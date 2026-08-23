// Step 4: the read-only shadow-analysis CLI.
//
// Every case runs against a throwaway database created under os.tmpdir().
// The real production database is NEVER opened here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import {
  PRE_MIGRATION_MESSAGE, analyze, main, openReadOnly, parseArgs, renderSummary,
} from '../src/report/shadow.js';

const CLI = new URL('../src/report/shadow.js', import.meta.url).pathname;
const S1 = '1'.repeat(64), S2 = '2'.repeat(64), S3 = '3'.repeat(64);

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cli-')), name);
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// A realistic dataset: two pairs, bullish + bearish primaries, two shadow
// providers, agreement and disagreement, known and unknown cost, one duplicate
// shadow row, one incomparable row, one shadow without a primary, and one
// primary with no snapshot id.
function seed(file) {
  const db = openDb(file);
  const P = db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,
    raw_json,summary_json,input_tokens,output_tokens,est_cost,source,provider,model,snapshot_id,pricing_status)
    VALUES (?,?,?,?,1,'r','{}','{}',2000,400,0.012,'claude','anthropic','claude-sonnet-4-6',?,'exact')`);
  const H = db.prepare(`INSERT INTO ai_shadow_calls (created_at,snapshot_id,pair,provider,model,status,
    regime,confidence,trade_allowed,input_tokens,output_tokens,est_cost,pricing_status,latency_ms)
    VALUES (?,?,?,?,?,?,?,?,?,1000,300,?,?,?)`);
  P.run('2026-08-01T00:00:00Z', 'BTCUSDT', 'bullish', 64, S1);
  H.run('2026-08-01T00:00:01Z', S1, 'BTCUSDT', 'mistral', 'mistral-large-2512', 'success', 'bullish', 71, 1, 0.00105, 'exact', 842);
  H.run('2026-08-01T00:00:01Z', S1, 'BTCUSDT', 'gemini', 'gemini-2.5-flash', 'success', 'bearish', 55, 0, 0.00031, 'exact', 430);
  H.run('2026-08-01T00:00:09Z', S1, 'BTCUSDT', 'mistral', 'mistral-large-2512', 'success', 'bullish', 71, 1, 0.00105, 'exact', 844); // duplicate
  P.run('2026-08-01T04:00:00Z', 'ETHUSDT', 'bearish', 58, S2);
  H.run('2026-08-01T04:00:01Z', S2, 'ETHUSDT', 'mistral', 'mistral-large-2512', 'success', 'bearish', 66, 1, 0.00098, 'exact', 770);
  H.run('2026-08-01T04:00:01Z', S2, 'ETHUSDT', 'gemini', 'gemini-2.5-flash', 'timeout', null, null, null, null, 'unknown', 10000);
  H.run('2026-08-01T08:00:01Z', S3, 'SOLUSDT', 'mistral', 'mistral-large-2512', 'success', 'bullish', 60, 1, 0.00090, 'exact', 700); // no primary
  db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,raw_json,
    summary_json,input_tokens,output_tokens,est_cost,source)
    VALUES ('2026-07-01T00:00:00Z','BTCUSDT','chop',50,0,'r','{}','{}',0,0,0,'claude')`).run();
  db.close();
  return file;
}

const run = (args, file) => execFileSync(process.execPath, [CLI, '--db', file, ...args], { encoding: 'utf8' });
const runJson = (args, file) => JSON.parse(run([...args, '--json'], file));

// --- read-only guarantee ---------------------------------------------------

test('the CLI database handle is read-only, enforced by SQLite itself', () => {
  const file = seed(tmpFile('ro.db'));
  const db = openReadOnly(file);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_shadow_calls').get().c, 6, 'reads work');
  for (const sql of [
    "INSERT INTO events (ts,type,detail) VALUES ('a','b','c')",
    'CREATE TABLE zz (a INT)',
    'UPDATE regime_calls SET confidence = 0',
    'DELETE FROM ai_shadow_calls',
  ]) {
    assert.throws(() => db.prepare(sql).run(), (e) => e.code === 'SQLITE_READONLY', sql);
  }
  db.close();
});

