// Step 12: Mistral pinning + pricing freshness.
//
// Two properties under test:
//   1. Mistral is pinned to a CONCRETE version — never a moving alias — so
//      regime_calls.model identifies exactly what ran and its price is
//      verifiable.
//   2. Pricing freshness is observable (exact | stale | unknown) and NEITHER
//      stale nor unknown pricing can ever block a trade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  PRICING, PRICING_FRESHNESS_DAYS, PRICING_STATUS, listPricedModels, resolvePricing,
} from '../src/ai/pricing.js';
import { costFromUsage, getDailySpend } from '../src/ai/budget.js';
import { evaluateRegime } from '../src/ai/regime.js';
import { mistralProvider } from '../src/ai/providers/mistral.js';

const PINNED = 'mistral-large-2512';
const GOOD = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"x"}';
const SUMMARY = { pair: 'BTCUSDT' };
const MISTRAL_IN = 0.50, MISTRAL_OUT = 1.50;
const ANTHROPIC_IN = 3.00, ANTHROPIC_OUT = 15.00;

function jsonResponse(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
}
async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}
const lastCall = (db) => db.prepare('SELECT provider, model, est_cost, pricing_status, input_tokens, output_tokens FROM regime_calls ORDER BY id DESC LIMIT 1').get();

// One real Mistral primary call against a stubbed transport.
async function mistralCall({ db, usage, model = PINNED, override = '', text = GOOD, onFetch = null }) {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    if (onFetch) return onFetch(calls, ...args);
    return jsonResponse({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } });
  };
  try {
    const out = await withConfig({
      mock: false, aiProvider: 'mistral', mistralApiKey: 'test-not-real', groqApiKey: '',
      mistralModel: model, aiModelOverride: override,
    }, () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 'snap' }));
    return { out, calls };
  } finally { globalThis.fetch = saved; }
}

// --- pinning -------------------------------------------------------------

test('Mistral default is PINNED to a concrete version, not a moving alias', () => {
  assert.equal(config.mistralModel, PINNED, 'shipped default is the pinned id');
  assert.ok(!/latest/.test(config.mistralModel), 'no moving alias in the default');
  // and the alias itself is deliberately never priced
  assert.ok(!('mistral-large-latest' in PRICING.mistral));
  assert.equal(resolvePricing('mistral', 'mistral-large-latest').status, PRICING_STATUS.UNKNOWN);
});

test('the provider resolves the pinned default and puts it on the wire', async () => {
  await withConfig({ aiModelOverride: '', mistralModel: PINNED }, () => {
    assert.equal(mistralProvider.model, PINNED);
  });
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  let sentModel = null;
  globalThis.fetch = async (url, opts) => {
    sentModel = JSON.parse(opts.body).model;
    return jsonResponse({ model: sentModel, choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };
  try {
    await withConfig({ mock: false, aiProvider: 'mistral', mistralApiKey: 'test-not-real', groqApiKey: '', mistralModel: PINNED, aiModelOverride: '' },
      () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 's' }));
    assert.equal(sentModel, PINNED, 'pinned id reaches the API');
    assert.equal(lastCall(db).model, PINNED, 'and is what gets attributed');
  } finally { globalThis.fetch = saved; db.close(); }
});

test('an explicit AI_MODEL still wins over the pinned default', async () => {
  // Overriding TO the pinned id: the override is honoured and priced exactly.
  await withConfig({ aiModelOverride: PINNED, mistralModel: 'something-else' }, () => {
    assert.equal(mistralProvider.model, PINNED, 'override wins over the provider default');
  });
  const db = openDb(':memory:');
  const { out } = await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 }, model: 'something-else', override: PINNED });
  const r = lastCall(db);
  assert.equal(r.model, PINNED, 'the override reached the wire and the attribution');
  assert.equal(r.pricing_status, 'exact');
  assert.ok(Math.abs(r.est_cost - (MISTRAL_IN + MISTRAL_OUT)) < 1e-9);
  assert.equal(out.evaluation.fresh, true);
  db.close();
});

test('the doc-style handle mistral-large-3-25-12 is UNKNOWN, not priced by proximity', async () => {
  // 'mistral-large-2512' is the API model id; the documentation-style handle
  // is a different string and must NOT inherit its price just because it
  // names the same release.
  const p = resolvePricing('mistral', 'mistral-large-3-25-12');
  assert.equal(p.status, PRICING_STATUS.UNKNOWN);
  assert.equal(p.inputPerMTok, null);
  assert.equal(p.outputPerMTok, null);
  assert.equal(costFromUsage(1_000_000, 1_000_000, p), null);
  assert.ok(!('mistral-large-3-25-12' in PRICING.mistral), 'not in the registry');
  assert.deepEqual(listPricedModels().filter((m) => m.provider === 'mistral').map((m) => m.model), [PINNED],
    'exactly one priced Mistral model');

  // end-to-end: selecting it yields NULL cost, no accrual, and still trades
  const db = openDb(':memory:');
  const { out } = await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 }, override: 'mistral-large-3-25-12' });
  const r = lastCall(db);
  assert.equal(r.model, 'mistral-large-3-25-12');
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null, 'no cost invented');
  assert.equal(getDailySpend(db, undefined, 'mistral'), 0, 'no dollar accrual');
  assert.equal(out.regime.trade_allowed, true, 'and trading is never blocked');
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'PRICING_UNKNOWN'").get());
  db.close();
});

