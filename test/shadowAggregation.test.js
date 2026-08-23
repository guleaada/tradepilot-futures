// Step 3: aggregation over comparison records.
//
// Pure computation on frozen fixtures plus a cross-check against the real
// loader on a scratch in-memory database. No provider, no key, no production
// database, no writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { aggregateComparisons, loadComparisons } from '../src/ai/shadowAnalysis.js';

// --- fixture builder -------------------------------------------------------

// Builds a record in the canonical loader shape. `agreement: null` models a
// comparable row whose tradability could not be established.
function rec({
  pair = 'BTCUSDT', provider = 'mistral', model = 'm', primaryRegime = 'bullish',
  shadowRegime = null, comparable = true, agreement = true, confidenceDelta = 0,
  estCost = 0.001, pricingStatus = 'exact', reason = null, snapshotId = 's',
} = {}) {
  return deepFreeze({
    snapshotId,
    pair,
    primary: {
      provider: 'anthropic', model: 'claude-sonnet-4-6', regime: primaryRegime,
      confidence: 60, tradeAllowed: true, source: 'claude', status: 'success',
    },
    shadow: {
      provider, model, regime: shadowRegime ?? primaryRegime, confidence: 60 + (confidenceDelta ?? 0),
      tradeAllowed: true, status: comparable ? 'success' : 'error',
      estCost, pricingStatus,
    },
    comparison: {
      regimeMatch: comparable ? agreement === true : null,
      confidenceDelta: comparable ? confidenceDelta : null,
      tradeAllowedMatch: comparable ? agreement === true : null,
      agreement: comparable ? agreement : null,
      comparable,
      reason: comparable ? null : (reason ?? 'shadow_not_success'),
    },
  });
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

// --- shape and empty populations ------------------------------------------

test('empty input yields zeroed totals and null rates — never NaN', () => {
  const a = aggregateComparisons([]);
  assert.deepEqual(a.totals, { rows: 0, comparable: 0, incomparable: 0, agreements: 0, disagreements: 0, agreementRate: null });
  assert.deepEqual(a.byProvider, {});
  assert.deepEqual(a.byRegime, {});
  assert.deepEqual(a.byPair, {});
  assert.deepEqual(a.costs, { known: 0, unknown: 0, total: 0 });
  // Defensive: bad input must not throw.
  assert.deepEqual(aggregateComparisons().totals.rows, 0);
  assert.deepEqual(aggregateComparisons(null).totals.rows, 0);
  const json = JSON.stringify(aggregateComparisons([]));
  assert.doesNotMatch(json, /NaN|Infinity/);
});

test('the returned shape has exactly the specified keys', () => {
  const a = aggregateComparisons([rec()]);
  assert.deepEqual(Object.keys(a).sort(), ['byPair', 'byProvider', 'byRegime', 'costs', 'totals']);
  assert.deepEqual(Object.keys(a.totals).sort(), ['agreementRate', 'agreements', 'comparable', 'disagreements', 'incomparable', 'rows']);
  assert.deepEqual(Object.keys(a.byProvider.mistral).sort(), ['agreementRate', 'agreements', 'avgAbsoluteConfidenceDelta', 'avgConfidenceDelta', 'comparable', 'disagreements', 'incomparable', 'rows', 'shadowCost']);
  assert.deepEqual(Object.keys(a.byRegime.bullish).sort(), ['agreementRate', 'agreements', 'comparable', 'disagreements', 'rows']);
  assert.deepEqual(Object.keys(a.byPair.BTCUSDT).sort(), ['agreementRate', 'agreements', 'avgAbsoluteConfidenceDelta', 'avgConfidenceDelta', 'comparable', 'disagreements', 'rows']);
  assert.deepEqual(Object.keys(a.costs).sort(), ['known', 'total', 'unknown']);
});

// --- agreement semantics ---------------------------------------------------

test('statistical sanity: 10 comparable rows, 7 agree, 3 disagree -> 0.7', () => {
  const records = [
    ...Array.from({ length: 7 }, () => rec({ agreement: true })),
    ...Array.from({ length: 3 }, () => rec({ agreement: false })),
  ];
  const a = aggregateComparisons(records);
  assert.equal(a.totals.rows, 10);
  assert.equal(a.totals.comparable, 10);
  assert.equal(a.totals.agreements, 7);
  assert.equal(a.totals.disagreements, 3);
  assert.equal(a.totals.agreementRate, 0.7);
});

test('all agreements -> 1; all disagreements -> 0', () => {
  assert.equal(aggregateComparisons([rec(), rec()]).totals.agreementRate, 1);
  const dis = aggregateComparisons([rec({ agreement: false }), rec({ agreement: false })]);
  assert.equal(dis.totals.agreementRate, 0);
  assert.equal(dis.totals.disagreements, 2);
});

test('incomparable rows are never disagreements and never affect the rate', () => {
  const base = [rec({ agreement: true }), rec({ agreement: false })];
  const withNoise = [
    ...base,
    rec({ comparable: false, reason: 'shadow_not_success' }),
    rec({ comparable: false, reason: 'primary_not_success' }),
    rec({ comparable: false, reason: 'primary_mock' }),
  ];
  const a = aggregateComparisons(withNoise);
  assert.equal(a.totals.rows, 5);
  assert.equal(a.totals.comparable, 2);
  assert.equal(a.totals.incomparable, 3);
  assert.equal(a.totals.disagreements, 1, 'the 3 unusable rows are NOT disagreements');
  assert.equal(a.totals.agreementRate, 0.5, 'rate is over comparable rows only');
  assert.equal(a.totals.agreementRate, aggregateComparisons(base).totals.agreementRate);
});

test('all incomparable -> agreementRate null, not 0', () => {
  const a = aggregateComparisons([rec({ comparable: false }), rec({ comparable: false })]);
  assert.equal(a.totals.comparable, 0);
  assert.equal(a.totals.incomparable, 2);
  assert.equal(a.totals.agreementRate, null, 'null means "no basis", 0 would mean "never agreed"');
  assert.equal(a.byProvider.mistral.agreementRate, null);
});

// --- confidence statistics -------------------------------------------------

test('signed and absolute confidence averages are computed independently', () => {
  const deltas = [-10, -5, 0, 5, 10];
  const a = aggregateComparisons(deltas.map((d) => rec({ confidenceDelta: d })));
  assert.equal(a.byProvider.mistral.avgConfidenceDelta, 0, 'signed mean of a symmetric set');
  assert.equal(a.byProvider.mistral.avgAbsoluteConfidenceDelta, 6, '(10+5+0+5+10)/5');
  assert.equal(a.byPair.BTCUSDT.avgConfidenceDelta, 0);
  assert.equal(a.byPair.BTCUSDT.avgAbsoluteConfidenceDelta, 6);

  // Asymmetric: the signed mean must not be washed out by the absolute one.
  const b = aggregateComparisons([-10, -20].map((d) => rec({ confidenceDelta: d })));
  assert.equal(b.byProvider.mistral.avgConfidenceDelta, -15);
  assert.equal(b.byProvider.mistral.avgAbsoluteConfidenceDelta, 15);
});

test('null / non-numeric deltas are ignored, and an empty population is null', () => {
  const a = aggregateComparisons([
    rec({ confidenceDelta: 10 }),
    rec({ confidenceDelta: null }),
    rec({ comparable: false }),          // delta null via incomparable
  ]);
  assert.equal(a.byProvider.mistral.avgConfidenceDelta, 10, 'averaged over the one usable delta');
  assert.equal(a.byProvider.mistral.avgAbsoluteConfidenceDelta, 10);

  const none = aggregateComparisons([rec({ confidenceDelta: null })]);
  assert.equal(none.byProvider.mistral.avgConfidenceDelta, null);
  assert.equal(none.byProvider.mistral.avgAbsoluteConfidenceDelta, null);
});

test('deltas are not rounded internally', () => {
  const a = aggregateComparisons([rec({ confidenceDelta: 1 }), rec({ confidenceDelta: 2 })]);
  assert.equal(a.byProvider.mistral.avgConfidenceDelta, 1.5);
});

// --- cost semantics --------------------------------------------------------

test('null estCost is unknown, never free; zero is a known zero', () => {
  const a = aggregateComparisons([
    rec({ estCost: 0.002 }),
    rec({ estCost: null, pricingStatus: 'unknown' }),
    rec({ estCost: 0, pricingStatus: 'exact' }),
  ]);
  assert.equal(a.costs.known, 2, 'a $0 cost is KNOWN');
  assert.equal(a.costs.unknown, 1);
  assert.equal(a.costs.total, 0.002, 'unknown contributes nothing rather than 0');
  assert.equal(a.byProvider.mistral.shadowCost, 0.002);
});

test('cost is counted for incomparable rows too — a failed call can still bill', () => {
  const a = aggregateComparisons([rec({ comparable: false, estCost: 0.0005 })]);
  assert.equal(a.costs.known, 1);
  assert.equal(a.costs.total, 0.0005);
  assert.equal(a.byProvider.mistral.shadowCost, 0.0005);
});

// --- dimensions ------------------------------------------------------------

test('each provider gets an independent bucket', () => {
  const a = aggregateComparisons([
    rec({ provider: 'gemini', agreement: true }),
    rec({ provider: 'gemini', agreement: false }),
    rec({ provider: 'mistral', agreement: true }),
    rec({ provider: 'openrouter', comparable: false }),
  ]);
  assert.deepEqual(Object.keys(a.byProvider), ['gemini', 'mistral', 'openrouter'], 'sorted');
  assert.equal(a.byProvider.gemini.agreementRate, 0.5);
  assert.equal(a.byProvider.mistral.agreementRate, 1);
  assert.equal(a.byProvider.openrouter.comparable, 0);
  assert.equal(a.byProvider.openrouter.agreementRate, null, 'zero comparable -> null, not 0');
  assert.equal(a.byProvider.openrouter.rows, 1);
});

test('missing provider / regime / pair collapse to "unknown" without crashing', () => {
  // Built raw rather than through rec(), whose default parameters would
  // substitute values for genuinely ABSENT fields and hide the case.
  const bare = { comparison: { comparable: true, agreement: true, confidenceDelta: null } };
  const blank = {
    pair: '   ',
    primary: { regime: '' },
    shadow: { provider: null, estCost: null },
    comparison: { comparable: true, agreement: true, confidenceDelta: null },
  };
  const a = aggregateComparisons([bare, blank]);
  assert.equal(a.byProvider.unknown.rows, 2, 'absent and blank provider share one bucket');
  assert.equal(a.byRegime.unknown.rows, 2);
  assert.equal(a.byPair.unknown.rows, 2);
  assert.equal(a.totals.rows, 2);
  assert.equal(a.totals.agreements, 2);
  assert.equal(a.costs.unknown, 2, 'absent estCost is unknown, not free');
  assert.equal(a.costs.total, 0);
  // Entirely empty objects and nulls must not throw either.
  assert.equal(aggregateComparisons([{}, null, undefined]).totals.rows, 3);
});

test('regimes and pairs bucket independently', () => {
  const a = aggregateComparisons([
    rec({ primaryRegime: 'bullish', pair: 'BTCUSDT', agreement: true }),
    rec({ primaryRegime: 'bullish', pair: 'ETHUSDT', agreement: false }),
    rec({ primaryRegime: 'chop', pair: 'BTCUSDT', agreement: false }),
    rec({ primaryRegime: 'bearish', pair: 'SOLUSDT', agreement: true }),
  ]);
  assert.deepEqual(Object.keys(a.byRegime), ['bearish', 'bullish', 'chop']);
  assert.deepEqual(Object.keys(a.byPair), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(a.byRegime.bullish.agreementRate, 0.5);
  assert.equal(a.byRegime.chop.agreementRate, 0, 'disagreement concentrated in chop');
  assert.equal(a.byPair.BTCUSDT.agreementRate, 0.5);
  assert.equal(a.byPair.SOLUSDT.agreementRate, 1);
  // Every dimension sees every row.
  const sum = (o) => Object.values(o).reduce((n, b) => n + b.rows, 0);
  assert.equal(sum(a.byRegime), 4);
  assert.equal(sum(a.byPair), 4);
  assert.equal(sum(a.byProvider), 4);
});

// --- determinism -----------------------------------------------------------

test('output is byte-identical regardless of input order', () => {
  const records = [
    rec({ provider: 'openrouter', pair: 'SOLUSDT', primaryRegime: 'chop', agreement: false, confidenceDelta: -7 }),
    rec({ provider: 'gemini', pair: 'BTCUSDT', primaryRegime: 'bullish', agreement: true, confidenceDelta: 3 }),
    rec({ provider: 'mistral', pair: 'ETHUSDT', primaryRegime: 'bearish', comparable: false, estCost: null }),
    rec({ provider: 'gemini', pair: 'BTCUSDT', primaryRegime: 'bullish', agreement: false, confidenceDelta: 11 }),
  ];
  const forward = JSON.stringify(aggregateComparisons(records));
  const reversed = JSON.stringify(aggregateComparisons([...records].reverse()));
  const shuffled = JSON.stringify(aggregateComparisons([records[2], records[0], records[3], records[1]]));
  assert.equal(reversed, forward);
  assert.equal(shuffled, forward);
  assert.equal(JSON.stringify(aggregateComparisons(records)), forward, 'repeatable');
});

// --- purity ----------------------------------------------------------------

test('aggregation never mutates its input (fixtures are deep-frozen)', () => {
  const records = [rec({ agreement: true }), rec({ agreement: false, provider: 'gemini' })];
  const before = JSON.stringify(records);
  aggregateComparisons(records);
  aggregateComparisons(records);
  assert.equal(JSON.stringify(records), before);
});

test('aggregating loader output leaves the records and the database untouched', () => {
  const db = openDb(':memory:');
  const SNAP = 'a'.repeat(64);
  db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,raw_json,
    summary_json,input_tokens,output_tokens,est_cost,source,provider,model,snapshot_id,pricing_status)
    VALUES ('2026-08-01T00:00:00Z','BTCUSDT','bullish',60,1,'r','{}','{}',0,0,0,'claude','anthropic','claude-sonnet-4-6',?,'exact')`).run(SNAP);
  const ins = db.prepare(`INSERT INTO ai_shadow_calls (created_at,snapshot_id,pair,provider,model,status,
    regime,confidence,trade_allowed,input_tokens,output_tokens,est_cost,pricing_status)
    VALUES ('2026-08-01T00:00:01Z',?,'BTCUSDT',?,'m','success',?,?,1,0,0,?,'exact')`);
  ins.run(SNAP, 'mistral', 'bullish', 71, 0.002);
  ins.run(SNAP, 'gemini', 'bearish', 50, 0.001);
  ins.run(SNAP, 'mistral', 'bullish', 71, 0.002);   // duplicate: loader dedupes

  const { records, meta } = loadComparisons(db);
  assert.equal(meta.duplicateShadowRowsDropped, 1);
  assert.equal(records.length, 2, 'aggregation sees deduplicated rows only');

  const recordsBefore = JSON.stringify(records);
  const dbBefore = JSON.stringify(db.prepare('SELECT * FROM ai_shadow_calls ORDER BY id').all());
  const a = aggregateComparisons(records);
  assert.equal(JSON.stringify(records), recordsBefore, 'records unchanged');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM ai_shadow_calls ORDER BY id').all()), dbBefore, 'db unchanged');

  assert.equal(a.totals.rows, 2);
  assert.equal(a.totals.agreements, 1);
  assert.equal(a.totals.disagreements, 1);
  assert.equal(a.totals.agreementRate, 0.5);
  assert.equal(a.costs.total, 0.003, 'the duplicate is not double-counted');
  db.close();
});

// --- static isolation audit ------------------------------------------------

test('isolation audit: the aggregation module stays pure and read-only', () => {
  const raw = fs.readFileSync(new URL('../src/ai/shadowAnalysis.js', import.meta.url), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /require\s*\(/);
  assert.doesNotMatch(code, /process\.env/);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /\.run\s*\(/);
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE', 'ALTER TABLE']) {
    assert.ok(!new RegExp(kw, 'i').test(code), `must not contain ${kw}`);
  }
});
