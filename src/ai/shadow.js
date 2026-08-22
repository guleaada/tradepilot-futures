// Shadow-mode model evaluation.
//
// SAFETY CONTRACT — the whole point of this module:
//   * Nothing here can influence a regime, a direction, an entry, an exit,
//     sizing, or an order. It imports NOTHING from ../engine/, never sees an
//     executor, and returns data that the trading path never reads.
//   * It cannot throw into the trading cycle: every provider call is isolated
//     with Promise.allSettled, and the top-level entry point catches
//     everything, including its own persistence errors.
//   * It is OFF unless AI_SHADOW_MODE === 'true'. With the flag off, not a
//     single HTTP request is made.
//
// Flow:
//   summary -> shadow provider.complete() -> parseRegimeResponse() -> storage
// and NEVER:
//   summary -> shadow provider -> runPairRules() -> executor
//
// Shadow providers receive the byte-identical market summary and the same
// canonical SYSTEM_PROMPT as the primary (the prompt lives inside each
// provider), so the experiment compares MODELS, not inputs.
import { performance } from 'node:perf_hooks';
import { canonicalJson, createSnapshotId } from './snapshot.js';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db.js';
import { isTimeoutError, logPricingIssue, parseRegimeResponse } from './regime.js';
import { tryGetPrimaryProvider } from './providers/index.js';
import { PRICING_STATUS, resolvePricing } from './pricing.js';
import { addSpend, costFromUsage } from './budget.js';

// The canonical snapshot helpers live in ./snapshot.js — ONE implementation,
// shared with the primary path. Re-exported here for existing importers;
// `computeSnapshotId` is retained as an alias of `createSnapshotId`.
export { canonicalJson, createSnapshotId, createSnapshotId as computeSnapshotId };

// Which providers run as shadows this cycle. Deduplicated, primary removed,
// unknown names reported rather than thrown.
export function resolveShadowProviders(cfg = config) {
  if (!cfg.aiShadowMode) return { providers: [], unknown: [] };
  const primary = String(cfg.aiProvider ?? '').toLowerCase();
  const seen = new Set();
  const providers = [];
  const unknown = [];
  for (const raw of cfg.aiShadowProviders ?? []) {
    const name = String(raw).trim().toLowerCase();
    if (!name || seen.has(name)) continue; // dedupe
    seen.add(name);
    // The live provider already answered this snapshot; calling it again
    // would double the spend and prove nothing.
    if (name === primary) continue;
    const provider = tryGetPrimaryProvider(name);
    if (!provider) { unknown.push(name); continue; }
    providers.push(provider);
  }
  return { providers, unknown };
}

// One shadow call. NEVER throws: every outcome becomes a status.
// Statuses: success | parse_failure | timeout | error
async function evaluateOne(provider, summary) {
  const started = performance.now();
  const base = { provider: provider.name, model: null, reportedModel: null };
  try {
    base.model = provider.model;
  } catch { /* a misbehaving getter must not break the run */ }

  try {
    // Pre-flight, mirroring the primary path: no key -> no HTTP request, and
    // only the env-var NAME is recorded, never the secret.
    if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
      return { ...base, status: 'error', error: `${provider.keyEnvVar} not set`, latencyMs: performance.now() - started };
    }

    const res = await provider.complete({ summary });
    const latencyMs = performance.now() - started;
    // The SAME parser as the primary — no per-provider parsing, no weakened
    // validation. `text` is the public model text only; providers already drop
    // hidden reasoning (Gemini thought parts, Mistral thinking chunks,
    // OpenRouter reasoning fields) before it reaches here.
    const parsed = parseRegimeResponse(res.text);
    // Price the model that actually answered. Unknown -> null cost, recorded
    // as such; a shadow provider never borrows another provider's rate.
    const model = res.model ?? base.model;
    const pricing = resolvePricing(provider.name, model);
    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;
    return {
      ...base,
      model,
      reportedModel: res.reportedModel ?? null,
      generationId: res.generationId ?? null,
      pricingStatus: pricing.status,
      pricing, // carried so the caller can emit PRICING_STALE / PRICING_UNKNOWN
      estCost: costFromUsage(inputTokens, outputTokens, pricing),
      status: parsed ? 'success' : 'parse_failure',
      // On a parse failure the regime fields stay NULL — never invented.
      regime: parsed?.regime ?? null,
      confidence: parsed?.confidence ?? null,
      tradeAllowed: parsed ? parsed.trade_allowed : null,
      reasoning: parsed?.reasoning ?? null,
      inputTokens,
      outputTokens,
      rawResponse: typeof res.text === 'string' ? res.text : null,
      latencyMs,
    };
  } catch (err) {
    return {
      ...base,
      status: isTimeoutError(err) ? 'timeout' : 'error',
      // Only the message — never headers or config, so no key can leak.
      error: String(err?.message ?? err).slice(0, 500),
      latencyMs: performance.now() - started,
    };
  }
}

