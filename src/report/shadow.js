// Read-only CLI for the shadow-evaluation dataset.
//
//   npm run shadow-analysis -- [--pair BTCUSDT] [--provider mistral]
//                              [--regime bullish] [--limit N]
//                              [--json | --summary] [--db PATH]
//
// SAFETY CONTRACT:
//   * The database is opened with better-sqlite3's `readonly: true`, which is
//     enforced by SQLite itself — any write attempt fails with SQLITE_READONLY.
//     openDb() from ../db.js is deliberately NOT used here: it applies the
//     schema and three migrations on open, so pointing it at the production
//     database would modify it just by looking.
//   * All querying is delegated to ../ai/shadowAnalysis.js. No SQL is
//     duplicated here.
//   * No provider is contacted and no credential is read. This command cannot
//     spend money or influence a trade.
//
// REPORTING STANCE: the primary is NOT ground truth, so this command reports
// OBSERVED AGREEMENT between models and never accuracy, correctness, or a
// ranking of providers. Two models agreeing means they are similar, not right.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { aggregateComparisons, datasetStatus, loadComparisons } from '../ai/shadowAnalysis.js';

export const PRE_MIGRATION_MESSAGE = 'Shadow analysis unavailable: database schema is pre-migration.';

const FLAGS_WITH_VALUES = new Set(['--pair', '--provider', '--regime', '--limit', '--db']);

export function parseArgs(argv = []) {
  const out = { pair: null, provider: null, regime: null, limit: null, dbPath: null, json: false, help: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--status') { out.status = true; continue; }
    // --summary is the default; accepted so the intent can be written out.
    if (arg === '--summary') { out.json = false; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!FLAGS_WITH_VALUES.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === '--pair') out.pair = value;
    else if (arg === '--provider') out.provider = value;
    else if (arg === '--regime') out.regime = value;
    else if (arg === '--db') out.dbPath = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error('--limit requires a non-negative integer');
      out.limit = n;
    }
  }
  return out;
}

// Read-only handle. Enforced by SQLite, not by convention.
export function openReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Load, filter and aggregate. READ-ONLY.
 *
 * Filter placement is deliberate:
 *   * `pair` and `provider` are pushed down to the loader (they exist there).
 *   * `regime` has no loader filter, so it is applied here against
 *     record.primary.regime — the label the trading system acted on, matching
 *     how aggregateComparisons keys byRegime.
 *   * `limit` is applied LAST, after every filter, so it always means "the
 *     first N of the filtered set" rather than "N rows, then filtered".
 *
 * Ordering is the loader's: pair, snapshot_id, provider, model, id. It is
 * derived entirely from the DATA, so it is stable across runs. NOTE it is NOT
 * chronological — records carry no timestamp, so --limit cannot mean "latest
 * N" and does not claim to.
 */
export function analyze(db, { pair = null, provider = null, regime = null, limit = null } = {}) {
  const { records, meta } = loadComparisons(db, { pair, provider });

  const wanted = regime === null ? null : String(regime).trim().toLowerCase();
  let selected = wanted === null
    ? records
    : records.filter((r) => (r.primary.regime ?? 'unknown') === wanted);

  const matchedBeforeLimit = selected.length;
  if (limit !== null) selected = selected.slice(0, limit);

  return {
    filters: { pair, provider, regime, limit },
    meta: { ...meta, regimeFilterMatched: matchedBeforeLimit, recordsAnalyzed: selected.length },
    aggregate: aggregateComparisons(selected),
  };
}

// --- formatting (display only; never mutates a computed number) ------------

const rate = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
const usd = (v) => (v === null ? 'n/a' : `$${v.toFixed(4)}`);
const delta = (v) => (v === null ? 'n/a' : (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)));
const pad = (s, n) => String(s).padEnd(n);

function table(title, rows, columns) {
  const lines = [`${title}:`];
  if (Object.keys(rows).length === 0) {
    lines.push('  (none)');
    return lines;
  }
  const widths = columns.map((c) => Math.max(c.header.length, ...Object.entries(rows).map(([k, v]) => String(c.value(k, v)).length)));
  lines.push(`  ${columns.map((c, i) => pad(c.header, widths[i])).join('  ')}`);
  for (const [key, value] of Object.entries(rows)) {
    lines.push(`  ${columns.map((c, i) => pad(c.value(key, value), widths[i])).join('  ')}`);
  }
  return lines;
}

