// Claude regime-call module. The AI layer only emits an opinion:
//   { regime, confidence, trade_allowed, reasoning }
// It NEVER sizes positions, sets leverage, or places orders — that is the
// rule engine's job. In this futures fork a confident `bearish` call is
// actionable (short entry), not just a "stay out" signal.
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { getPrimaryProvider, tryGetPrimaryProvider } from './providers/index.js';
import { PRICING_STATUS, resolvePricing } from './pricing.js';
import { getDb, logEvent, nowIso } from '../db.js';
import { mockTrend } from '../data/binance.js';
import {
  addSpend,
  costFromUsage,
  estimateCallCost,
  warnIfBudgetMisconfigured,
  wouldExceedBudget,
} from './budget.js';

export const FALLBACK_REGIME = Object.freeze({
  regime: 'chop',
  confidence: 0,
  trade_allowed: false,
  reasoning: 'parse_failure',
});

const VALID_REGIMES = new Set(['bullish', 'bearish', 'chop']);

// SYSTEM_PROMPT lives in ./prompt.js — single canonical definition, shared
// with every primary provider. Re-exported here for existing importers.
export { SYSTEM_PROMPT };

// Clean truncation: an opened <thinking> that never closed (so no JSON could
// follow). Distinct from a schema error on a complete response — the salvage
// path retries this once with more room.
export function isTruncatedThinking(text) {
  if (typeof text !== 'string') return false;
  return /<thinking>/i.test(text) && !/<\/thinking>/i.test(text);
}

const THINKING_CLOSE = '</thinking>';

// Drop everything up to a LONE closing tag (one with no opening tag before it),
// leaving text that already contains a proper <thinking> pair untouched.
//
// This replaces  /[\s\S]*<\/thinking>/i  with a "keep it if it contains an
// opening tag" callback. That regex backtracks catastrophically when NO closing
// tag is present: the greedy [\s\S]* is retried from every start position, so
// cost grows as O(n^2) - measured at 597ms for a 16KB response and roughly
// fourfold per doubling. Indexing is O(n) and byte-equivalent on every case
// (proven in test/parse.test.js).
function stripLoneClosingThinkingTag(s) {
  const at = s.toLowerCase().lastIndexOf(THINKING_CLOSE);
  if (at === -1) return s;
  const upto = at + THINKING_CLOSE.length;
  return /<thinking/i.test(s.slice(0, upto)) ? s : s.slice(upto);
}

// Parse defensively: strip <thinking> blocks and code fences, extract the
// outermost JSON object, then validate strictly — regime in the known set,
// confidence an integer (clamped to 0-100), trade_allowed boolean, reasoning
// a non-empty string (truncated to 200 chars). Returns null on any failure.
export function parseRegimeResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let body = stripLoneClosingThinkingTag(
    text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ''),
  ).trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    body = body.slice(start, end + 1);
  }
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!VALID_REGIMES.has(obj.regime)) return null;
  // STRICT: the schema promises an integer 0-100 and nothing else is accepted.
  // This was previously Number(obj.confidence) followed by a clamp, which
  // silently converted "999" and 1e21 into 100 (maximum conviction from a value
  // the schema forbids), [70] into 70, and null/false into 0. A malformed
  // confidence is now a parse failure, taking the same safe fallback path as any
  // other unusable response rather than being guessed at.
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || !Number.isInteger(confidence)
    || confidence < 0 || confidence > 100) return null;
  if (typeof obj.trade_allowed !== 'boolean') return null;
  const reasoning = obj.reasoning ?? obj.reason;
  if (typeof reasoning !== 'string' || !reasoning.trim()) return null;
  return {
    regime: obj.regime,
    confidence, // already validated as an integer within [0, 100]
    trade_allowed: obj.trade_allowed,
    reasoning: reasoning.trim().slice(0, 200),
  };
}

