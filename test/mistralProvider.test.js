// Mistral primary-provider tests. No real API key, no real network: every
// request is served by an injected stub.
//
// Load-bearing guarantees: Mistral uses the SAME canonical prompt, the SAME
// parser, the SAME timeout and the SAME safe-fallback path as every other
// provider — a failure never silently becomes another provider's answer, and
// the CONFIGURED model stays the authoritative attribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { mistralProvider } from '../src/ai/providers/mistral.js';
import { getPrimaryProvider, listPrimaryProviders } from '../src/ai/providers/index.js';
import { getRegime, parseRegimeResponse, FALLBACK_REGIME } from '../src/ai/regime.js';
import { runPairRules } from '../src/engine/rules.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2 };
const FAKE_KEY = 'test-key-not-real';
const MODEL = 'mistral-large-latest';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function mistralBody(content, usage = { prompt_tokens: 1500, completion_tokens: 80 }, extra = {}) {
  return {
    id: 'cmpl-abc123',
    object: 'chat.completion',
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
    ...extra,
  };
}

function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(calls.length, url, opts);
  };
  impl.calls = calls;
  return impl;
}

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

async function withMistralEngine({ fetchImpl, model = MODEL, modelOverride = '' }, fn) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await withConfig({
      mock: false, aiProvider: 'mistral', mistralApiKey: FAKE_KEY,
      mistralModel: model, aiModelOverride: modelOverride, groqApiKey: '',
    }, fn);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// --- A. successful response ---------------------------------------------

test('A: a successful response normalizes to the shared provider shape', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(mistralBody(GOOD_JSON, { prompt_tokens: 1512, completion_tokens: 96 })));
  const out = await withConfig({ mistralApiKey: FAKE_KEY, mistralModel: MODEL, aiModelOverride: '' },
    () => mistralProvider.complete({ summary: SUMMARY, fetchImpl }));

  assert.equal(out.provider, 'mistral');
  assert.equal(out.model, MODEL);
  assert.equal(out.text, GOOD_JSON, 'raw model text, untouched');
  assert.deepEqual(out.usage, { inputTokens: 1512, outputTokens: 96 });
});

test('A2: missing usage reads as zero; array-form content is concatenated', async () => {
  const noUsage = recordingFetch(() => jsonResponse({ choices: [{ message: { content: GOOD_JSON } }] }));
  const a = await withConfig({ mistralApiKey: FAKE_KEY }, () => mistralProvider.complete({ summary: SUMMARY, fetchImpl: noUsage }));
  assert.deepEqual(a.usage, { inputTokens: 0, outputTokens: 0 }, 'never invents token counts');

  // newer API versions return content as typed chunks
  const chunked = recordingFetch(() => jsonResponse(mistralBody([{ type: 'text', text: '{"regime":"bull' }, { type: 'text', text: 'ish","confidence":70,"trade_allowed":true,"reasoning":"ok"}' }])));
  const b = await withConfig({ mistralApiKey: FAKE_KEY }, () => mistralProvider.complete({ summary: SUMMARY, fetchImpl: chunked }));
  assert.equal(parseRegimeResponse(b.text).regime, 'bullish');
});

test('A3: hidden reasoning chunks are never extracted', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(mistralBody([
    { type: 'thinking', text: 'SECRET hidden chain of thought' },
    { type: 'text', text: GOOD_JSON },
  ])));
  const out = await withConfig({ mistralApiKey: FAKE_KEY }, () => mistralProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.equal(out.text, GOOD_JSON);
  assert.ok(!JSON.stringify(out).includes('SECRET'), 'hidden reasoning never leaves the provider');
});

// --- B / C. model resolution (Step 5.5 rule) ----------------------------

