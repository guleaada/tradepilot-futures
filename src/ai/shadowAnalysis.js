// Shadow-mode evaluation analysis: turns persisted primary + shadow records
// into one canonical comparison shape.
//
// SAFETY CONTRACT — this module is EVIDENCE, never input:
//   * It is READ-ONLY. It issues SELECTs and nothing else: no INSERT, UPDATE,
//     DELETE or DDL appears anywhere below.
//   * It imports NOTHING. Not ../engine/, not a provider, not an API client,
//     not a secret, not ../config.js, not Telegram, not order/execution code —
//     and deliberately not ../db.js either, because db.js imports config. The
//     caller passes an open handle in, so this file cannot reach configuration
//     or credentials even transitively.
//   * It is pure with respect to the database: running it twice on the same
//     rows produces byte-identical output, which is what makes historical
//     replay meaningful.
//
// Nothing here may influence a regime, an entry, an exit, sizing, or an order.
//
// Two facts about the underlying tables drive the design:
//
//   1. `ai_shadow_calls` has NO uniqueness constraint on
//      (snapshot_id, pair, provider, model) — duplicates can be inserted by a
//      retry, a re-run cycle, or a replay. Aggregating them naively would
//      double-count, so rows are deduplicated deterministically here.
//   2. `regime_calls.source` uses a legacy 'claude*' vocabulary that predates
//      multi-provider support: a Gemini or Mistral primary still records
//      source='claude'. The real provider lives in `regime_calls.provider`.
//      normalizeStatus() maps that legacy vocabulary onto the SAME status
//      words the shadow side uses, so both halves of a comparison can be
//      reasoned about with one set of terms.

// The shared status vocabulary. `ai_shadow_calls.status` already speaks it;
// primary rows are mapped onto it by normalizeStatus().
export const EVAL_STATUS = Object.freeze({
  SUCCESS: 'success',              // a provider answered and the output parsed
  PARSE_FAILURE: 'parse_failure',  // a provider answered, output unusable
  TIMEOUT: 'timeout',
  ERROR: 'error',
  MOCK: 'mock',                    // synthetic; never a real model opinion
  UNKNOWN: 'unknown',              // unrecognised source string
});

// Why a pair could not be compared. Exactly one is set when comparable=false,
// and it is always null when comparable=true.
export const INCOMPARABLE = Object.freeze({
  PRIMARY_NOT_SUCCESS: 'primary_not_success',
  SHADOW_NOT_SUCCESS: 'shadow_not_success',
  PRIMARY_MOCK: 'primary_mock',
  MISSING_REGIME: 'missing_regime',
});

// regime_calls.source -> the shared vocabulary above.
export function normalizeStatus(source) {
  switch (String(source ?? '').toLowerCase()) {
    case 'claude': return EVAL_STATUS.SUCCESS;
    case 'claude_parse_fail': return EVAL_STATUS.PARSE_FAILURE;
    case 'claude_timeout': return EVAL_STATUS.TIMEOUT;
    case 'claude_error': return EVAL_STATUS.ERROR;
    case 'mock': return EVAL_STATUS.MOCK;
    default: return EVAL_STATUS.UNKNOWN;
  }
}

// Regimes are compared case- and whitespace-insensitively; null stays null so
// "absent" can never masquerade as a match.
function normRegime(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return s === '' ? null : s;
}