// Outcomes of the last N regime calls: portfolio return over the 4h following
// each call, measured from equity snapshots.
export function regimeCallOutcomes(pair, db = getDb(), limit = 5) {
  const calls = db
    .prepare('SELECT ts, regime, confidence, trade_allowed FROM regime_calls WHERE pair = ? ORDER BY id DESC LIMIT ?')
    .all(pair, limit);
  const eqAt = db.prepare('SELECT equity FROM equity_snapshots WHERE ts >= ? ORDER BY ts LIMIT 1');
  return calls.map((c) => {
    const start = eqAt.get(c.ts);
    const end = eqAt.get(new Date(Date.parse(c.ts) + 4 * 3_600_000).toISOString());
    const ret = start && end && start.equity > 0 ? ((end.equity - start.equity) / start.equity) * 100 : null;
    return {
      ts: c.ts,
      regime: c.regime,
      confidence: c.confidence,
      trade_allowed: !!c.trade_allowed,
      return_4h_pct: ret === null ? null : Number(ret.toFixed(3)),
    };
  });
}

// Compact market summary fed to Claude. Kept well under ~1,500 tokens.
// `context` carries portfolio-level facts: drawdown from peak, BTC dominance
// approximation, trailing 7-day stats. No sentiment block in this fork.
export function buildMarketSummary(pair, market, recentCalls = [], recentTrades = [], context = null) {
  const r = (v, d = 2) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
  return {
    pair,
    market_type: 'usdm_futures (long and short both possible)',
    as_of: nowIso(),
    price: r(market.price, 2),
    ohlc_1h_last5: market.last5,
    rsi14_1h: r(market.rsi1h),
    ema_1h: { e20: r(market.ema20_1h), e50: r(market.ema50_1h), e200: r(market.ema200_1h) },
    ema_4h: { e20: r(market.ema20_4h), e50: r(market.ema50_4h), e200: r(market.ema200_4h) },
    price_vs_ema50_4h: market.ema50_4h ? r((market.price / market.ema50_4h - 1) * 100, 2) : null,
    atr14_1h: r(market.atr1h, 4),
    atr_pct_of_price: market.atr1h ? r((market.atr1h / market.price) * 100, 3) : null,
    volatility_20: market.vol20 === null ? null : r(market.vol20 * 100, 3),
    change_24h_pct: r(market.change24hPct),
    volume_24h: r(market.volume24h, 0),
    funding_rate: market.fundingRate === null
      ? 'unavailable (futures endpoint unreachable)'
      : market.fundingRate,
    last_regime_calls: recentCalls.map((c) => ({
      ts: c.ts,
      regime: c.regime,
      confidence: c.confidence,
      trade_allowed: !!c.trade_allowed,
      ...(c.return_4h_pct !== undefined ? { return_4h_pct: c.return_4h_pct } : {}),
    })),
    portfolio_context: context,
    recent_closed_trades: recentTrades.map((t) => ({
      exit_time: t.exit_time,
      direction: t.direction,
      pnl: r(t.pnl),
      exit_reason: t.exit_reason,
    })),
  };
}

// Did this request die on our own request deadline rather than a provider
// error? AbortSignal.timeout rejects with a DOMException named 'TimeoutError',
// but Node/undici sometimes surfaces it wrapped (err.cause) or as a plain
// abort, so check every shape. Used only to CLASSIFY the failure — a timeout
// takes exactly the same safe fallback path as any other AI failure.
export function isTimeoutError(err) {
  if (!err) return false;
  const names = [err.name, err.cause?.name].filter(Boolean);
  if (names.some((n) => n === 'TimeoutError' || n === 'AbortError')) return true;
  return /timed? ?out|aborted/i.test(String(err.message ?? ''));
}

// The primary regime request now goes through the provider registry: the
// engine depends on the normalized interface
//   { provider, model, text, usage: { inputTokens, outputTokens } }
// and never on Anthropic specifics. Anthropic's own implementation (endpoint,
// auth, anthropic-version, response extraction) lives in
// src/ai/providers/anthropic.js. Parsing stays here, in parseRegimeResponse().
async function callPrimaryProvider(provider, summary, maxTokens = config.aiMaxOutputTokens) {
  return provider.complete({ summary, maxTokens });
}

