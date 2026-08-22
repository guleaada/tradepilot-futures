// Exact primary <-> shadow correlation.
//
// The invariant: ONE snapshot id is created per market summary and handed to
// both paths, so regime_calls.snapshot_id and ai_shadow_calls.snapshot_id can
// be joined exactly. Neither path derives its own id, and historical rows are
// never given a fabricated one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { canonicalJson, createSnapshotId } from '../src/ai/snapshot.js';
import { getRegime } from '../src/ai/regime.js';
import { getShadowCalls, runShadowEvaluation } from '../src/ai/shadow.js';
import { runPairRules } from '../src/engine/rules.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2, ema_4h: { e50: 62000, e200: 61000 } };

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

function fakeProvider(name, behavior = {}) {
  return {
    name,
    keyEnvVar: `${name.toUpperCase()}_API_KEY`,
    isConfigured: () => true,
    get model() { return `${name}-test-model`; },
    async complete() {
      return {
        provider: name, model: `${name}-test-model`,
        text: behavior.text ?? GOOD_JSON,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

// --- A / B. the canonical algorithm --------------------------------------

test('A: key order is irrelevant — the id is semantic, not serialization-order', () => {
  assert.equal(createSnapshotId({ a: 1, b: 2 }), createSnapshotId({ b: 2, a: 1 }));
  assert.equal(
    createSnapshotId({ x: { p: 1, q: [1, { m: 2, n: 3 }] }, y: 5 }),
    createSnapshotId({ y: 5, x: { q: [1, { n: 3, m: 2 }] , p: 1 } }),
  );
  assert.match(createSnapshotId(SUMMARY), /^[0-9a-f]{64}$/, 'sha-256 hex');
  // arrays stay order-sensitive: [1,2] is genuinely different market data from [2,1]
  assert.notEqual(createSnapshotId({ v: [1, 2] }), createSnapshotId({ v: [2, 1] }));
  assert.equal(canonicalJson({ x: undefined }), '{"x":null}');
});

test('B: any meaningful change to the summary changes the id', () => {
  const base = createSnapshotId(SUMMARY);
  assert.notEqual(base, createSnapshotId({ ...SUMMARY, price: 63000.01 }));
  assert.notEqual(base, createSnapshotId({ ...SUMMARY, rsi14_1h: 48.3 }));
  assert.notEqual(base, createSnapshotId({ ...SUMMARY, ema_4h: { e50: 62000, e200: 61000.5 } }));
  assert.notEqual(base, createSnapshotId({ ...SUMMARY, pair: 'ETHUSDT' }));
  assert.equal(base, createSnapshotId({ ...SUMMARY }), 'identical values -> identical id');
});

test('B2: the id encodes the MARKET only — never provider, model, or credentials', async () => {
  // Same summary, wildly different provider/model/key config: identical id.
  const a = await withConfig({ aiProvider: 'anthropic', aiModel: 'claude-sonnet-4-6', anthropicApiKey: 'secret-a' },
    () => createSnapshotId(SUMMARY));
  const b = await withConfig({ aiProvider: 'mistral', aiModel: 'mistral-large-latest', mistralApiKey: 'secret-b' },
    () => createSnapshotId(SUMMARY));
  assert.equal(a, b, 'identity is the market state, not who answered');
  // and no secret material can be present in a hex digest
  assert.ok(!a.includes('secret'));
});

// --- C. primary persistence ---------------------------------------------

test('C: a primary regime call persists the supplied snapshot_id verbatim', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    content: [{ type: 'text', text: GOOD_JSON }], usage: { input_tokens: 100, output_tokens: 20 },
  });
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'test-not-real', groqApiKey: '' },
      () => getRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 'abc123' }));
    const row = db.prepare('SELECT snapshot_id, provider, model, source FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.snapshot_id, 'abc123');
    // attribution is unchanged by this step
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.source, 'claude');
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

