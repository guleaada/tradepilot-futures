// Provider-abstraction contract tests.
//
// The regime engine must depend on the normalized interface
//   { provider, model, text, usage: { inputTokens, outputTokens } }
// and never on Anthropic specifics. These lock the boundary: the provider does
// HTTP/auth/extraction only, parseRegimeResponse() owns regime parsing, and
// there is exactly ONE canonical SYSTEM_PROMPT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { anthropicProvider, ANTHROPIC_VERSION } from '../src/ai/providers/anthropic.js';
import { getPrimaryProvider, listPrimaryProviders } from '../src/ai/providers/index.js';
import { getRegime, parseRegimeResponse, FALLBACK_REGIME } from '../src/ai/regime.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function claudeBody(text, usage = { input_tokens: 123, output_tokens: 45 }) {
  return { content: [{ type: 'text', text }], usage };
}

// Records every request so tests can assert on URL/headers/body.
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
  try {
    return await fn();
  } finally {
    Object.assign(config, saved);
  }
}

// --- A. provider success ------------------------------------------------

test('A: Anthropic provider returns the normalized shape with real usage and model', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(claudeBody(GOOD_JSON, { input_tokens: 1234, output_tokens: 56 })));
  const out = await withConfig({ aiModel: 'claude-sonnet-4-6', anthropicApiKey: 'sk-ant-test', anthropicBase: 'https://api.anthropic.com' },
    () => anthropicProvider.complete({ summary: { pair: 'BTCUSDT' }, fetchImpl }));

  assert.equal(out.provider, 'anthropic');
  assert.equal(out.model, 'claude-sonnet-4-6');
  assert.equal(out.text, GOOD_JSON, 'raw model text passed through untouched');
  assert.deepEqual(out.usage, { inputTokens: 1234, outputTokens: 56 });

  // request shape is byte-identical to the pre-refactor inline call
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(call.opts.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.body.model, 'claude-sonnet-4-6');
  assert.equal(call.body.max_tokens, config.aiMaxOutputTokens);
  assert.equal(call.body.messages[0].role, 'user');
  assert.ok(!('temperature' in call.body), 'temperature stays unset, as before');
});

test('A2: multi-block responses concatenate only text blocks; missing usage reads as zero', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse({
    content: [{ type: 'text', text: 'part1 ' }, { type: 'thinking', text: 'IGNORED' }, { type: 'text', text: 'part2' }],
  }));
  const out = await anthropicProvider.complete({ summary: {}, fetchImpl });
  assert.equal(out.text, 'part1 part2');
  assert.deepEqual(out.usage, { inputTokens: 0, outputTokens: 0 });
});

// --- B. API failure -----------------------------------------------------

test('B: a non-2xx throws the existing error shape and reaches the safe fallback', async () => {
  const fetchImpl = recordingFetch(() => new Response('rate limited', { status: 429 }));
  await assert.rejects(
    () => anthropicProvider.complete({ summary: {}, fetchImpl }),
    /Anthropic API 429: rate limited/,
  );

  // and end-to-end through the engine: safe fallback, existing claude_error path
  const db = openDb(':memory:');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    const regime = await withConfig({ mock: false, anthropicApiKey: 'sk-ant-test' },
      () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
    assert.deepEqual(regime, { ...FALLBACK_REGIME });
    assert.equal(regime.trade_allowed, false);
    assert.equal(db.prepare('SELECT source FROM regime_calls ORDER BY id DESC LIMIT 1').get().source, 'claude_error');
    assert.ok(db.prepare("SELECT id FROM events WHERE type = 'AI_ERROR'").get());
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

// --- C. timeout (Step 1 behavior intact through the abstraction) ---------

test('C: the Step-1 deadline is still wired inside the provider', async () => {
  // only settles by rejecting when the signal aborts; no signal -> hangs -> fail
  const fetchImpl = (url, opts = {}) => new Promise((_r, reject) => {
    const { signal } = opts;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await withConfig({ aiRequestTimeoutMs: 60 }, async () => {
    await assert.rejects(() => anthropicProvider.complete({ summary: {}, fetchImpl }));
  });
});

// --- D. shared canonical prompt -----------------------------------------

test('D: the provider sends the canonical SYSTEM_PROMPT verbatim', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(claudeBody(GOOD_JSON)));
  await anthropicProvider.complete({ summary: {}, fetchImpl });
  assert.equal(fetchImpl.calls[0].body.system, SYSTEM_PROMPT, 'exact same prompt object, not a copy');
});

test('D2: exactly one definition of the prompt exists in src/', () => {
  // Coupled to the prompt's opening line on purpose: this asserts the prompt
  // has exactly ONE definition in src/. Update the marker when the prompt text
  // changes (PROMPT_VERSION must be bumped too); never relax the assertion.
  const marker = "You are TradePilot's market-regime evaluator";
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes(marker)) hits.push(full);
    }
  };
  walk('src');
  assert.deepEqual(hits, ['src/ai/prompt.js'], `prompt must live in exactly one file, found: ${hits.join(', ')}`);
});

