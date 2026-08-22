// Shadow-mode evaluation tests.
//
// The single most important property under test: a shadow provider — however
// confident, however broken — can NEVER influence a regime, an entry, an exit,
// sizing, or an order. Everything else here supports that claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  canonicalJson, computeSnapshotId, getShadowCalls, resolveShadowProviders, runShadowEvaluation,
} from '../src/ai/shadow.js';
import { runPairRules } from '../src/engine/rules.js';

const GOOD_JSON = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"Downtrend intact."}';
const SUMMARY = { pair: 'BTCUSDT', price: 63000, rsi14_1h: 48.2, ema_4h: { e50: 62000 } };

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

// A fake provider implementing the real interface, with a call counter.
function fakeProvider(name, behavior = {}) {
  const p = {
    name,
    keyEnvVar: `${name.toUpperCase()}_API_KEY`,
    isConfigured: () => behavior.configured !== false,
    get model() { return behavior.model ?? `${name}-test-model`; },
    calls: [],
    async complete({ summary }) {
      p.calls.push(summary);
      if (behavior.hang) return new Promise(() => {}); // never settles
      if (behavior.throws) throw behavior.throws;
      return {
        provider: name,
        model: behavior.model ?? `${name}-test-model`,
        text: behavior.text ?? GOOD_JSON,
        usage: behavior.usage ?? { inputTokens: 100, outputTokens: 20 },
        ...(behavior.reportedModel ? { reportedModel: behavior.reportedModel } : {}),
      };
    },
  };
  return p;
}

// Run shadow with explicit fake providers via the module's test seam.
async function runShadowEvaluationWithProviders(providers, { db, pair, summary }) {
  return runShadowEvaluation({ pair, summary, db, providers });
}

// --- A / B / R. the feature flag ----------------------------------------

test('A + R: disabled by default — a fresh config makes ZERO shadow calls', async () => {
  const db = openDb(':memory:');
  const gem = fakeProvider('gemini');
  assert.equal(config.aiShadowMode, false, 'shipped default is OFF');

  await withConfig({ aiShadowMode: false, aiShadowProviders: ['gemini'] }, async () => {
    assert.deepEqual(resolveShadowProviders(config).providers, []);
    const out = await runShadowEvaluation({ pair: 'BTCUSDT', summary: SUMMARY, db });
    assert.deepEqual(out, { snapshotId: null, results: [] });
  });
  assert.equal(gem.calls.length, 0, 'no provider was contacted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_shadow_calls').get().n, 0, 'no rows written');
  db.close();
});