test('C2: snapshot_id is persisted on failure outcomes too (and is NULL when not supplied)', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'test-not-real', groqApiKey: '' },
      () => getRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 'err-snap' }));
    const failed = db.prepare('SELECT snapshot_id, source FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(failed.source, 'claude_error');
    assert.equal(failed.snapshot_id, 'err-snap', 'a failed evaluation is still correlatable');

    // legacy call style (no options arg) still works and simply records NULL
    await withConfig({ mock: true }, () => getRegime('ETHUSDT', SUMMARY, db));
    const legacy = db.prepare('SELECT snapshot_id, source FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(legacy.source, 'mock');
    assert.equal(legacy.snapshot_id, null, 'never invented when not supplied');
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

// --- D. shadow persistence ----------------------------------------------

test('D: shadow rows use the supplied snapshot_id and never recompute it', async () => {
  const db = openDb(':memory:');
  const out = await withConfig({ aiShadowMode: true, aiProvider: 'anthropic' },
    () => runShadowEvaluation({
      pair: 'BTCUSDT', summary: SUMMARY, snapshotId: 'abc123', db,
      providers: [fakeProvider('gemini'), fakeProvider('mistral')],
    }));
  assert.equal(out.snapshotId, 'abc123');
  const rows = getShadowCalls(db);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.snapshot_id, 'abc123', `${r.provider} used the supplied id`);
  // it is NOT the hash of the summary — proving the supplied value won
  assert.notEqual('abc123', createSnapshotId(SUMMARY));
  db.close();
});

// --- E. exact correlation (the point of the step) ------------------------

test('E: primary and shadow rows for one market summary join exactly on snapshot_id', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    content: [{ type: 'text', text: '{"regime":"bullish","confidence":71,"trade_allowed":true,"reasoning":"Trend intact."}' }],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  try {
    // exactly what runCycle does: create ONCE, pass to both
    const snapshotId = createSnapshotId(SUMMARY);
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'test-not-real', groqApiKey: '', aiShadowMode: true },
      async () => {
        await getRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId });
        await runShadowEvaluation({
          pair: 'BTCUSDT', summary: SUMMARY, snapshotId, db,
          providers: [fakeProvider('gemini'), fakeProvider('mistral')],
        });
      });

    // the join a future comparison will run
    const joined = db.prepare(`
      SELECT r.provider AS primary_provider, r.regime AS primary_regime,
             s.provider AS shadow_provider, s.regime AS shadow_regime, s.snapshot_id
      FROM regime_calls r
      JOIN ai_shadow_calls s ON s.snapshot_id = r.snapshot_id AND s.pair = r.pair
      ORDER BY s.id`).all();

    assert.equal(joined.length, 2, 'both shadow rows join to the one primary row');
    assert.equal(joined[0].snapshot_id, snapshotId);
    assert.deepEqual(joined.map((j) => j.shadow_provider).sort(), ['gemini', 'mistral']);
    for (const j of joined) {
      assert.equal(j.primary_provider, 'anthropic');
      assert.equal(j.primary_regime, 'bullish', 'primary opinion');
      assert.equal(j.shadow_regime, 'bearish', 'shadow opinion — different, and attributable');
    }
  } finally {
    globalThis.fetch = saved;
    db.close();
  }
});

test('E2: a different market state produces a different join group', async () => {
  const db = openDb(':memory:');
  const other = { ...SUMMARY, price: 64000 };
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic' }, async () => {
    await runShadowEvaluation({ pair: 'BTCUSDT', summary: SUMMARY, snapshotId: createSnapshotId(SUMMARY), db, providers: [fakeProvider('gemini')] });
    await runShadowEvaluation({ pair: 'BTCUSDT', summary: other, snapshotId: createSnapshotId(other), db, providers: [fakeProvider('gemini')] });
  });
  const ids = db.prepare('SELECT DISTINCT snapshot_id FROM ai_shadow_calls').all();
  assert.equal(ids.length, 2, 'two market states, two snapshots — never conflated');
  db.close();
});

// --- F. no historical fabrication ---------------------------------------

