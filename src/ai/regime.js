// Claude regime-call module. The AI layer only emits an opinion:
//   { regime, confidence, trade_allowed, reasoning }
// It NEVER sizes positions, sets leverage, or places orders — that is the
// rule engine's job. In this futures fork a confident `bearish` call is
// actionable (short entry), not just a "stay out" signal.
import { config } from '../config.js';
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

const SYSTEM_PROMPT = [
  'You are the market-regime analyst for a crypto paper-trading research system on FUTURES,',
  'which can go LONG on bullish regimes and SHORT on bearish regimes.',
  'You receive a compact JSON market summary for one trading pair.',
  'Classify the current regime and decide whether the deterministic rule engine should be allowed to trade.',
  'A confident bearish call enables short entries — it is a directional opinion, not just a risk-off flag.',
  'Some pairs are precious metals (gold XAUUSDT, silver XAGUSDT). Metals are macro-driven, trend more smoothly than crypto, and are often uncorrelated with it — treat a clean metals trend as high-conviction.',
  'For metals especially, favor trend continuation over counter-trend calls; their reversals are slower and cleaner than crypto\'s.',
  'Goal: commit to a clear directional call whenever the evidence genuinely supports one. Do not retreat to "chop" out of excess caution when momentum, RSI, volume, and EMA alignment actually agree on a direction — a moderate-but-real edge is tradable.',
  'When indicators align on a direction with decent momentum, lean bullish or bearish with confidence 55-75 rather than defaulting to chop.',
  'But "chop" remains the honest answer in true sideways, conflicting, or low-conviction conditions. Never manufacture a signal that is not there — a forced trade is worse than no trade.',
  'For SHORTS specifically: weight the risk of sharp counter-trend bounces and short squeezes. Require clean bearish structure (price below key EMAs, real downside momentum), not merely a pullback within an uptrend.',
  'You do not size positions, set leverage, pick entries, or place orders.',
  'Inside <thinking>, use at most 3 short bullet points (one line each).',
  'Do not restate the input data; go straight to the regime judgment.',
  'Then immediately close </thinking> and output the JSON.',
  'After </thinking>, output ONLY valid raw JSON, no markdown, no code fences, exactly this schema:',
  '{"regime":"bullish"|"bearish"|"chop","confidence":<integer 0-100>,"trade_allowed":true|false,"reasoning":"non-empty, max 2 sentences"}',
].join(' ');

// Clean truncation: an opened <thinking> that never closed (so no JSON could
// follow). Distinct from a schema error on a complete response — the salvage
// path retries this once with more room.
export function isTruncatedThinking(text) {
  if (typeof text !== 'string') return false;
  return /<thinking>/i.test(text) && !/<\/thinking>/i.test(text);
}