test('B: an explicit AI_MODEL is used on the wire AND recorded', async () => {
  const db = openDb(':memory:');
  const fetchImpl = recordingFetch(() => jsonResponse(mistralBody(GOOD_JSON)));
  await withMistralEngine({ fetchImpl, modelOverride: 'mistral-explicit-test-id' },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(fetchImpl.calls[0].body.model, 'mistral-explicit-test-id', 'explicit model hits the API');
  assert.equal(db.prepare('SELECT model FROM regime_calls ORDER BY id DESC LIMIT 1').get().model, 'mistral-explicit-test-id');
  db.close();
});

test('C: with AI_MODEL unset, the Mistral default is used and no Anthropic id leaks in', async () => {
  const db = openDb(':memory:');
  const fetchImpl = recordingFetch(() => jsonResponse(mistralBody(GOOD_JSON)));
  await withMistralEngine({ fetchImpl, model: MODEL, modelOverride: '' },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(fetchImpl.calls[0].body.model, MODEL);
  const recorded = db.prepare('SELECT model FROM regime_calls ORDER BY id DESC LIMIT 1').get().model;
  assert.equal(recorded, MODEL);
  assert.ok(!String(recorded).includes('claude'), 'the Anthropic default never leaks into Mistral');
  assert.notEqual(recorded, config.aiModel);
  db.close();
});

// --- D. request structure ------------------------------------------------

test('D: endpoint, auth header, model, canonical prompt, summary, max tokens, no temperature', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(mistralBody(GOOD_JSON)));
  await withConfig({ mistralApiKey: FAKE_KEY, mistralModel: MODEL, aiModelOverride: '', mistralBase: 'https://api.mistral.ai/v1' },
    () => mistralProvider.complete({ summary: SUMMARY, fetchImpl }));

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.body.model, MODEL);
  assert.equal(call.body.max_tokens, config.aiMaxOutputTokens, 'same max-token intent as the other providers');

  // the ONE canonical prompt as the system message, not a copy
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages[0].content, SYSTEM_PROMPT);
  assert.equal(call.body.messages[1].role, 'user');
  assert.equal(call.body.messages[1].content, JSON.stringify(SUMMARY));
  // temperature stays unset, matching every existing provider
  assert.ok(!('temperature' in call.body), 'temperature not sent');
});

// --- E. API key security -------------------------------------------------

test('E: the API key appears only in the auth header — never URL, body, or errors', async () => {
  const fetchImpl = recordingFetch(() => new Response('upstream exploded', { status: 500 }));
  let thrown = null;
  await withConfig({ mistralApiKey: FAKE_KEY }, async () => {
    try { await mistralProvider.complete({ summary: SUMMARY, fetchImpl }); } catch (err) { thrown = err; }
  });
  const call = fetchImpl.calls[0];
  assert.ok(!call.url.includes(FAKE_KEY), 'key never in the URL');
  assert.ok(!String(call.opts.body).includes(FAKE_KEY), 'key never in the body');
  assert.equal(call.opts.headers.authorization, `Bearer ${FAKE_KEY}`, 'key only in the intended header');
  assert.ok(thrown && !String(thrown.message).includes(FAKE_KEY), 'key never in the error message');
});

// --- F / G / H. the EXISTING parser handles Mistral output ---------------