test('B: enabled — configured shadow providers are called and persisted', async () => {
  const db = openDb(':memory:');
  const gem = fakeProvider('gemini');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini'] },
    () => runShadowEvaluationWithProviders([gem], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  assert.equal(gem.calls.length, 1);
  const rows = getShadowCalls(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'gemini');
  assert.equal(rows[0].status, 'success');
  db.close();
});

// --- C. same input -------------------------------------------------------

test('C: every shadow provider receives the byte-identical market summary', async () => {
  const db = openDb(':memory:');
  const a = fakeProvider('gemini');
  const b = fakeProvider('mistral');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral'] },
    () => runShadowEvaluationWithProviders([a, b], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  assert.equal(a.calls[0], SUMMARY, 'same object reference — no per-provider mutation');
  assert.equal(b.calls[0], SUMMARY);
  assert.equal(JSON.stringify(a.calls[0]), JSON.stringify(b.calls[0]));
  db.close();
});

// --- D / E. snapshot identity -------------------------------------------

test('D: identical market state yields an identical snapshot_id across providers', async () => {
  const db = openDb(':memory:');
  const a = fakeProvider('gemini');
  const b = fakeProvider('mistral');
  const out = await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral'] },
    () => runShadowEvaluationWithProviders([a, b], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  const ids = new Set(getShadowCalls(db).map((r) => r.snapshot_id));
  assert.equal(ids.size, 1, 'one snapshot, both providers');
  assert.equal([...ids][0], out.snapshotId);
  // key order must not matter — the id is semantic
  assert.equal(
    computeSnapshotId({ a: 1, b: { c: 2, d: 3 } }),
    computeSnapshotId({ b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.match(out.snapshotId, /^[0-9a-f]{64}$/, 'sha-256 hex');
  db.close();
});

test('E: changing one input value changes the snapshot_id', () => {
  const base = computeSnapshotId(SUMMARY);
  assert.notEqual(base, computeSnapshotId({ ...SUMMARY, price: 63000.01 }));
  assert.notEqual(base, computeSnapshotId({ ...SUMMARY, rsi14_1h: 48.3 }));
  assert.notEqual(base, computeSnapshotId({ ...SUMMARY, ema_4h: { e50: 62000.5 } }));
  assert.equal(base, computeSnapshotId({ ...SUMMARY }), 'same values -> same id');
  // null/undefined are canonicalized, not crashed on
  assert.equal(canonicalJson({ x: undefined }), '{"x":null}');
});

// --- F / G / H. failure isolation ---------------------------------------

test('F: a throwing shadow provider is isolated — others succeed, nothing escapes', async () => {
  const db = openDb(':memory:');
  const boom = fakeProvider('gemini', { throws: new Error('provider exploded') });
  const ok = fakeProvider('mistral');
  const out = await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral'] },
    () => runShadowEvaluationWithProviders([boom, ok], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  assert.equal(out.results.length, 2, 'the run completed — no exception escaped');
  const byProvider = Object.fromEntries(getShadowCalls(db).map((r) => [r.provider, r]));
  assert.equal(byProvider.gemini.status, 'error');
  assert.match(byProvider.gemini.error, /provider exploded/);
  assert.equal(byProvider.gemini.regime, null, 'no invented regime');
  assert.equal(byProvider.mistral.status, 'success', 'the healthy provider is unaffected');
  db.close();
});

test('G: a hanging shadow provider times out and does not stall the others', async () => {
  const db = openDb(':memory:');
  // A provider that respects the shared deadline the way real ones do.
  const hanging = {
    name: 'gemini', keyEnvVar: 'GEMINI_API_KEY', isConfigured: () => true,
    get model() { return 'gemini-test-model'; },
    async complete() {
      await new Promise((_r, reject) => {
        const signal = AbortSignal.timeout(config.aiRequestTimeoutMs);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const ok = fakeProvider('mistral');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral'], aiRequestTimeoutMs: 60 },
    () => runShadowEvaluationWithProviders([hanging, ok], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  const byProvider = Object.fromEntries(getShadowCalls(db).map((r) => [r.provider, r]));
  assert.equal(byProvider.gemini.status, 'timeout', 'classified as a timeout, not a generic error');
  assert.equal(byProvider.mistral.status, 'success', 'concurrent provider unaffected');
  db.close();
});

test('H: malformed shadow output is parse_failure with NULL regime fields', async () => {
  const db = openDb(':memory:');
  const bad = fakeProvider('gemini', { text: '{"regime":"moonish","confidence":"very"}' });
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini'] },
    () => runShadowEvaluationWithProviders([bad], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  const row = getShadowCalls(db)[0];
  assert.equal(row.status, 'parse_failure');
  assert.equal(row.regime, null);
  assert.equal(row.confidence, null);
  assert.equal(row.trade_allowed, null, 'nothing invented on a parse failure');
  assert.equal(row.raw_response, '{"regime":"moonish","confidence":"very"}', 'raw text kept for analysis');
  db.close();
});

// --- I + §14/§21. NO TRADING SIDE EFFECTS (the critical property) --------

test('I: a screaming-bullish shadow response cannot open a trade or touch an executor', async () => {
  const db = openDb(':memory:');
  const executor = {
    calls: 0,
    async openPosition() { this.calls++; throw new Error('shadow reached the executor'); },
    async closePosition() { this.calls++; throw new Error('shadow reached the executor'); },
  };
  const shouty = fakeProvider('gemini', {
    text: '{"regime":"bullish","confidence":100,"trade_allowed":true,"reasoning":"MAX CONVICTION BUY."}',
  });

  const out = await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini'] },
    () => runShadowEvaluationWithProviders([shouty], { db, pair: 'BTCUSDT', summary: SUMMARY }));

  // the shadow row exists...
  const row = getShadowCalls(db)[0];
  assert.equal(row.status, 'success');
  assert.equal(row.regime, 'bullish');
  assert.equal(row.confidence, 100);
  assert.equal(row.trade_allowed, 1);
  // ...and changed nothing that trades
  assert.equal(executor.calls, 0, 'executor never invoked');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 0, 'no trades');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0, 'no orders');
  // the returned value carries nothing the engine consumes
  assert.deepEqual(Object.keys(out).sort(), ['results', 'snapshotId']);

  // and the trading engine, given the PRIMARY chop regime, still refuses —
  // the shadow's 100-confidence bullish call is invisible to it.
  const primaryChop = { regime: 'chop', confidence: 0, trade_allowed: false, reasoning: 'parse_failure' };
  const actions = await runPairRules({
    pair: 'BTCUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.5, adx4h: 40, regime: primaryChop, executor,
    cfg: { ...config, weekendFilterEnabled: false, volTargetingEnabled: false }, db,
  });
  assert.deepEqual(actions.map((a) => a.type), ['no_entry']);
  assert.equal(actions[0].reason, 'no_directional_regime');
  assert.equal(executor.calls, 0);
  db.close();
});

test('§21 call-graph audit: shadow.js has no path to the trading engine', () => {
  const src = fs.readFileSync('src/ai/shadow.js', 'utf8');
  const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!spec.includes('engine/'), `shadow.js must not import from engine/: ${spec}`);
  }
  // Scan CODE, not prose: the file's comments legitimately discuss the
  // executor in order to state that it never touches one.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/\bexecutor\b/.test(code), 'shadow.js never references an executor in code');
  assert.ok(!/runPairRules|openTrade|closeTrade|partialCloseTrade|openPosition|closePosition|placeOrder|setCash/.test(code),
    'shadow.js never references order/position/wallet functions in code');
  // and it is a leaf: only the orchestrator may import it
  const importers = ['src/index.js', 'src/engine/rules.js', 'src/engine/portfolio.js', 'src/ai/regime.js']
    .filter((f) => fs.existsSync(f) && /from '.*shadow\.js'/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(importers, ['src/index.js'], 'only the cycle orchestrator imports shadow');
});

// --- J / K / L / M. record contents --------------------------------------

test('J + K + L + M: attribution, latency, raw text — and no secrets or hidden reasoning', async () => {
  const db = openDb(':memory:');
  const p = fakeProvider('mistral', {
    model: 'mistral-large-latest', reportedModel: 'mistral-large-2411',
    usage: { inputTokens: 1512, outputTokens: 96 },
  });
  const out = await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['mistral'] },
    () => runShadowEvaluationWithProviders([p], { db, pair: 'ETHUSDT', summary: SUMMARY }));

  const row = getShadowCalls(db)[0];
  // J: attribution
  assert.equal(row.provider, 'mistral');
  assert.equal(row.model, 'mistral-large-latest', 'configured model is authoritative');
  assert.equal(row.reported_model, 'mistral-large-2411', 'alias resolution kept as metadata');
  assert.equal(row.snapshot_id, out.snapshotId);
  assert.equal(row.pair, 'ETHUSDT');
  // K: latency
  assert.ok(typeof row.latency_ms === 'number' && row.latency_ms >= 0, `latency recorded: ${row.latency_ms}`);
  // cost inputs for later analysis
  assert.equal(row.input_tokens, 1512);
  assert.equal(row.output_tokens, 96);
  // L: public raw text stored
  assert.equal(row.raw_response, GOOD_JSON);
  // M: nothing secret or hidden anywhere in the row
  const dump = JSON.stringify(row);
  for (const f of ['sk-ant-', 'AIza', 'Bearer ', 'authorization', 'x-api-key', 'SECRET']) {
    assert.ok(!dump.includes(f), `row must not contain ${f}`);
  }
  db.close();
});

test('M2: a missing key is recorded as an error without ever naming the secret', async () => {
  const db = openDb(':memory:');
  const unconfigured = fakeProvider('gemini', { configured: false });
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini'] },
    () => runShadowEvaluationWithProviders([unconfigured], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  const row = getShadowCalls(db)[0];
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'GEMINI_API_KEY not set', 'env var NAME only');
  assert.equal(unconfigured.calls.length, 0, 'no HTTP request attempted');
  db.close();
});

// --- N / O / P / Q. provider-list resolution -----------------------------

test('N: multiple shadow providers run independently and concurrently', async () => {
  const db = openDb(':memory:');
  const a = fakeProvider('gemini');
  const b = fakeProvider('mistral');
  const c = fakeProvider('openrouter');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral', 'openrouter'] },
    () => runShadowEvaluationWithProviders([a, b, c], { db, pair: 'BTCUSDT', summary: SUMMARY }));
  assert.deepEqual(getShadowCalls(db).map((r) => r.provider).sort(), ['gemini', 'mistral', 'openrouter']);
  for (const p of [a, b, c]) assert.equal(p.calls.length, 1, `${p.name} called exactly once`);
  db.close();
});

test('O + P + Q: duplicates deduped, unknown names skipped, primary never shadowed', async () => {
  // O: duplicates
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'gemini', 'mistral'] }, () => {
    assert.deepEqual(resolveShadowProviders(config).providers.map((p) => p.name), ['gemini', 'mistral']);
  });
  // P: unknown provider is reported, not fatal
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'does-not-exist', 'mistral'] }, () => {
    const { providers, unknown } = resolveShadowProviders(config);
    assert.deepEqual(providers.map((p) => p.name), ['gemini', 'mistral']);
    assert.deepEqual(unknown, ['does-not-exist']);
  });
  // Q: the live provider is removed from the shadow set
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['anthropic', 'gemini'] }, () => {
    assert.deepEqual(resolveShadowProviders(config).providers.map((p) => p.name), ['gemini'],
      'the primary is never called twice');
  });
  // whitespace/case tolerated
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: [' Gemini ', 'MISTRAL'] }, () => {
    assert.deepEqual(resolveShadowProviders(config).providers.map((p) => p.name), ['gemini', 'mistral']);
  });
});