function persist(db, { snapshotId, pair, result, at }) {
  db.prepare(
    `INSERT INTO ai_shadow_calls
       (created_at, snapshot_id, pair, provider, model, reported_model, status,
        regime, confidence, trade_allowed, reasoning,
        input_tokens, output_tokens, latency_ms, error, raw_response,
        est_cost, pricing_status, generation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    at, snapshotId, pair,
    result.provider, result.model ?? null, result.reportedModel ?? null, result.status,
    result.regime ?? null,
    result.confidence ?? null,
    result.tradeAllowed === null || result.tradeAllowed === undefined ? null : (result.tradeAllowed ? 1 : 0),
    result.reasoning ?? null,
    result.inputTokens ?? 0, result.outputTokens ?? 0,
    result.latencyMs ?? null,
    result.error ?? null,
    result.rawResponse ?? null,
    result.estCost ?? null,      // NULL when pricing is unknown — never fabricated
    result.pricingStatus ?? null,
    result.generationId ?? null, // for cost reconciliation only
  );
}

/**
 * Evaluate one pair's snapshot with every configured shadow provider.
 *
 * Returns a summary for logging/tests. NEVER throws and NEVER returns anything
 * the trading path consumes. Safe to call without awaiting — but the caller
 * should await the collected promises before the process exits so writes land.
 */
export async function runShadowEvaluation({ pair, summary, snapshotId: providedSnapshotId = null, db = getDb(), cfg = config, providers: injected = null } = {}) {
  try {
    // `injected` is a test-only seam (same convention as
    // filterPairsByLiquidity's `deps`); production always resolves from config.
    const { providers, unknown } = injected
      ? { providers: injected, unknown: [] }
      : resolveShadowProviders(cfg);
    if (unknown.length) {
      // Reported, never fatal: a typo in AI_SHADOW_PROVIDERS must not stop the
      // other shadows, and certainly must not stop trading.
      try { logEvent('SHADOW_PROVIDER_UNKNOWN', { pair, unknown }, db); } catch { /* ignore */ }
    }
    if (providers.length === 0) return { snapshotId: null, results: [] };

    // The cycle creates the id ONCE and hands the SAME value to the primary
    // and to every shadow provider — that exact-match is the join key. The
    // fallback exists only for direct/standalone calls (tests); it uses the
    // same shared helper, never a second implementation.
    const snapshotId = providedSnapshotId ?? createSnapshotId(summary);
    const at = nowIso();

    // Concurrent, and isolated from each other: one provider hanging or
    // exploding cannot affect the others.
    const settled = await Promise.allSettled(providers.map((p) => evaluateOne(p, summary)));

    const results = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      // evaluateOne is written never to reject; this is belt-and-braces.
      const result = s.status === 'fulfilled'
        ? s.value
        : { provider: providers[i].name, model: null, status: 'error', error: String(s.reason?.message ?? s.reason).slice(0, 500), latencyMs: null };
      results.push(result);
      // Shadow spend is real money: accrue it under the SHADOW provider's own
      // ai_budget bucket, never under the primary's. Because the buckets are
      // per-provider, shadow spend can never consume the primary's daily cap
      // and so can never starve the trading decision.
      try {
        // A STALE price still accrues (an old rate beats no rate); only an
        // UNKNOWN one is left uncosted. Both are flagged, neither blocks.
        if (typeof result.estCost === 'number' && Number.isFinite(result.estCost)) {
          addSpend(result.estCost, db, undefined, result.provider);
        }
        if (result.pricing) {
          logPricingIssue(db, result.pricing, {
            pair, provider: result.provider, model: result.model ?? null, stage: 'shadow_call',
          });
        }
      } catch { /* accounting must never break the evaluation */ }
      try {
        persist(db, { snapshotId, pair, result, at });
      } catch (err) {
        // A storage failure is an evaluation problem, never a trading problem.
        try { logEvent('SHADOW_PERSIST_FAILED', { pair, provider: result.provider, error: String(err?.message ?? err).slice(0, 200) }, db); } catch { /* ignore */ }
      }
    }
    return { snapshotId, results };
  } catch (err) {
    // Absolute backstop: nothing from shadow mode reaches the cycle.
    try { logEvent('SHADOW_EVALUATION_FAILED', { pair, error: String(err?.message ?? err).slice(0, 300) }, db); } catch { /* ignore */ }
    return { snapshotId: null, results: [] };
  }
}

// Small read helper for tests/analysis. Not used by the trading path.
export function getShadowCalls(db = getDb(), { pair = null, snapshotId = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (pair) { where.push('pair = ?'); args.push(pair); }
  if (snapshotId) { where.push('snapshot_id = ?'); args.push(snapshotId); }
  const sql = `SELECT * FROM ai_shadow_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}
