// OpenRouter primary-provider tests. No real API key, no real network: every
// request is served by an injected stub.
//
// Load-bearing guarantees: OpenRouter uses the SAME canonical prompt, the SAME
// parser, the SAME timeout and the SAME safe-fallback path as the other
// providers — a failure never silently becomes a different provider's answer,
// and the CONFIGURED model stays the authoritative attribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { openrouterProvider } from '../src/ai/providers/openrouter.js';
import { getPrimaryProvider, listPrimaryProviders } from '../src/ai/providers/index.js';
import { getRegime, parseRegimeResponse, FALLBACK_REGIME } from '../src/ai/regime.js';
import { runPairRules } from '../src/engine/rules.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2 };
const FAKE_KEY = 'test-key-not-real';
const MODEL = 'meta-llama/llama-3.3-70b-instruct';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// Minimal shape of a real OpenAI-compatible chat completion.
function orBody(text, usage = { prompt_tokens: 1500, completion_tokens: 80 }, extra = {}) {
  return {
    id: 'gen-abc123',
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
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

// Route the engine through OpenRouter with a stubbed global fetch.
async function withOrEngine({ fetchImpl, model = MODEL, modelOverride = '' }, fn) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await withConfig({
      mock: false, aiProvider: 'openrouter', openrouterApiKey: FAKE_KEY,
      openrouterModel: model, aiModelOverride: modelOverride, groqApiKey: '',
    }, fn);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// --- A. successful response ---------------------------------------------

test('A: a successful response normalizes to the shared provider shape', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(orBody(GOOD_JSON, { prompt_tokens: 1512, completion_tokens: 96 })));
  const out = await withConfig({ openrouterApiKey: FAKE_KEY, openrouterModel: MODEL, aiModelOverride: '' },
    () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));

  assert.equal(out.provider, 'openrouter');
  assert.equal(out.model, MODEL);
  assert.equal(out.text, GOOD_JSON, 'raw model text, untouched');
  assert.deepEqual(out.usage, { inputTokens: 1512, outputTokens: 96 });
});

test('A2: missing usage reads as zero — token counts are never invented', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({ choices: [{ message: { content: GOOD_JSON } }], model: MODEL }));
  const out = await withConfig({ openrouterApiKey: FAKE_KEY }, () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.deepEqual(out.usage, { inputTokens: 0, outputTokens: 0 });
});

test('A3: hidden reasoning fields are never extracted', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({
    model: MODEL,
    choices: [{ message: { role: 'assistant', content: GOOD_JSON, reasoning: 'SECRET hidden chain of thought' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }));
  const out = await withConfig({ openrouterApiKey: FAKE_KEY }, () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.equal(out.text, GOOD_JSON);
  assert.ok(!JSON.stringify(out).includes('SECRET'), 'hidden reasoning never leaves the provider');
});

test('A4: the CONFIGURED model stays authoritative even if the response reports another', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(orBody(GOOD_JSON, { prompt_tokens: 1, completion_tokens: 1 }, { model: 'some/other-model-served' })));
  const out = await withConfig({ openrouterApiKey: FAKE_KEY, openrouterModel: MODEL, aiModelOverride: '' },
    () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.equal(out.model, MODEL, 'attribution is never silently rewritten');
  assert.equal(out.reportedModel, 'some/other-model-served', 'the served model is surfaced for verification only');
});

test('A5: AI_MODEL overrides the OpenRouter default when explicitly set', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(orBody(GOOD_JSON)));
  const out = await withConfig({ openrouterApiKey: FAKE_KEY, openrouterModel: MODEL, aiModelOverride: 'vendor/explicit-choice' },
    () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.equal(out.model, 'vendor/explicit-choice');
  assert.equal(fetchImpl.calls[0].body.model, 'vendor/explicit-choice');
});

// --- B. request structure ------------------------------------------------

test('B: endpoint, auth header, model, canonical prompt, summary, max tokens', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(orBody(GOOD_JSON)));
  await withConfig({ openrouterApiKey: FAKE_KEY, openrouterModel: MODEL, aiModelOverride: '', openrouterBase: 'https://openrouter.ai/api/v1' },
    () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.body.model, MODEL);
  assert.equal(call.body.max_tokens, config.aiMaxOutputTokens, 'same max-token intent as the other providers');

  // the ONE canonical prompt as the system message, not a copy
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages[0].content, SYSTEM_PROMPT);
  // identical semantic user content to the other providers
  assert.equal(call.body.messages[1].role, 'user');
  assert.equal(call.body.messages[1].content, JSON.stringify(SUMMARY));
  // temperature stays unset, matching current behavior
  assert.ok(!('temperature' in call.body), 'temperature not sent');
});

