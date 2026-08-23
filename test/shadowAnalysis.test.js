// Step 2: the canonical primary/shadow comparison record.
//
// Everything here runs on scratch in-memory databases with synthetic rows.
// No provider is contacted, no key is read, no production database is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import {
  EVAL_STATUS, INCOMPARABLE, compareRecords, dedupeRows, hasShadowSchema,
  loadComparisons, normalizeStatus,
} from '../src/ai/shadowAnalysis.js';

// --- fixtures --------------------------------------------------------------

const SNAP = 'a'.repeat(64);

function insertPrimary(db, o = {}) {
  return db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning,
       raw_json, summary_json, input_tokens, output_tokens, est_cost, source, provider,
       model, snapshot_id, pricing_status)
     VALUES (@ts,@pair,@regime,@confidence,@trade_allowed,'r','{}','{}',0,0,0,@source,
             @provider,@model,@snapshot_id,'exact')`,
  ).run({
    ts: '2026-08-01T00:00:00.000Z', pair: 'BTCUSDT', regime: 'bullish', confidence: 60,
    trade_allowed: 1, source: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-6',
    snapshot_id: SNAP, ...o,
  }).lastInsertRowid;
}

function insertShadow(db, o = {}) {
  return db.prepare(
    `INSERT INTO ai_shadow_calls (created_at, snapshot_id, pair, provider, model, status,
       regime, confidence, trade_allowed, input_tokens, output_tokens, est_cost, pricing_status)
     VALUES (@created_at,@snapshot_id,@pair,@provider,@model,@status,@regime,@confidence,
             @trade_allowed,0,0,@est_cost,@pricing_status)`,
  ).run({
    created_at: '2026-08-01T00:00:01.000Z', snapshot_id: SNAP, pair: 'BTCUSDT',
    provider: 'mistral', model: 'mistral-large-2512', status: 'success', regime: 'bullish',
    confidence: 71, trade_allowed: 1, est_cost: 0.002, pricing_status: 'exact', ...o,
  }).lastInsertRowid;
}

// --- the canonical shape ---------------------------------------------------

test('the record carries every specified field, in the specified nesting', () => {
  const r = compareRecords(
    { provider: 'anthropic', model: 'claude-sonnet-4-6', regime: 'bullish', confidence: 60, trade_allowed: 1, source: 'claude', snapshot_id: SNAP, pair: 'BTCUSDT' },
    { provider: 'mistral', model: 'mistral-large-2512', regime: 'bullish', confidence: 71, trade_allowed: 1, status: 'success', pricing_status: 'exact', est_cost: 0.002, snapshot_id: SNAP, pair: 'BTCUSDT' },
  );
  assert.deepEqual(Object.keys(r).sort(), ['comparison', 'pair', 'primary', 'shadow', 'snapshotId']);
  assert.deepEqual(Object.keys(r.primary).sort(), ['confidence', 'model', 'provider', 'regime', 'source', 'status', 'tradeAllowed']);
  assert.deepEqual(Object.keys(r.shadow).sort(), ['confidence', 'estCost', 'model', 'pricingStatus', 'provider', 'regime', 'status', 'tradeAllowed']);
  assert.deepEqual(Object.keys(r.comparison).sort(), ['agreement', 'comparable', 'confidenceDelta', 'reason', 'regimeMatch', 'tradeAllowedMatch']);
  assert.equal(r.snapshotId, SNAP);
  assert.equal(r.pair, 'BTCUSDT');
});

test('agreement: same regime and same tradability', () => {
  const r = compareRecords(
    { regime: 'BULLISH ', confidence: 60, trade_allowed: 1, source: 'claude' },
    { regime: 'bullish', confidence: 71, trade_allowed: 1, status: 'success' },
  );
  assert.equal(r.comparison.comparable, true);
  assert.equal(r.comparison.reason, null);
  assert.equal(r.comparison.regimeMatch, true, 'case/whitespace insensitive');
  assert.equal(r.comparison.tradeAllowedMatch, true);
  assert.equal(r.comparison.agreement, true);
  assert.equal(r.comparison.confidenceDelta, 11, 'signed, shadow minus primary');
});

test('disagreement on the label, and on tradability, are both visible', () => {
  const label = compareRecords(
    { regime: 'bullish', confidence: 80, trade_allowed: 1, source: 'claude' },
    { regime: 'bearish', confidence: 55, trade_allowed: 1, status: 'success' },
  );
  assert.equal(label.comparison.regimeMatch, false);
  assert.equal(label.comparison.agreement, false);
  assert.equal(label.comparison.confidenceDelta, -25);

  const trade = compareRecords(
    { regime: 'bullish', confidence: 60, trade_allowed: 1, source: 'claude' },
    { regime: 'bullish', confidence: 60, trade_allowed: 0, status: 'success' },
  );
  assert.equal(trade.comparison.regimeMatch, true);
  assert.equal(trade.comparison.tradeAllowedMatch, false, 'shadow would have blocked the trade');
  assert.equal(trade.comparison.agreement, false);
  assert.equal(trade.comparison.confidenceDelta, 0);
});

// --- comparability ---------------------------------------------------------

test('an unusable evaluation is never scored as a disagreement', () => {
  for (const status of ['error', 'timeout', 'parse_failure']) {
    const r = compareRecords(
      { regime: 'bullish', confidence: 60, trade_allowed: 1, source: 'claude' },
      { regime: null, confidence: null, trade_allowed: null, status },
    );
    assert.equal(r.comparison.comparable, false, status);
    assert.equal(r.comparison.reason, INCOMPARABLE.SHADOW_NOT_SUCCESS);
    // The distinction this guards: false would mean "the models disagreed".
    assert.equal(r.comparison.regimeMatch, null);
    assert.equal(r.comparison.tradeAllowedMatch, null);
    assert.equal(r.comparison.agreement, null);
    assert.equal(r.comparison.confidenceDelta, null);
  }
});

test('a non-success PRIMARY blocks comparison, and mock is called out separately', () => {
  const errored = compareRecords(
    { regime: 'chop', confidence: 0, trade_allowed: 0, source: 'claude_error' },
    { regime: 'bullish', confidence: 70, trade_allowed: 1, status: 'success' },
  );
  assert.equal(errored.comparison.comparable, false);
  assert.equal(errored.comparison.reason, INCOMPARABLE.PRIMARY_NOT_SUCCESS);

  // A mock primary is synthetic — comparing a real model against it would be
  // meaningless, and it must not be lumped in with genuine failures.
  const mock = compareRecords(
    { regime: 'bullish', confidence: 72, trade_allowed: 1, source: 'mock' },
    { regime: 'bullish', confidence: 70, trade_allowed: 1, status: 'success' },
  );
  assert.equal(mock.comparison.comparable, false);
  assert.equal(mock.comparison.reason, INCOMPARABLE.PRIMARY_MOCK);
});

test('normalizeStatus maps the legacy claude* vocabulary onto shared words', () => {
  assert.equal(normalizeStatus('claude'), EVAL_STATUS.SUCCESS);
  assert.equal(normalizeStatus('claude_parse_fail'), EVAL_STATUS.PARSE_FAILURE);
  assert.equal(normalizeStatus('claude_timeout'), EVAL_STATUS.TIMEOUT);
  assert.equal(normalizeStatus('claude_error'), EVAL_STATUS.ERROR);
  assert.equal(normalizeStatus('mock'), EVAL_STATUS.MOCK);
  assert.equal(normalizeStatus('something-new'), EVAL_STATUS.UNKNOWN);
  assert.equal(normalizeStatus(null), EVAL_STATUS.UNKNOWN);
  // A Gemini primary still writes source='claude'; provider carries the truth.
  const r = compareRecords({ provider: 'gemini', source: 'claude', regime: 'bullish', confidence: 1, trade_allowed: 1 },
    { provider: 'mistral', status: 'success', regime: 'bullish', confidence: 1, trade_allowed: 1 });
  assert.equal(r.primary.provider, 'gemini');
  assert.equal(r.primary.status, EVAL_STATUS.SUCCESS);
});

test('an unknown shadow price stays NULL and is never read as free', () => {
  const r = compareRecords(
    { regime: 'bullish', confidence: 60, trade_allowed: 1, source: 'claude' },
    { regime: 'bullish', confidence: 60, trade_allowed: 1, status: 'success', est_cost: null, pricing_status: 'unknown' },
  );
  assert.equal(r.shadow.estCost, null);
  assert.notEqual(r.shadow.estCost, 0);
  assert.equal(r.shadow.pricingStatus, 'unknown');
});

// --- duplicates (Step 1 found no uniqueness constraint) --------------------

test('duplicate rows are deduplicated deterministically, newest id winning', () => {
  const key = (r) => JSON.stringify([r.snapshot_id, r.pair, r.provider, r.model]);
  const a = { id: 1, snapshot_id: SNAP, pair: 'BTCUSDT', provider: 'mistral', model: 'm', confidence: 10 };
  const b = { id: 2, snapshot_id: SNAP, pair: 'BTCUSDT', provider: 'mistral', model: 'm', confidence: 20 };
  const forward = dedupeRows([a, b], key);
  const reverse = dedupeRows([b, a], key);
  assert.equal(forward.rows.length, 1);
  assert.equal(forward.dropped, 1);
  assert.equal(forward.rows[0].confidence, 20, 'highest id wins');
  assert.deepEqual(reverse.rows, forward.rows, 'result is independent of input order');
});

// --- loading from a database ----------------------------------------------

test('loadComparisons builds records from persisted rows and reports coverage', () => {
  const db = openDb(':memory:');
  insertPrimary(db);
  insertShadow(db);                                            // agrees
  insertShadow(db, { provider: 'gemini', model: 'gemini-2.5-flash', regime: 'bearish', confidence: 50 });
  insertShadow(db, { provider: 'openrouter', model: 'x', status: 'timeout', regime: null, confidence: null, trade_allowed: null, est_cost: null, pricing_status: 'unknown' });
  // A shadow row whose primary never existed.
  insertShadow(db, { snapshot_id: 'b'.repeat(64), provider: 'mistral' });

  const { records, meta } = loadComparisons(db);
  assert.equal(meta.schemaReady, true);
  assert.equal(meta.shadowRows, 4);
  assert.equal(meta.shadowRowsWithoutPrimary, 1);
  assert.equal(records.length, 3);
  assert.equal(meta.comparable, 2);
  assert.equal(meta.incomparable, 1);

  const byProvider = Object.fromEntries(records.map((r) => [r.shadow.provider, r]));
  assert.equal(byProvider.mistral.comparison.agreement, true);
  assert.equal(byProvider.gemini.comparison.regimeMatch, false);
  assert.equal(byProvider.openrouter.comparison.comparable, false);
  assert.equal(byProvider.openrouter.comparison.reason, INCOMPARABLE.SHADOW_NOT_SUCCESS);
  db.close();
});

test('output is deterministic and independent of insertion order', () => {
  const build = (order) => {
    const db = openDb(':memory:');
    insertPrimary(db);
    for (const p of order) insertShadow(db, { provider: p, model: `${p}-model` });
    const { records } = loadComparisons(db);
    db.close();
    return JSON.stringify(records);
  };
  const a = build(['mistral', 'gemini', 'openrouter']);
  const b = build(['openrouter', 'mistral', 'gemini']);
  assert.equal(a, b, 'same rows in a different order produce identical output');
  assert.equal(a, build(['mistral', 'gemini', 'openrouter']), 'repeatable');
});

test('reading never mutates the database', () => {
  const db = openDb(':memory:');
  insertPrimary(db);
  insertShadow(db);
  const snap = () => JSON.stringify({
    s: db.prepare('SELECT * FROM ai_shadow_calls ORDER BY id').all(),
    p: db.prepare('SELECT * FROM regime_calls ORDER BY id').all(),
  });
  const before = snap();
  loadComparisons(db);
  loadComparisons(db, { pair: 'BTCUSDT' });
  assert.equal(snap(), before, 'analysis is read-only');
  db.close();
});

test('a PRE-MIGRATION database yields an empty dataset, not a crash', () => {
  // Exactly the shape production is in today: regime_calls without
  // snapshot_id, and no ai_shadow_calls table at all.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE regime_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, pair TEXT,
    regime TEXT, confidence REAL, trade_allowed INTEGER, source TEXT)`);
  assert.equal(hasShadowSchema(db), false);
  const { records, meta } = loadComparisons(db);
  assert.deepEqual(records, []);
  assert.equal(meta.schemaReady, false);
  db.close();
});