export function renderSummary(result) {
  const { filters, meta, aggregate } = result;
  const t = aggregate.totals;
  const out = ['Shadow Analysis', ''];

  const active = Object.entries(filters).filter(([, v]) => v !== null);
  out.push(active.length ? `Filters: ${active.map(([k, v]) => `${k}=${v}`).join(' ')}` : 'Filters: none');
  out.push('');
  out.push(`Rows:            ${t.rows}`);
  out.push(`Comparable:      ${t.comparable}`);
  out.push(`Incomparable:    ${t.incomparable}`);
  out.push(`Agreement rate:  ${rate(t.agreementRate)}${t.comparable === 0 ? '  (no comparable rows — nothing to compare)' : ''}`);
  out.push('');

  out.push(...table('By provider', aggregate.byProvider, [
    { header: 'provider', value: (k) => k },
    { header: 'rows', value: (k, v) => v.rows },
    { header: 'comparable', value: (k, v) => v.comparable },
    { header: 'agreements', value: (k, v) => v.agreements },
    { header: 'disagreements', value: (k, v) => v.disagreements },
    { header: 'observed agreement', value: (k, v) => rate(v.agreementRate) },
    { header: 'avg delta', value: (k, v) => delta(v.avgConfidenceDelta) },
    { header: 'shadow cost', value: (k, v) => usd(v.shadowCost) },
  ]));
  out.push('');

  out.push(...table('By primary regime', aggregate.byRegime, [
    { header: 'regime', value: (k) => k },
    { header: 'rows', value: (k, v) => v.rows },
    { header: 'comparable', value: (k, v) => v.comparable },
    { header: 'agreements', value: (k, v) => v.agreements },
    { header: 'disagreements', value: (k, v) => v.disagreements },
    { header: 'observed agreement', value: (k, v) => rate(v.agreementRate) },
  ]));
  out.push('');

  out.push(...table('By pair', aggregate.byPair, [
    { header: 'pair', value: (k) => k },
    { header: 'rows', value: (k, v) => v.rows },
    { header: 'comparable', value: (k, v) => v.comparable },
    { header: 'agreements', value: (k, v) => v.agreements },
    { header: 'disagreements', value: (k, v) => v.disagreements },
    { header: 'observed agreement', value: (k, v) => rate(v.agreementRate) },
  ]));
  out.push('');

  out.push('Costs:');
  out.push(`  known (rows):   ${aggregate.costs.known}`);
  out.push(`  unknown (rows): ${aggregate.costs.unknown}${aggregate.costs.unknown > 0 ? '  (unpriced model — not counted as free)' : ''}`);
  out.push(`  total:          ${usd(aggregate.costs.total)}`);
  out.push('');

  out.push('Data coverage:');
  out.push(`  shadow rows scanned:             ${meta.shadowRows}`);
  out.push(`  duplicate shadow rows dropped:   ${meta.duplicateShadowRowsDropped}`);
  out.push(`  shadow rows without a primary:   ${meta.shadowRowsWithoutPrimary}`);
  out.push(`  primaries without a snapshot id: ${meta.primaryRowsWithoutSnapshotId}`);
  out.push('');
  out.push('Observed agreement measures how often a shadow model reached the same');
  out.push('conclusion as the primary. The primary is not ground truth, so this is');
  out.push('not accuracy and does not rank providers.');

  return out.join('\n');
}

// Operational status. Reports NAMES and COUNTS only — never a key, a secret,
// an environment value, or a raw provider response.
export function renderStatus(status, runtime) {
  const yn = (b) => (b ? 'yes' : 'no');
  const or = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : v);
  return [
    'Shadow Analysis - status',
    '',
    'Database:',
    `  schema ready:               ${yn(status.schemaReady)}${status.schemaReady ? '' : '   (pre-migration)'}`,
    `  shadow rows:                ${status.shadowRows}`,
    `  comparable rows:            ${status.comparableRows}`,
    `  primaries with snapshot id: ${status.primariesWithSnapshotId}`,
    `  latest primary evaluation:  ${or(status.latestPrimaryAt, 'none recorded')}`,
    `  latest shadow evaluation:   ${or(status.latestShadowAt, 'none recorded')}`,
    '',
    'Configuration (names only):',
    `  primary provider:           ${or(runtime.primaryProvider, 'unset')}`,
    `  shadow mode enabled:        ${yn(runtime.shadowModeEnabled)}`,
    `  configured shadow providers:${runtime.shadowProviders.length ? ' ' + runtime.shadowProviders.join(', ') : ' (none)'}`,
  ].join('\n');
}

export const USAGE = `Usage: npm run shadow-analysis -- [options]

  --pair <SYMBOL>      only this pair
  --provider <NAME>    only this shadow provider
  --regime <NAME>      only rows whose PRIMARY regime matches
  --limit <N>          first N records of the filtered set (data order, not time)
  --json               machine-readable output
  --status             read-only operational status, then exit
  --summary            human-readable output (default)
  --db <PATH>          database to read (default: the configured database)
  --help               this message`;

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(err.message);
    error(USAGE);
    return 2;
  }
  if (args.help) { log(USAGE); return 0; }

  const dbPath = args.dbPath ?? config.dbPath;
  let db;
  try {
    db = openReadOnly(dbPath);
  } catch (err) {
    error(err.message);
    return 2;
  }

  try {
    if (args.status) {
      const status = datasetStatus(db);
      const runtime = {
        primaryProvider: config.aiProvider,
        shadowModeEnabled: config.aiShadowMode,
        shadowProviders: [...(config.aiShadowProviders ?? [])],
      };
      if (args.json) log(JSON.stringify({ status, runtime }, null, 2));
      else log(renderStatus(status, runtime));
      return 0;
    }
    const result = analyze(db, args);

    if (!result.meta.schemaReady) {
      // Never render an empty dataset as though the models agreed.
      if (args.json) log(JSON.stringify({ error: PRE_MIGRATION_MESSAGE, filters: result.filters, meta: result.meta }, null, 2));
      else log(PRE_MIGRATION_MESSAGE);
      return 0;
    }
    if (args.json) {
      log(JSON.stringify({ filters: result.filters, meta: result.meta, aggregate: result.aggregate }, null, 2));
      return 0;
    }
    if (result.aggregate.totals.rows === 0) {
      log('Shadow Analysis\n\nNo shadow evaluation records found for the selected filters.');
      return 0;
    }
    log(renderSummary(result));
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
