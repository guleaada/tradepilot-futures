// Gemini primary-provider tests. No real API key, no real network: every
// request is served by an injected stub.
//
// The load-bearing guarantees: Gemini goes through the SAME canonical prompt,
// the SAME parser, the SAME timeout and the SAME safe-fallback path as
// Anthropic — and a Gemini failure never silently becomes an Anthropic call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { geminiProvider, GEMINI_API_VERSION } from '../src/ai/providers/gemini.js';
import { getPrimaryProvider, listPrimaryProviders } from '../src/ai/providers/index.js';
import { getRegime, parseRegimeResponse, FALLBACK_REGIME } from '../src/ai/regime.js';
import { runPairRules } from '../src/engine/rules.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2 };

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// Minimal shape of a real generateContent response.
function geminiBody(text, usage = { promptTokenCount: 1500, candidatesTokenCount: 80 }, extra = {}) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: usage,
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

// Route the engine through Gemini with a stubbed global fetch.
async function withGeminiEngine({ fetchImpl, model = 'gemini-2.5-flash' }, fn) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await withConfig({
      mock: false, aiProvider: 'gemini', geminiApiKey: 'test-key-not-real',
      geminiModel: model, groqApiKey: '',
    }, fn);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// --- A. successful response ---------------------------------------------

test('A: a successful Gemini response normalizes to the shared provider shape', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(geminiBody(GOOD_JSON, { promptTokenCount: 1512, candidatesTokenCount: 96 })));
  const out = await withConfig({ geminiApiKey: 'test-key-not-real', geminiModel: 'gemini-2.5-flash' },
    () => geminiProvider.complete({ summary: SUMMARY, fetchImpl }));

  assert.equal(out.provider, 'gemini');
  assert.equal(out.model, 'gemini-2.5-flash');
  assert.equal(out.text, GOOD_JSON, 'raw model text, untouched');
  assert.deepEqual(out.usage, { inputTokens: 1512, outputTokens: 96 });
});

test('A2: usage edge cases — thinking tokens count as output; missing usage reads as 0', async () => {
  const withThoughts = recordingFetch(() => jsonResponse(geminiBody(GOOD_JSON, {
    promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 400,
  })));
  const a = await geminiProvider.complete({ summary: SUMMARY, fetchImpl: withThoughts });
  assert.deepEqual(a.usage, { inputTokens: 1000, outputTokens: 450 }, 'hidden thinking is billed as output');

  const noUsage = recordingFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: GOOD_JSON }] } }] }));
  const b = await geminiProvider.complete({ summary: SUMMARY, fetchImpl: noUsage });
  assert.deepEqual(b.usage, { inputTokens: 0, outputTokens: 0 }, 'never invents token counts');
});

