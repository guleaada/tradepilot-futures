// Provider/model-specific pricing.
//
// The property this suite exists to protect: NO provider may ever silently
// inherit another provider's price. An unrecognised (provider, model) pair
// resolves to 'unknown' with a NULL cost — never to a default rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { PRICING, PRICING_STATUS, listPricedModels, resolvePricing } from '../src/ai/pricing.js';
import { addSpend, costFromUsage, getDailySpend, getSpendByProvider } from '../src/ai/budget.js';
import { evaluateRegime } from '../src/ai/regime.js';
import { getShadowCalls, runShadowEvaluation } from '../src/ai/shadow.js';

const GOOD = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"x"}';
const SUMMARY = { pair: 'BTCUSDT' };
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

// Drive a real primary call for a given provider/model with a stubbed fetch.
async function primaryCall({ provider, model, db, usage, text = GOOD, status = 200, pair = 'BTCUSDT' }) {
  const saved = globalThis.fetch;
  const bodies = {
    anthropic: () => jsonResponse({ content: [{ type: 'text', text }], usage: { input_tokens: usage.in, output_tokens: usage.out } }, status),
    gemini: () => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out } }, status),
    openrouter: () => jsonResponse({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } }, status),
    mistral: () => jsonResponse({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out } }, status),
  };
  globalThis.fetch = async () => bodies[provider]();
  try {
    const keys = { anthropic: 'anthropicApiKey', gemini: 'geminiApiKey', openrouter: 'openrouterApiKey', mistral: 'mistralApiKey' };
    const models = { anthropic: 'aiModel', gemini: 'geminiModel', openrouter: 'openrouterModel', mistral: 'mistralModel' };
    return await withConfig({
      mock: false, aiProvider: provider, groqApiKey: '', aiModelOverride: '',
      [keys[provider]]: 'test-not-real', [models[provider]]: model,
    }, () => evaluateRegime(pair, { ...SUMMARY, pair }, db, Date.now(), { snapshotId: 'snap' }));
  } finally { globalThis.fetch = saved; }
}

const lastCall = (db) => db.prepare('SELECT provider, model, est_cost, pricing_status, input_tokens, output_tokens FROM regime_calls ORDER BY id DESC LIMIT 1').get();

// --- A–D: exact vs unknown per provider ---------------------------------

test('A: Anthropic claude-sonnet-4-6 prices at $3/$15', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'anthropic', model: 'claude-sonnet-4-6', db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'exact');
  assert.ok(Math.abs(r.est_cost - (ANTHROPIC_IN + ANTHROPIC_OUT)) < 1e-9, `got ${r.est_cost}`);
  assert.ok(Math.abs(getDailySpend(db, undefined, 'anthropic') - 18) < 1e-9);
  db.close();
});

test('B: Gemini gemini-2.5-flash prices at $0.30/$2.50', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'gemini', model: 'gemini-2.5-flash', db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.pricing_status, 'exact');
  assert.ok(Math.abs(r.est_cost - 2.80) < 1e-9, `got ${r.est_cost}`);
  db.close();
});

test('C: OpenRouter llama-3.3-70b prices at $0.10/$0.32', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'exact');
  assert.ok(Math.abs(r.est_cost - 0.42) < 1e-9, `got ${r.est_cost}`);
  db.close();
});

test('D: Mistral mistral-large-latest is UNKNOWN — a moving alias is never guessed', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'mistral', model: 'mistral-large-latest', db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.equal(r.provider, 'mistral');
  assert.equal(r.model, 'mistral-large-latest');
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null, 'no cost invented for an unresolved alias');
  assert.equal(getDailySpend(db, undefined, 'mistral'), 0, 'nothing accrued');
  // Step 12 pins and prices concrete Mistral versions, but the moving ALIAS
  // must still resolve to unknown: pricing it would be a guess about which
  // model actually ran.
  assert.ok(!('mistral-large-latest' in PRICING.mistral), 'the alias is never priced');
  db.close();
});

// --- E–G: unknown models and AI_MODEL overrides -------------------------

test('E + G: an unknown model resolves to unknown — NOT the provider default price', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'gemini', model: 'gemini-99-future', db, usage: { in: 1_000_000, out: 1_000_000 } });
  const r = lastCall(db);
  assert.equal(r.model, 'gemini-99-future');
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null);
  // specifically NOT gemini-2.5-flash's price
  assert.notEqual(r.est_cost, 2.80);
  db.close();
});

