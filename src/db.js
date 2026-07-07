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
  source        TEXT DEFAULT 'claude'
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