// Parse defensively: strip <thinking> blocks and code fences, extract the
// outermost JSON object, then validate strictly — regime in the known set,
// confidence an integer (clamped to 0-100), trade_allowed boolean, reasoning
// a non-empty string (truncated to 200 chars). Returns null on any failure.
export function parseRegimeResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let body = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/[\s\S]*<\/thinking>/i, (m) => (m.includes('<thinking') ? m : '')) // tolerate a lone closing tag
    .trim();
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
  const confidence = Number(obj.confidence);
  if (!Number.isInteger(confidence)) return null;
  if (typeof obj.trade_allowed !== 'boolean') return null;
  const reasoning = obj.reasoning ?? obj.reason;
  if (typeof reasoning !== 'string' || !reasoning.trim()) return null;
  return {
    regime: obj.regime,
    confidence: Math.max(0, Math.min(100, confidence)),
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

async function callClaude(summary, maxTokens = config.aiMaxOutputTokens) {
  const res = await fetch(`${config.anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.aiModel,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(summary) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: data.usage || { input_tokens: 0, output_tokens: 0 } };
}

// Optional free pre-filter: ask Groq whether anything materially changed.
// Returns true ("call Claude") on any doubt or failure.
async function groqSaysChanged(summary, lastSummaryJson) {
  if (!config.groqApiKey || !lastSummaryJson) return true;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
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
  } catch {
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

function recordCall(db, pair, regime, summary, usage, estCost, source, rawText, ts = nowIso()) {
  db.prepare(
    `INSERT INTO regime_calls
       (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json,
        input_tokens, output_tokens, est_cost, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    pair,
    regime.regime,
    regime.confidence,
    regime.trade_allowed ? 1 : 0,
    regime.reasoning,
    rawText ?? JSON.stringify(regime),
    JSON.stringify(summary),
    usage.input_tokens || 0,
    usage.output_tokens || 0,
    estCost,
    source,
  );
}

// Main entry: returns the regime the rule engine should use this cycle.
// Respects AI cadence, the Groq pre-filter, and the hard daily budget cap.
// `nowMs` is overridable so tests can run the cadence on sim time.
export async function getRegime(pair, summary, db = getDb(), nowMs = Date.now()) {
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
    recordCall(db, pair, mock, summary, { input_tokens: 0, output_tokens: 0 }, 0, 'mock', null, new Date(nowMs).toISOString());
    return mock;
  }

  const lastCall = db
    .prepare('SELECT * FROM regime_calls WHERE pair = ? ORDER BY id DESC LIMIT 1')
    .get(pair);
  const ageHours = lastCall ? (nowMs - Date.parse(lastCall.ts)) / 3_600_000 : Infinity;

  // Cadence: never call Claude more often than every aiCadenceHours per pair.
  if (lastCall && ageHours < config.aiCadenceHours) {
    return rowToRegime(lastCall);
  }

  // Groq pre-filter: skip Claude if nothing changed, unless the last call is
  // older than aiMaxStaleHours.
  if (lastCall && ageHours < config.aiMaxStaleHours) {
    const changed = await groqSaysChanged(summary, lastCall.summary_json);
    if (!changed) {
      logEvent('GROQ_SKIPPED', { pair, ageHours: Number(ageHours.toFixed(2)) }, db);
      return rowToRegime(lastCall);
    }
  }

  // Hard daily budget cap.
  const estCost = estimateCallCost();
  warnIfBudgetMisconfigured(estCost, config.aiDailyBudgetUsd, 'anthropic', db);
  if (wouldExceedBudget(estCost, config.aiDailyBudgetUsd, db)) {
    logEvent('BUDGET_SKIPPED', { pair, estCost }, db);
    return lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME };
  }

  if (!config.anthropicApiKey) {
    logEvent('AI_ERROR', { pair, error: 'ANTHROPIC_API_KEY not set' }, db);
    return lastCall ? decayed(lastCall) : { ...FALLBACK_REGIME };
  }

  try {
    let { text, usage } = await callClaude(summary);
    let cost = costFromUsage(usage.input_tokens || 0, usage.output_tokens || 0);
    addSpend(cost, db);
    const tsIso = new Date(nowMs).toISOString();

    let parsed = parseRegimeResponse(text);

    // Salvage path: clean truncation (opened <thinking>, never closed) means
    // we ran out of output room, not a schema error. Log the failure, then
    // retry exactly once with double the token ceiling.
    if (!parsed && isTruncatedThinking(text)) {
      logEvent('REGIME_PARSE_FAILURE', { pair, reason: 'truncated_thinking', raw: String(text).slice(0, 300) }, db);
      const retry = await callClaude(summary, config.aiMaxOutputTokens * 2);
      const retryCost = costFromUsage(retry.usage.input_tokens || 0, retry.usage.output_tokens || 0);
      addSpend(retryCost, db);
      logEvent('REGIME_RETRY', { pair, maxTokens: config.aiMaxOutputTokens * 2 }, db);
      text = retry.text;
      usage = retry.usage;
      cost += retryCost;
      parsed = parseRegimeResponse(text);
    }

    if (!parsed) {
      logEvent('REGIME_PARSE_FAILURE', { pair, raw: String(text).slice(0, 300) }, db);
      const fb = { ...FALLBACK_REGIME };
      recordCall(db, pair, fb, summary, usage, cost, 'claude_parse_fail', text, tsIso);
      return fb;
    }
    recordCall(db, pair, parsed, summary, usage, cost, 'claude', text, tsIso);
    return parsed;
  } catch (err) {
    logEvent('AI_ERROR', { pair, error: String(err).slice(0, 300) }, db);
    // Persist a row even on a network/API exception. Without this, lastCall
    // stays null forever and the 4h cadence gate above never engages — an
    // erroring key gets hammered every cycle instead of backing off.
    const fb = { ...FALLBACK_REGIME };
    recordCall(db, pair, fb, summary, { input_tokens: 0, output_tokens: 0 }, 0, 'claude_error', String(err).slice(0, 300), new Date(nowMs).toISOString());
    return lastCall ? decayed(lastCall) : fb;
  }
}
