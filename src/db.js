// SQLite setup and helpers. Every AI decision and every rule decision must be
// explainable from this database alone.
//
// FUTURES fork schema changes vs spot:
//   trades.direction        'long' | 'short' (replaces the vestigial `side`)
//   trades.funding_paid     cumulative funding cost charged to the trade (USD;
//                           negative = funding received)
//   trades.leverage         leverage set when the trade opened
//   trades.margin           isolated margin locked for the position (USD)
//   trades.last_funding_ts  last funding boundary already applied (guards
//                           against double-charging)
// The sentiment_calls table is gone: the Grok/X-sentiment layer is not part
// of this fork.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS regime_calls (
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
  -- source is the call OUTCOME/state (claude, claude_parse_fail,
  -- claude_error, claude_timeout, mock). provider and model are separate
  -- dimensions: who served the call, and exactly which model. Splitting them
  -- is what makes provider-vs-outcome attribution possible later.
  source        TEXT DEFAULT 'claude',
  provider      TEXT,
  model         TEXT,
  -- Join key to ai_shadow_calls.snapshot_id: identifies the exact market
  -- state this model was shown. Created ONCE per pair per cycle and passed to
  -- both paths. NULL on historical rows (see migrateRegimeCalls).
  snapshot_id   TEXT,
  -- 'exact' when the (provider, model) pair had a verified price, 'unknown'
  -- when it did not (est_cost is then NULL). NULL on historical rows.
  pricing_status TEXT,
  -- Cost reconciliation (currently OpenRouter only). est_cost above stays the
  -- ESTIMATE for the REQUESTED model and is never overwritten; actual_cost is
  -- the provider's own billed figure, kept strictly alongside it so estimate
  -- and actual can be compared rather than conflated.
  generation_id      TEXT,   -- provider-side id used to look the cost up
  actual_cost        REAL,   -- NULL until reconciled; NULL forever if it fails
  actual_cost_source TEXT,   -- e.g. 'openrouter_generation'
  reconcile_attempts INTEGER DEFAULT 0  -- bounded; never retried indefinitely
);

-- Shadow-mode model evaluation. DELIBERATELY SEPARATE from regime_calls:
-- the production regime-call schema stays untouched, and nothing in the
-- trading path reads this table. Rows here are evidence about models, never
-- inputs to a trade. status is its own vocabulary (success | parse_failure |
-- timeout | error) so regime_calls.source keeps its existing meaning.
CREATE TABLE IF NOT EXISTS ai_shadow_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL,
  snapshot_id    TEXT NOT NULL,
  pair           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT,
  reported_model TEXT,
  status         TEXT NOT NULL,
  regime         TEXT,
  confidence     REAL,
  trade_allowed  INTEGER,
  reasoning      TEXT,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  latency_ms     REAL,
  error          TEXT,
  raw_response   TEXT,
  est_cost       REAL,
  pricing_status TEXT,
  generation_id      TEXT,
  actual_cost        REAL,
  actual_cost_source TEXT,
  reconcile_attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair        TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'long',
  status      TEXT NOT NULL DEFAULT 'open',
  entry_time  TEXT NOT NULL,
  entry_price REAL NOT NULL,
  qty         REAL NOT NULL,
  stop_price  REAL NOT NULL,
  tp_price    REAL NOT NULL,
  entry_fee   REAL NOT NULL DEFAULT 0,
  exit_time   TEXT,
  exit_price  REAL,
  exit_fee    REAL,
  pnl         REAL,
  exit_reason TEXT,
  entry_order_id TEXT,
  exit_order_id  TEXT,
  initial_risk        REAL,
  trailing_stop_active INTEGER DEFAULT 0,
  partial_exit_done    INTEGER DEFAULT 0,
  remainder_qty        REAL,
  partial_pnl          REAL DEFAULT 0,
  regime_at_entry      TEXT,
  confidence_at_entry  REAL,
  entry_qty            REAL,
  leverage             REAL,
  margin               REAL,
  funding_paid         REAL DEFAULT 0,
  last_funding_ts      TEXT,
  trend_class          TEXT,
  tp_mult              REAL,
  hwm                  REAL
);

CREATE TABLE IF NOT EXISTS regime_accuracy (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,
  pair                TEXT NOT NULL,
  regime_at_entry     TEXT NOT NULL,
  confidence_at_entry REAL,
  actual_return_pct   REAL,
  duration_minutes    REAL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  pair          TEXT NOT NULL,
  side          TEXT NOT NULL,
  direction     TEXT,
  type          TEXT NOT NULL DEFAULT 'MARKET',
  requested_qty REAL,
  executed_qty  REAL,
  signal_price  REAL,
  fill_price    REAL,
  status        TEXT,
  order_id      TEXT,
  raw_json      TEXT
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  equity REAL NOT NULL,
  cash   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_budget (
  date     TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  spend    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, provider)
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  type   TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS portfolio (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  cash REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_equity (
  date        TEXT PRIMARY KEY,
  open_equity REAL NOT NULL
);
`;

export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateTrades(db);
  migrateRegimeCalls(db);
  migrateShadowCalls(db);
  db.prepare('INSERT OR IGNORE INTO portfolio (id, cash) VALUES (1, ?)').run(config.startBalance);
  return db;
}

// Additive migrations for DBs created before newer columns existed (e.g. a DB
// seeded from an earlier fork checkout). Columns are only ever ADDED.
function migrateTrades(db) {
  const cols = db.prepare('PRAGMA table_info(trades)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE trades ADD COLUMN ${ddl}`);
  };
  add('direction', "direction TEXT NOT NULL DEFAULT 'long'");
  add('leverage', 'leverage REAL');
  add('margin', 'margin REAL');
  add('funding_paid', 'funding_paid REAL DEFAULT 0');
  add('last_funding_ts', 'last_funding_ts TEXT');
  add('entry_qty', 'entry_qty REAL');
  add('trend_class', 'trend_class TEXT'); // dynamic-TP trend class at entry
  add('tp_mult', 'tp_mult REAL'); // ATR multiple used for this trade's TP
  add('hwm', 'hwm REAL'); // high-water mark price for the chandelier trailing stop
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (orderCols.length && !orderCols.includes('direction')) {
    db.exec('ALTER TABLE orders ADD COLUMN direction TEXT');
  }
}

