// Mistral pricing verification: the arithmetic, the metadata, and the budget
// bucket the cost lands in.
//
// Complements mistralPinning.test.js (which covers pinning + freshness) and
// pricing.test.js (which covers cross-provider contamination). Everything here
// is offline: no key, no network, no production DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { PRICING, PRICING_STATUS, resolvePricing } from '../src/ai/pricing.js';
import { addSpend, costFromUsage, wouldExceedBudget } from '../src/ai/budget.js';

const PINNED = 'mistral-large-2512';
const IN_RATE = 0.50, OUT_RATE = 1.50;
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

// --- verification metadata -------------------------------------------------

test('the pinned Mistral price is sourced from Mistral\'s OWN docs, not a reseller', () => {
  const entry = PRICING.mistral[PINNED];
  assert.ok(entry, `${PINNED} must be registered`);
  assert.equal(entry.inputPerMTok, IN_RATE);
  assert.equal(entry.outputPerMTok, OUT_RATE);
  // A third-party aggregator (OpenRouter, Fireworks, Bedrock, a blog) can
  // resell at its own margin — only Mistral's own price is authoritative for
  // a direct api.mistral.ai call.
  assert.match(entry.source, /(^|\.)mistral\.ai\//, 'source must be an official mistral.ai URL');
  assert.doesNotMatch(entry.source, /openrouter|fireworks|baseten|nvidia|huggingface|medium/i);
});

test('verifiedOn is a real, non-future date', () => {
  const ms = Date.parse(PRICING.mistral[PINNED].verifiedOn);
  assert.ok(Number.isFinite(ms), 'verifiedOn must parse');
  assert.ok(ms <= Date.now(), 'a price cannot have been verified in the future');
  assert.equal(resolvePricing('mistral', PINNED).status, PRICING_STATUS.EXACT);
});

test('the official ALIAS and the docs SLUG both stay unknown', () => {
  // Both strings are real and appear in Mistral's docs, which is exactly why
  // they are tempting: 'mistral-large-latest' is the published alias of this
  // very model, and 'mistral-large-3-25-12' is its docs URL slug. Neither is
  // priced: an alias silently re-points at a future model, and the slug is not
  // an API id at all.
  assert.equal(resolvePricing('mistral', 'mistral-large-latest').status, PRICING_STATUS.UNKNOWN);
  assert.equal(resolvePricing('mistral', 'mistral-large-3-25-12').status, PRICING_STATUS.UNKNOWN);
  assert.deepEqual(Object.keys(PRICING.mistral), [PINNED], 'exactly one priced Mistral model');
});

// --- cost arithmetic -------------------------------------------------------

test('cost matrix: 1M/1M, fractional, zero-in, zero-out, zero/zero, huge', () => {
  const p = resolvePricing('mistral', PINNED);

  // 1M in + 1M out = $0.50 + $1.50
  assert.equal(costFromUsage(1_000_000, 1_000_000, p), 2.00);
  // ...and emphatically not Anthropic's $3 + $15
  assert.notEqual(costFromUsage(1_000_000, 1_000_000, p), 18.00);

  // fractional counts are not rounded or truncated
  near(costFromUsage(1500.5, 250.25, p), (1500.5 * IN_RATE + 250.25 * OUT_RATE) / 1e6);
  near(costFromUsage(1500.5, 250.25, p), 0.001125625);

  // one side zero: the other side still bills
  assert.equal(costFromUsage(0, 1000, p), 0.0015);
  assert.equal(costFromUsage(1000, 0, p), 0.0005);

  // zero/zero is a KNOWN zero cost — the number 0, never null
  const zero = costFromUsage(0, 0, p);
  assert.equal(zero, 0);
  assert.notEqual(zero, null);
  assert.equal(typeof zero, 'number');

  // large counts stay linear (no overflow, no clamping)
  assert.equal(costFromUsage(1e9, 1e9, p), 2000);
  near(costFromUsage(123_456_789, 987_654_321, p), (123_456_789 * IN_RATE + 987_654_321 * OUT_RATE) / 1e6);
});

test('null means UNKNOWN pricing; 0 means a known zero cost', () => {
  const unknown = resolvePricing('mistral', 'mistral-nonexistent-9999');
  assert.equal(unknown.status, PRICING_STATUS.UNKNOWN);
  assert.equal(costFromUsage(1_000_000, 1_000_000, unknown), null, 'unknown price yields null, never 0');
  // The pinned model is no longer in that bucket.
  assert.notEqual(costFromUsage(1_000_000, 1_000_000, resolvePricing('mistral', PINNED)), null);
});

// --- budget bucket ---------------------------------------------------------

test('wouldExceedBudget gates per provider: Mistral and Anthropic cannot starve each other', () => {
  const db = openDb(':memory:');
  const date = '2026-01-01';
  const cap = 0.50;

  // Anthropic burns its entire daily cap.
  addSpend(cap, db, date, 'anthropic');

  assert.equal(wouldExceedBudget(0.01, cap, db, date, 'anthropic'), true, 'anthropic is capped out');
  assert.equal(wouldExceedBudget(0.01, cap, db, date, 'mistral'), false, 'mistral must be unaffected');

  // Now the mirror image: Mistral shadow spend must not close Anthropic's gate.
  const db2 = openDb(':memory:');
  addSpend(cap, db2, date, 'mistral');
  assert.equal(wouldExceedBudget(0.01, cap, db2, date, 'mistral'), true, 'mistral is capped out');
  assert.equal(wouldExceedBudget(0.01, cap, db2, date, 'anthropic'), false, 'anthropic must be unaffected');

  db.close(); db2.close();
});

test('an exactly-priced Mistral call accrues; an unknown-priced one accrues nothing', () => {
  const db = openDb(':memory:');
  const date = '2026-01-01';

  const exact = costFromUsage(1_000_000, 1_000_000, resolvePricing('mistral', PINNED));
  addSpend(exact, db, date, 'mistral');

  const unknownCost = costFromUsage(1_000_000, 1_000_000, resolvePricing('mistral', 'mistral-large-latest'));
  assert.equal(unknownCost, null);
  // The shadow path only calls addSpend for a finite number, so an unknown
  // price contributes nothing rather than being coerced to 0.
  if (typeof unknownCost === 'number' && Number.isFinite(unknownCost)) addSpend(unknownCost, db, date, 'mistral');

  const row = db.prepare('SELECT spend FROM ai_budget WHERE date = ? AND provider = ?').get(date, 'mistral');
  assert.equal(row.spend, 2.00, 'only the exactly-priced call accrued');
  const anthropicRow = db.prepare('SELECT spend FROM ai_budget WHERE date = ? AND provider = ?').get(date, 'anthropic');
  assert.equal(anthropicRow, undefined, 'nothing leaked into the anthropic bucket');

  db.close();
});

// --- report attribution ----------------------------------------------------

test('the report attributes Mistral spend to Mistral, never to Anthropic', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { config } = await import('../src/config.js');
  const { generateReport } = await import('../src/report/daily.js');

  const db = openDb(':memory:');
  const date = new Date().toISOString().slice(0, 10);
  addSpend(0.0120, db, date, 'anthropic');   // primary
  addSpend(2.0000, db, date, 'mistral');     // shadow

  // Never write into the repo's reports/ directory.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-report-'));
  const savedDir = config.reportsDir;
  config.reportsDir = tmp;
  let html;
  try {
    html = fs.readFileSync(generateReport(db, date), 'utf8');
  } finally {
    config.reportsDir = savedDir;
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  }

  // Each provider is named next to its OWN number.
  assert.match(html, /Today AI spend — anthropic<\/th><td>\$0\.0120</);
  assert.match(html, /Today AI spend — mistral<\/th><td>\$2\.0000</);
  assert.match(html, /Today AI spend — total<\/th><td>\$2\.0120</);
  // The failure this guards against: Mistral's $2 shown under an Anthropic label.
  assert.doesNotMatch(html, /anthropic<\/th><td>\$2\.0000</);
  assert.doesNotMatch(html, /Claude<\/th><td>\$2\.0000</);
});
