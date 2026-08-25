// Provider/model attribution on regime_calls.
//
// Experimental-integrity guarantees locked here:
//   source   = call OUTCOME (unchanged values, existing queries keep working)
//   provider = WHO served it
//   model    = the EXACT model id, or NULL — never a guess
// Historical rows must migrate additively, stay readable, and never gain a
// fabricated model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getRegime } from '../src/ai/regime.js';
import { closeTrade, openTrade } from '../src/engine/portfolio.js';
import { addSpend, getDailySpend } from '../src/ai/budget.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

// A pre-migration database: the exact legacy regime_calls DDL, no
// provider/model columns, carrying real-looking historical rows.
function legacyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-attr-'));
  const file = path.join(dir, 'legacy.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE regime_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT NOT NULL,
      pair          TEXT NOT NULL,
      regime        TEXT NOT NULL,
      confidence    REAL NOT NULL,
      trade_allowed INTEGER NOT NULL,
      reasoning     TEXT,
      raw_json      TEXT,
      summary_json  TEXT,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      est_cost      REAL DEFAULT 0,
      source        TEXT DEFAULT 'claude'
    )`);
  const ins = old.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('2026-07-04T09:00:00Z', 'BTCUSDT', 'bullish', 68, 1, 'trend intact', '<thinking>..</thinking>{}', '{"pair":"BTCUSDT"}', 1500, 210, 0.0077, 'claude');
  ins.run('2026-07-04T13:00:00Z', 'ETHUSDT', 'chop', 0, 0, 'parse_failure', 'garbage', '{"pair":"ETHUSDT"}', 1400, 300, 0.0087, 'claude_parse_fail');
  ins.run('2026-07-05T01:00:00Z', 'SOLUSDT', 'chop', 0, 0, 'parse_failure', 'boom', '{"pair":"SOLUSDT"}', 0, 0, 0, 'claude_error');
  ins.run('2026-07-05T05:00:00Z', 'XRPUSDT', 'chop', 0, 0, 'parse_failure', 'timeout', '{"pair":"XRPUSDT"}', 0, 0, 0, 'claude_timeout');
  ins.run('2026-07-05T06:00:00Z', 'BNBUSDT', 'bullish', 72, 1, 'mock', null, '{"pair":"BNBUSDT"}', 0, 0, 0, 'mock');
  // an unrecognized source: provider must NOT be invented for it
  ins.run('2026-07-05T07:00:00Z', 'LTCUSDT', 'chop', 10, 0, 'who knows', null, '{}', 0, 0, 0, 'something_unknown');
  old.close();
  return { file, dir };
}

// --- A. migration -------------------------------------------------------

test('A: a fresh database has provider/model columns', () => {
  const db = openDb(':memory:');
  const c = cols(db, 'regime_calls');
  assert.ok(c.includes('provider'), 'provider column present');
  assert.ok(c.includes('model'), 'model column present');
  assert.ok(c.includes('source'), 'source column retained');
  db.close();
});

test('A2: an existing pre-migration database migrates and keeps every row readable', () => {
  const { file, dir } = legacyDb();
  try {
    const before = new Database(file);
    assert.ok(!cols(before, 'regime_calls').includes('provider'), 'starts without provider');
    const beforeRows = before.prepare('SELECT * FROM regime_calls ORDER BY id').all();
    before.close();

    const db = openDb(file);
    assert.ok(cols(db, 'regime_calls').includes('provider'));
    assert.ok(cols(db, 'regime_calls').includes('model'));

    const after = db.prepare('SELECT * FROM regime_calls ORDER BY id').all();
    assert.equal(after.length, beforeRows.length, 'no rows lost');
    // every pre-existing field survives untouched
    for (let i = 0; i < beforeRows.length; i++) {
      for (const k of Object.keys(beforeRows[i])) {
        assert.deepEqual(after[i][k], beforeRows[i][k], `row ${i} field ${k} preserved`);
      }
    }
    db.close();

    // idempotent: re-opening does not duplicate columns or re-run the backfill
    const again = openDb(file);
    assert.equal(cols(again, 'regime_calls').filter((n) => n === 'provider').length, 1);
    assert.equal(again.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, beforeRows.length);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- B. historical data -------------------------------------------------

test('B: provider is inferred only where certain; model is NEVER fabricated', () => {
  const { file, dir } = legacyDb();
  try {
    const db = openDb(file);
    const byPair = Object.fromEntries(
      db.prepare('SELECT pair, source, provider, model FROM regime_calls').all().map((r) => [r.pair, r]));

    // every claude* outcome came from the only provider that ever ran
    for (const pair of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
      assert.equal(byPair[pair].provider, 'anthropic', `${pair} (${byPair[pair].source}) -> anthropic`);
    }
    assert.equal(byPair.BNBUSDT.provider, 'mock');
    // unrecognized source: no guess
    assert.equal(byPair.LTCUSDT.provider, null, 'unknown source keeps provider NULL');

    // NOT ONE historical row gets a model — the record contains no evidence
    const models = db.prepare('SELECT DISTINCT model FROM regime_calls').all();
    assert.deepEqual(models, [{ model: null }], 'all historical models are NULL');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls WHERE model IS NOT NULL').get().n, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- C. new Anthropic call ---------------------------------------------

test('C: a new Anthropic call persists provider=anthropic and the configured model', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    content: [{ type: 'text', text: GOOD_JSON }],
    usage: { input_tokens: 1500, output_tokens: 80 },
  });
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-test', aiModel: 'claude-sonnet-4-6', groqApiKey: '' },
      () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
    const row = db.prepare('SELECT * FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.model, 'claude-sonnet-4-6');
    assert.equal(row.source, 'claude', 'source still describes the OUTCOME');
    assert.equal(row.input_tokens, 1500);
    assert.equal(row.output_tokens, 80);
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

test('C2: attribution follows the configured model, not a hard-coded constant', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ content: [{ type: 'text', text: GOOD_JSON }], usage: { input_tokens: 1, output_tokens: 1 } });
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-test', aiModel: 'claude-opus-4-1-some-future-id', groqApiKey: '' },
      () => getRegime('ETHUSDT', { pair: 'ETHUSDT' }, db));
    assert.equal(db.prepare('SELECT model FROM regime_calls ORDER BY id DESC LIMIT 1').get().model, 'claude-opus-4-1-some-future-id');
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

test('C3: mock cycles record provider=mock with model NULL (no model ran)', async () => {
  const db = openDb(':memory:');
  await withConfig({ mock: true }, () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'mock');
  assert.equal(row.provider, 'mock');
  assert.equal(row.model, null, 'no model was invoked, so none is claimed');
  db.close();
});

// --- D. dimension separation -------------------------------------------

test('D: failure outcomes keep provider/model while source carries the outcome', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-test', aiModel: 'claude-sonnet-4-6', groqApiKey: '' },
      () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
    const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    // three independent dimensions on one row
    assert.equal(row.source, 'claude_error', 'outcome');
    assert.equal(row.provider, 'anthropic', 'who served it');
    assert.equal(row.model, 'claude-sonnet-4-6', 'the model the request was sent with');
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

test('D2: a provider that never resolves records the configured provider with NULL model', async () => {
  const db = openDb(':memory:');
  await withConfig({ mock: false, anthropicApiKey: 'sk-ant-test', aiProvider: 'not-a-provider', groqApiKey: '' },
    () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_error');
  assert.equal(row.provider, 'not-a-provider', 'what was configured');
  assert.equal(row.model, null, 'no model was ever selected, so none is claimed');
  db.close();
});

// --- E. multiple providers coexist -------------------------------------

test('E: rows from different providers/models coexist for one pair and date', () => {
  const db = openDb(':memory:');
  const ins = db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source, provider, model)
     VALUES (?, 'BTCUSDT', ?, ?, 1, 'r', '{}', '{}', 10, 5, 0.001, 'claude', ?, ?)`);
  ins.run('2026-07-09T09:00:00Z', 'bullish', 70, 'anthropic', 'claude-sonnet-4-6');
  ins.run('2026-07-09T09:00:01Z', 'bearish', 61, 'gemini', 'gemini-model-b');
  ins.run('2026-07-09T09:00:02Z', 'chop', 40, 'mistral', 'mistral-model-c');

  const rows = db.prepare("SELECT provider, model, regime FROM regime_calls WHERE pair='BTCUSDT' AND ts LIKE '2026-07-09%' ORDER BY id").all();
  assert.equal(rows.length, 3, 'three rows coexist; none overwrote another');
  assert.deepEqual(rows.map((r) => [r.provider, r.model, r.regime]), [
    ['anthropic', 'claude-sonnet-4-6', 'bullish'],
    ['gemini', 'gemini-model-b', 'bearish'],
    ['mistral', 'mistral-model-c', 'chop'],
  ]);
  // and they are independently attributable — the query a future comparison needs
  const byProvider = db.prepare('SELECT provider, COUNT(*) n FROM regime_calls GROUP BY provider ORDER BY provider').all();
  assert.deepEqual(byProvider, [
    { provider: 'anthropic', n: 1 }, { provider: 'gemini', n: 1 }, { provider: 'mistral', n: 1 },
  ]);
  db.close();
});