test('F: a legacy DB migrates additively; historical rows keep NULL snapshot_id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-snap-'));
  const file = path.join(dir, 'legacy.db');
  try {
    // pre-snapshot_id schema, carrying real-looking history
    const old = new Database(file);
    old.exec(`
      CREATE TABLE regime_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, pair TEXT NOT NULL,
        regime TEXT NOT NULL, confidence REAL NOT NULL, trade_allowed INTEGER NOT NULL,
        reasoning TEXT, raw_json TEXT, summary_json TEXT,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        est_cost REAL DEFAULT 0, source TEXT DEFAULT 'claude',
        provider TEXT, model TEXT)`);
    const ins = old.prepare(`INSERT INTO regime_calls
      (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source, provider, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('2026-07-04T09:00:00Z', 'BTCUSDT', 'bullish', 68, 1, 'r', '{}', '{"pair":"BTCUSDT"}', 1500, 210, 0.0077, 'claude', 'anthropic', null);
    ins.run('2026-07-05T09:00:00Z', 'ETHUSDT', 'chop', 0, 0, 'p', 'x', '{"pair":"ETHUSDT"}', 0, 0, 0, 'claude_error', 'anthropic', null);
    const before = old.prepare('SELECT * FROM regime_calls ORDER BY id').all();
    old.close();

    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(regime_calls)').all().map((c) => c.name);
    assert.ok(cols.includes('snapshot_id'), 'column added');

    const after = db.prepare('SELECT * FROM regime_calls ORDER BY id').all();
    assert.equal(after.length, before.length, 'no rows lost');
    for (let i = 0; i < before.length; i++) {
      for (const k of Object.keys(before[i])) {
        assert.deepEqual(after[i][k], before[i][k], `row ${i} field ${k} untouched`);
      }
      assert.equal(after[i].snapshot_id, null, 'historical snapshot_id is NULL, never fabricated');
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls WHERE snapshot_id IS NOT NULL').get().n, 0);
    db.close();

    // idempotent: re-open twice more, still one column and no invented values
    for (let i = 0; i < 2; i++) {
      const again = openDb(file);
      assert.equal(again.prepare('PRAGMA table_info(regime_calls)').all().filter((c) => c.name === 'snapshot_id').length, 1);
      assert.equal(again.prepare('SELECT COUNT(*) n FROM regime_calls WHERE snapshot_id IS NOT NULL').get().n, 0);
      assert.equal(again.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, before.length);
      again.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: a fresh database has snapshot_id on regime_calls and ai_shadow_calls', () => {
  const db = openDb(':memory:');
  assert.ok(db.prepare('PRAGMA table_info(regime_calls)').all().map((c) => c.name).includes('snapshot_id'));
  assert.ok(db.prepare('PRAGMA table_info(ai_shadow_calls)').all().map((c) => c.name).includes('snapshot_id'));
  db.close();
});

// --- G. exactly one implementation --------------------------------------

test('G: the snapshot algorithm is defined in exactly ONE file', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  walk('src');

  // the hashing primitive must appear in one file only
  const hashers = files.filter((f) => /createHash\(\s*['"]sha256['"]\s*\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hashers, ['src/ai/snapshot.js'], `sha-256 snapshot hashing must live in one file, found: ${hashers.join(', ')}`);

  // and the canonicalizer must be DEFINED once (re-exports are fine)
  const definers = files.filter((f) => /^export function canonicalJson/m.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(definers, ['src/ai/snapshot.js'], `canonicalJson must be defined once, found: ${definers.join(', ')}`);

  // the cycle creates it; regime.js must never derive one
  const regimeSrc = fs.readFileSync('src/ai/regime.js', 'utf8');
  assert.ok(!/createSnapshotId|canonicalJson|createHash/.test(regimeSrc),
    'regime.js receives the id, never computes it');
  assert.ok(/createSnapshotId\(summary\)/.test(fs.readFileSync('src/index.js', 'utf8')),
    'the cycle is where the id is created');
});

// --- H. trading isolation still holds ------------------------------------

test('H: a max-conviction shadow response still cannot trade, correlation notwithstanding', async () => {
  const db = openDb(':memory:');
  const executor = {
    calls: 0,
    async openPosition() { this.calls++; throw new Error('shadow reached the executor'); },
    async closePosition() { this.calls++; throw new Error('shadow reached the executor'); },
  };
  const shouty = fakeProvider('gemini', {
    text: '{"regime":"bullish","confidence":100,"trade_allowed":true,"reasoning":"MAX CONVICTION BUY."}',
  });
  const snapshotId = createSnapshotId(SUMMARY);
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic' },
    () => runShadowEvaluation({ pair: 'BTCUSDT', summary: SUMMARY, snapshotId, db, providers: [shouty] }));

  const row = getShadowCalls(db)[0];
  assert.equal(row.regime, 'bullish');
  assert.equal(row.confidence, 100);
  assert.equal(row.snapshot_id, snapshotId, 'correlatable...');
  assert.equal(executor.calls, 0, '...but never executable');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);

  // the engine, given the PRIMARY chop regime, still refuses
  const actions = await runPairRules({
    pair: 'BTCUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.5, adx4h: 40,
    regime: { regime: 'chop', confidence: 0, trade_allowed: false, reasoning: 'parse_failure' },
    executor, cfg: { ...config, weekendFilterEnabled: false, volTargetingEnabled: false }, db,
  });
  assert.deepEqual(actions.map((a) => a.type), ['no_entry']);
  assert.equal(executor.calls, 0);
  db.close();
});