test('P2: an unknown shadow provider is logged and never stops the run', async () => {
  const db = openDb(':memory:');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['does-not-exist'] },
    () => runShadowEvaluation({ pair: 'BTCUSDT', summary: SUMMARY, db }));
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'SHADOW_PROVIDER_UNKNOWN'").get();
  assert.ok(ev, 'reported as an event');
  assert.deepEqual(JSON.parse(ev.detail).unknown, ['does-not-exist']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_shadow_calls').get().n, 0);
  db.close();
});

// --- pair isolation (§15) ------------------------------------------------

test('§15: one provider failing on BTCUSDT does not affect ETHUSDT evaluation', async () => {
  const db = openDb(':memory:');
  const flaky = fakeProvider('gemini', { throws: new Error('btc blew up') });
  const ok = fakeProvider('mistral');
  await withConfig({ aiShadowMode: true, aiProvider: 'anthropic', aiShadowProviders: ['gemini', 'mistral'] }, async () => {
    await runShadowEvaluationWithProviders([flaky, ok], { db, pair: 'BTCUSDT', summary: SUMMARY });
    const healthy = fakeProvider('gemini');
    await runShadowEvaluationWithProviders([healthy, fakeProvider('mistral')], {
      db, pair: 'ETHUSDT', summary: { ...SUMMARY, pair: 'ETHUSDT' },
    });
  });
  const eth = getShadowCalls(db, { pair: 'ETHUSDT' });
  assert.equal(eth.length, 2);
  assert.ok(eth.every((r) => r.status === 'success'), 'ETH unaffected by the BTC failure');
  // distinct snapshots per pair
  const btcSnap = getShadowCalls(db, { pair: 'BTCUSDT' })[0].snapshot_id;
  assert.notEqual(btcSnap, eth[0].snapshot_id, 'each pair gets its own snapshot_id');
  db.close();
});
