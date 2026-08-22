// OpenRouter actual-cost reconciliation.
//
// SAFETY CONTRACT — this module is pure bookkeeping:
//   * It imports NOTHING from ../engine/ and never sees an executor. It cannot
//     influence a regime, a direction, an entry, an exit, sizing, or an order.
//   * It runs AFTER trading, fire-and-forget, and never throws into the cycle.
//   * It NEVER overwrites est_cost. The estimate stays what it always was: the
//     price of the REQUESTED model. `actual_cost` is stored strictly
//     alongside it, so the two can be compared instead of conflated — which is
//     the whole point, since OpenRouter may route to an upstream provider
//     whose real price differs from the requested model's list price.
//   * It NEVER feeds the budget gate or budget accrual. Those keep using the
//     estimate, so a reconciliation outcome can never change gating behaviour.
//
// Why a separate pass at all: OpenRouter's generation stats are not available
// at response time — the cost endpoint is populated a moment later. Looking it
// up in a subsequent cycle is therefore the correct shape, not a workaround.
import { config } from '../config.js';
import { getDb, logEvent } from '../db.js';

export const ACTUAL_COST_SOURCE = 'openrouter_generation';

// A row is abandoned after this many failed attempts. Bounded on purpose: a
// generation id that never resolves (expired, wrong account, endpoint gone)
// must not be retried forever on a 15-minute cycle.
export const MAX_RECONCILE_ATTEMPTS = 3;

// How many rows one cycle will try. Keeps the pass cheap and predictable.
export const RECONCILE_BATCH_SIZE = 20;

const TABLES = ['regime_calls', 'ai_shadow_calls'];

// Deduplicated-per-day warning, so a persistently failing id cannot flood the
// events table on a 15-minute cadence.
function logReconcileIssue(db, type, detail) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const seen = db.prepare(
      'SELECT id FROM events WHERE type = ? AND ts >= ? AND detail LIKE ? LIMIT 1',
    ).get(type, `${today}T00:00:00`, `%"generationId":${JSON.stringify(detail.generationId ?? null)}%`);
    if (!seen) logEvent(type, detail, db);
  } catch { /* bookkeeping must never break the cycle */ }
}

// Rows that have a generation id, no actual cost yet, and attempts to spare.
export function pendingReconciliations(db = getDb(), limit = RECONCILE_BATCH_SIZE) {
  const out = [];
  for (const table of TABLES) {
    try {
      const rows = db.prepare(
        `SELECT id, generation_id, reconcile_attempts FROM ${table}
         WHERE provider = 'openrouter'
           AND generation_id IS NOT NULL
           AND actual_cost IS NULL
           AND COALESCE(reconcile_attempts, 0) < ?
         ORDER BY id DESC LIMIT ?`,
      ).all(MAX_RECONCILE_ATTEMPTS, limit);
      for (const r of rows) out.push({ table, ...r });
    } catch { /* a table missing the columns simply yields nothing */ }
  }
  return out;
}

/**
 * Fetch the billed cost for one generation id.
 * Returns a number, or null for every failure mode (HTTP error, timeout,
 * malformed body, missing total_cost). Never throws.
 */
export async function fetchGenerationCost(generationId, { fetchImpl = fetch } = {}) {
  const url = `${config.openrouterBase}/generation?id=${encodeURIComponent(generationId)}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    // Same shared deadline as every other AI request — no second timeout system.
    signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
    headers: {
      accept: 'application/json',
      // Bearer header only; the key never enters a URL or a log line.
      authorization: `Bearer ${config.openrouterApiKey}`,
    },
  });
  if (!res.ok) throw new Error(`OpenRouter generation ${res.status}`);
  const body = await res.json();
  // The endpoint wraps the record in `data`; tolerate a bare object too.
  const record = body?.data ?? body;
  const cost = record?.total_cost;
  // A missing or non-numeric total_cost is NOT an error to retry forever — it
  // is simply "no verified figure", and must leave actual_cost NULL.
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

/**
 * Reconcile up to one batch of pending OpenRouter rows.
 * Never throws, never blocks trading, never mutates est_cost.
 */
export async function reconcileOpenRouterCosts({ db = getDb(), fetchImpl = fetch, limit = RECONCILE_BATCH_SIZE } = {}) {
  const summary = { attempted: 0, reconciled: 0, failed: 0, abandoned: 0 };
  try {
    // Nothing to do unless OpenRouter is actually configured — no key, no call.
    if (!config.openrouterApiKey) return summary;
    const pending = pendingReconciliations(db, limit);
    if (pending.length === 0) return summary;

    for (const row of pending) {
      summary.attempted += 1;
      // Count the attempt FIRST, so a call that hangs or crashes still burns
      // an attempt and the row can never be retried indefinitely.
      try {
        db.prepare(`UPDATE ${row.table} SET reconcile_attempts = COALESCE(reconcile_attempts, 0) + 1 WHERE id = ?`)
          .run(row.id);
      } catch { /* ignore */ }

      let cost = null;
      let failure = null;
      try {
        cost = await fetchGenerationCost(row.generation_id, { fetchImpl });
        if (cost === null) failure = 'missing_total_cost';
      } catch (err) {
        failure = String(err?.message ?? err).slice(0, 200);
      }

      if (cost !== null) {
        try {
          db.prepare(
            `UPDATE ${row.table} SET actual_cost = ?, actual_cost_source = ? WHERE id = ?`,
          ).run(cost, ACTUAL_COST_SOURCE, row.id);
          summary.reconciled += 1;
        } catch { /* ignore */ }
        continue;
      }

      summary.failed += 1;
      const attemptsNow = (row.reconcile_attempts ?? 0) + 1;
      const givenUp = attemptsNow >= MAX_RECONCILE_ATTEMPTS;
      if (givenUp) summary.abandoned += 1;
      logReconcileIssue(db, 'COST_RECONCILE_FAILED', {
        table: row.table, rowId: row.id, generationId: row.generation_id,
        attempts: attemptsNow, givenUp, reason: failure,
      });
    }
  } catch (err) {
    // Absolute backstop: reconciliation can never reach the trading cycle.
    try { logEvent('COST_RECONCILE_ERROR', { error: String(err?.message ?? err).slice(0, 300) }, db); } catch { /* ignore */ }
  }
  return summary;
}

// Reporting helper: estimated vs reconciled actual for a date. Rows without a
// verified actual are counted, never silently treated as verified.
export function getOpenRouterCostReconciliation(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const row = db.prepare(
    `SELECT COUNT(*) AS calls,
            ROUND(COALESCE(SUM(est_cost), 0), 6) AS estimated,
            SUM(CASE WHEN actual_cost IS NOT NULL THEN 1 ELSE 0 END) AS reconciled_calls,
            ROUND(COALESCE(SUM(actual_cost), 0), 6) AS actual_reconciled,
            SUM(CASE WHEN actual_cost IS NULL THEN 1 ELSE 0 END) AS unreconciled_calls
     FROM regime_calls
     WHERE provider = 'openrouter' AND ts >= ? AND ts < ?`,
  ).get(`${date}T00:00:00`, `${date}T23:59:59.999`);
  return row ?? null;
}