test('filters narrow the dataset without changing the record shape', () => {
  const db = openDb(':memory:');
  insertPrimary(db);
  insertPrimary(db, { pair: 'ETHUSDT', snapshot_id: 'c'.repeat(64) });
  insertShadow(db);
  insertShadow(db, { pair: 'ETHUSDT', snapshot_id: 'c'.repeat(64) });
  assert.equal(loadComparisons(db).records.length, 2);
  assert.equal(loadComparisons(db, { pair: 'ETHUSDT' }).records.length, 1);
  assert.equal(loadComparisons(db, { provider: 'gemini' }).records.length, 0);
  assert.equal(loadComparisons(db, { snapshotId: SNAP }).records[0].pair, 'BTCUSDT');
  assert.equal(loadComparisons(db, { limit: 1 }).records.length, 1);
  db.close();
});

test('db handle is required — the module never reaches for a global one', () => {
  assert.throws(() => loadComparisons(null), TypeError);
  assert.throws(() => loadComparisons(), TypeError);
});

// --- static safety audit ---------------------------------------------------

test('safety audit: shadowAnalysis.js imports nothing and writes nothing', () => {
  const raw = fs.readFileSync(new URL('../src/ai/shadowAnalysis.js', import.meta.url), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  assert.doesNotMatch(code, /^\s*import\s/m, 'must import nothing at all');
  assert.doesNotMatch(code, /require\s*\(/, 'no CommonJS escape hatch either');
  // Specific prohibitions from the safety boundary.
  for (const forbidden of ['engine/', 'config.js', 'providers/', 'getDb', 'process.env', 'fetch(', 'alert']) {
    assert.ok(!code.includes(forbidden), `must not reference ${forbidden}`);
  }
  // Read-only: no write statement, no .run().
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
  assert.doesNotMatch(code, /\.run\s*\(/, 'better-sqlite3 writes go through .run()');
});
