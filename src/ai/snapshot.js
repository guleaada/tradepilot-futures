// THE canonical market-snapshot identifier — one implementation, shared by the
// primary regime path and the shadow evaluation path.
//
// A snapshot id answers exactly one question: "which market state was this
// model shown?" It is therefore derived from the market summary ALONE. It
// deliberately contains nothing about who answered or how:
//   no provider, no model, no prompt text, no config, no credentials,
//   no headers, no timestamps-as-identity.
// That is what makes it a valid join key for comparing different models on
// identical input.
//
// The id is created ONCE per pair per cycle in runCycle and passed to both
// paths, so primary and shadow rows can be joined exactly. Nothing else may
// re-derive it independently.
import crypto from 'node:crypto';

// Recursively key-sorted JSON so the id identifies the SEMANTIC input: two
// structurally identical summaries hash the same regardless of key order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// SHA-256 hex of the canonicalized market summary.
export function createSnapshotId(summary) {
  return crypto.createHash('sha256').update(canonicalJson(summary)).digest('hex');
}