test('F: an explicit AI_MODEL selects that model\'s OWN price', async () => {
  // AI_MODEL pointing at a priced model on its own provider -> exact
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ candidates: [{ content: { parts: [{ text: GOOD }] } }], usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 } });
  try {
    await withConfig({ mock: false, aiProvider: 'gemini', geminiApiKey: 'test-not-real', groqApiKey: '', aiModelOverride: 'gemini-2.5-flash', geminiModel: 'something-else' },
      () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 's' }));
    const r = lastCall(db);
    assert.equal(r.model, 'gemini-2.5-flash', 'the override chose the model');
    assert.equal(r.pricing_status, 'exact');
    assert.ok(Math.abs(r.est_cost - 2.80) < 1e-9, 'and the override chose the PRICE');
  } finally { globalThis.fetch = saved; db.close(); }
});

test('G2: AI_MODEL pointing at an Anthropic id on Gemini does NOT borrow Anthropic pricing', () => {
  // the exact silent-mispricing scenario this design exists to prevent
  const p = resolvePricing('gemini', 'claude-sonnet-4-6');
  assert.equal(p.status, 'unknown');
  assert.equal(p.inputPerMTok, null);
  assert.equal(costFromUsage(1_000_000, 1_000_000, p), null);
});

// --- §19 REGRESSION GUARD -----------------------------------------------

test('§19: no provider may silently inherit Anthropic pricing', () => {
  const anthropicPrice = resolvePricing('anthropic', 'claude-sonnet-4-6');
  assert.equal(anthropicPrice.inputPerMTok, ANTHROPIC_IN);
  assert.equal(anthropicPrice.outputPerMTok, ANTHROPIC_OUT);

  for (const provider of ['gemini', 'openrouter', 'mistral']) {
    // Anthropic's model id is unknown on every other provider
    const borrowed = resolvePricing(provider, 'claude-sonnet-4-6');
    assert.equal(borrowed.status, 'unknown', `${provider} must not know Anthropic's model`);
    assert.equal(borrowed.inputPerMTok, null);

    // and no priced model of theirs happens to carry Anthropic's rates
    for (const entry of listPricedModels().filter((m) => m.provider === provider)) {
      assert.ok(!(entry.inputPerMTok === ANTHROPIC_IN && entry.outputPerMTok === ANTHROPIC_OUT),
        `${provider}/${entry.model} carries Anthropic's exact rates — suspicious`);
    }
    // an arbitrary unknown model never yields a number
    assert.equal(costFromUsage(1_000_000, 1_000_000, resolvePricing(provider, 'anything-at-all')), null);
  }
});

test('P + Q + R: end-to-end, a 1M/1M call on each provider is never charged $18', async () => {
  for (const [provider, model, expected] of [
    ['gemini', 'gemini-2.5-flash', 2.80],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct', 0.42],
    ['mistral', 'mistral-large-latest', null],
  ]) {
    const db = openDb(':memory:');
    await primaryCall({ provider, model, db, usage: { in: 1_000_000, out: 1_000_000 } });
    const r = lastCall(db);
    if (expected === null) assert.equal(r.est_cost, null, `${provider}: unknown stays NULL`);
    else assert.ok(Math.abs(r.est_cost - expected) < 1e-9, `${provider}: expected ${expected}, got ${r.est_cost}`);
    assert.notEqual(r.est_cost, 18, `${provider} was charged Anthropic's $18`);
    assert.equal(getDailySpend(db, undefined, 'anthropic'), 0, `${provider} spend must not land in Anthropic's bucket`);
    db.close();
  }
});

// --- H–K: budget isolation, attribution, retry --------------------------

test('H: ai_budget keeps each provider in its own bucket', async () => {
  const db = openDb(':memory:');
  // Different pairs: two calls on the SAME pair inside AI_CADENCE_HOURS would
  // hit the cadence cache and never reach a provider.
  await primaryCall({ provider: 'anthropic', model: 'claude-sonnet-4-6', db, usage: { in: 1_000_000, out: 0 }, pair: 'BTCUSDT' });
  await primaryCall({ provider: 'gemini', model: 'gemini-2.5-flash', db, usage: { in: 1_000_000, out: 0 }, pair: 'ETHUSDT' });
  const { byProvider, total } = getSpendByProvider(db);
  const map = Object.fromEntries(byProvider.map((r) => [r.provider, r.spend]));
  assert.ok(Math.abs(map.anthropic - 3.0) < 1e-9);
  assert.ok(Math.abs(map.gemini - 0.30) < 1e-9);
  assert.ok(Math.abs(total - 3.30) < 1e-9);
  db.close();
});

