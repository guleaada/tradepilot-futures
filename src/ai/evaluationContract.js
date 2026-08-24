// THE regime-evaluation contract: what a model is asked to return, and what
// counts as a valid return. One definition, imported by the prompt so the two
// can never drift apart.
//
// SCOPE — read this before wiring anything new:
//   * This module is a SPECIFICATION and an OFFLINE validator. The
//     authoritative parser on the trading path is parseRegimeResponse() in
//     ./regime.js and it is deliberately untouched: making the live parser
//     stricter would turn calls that currently produce a tradable regime into
//     parse failures, which is a change in trading behavior.
//   * Use this to validate persisted output (regime_calls.raw_json,
//     ai_shadow_calls.raw_response) and to assert the contract in tests.
//   * It imports nothing, performs no I/O, and reaches no provider.
//
// REQUIRED vs OPTIONAL is the load-bearing distinction:
//   Required fields are exactly the four the production parser and the
//   database already depend on. A violation of any of them is a hard reject —
//   fail closed, never a salvaged half-evaluation.
//   Optional fields are additive observability. A violation drops that ONE
//   field and records an issue; it never invalidates an otherwise-good
//   evaluation, and no optional field is ever consulted for a trade.

export const VALID_REGIMES = Object.freeze(['bullish', 'bearish', 'chop']);
export const VALID_DIRECTIONS = Object.freeze(['long', 'short', 'neutral']);

// The four fields the engine and the schema already rely on.
export const REQUIRED_FIELDS = Object.freeze(['regime', 'confidence', 'trade_allowed', 'reasoning']);
// Additive; persisted only inside the existing raw text columns. No migration.
export const OPTIONAL_FIELDS = Object.freeze(['direction', 'evidence', 'uncertainty']);

export const MAX_EVIDENCE = 3;
export const MAX_UNCERTAINTY = 2;
export const MAX_REASONING_CHARS = 200; // matches the production parser's truncation
// Evidence and uncertainty are meant to be SHORT statements. Without a cap a
// model could return megabyte strings that are then logged and compared; the
// sibling field (reasoning) has always been capped, so this closes that gap.
export const MAX_ITEM_CHARS = 200;

// The exact schema line embedded in the system prompt. Kept here so a change
// to the contract is a change to the prompt, provably (see promptContract test).
export const SCHEMA_LINE =
  '{"regime":"bullish"|"bearish"|"chop","confidence":<integer 0-100>,'
  + '"trade_allowed":true|false,"direction":"long"|"short"|"neutral",'
  + '"reasoning":"<non-empty, max 2 sentences>",'
  + '"evidence":["<=3 short factual statements about the supplied data"],'
  + '"uncertainty":["<=2 items; [] when the evidence is clean"]}';

// Hard-reject reasons. Exactly one is reported, in the fixed order checked.
export const REJECT = Object.freeze({
  EMPTY: 'empty_output',
  NOT_JSON: 'malformed_json',
  NOT_OBJECT: 'not_an_object',
  REGIME_INVALID: 'regime_missing_or_invalid',
  CONFIDENCE_TYPE: 'confidence_not_an_integer',
  CONFIDENCE_RANGE: 'confidence_out_of_range',
  TRADE_ALLOWED_INVALID: 'trade_allowed_not_boolean',
  REASONING_INVALID: 'reasoning_missing_or_empty',
});

// Soft issues: recorded, never fatal.
export const ISSUE = Object.freeze({
  DIRECTION_INVALID: 'direction_invalid_dropped',
  DIRECTION_CONTRADICTS_REGIME: 'direction_contradicts_regime_dropped',
  EVIDENCE_INVALID: 'evidence_not_an_array_of_strings_dropped',
  EVIDENCE_TRUNCATED: 'evidence_truncated',
  UNCERTAINTY_INVALID: 'uncertainty_not_an_array_of_strings_dropped',
  UNCERTAINTY_TRUNCATED: 'uncertainty_truncated',
  UNKNOWN_FIELDS: 'unknown_fields_ignored',
  MARKDOWN_WRAPPED: 'markdown_fence_stripped',
  PROSE_AROUND_JSON: 'surrounding_prose_stripped',
});

const THINKING_CLOSE = '</thinking>';

// Drop everything up to a LONE closing tag (one with no opening tag before
// it), leaving text that already contains a proper <thinking> pair untouched.
//
// This is the linear equivalent of the production parser's
//   /[\s\S]*<\/thinking>/i  with a "keep it if it contains an opening tag" callback.
// That regex backtracks catastrophically when NO closing tag is present: a
// greedy [\s\S]* is retried from every start position, giving O(n^2). Measured
// at 597ms for a 16KB response and rising fourfold per doubling. Indexing is
// O(n) and byte-equivalent on every case (verified in promptContract.test.js).
function stripLoneClosingTag(s) {
  const at = s.toLowerCase().lastIndexOf(THINKING_CLOSE);
  if (at === -1) return s;
  const upto = at + THINKING_CLOSE.length;
  return /<thinking/i.test(s.slice(0, upto)) ? s : s.slice(upto);
}

