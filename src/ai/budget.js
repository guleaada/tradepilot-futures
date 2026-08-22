// Daily AI spend tracker per provider, persisted in SQLite (table: ai_budget).
// Provider defaults to 'anthropic'. The Grok/xAI provider from the spot bot is
// gone (sentiment layer not included in this fork); the (date, provider)
// schema is kept so a second provider can be added without a migration.
import { getDb, logEvent } from '../db.js';
import { config } from '../config.js';

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function getDailySpend(db = getDb(), date = todayUtc(), provider = 'anthropic') {
  const row = db
    .prepare('SELECT spend FROM ai_budget WHERE date = ? AND provider = ?')
    .get(date, provider);
  return row ? row.spend : 0;
}

export function addSpend(usd, db = getDb(), date = todayUtc(), provider = 'anthropic') {
  db.prepare(
    `INSERT INTO ai_budget (date, provider, spend) VALUES (?, ?, ?)
     ON CONFLICT(date, provider) DO UPDATE SET spend = spend + excluded.spend`,
  ).run(date, provider, usd);
}

// Per-provider spend for a date, plus the total. Used by reporting so a
// multi-provider run is never collapsed into a single "Claude" figure.
export function getSpendByProvider(db = getDb(), date = todayUtc()) {
  const rows = db.prepare('SELECT provider, spend FROM ai_budget WHERE date = ? ORDER BY provider').all(date);
  return { byProvider: rows, total: rows.reduce((sum, r) => sum + r.spend, 0) };
}

// Count of calls whose (provider, model) had no verified price, per provider.
export function getPricingUnknownCounts(db = getDb(), date = todayUtc()) {
  return db.prepare(
    `SELECT provider, COUNT(*) AS n FROM regime_calls
     WHERE pricing_status = 'unknown' AND ts >= ? AND ts < ?
     GROUP BY provider ORDER BY provider`,
  ).all(`${date}T00:00:00`, `${date}T23:59:59.999`);
}

export function wouldExceedBudget(
  estCostUsd,
  capUsd = config.aiDailyBudgetUsd,
  db = getDb(),
  date = todayUtc(),
  provider = 'anthropic',
) {
  return getDailySpend(db, date, provider) + estCostUsd > capUsd;
}

// If the pre-call estimate alone exceeds the full daily cap, the gate can
// never admit even one call — that's a configuration error, not normal budget
// exhaustion. Log it loudly, once per day per provider. Returns true when
// misconfigured.
export function warnIfBudgetMisconfigured(estCostUsd, capUsd, provider, db = getDb(), date = todayUtc()) {
  if (estCostUsd <= capUsd) return false;
  const seen = db
    .prepare(
      "SELECT id FROM events WHERE type = 'BUDGET_MISCONFIGURED' AND ts >= ? AND detail LIKE ? LIMIT 1",
    )
    .get(`${date}T00:00:00`, `%"provider":"${provider}"%`);
  if (!seen) {
    logEvent('BUDGET_MISCONFIGURED', { provider, estCost: estCostUsd, cap: capUsd }, db);
  }
  return true;
}

// Cost for a call, given EXPLICIT pricing. There is deliberately no default
// pricing argument: a caller that has not resolved a price must not be able to
// silently borrow someone else's rate.
//
// Returns null when the price is unknown — null means "not computable", which
// is different from 0 ("computed, and free"). Callers persist null as
// est_cost and never add it to a budget.
export function costFromUsage(inputTokens, outputTokens, pricing) {
  if (!pricing || pricing.status === 'unknown'
    || !Number.isFinite(pricing.inputPerMTok) || !Number.isFinite(pricing.outputPerMTok)) {
    return null;
  }
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}

// Pre-call budget estimate for a specific provider/model price. Null when the
// price is unknown, which the caller treats as "cannot gate on dollars"
// (see the call-bounding note in regime.js).
export function estimateCallCost(pricing, cfg = config) {
  return costFromUsage(cfg.estInputTokens, cfg.estOutputTokens, pricing);
}