// SQLite stores trade_allowed as INTEGER 0/1. Null stays null.
function normBool(v) {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

function normNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Normalize one persisted primary row + one persisted shadow row into THE
 * canonical comparison record. Pure: same rows in, same record out.
 *
 * Every comparison field is null unless the pair is genuinely comparable — a
 * disagreement and an unusable evaluation must never look alike.
 */
export function compareRecords(primaryRow, shadowRow) {
  const primary = {
    provider: primaryRow?.provider ?? null,
    model: primaryRow?.model ?? null,
    regime: normRegime(primaryRow?.regime),
    confidence: normNumber(primaryRow?.confidence),
    tradeAllowed: normBool(primaryRow?.trade_allowed),
    source: primaryRow?.source ?? null,
    status: normalizeStatus(primaryRow?.source),
  };

  const shadow = {
    provider: shadowRow?.provider ?? null,
    model: shadowRow?.model ?? null,
    regime: normRegime(shadowRow?.regime),
    confidence: normNumber(shadowRow?.confidence),
    tradeAllowed: normBool(shadowRow?.trade_allowed),
    status: shadowRow?.status ?? null,
    pricingStatus: shadowRow?.pricing_status ?? null,
    // NULL est_cost means "unknown price", never "free" — it is preserved as
    // null rather than coerced to 0.
    estCost: shadowRow?.est_cost === null || shadowRow?.est_cost === undefined
      ? null
      : normNumber(shadowRow.est_cost),
  };

  // Comparability is decided BEFORE any comparison is attempted, in a fixed
  // order so the reason is deterministic when several apply.
  let reason = null;
  if (primary.status === EVAL_STATUS.MOCK) reason = INCOMPARABLE.PRIMARY_MOCK;
  else if (primary.status !== EVAL_STATUS.SUCCESS) reason = INCOMPARABLE.PRIMARY_NOT_SUCCESS;
  else if (shadow.status !== EVAL_STATUS.SUCCESS) reason = INCOMPARABLE.SHADOW_NOT_SUCCESS;
  else if (primary.regime === null || shadow.regime === null) reason = INCOMPARABLE.MISSING_REGIME;

  const comparable = reason === null;

  const regimeMatch = comparable ? primary.regime === shadow.regime : null;
  const tradeAllowedMatch = comparable
    ? (primary.tradeAllowed === null || shadow.tradeAllowed === null
      ? null
      : primary.tradeAllowed === shadow.tradeAllowed)
    : null;
  // Signed, shadow RELATIVE TO primary: positive = the shadow was more
  // confident. Never rounded — callers aggregate raw values.
  const confidenceDelta = comparable && primary.confidence !== null && shadow.confidence !== null
    ? shadow.confidence - primary.confidence
    : null;
  // Full agreement needs BOTH the label and the tradability to match. If
  // tradability is unknown, agreement is unknown rather than assumed.
  const agreement = comparable
    ? (regimeMatch === null || tradeAllowedMatch === null ? null : regimeMatch && tradeAllowedMatch)
    : null;

  return {
    snapshotId: shadowRow?.snapshot_id ?? primaryRow?.snapshot_id ?? null,
    pair: shadowRow?.pair ?? primaryRow?.pair ?? null,
    primary,
    shadow,
    comparison: { regimeMatch, confidenceDelta, tradeAllowedMatch, agreement, comparable, reason },
  };
}

// Deterministic dedupe. Rows are keyed by (snapshot_id, pair, provider, model)
// and the HIGHEST id wins — the most recently written observation for that
// exact evaluation. Because the key and the tiebreak are both taken from the
// data, the result does not depend on input order.
export function dedupeRows(rows, keyOf) {
  const best = new Map();
  let dropped = 0;
  for (const row of rows) {
    const key = keyOf(row);
    const prev = best.get(key);
    if (prev === undefined) best.set(key, row);
    else {
      dropped += 1;
      if ((row.id ?? 0) > (prev.id ?? 0)) best.set(key, row);
    }
  }
  return { rows: [...best.values()], dropped };
}

const shadowKey = (r) => JSON.stringify([r.snapshot_id, r.pair, r.provider, r.model]);
const primaryKey = (r) => JSON.stringify([r.snapshot_id, r.pair]);

// True when the database has been migrated far enough to hold shadow data.
// A pre-migration database (no ai_shadow_calls table, no regime_calls
// .snapshot_id) must yield an empty dataset, never a SQL error.
export function hasShadowSchema(db) {
  const table = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ai_shadow_calls'",
  ).get();
  if (!table) return false;
  const cols = db.prepare('PRAGMA table_info(regime_calls)').all().map((c) => c.name);
  return cols.includes('snapshot_id');
}

/**
 * Load every comparable primary/shadow pairing from an already-populated
 * database. READ-ONLY.
 *
 * `db` is REQUIRED — this module never reaches for a global handle, which is
 * what keeps it free of config and credentials.
 *
 * Ordering is fully determined by the DATA (pair, snapshot, provider, model),
 * not by insertion order or wall-clock time, so a replay of the same rows
 * produces an identical sequence.
 *
 * @returns {{records: object[], meta: object}}
 */
