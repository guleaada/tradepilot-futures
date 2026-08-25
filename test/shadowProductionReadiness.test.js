// Step 5: production-readiness gaps not already covered elsewhere.
//
// The freshness-gate paths (fresh/cached/parse-failure/timeout/error/hang) are
// already proven in shadowCadence.test.js and shadowMode.test.js and are not
// duplicated here. What was NOT covered, and is covered now:
//   1. the real migration path against a pre-migration database, and its idempotence
//   2. the manual-only workflow wiring for the Mistral shadow
//   3. the --status diagnostic, including that it leaks no secret
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { datasetStatus } from '../src/ai/shadowAnalysis.js';
import { renderStatus } from '../src/report/shadow.js';

const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ready-')), n);

// --- 1. migration -----------------------------------------------------------

// The exact shape production was in before the AI-layer release: regime_calls
// without provider/model/snapshot_id, and no ai_shadow_calls table.
function seedPreMigration(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE regime_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, pair TEXT NOT NULL,
      regime TEXT NOT NULL, confidence REAL NOT NULL, trade_allowed INTEGER NOT NULL, reasoning TEXT,
      raw_json TEXT, summary_json TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      est_cost REAL DEFAULT 0, source TEXT DEFAULT 'claude');
    CREATE TABLE portfolio (id INTEGER PRIMARY KEY CHECK (id = 1), cash REAL NOT NULL);`);
  db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,raw_json,
    summary_json,input_tokens,output_tokens,est_cost,source)
    VALUES ('2026-07-01T00:00:00Z','BTCUSDT','bullish',72,1,'r','{}','{}',1000,200,0.009,'claude')`).run();
  db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,raw_json,
    summary_json,input_tokens,output_tokens,est_cost,source)
    VALUES ('2026-07-02T00:00:00Z','ETHUSDT','chop',40,0,'r','{}','{}',900,180,0.008,'claude_error')`).run();
  db.prepare('INSERT INTO portfolio (id, cash) VALUES (1, 4879.56853206285)').run();
  db.close();
  return file;
}

const snapshotOf = (file) => {
  const db = new Database(file, { readonly: true });
  const s = JSON.stringify({
    schema: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    regime: db.prepare('SELECT * FROM regime_calls ORDER BY id').all(),
    portfolio: db.prepare('SELECT * FROM portfolio').all(),
  });
  db.close();
  return s;
};

test('migration preserves every existing row and value', () => {
  const file = seedPreMigration(tmp('mig.db'));
  const ro = new Database(file, { readonly: true });
  const before = ro.prepare('SELECT id,ts,pair,regime,confidence,trade_allowed,est_cost,source FROM regime_calls ORDER BY id').all();
  const cashBefore = ro.prepare('SELECT cash FROM portfolio WHERE id = 1').get();
  ro.close();

  openDb(file).close();

  const after = new Database(file, { readonly: true });
  assert.deepEqual(
    after.prepare('SELECT id,ts,pair,regime,confidence,trade_allowed,est_cost,source FROM regime_calls ORDER BY id').all(),
    before, 'pre-existing columns are untouched, row for row');
  assert.deepEqual(after.prepare('SELECT cash FROM portfolio WHERE id = 1').get(), cashBefore, 'no trading data altered');
  assert.equal(after.prepare('SELECT COUNT(*) c FROM regime_calls').get().c, 2, 'nothing deleted');
  after.close();
});

test('migration adds the shadow schema without rewriting history', () => {
  const file = seedPreMigration(tmp('mig2.db'));
  openDb(file).close();
  const db = new Database(file, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(regime_calls)').all().map((c) => c.name);
  for (const c of ['provider', 'model', 'snapshot_id', 'pricing_status']) assert.ok(cols.includes(c), `missing ${c}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('ai_shadow_calls'));
  const scols = db.prepare('PRAGMA table_info(ai_shadow_calls)').all().map((c) => c.name);
  for (const c of ['est_cost', 'pricing_status', 'snapshot_id']) assert.ok(scols.includes(c), `shadow missing ${c}`);

  // snapshot_id and pricing_status are NEVER backfilled: a fabricated id would
  // join unrelated rows, and old costs used one global rate.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM regime_calls WHERE snapshot_id IS NULL').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM regime_calls WHERE pricing_status IS NULL').get().c, 2);
  // provider IS backfilled, but only where `source` identifies it unambiguously.
  assert.deepEqual(db.prepare('SELECT provider, COUNT(*) n FROM regime_calls GROUP BY provider').all(),
    [{ provider: 'anthropic', n: 2 }]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM regime_calls WHERE model IS NULL').get().c, 2, 'model is unknowable, stays NULL');
  db.close();
});