// Optional free pre-filter: ask Groq whether anything materially changed.
// Returns true ("call Claude") on any doubt or failure.
async function groqSaysChanged(summary, lastSummaryJson, db = null, pair = null) {
  if (!config.groqApiKey || !lastSummaryJson) return true;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      // Same bounded deadline as the Claude call.
      signal: AbortSignal.timeout(config.aiRequestTimeoutMs),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.groqModel,
        max_tokens: 5,
        messages: [
          {
            role: 'user',
            content:
              'Compare these two crypto market summaries. Has anything materially changed ' +
              '(trend direction, RSI zone, volatility, funding)? Answer with exactly one word: yes or no.\n' +
              `PREVIOUS: ${lastSummaryJson}\nCURRENT: ${JSON.stringify(summary)}`,
          },
        ],
      }),
    });
    if (!res.ok) return true;
    const data = await res.json();
    const answer = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return !answer.startsWith('no');
  } catch (err) {
    // Fails OPEN (returns true = "call Claude"): the pre-filter is an
    // optional cost saver, never a gate on the real decision. A timeout is
    // logged distinctly so a persistently slow Groq is diagnosable.
    if (db) {
      try {
        logEvent(isTimeoutError(err) ? 'GROQ_TIMEOUT' : 'GROQ_ERROR',
          { pair, timeoutMs: config.aiRequestTimeoutMs, error: String(err.message ?? err).slice(0, 200) }, db);
      } catch { /* logging must never break the pre-filter */ }
    }
    return true;
  }
}

function rowToRegime(row) {
  return {
    regime: row.regime,
    confidence: row.confidence,
    trade_allowed: !!row.trade_allowed,
    reasoning: row.reasoning || '',
  };
}

function decayed(row, points = config.budgetDecayPoints) {
  const base = rowToRegime(row);
  return { ...base, confidence: Math.max(0, base.confidence - points) };
}