test('Q: the database is byte-identical before and after a CLI run', () => {
  const file = seed(tmpFile('immutable.db'));
  const before = sha(file);
  run([], file);
  run(['--json'], file);
  run(['--pair', 'BTCUSDT'], file);
  assert.equal(sha(file), before, 'running the CLI must not alter one byte');
});

test('the CLI does not use openDb(), which would migrate a production database', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  // Checked against code only: a comment naming openDb to explain why it is
  // NOT used must not fail this.
  assert.doesNotMatch(code, /openDb/, 'openDb applies schema + migrations on open');
  assert.match(code, /readonly:\s*true/);
});

// --- A: empty dataset ------------------------------------------------------

test('A: an empty but migrated database reports no records, not agreement', () => {
  const file = tmpFile('empty.db');
  openDb(file).close();
  const out = run([], file);
  assert.match(out, /No shadow evaluation records found/);
  const j = runJson([], file);
  assert.equal(j.aggregate.totals.rows, 0);
  assert.equal(j.aggregate.totals.agreementRate, null, 'null, never 0');
  assert.doesNotMatch(out, /0\.0%/, 'must not present emptiness as 0% agreement');
});

// --- B: pre-migration ------------------------------------------------------

test('B: a pre-migration database reports the exact required message', () => {
  const file = tmpFile('old.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE regime_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, pair TEXT,
    regime TEXT, confidence REAL, trade_allowed INTEGER, source TEXT)`);
  db.close();
  assert.equal(run([], file).trim(), PRE_MIGRATION_MESSAGE);
  const j = runJson([], file);
  assert.equal(j.error, PRE_MIGRATION_MESSAGE);
  assert.equal(j.meta.schemaReady, false);
  assert.equal(j.aggregate, undefined, 'no aggregate is presented as if it were data');
});

// --- C: human-readable -----------------------------------------------------

test('C: human-readable output has the required sections and neutral language', () => {
  const out = run([], seed(tmpFile('human.db')));
  for (const section of ['Shadow Analysis', 'Rows:', 'Comparable:', 'Incomparable:',
    'Agreement rate:', 'By provider', 'By primary regime', 'By pair', 'Costs:']) {
    assert.ok(out.includes(section), `missing section: ${section}`);
  }
  assert.match(out, /Observed agreement/);
  // The primary is not ground truth — these words would assert otherwise.
  // The closing disclaimer is excluded from the scan: it DENIES accuracy
  // ("not accuracy"), which is the stance being enforced, not a breach of it.
  const body = out.split('Observed agreement measures')[0].toLowerCase();
  for (const banned of ['accuracy', 'accurate', 'best provider', 'worst', 'winner', 'winning']) {
    assert.doesNotMatch(body, new RegExp(banned), `must not claim "${banned}"`);
  }
  assert.match(out, /not accuracy and does not rank providers/);
});

test('C2: totals are correct — duplicate and orphan rows excluded', () => {
  const out = run([], seed(tmpFile('totals.db')));
  assert.match(out, /Rows:\s+4/);
  assert.match(out, /Comparable:\s+3/);
  assert.match(out, /Incomparable:\s+1/);
  assert.match(out, /Agreement rate:\s+66\.7%/);
  assert.match(out, /duplicate shadow rows dropped:\s+1/);
  assert.match(out, /shadow rows without a primary:\s+1/);
  assert.match(out, /primaries without a snapshot id:\s+1/);
});

// --- D/L: JSON + metadata --------------------------------------------------

test('D + L: JSON carries filters, full loader metadata, and the aggregate', () => {
  const j = runJson([], seed(tmpFile('json.db')));
  assert.deepEqual(Object.keys(j).sort(), ['aggregate', 'filters', 'meta']);
  for (const k of ['schemaReady', 'duplicateShadowRowsDropped', 'primaryRowsWithoutSnapshotId', 'shadowRowsWithoutPrimary']) {
    assert.ok(k in j.meta, `loader metadata must survive: ${k}`);
  }
  assert.equal(j.meta.duplicateShadowRowsDropped, 1);
  assert.equal(j.meta.shadowRowsWithoutPrimary, 1);
  assert.equal(j.meta.primaryRowsWithoutSnapshotId, 1);
  assert.equal(j.aggregate.totals.agreements, 2);
  assert.equal(j.aggregate.totals.disagreements, 1);
  // Raw precision is preserved; only the human view formats.
  assert.equal(j.aggregate.byProvider.gemini.shadowCost, 0.00031);
});

// --- E/F/G/H: filters ------------------------------------------------------

test('E: provider filter', () => {
  const file = seed(tmpFile('fprov.db'));
  const j = runJson(['--provider', 'mistral'], file);
  assert.deepEqual(Object.keys(j.aggregate.byProvider), ['mistral']);
  assert.equal(j.aggregate.totals.rows, 2, 'the SOLUSDT mistral row has no primary');
  assert.equal(j.filters.provider, 'mistral');
  assert.deepEqual(Object.keys(runJson(['--provider', 'gemini'], file).aggregate.byProvider), ['gemini']);
  assert.equal(runJson(['--provider', 'nope'], file).aggregate.totals.rows, 0);
});

test('F: pair filter', () => {
  const file = seed(tmpFile('fpair.db'));
  const j = runJson(['--pair', 'BTCUSDT'], file);
  assert.deepEqual(Object.keys(j.aggregate.byPair), ['BTCUSDT']);
  assert.equal(j.aggregate.totals.rows, 2);
  assert.equal(runJson(['--pair', 'ETHUSDT'], file).aggregate.totals.rows, 2);
  assert.equal(runJson(['--pair', 'XXXUSDT'], file).aggregate.totals.rows, 0);
});

test('G: primary-regime filter matches the PRIMARY label', () => {
  const file = seed(tmpFile('freg.db'));
  const bull = runJson(['--regime', 'bullish'], file);
  assert.deepEqual(Object.keys(bull.aggregate.byRegime), ['bullish']);
  assert.equal(bull.aggregate.totals.rows, 2, 'both BTCUSDT shadows share a bullish primary');
  // The gemini row here SAID bearish; it is still selected because the filter
  // is on the primary's regime, which is what the system acted on.
  assert.equal(bull.aggregate.byProvider.gemini.rows, 1);
  assert.equal(runJson(['--regime', 'BEARISH'], file).aggregate.totals.rows, 2, 'case-insensitive');
  assert.equal(runJson(['--regime', 'nonesuch'], file).aggregate.totals.rows, 0);
});

test('H: --limit takes the first N in the loader\'s data order, not by time', () => {
  const file = seed(tmpFile('flimit.db'));
  // Loader order is pair, snapshot_id, provider, model, id — so BTCUSDT sorts
  // before ETHUSDT, and gemini before mistral within a pair.
  assert.deepEqual(Object.keys(runJson(['--limit', '1'], file).aggregate.byPair), ['BTCUSDT']);
  assert.deepEqual(Object.keys(runJson(['--limit', '1'], file).aggregate.byProvider), ['gemini']);
  assert.equal(runJson(['--limit', '0'], file).aggregate.totals.rows, 0);
  assert.equal(runJson(['--limit', '99'], file).aggregate.totals.rows, 4, 'limit above the set is a no-op');
  // Limit applies AFTER filtering, so it always means "N of the filtered set".
  assert.equal(runJson(['--provider', 'mistral', '--limit', '1'], file).aggregate.totals.rows, 1);
  assert.deepEqual(Object.keys(runJson(['--provider', 'mistral', '--limit', '1'], file).aggregate.byProvider), ['mistral']);
});

test('filters combine, and are echoed back exactly as applied', () => {
  const file = seed(tmpFile('fcombo.db'));
  const j = runJson(['--pair', 'BTCUSDT', '--provider', 'mistral', '--regime', 'bullish', '--limit', '5'], file);
  assert.deepEqual(j.filters, { pair: 'BTCUSDT', provider: 'mistral', regime: 'bullish', limit: 5 });
  assert.equal(j.aggregate.totals.rows, 1);
  assert.equal(j.aggregate.totals.agreementRate, 1);
});

// --- I/J/K -----------------------------------------------------------------

test('I: multiple providers get independent buckets', () => {
  const j = runJson([], seed(tmpFile('multi.db')));
  assert.deepEqual(Object.keys(j.aggregate.byProvider), ['gemini', 'mistral'], 'sorted');
  assert.equal(j.aggregate.byProvider.mistral.agreementRate, 1);
  assert.equal(j.aggregate.byProvider.gemini.agreementRate, 0);
});

test('J: an incomparable row is not a disagreement and does not move the rate', () => {
  const j = runJson([], seed(tmpFile('incomp.db')));
  assert.equal(j.aggregate.byProvider.gemini.rows, 2);
  assert.equal(j.aggregate.byProvider.gemini.comparable, 1);
  assert.equal(j.aggregate.byProvider.gemini.incomparable, 1, 'the timeout');
  assert.equal(j.aggregate.byProvider.gemini.disagreements, 1, 'only the real disagreement');
});

test('K: costs are formatted for display only; unknown never reads as free', () => {
  const file = seed(tmpFile('cost.db'));
  const out = run([], file);
  assert.match(out, /known \(rows\):\s+3/);
  assert.match(out, /unknown \(rows\):\s+1/);
  assert.match(out, /not counted as free/);
  assert.match(out, /total:\s+\$0\.0023/, 'USD formatting in the human view');
  // The underlying number keeps full precision.
  assert.equal(runJson([], file).aggregate.costs.total, 0.00105 + 0.00031 + 0.00098);
});

// --- M: determinism --------------------------------------------------------

test('M: repeated execution produces byte-identical output', () => {
  const file = seed(tmpFile('det.db'));
  const j1 = run(['--json'], file);
  assert.equal(run(['--json'], file), j1);
  assert.equal(run(['--json'], file), j1);
  const h1 = run([], file);
  assert.equal(run([], file), h1);
  assert.doesNotMatch(j1, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no wall-clock timestamp may leak in');
});

// --- N/O/P: static isolation ----------------------------------------------

test('N + O + P: the CLI writes nothing, imports no engine, calls no provider', () => {
  const raw = fs.readFileSync(CLI, 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE', 'ALTER TABLE']) {
    assert.ok(!new RegExp(kw, 'i').test(code), `must not contain ${kw}`);
  }
  assert.doesNotMatch(code, /\.run\s*\(/, 'no better-sqlite3 write path');
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /engine\//, 'no trading-engine import');
  for (const secret of ['ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY',
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'BINANCE', 'apiKey']) {
    assert.ok(!code.includes(secret), `must not touch ${secret}`);
  }
  // Only these modules may be imported.
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../ai/shadowAnalysis.js', '../config.js', 'better-sqlite3', 'node:fs', 'node:url']);
});

// --- argument handling -----------------------------------------------------

test('argument parsing: defaults, validation, and usage errors', () => {
  assert.deepEqual(parseArgs([]), { pair: null, provider: null, regime: null, limit: null, dbPath: null, json: false, help: false, status: false });
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--status']).status, true);
  assert.equal(parseArgs([]).status, false, '--status is opt-in');
  assert.equal(parseArgs(['--json', '--summary']).json, false, 'last mode wins');
  assert.equal(parseArgs(['--limit', '5']).limit, 5);
  assert.throws(() => parseArgs(['--limit', 'abc']), /non-negative integer/);
  assert.throws(() => parseArgs(['--limit', '-1']), /non-negative integer/);
  assert.throws(() => parseArgs(['--pair']), /requires a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('usage errors exit non-zero without touching a database', () => {
  const lines = [];
  const code = main(['--bogus'], { log: () => {}, error: (m) => lines.push(m) });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /unknown argument/);
  assert.equal(main(['--db', '/nonexistent/nope.db'], { log: () => {}, error: () => {} }), 2);
});

test('renderSummary and analyze are usable directly on an open handle', () => {
  const db = openReadOnly(seed(tmpFile('direct.db')));
  const result = analyze(db, { pair: 'ETHUSDT' });
  assert.equal(result.aggregate.totals.rows, 2);
  assert.match(renderSummary(result), /Shadow Analysis/);
  db.close();
});
