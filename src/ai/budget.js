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

export function costFromUsage(inputTokens, outputTokens, pricing = config.pricing) {
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export function estimateCallCost(cfg = config) {
  return costFromUsage(cfg.estInputTokens, cfg.estOutputTokens, cfg.pricing);
}
