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

test('rejects out-of-range confidence instead of clamping it', () => {
  // Previously 250 was clamped to 100, manufacturing MAXIMUM conviction from a
  // value the schema forbids. A malformed confidence is now a parse failure and
  // takes the same safe fallback path as any other unusable response.
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":250,"trade_allowed":true,"reasoning":"Strong trend."}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":-5,"trade_allowed":true,"reasoning":"x"}'), null);
  // The valid boundaries still parse.
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":0,"trade_allowed":true,"reasoning":"x"}').confidence, 0);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":100,"trade_allowed":true,"reasoning":"x"}').confidence, 100);
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
  const origProvider = config.aiProvider;
  const origFetch = globalThis.fetch;
  config.mock = false;
  // Exercises the ANTHROPIC provider specifically.
  config.aiProvider = 'anthropic';
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
    config.aiProvider = origProvider;
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

// --- ReDoS regression -------------------------------------------------------

// Median of 3 so a single GC pause cannot decide the result.
function medianParseMs(text) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    parseRegimeResponse(text);
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return runs.sort((a, b) => a - b)[1];
}

const bigBody = (n) => '{"regime":"bullish","confidence":64,"trade_allowed":true,"reasoning":"'
  + 'x'.repeat(n) + '"}';

test('parsing scales linearly, not quadratically, on large input', () => {
  // The <thinking> salvage used a greedy /[\s\S]*<\/thinking>/i. With no closing
  // tag present it retried from every start position: O(n^2), measured at 597ms
  // for 16KB and roughly fourfold per doubling. At 1MB that projects to tens of
  // minutes. It now uses lastIndexOf, which is O(n).
  parseRegimeResponse(bigBody(1000)); // warm up

  const sizes = [16_000, 64_000, 256_000, 1_000_000];
  const times = sizes.map((n) => medianParseMs(bigBody(n)));

  // Hard bound. Quadratic behaviour at 1MB projects to ~39 minutes, so this
  // rules it out with enormous margin and cannot flake on a slow machine.
  assert.ok(times[3] < 1000, `1MB must parse well under 1s, took ${times[3].toFixed(1)}ms`);

  // Growth check, normalised for size. Linear is ~1x; quadratic across this
  // 62.5x size range would be ~62x. A generous ceiling of 5 separates them
  // decisively without depending on absolute timings.
  const floor = 0.05; // ms - avoids dividing by a near-zero measurement
  const growth = (Math.max(times[3], floor) / Math.max(times[0], floor)) / (sizes[3] / sizes[0]);
  assert.ok(growth < 5,
    `normalised growth must stay near linear, got ${growth.toFixed(2)}x `
    + `(times: ${times.map((t) => t.toFixed(2)).join(', ')}ms)`);

  // A large-but-valid response is still parsed correctly, not just quickly.
  const parsed = parseRegimeResponse(bigBody(1_000_000));
  assert.equal(parsed.regime, 'bullish');
  assert.equal(parsed.confidence, 64);
  assert.equal(parsed.reasoning.length, 200, 'reasoning is still truncated to 200 chars');
});

test('the linear <thinking> strip is byte-equivalent to the regex it replaced', () => {
  // The exact semantics that had to be preserved: complete pairs are removed,
  // a LONE closing tag drops everything before it, an unclosed opening tag is
  // left alone, and matching is case-insensitive.
  const GOOD_JSON_LOCAL = '{"regime":"bullish","confidence":64,"trade_allowed":true,"reasoning":"x"}';
  const legacyStrip = (t) => t
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/[\s\S]*<\/thinking>/i, (m) => (m.includes('<thinking') ? m : ''))
    .trim();

  const cases = [
    GOOD_JSON_LOCAL,
    '<thinking>a</thinking>' + GOOD_JSON_LOCAL,
    'junk</thinking>' + GOOD_JSON_LOCAL,
    'a</thinking>b</thinking>' + GOOD_JSON_LOCAL,
    'X</THINKING>' + GOOD_JSON_LOCAL,
    '<thinking>never closed',
    '<THINKING>x</THINKING>' + GOOD_JSON_LOCAL,
    '',
  ];
  for (const c of cases) {
    // Parse the legacy-stripped text and the raw text through the live parser;
    // both must reach the same verdict.
    const viaLegacy = legacyStrip(c) === '' ? null : parseRegimeResponse(legacyStrip(c));
    const viaLive = parseRegimeResponse(c);
    assert.deepEqual(viaLive, viaLegacy, 'differs for: ' + JSON.stringify(c).slice(0, 50));
  }
});