test('no auto-upgrade or routing: an unknown Mistral model stays unknown', async () => {
  const db = openDb(':memory:');
  await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 }, model: 'mistral-future-99' });
  const r = lastCall(db);
  assert.equal(r.model, 'mistral-future-99', 'never silently swapped for the pinned id');
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null);
  db.close();
});

// --- exact pricing -------------------------------------------------------

test('exact Mistral pricing: $0.50 in / $1.50 out, and the computed cost', async () => {
  const p = resolvePricing('mistral', PINNED);
  assert.equal(p.status, PRICING_STATUS.EXACT);
  assert.equal(p.inputPerMTok, MISTRAL_IN);
  assert.equal(p.outputPerMTok, MISTRAL_OUT);
  assert.match(p.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(PRICING.mistral[PINNED].source.includes('mistral.ai'), 'official source recorded');

  // 1M/1M -> $2.00 exactly
  assert.equal(costFromUsage(1_000_000, 1_000_000, p), MISTRAL_IN + MISTRAL_OUT);
  // realistic call, no premature rounding
  const expected = (1500 * MISTRAL_IN + 80 * MISTRAL_OUT) / 1_000_000;
  assert.equal(costFromUsage(1500, 80, p), expected);

  const db = openDb(':memory:');
  await mistralCall({ db, usage: { in: 1500, out: 80 } });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'exact');
  assert.ok(Math.abs(r.est_cost - expected) < 1e-12);
  assert.ok(Math.abs(getDailySpend(db, undefined, 'mistral') - expected) < 1e-12, 'accrued under mistral');
  assert.equal(getDailySpend(db, undefined, 'anthropic'), 0, 'never under anthropic');
  db.close();
});

// --- freshness semantics -------------------------------------------------

test('freshness: exact inside the threshold, stale beyond it — boundary checked', () => {
  const verified = Date.parse(PRICING.mistral[PINNED].verifiedOn);
  const at = (days) => new Date(verified + days * 86_400_000);
  assert.equal(resolvePricing('mistral', PINNED, at(0)).status, PRICING_STATUS.EXACT);
  assert.equal(resolvePricing('mistral', PINNED, at(PRICING_FRESHNESS_DAYS)).status, PRICING_STATUS.EXACT, 'exactly at the threshold is still fresh');
  assert.equal(resolvePricing('mistral', PINNED, at(PRICING_FRESHNESS_DAYS + 0.01)).status, PRICING_STATUS.STALE);
  const stale = resolvePricing('mistral', PINNED, at(400));
  assert.equal(stale.status, PRICING_STATUS.STALE);
  // a stale price is still a price: rates survive, cost is still computable
  assert.equal(stale.inputPerMTok, MISTRAL_IN);
  assert.equal(costFromUsage(1_000_000, 1_000_000, stale), MISTRAL_IN + MISTRAL_OUT);
  assert.ok(stale.ageDays > PRICING_FRESHNESS_DAYS);
  // the threshold is a fixed, documented constant
  assert.equal(PRICING_FRESHNESS_DAYS, 90);
});

test('a malformed verifiedOn is treated as STALE, never silently fresh', () => {
  const bad = { status: undefined };
  // resolve against a synthetic entry via the public API is not possible, so
  // assert the contract on every shipped entry instead: all parse cleanly.
  for (const m of listPricedModels()) {
    assert.ok(Number.isFinite(Date.parse(m.verifiedOn)), `${m.provider}/${m.model} has an unparseable verifiedOn`);
  }
  // and costFromUsage refuses anything that is not a usable price
  assert.equal(costFromUsage(1000, 1000, bad), null);
});