// --- C. API key security -------------------------------------------------

test('C: the API key appears only in the auth header — never the URL, body, or errors', async () => {
  const fetchImpl = recordingFetch(() => new Response('upstream exploded', { status: 500 }));
  let thrown = null;
  await withConfig({ openrouterApiKey: FAKE_KEY }, async () => {
    try { await openrouterProvider.complete({ summary: SUMMARY, fetchImpl }); } catch (err) { thrown = err; }
  });

  const call = fetchImpl.calls[0];
  assert.ok(!call.url.includes(FAKE_KEY), 'key never in the URL');
  assert.ok(!String(call.opts.body).includes(FAKE_KEY), 'key never in the body');
  assert.equal(call.opts.headers.authorization, `Bearer ${FAKE_KEY}`, 'key only in the intended header');
  assert.ok(thrown && !String(thrown.message).includes(FAKE_KEY), 'key never in the error message');
});

// --- D/E/F. the EXISTING parser handles OpenRouter formatting ------------

test('D: malformed regime JSON falls back safely via the existing parser', async () => {
  const db = openDb(':memory:');
  const regime = await withOrEngine({ fetchImpl: async () => jsonResponse(orBody('{"regime":"moonish","confidence":"high"}')) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.equal(regime.trade_allowed, false);
  const row = db.prepare('SELECT source, provider FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_parse_fail', 'existing outcome vocabulary unchanged in this step');
  assert.equal(row.provider, 'openrouter');
  db.close();
});

test('E: JSON inside a markdown code fence is parsed by the existing parser', async () => {
  const db = openDb(':memory:');
  const fenced = '```json\n' + GOOD_JSON + '\n```';
  assert.equal(parseRegimeResponse(fenced).regime, 'bearish');
  const regime = await withOrEngine({ fetchImpl: async () => jsonResponse(orBody(fenced)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.confidence, 66);
  db.close();
});

test('F: <thinking> wrappers behave exactly as before, validation not weakened', async () => {
  const db = openDb(':memory:');
  const wrapped = `<thinking>\n- momentum down\n</thinking>\n${GOOD_JSON}`;
  const regime = await withOrEngine({ fetchImpl: async () => jsonResponse(orBody(wrapped)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.reasoning, 'Downtrend intact.', 'only the public reasoning field is persisted');
  // strict validation still applies to OpenRouter output
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72.5,"trade_allowed":true,"reasoning":"x"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":70,"trade_allowed":"yes","reasoning":"x"}'), null);
  db.close();
});

// --- G. HTTP error -------------------------------------------------------

test('G: an HTTP error propagates, falls back safely, and creates no trade', async () => {
  const db = openDb(':memory:');
  const regime = await withOrEngine({ fetchImpl: async () => new Response('rate limited', { status: 429 }) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_error');
  assert.equal(row.provider, 'openrouter');
  assert.equal(row.model, MODEL);

  const executor = {
    async openPosition() { throw new Error('order placed off a failed OpenRouter call'); },
    async closePosition() { throw new Error('order placed off a failed OpenRouter call'); },
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

test('G2: an HTTP-200 error envelope is a provider error, not a fabricated regime', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'upstream provider unavailable', code: 502 } });
  await assert.rejects(
    () => withConfig({ openrouterApiKey: FAKE_KEY }, () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl })),
    /OpenRouter API error: upstream provider unavailable/,
  );
  // and an empty choices array likewise
  await assert.rejects(
    () => withConfig({ openrouterApiKey: FAKE_KEY }, () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl: async () => jsonResponse({ choices: [] }) })),
    /returned no choice/,
  );
});

// --- H. timeout ----------------------------------------------------------

test('H: the shared AbortSignal deadline actually terminates a hanging request', async () => {
  // only settles by rejecting on abort; a missing signal hangs the test
  const fetchImpl = (url, opts = {}) => new Promise((_r, reject) => {
    const { signal } = opts;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await withConfig({ aiRequestTimeoutMs: 60, openrouterApiKey: FAKE_KEY }, async () => {
    await assert.rejects(() => openrouterProvider.complete({ summary: SUMMARY, fetchImpl }));
  });

  const db = openDb(':memory:');
  await withConfig({ aiRequestTimeoutMs: 60 }, () =>
    withOrEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db)));
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'AI_TIMEOUT'").get(), 'AI_TIMEOUT logged');
  assert.equal(db.prepare('SELECT provider FROM regime_calls ORDER BY id DESC LIMIT 1').get().provider, 'openrouter');
  db.close();
});

// --- I. missing key ------------------------------------------------------

test('I: a missing OPENROUTER_API_KEY is caught pre-flight, with no request and no secret in logs', async () => {
  const db = openDb(':memory:');
  let called = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('should never be reached'); };
  try {
    const regime = await withConfig({ mock: false, aiProvider: 'openrouter', openrouterApiKey: '', groqApiKey: '' },
      () => getRegime('BTCUSDT', SUMMARY, db));
    assert.deepEqual(regime, { ...FALLBACK_REGIME });
    assert.equal(called, false, 'no HTTP request attempted without a key');
    const ev = JSON.parse(db.prepare("SELECT detail FROM events WHERE type = 'AI_ERROR'").get().detail);
    assert.equal(ev.error, 'OPENROUTER_API_KEY not set', 'reports the env var NAME only');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM events').all()).includes(FAKE_KEY));
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

// --- J. attribution ------------------------------------------------------

test('J: a successful call persists provider=openrouter and the exact configured model', async () => {
  const db = openDb(':memory:');
  await withOrEngine({ fetchImpl: async () => jsonResponse(orBody(GOOD_JSON, { prompt_tokens: 1512, completion_tokens: 96 })) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  const row = db.prepare('SELECT source, provider, model, input_tokens, output_tokens FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.provider, 'openrouter');
  assert.equal(row.model, MODEL);
  assert.equal(row.source, 'claude', 'source still carries the OUTCOME, not the provider');
  assert.equal(row.input_tokens, 1512);
  assert.equal(row.output_tokens, 96);
  db.close();
});

test('J2: a different configured model id is recorded verbatim', async () => {
  const db = openDb(':memory:');
  await withOrEngine({ fetchImpl: async () => jsonResponse(orBody(GOOD_JSON)), model: 'vendor/some-other-stable-id' },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(db.prepare('SELECT model FROM regime_calls ORDER BY id DESC LIMIT 1').get().model, 'vendor/some-other-stable-id');
  db.close();
});

// --- K. no automatic fallback -------------------------------------------

test('K: OpenRouter failure NEVER contacts Anthropic or Gemini', async () => {
  const db = openDb(':memory:');
  const hosts = [];
  const fetchImpl = async (url) => {
    hosts.push(String(url));
    return new Response('server error', { status: 500 });
  };
  const regime = await withOrEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db));

  assert.deepEqual(regime, { ...FALLBACK_REGIME }, 'safe fallback, not another provider');
  assert.equal(hosts.length, 1, 'exactly one primary-provider attempt');
  assert.ok(hosts[0].includes('openrouter.ai'), `only OpenRouter contacted: ${hosts.join(', ')}`);
  assert.ok(!hosts.some((u) => u.includes('anthropic')), 'Anthropic NOT contacted');
  assert.ok(!hosts.some((u) => u.includes('generativelanguage')), 'Gemini NOT contacted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, 1);
  assert.equal(db.prepare('SELECT provider FROM regime_calls ORDER BY id DESC LIMIT 1').get().provider, 'openrouter');
  db.close();
});

// --- L. deterministic selection -----------------------------------------

test('L: AI_PROVIDER=openrouter always selects OpenRouter; Gemini is the default', () => {
  assert.equal(config.aiProvider, 'gemini', 'shipped default is Gemini');
  for (let i = 0; i < 5; i++) assert.equal(getPrimaryProvider('openrouter'), openrouterProvider);
  assert.equal(getPrimaryProvider('openrouter').name, 'openrouter');
  assert.equal(getPrimaryProvider('OpenRouter').name, 'openrouter', 'case-insensitive, still deterministic');
  const registry = listPrimaryProviders();
  for (const p of ['anthropic', 'gemini', 'openrouter']) assert.ok(registry.includes(p), `${p} registered`);
  assert.ok(!registry.includes('groq'), 'Groq is still NOT a primary provider');
});
