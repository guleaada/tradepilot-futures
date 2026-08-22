// Shadow cadence: shadow follows PRIMARY freshness.
//
// Shadow providers may only run when the primary actually called a provider
// and got a usable regime for this cycle's snapshot. Comparing a fresh shadow
// answer against a cached or fallback primary is an invalid comparison — and
// burns provider quota every cycle for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { REGIME_OUTCOMES, evaluateRegime, getRegime } from '../src/ai/regime.js';
import { createSnapshotId } from '../src/ai/snapshot.js';
import { getShadowCalls } from '../src/ai/shadow.js';
import { runCycle, __setActivePairs, __setExecutor } from '../src/index.js';

const GOOD_JSON = '{"regime":"bullish","confidence":71,"trade_allowed":true,"reasoning":"Trend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2 };

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
const claudeOk = (text = GOOD_JSON) => jsonResponse({
  content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 },
});

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

const LIVE = { mock: false, aiProvider: 'anthropic', anthropicApiKey: 'test-not-real', groqApiKey: '' };

async function evaluateWith(fetchImpl, cfg, { db, summary = SUMMARY, pair = 'BTCUSDT' }) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await withConfig({ ...LIVE, ...cfg }, () =>
      evaluateRegime(pair, summary, db, Date.now(), { snapshotId: createSnapshotId(summary) }));
  } finally { globalThis.fetch = saved; }
}