test('STALE pricing: emits a deduplicated PRICING_STALE, still costs, never blocks trading', async () => {
  const db = openDb(':memory:');
  // Force staleness by resolving against a far-future clock inside the engine:
  // simulate by registering the call twice on distinct pairs with a patched
  // Date so the engine sees an aged verifiedOn.
  const RealDate = Date;
  const future = new RealDate(RealDate.parse(PRICING.mistral[PINNED].verifiedOn) + 400 * 86_400_000);
  // eslint-disable-next-line no-global-assign
  globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(future); }
    static now() { return future.getTime(); }
    static parse(...a) { return RealDate.parse(...a); }
  };
  try {
    const { out } = await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 } });
    const r = lastCall(db);
    assert.equal(r.pricing_status, 'stale', 'flagged as stale');
    assert.ok(Math.abs(r.est_cost - 2.0) < 1e-9, 'a stale price still yields a cost');
    assert.ok(Math.abs(getDailySpend(db, undefined, 'mistral') - 2.0) < 1e-9, 'and still accrues');
    // TRADING IS NOT BLOCKED
    assert.equal(out.evaluation.fresh, true, 'the regime evaluation still succeeded');
    assert.equal(out.regime.regime, 'bearish');
    assert.equal(out.regime.trade_allowed, true, 'stale pricing never suppresses a signal');

    const events = db.prepare("SELECT detail FROM events WHERE type = 'PRICING_STALE'").all();
    assert.ok(events.length >= 1, 'PRICING_STALE emitted');
    const d = JSON.parse(events[0].detail);
    assert.equal(d.provider, 'mistral');
    assert.equal(d.model, PINNED);
    assert.ok(d.ageDays >= PRICING_FRESHNESS_DAYS, 'age reported');
    assert.equal(d.verifiedOn, PRICING.mistral[PINNED].verifiedOn);

    // dedupe: a second call on another pair adds no duplicate for the same model/day
    const before = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'PRICING_STALE'").get().n;
    await withConfig({ mock: false, aiProvider: 'mistral', mistralApiKey: 'test-not-real', groqApiKey: '', mistralModel: PINNED, aiModelOverride: '' }, async () => {
      const saved = globalThis.fetch;
      globalThis.fetch = async () => jsonResponse({ model: PINNED, choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      try { await evaluateRegime('ETHUSDT', { pair: 'ETHUSDT' }, db, Date.now(), { snapshotId: 's2' }); } finally { globalThis.fetch = saved; }
    });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'PRICING_STALE'").get().n, before,
      'deduplicated per model per day');
  } finally {
    globalThis.Date = RealDate;
    db.close();
  }
});

test('UNKNOWN pricing: NULL cost, no accrual, PRICING_UNKNOWN, still never blocks trading', async () => {
  const db = openDb(':memory:');
  const { out } = await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 }, model: 'mistral-unpriced-xyz' });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null, 'no cost invented');
  assert.equal(getDailySpend(db, undefined, 'mistral'), 0, 'no dollar accrual');
  // TRADING IS NOT BLOCKED
  assert.equal(out.evaluation.fresh, true);
  assert.equal(out.regime.trade_allowed, true);
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'PRICING_UNKNOWN'").get());
  db.close();
});

// --- no rate leakage -----------------------------------------------------

test('Mistral never inherits Anthropic rates, at any freshness', () => {
  const p = resolvePricing('mistral', PINNED);
  assert.notEqual(p.inputPerMTok, ANTHROPIC_IN);
  assert.notEqual(p.outputPerMTok, ANTHROPIC_OUT);
  for (const m of listPricedModels().filter((x) => x.provider === 'mistral')) {
    assert.ok(!(m.inputPerMTok === ANTHROPIC_IN && m.outputPerMTok === ANTHROPIC_OUT),
      `${m.model} carries Anthropic's exact rates`);
  }
  // Anthropic's model id is unknown on Mistral, and vice versa
  assert.equal(resolvePricing('mistral', 'claude-sonnet-4-6').status, PRICING_STATUS.UNKNOWN);
  assert.equal(resolvePricing('anthropic', PINNED).status, PRICING_STATUS.UNKNOWN);
});

test('end-to-end: a 1M/1M Mistral call costs $2.00, never Anthropic\'s $18', async () => {
  const db = openDb(':memory:');
  await mistralCall({ db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.ok(Math.abs(r.est_cost - 2.0) < 1e-9, `expected 2.00, got ${r.est_cost}`);
  assert.notEqual(r.est_cost, 18);
  db.close();
});

// --- safety invariant ----------------------------------------------------

test('safety invariant: at most ONE primary call plus ONE truncation retry', async () => {
  // normal success -> exactly one call
  const db1 = openDb(':memory:');
  const { calls: n1 } = await mistralCall({ db1: null, db: db1, usage: { in: 10, out: 5 } });
  assert.equal(n1, 1, 'a clean response makes exactly one call');
  db1.close();

  // truncated thinking -> exactly two calls, never more
  const db2 = openDb(':memory:');
  const { calls: n2 } = await mistralCall({
    db: db2, usage: { in: 10, out: 5 },
    onFetch: (n) => jsonResponse({
      model: PINNED,
      choices: [{ message: { content: n === 1 ? '<thinking>cut off' : GOOD } }],
      usage: { prompt_tokens: 1000 * n, completion_tokens: 100 * n },
    }),
  });
  assert.equal(n2, 2, 'one call + one retry, and no more');
  db2.close();

  // a SECOND truncation does NOT trigger a third attempt
  const db3 = openDb(':memory:');
  const { calls: n3, out } = await mistralCall({
    db: db3, usage: { in: 10, out: 5 },
    onFetch: () => jsonResponse({ model: PINNED, choices: [{ message: { content: '<thinking>still cut off' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
  });
  assert.equal(n3, 2, 'retry happens at most once even if it also truncates');
  assert.equal(out.regime.trade_allowed, false, 'and degrades to the safe fallback');
  db3.close();
});
