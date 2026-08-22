// Bounded-deadline regression locks for the AI layer.
//
// Before this, callClaude() and groqSaysChanged() called fetch() with no
// timeout: a hung provider socket stalled the entire cycle behind it (the CI
// job caps at 10 minutes), which would silently skip stop/exit management for
// every pair queued after the wedged pair. These tests prove the deadline is
// wired, that a timeout is classified as a provider failure, and — most
// importantly — that a timeout can never produce a trade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getRegime, isTimeoutError, FALLBACK_REGIME } from '../src/ai/regime.js';
import { runPairRules } from '../src/engine/rules.js';

// A fetch that NEVER resolves on its own — it only ever settles by rejecting
// when the caller's AbortSignal fires. If the code under test forgot to pass a
// signal, the promise hangs forever and the test fails on timeout: that is the
// assertion. `reason` is the DOMException AbortSignal.timeout produces.
function hangingFetch(seen = []) {
  return (url, opts = {}) => new Promise((_resolve, reject) => {
    seen.push(String(url));
    const { signal } = opts;
    if (!signal) return; // no deadline wired -> hangs -> test fails (intended)
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Run `fn` with the AI layer forced live (not mock), a short deadline, and a
// stub fetch — restoring every global/config field afterwards.
async function withAiEnv({ fetchImpl, timeoutMs = 60, groqKey = '' }, fn) {
  const saved = {
    fetch: globalThis.fetch,
    mock: config.mock,
    key: config.anthropicApiKey,
    groq: config.groqApiKey,
    timeout: config.aiRequestTimeoutMs,
  };
  globalThis.fetch = fetchImpl;
  config.mock = false;
  config.anthropicApiKey = 'sk-ant-TEST-SECRET-DO-NOT-LEAK';
  config.groqApiKey = groqKey;
  config.aiRequestTimeoutMs = timeoutMs;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    config.mock = saved.mock;
    config.anthropicApiKey = saved.key;
    config.groqApiKey = saved.groq;
    config.aiRequestTimeoutMs = saved.timeout;
  }
}

test('isTimeoutError recognizes every shape Node surfaces an aborted deadline as', () => {
  assert.equal(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  // undici often wraps the DOMException as err.cause
  assert.equal(isTimeoutError({ name: 'TypeError', cause: { name: 'TimeoutError' } }), true);
  assert.equal(isTimeoutError(new Error('The operation was aborted due to timeout')), true);
  // genuine non-timeout failures must NOT be misclassified
  assert.equal(isTimeoutError(new Error('Anthropic API 500: server error')), false);
  assert.equal(isTimeoutError(null), false);
});

test('Claude request aborts on the deadline and returns the safe chop fallback', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const regime = await withAiEnv({ fetchImpl: hangingFetch(seen) }, () =>
    getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));

  assert.ok(seen.some((u) => u.includes('/v1/messages')), 'the Anthropic call was attempted');
  // safe fallback: chop, zero confidence, trading NOT allowed
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.equal(regime.trade_allowed, false);

  // classified as a timeout, distinct from a generic AI_ERROR
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'AI_TIMEOUT'").get();
  assert.ok(ev, 'AI_TIMEOUT event logged');
  assert.equal(JSON.parse(ev.detail).timeoutMs, 60);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'AI_ERROR'").get().n, 0);

  // a row is still persisted so the cadence gate backs off instead of hammering
  const row = db.prepare('SELECT source, raw_json FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_timeout');
  db.close();
});

test('a timeout never leaks the API key into events or the database', async () => {
  const db = openDb(':memory:');
  await withAiEnv({ fetchImpl: hangingFetch() }, () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
  const dump = JSON.stringify([
    db.prepare('SELECT * FROM events').all(),
    db.prepare('SELECT * FROM regime_calls').all(),
  ]);
  assert.ok(!dump.includes('sk-ant-'), 'no API key material anywhere in persisted state');
  assert.ok(!dump.includes('TEST-SECRET'), 'no secret fragment persisted');
  db.close();
});

test('Groq pre-filter timeout fails OPEN, is logged, and does not block the Claude decision', async () => {
  const db = openDb(':memory:');
  // A prior call 5h old: past the 4h cadence gate, inside the 8h staleness
  // window — exactly the window where the Groq pre-filter runs.
  const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source)
     VALUES (?, 'BTCUSDT', 'bullish', 70, 1, 'prior', '{}', '{"pair":"BTCUSDT"}', 0, 0, 0, 'claude')`,
  ).run(fiveHoursAgo);

  const seen = [];
  const hang = hangingFetch(seen);
  // Groq hangs; Anthropic answers normally.
  const fetchImpl = (url, opts) => (String(url).includes('groq')
    ? hang(url, opts)
    : (seen.push(String(url)), Promise.resolve(jsonResponse({
      content: [{ type: 'text', text: '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}' }],
      usage: { input_tokens: 100, output_tokens: 40 },
    }))));

  const regime = await withAiEnv({ fetchImpl, groqKey: 'gsk-test' }, () =>
    getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));

  assert.ok(seen.some((u) => u.includes('groq')), 'Groq was attempted');
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'GROQ_TIMEOUT'").get();
  assert.ok(ev, 'GROQ_TIMEOUT logged distinctly');
  assert.equal(JSON.parse(ev.detail).pair, 'BTCUSDT');
  // failing open means the real decision still happened
  assert.ok(seen.some((u) => u.includes('/v1/messages')), 'fell through to Claude');
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.confidence, 66);
  db.close();
});

test('a timeout does not throw out of the cycle: the next pair still gets a live regime', async () => {
  const db = openDb(':memory:');
  const seen = [];
  const hang = hangingFetch(seen);
  // BTC's request hangs; ETH's answers. Simulates one wedged pair mid-cycle.
  let call = 0;
  const fetchImpl = (url, opts) => {
    call += 1;
    if (call === 1) return hang(url, opts);
    seen.push(String(url));
    return Promise.resolve(jsonResponse({
      content: [{ type: 'text', text: '{"regime":"bullish","confidence":71,"trade_allowed":true,"reasoning":"Trend intact."}' }],
      usage: { input_tokens: 100, output_tokens: 40 },
    }));
  };

  await withAiEnv({ fetchImpl }, async () => {
    // must RESOLVE (never reject) — a rejection here would kill the cycle
    const first = await getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db);
    assert.equal(first.trade_allowed, false, 'wedged pair degrades to no-trade');
    const second = await getRegime('ETHUSDT', { pair: 'ETHUSDT' }, db);
    assert.equal(second.regime, 'bullish', 'the cycle continued for the next pair');
    assert.equal(second.confidence, 71);
  });
  db.close();
});

test('a timeout can NEVER open a trade: the fallback regime is refused by the entry gate', async () => {
  const db = openDb(':memory:');
  const regime = await withAiEnv({ fetchImpl: hangingFetch() }, () =>
    getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));

  // Wire the timed-out regime straight into the rule engine with an executor
  // that detonates if anything tries to place an order.
  const executor = {
    async openPosition() { throw new Error('an order was placed off a timed-out regime'); },
    async closePosition() { throw new Error('an order was placed off a timed-out regime'); },
  };
  const actions = await runPairRules({
    pair: 'BTCUSDT',
    price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.5, adx4h: 40, // an otherwise-perfect long setup
    regime,
    executor,
    cfg: { ...config, weekendFilterEnabled: false, volTargetingEnabled: false },
    db,
  });

  assert.deepEqual(actions.map((a) => a.type), ['no_entry']);
  assert.equal(actions[0].reason, 'no_directional_regime');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, 'zero trades created');
  db.close();
});