// Additive provider/model attribution for regime_calls. Same convention as
// migrateTrades: ALTER TABLE ADD COLUMN guarded by PRAGMA table_info, never a
// table rebuild, never a dropped or rewritten column.
//
// Backfill policy (deliberately conservative):
//   provider — inferable with certainty for historical rows, because Anthropic
//              was the ONLY primary provider that ever ran: every 'claude*'
//              source came from it. Backfilled once, when the column is added.
//   model    — NEVER backfilled. Nothing in the historical record identifies
//              the exact model: raw_json holds the model's response TEXT and
//              summary_json holds the market summary; neither carries a model
//              id, and AI_MODEL could have been overridden per run. Guessing
//              from today's config default would fabricate experimental data,
//              so historical model stays NULL. Verified against the live DB:
//              0 of 191 rows contain any model identifier.
// Additive pricing columns for shadow rows created before pricing existed.
// Historical shadow rows keep est_cost = NULL and pricing_status = NULL: they
// were never costed, and inventing a figure now would be a guess.
function migrateShadowCalls(db) {
  const cols = db.prepare('PRAGMA table_info(ai_shadow_calls)').all().map((c) => c.name);
  if (cols.length === 0) return; // table not created yet (SCHEMA handles fresh DBs)
  if (!cols.includes('est_cost')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN est_cost REAL');
  if (!cols.includes('pricing_status')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN pricing_status TEXT');
  if (!cols.includes('generation_id')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN generation_id TEXT');
  if (!cols.includes('actual_cost')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN actual_cost REAL');
  if (!cols.includes('actual_cost_source')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN actual_cost_source TEXT');
  if (!cols.includes('reconcile_attempts')) db.exec('ALTER TABLE ai_shadow_calls ADD COLUMN reconcile_attempts INTEGER DEFAULT 0');
}

function migrateRegimeCalls(db) {
  const cols = db.prepare('PRAGMA table_info(regime_calls)').all().map((c) => c.name);
  if (cols.length === 0) return; // table not created yet (SCHEMA handles fresh DBs)
  const addedProvider = !cols.includes('provider');
  if (addedProvider) db.exec('ALTER TABLE regime_calls ADD COLUMN provider TEXT');
  if (!cols.includes('model')) db.exec('ALTER TABLE regime_calls ADD COLUMN model TEXT');
  // Correlation key with ai_shadow_calls. NEVER backfilled: the original
  // market summary for a historical call was not retained in a form we can
  // re-hash with certainty, and a fabricated id would silently join unrelated
  // rows — worse than a NULL. Historical rows stay NULL by design.
  if (!cols.includes('snapshot_id')) db.exec('ALTER TABLE regime_calls ADD COLUMN snapshot_id TEXT');
  // Pricing provenance. NEVER backfilled: historical rows were costed with a
  // single global Anthropic rate applied to every provider, so their est_cost
  // may be wrong and we cannot reconstruct the correct model/price context.
  // Leaving pricing_status NULL marks them honestly as "provenance unknown"
  // rather than relabelling bad numbers as trustworthy.
  if (!cols.includes('pricing_status')) db.exec('ALTER TABLE regime_calls ADD COLUMN pricing_status TEXT');
  // Reconciliation columns. NEVER backfilled: a historical row has no
  // generation id, so its actual cost is unknowable — and marking old
  // estimates as "verified actual" would be the exact relabelling this design
  // exists to prevent.
  if (!cols.includes('generation_id')) db.exec('ALTER TABLE regime_calls ADD COLUMN generation_id TEXT');
  if (!cols.includes('actual_cost')) db.exec('ALTER TABLE regime_calls ADD COLUMN actual_cost REAL');
  if (!cols.includes('actual_cost_source')) db.exec('ALTER TABLE regime_calls ADD COLUMN actual_cost_source TEXT');
  if (!cols.includes('reconcile_attempts')) db.exec('ALTER TABLE regime_calls ADD COLUMN reconcile_attempts INTEGER DEFAULT 0');

  // One-time backfill, only on the run that introduces the column, and only
  // where `source` identifies the provider unambiguously. Rows whose source is
  // unrecognized keep provider NULL rather than being assigned a guess.
  if (addedProvider) {
    db.prepare("UPDATE regime_calls SET provider = 'anthropic' WHERE provider IS NULL AND source LIKE 'claude%'").run();
    db.prepare("UPDATE regime_calls SET provider = 'mock' WHERE provider IS NULL AND source = 'mock'").run();
  }
}

let _db = null;

export function getDb() {
  if (!_db) _db = openDb();
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// `ts` is overridable so tests can stamp events with fixed time.
export function logEvent(type, detail, db = getDb(), ts = nowIso()) {
  db.prepare('INSERT INTO events (ts, type, detail) VALUES (?, ?, ?)').run(
    ts,
    type,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