test('I + J: regime_calls records pricing_status and est_cost together', async () => {
  const db = openDb(':memory:');
  await primaryCall({ provider: 'anthropic', model: 'claude-sonnet-4-6', db, usage: { in: 1500, out: 80 } });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'exact');
  const expected = (1500 * 3 + 80 * 15) / 1e6;
  assert.ok(Math.abs(r.est_cost - expected) < 1e-12, `${r.est_cost} vs ${expected}`);
  db.close();
});

test('K: a truncation retry charges BOTH attempts independently', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return n === 1
      ? jsonResponse({ content: [{ type: 'text', text: '<thinking>cut off' }], usage: { input_tokens: 1000, output_tokens: 100 } })
      : jsonResponse({ content: [{ type: 'text', text: GOOD }], usage: { input_tokens: 2000, output_tokens: 150 } });
  };
  try {
    await withConfig({ mock: false, aiProvider: 'anthropic', anthropicApiKey: 'test-not-real', groqApiKey: '', aiModel: 'claude-sonnet-4-6' },
      () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 's' }));
    assert.equal(n, 2, 'two billable attempts');
    // (1000*3 + 100*15) + (2000*3 + 150*15) all / 1e6
    const expected = ((1000 * 3 + 100 * 15) + (2000 * 3 + 150 * 15)) / 1e6;
    assert.ok(Math.abs(getDailySpend(db, undefined, 'anthropic') - expected) < 1e-12, `spend ${getDailySpend(db, undefined, 'anthropic')} vs ${expected}`);
    assert.ok(Math.abs(lastCall(db).est_cost - expected) < 1e-12, 'row cost is the sum of both attempts');
  } finally { globalThis.fetch = saved; db.close(); }
});

test('K2: with unknown pricing, BOTH retry attempts stay uncosted', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return n === 1
      ? jsonResponse({ choices: [{ message: { content: '<thinking>cut off' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } })
      : jsonResponse({ choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 2000, completion_tokens: 150 } });
  };
  try {
    await withConfig({ mock: false, aiProvider: 'mistral', mistralApiKey: 'test-not-real', groqApiKey: '', aiModelOverride: '', mistralModel: 'mistral-large-latest' },
      () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 's' }));
    assert.equal(n, 2);
    assert.equal(lastCall(db).est_cost, null);
    assert.equal(getDailySpend(db, undefined, 'mistral'), 0, 'no Anthropic fallback charge');
  } finally { globalThis.fetch = saved; db.close(); }
});

// --- L–N + O: shadow pricing --------------------------------------------

function fakeShadow(name, model, usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }) {
  return {
    name, keyEnvVar: `${name.toUpperCase()}_API_KEY`, isConfigured: () => true,
    get model() { return model; },
    async complete() { return { provider: name, model, text: GOOD, usage }; },
  };
}

test('L + M + N: shadow rows carry est_cost/pricing_status and accrue to their OWN provider', async () => {
  const db = openDb(':memory:');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic' }, () =>
    runShadowEvaluation({
      pair: 'BTCUSDT', summary: SUMMARY, snapshotId: 'snap', db,
      providers: [fakeShadow('gemini', 'gemini-2.5-flash'), fakeShadow('openrouter', 'meta-llama/llama-3.3-70b-instruct')],
    }));
  const rows = Object.fromEntries(getShadowCalls(db).map((r) => [r.provider, r]));
  assert.equal(rows.gemini.pricing_status, 'exact');
  assert.ok(Math.abs(rows.gemini.est_cost - 2.80) < 1e-9);
  assert.ok(Math.abs(rows.openrouter.est_cost - 0.42) < 1e-9);
  // spend lands under each shadow provider, never Anthropic
  const map = Object.fromEntries(getSpendByProvider(db).byProvider.map((r) => [r.provider, r.spend]));
  assert.ok(Math.abs(map.gemini - 2.80) < 1e-9);
  assert.ok(Math.abs(map.openrouter - 0.42) < 1e-9);
  assert.equal(map.anthropic, undefined, 'shadow spend NEVER lands under the primary');
  db.close();
});