// --- E. parser separation -----------------------------------------------

test('E: the provider does NOT parse regime JSON — it returns raw text', async () => {
  const raw = `<thinking>\n- momentum up\n</thinking>\n${GOOD_JSON}`;
  const fetchImpl = recordingFetch(() => jsonResponse(claudeBody(raw)));
  const out = await anthropicProvider.complete({ summary: {}, fetchImpl });

  // raw text comes back with <thinking> intact and NO regime fields on it
  assert.equal(out.text, raw);
  assert.equal(out.regime, undefined);
  assert.equal(out.confidence, undefined);
  // parsing is the engine parser's job, and it still works on that text
  assert.deepEqual(parseRegimeResponse(out.text), {
    regime: 'bearish', confidence: 66, trade_allowed: true, reasoning: 'Downtrend intact.',
  });
});

// --- F. Groq stays a separate subsystem ---------------------------------

test('F: Groq is NOT a primary provider and its change detector stays independent', async () => {
  // The registry grows as providers are added, so assert the INVARIANT rather
  // than an exact list: Groq must never appear in it (it is a binary change
  // detector, not a regime provider) and anthropic must always be there.
  assert.ok(listPrimaryProviders().includes('anthropic'));
  assert.equal(getPrimaryProvider('anthropic'), anthropicProvider);
  assert.ok(!listPrimaryProviders().includes('groq'), 'Groq is not a primary provider');
  assert.throws(() => getPrimaryProvider('groq'), /unknown AI provider "groq"/);

  // The detector's short-circuit still works: Groq says "no" -> prior regime
  // reused, primary provider never called.
  const db = openDb(':memory:');
  const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO regime_calls (ts, pair, regime, confidence, trade_allowed, reasoning, raw_json, summary_json, input_tokens, output_tokens, est_cost, source)
     VALUES (?, 'BTCUSDT', 'bullish', 70, 1, 'prior', '{}', '{"pair":"BTCUSDT"}', 0, 0, 0, 'claude')`,
  ).run(fiveHoursAgo);

  const seen = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('groq')) return jsonResponse({ choices: [{ message: { content: 'no' } }] });
    throw new Error('primary provider must NOT be called when Groq says nothing changed');
  };
  try {
    const regime = await withConfig({ mock: false, anthropicApiKey: 'sk-ant-test', groqApiKey: 'gsk-test' },
      () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
    assert.equal(regime.regime, 'bullish', 'prior regime reused');
    assert.ok(seen.some((u) => u.includes('groq')), 'Groq detector ran');
    assert.ok(!seen.some((u) => u.includes('/v1/messages')), 'primary provider skipped');
    assert.ok(db.prepare("SELECT id FROM events WHERE type = 'GROQ_SKIPPED'").get());
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

// --- G. truncation retry through the abstraction ------------------------

test('G: truncated thinking retries through the provider with doubled max_tokens', async () => {
  const db = openDb(':memory:');
  const bodies = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? jsonResponse(claudeBody('<thinking>\n- cut off mid thou', { input_tokens: 100, output_tokens: 1024 }))
      : jsonResponse(claudeBody(GOOD_JSON, { input_tokens: 100, output_tokens: 60 }));
  };
  try {
    const regime = await withConfig({ mock: false, anthropicApiKey: 'sk-ant-test', groqApiKey: '' },
      () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));

    assert.equal(bodies.length, 2, 'retried exactly once');
    assert.equal(bodies[0].max_tokens, config.aiMaxOutputTokens);
    assert.equal(bodies[1].max_tokens, config.aiMaxOutputTokens * 2, 'retry doubles the ceiling');
    assert.equal(bodies[1].system, SYSTEM_PROMPT, 'retry uses the same canonical prompt');
    assert.equal(regime.regime, 'bearish');
    assert.ok(db.prepare("SELECT id FROM events WHERE type = 'REGIME_RETRY'").get());

    // usage/cost accounting survived the camelCase normalization
    const row = db.prepare('SELECT input_tokens, output_tokens, source FROM regime_calls ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.source, 'claude');
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 60);
  } finally {
    globalThis.fetch = savedFetch;
    db.close();
  }
});

test('G2: an unknown configured provider degrades to the safe fallback, never a crash', async () => {
  const db = openDb(':memory:');
  const regime = await withConfig({ mock: false, anthropicApiKey: 'sk-ant-test', aiProvider: 'not-a-provider' },
    () => getRegime('BTCUSDT', { pair: 'BTCUSDT' }, db));
  assert.deepEqual(regime, { ...FALLBACK_REGIME });
  assert.equal(regime.trade_allowed, false);
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'AI_ERROR'").get());
  db.close();
});
