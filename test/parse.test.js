import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getRegime, isTruncatedThinking, parseRegimeResponse } from '../src/ai/regime.js';

test('parses clean raw JSON', () => {
  const out = parseRegimeResponse(
    '{"regime":"bullish","confidence":72,"trade_allowed":true,"reasoning":"Uptrend intact."}',
  );
  assert.deepEqual(out, {
    regime: 'bullish',
    confidence: 72,
    trade_allowed: true,
    reasoning: 'Uptrend intact.',
  });
});

test('strips markdown code fences', () => {
  const out = parseRegimeResponse(
    '```json\n{"regime":"chop","confidence":40,"trade_allowed":false,"reasoning":"Range-bound."}\n```',
  );
  assert.equal(out.regime, 'chop');
  assert.equal(out.trade_allowed, false);
});

test('extracts JSON embedded in surrounding prose', () => {
  const out = parseRegimeResponse(
    'Here is my analysis: {"regime":"bearish","confidence":80,"trade_allowed":false,"reasoning":"Breakdown."} Hope this helps!',
  );
  assert.equal(out.regime, 'bearish');
});

test('clamps confidence into [0, 100]', () => {
  const out = parseRegimeResponse('{"regime":"bullish","confidence":250,"trade_allowed":true,"reasoning":"Strong trend."}');
  assert.equal(out.confidence, 100);
});

test('truncated thinking (opened <thinking>, never closed, no JSON) returns null', () => {
  // This is the production failure: max_tokens cut Claude off mid-reasoning.
  const truncated = '<thinking>\n- price above all EMAs\n- RSI healthy, momentum is essentially no mo';
  assert.equal(parseRegimeResponse(truncated), null);
  assert.equal(isTruncatedThinking(truncated), true);
});

test('isTruncatedThinking distinguishes truncation from complete/other responses', () => {
  // complete thinking block -> not truncation (it is a schema error if no JSON)
  assert.equal(isTruncatedThinking('<thinking>done</thinking>{"regime":"chop"}'), false);
  // no thinking tag at all -> not truncation
  assert.equal(isTruncatedThinking('{"regime":"bullish"}'), false);
  assert.equal(isTruncatedThinking('garbage'), false);
  assert.equal(isTruncatedThinking(''), false);
  assert.equal(isTruncatedThinking(null), false);
});

test('strips a <thinking> block before parsing', () => {
  const out = parseRegimeResponse(
    '<thinking>Step 1: price above all EMAs. Step 2: RSI healthy. So bullish.</thinking>\n' +
    '{"regime":"bullish","confidence":68,"trade_allowed":true,"reasoning":"Trend and momentum align."}',
  );
  assert.equal(out.regime, 'bullish');
  assert.equal(out.confidence, 68);
});

test('strict schema: non-integer confidence and empty reasoning are rejected', () => {
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72.5,"trade_allowed":true,"reasoning":"x"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72,"trade_allowed":true,"reasoning":""}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72,"trade_allowed":true}'), null);
  // long reasoning is truncated to 200 chars rather than rejected
  const long = parseRegimeResponse(`{"regime":"chop","confidence":40,"trade_allowed":false,"reasoning":"${'a'.repeat(300)}"}`);
  assert.equal(long.reasoning.length, 200);
});

test('a network/API exception persists a row so the 4h cadence gate re-engages', async () => {
  // getRegime reads the shared config singleton directly (no cfg param),
  // so drive it the same way other suites do: mutate and restore.
  const db = openDb(':memory:');
  const origMock = config.mock;
  const origKey = config.anthropicApiKey;
  const origFetch = globalThis.fetch;
  config.mock = false;
  config.anthropicApiKey = 'bad-key';
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('simulated network/auth failure'); };
  try {
    const summary = { pair: 'BTCUSDT' };
    await getRegime('BTCUSDT', summary, db);
    // the exception path must persist a row, not just log an event
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM regime_calls').get().n, 1);
    const row = db.prepare('SELECT source FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.source, 'claude_error');
    assert.equal(fetchCalls, 1);

    // a second call moments later must NOT hit the network again — the
    // cadence gate should now see the persisted row and reuse it.
    await getRegime('BTCUSDT', summary, db);
    assert.equal(fetchCalls, 1, 'cadence gate must prevent a second network call within 4h');
  } finally {
    config.mock = origMock;
    config.anthropicApiKey = origKey;
    globalThis.fetch = origFetch;
  }
  db.close();
});

test('rejects malformed and schema-invalid output', () => {
  assert.equal(parseRegimeResponse('not json at all'), null);
  assert.equal(parseRegimeResponse(''), null);
  assert.equal(parseRegimeResponse(null), null);
  assert.equal(parseRegimeResponse('{"regime":"moonish","confidence":50,"trade_allowed":true}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":"high","trade_allowed":true}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":50,"trade_allowed":"yes"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":50'), null);
  assert.equal(parseRegimeResponse('[1,2,3]'), null);
});