test('O: unknown shadow pricing → NULL cost, no spend, PRICING_UNKNOWN event', async () => {
  const db = openDb(':memory:');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic' }, () =>
    runShadowEvaluation({
      pair: 'BTCUSDT', summary: SUMMARY, snapshotId: 'snap', db,
      providers: [fakeShadow('mistral', 'mistral-large-latest')],
    }));
  const r = getShadowCalls(db)[0];
  assert.equal(r.pricing_status, 'unknown');
  assert.equal(r.est_cost, null);
  assert.equal(getDailySpend(db, undefined, 'mistral'), 0);
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'PRICING_UNKNOWN'").get();
  assert.ok(ev, 'PRICING_UNKNOWN emitted');
  const d = JSON.parse(ev.detail);
  assert.equal(d.provider, 'mistral');
  assert.equal(d.model, 'mistral-large-latest');
  db.close();
});

test('O2: an unknown-priced PRIMARY emits PRICING_UNKNOWN and still trades normally', async () => {
  const db = openDb(':memory:');
  const out = await primaryCall({ provider: 'mistral', model: 'mistral-large-latest', db, usage: { in: 10, out: 5 } });
  assert.equal(out.regime.regime, 'bearish', 'trading is NOT blocked by unknown pricing');
  assert.equal(out.evaluation.fresh, true);
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'PRICING_UNKNOWN'").get());
  db.close();
});

// --- U–X: edge cases and determinism ------------------------------------

test('U + V: zero tokens cost 0 (exact); missing usage is 0, not null-priced', async () => {
  const p = resolvePricing('anthropic', 'claude-sonnet-4-6');
  assert.equal(costFromUsage(0, 0, p), 0, 'zero tokens is a computed 0, not unknown');
  const db = openDb(':memory:');
  await primaryCall({ provider: 'gemini', model: 'gemini-2.5-flash', db, usage: { in: 0, out: 0 } });
  const r = lastCall(db);
  assert.equal(r.pricing_status, 'exact');
  assert.equal(r.est_cost, 0);
  assert.equal(r.input_tokens, 0);
  db.close();
});

test('V2: costFromUsage with no pricing argument returns null, never a default', () => {
  assert.equal(costFromUsage(1000, 1000, undefined), null);
  assert.equal(costFromUsage(1000, 1000, null), null);
  assert.equal(costFromUsage(1000, 1000, { status: 'unknown', inputPerMTok: null, outputPerMTok: null }), null);
});

test('W: exact floating-point arithmetic', () => {
  const p = resolvePricing('openrouter', 'meta-llama/llama-3.3-70b-instruct');
  // 1,234,567 in @ $0.10 + 89,012 out @ $0.32
  const expected = (1234567 * 0.10 + 89012 * 0.32) / 1_000_000;
  assert.equal(costFromUsage(1234567, 89012, p), expected, 'no premature rounding');
  assert.ok(Math.abs(costFromUsage(1_000_000, 0, p) - 0.10) < 1e-12);
});

test('X: resolution is deterministic, case-insensitive on provider, exact on model', () => {
  // `now` is pinned: ageDays legitimately advances with the wall clock, so
  // determinism means "same inputs INCLUDING time -> same result".
  const NOW = new Date('2026-08-21T12:00:00Z');
  const a = resolvePricing('anthropic', 'claude-sonnet-4-6', NOW);
  for (let i = 0; i < 5; i++) assert.deepEqual(resolvePricing('anthropic', 'claude-sonnet-4-6', NOW), a);
  assert.deepEqual(resolvePricing('ANTHROPIC', 'claude-sonnet-4-6', NOW), a, 'provider case-insensitive');
  // model ids are matched EXACTLY — no fuzzy/prefix matching
  assert.equal(resolvePricing('anthropic', 'claude-sonnet-4-6 ').status, 'unknown');
  assert.equal(resolvePricing('anthropic', 'claude-sonnet-4').status, 'unknown');
  assert.equal(resolvePricing('anthropic', 'claude-sonnet-5').status, 'unknown', 'a newer model is not assumed to share a price');
  assert.equal(resolvePricing(null, null).status, 'unknown');
  // every entry carries a verification date
  for (const m of listPricedModels()) {
    assert.match(m.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${m.provider}/${m.model} needs a verifiedOn date`);
    assert.ok(m.source, `${m.provider}/${m.model} needs a source`);
  }
});