export function loadComparisons(db, {
  pair = null, provider = null, snapshotId = null, since = null, limit = null,
} = {}) {
  if (!db) throw new TypeError('loadComparisons requires an open database handle');

  const meta = {
    schemaReady: false,
    shadowRows: 0,
    duplicateShadowRowsDropped: 0,
    duplicatePrimaryRowsDropped: 0,
    shadowRowsWithoutPrimary: 0,
    primaryRowsWithoutSnapshotId: 0,
    comparable: 0,
    incomparable: 0,
  };

  if (!hasShadowSchema(db)) return { records: [], meta };
  meta.schemaReady = true;

  const where = [];
  const args = [];
  if (pair) { where.push('s.pair = ?'); args.push(pair); }
  if (provider) { where.push('s.provider = ?'); args.push(provider); }
  if (snapshotId) { where.push('s.snapshot_id = ?'); args.push(snapshotId); }
  if (since) { where.push('s.created_at >= ?'); args.push(since); }

  const shadowRows = db.prepare(
    `SELECT id, snapshot_id, pair, provider, model, status, regime, confidence,
            trade_allowed, pricing_status, est_cost
       FROM ai_shadow_calls s
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pair, snapshot_id, provider, model, id`,
  ).all(...args);
  meta.shadowRows = shadowRows.length;

  // Primaries are counted for diagnostics even though only joined ones are
  // used: a primary with a NULL snapshot_id is a historical row that can never
  // be correlated, and silently omitting it would overstate coverage.
  meta.primaryRowsWithoutSnapshotId = db.prepare(
    'SELECT COUNT(*) AS n FROM regime_calls WHERE snapshot_id IS NULL',
  ).get().n;

  const dedupedShadow = dedupeRows(shadowRows, shadowKey);
  meta.duplicateShadowRowsDropped = dedupedShadow.dropped;

  const primaryRows = db.prepare(
    `SELECT id, snapshot_id, pair, provider, model, source, regime, confidence, trade_allowed
       FROM regime_calls WHERE snapshot_id IS NOT NULL ORDER BY id`,
  ).all();
  const dedupedPrimary = dedupeRows(primaryRows, primaryKey);
  meta.duplicatePrimaryRowsDropped = dedupedPrimary.dropped;

  const primaryBy = new Map(dedupedPrimary.rows.map((r) => [primaryKey(r), r]));

  const records = [];
  for (const s of dedupedShadow.rows) {
    const p = primaryBy.get(JSON.stringify([s.snapshot_id, s.pair]));
    if (!p) {
      // A shadow row whose primary is absent cannot be compared at all, and is
      // reported rather than silently dropped.
      meta.shadowRowsWithoutPrimary += 1;
      continue;
    }
    const record = compareRecords(p, s);
    if (record.comparison.comparable) meta.comparable += 1; else meta.incomparable += 1;
    records.push(record);
    if (limit !== null && records.length >= limit) break;
  }

  return { records, meta };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
//
// Pure computation over records that loadComparisons() (or a fixture) already
// produced. It touches no database, reads no configuration, and never mutates
// its input — the records are only read from.
//
// OBSERVATIONAL ONLY. Agreement counts how often a shadow model reached the
// same conclusion as the primary. It is NOT accuracy: the primary is not
// ground truth, so a high agreement rate says two models are similar, never
// that either is right. Nothing here ranks providers, names a "best" model,
// or estimates trading performance, because these records cannot support such
// a claim.

// Bucket key for a value that may be absent. Missing dimensions are collected
// under one explicit label rather than crashing or being silently dropped.
const UNKNOWN_KEY = 'unknown';
function bucketKey(value) {
  if (value === null || value === undefined) return UNKNOWN_KEY;
  const s = String(value).trim();
  return s === '' ? UNKNOWN_KEY : s;
}

// agreements / comparable, or null when there is nothing to divide by.
// Never NaN, never Infinity.
function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

// Mean of a population, or null when it is empty. Never rounded.
function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function newBucket() {
  return {
    rows: 0,
    comparable: 0,
    incomparable: 0,
    agreements: 0,
    disagreements: 0,
    deltas: [],
    absDeltas: [],
    shadowCost: 0,
  };
}

function bucketFor(map, key) {
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = newBucket();
    map.set(key, bucket);
  }
  return bucket;
}

// Objects are emitted with their keys SORTED so that two runs over the same
// records — in any order — serialize identically.
function emit(map, shape) {
  const out = {};
  for (const key of [...map.keys()].sort()) out[key] = shape(map.get(key));
  return out;
}

/**
 * Aggregate comparison records into totals and per-provider / per-regime /
 * per-pair breakdowns.
 *
 * Counting rules, applied identically in every bucket:
 *   agreement    = comparison.comparable === true AND comparison.agreement === true
 *   disagreement = comparison.comparable === true AND comparison.agreement === false
 * An incomparable row is therefore NEVER counted as a disagreement — that
 * conflation would quietly inflate every disagreement figure with timeouts
 * and provider errors.
 *
 * Confidence statistics use comparable rows with a finite delta only.
 *
 * Costs: a numeric shadow estCost is a KNOWN cost, null is an UNKNOWN one.
 * `known`/`unknown` are ROW COUNTS and `total` is the summed USD of the known
 * ones. Unknown pricing is never coerced to zero, so an unpriced model can
 * never masquerade as a free one.
 *
 * @param {object[]} records
 */