test('migration is idempotent — reopening changes nothing', () => {
  const file = seedPreMigration(tmp('mig3.db'));
  openDb(file).close();
  const first = snapshotOf(file);
  openDb(file).close();
  const second = snapshotOf(file);
  openDb(file).close();
  assert.equal(second, first, '2nd open is a no-op');
  assert.equal(snapshotOf(file), first, '3rd open is a no-op');
});

// --- 2. workflow wiring -----------------------------------------------------

const WORKFLOW = fs.readFileSync(new URL('../.github/workflows/tradepilot-futures.yml', import.meta.url), 'utf8');
// Comments stripped: an explanatory comment naming a secret is documentation,
// not a capability, and must not fail an "is it reachable" assertion.
const WORKFLOW_CODE = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// GitHub expression semantics for `cond && value || ''`:
// `a && b` yields a when a is falsy, else b; `a || b` yields a when truthy,
// else b. An empty string is falsy. So the whole expression is value | ''.
function evaluateGithubTernary(expression, inputValue) {
  const m = expression.match(/^\$\{\{\s*github\.event\.inputs\.shadow_provider\s*==\s*'([^']+)'\s*&&\s*(.+?)\s*\|\|\s*''\s*\}\}$/);
  assert.ok(m, `expression not in the expected guarded form: ${expression}`);
  const [, compareTo, whenTrue] = m;
  if (inputValue !== compareTo) return '';
  const literal = whenTrue.match(/^'(.*)'$/);
  return literal ? literal[1] : `<${whenTrue}>`; // a secrets.* reference
}

const envValue = (name) => {
  const m = WORKFLOW.match(new RegExp(`^\\s*${name}:\\s*"?(.+?)"?\\s*$`, 'm'));
  assert.ok(m, `${name} not found in the workflow`);
  return m[1];
};

test('workflow: AI_PROVIDER is gemini unconditionally', () => {
  // REQUIREMENT 1 + 2: scheduled runs use Gemini, and Gemini is authoritative.
  // A literal, not an expression, so no workflow input can vary it.
  assert.equal(envValue('AI_PROVIDER'), 'gemini');
  assert.doesNotMatch(envValue('AI_PROVIDER'), /\$\{\{/, 'must be a literal, not an expression');
});

test('workflow: shadow_provider=none yields empty shadow wiring', () => {
  for (const name of ['AI_SHADOW_MODE', 'AI_SHADOW_PROVIDERS', 'MISTRAL_API_KEY']) {
    assert.equal(evaluateGithubTernary(envValue(name), 'none'), '', `${name} must be empty`);
  }
});

test('workflow: shadow_provider=mistral enables shadow and supplies the secret', () => {
  assert.equal(evaluateGithubTernary(envValue('AI_SHADOW_MODE'), 'mistral'), 'true');
  assert.equal(evaluateGithubTernary(envValue('AI_SHADOW_PROVIDERS'), 'mistral'), 'mistral');
  assert.match(envValue('MISTRAL_API_KEY'), /secrets\.MISTRAL_API_KEY/, 'a secret REFERENCE, never a literal');
  assert.equal(envValue('AI_PROVIDER'), 'gemini', 'primary is unchanged even with shadow on');
});

test('workflow: a SCHEDULED run can never enable the Mistral shadow', () => {
  // On a schedule event github.event.inputs is absent, so the comparison is
  // false for any value that is not the literal 'mistral'.
  for (const scheduled of [null, undefined, '', 'none']) {
    for (const name of ['AI_SHADOW_MODE', 'AI_SHADOW_PROVIDERS', 'MISTRAL_API_KEY']) {
      assert.equal(evaluateGithubTernary(envValue(name), scheduled), '', `${name} with input=${String(scheduled)}`);
    }
  }
  assert.match(WORKFLOW, /schedule:\s*\n\s*- cron: '\*\/15 \* \* \* \*'/, 'cadence unchanged');
});

test('workflow: the manual input defaults to none and offers only none|mistral', () => {
  assert.match(WORKFLOW, /shadow_provider:/);
  assert.match(WORKFLOW, /default:\s*none/);
  const options = WORKFLOW.slice(WORKFLOW.indexOf('options:')).split('\n').slice(1, 3).map((l) => l.trim());
  assert.deepEqual(options, ['- none', '- mistral']);
  // GEMINI_API_KEY is now the PRIMARY provider's key and is legitimately
  // present. No OTHER provider secret may be exposed, and Anthropic's must be
  // gone entirely (requirement 10).
  for (const name of ['OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!WORKFLOW_CODE.includes(name), `${name} must not appear in workflow code`);
  }
  assert.match(WORKFLOW, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/,
    'the primary key is supplied as a secret reference');
});

// --- 3. --status diagnostic -------------------------------------------------

test('datasetStatus reports counts and real timestamps, on a migrated DB', () => {
  const file = tmp('status.db');
  const db = openDb(file);
  db.prepare(`INSERT INTO regime_calls (ts,pair,regime,confidence,trade_allowed,reasoning,raw_json,
    summary_json,input_tokens,output_tokens,est_cost,source,provider,model,snapshot_id,pricing_status)
    VALUES ('2026-08-01T00:00:00Z','BTCUSDT','bullish',64,1,'r','{}','{}',0,0,0,'claude','anthropic','claude-sonnet-4-6',?,'exact')`).run('a'.repeat(64));
  db.prepare(`INSERT INTO ai_shadow_calls (created_at,snapshot_id,pair,provider,model,status,regime,
    confidence,trade_allowed,input_tokens,output_tokens,est_cost,pricing_status)
    VALUES ('2026-08-01T00:00:05Z',?,'BTCUSDT','mistral','mistral-large-2512','success','bullish',70,1,0,0,0.001,'exact')`).run('a'.repeat(64));
  const s = datasetStatus(db);
  db.close();
  assert.equal(s.schemaReady, true);
  assert.equal(s.shadowRows, 1);
  assert.equal(s.comparableRows, 1);
  assert.equal(s.primariesWithSnapshotId, 1);
  assert.equal(s.latestPrimaryAt, '2026-08-01T00:00:00Z');
  assert.equal(s.latestShadowAt, '2026-08-01T00:00:05Z');
});

test('datasetStatus on a pre-migration DB reports not-ready without crashing', () => {
  const file = seedPreMigration(tmp('status-old.db'));
  const db = new Database(file, { readonly: true });
  const s = datasetStatus(db);
  db.close();
  assert.equal(s.schemaReady, false);
  assert.equal(s.shadowRows, 0);
  assert.equal(s.latestShadowAt, null);
  assert.equal(s.latestPrimaryAt, '2026-07-02T00:00:00Z', 'regime_calls predates the shadow schema');
  assert.throws(() => datasetStatus(null), TypeError);
});

test('status output exposes names and counts only — never a secret', () => {
  const rendered = renderStatus(
    { schemaReady: true, shadowRows: 3, comparableRows: 2, primariesWithSnapshotId: 3, latestPrimaryAt: '2026-08-01T00:00:00Z', latestShadowAt: '2026-08-01T00:00:05Z' },
    { primaryProvider: 'anthropic', shadowModeEnabled: true, shadowProviders: ['mistral'] },
  );
  assert.match(rendered, /primary provider:\s+anthropic/);
  assert.match(rendered, /shadow mode enabled:\s+yes/);
  assert.match(rendered, /configured shadow providers: mistral/);
  for (const forbidden of ['sk-', 'api_key', 'apiKey', 'API_KEY', 'secret', 'token', 'Bearer']) {
    assert.ok(!rendered.includes(forbidden), `status must not contain "${forbidden}"`);
  }
  // The renderer receives only names/booleans; it has no access to a key.
  const src = fs.readFileSync(new URL('../src/report/shadow.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function renderStatus'), src.indexOf('export const USAGE'));
  assert.ok(!/apiKey|API_KEY|secret/i.test(body), 'renderStatus references no credential field');
});

// =========================================================================
// Provider-selection contract: Gemini primary (requirements 1-10)
// =========================================================================

test('R3 + R4: Mistral is shadow-only and Groq is not a provider at all', async () => {
  const { listPrimaryProviders, tryGetPrimaryProvider } = await import('../src/ai/providers/index.js');
  // Mistral IS registered (it can be a shadow) but the workflow never selects it
  // as primary. Groq is not in the registry at all - it is an optional
  // pre-filter (groqSaysChanged), structurally incapable of being primary.
  assert.deepEqual(listPrimaryProviders().sort(), ['anthropic', 'gemini', 'mistral', 'openrouter']);
  assert.ok(tryGetPrimaryProvider('mistral'), 'mistral is a registered provider');
  assert.ok(!tryGetPrimaryProvider('groq'), 'groq is NOT a primary provider');
  assert.ok(!tryGetPrimaryProvider('GROQ'));
  assert.ok(!tryGetPrimaryProvider('grok'));
  // Groq appears in the workflow only as an optional pre-filter key.
  assert.match(WORKFLOW, /GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \}\}/);
  assert.doesNotMatch(WORKFLOW, /AI_PROVIDER:\s*(groq|mistral)/i);
});

test('R5: no workflow input can make Mistral or Groq primary', () => {
  // AI_PROVIDER is a literal. The only input is shadow_provider, and it feeds
  // ONLY the three shadow variables - never AI_PROVIDER.
  assert.equal(envValue('AI_PROVIDER'), 'gemini');
  const inputDriven = [...WORKFLOW.matchAll(/^\s*([A-Z_]+):\s*"\$\{\{[^}]*shadow_provider[^}]*\}\}"/gm)]
    .map((m) => m[1]).sort();
  assert.deepEqual(inputDriven, ['AI_SHADOW_MODE', 'AI_SHADOW_PROVIDERS', 'MISTRAL_API_KEY'],
    'only the shadow wiring may depend on the input');
  assert.ok(!inputDriven.includes('AI_PROVIDER'), 'AI_PROVIDER must never be input-driven');
  // Every option the UI offers, checked against the primary.
  for (const input of [null, 'none', 'mistral']) {
    assert.equal(envValue('AI_PROVIDER'), 'gemini', `primary must stay gemini for input=${input}`);
  }
});

test('R9 + R10: Anthropic is neither required nor reachable in production', () => {
  // Requirement 9: not required - no Anthropic env mapping and no secret
  // reference survive anywhere in the executable part of the workflow.
  assert.ok(!WORKFLOW_CODE.includes('ANTHROPIC'), 'no Anthropic reference in workflow code');
  // Requirement 10: not reachable - the secret is never handed to the job, so
  // the provider's pre-flight refuses before any HTTP request is built.
  assert.doesNotMatch(WORKFLOW, /secrets\.ANTHROPIC_API_KEY/, 'the secret is never referenced, even in a comment');
  assert.doesNotMatch(WORKFLOW_CODE, /^\s*ANTHROPIC_API_KEY:/m, 'no env mapping');
});

test('R10: without ANTHROPIC_API_KEY the Anthropic provider cannot issue a request', async () => {
  const { config } = await import('../src/config.js');
  const { anthropicProvider } = await import('../src/ai/providers/index.js');
  const saved = config.anthropicApiKey;
  config.anthropicApiKey = '';           // exactly the production job environment
  try {
    assert.equal(anthropicProvider.isConfigured(), false,
      'pre-flight must fail, so no HTTP request is ever constructed');
  } finally {
    config.anthropicApiKey = saved;
  }
});
