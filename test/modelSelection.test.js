// Cross-provider model-selection consistency.
//
// ONE rule, identical for every primary provider:
//   AI_MODEL explicitly set  -> that model, whichever provider is selected
//   AI_MODEL unset           -> that provider's own default
//
// The trap this guards: config.aiModel folds in an Anthropic-flavoured
// fallback ('claude-sonnet-4-6'), so it can never be used as "the generic
// model" — doing so would silently override Gemini's / OpenRouter's defaults
// with an id that is invalid on those APIs. config.aiModelOverride is the RAW
// AI_MODEL (empty when unset) and is what the rule keys off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { anthropicProvider } from '../src/ai/providers/anthropic.js';
import { geminiProvider } from '../src/ai/providers/gemini.js';
import { openrouterProvider } from '../src/ai/providers/openrouter.js';
import { getPrimaryProvider, listPrimaryProviders } from '../src/ai/providers/index.js';
import { getRegime } from '../src/ai/regime.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT' };
const EXPLICIT = 'vendor/explicitly-chosen-model';

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

// Captures the model each provider actually PUTS ON THE WIRE, per API shape.
function captureFetch(providerName) {
  const seen = { url: null, model: null };
  const impl = async (url, opts = {}) => {
    seen.url = String(url);
    seen.model = JSON.parse(opts.body).model ?? null; // gemini carries it in the URL
    if (providerName === 'gemini') {
      const m = seen.url.match(/models\/([^:]+):generateContent/);
      seen.model = m ? decodeURIComponent(m[1]) : null;
      return jsonResponse({ candidates: [{ content: { parts: [{ text: GOOD_JSON }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    }
    if (providerName === 'openrouter') {
      return jsonResponse({ model: seen.model, choices: [{ message: { content: GOOD_JSON } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    return jsonResponse({ content: [{ type: 'text', text: GOOD_JSON }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  impl.seen = seen;
  return impl;
}

// Drive the full engine so the recorded attribution is checked too, not just
// the getter.
async function resolveThroughEngine(providerName, overrides) {
  const db = openDb(':memory:');
  const fetchImpl = captureFetch(providerName);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await withConfig({
      mock: false, aiProvider: providerName, groqApiKey: '',
      anthropicApiKey: 'test-not-real', geminiApiKey: 'test-not-real', openrouterApiKey: 'test-not-real',
      ...overrides,
    }, () => getRegime('BTCUSDT', SUMMARY, db));
    const row = db.prepare('SELECT provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    return { wire: fetchImpl.seen.model, recorded: row };
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
}

// --- A / B. Gemini ------------------------------------------------------

test('A: Gemini uses an explicitly set AI_MODEL', async () => {
  await withConfig({ aiModelOverride: EXPLICIT, geminiModel: 'gemini-2.5-flash' }, () => {
    assert.equal(geminiProvider.model, EXPLICIT);
  });
  const { wire, recorded } = await resolveThroughEngine('gemini', { aiModelOverride: EXPLICIT, geminiModel: 'gemini-2.5-flash' });
  assert.equal(wire, EXPLICIT, 'the explicit model is what hits the API');
  assert.equal(recorded.provider, 'gemini');
  assert.equal(recorded.model, EXPLICIT, 'and what gets recorded');
});

test('B: Gemini falls back to its own default when AI_MODEL is unset', async () => {
  await withConfig({ aiModelOverride: '', geminiModel: 'gemini-2.5-flash' }, () => {
    assert.equal(geminiProvider.model, 'gemini-2.5-flash');
  });
  const { wire, recorded } = await resolveThroughEngine('gemini', { aiModelOverride: '', geminiModel: 'gemini-2.5-flash' });
  assert.equal(wire, 'gemini-2.5-flash');
  assert.equal(recorded.model, 'gemini-2.5-flash');
  // the Anthropic-flavoured fallback must NEVER leak into Gemini
  assert.notEqual(recorded.model, config.aiModel);
  assert.ok(!String(recorded.model).includes('claude'), 'no Anthropic default bleeding through');
});

// --- C. OpenRouter unchanged --------------------------------------------

test('C: OpenRouter behavior is unchanged — explicit wins, else its own default', async () => {
  await withConfig({ aiModelOverride: EXPLICIT, openrouterModel: 'meta-llama/llama-3.3-70b-instruct' }, () => {
    assert.equal(openrouterProvider.model, EXPLICIT);
  });
  await withConfig({ aiModelOverride: '', openrouterModel: 'meta-llama/llama-3.3-70b-instruct' }, () => {
    assert.equal(openrouterProvider.model, 'meta-llama/llama-3.3-70b-instruct');
  });
  const explicit = await resolveThroughEngine('openrouter', { aiModelOverride: EXPLICIT });
  assert.equal(explicit.wire, EXPLICIT);
  assert.equal(explicit.recorded.model, EXPLICIT);
  const fallback = await resolveThroughEngine('openrouter', { aiModelOverride: '', openrouterModel: 'meta-llama/llama-3.3-70b-instruct' });
  assert.equal(fallback.wire, 'meta-llama/llama-3.3-70b-instruct');
  assert.ok(!String(fallback.recorded.model).includes('claude'));
});

// --- D. Anthropic unchanged ---------------------------------------------

test('D: Anthropic behavior is unchanged — explicit wins, else the Anthropic default', async () => {
  await withConfig({ aiModel: EXPLICIT }, () => {
    assert.equal(anthropicProvider.model, EXPLICIT);
  });
  await withConfig({ aiModel: 'claude-sonnet-4-6' }, () => {
    assert.equal(anthropicProvider.model, 'claude-sonnet-4-6');
  });
  const { wire, recorded } = await resolveThroughEngine('anthropic', { aiModel: 'claude-sonnet-4-6' });
  assert.equal(wire, 'claude-sonnet-4-6');
  assert.equal(recorded.provider, 'anthropic');
  assert.equal(recorded.model, 'claude-sonnet-4-6');
});

test('D2: one AI_MODEL value applies to whichever provider is selected', async () => {
  // the whole point of the normalization: same env, three providers, one model
  for (const name of ['anthropic', 'gemini', 'openrouter']) {
    const overrides = name === 'anthropic' ? { aiModel: EXPLICIT, aiModelOverride: EXPLICIT } : { aiModelOverride: EXPLICIT };
    const { wire, recorded } = await resolveThroughEngine(name, overrides);
    assert.equal(wire, EXPLICIT, `${name} sends the explicit model`);
    assert.equal(recorded.provider, name);
    assert.equal(recorded.model, EXPLICIT, `${name} records the explicit model`);
  }
});

// --- E. deterministic selection -----------------------------------------

test('E: AI_PROVIDER selection stays deterministic and Gemini is the default', () => {
  assert.equal(config.aiProvider, 'gemini');
  const expected = { anthropic: anthropicProvider, gemini: geminiProvider, openrouter: openrouterProvider };
  for (const [name, provider] of Object.entries(expected)) {
    for (let i = 0; i < 3; i++) assert.equal(getPrimaryProvider(name), provider, `${name} resolves consistently`);
    assert.equal(getPrimaryProvider(name).name, name);
  }
  assert.ok(!listPrimaryProviders().includes('groq'), 'Groq still not a primary provider');
});

// --- F. no provider fallback --------------------------------------------

test('F: a failure on any provider never contacts another provider', async () => {
  for (const [name, host] of [['anthropic', 'api.anthropic.com'], ['gemini', 'generativelanguage'], ['openrouter', 'openrouter.ai']]) {
    const db = openDb(':memory:');
    const hosts = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { hosts.push(String(url)); return new Response('fail', { status: 500 }); };
    try {
      await withConfig({
        mock: false, aiProvider: name, groqApiKey: '',
        anthropicApiKey: 'test-not-real', geminiApiKey: 'test-not-real', openrouterApiKey: 'test-not-real',
      }, () => getRegime('BTCUSDT', SUMMARY, db));
      assert.equal(hosts.length, 1, `${name}: exactly one attempt`);
      assert.ok(hosts[0].includes(host), `${name}: contacted its own endpoint`);
      const others = [['api.anthropic.com', 'anthropic'], ['generativelanguage', 'gemini'], ['openrouter.ai', 'openrouter']]
        .filter(([, n]) => n !== name);
      for (const [otherHost, otherName] of others) {
        assert.ok(!hosts.some((u) => u.includes(otherHost)), `${name} failure did not fall back to ${otherName}`);
      }
      assert.equal(db.prepare('SELECT provider FROM regime_calls ORDER BY id DESC LIMIT 1').get().provider, name);
    } finally {
      globalThis.fetch = savedFetch;
      db.close();
    }
  }
});