export function aggregateComparisons(records = []) {
  const list = Array.isArray(records) ? records : [];

  const totals = newBucket();
  const providers = new Map();
  const regimes = new Map();
  const pairs = new Map();
  let knownCosts = 0;
  let unknownCosts = 0;
  let costTotal = 0;

  for (const record of list) {
    const comparison = record?.comparison ?? {};
    const comparable = comparison.comparable === true;
    // Read against `true`/`false` explicitly: `agreement` is null on an
    // incomparable row, and null must fall into neither bucket.
    const isAgreement = comparable && comparison.agreement === true;
    const isDisagreement = comparable && comparison.agreement === false;

    const delta = comparison.confidenceDelta;
    const hasDelta = comparable && typeof delta === 'number' && Number.isFinite(delta);

    // byRegime is keyed on the PRIMARY's regime: the question it answers is
    // "in which market conditions do the models diverge", and the primary is
    // the label the trading system actually acted on.
    const providerBucket = bucketFor(providers, bucketKey(record?.shadow?.provider));
    const touched = [
      totals,
      providerBucket,
      bucketFor(regimes, bucketKey(record?.primary?.regime)),
      bucketFor(pairs, bucketKey(record?.pair)),
    ];

    for (const bucket of touched) {
      bucket.rows += 1;
      if (comparable) bucket.comparable += 1; else bucket.incomparable += 1;
      if (isAgreement) bucket.agreements += 1;
      if (isDisagreement) bucket.disagreements += 1;
      if (hasDelta) {
        bucket.deltas.push(delta);
        bucket.absDeltas.push(Math.abs(delta));
      }
    }

    // Cost is a property of the shadow CALL, so it is counted for every row —
    // including incomparable ones. A timed-out call can still have been billed.
    const cost = record?.shadow?.estCost;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      knownCosts += 1;
      costTotal += cost;
      providerBucket.shadowCost += cost;
    } else {
      unknownCosts += 1;
    }
  }

  return {
    totals: {
      rows: totals.rows,
      comparable: totals.comparable,
      incomparable: totals.incomparable,
      agreements: totals.agreements,
      disagreements: totals.disagreements,
      agreementRate: ratio(totals.agreements, totals.comparable),
    },
    byProvider: emit(providers, (b) => ({
      rows: b.rows,
      comparable: b.comparable,
      incomparable: b.incomparable,
      agreements: b.agreements,
      disagreements: b.disagreements,
      agreementRate: ratio(b.agreements, b.comparable),
      avgConfidenceDelta: mean(b.deltas),
      avgAbsoluteConfidenceDelta: mean(b.absDeltas),
      shadowCost: b.shadowCost,
    })),
    byRegime: emit(regimes, (b) => ({
      rows: b.rows,
      comparable: b.comparable,
      agreements: b.agreements,
      disagreements: b.disagreements,
      agreementRate: ratio(b.agreements, b.comparable),
    })),
    byPair: emit(pairs, (b) => ({
      rows: b.rows,
      comparable: b.comparable,
      agreements: b.agreements,
      disagreements: b.disagreements,
      agreementRate: ratio(b.agreements, b.comparable),
      avgConfidenceDelta: mean(b.deltas),
      avgAbsoluteConfidenceDelta: mean(b.absDeltas),
    })),
    costs: {
      known: knownCosts,
      unknown: unknownCosts,
      total: costTotal,
    },
  };
}

/**
 * Operational snapshot of the dataset. READ-ONLY, and deliberately narrow: it
 * reports only what is already stored, never configuration and never secrets.
 *
 * Timestamps come from columns that already exist (regime_calls.ts and
 * ai_shadow_calls.created_at). No schema field was added for this.
 */
export function datasetStatus(db) {
  if (!db) throw new TypeError('datasetStatus requires an open database handle');
  const status = {
    schemaReady: false,
    shadowRows: 0,
    comparableRows: 0,
    primariesWithSnapshotId: 0,
    latestPrimaryAt: null,
    latestShadowAt: null,
  };
  const hasRegimeCalls = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'regime_calls'",
  ).get();
  // regime_calls predates the shadow schema, so its latest timestamp is
  // reportable even on a database that cannot yet hold shadow rows.
  if (hasRegimeCalls) status.latestPrimaryAt = db.prepare('SELECT MAX(ts) AS t FROM regime_calls').get().t ?? null;

  status.schemaReady = hasShadowSchema(db);
  if (!status.schemaReady) return status;

  status.shadowRows = db.prepare('SELECT COUNT(*) AS c FROM ai_shadow_calls').get().c;
  status.latestShadowAt = db.prepare('SELECT MAX(created_at) AS t FROM ai_shadow_calls').get().t ?? null;
  status.primariesWithSnapshotId = db.prepare(
    'SELECT COUNT(*) AS c FROM regime_calls WHERE snapshot_id IS NOT NULL',
  ).get().c;
  status.comparableRows = loadComparisons(db).meta.comparable;
  return status;
}