// `usage` is the normalized provider shape: { inputTokens, outputTokens }.
//
// Three independent dimensions are persisted, never conflated:
//   source   — the call OUTCOME/state (claude | claude_parse_fail |
//              claude_error | claude_timeout | mock). Unchanged values, so
//              every existing query/report keeps working.
//   provider — WHO served it (anthropic | mock | ...), from the abstraction.
//   model    — the EXACT model id, from the abstraction. Null when no model
//              was actually selected; never a guess.
function recordCall(db, {
  pair, regime, summary, usage, estCost, source,
  provider = null, model = null, snapshotId = null, pricingStatus = null,
  generationId = null, rawText = null, ts = nowIso(),
}) {
  db.prepare(
    `INSERT INTO regime_calls
       (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json,
        input_tokens, output_tokens, est_cost, source, provider, model, snapshot_id,
        pricing_status, generation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    pair,
    regime.regime,
    regime.confidence,
    regime.trade_allowed ? 1 : 0,
    regime.reasoning,
    rawText ?? JSON.stringify(regime),
    JSON.stringify(summary),
    usage.inputTokens || 0,
    usage.outputTokens || 0,
    estCost,
    source,
    provider,
    model,
    snapshotId, // created once by the cycle; never re-hashed here
    pricingStatus, // 'exact' | 'unknown' | null (no provider call was made)
    generationId,  // provider-side id for later cost reconciliation only
  );
}

// Why a regime came back the way it did. This is EXPLICIT metadata, not
// something callers should re-derive from timestamps, source strings, provider
// names or confidence values. Exactly one outcome — FRESH — means "a real
// configured primary provider was called and produced a valid regime for THIS
// cycle's market summary"; everything else is a cache hit or a fallback.
export const REGIME_OUTCOMES = Object.freeze({
  FRESH: 'fresh',                       // provider called, response parsed
  CACHED: 'cached',                     // inside the AI cadence window
  CACHED_UNCHANGED: 'cached_unchanged',  // Groq pre-filter said nothing moved
  BUDGET_SKIP: 'budget_skip',
  MISSING_KEY: 'missing_key',
  PARSE_FAILURE: 'parse_failure',        // provider answered, output unusable
  TIMEOUT: 'timeout',
  PROVIDER_ERROR: 'provider_error',
  MOCK: 'mock',                          // synthetic regime, no provider call
});

// Structured, deduplicated-per-day signal about a pricing problem:
//   PRICING_UNKNOWN — no verified price for this (provider, model)
//   PRICING_STALE   — priced, but verified longer ago than the threshold
// Deduplicated per (type, model, day) so a 15-minute cycle cannot flood the
// events table. NEITHER ever blocks trading; both are purely observational.
// Never throws: an accounting gap must not break a trading cycle.
export function logPricingIssue(db, pricing, detail) {
  const type = pricing.status === PRICING_STATUS.UNKNOWN
    ? 'PRICING_UNKNOWN'
    : pricing.status === PRICING_STATUS.STALE ? 'PRICING_STALE' : null;
  if (!type) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const seen = db.prepare(
      `SELECT id FROM events WHERE type = ? AND ts >= ? AND detail LIKE ? LIMIT 1`,
    ).get(type, `${today}T00:00:00`, `%"model":${JSON.stringify(detail.model ?? null)}%`);
    if (!seen) {
      logEvent(type, {
        ...detail,
        ...(pricing.verifiedOn ? { verifiedOn: pricing.verifiedOn } : {}),
        ...(Number.isFinite(pricing.ageDays) ? { ageDays: Math.round(pricing.ageDays) } : {}),
      }, db);
    }
  } catch { /* accounting must never break the cycle */ }
  return type;
}

function evaluation(outcome, extra = {}) {
  return { fresh: outcome === REGIME_OUTCOMES.FRESH, outcome, ...extra };
}

// Main entry: returns the regime the rule engine should use this cycle.
// Respects AI cadence, the Groq pre-filter, and the hard daily budget cap.
// `nowMs` is overridable so tests can run the cadence on sim time.
// `snapshotId` identifies the exact market state this evaluation was given.
// It is CREATED BY THE CALLER (runCycle) and passed straight through to
// storage — getRegime never derives one, so the primary row and the shadow
// rows for the same summary always carry the identical value.
export async function evaluateRegime(pair, summary, db = getDb(), nowMs = Date.now(), { snapshotId = null } = {}) {
  if (config.mock) {
    // Mock regime follows the synthetic trend of the pair, so demo cycles can
    // open a LONG on an uptrend pair and a SHORT on a downtrend pair.
    const bearish = mockTrend(pair) < 0;
    const mock = {
      regime: bearish ? 'bearish' : 'bullish',
      confidence: 72,
      trade_allowed: true,
      reasoning: bearish
        ? 'Mock regime: synthetic downtrend with sustained selling pressure.'
        : 'Mock regime: synthetic uptrend with healthy momentum.',
    };
    // Mock: provider 'mock' (a synthetic generator DID produce this row) but
    // model NULL — no model was invoked, and inventing one would pollute
    // model-level attribution exactly like a backfilled guess would.
    recordCall(db, {
      pair, regime: mock, summary, usage: { inputTokens: 0, outputTokens: 0 }, estCost: 0,
      source: 'mock', provider: 'mock', model: null, snapshotId, pricingStatus: null, ts: new Date(nowMs).toISOString(),
    });
    return { regime: mock, evaluation: evaluation(REGIME_OUTCOMES.MOCK, { provider: 'mock', model: null }) };
  }

  const lastCall = db
    .prepare('SELECT * FROM regime_calls WHERE pair = ? ORDER BY id DESC LIMIT 1')
    .get(pair);
  const ageHours = lastCall ? (nowMs - Date.parse(lastCall.ts)) / 3_600_000 : Infinity;

  // Cadence: never call Claude more often than every aiCadenceHours per pair.
  if (lastCall && ageHours < config.aiCadenceHours) {
    return {
      regime: rowToRegime(lastCall),
      evaluation: evaluation(REGIME_OUTCOMES.CACHED, { provider: lastCall.provider ?? null, model: lastCall.model ?? null, ageHours }),
    };
  }

  // Groq pre-filter: skip Claude if nothing changed, unless the last call is
  // older than aiMaxStaleHours.
  if (lastCall && ageHours < config.aiMaxStaleHours) {
    const changed = await groqSaysChanged(summary, lastCall.summary_json, db, pair);
    if (!changed) {
      logEvent('GROQ_SKIPPED', { pair, ageHours: Number(ageHours.toFixed(2)) }, db);
      return {
        regime: rowToRegime(lastCall),
        evaluation: evaluation(REGIME_OUTCOMES.CACHED_UNCHANGED, { provider: lastCall.provider ?? null, model: lastCall.model ?? null, ageHours }),
      };
    }
  }

  // Provider-agnostic credential pre-flight. Each provider declares its own
  // key env var, so adding a provider can never leave a stale Anthropic-only
  // check gating it. An UNKNOWN provider name is deliberately not handled
  // here — it falls through to the main try below so it keeps its existing
  // error/attribution behavior. Only the env var NAME is logged, never a key.
  const configuredProvider = tryGetPrimaryProvider();
  if (configuredProvider && !configuredProvider.isConfigured()) {
    logEvent('AI_ERROR', { pair, error: `${configuredProvider.keyEnvVar} not set` }, db);
    return {
      regime: lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME },
      evaluation: evaluation(REGIME_OUTCOMES.MISSING_KEY, { provider: configuredProvider.name }),
    };
  }

  // Hard daily budget cap, priced for the provider/model that will ACTUALLY
  // be called — never a global rate. When the price is unknown the dollar gate
  // cannot be evaluated, so it is skipped rather than guessed.
  //
  // Skipping the dollar gate does NOT mean unbounded spend: primary calls are
  // already bounded structurally, independent of pricing, by the AI cadence
  // (one call per pair per AI_CADENCE_HOURS), the single truncation retry, and
  // the per-cycle pair count. With the shipped defaults that ceiling is
  // 17 pairs x (24/4) windows x 2 attempts = 204 calls/day worst case. No new
  // control is needed; see PRICING_UNKNOWN events to spot an unpriced model.
  const gateProviderName = configuredProvider?.name ?? config.aiProvider;
  const gateModel = configuredProvider?.model ?? null;
  const gatePricing = resolvePricing(gateProviderName, gateModel);
  const estCost = estimateCallCost(gatePricing);
  logPricingIssue(db, gatePricing, { pair, provider: gateProviderName, model: gateModel, stage: 'budget_gate' });
  if (estCost !== null) warnIfBudgetMisconfigured(estCost, config.aiDailyBudgetUsd, gateProviderName, db);
  if (estCost !== null && wouldExceedBudget(estCost, config.aiDailyBudgetUsd, db, undefined, gateProviderName)) {
    logEvent('BUDGET_SKIPPED', { pair, provider: gateProviderName, estCost }, db);
    return {
      regime: lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME },
      evaluation: evaluation(REGIME_OUTCOMES.BUDGET_SKIP),
    };
  }

  // Attribution for whatever happens below, taken from the provider
  // abstraction rather than hand-typed at each DB call site. Seeded with the
  // CONFIGURED provider and a NULL model so that a failure during provider
  // resolution records what was configured without claiming a model that was
  // never actually selected.
  const attribution = { provider: config.aiProvider, model: null };
  try {
    const provider = getPrimaryProvider();
    attribution.provider = provider.name;
    attribution.model = provider.model;

    const first = await callPrimaryProvider(provider, summary);
    let { text, usage } = first;
    attribution.provider = first.provider ?? attribution.provider;
    attribution.model = first.model ?? attribution.model;
    // Recorded for later cost reconciliation ONLY — never used for pricing,
    // attribution, or any trading decision. A retry supersedes it below.
    attribution.generationId = first.generationId ?? null;
    // Price the model that ACTUALLY answered. Unknown -> null cost, recorded
    // as such and never added to any budget (and never priced at another
    // provider's rate).
    const pricing = resolvePricing(attribution.provider, attribution.model);
    attribution.pricingStatus = pricing.status;
    // STALE still produces a cost (an old price beats no price) and still
    // accrues to the budget; it is flagged, never suppressed.
    logPricingIssue(db, pricing, { pair, provider: attribution.provider, model: attribution.model, stage: 'primary_call' });
    let cost = costFromUsage(usage.inputTokens || 0, usage.outputTokens || 0, pricing);
    if (cost !== null) addSpend(cost, db, undefined, attribution.provider);
    const tsIso = new Date(nowMs).toISOString();

    let parsed = parseRegimeResponse(text);

    // Salvage path: clean truncation (opened <thinking>, never closed) means
    // we ran out of output room, not a schema error. Log the failure, then
    // retry exactly once with double the token ceiling.
    if (!parsed && isTruncatedThinking(text)) {
      logEvent('REGIME_PARSE_FAILURE', { pair, reason: 'truncated_thinking', raw: String(text).slice(0, 300) }, db);
      const retry = await callPrimaryProvider(provider, summary, config.aiMaxOutputTokens * 2);
      // The retry is a separate billable attempt: priced independently and
      // added on top. Unknown pricing keeps BOTH attempts uncosted.
      const retryCost = costFromUsage(retry.usage.inputTokens || 0, retry.usage.outputTokens || 0, pricing);
      if (retryCost !== null) addSpend(retryCost, db, undefined, attribution.provider);
      logEvent('REGIME_RETRY', { pair, maxTokens: config.aiMaxOutputTokens * 2 }, db);
      text = retry.text;
      usage = retry.usage;
      attribution.generationId = retry.generationId ?? attribution.generationId;
      cost = cost === null || retryCost === null ? null : cost + retryCost;
      parsed = parseRegimeResponse(text);
    }

    if (!parsed) {
      logEvent('REGIME_PARSE_FAILURE', { pair, raw: String(text).slice(0, 300) }, db);
      const fb = { ...FALLBACK_REGIME };
      recordCall(db, {
        pair, regime: fb, summary, usage, estCost: cost, source: 'claude_parse_fail',
        ...attribution, snapshotId, rawText: text, ts: tsIso,
      });
      return { regime: fb, evaluation: evaluation(REGIME_OUTCOMES.PARSE_FAILURE, { ...attribution }) };
    }
    recordCall(db, {
      pair, regime: parsed, summary, usage, estCost: cost, source: 'claude',
      ...attribution, snapshotId, rawText: text, ts: tsIso,
    });
    return { regime: parsed, evaluation: evaluation(REGIME_OUTCOMES.FRESH, { ...attribution }) };
  } catch (err) {
    // A request that hit OUR deadline is logged as AI_TIMEOUT (distinct from
    // a provider/network error) but takes the identical safe path below:
    // decayed prior regime, or the no-trade chop fallback. Only err.message is
    // recorded — never headers/config — so API keys can't leak into the DB.
    const timedOut = isTimeoutError(err);
    logEvent(timedOut ? 'AI_TIMEOUT' : 'AI_ERROR',
      { pair, ...(timedOut ? { timeoutMs: config.aiRequestTimeoutMs } : {}), error: String(err.message ?? err).slice(0, 300) }, db);
    // Persist a row even on a network/API exception. Without this, lastCall
    // stays null forever and the 4h cadence gate above never engages — an
    // erroring key gets hammered every cycle instead of backing off.
    const fb = { ...FALLBACK_REGIME };
    recordCall(db, {
      pair, regime: fb, summary, usage: { inputTokens: 0, outputTokens: 0 }, estCost: 0,
      source: timedOut ? 'claude_timeout' : 'claude_error',
      ...attribution, snapshotId, rawText: String(err.message ?? err).slice(0, 300),
      ts: new Date(nowMs).toISOString(),
    });
    return {
      regime: lastCall ? decayed(lastCall) : fb,
      evaluation: evaluation(timedOut ? REGIME_OUTCOMES.TIMEOUT : REGIME_OUTCOMES.PROVIDER_ERROR, { ...attribution }),
    };
  }
}

// Backward-compatible wrapper: returns ONLY the regime object, with exactly
// the semantics the trading engine has always consumed. Every existing caller
// keeps working unchanged; callers that need to know whether a fresh provider
// call happened use evaluateRegime() instead.
export async function getRegime(pair, summary, db = getDb(), nowMs = Date.now(), opts = {}) {
  const { regime } = await evaluateRegime(pair, summary, db, nowMs, opts);
  return regime;
}