// Seed a prior primary call so the cadence gate can hit.
function seedPriorCall(db, { pair = 'BTCUSDT', hoursAgo = 1, summaryJson = '{"pair":"BTCUSDT"}' } = {}) {
  db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json,
       input_tokens, output_tokens, est_cost, source, provider, model, snapshot_id)
     VALUES (?, ?, 'bearish', 64, 1, 'prior', '{}', ?, 10, 5, 0.001, 'claude', 'anthropic', 'claude-sonnet-4-6', 'prior-snap')`,
  ).run(new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), pair, summaryJson);
}

// --- C. explicit freshness metadata --------------------------------------

test('C: freshness is explicit metadata, not inferred from strings or timestamps', async () => {
  const db = openDb(':memory:');
  const out = await evaluateWith(async () => claudeOk(), {}, { db });
  assert.equal(typeof out.evaluation.fresh, 'boolean');
  assert.equal(out.evaluation.fresh, true);
  assert.equal(out.evaluation.outcome, REGIME_OUTCOMES.FRESH);
  assert.equal(out.evaluation.provider, 'anthropic');
  assert.equal(out.regime.regime, 'bullish', 'regime semantics unchanged');
  // exactly one outcome is fresh
  const fresh = Object.values(REGIME_OUTCOMES).filter((o) => o === REGIME_OUTCOMES.FRESH);
  assert.equal(fresh.length, 1);
  db.close();
});

test('C2: getRegime() still returns the bare regime — every existing caller is unaffected', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => claudeOk();
  try {
    const regime = await withConfig(LIVE, () => getRegime('BTCUSDT', SUMMARY, db));
    assert.deepEqual(Object.keys(regime).sort(), ['confidence', 'reasoning', 'regime', 'trade_allowed']);
    assert.equal(regime.evaluation, undefined, 'no metadata leaks into the trading object');
  } finally { globalThis.fetch = saved; db.close(); }
});

// --- A / D–H. every non-fresh outcome ------------------------------------

test('A + D–H: only a fresh provider call is fresh; every cache/fallback path is not', async () => {
  const cases = [
    // A: cached inside the AI cadence window
    ['A cached', REGIME_OUTCOMES.CACHED, async (db) => {
      seedPriorCall(db, { hoursAgo: 1 }); // < aiCadenceHours (4)
      return evaluateWith(async () => { throw new Error('provider must NOT be called'); }, {}, { db });
    }],
    // D: provider answered but the output cannot be parsed
    ['D parse_failure', REGIME_OUTCOMES.PARSE_FAILURE, (db) =>
      evaluateWith(async () => claudeOk('{"regime":"moonish","confidence":"high"}'), {}, { db })],
    // E: timeout
    ['E timeout', REGIME_OUTCOMES.TIMEOUT, (db) =>
      evaluateWith((url, opts = {}) => new Promise((_r, reject) => {
        const { signal } = opts;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }), { aiRequestTimeoutMs: 50 }, { db })],
    // F: provider HTTP error
    ['F provider_error', REGIME_OUTCOMES.PROVIDER_ERROR, (db) =>
      evaluateWith(async () => new Response('boom', { status: 500 }), {}, { db })],
    // G: budget gate
    ['G budget_skip', REGIME_OUTCOMES.BUDGET_SKIP, (db) =>
      evaluateWith(async () => { throw new Error('provider must NOT be called'); }, { aiDailyBudgetUsd: 0 }, { db })],
    // H: missing credentials
    ['H missing_key', REGIME_OUTCOMES.MISSING_KEY, (db) =>
      evaluateWith(async () => { throw new Error('provider must NOT be called'); }, { anthropicApiKey: '' }, { db })],
    // mock mode is explicitly NOT fresh
    ['mock', REGIME_OUTCOMES.MOCK, (db) =>
      evaluateWith(async () => { throw new Error('provider must NOT be called'); }, { mock: true }, { db })],
  ];

  for (const [label, expected, run] of cases) {
    const db = openDb(':memory:');
    const out = await run(db);
    assert.equal(out.evaluation.outcome, expected, `${label}: outcome`);
    assert.equal(out.evaluation.fresh, false, `${label}: must NOT be fresh -> no shadow comparison`);
    assert.ok(out.regime && typeof out.regime.regime === 'string', `${label}: trading still gets a usable regime`);
    db.close();
  }
});

test('A2: the Groq pre-filter cache path is also not fresh', async () => {
  const db = openDb(':memory:');
  seedPriorCall(db, { hoursAgo: 5 }); // past cadence, inside staleness -> Groq runs
  const out = await evaluateWith(async (url) => {
    if (String(url).includes('groq')) return jsonResponse({ choices: [{ message: { content: 'no' } }] });
    throw new Error('primary must NOT be called when Groq says nothing changed');
  }, { groqApiKey: 'gsk-test' }, { db });
  assert.equal(out.evaluation.outcome, REGIME_OUTCOMES.CACHED_UNCHANGED);
  assert.equal(out.evaluation.fresh, false);
  db.close();
});

// --- real cycle: A, B, I, J, K through runCycle ---------------------------

// Serve everything runCycle needs offline: binance market data + the primary
// provider. config.mock stays FALSE so the real (non-mock) regime path runs.
function cycleFetch({ onPrimary, shadowImpl }) {
  const candles = Array.from({ length: 220 }, (_, i) => {
    const close = 60000 * (1 + 0.0006 * i);
    return [i * 3600000, String(close * 0.999), String(close * 1.003), String(close * 0.997), String(close), '1000', i * 3600000 + 3599999, '0', 0, '0', '0', '0'];
  });
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/klines')) return jsonResponse(candles);
    if (u.includes('/ticker/24hr')) return jsonResponse({ lastPrice: '63000', priceChangePercent: '1.2', volume: '1000', quoteVolume: '900000000' });
    if (u.includes('premiumIndex')) return jsonResponse({ lastFundingRate: '0.0001' });
    if (u.includes('anthropic')) return onPrimary(url, opts);
    if (shadowImpl) return shadowImpl(url, opts);
    return jsonResponse({});
  };
}

async function runOneCycle({ db, onPrimary, shadowImpl = null, cfg = {} }) {
  const savedFetch = globalThis.fetch;
  const executor = { calls: 0, async reconcile() { return true; },
    async openPosition() { this.calls++; return { skipped: 'test' }; },
    async closePosition() { this.calls++; return { skipped: 'test' }; } };
  globalThis.fetch = cycleFetch({ onPrimary, shadowImpl });
  __setActivePairs(['BTCUSDT']);
  __setExecutor(executor);
  try {
    await withConfig({ ...LIVE, dbPath: ':memory:', pairs: ['BTCUSDT'], ...cfg }, () => runCycle(db));
    return executor;
  } finally {
    globalThis.fetch = savedFetch;
    __setActivePairs([...config.pairs]);
    __setExecutor(null);
  }
}

test('B + I: a FRESH primary triggers shadow, sharing the exact snapshot_id', async () => {
  const db = openDb(':memory:');
  let shadowHits = 0;
  await runOneCycle({
    db,
    onPrimary: async () => claudeOk(),
    shadowImpl: async (url) => {
      if (String(url).includes('generativelanguage')) {
        shadowHits++;
        return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"regime":"bearish","confidence":60,"trade_allowed":true,"reasoning":"Shadow view."}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
      }
      return jsonResponse({});
    },
    cfg: { aiShadowMode: true, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real' },
  });

  assert.equal(shadowHits, 1, 'shadow ran exactly once for the fresh primary');
  const shadow = getShadowCalls(db);
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].status, 'success');
  // I: exact correlation preserved from Step 8
  const joined = db.prepare(`SELECT r.snapshot_id AS p, s.snapshot_id AS s FROM regime_calls r
    JOIN ai_shadow_calls s ON s.snapshot_id = r.snapshot_id AND s.pair = r.pair`).all();
  assert.equal(joined.length, 1, 'primary and shadow join exactly');
  assert.equal(joined[0].p, joined[0].s);
  db.close();
});

test('A3 (real cycle): a CACHED primary makes ZERO primary and ZERO shadow calls', async () => {
  const db = openDb(':memory:');
  seedPriorCall(db, { hoursAgo: 1 }); // inside the cadence window
  let primaryHits = 0;
  let shadowHits = 0;
  await runOneCycle({
    db,
    onPrimary: async () => { primaryHits++; return claudeOk(); },
    shadowImpl: async (url) => { if (String(url).includes('generativelanguage')) shadowHits++; return jsonResponse({}); },
    cfg: { aiShadowMode: true, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real' },
  });
  assert.equal(primaryHits, 0, 'primary served from cache');
  assert.equal(shadowHits, 0, 'and therefore NO shadow calls');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_shadow_calls').get().n, 0, 'no shadow rows written');
  db.close();
});

test('D2 (real cycle): a primary parse failure produces no shadow comparison', async () => {
  const db = openDb(':memory:');
  let shadowHits = 0;
  await runOneCycle({
    db,
    onPrimary: async () => claudeOk('{"regime":"moonish","confidence":"high"}'),
    shadowImpl: async (url) => { if (String(url).includes('generativelanguage')) shadowHits++; return jsonResponse({}); },
    cfg: { aiShadowMode: true, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real' },
  });
  assert.equal(shadowHits, 0, 'no valid primary prediction -> nothing to compare against');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_shadow_calls').get().n, 0);
  // trading still got its safe fallback, recorded as before
  assert.equal(db.prepare('SELECT source FROM regime_calls ORDER BY id DESC LIMIT 1').get().source, 'claude_parse_fail');
  db.close();
});

test('J: a hanging shadow provider never blocks trading, and the drain still waits', async () => {
  const db = openDb(':memory:');
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  // The shadow provider blocks on `gate`. We release it on a timer that fires
  // AFTER the trading loop has had ample time to finish, so if the cycle had
  // awaited the shadow before runPairRules, the ordering below would invert.
  const cyclePromise = runOneCycle({
    db,
    onPrimary: async () => claudeOk(),
    shadowImpl: async (url) => {
      if (String(url).includes('generativelanguage')) {
        order.push('shadow-started');
        await gate;
        order.push('shadow-finished');
        return jsonResponse({ candidates: [{ content: { parts: [{ text: GOOD_JSON }] } }], usageMetadata: {} });
      }
      return jsonResponse({});
    },
    cfg: {
      aiShadowMode: true, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real',
      aiRequestTimeoutMs: 5000, // deliberately long: the cycle must not wait it out
    },
  });

  const timer = setTimeout(() => { order.push('release'); release(); }, 40);
  const startedAt = Date.now();
  await cyclePromise;
  clearTimeout(timer);

  assert.ok(order.includes('shadow-started'), 'the shadow call was started');
  assert.ok(order.indexOf('release') < order.indexOf('shadow-finished'),
    `shadow resolved only after the release: ${order.join(' -> ')}`);
  // The cycle DID wait at the end-of-cycle drain (it returned after the
  // release), but never anywhere near the 5s shadow timeout.
  assert.ok(Date.now() - startedAt < 4000, 'the cycle never waited out the shadow timeout');
  assert.equal(getShadowCalls(db).length, 1, 'the end-of-cycle drain still persisted the shadow row');
  assert.equal(getShadowCalls(db)[0].status, 'success');
  db.close();
});

test('K: a max-conviction shadow response still causes zero executor calls and zero trades', async () => {
  const db = openDb(':memory:');
  const executor = await runOneCycle({
    db,
    // primary says chop -> the engine must not trade
    onPrimary: async () => claudeOk('{"regime":"chop","confidence":20,"trade_allowed":false,"reasoning":"No edge."}'),
    shadowImpl: async (url) => {
      if (String(url).includes('generativelanguage')) {
        return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"regime":"bullish","confidence":100,"trade_allowed":true,"reasoning":"MAX CONVICTION BUY."}' }] } }], usageMetadata: {} });
      }
      return jsonResponse({});
    },
    cfg: { aiShadowMode: true, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real' },
  });
  const shadow = getShadowCalls(db);
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].regime, 'bullish');
  assert.equal(shadow[0].confidence, 100, 'the shadow screamed BUY...');
  assert.equal(executor.calls, 0, '...and the executor was never called');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
  db.close();
});

test('R: with AI_SHADOW_MODE off, a fresh primary still makes zero shadow calls', async () => {
  const db = openDb(':memory:');
  let shadowHits = 0;
  await runOneCycle({
    db,
    onPrimary: async () => claudeOk(),
    shadowImpl: async (url) => { if (String(url).includes('generativelanguage')) shadowHits++; return jsonResponse({}); },
    cfg: { aiShadowMode: false, aiShadowProviders: ['gemini'], geminiApiKey: 'test-not-real' },
  });
  assert.equal(shadowHits, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_shadow_calls').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, 1, 'the primary still ran');
  db.close();
});