// Strip the wrappers models actually emit, mirroring the production parser so
// the two agree on what "the JSON" is. Returns { body, issues }.
function unwrap(text) {
  const issues = [];
  let body = stripLoneClosingTag(text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')).trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) {
    body = fenced[1].trim();
    issues.push(ISSUE.MARKDOWN_WRAPPED);
  }
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return { body: null, issues };
    body = body.slice(start, end + 1);
    issues.push(ISSUE.PROSE_AROUND_JSON);
  }
  return { body, issues };
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

// A direction that argues against its own regime is incoherent. It is dropped
// rather than reconciled: the regime is what the engine already acts on, and
// silently "fixing" direction would invent an opinion the model did not give.
function directionContradicts(regime, direction) {
  return (regime === 'bullish' && direction === 'short') || (regime === 'bearish' && direction === 'long');
}

/**
 * Validate raw model text against the contract.
 *
 * @returns {{ok: boolean, rejected: string|null, value: object|null, issues: string[]}}
 *   ok=false  -> rejected names the single hard failure; value is null.
 *   ok=true   -> value carries the four required fields plus any optional
 *                field that survived validation; issues lists what was dropped.
 */
export function validateEvaluation(text) {
  const issues = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, rejected: REJECT.EMPTY, value: null, issues };
  }

  const unwrapped = unwrap(text);
  issues.push(...unwrapped.issues);
  if (unwrapped.body === null) {
    return { ok: false, rejected: REJECT.NOT_JSON, value: null, issues };
  }

  let obj;
  try {
    obj = JSON.parse(unwrapped.body);
  } catch {
    return { ok: false, rejected: REJECT.NOT_JSON, value: null, issues };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, rejected: REJECT.NOT_OBJECT, value: null, issues };
  }

  // --- required, in fixed order so the reported reason is deterministic ---
  if (!VALID_REGIMES.includes(obj.regime)) {
    return { ok: false, rejected: REJECT.REGIME_INVALID, value: null, issues };
  }
  // Number() first so a numeric string is judged on its value, but booleans,
  // null and arrays (which Number() happily coerces) are excluded up front.
  const rawConfidence = obj.confidence;
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence) || !Number.isInteger(rawConfidence)) {
    return { ok: false, rejected: REJECT.CONFIDENCE_TYPE, value: null, issues };
  }
  // Out of range is REJECTED here, not clamped. Clamping 150 -> 100 would
  // manufacture maximum conviction out of a value the model was never allowed
  // to emit. (The production parser clamps instead; see docs/ai-layer.md.)
  if (rawConfidence < 0 || rawConfidence > 100) {
    return { ok: false, rejected: REJECT.CONFIDENCE_RANGE, value: null, issues };
  }
  if (typeof obj.trade_allowed !== 'boolean') {
    return { ok: false, rejected: REJECT.TRADE_ALLOWED_INVALID, value: null, issues };
  }
  const reasoning = obj.reasoning ?? obj.reason;
  if (typeof reasoning !== 'string' || reasoning.trim() === '') {
    return { ok: false, rejected: REJECT.REASONING_INVALID, value: null, issues };
  }

  const value = {
    regime: obj.regime,
    confidence: rawConfidence,
    trade_allowed: obj.trade_allowed,
    reasoning: reasoning.trim().slice(0, MAX_REASONING_CHARS),
    direction: null,
    evidence: [],
    uncertainty: [],
  };

  // --- optional: a violation drops the field, never the evaluation ---
  if (obj.direction !== undefined && obj.direction !== null) {
    if (!VALID_DIRECTIONS.includes(obj.direction)) issues.push(ISSUE.DIRECTION_INVALID);
    else if (directionContradicts(obj.regime, obj.direction)) issues.push(ISSUE.DIRECTION_CONTRADICTS_REGIME);
    else value.direction = obj.direction;
  }
  if (obj.evidence !== undefined && obj.evidence !== null) {
    if (!isStringArray(obj.evidence)) issues.push(ISSUE.EVIDENCE_INVALID);
    else {
      value.evidence = obj.evidence.slice(0, MAX_EVIDENCE).map((s) => s.trim().slice(0, MAX_ITEM_CHARS));
      if (obj.evidence.length > MAX_EVIDENCE) issues.push(ISSUE.EVIDENCE_TRUNCATED);
    }
  }
  if (obj.uncertainty !== undefined && obj.uncertainty !== null) {
    if (!isStringArray(obj.uncertainty)) issues.push(ISSUE.UNCERTAINTY_INVALID);
    else {
      value.uncertainty = obj.uncertainty.slice(0, MAX_UNCERTAINTY).map((s) => s.trim().slice(0, MAX_ITEM_CHARS));
      if (obj.uncertainty.length > MAX_UNCERTAINTY) issues.push(ISSUE.UNCERTAINTY_TRUNCATED);
    }
  }

  const known = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS, 'reason']);
  if (Object.keys(obj).some((k) => !known.has(k))) issues.push(ISSUE.UNKNOWN_FIELDS);

  return { ok: true, rejected: null, value, issues };
}