test('F: malformed regime JSON falls back safely via the existing parser', async () => {
  const db = openDb(':memory:');
  const regime = await withMistralEngine({ fetchImpl: async () => jsonResponse(mistralBody('{"regime":"moonish","confidence":"high"}')) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.equal(regime.trade_allowed, false);
  const row = db.prepare('SELECT source, provider FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_parse_fail', 'existing outcome vocabulary unchanged');
  assert.equal(row.provider, 'mistral');
  db.close();
});

test('G: JSON inside a markdown code fence is parsed by the existing parser', async () => {
  const db = openDb(':memory:');
  const fenced = '```json\n' + GOOD_JSON + '\n```';
  const regime = await withMistralEngine({ fetchImpl: async () => jsonResponse(mistralBody(fenced)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.confidence, 66);
  db.close();
});

test('H: <thinking> wrappers behave as before; validation is not weakened', async () => {
  const db = openDb(':memory:');
  const wrapped = `<thinking>\n- momentum down\n</thinking>\n${GOOD_JSON}`;
  const regime = await withMistralEngine({ fetchImpl: async () => jsonResponse(mistralBody(wrapped)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.reasoning, 'Downtrend intact.', 'only the public reasoning field is persisted');
  // strict validation still applies
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72.5,"trade_allowed":true,"reasoning":"x"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"sideways","confidence":70,"trade_allowed":true,"reasoning":"x"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":70,"trade_allowed":"yes","reasoning":"x"}'), null);
  db.close();
});

// --- I. HTTP error -------------------------------------------------------

test('I: an HTTP error falls back safely, creates no trade, contacts no one else', async () => {
  const db = openDb(':memory:');
  const hosts = [];
  const regime = await withMistralEngine({
    fetchImpl: async (url) => { hosts.push(String(url)); return new Response('rate limited', { status: 429 }); },
  }, () => getRegime('BTCUSDT', SUMMARY, db));

  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.ok(hosts.every((u) => u.includes('api.mistral.ai')), 'only Mistral contacted');
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_error');
  assert.equal(row.provider, 'mistral');
  assert.equal(row.model, MODEL, 'the model the failed request was sent with');

  const executor = {
    async openPosition() { throw new Error('order placed off a failed Mistral call'); },
    async closePosition() { throw new Error('order placed off a failed Mistral call'); },
  };
  const actions = await runPairRules({
    pair: 'BTCUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.5, adx4h: 40, regime, executor,
    cfg: { ...config, weekendFilterEnabled: false, volTargetingEnabled: false }, db,
  });
  assert.deepEqual(actions.map((a) => a.type), ['no_entry']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0);
  db.close();
});

test('I2: an empty choices array is a provider error, not a fabricated regime', async () => {
  await assert.rejects(
    () => withConfig({ mistralApiKey: FAKE_KEY }, () => mistralProvider.complete({ summary: SUMMARY, fetchImpl: async () => jsonResponse({ choices: [] }) })),
    /returned no choice/,
  );
});

// --- J. timeout ----------------------------------------------------------

test('J: the shared AbortSignal deadline actually aborts a hanging request', async () => {
  // only settles by rejecting on abort; a missing signal hangs the test
  const fetchImpl = (url, opts = {}) => new Promise((_r, reject) => {
    const { signal } = opts;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await withConfig({ aiRequestTimeoutMs: 60, mistralApiKey: FAKE_KEY }, async () => {
    await assert.rejects(() => mistralProvider.complete({ summary: SUMMARY, fetchImpl }));
  });

  const db = openDb(':memory:');
  await withConfig({ aiRequestTimeoutMs: 60 }, () =>
    withMistralEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db)));
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'AI_TIMEOUT'").get(), 'AI_TIMEOUT logged');
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_timeout');
  assert.equal(row.provider, 'mistral');
  assert.equal(row.model, MODEL, 'attribution survives a timeout');
  db.close();
});

// --- K. missing key ------------------------------------------------------

test('K: a missing MISTRAL_API_KEY is caught pre-flight — no request, no secret in logs', async () => {
  const db = openDb(':memory:');
  let called = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('should never be reached'); };
  try {
    const regime = await withConfig({ mock: false, aiProvider: 'mistral', mistralApiKey: '', groqApiKey: '' },
      () => getRegime('BTCUSDT', SUMMARY, db));
    assert.deepEqual(regime, { ...FALLBACK_REGIME });
    assert.equal(called, false, 'no HTTP request attempted without a key');
    const ev = JSON.parse(db.prepare("SELECT detail FROM events WHERE type = 'AI_ERROR'").get().detail);
    assert.equal(ev.error, 'MISTRAL_API_KEY not set', 'reports the env var NAME only');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM events').all()).includes(FAKE_KEY));
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

// --- L. attribution ------------------------------------------------------

test('L: attribution is correct on success (and source stays the outcome)', async () => {
  const db = openDb(':memory:');
  await withMistralEngine({ fetchImpl: async () => jsonResponse(mistralBody(GOOD_JSON, { prompt_tokens: 1512, completion_tokens: 96 })) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  const row = db.prepare('SELECT source, provider, model, input_tokens, output_tokens FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.provider, 'mistral');
  assert.equal(row.model, MODEL);
  assert.equal(row.source, 'claude', 'source still carries the OUTCOME, not the provider');
  assert.equal(row.input_tokens, 1512);
  assert.equal(row.output_tokens, 96);
  db.close();
});

// --- M. no automatic fallback -------------------------------------------

test('M: a Mistral failure NEVER contacts Anthropic, Gemini or OpenRouter', async () => {
  const db = openDb(':memory:');
  const hosts = [];
  const regime = await withMistralEngine({
    fetchImpl: async (url) => { hosts.push(String(url)); return new Response('server error', { status: 500 }); },
  }, () => getRegime('BTCUSDT', SUMMARY, db));

  assert.deepEqual(regime, { ...FALLBACK_REGIME }, 'safe fallback, not another provider');
  assert.equal(hosts.length, 1, 'exactly one primary-provider attempt');
  assert.ok(hosts[0].includes('api.mistral.ai'));
  for (const other of ['api.anthropic.com', 'generativelanguage', 'openrouter.ai']) {
    assert.ok(!hosts.some((u) => u.includes(other)), `${other} NOT contacted`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, 1);
  db.close();
});

// --- N. deterministic selection -----------------------------------------

test('N: AI_PROVIDER=mistral always selects Mistral; Anthropic stays the default', () => {
  assert.equal(config.aiProvider, 'anthropic', 'shipped default is Anthropic');
  for (let i = 0; i < 5; i++) assert.equal(getPrimaryProvider('mistral'), mistralProvider);
  assert.equal(getPrimaryProvider('mistral').name, 'mistral');
  assert.equal(getPrimaryProvider('Mistral').name, 'mistral', 'case-insensitive, still deterministic');
  const registry = listPrimaryProviders();
  for (const p of ['anthropic', 'gemini', 'openrouter', 'mistral']) assert.ok(registry.includes(p), `${p} registered`);
  assert.ok(!registry.includes('groq'), 'Groq is still NOT a primary provider');
});