test('A3: hidden reasoning parts are never extracted or persisted', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({
    candidates: [{ content: { parts: [
      { text: 'SECRET internal chain of thought', thought: true },
      { text: GOOD_JSON },
    ] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }));
  const out = await geminiProvider.complete({ summary: SUMMARY, fetchImpl });
  assert.equal(out.text, GOOD_JSON);
  assert.ok(!out.text.includes('SECRET'), 'thought-flagged parts are dropped');
});

// --- B. request structure ------------------------------------------------

test('B: endpoint, header auth, model, canonical prompt and market summary', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(geminiBody(GOOD_JSON)));
  await withConfig({ geminiApiKey: 'test-key-not-real', geminiModel: 'gemini-2.5-flash', geminiBase: 'https://generativelanguage.googleapis.com' },
    () => geminiProvider.complete({ summary: SUMMARY, fetchImpl }));

  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/gemini-2.5-flash:generateContent`);
  assert.equal(call.opts.method, 'POST');
  // key travels in a header, never in the URL
  assert.equal(call.opts.headers['x-goog-api-key'], 'test-key-not-real');
  assert.ok(!call.url.includes('test-key-not-real'), 'API key never appears in the URL');

  // the ONE canonical prompt, not a copy
  assert.equal(call.body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  // identical semantic user content to the Anthropic path
  assert.equal(call.body.contents[0].role, 'user');
  assert.equal(call.body.contents[0].parts[0].text, JSON.stringify(SUMMARY));
  assert.equal(call.body.generationConfig.maxOutputTokens, config.aiMaxOutputTokens);
  // no thinkingConfig unless explicitly configured
  assert.equal(call.body.generationConfig.thinkingConfig, undefined);
});

test('B2: thinkingConfig is sent only when explicitly configured', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(geminiBody(GOOD_JSON)));
  await withConfig({ geminiThinkingBudget: 0, geminiApiKey: 'test-key-not-real' },
    () => geminiProvider.complete({ summary: SUMMARY, fetchImpl }));
  assert.deepEqual(fetchImpl.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

// --- C/D/E. the EXISTING parser handles Gemini formatting ----------------

test('C: malformed regime JSON from Gemini falls back safely via the existing parser', async () => {
  const db = openDb(':memory:');
  const fetchImpl = async () => jsonResponse(geminiBody('{"regime":"moonish","confidence":"very high"}'));
  const regime = await withGeminiEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.equal(regime.trade_allowed, false);
  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_parse_fail', 'existing outcome vocabulary unchanged in this step');
  assert.equal(row.provider, 'gemini', 'provider column disambiguates who actually failed');
  db.close();
});

test('D: JSON inside a markdown code fence is parsed by the existing parser', async () => {
  const db = openDb(':memory:');
  const fenced = '```json\n' + GOOD_JSON + '\n```';
  // parser-level
  assert.equal(parseRegimeResponse(fenced).regime, 'bearish');
  // end-to-end through Gemini
  const regime = await withGeminiEngine({ fetchImpl: async () => jsonResponse(geminiBody(fenced)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.confidence, 66);
  db.close();
});

test('E: <thinking> wrappers and surrounding prose behave exactly as before', async () => {
  const db = openDb(':memory:');
  const wrapped = `<thinking>\n- momentum down\n- RSI mid-band\n</thinking>\n${GOOD_JSON}`;
  const regime = await withGeminiEngine({ fetchImpl: async () => jsonResponse(geminiBody(wrapped)) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(regime.regime, 'bearish');
  assert.equal(regime.reasoning, 'Downtrend intact.', 'only the public reasoning field is kept');
  const row = db.prepare('SELECT reasoning FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.reasoning, 'Downtrend intact.');
  // validation is NOT weakened for Gemini
  assert.equal(parseRegimeResponse(`<thinking>x</thinking>{"regime":"bullish","confidence":72.5,"trade_allowed":true,"reasoning":"x"}`), null);
  db.close();
});

// --- F. HTTP error -------------------------------------------------------

test('F: an HTTP error propagates, falls back safely, and creates no trade', async () => {
  const db = openDb(':memory:');
  const regime = await withGeminiEngine({ fetchImpl: async () => new Response('quota exceeded', { status: 429 }) },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });

  const row = db.prepare('SELECT source, provider, model FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.source, 'claude_error');
  assert.equal(row.provider, 'gemini');
  assert.equal(row.model, 'gemini-2.5-flash', 'the model the failed request was sent with');

  // and the failed regime cannot open a position
  const executor = {
    async openPosition() { throw new Error('order placed off a failed Gemini call'); },
    async closePosition() { throw new Error('order placed off a failed Gemini call'); },
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

test('F2: a safety-blocked response is a provider error, not a fabricated regime', async () => {
  const fetchImpl = async () => jsonResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });
  await assert.rejects(
    () => withConfig({ geminiApiKey: 'test-key-not-real' }, () => geminiProvider.complete({ summary: SUMMARY, fetchImpl })),
    /no candidate \(SAFETY\)/,
  );
});

// --- G. timeout ----------------------------------------------------------

test('G: the shared AbortSignal deadline is wired into the Gemini request', async () => {
  // only settles by rejecting on abort; a missing signal hangs the test
  const fetchImpl = (url, opts = {}) => new Promise((_r, reject) => {
    const { signal } = opts;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await withConfig({ aiRequestTimeoutMs: 60, geminiApiKey: 'test-key-not-real' }, async () => {
    await assert.rejects(() => geminiProvider.complete({ summary: SUMMARY, fetchImpl }));
  });

  // end-to-end: timeout classification and safe fallback still apply
  const db = openDb(':memory:');
  await withConfig({ aiRequestTimeoutMs: 60 }, () =>
    withGeminiEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db)));
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'AI_TIMEOUT'").get(), 'AI_TIMEOUT logged');
  assert.equal(db.prepare('SELECT provider FROM regime_calls ORDER BY id DESC LIMIT 1').get().provider, 'gemini');
  db.close();
});

// --- H. missing API key --------------------------------------------------

test('H: a missing GEMINI_API_KEY is caught pre-flight, with no request and no key in logs', async () => {
  const db = openDb(':memory:');
  let called = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('should never be reached'); };
  try {
    const regime = await withConfig({ mock: false, aiProvider: 'gemini', geminiApiKey: '', groqApiKey: '' },
      () => getRegime('BTCUSDT', SUMMARY, db));
    assert.deepEqual(regime, { ...FALLBACK_REGIME });
    assert.equal(called, false, 'no HTTP request attempted without a key');
    const ev = JSON.parse(db.prepare("SELECT detail FROM events WHERE type = 'AI_ERROR'").get().detail);
    assert.equal(ev.error, 'GEMINI_API_KEY not set', 'reports the env var NAME only');
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

// --- I. attribution ------------------------------------------------------

test('I: a successful Gemini call persists provider=gemini and the exact model', async () => {
  const db = openDb(':memory:');
  await withGeminiEngine({ fetchImpl: async () => jsonResponse(geminiBody(GOOD_JSON, { promptTokenCount: 1512, candidatesTokenCount: 96 })), model: 'gemini-2.5-flash' },
    () => getRegime('BTCUSDT', SUMMARY, db));
  const row = db.prepare('SELECT source, provider, model, input_tokens, output_tokens FROM regime_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.provider, 'gemini');
  assert.equal(row.model, 'gemini-2.5-flash');
  assert.equal(row.source, 'claude', 'source still carries the OUTCOME, not the provider');
  assert.equal(row.input_tokens, 1512);
  assert.equal(row.output_tokens, 96);
  db.close();
});

test('I2: attribution follows the configured model id, not a hard-coded constant', async () => {
  const db = openDb(':memory:');
  await withGeminiEngine({ fetchImpl: async () => jsonResponse(geminiBody(GOOD_JSON)), model: 'gemini-some-future-id' },
    () => getRegime('BTCUSDT', SUMMARY, db));
  assert.equal(db.prepare('SELECT model FROM regime_calls ORDER BY id DESC LIMIT 1').get().model, 'gemini-some-future-id');
  db.close();
});

// --- J. no automatic fallback -------------------------------------------

test('J: Gemini failure NEVER falls through to Anthropic', async () => {
  const db = openDb(':memory:');
  const hosts = [];
  const fetchImpl = async (url) => {
    hosts.push(String(url));
    return new Response('server error', { status: 500 });
  };
  const regime = await withGeminiEngine({ fetchImpl }, () => getRegime('BTCUSDT', SUMMARY, db));

  assert.deepEqual(regime, { ...FALLBACK_REGIME }, 'safe fallback, not a second provider');
  assert.ok(hosts.every((u) => u.includes('generativelanguage')), `only Gemini was contacted: ${hosts.join(', ')}`);
  assert.ok(!hosts.some((u) => u.includes('anthropic')), 'Anthropic was NOT called');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM regime_calls').get().n, 1, 'exactly one attempt recorded');
  assert.equal(db.prepare('SELECT provider FROM regime_calls ORDER BY id DESC LIMIT 1').get().provider, 'gemini');
  db.close();
});

test('J2: provider selection is deterministic and Anthropic remains the default', () => {
  assert.equal(config.aiProvider, 'anthropic', 'shipped default is Anthropic');
  assert.equal(getPrimaryProvider('gemini'), geminiProvider);
  assert.equal(getPrimaryProvider('gemini').name, 'gemini');
  assert.ok(listPrimaryProviders().includes('gemini'));
  // same input -> same provider, every time
  assert.equal(getPrimaryProvider('gemini'), getPrimaryProvider('gemini'));
});