// --- F. existing functionality unaffected ------------------------------

test('F: budget accounting, regime accuracy and existing queries still work', () => {
  const db = openDb(':memory:');
  // budget
  addSpend(0.1234, db, '2026-07-09', 'anthropic');
  assert.ok(Math.abs(getDailySpend(db, '2026-07-09', 'anthropic') - 0.1234) < 1e-9);

  // regime accuracy still populated on close
  const id = openTrade({ pair: 'ETHUSDT', direction: 'short', qty: 1, fillPrice: 100, fee: 0, stopPrice: 106, tpPrice: 85, regimeAtEntry: 'bearish', confidenceAtEntry: 72 }, db);
  closeTrade(id, { fillPrice: 90, fee: 0, reason: 'tp' }, db);
  const acc = db.prepare('SELECT * FROM regime_accuracy').get();
  assert.equal(acc.regime_at_entry, 'bearish');
  assert.ok(acc.actual_return_pct > 0);

  // the report's query (SELECT *) and index.js's counter still work
  db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source, provider, model)
     VALUES ('2026-07-09T10:00:00Z','BTCUSDT','bullish',70,1,'r','{}','{}',10,5,0.001,'claude','anthropic','claude-sonnet-4-6')`).run();
  const reportRows = db.prepare('SELECT * FROM regime_calls ORDER BY id DESC LIMIT 10').all();
  assert.equal(reportRows.length, 1);
  assert.equal(reportRows[0].reasoning, 'r', 'existing report fields intact');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM regime_calls WHERE ts >= ?').get('2026-07-09T00:00:00').n, 1);

  // existing source values still round-trip
  assert.equal(db.prepare("SELECT COUNT(*) n FROM regime_calls WHERE source = 'claude'").get().n, 1);
  db.close();
});
