// Step 13: OpenRouter actual-cost reconciliation.
//
// The load-bearing properties: the ESTIMATE (priced from the REQUESTED model)
// is never overwritten, reconciliation is bounded and cannot retry forever,
// and none of it can touch a trading decision, the budget gate, the primary
// call count, the retry limit, or shadow isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import {
  ACTUAL_COST_SOURCE, MAX_RECONCILE_ATTEMPTS, fetchGenerationCost,
  getOpenRouterCostReconciliation, pendingReconciliations, reconcileOpenRouterCosts,
} from '../src/ai/reconcile.js';
import { openrouterProvider } from '../src/ai/providers/openrouter.js';
import { evaluateRegime } from '../src/ai/regime.js';
import { getShadowCalls, runShadowEvaluation } from '../src/ai/shadow.js';
import { getDailySpend } from '../src/ai/budget.js';
import { runPairRules } from '../src/engine/rules.js';

const OR_MODEL = 'meta-llama/llama-3.3-70b-instruct';
const GOOD = '{"regime":"bearish","confidence":66,"trade_allowed":true,"reasoning":"x"}';
const SUMMARY = { pair: 'BTCUSDT' };
const GEN_ID = 'gen-abc123';
const FAKE_KEY = 'test-key-not-real';

function jsonResponse(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
}
const orCompletion = (usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, id = GEN_ID) =>
  jsonResponse({ id, model: OR_MODEL, choices: [{ message: { content: GOOD } }], usage });

async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try { return await fn(); } finally { Object.assign(config, saved); }
}

const OR_CFG = {
  mock: false, aiProvider: 'openrouter', openrouterApiKey: FAKE_KEY,
  openrouterModel: OR_MODEL, aiModelOverride: '', groqApiKey: '',
};

async function openrouterPrimary({ db, response = orCompletion(), pair = 'BTCUSDT' }) {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response; };
  try {
    const out = await withConfig(OR_CFG, () => evaluateRegime(pair, { ...SUMMARY, pair }, db, Date.now(), { snapshotId: 'snap' }));
    return { out, calls };
  } finally { globalThis.fetch = saved; }
}
const lastCall = (db) => db.prepare('SELECT * FROM regime_calls ORDER BY id DESC LIMIT 1').get();

// --- generation-ID capture ----------------------------------------------

test('the provider surfaces the generation id, and it is persisted', async () => {
  const rec = await withConfig({ openrouterApiKey: FAKE_KEY, openrouterModel: OR_MODEL, aiModelOverride: '' },
    () => openrouterProvider.complete({ summary: SUMMARY, fetchImpl: async () => orCompletion() }));
  assert.equal(rec.generationId, GEN_ID);
  assert.equal(rec.model, OR_MODEL, 'attribution still the REQUESTED model');

  const db = openDb(':memory:');
  await openrouterPrimary({ db });
  const r = lastCall(db);
  assert.equal(r.generation_id, GEN_ID);
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.actual_cost, null, 'not reconciled yet');
  assert.equal(r.actual_cost_source, null);
  assert.equal(r.reconcile_attempts, 0);
  db.close();
});

test('a response without an id persists NULL and is never queued', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db, response: jsonResponse({ model: OR_MODEL, choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
  assert.equal(lastCall(db).generation_id, null);
  assert.equal(pendingReconciliations(db).length, 0, 'no id -> nothing to reconcile');
  db.close();
});

// --- successful reconciliation ------------------------------------------

test('successful reconciliation stores the exact total_cost and its source', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db });
  const estBefore = lastCall(db).est_cost;

  let requestedUrl = null;
  let authHeader = null;
  const fetchImpl = async (url, opts) => {
    requestedUrl = String(url);
    authHeader = opts.headers.authorization;
    return jsonResponse({ data: { id: GEN_ID, total_cost: 0.00042731, model: OR_MODEL } });
  };
  const summary = await withConfig(OR_CFG, () => reconcileOpenRouterCosts({ db, fetchImpl }));

  assert.deepEqual(summary, { attempted: 1, reconciled: 1, failed: 0, abandoned: 0 });
  const r = lastCall(db);
  assert.equal(r.actual_cost, 0.00042731, 'exact total_cost, unrounded');
  assert.equal(r.actual_cost_source, ACTUAL_COST_SOURCE);
  assert.equal(r.est_cost, estBefore, 'the ESTIMATE is untouched');
  // request shape: authenticated header, id in the query, key never in a log
  assert.ok(requestedUrl.includes('/generation?id=gen-abc123'));
  assert.equal(authHeader, `Bearer ${FAKE_KEY}`);
  assert.ok(!requestedUrl.includes(FAKE_KEY), 'key never in the URL');
  // and it is no longer pending
  assert.equal(pendingReconciliations(db).length, 0);
  db.close();
});

test('the estimate is preserved even when the actual differs wildly', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db }); // 1M/1M at $0.10/$0.32 -> $0.42 estimated
  const est = lastCall(db).est_cost;
  assert.ok(Math.abs(est - 0.42) < 1e-9, `estimate should be 0.42, got ${est}`);

  await withConfig(OR_CFG, () => reconcileOpenRouterCosts({
    db, fetchImpl: async () => jsonResponse({ data: { total_cost: 9.99 } }),
  }));
  const r = lastCall(db);
  assert.equal(r.actual_cost, 9.99, 'actual recorded as reported');
  assert.ok(Math.abs(r.est_cost - 0.42) < 1e-9, 'requested-model estimate NEVER overwritten');
  assert.notEqual(r.est_cost, r.actual_cost, 'the two are stored separately, not conflated');
  db.close();
});

// --- failure modes -------------------------------------------------------

test('HTTP error, malformed body, and missing total_cost all leave actual_cost NULL', async () => {
  for (const [label, fetchImpl] of [
    ['http error', async () => new Response('nope', { status: 500 })],
    ['malformed json', async () => new Response('<html>not json', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['missing total_cost', async () => jsonResponse({ data: { id: GEN_ID, model: OR_MODEL } })],
    ['non-numeric total_cost', async () => jsonResponse({ data: { total_cost: 'free' } })],
    ['timeout', (url, opts = {}) => new Promise((_r, reject) => {
      const { signal } = opts;
      if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })],
  ]) {
    const db = openDb(':memory:');
    await openrouterPrimary({ db });
    const est = lastCall(db).est_cost;
    const summary = await withConfig({ ...OR_CFG, aiRequestTimeoutMs: 50 },
      () => reconcileOpenRouterCosts({ db, fetchImpl }));
    const r = lastCall(db);
    assert.equal(r.actual_cost, null, `${label}: actual stays NULL`);
    assert.equal(r.actual_cost_source, null, `${label}: no source claimed`);
    assert.equal(r.est_cost, est, `${label}: estimate untouched`);
    assert.equal(summary.failed, 1, `${label}: counted as failed`);
    assert.ok(db.prepare("SELECT id FROM events WHERE type = 'COST_RECONCILE_FAILED'").get(), `${label}: warned`);
    db.close();
  }
});

test('retries are bounded and the warning is deduplicated', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db });
  const fetchImpl = async () => new Response('nope', { status: 500 });

  for (let i = 1; i <= MAX_RECONCILE_ATTEMPTS; i++) {
    const s = await withConfig(OR_CFG, () => reconcileOpenRouterCosts({ db, fetchImpl }));
    assert.equal(s.attempted, 1, `attempt ${i} ran`);
    assert.equal(lastCall(db).reconcile_attempts, i);
  }
  // exhausted: the row is abandoned, not retried forever
  const after = await withConfig(OR_CFG, () => reconcileOpenRouterCosts({ db, fetchImpl }));
  assert.deepEqual(after, { attempted: 0, reconciled: 0, failed: 0, abandoned: 0 }, 'no further attempts');
  assert.equal(lastCall(db).reconcile_attempts, MAX_RECONCILE_ATTEMPTS);
  assert.equal(pendingReconciliations(db).length, 0, 'dropped from the queue');
  // deduplicated warning: one row per generation id per day
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'COST_RECONCILE_FAILED'").get().n, 1);
  db.close();
});

test('a hanging lookup still burns an attempt, so it can never loop forever', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db });
  const hang = (url, opts = {}) => new Promise((_r, reject) => {
    const { signal } = opts;
    if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await withConfig({ ...OR_CFG, aiRequestTimeoutMs: 50 }, () => reconcileOpenRouterCosts({ db, fetchImpl: hang }));
  assert.equal(lastCall(db).reconcile_attempts, 1, 'attempt counted despite the timeout');
  db.close();
});

test('no OpenRouter key means no reconciliation requests at all', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db });
  let called = false;
  const s = await withConfig({ ...OR_CFG, openrouterApiKey: '' },
    () => reconcileOpenRouterCosts({ db, fetchImpl: async () => { called = true; return jsonResponse({}); } }));
  assert.equal(called, false);
  assert.deepEqual(s, { attempted: 0, reconciled: 0, failed: 0, abandoned: 0 });
  db.close();
});

test('fetchGenerationCost tolerates a bare record and rejects a bad status', async () => {
  await withConfig({ openrouterApiKey: FAKE_KEY }, async () => {
    assert.equal(await fetchGenerationCost(GEN_ID, { fetchImpl: async () => jsonResponse({ total_cost: 0.5 }) }), 0.5);
    assert.equal(await fetchGenerationCost(GEN_ID, { fetchImpl: async () => jsonResponse({ data: {} }) }), null);
    await assert.rejects(() => fetchGenerationCost(GEN_ID, { fetchImpl: async () => new Response('x', { status: 404 }) }));
  });
});

// --- no effect on trading, budget, call count, retry, or shadow ----------

test('reconciliation changes no trade outcome, budget accrual, or budget gate', async () => {
  const db = openDb(':memory:');
  const { out, calls } = await openrouterPrimary({ db });
  const spendBefore = getDailySpend(db, undefined, 'openrouter');
  const estBefore = lastCall(db).est_cost;
  assert.equal(calls, 1, 'exactly one primary call');
  assert.ok(Math.abs(spendBefore - 0.42) < 1e-9, 'budget accrued from the ESTIMATE');

  await withConfig(OR_CFG, () => reconcileOpenRouterCosts({
    db, fetchImpl: async () => jsonResponse({ data: { total_cost: 9.99 } }),
  }));

  // budget accrual and the gate input are unchanged by the reconciled figure
  assert.equal(getDailySpend(db, undefined, 'openrouter'), spendBefore, 'budget untouched by actual cost');
  assert.equal(lastCall(db).est_cost, estBefore);
  // the regime the engine received is unchanged
  assert.equal(out.regime.regime, 'bearish');
  assert.equal(out.regime.trade_allowed, true);
  // and an executor is never reachable from this path
  const executor = {
    calls: 0,
    async openPosition() { this.calls++; throw new Error('reconciliation reached the executor'); },
    async closePosition() { this.calls++; throw new Error('reconciliation reached the executor'); },
  };
  const actions = await runPairRules({
    pair: 'BTCUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.5, adx4h: 40,
    regime: { regime: 'chop', confidence: 0, trade_allowed: false, reasoning: 'x' },
    executor, cfg: { ...config, weekendFilterEnabled: false, volTargetingEnabled: false }, db,
  });
  assert.deepEqual(actions.map((a) => a.type), ['no_entry']);
  assert.equal(executor.calls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 0);
  db.close();
});

test('the one-call-plus-one-retry invariant is unaffected', async () => {
  const db = openDb(':memory:');
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return jsonResponse({
      id: `gen-${n}`, model: OR_MODEL,
      choices: [{ message: { content: n === 1 ? '<thinking>cut off' : GOOD } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
  };
  try {
    await withConfig(OR_CFG, () => evaluateRegime('BTCUSDT', SUMMARY, db, Date.now(), { snapshotId: 's' }));
    assert.equal(n, 2, 'one call + one retry, unchanged');
    // the RETRY's generation id supersedes the first: it is the billable call
    assert.equal(lastCall(db).generation_id, 'gen-2');
  } finally { globalThis.fetch = saved; db.close(); }
});

test('shadow rows reconcile too, and shadow isolation is intact', async () => {
  const db = openDb(':memory:');
  const shadowProvider = {
    name: 'openrouter', keyEnvVar: 'OPENROUTER_API_KEY', isConfigured: () => true,
    get model() { return OR_MODEL; },
    async complete() {
      return { provider: 'openrouter', model: OR_MODEL, text: GOOD, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, generationId: 'gen-shadow-1' };
    },
  };
  await withConfig({ ...OR_CFG, aiShadowMode: true, aiProvider: 'anthropic' }, () =>
    runShadowEvaluation({ pair: 'BTCUSDT', summary: SUMMARY, snapshotId: 'snap', db, providers: [shadowProvider] }));
  const before = getShadowCalls(db)[0];
  assert.equal(before.generation_id, 'gen-shadow-1');
  assert.ok(Math.abs(before.est_cost - 0.42) < 1e-9);

  await withConfig(OR_CFG, () => reconcileOpenRouterCosts({
    db, fetchImpl: async () => jsonResponse({ data: { total_cost: 0.0011 } }),
  }));
  const after = getShadowCalls(db)[0];
  assert.equal(after.actual_cost, 0.0011);
  assert.equal(after.actual_cost_source, ACTUAL_COST_SOURCE);
  assert.ok(Math.abs(after.est_cost - 0.42) < 1e-9, 'shadow estimate untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 0, 'shadow still creates no trades');
  db.close();
});

test('reconcile.js has no path to the trading engine', () => {
  const src = fs.readFileSync('src/ai/reconcile.js', 'utf8');
  const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports) assert.ok(!spec.includes('engine/'), `must not import ${spec}`);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/\bexecutor\b|runPairRules|openTrade|closeTrade|addSpend/.test(code),
    'reconcile.js never references trading or budget-accrual functions');
});

// --- reporting -----------------------------------------------------------

test('reporting separates estimated from reconciled actual and counts the rest', async () => {
  const db = openDb(':memory:');
  await openrouterPrimary({ db, pair: 'BTCUSDT' });
  await openrouterPrimary({ db, response: orCompletion({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'gen-2'), pair: 'ETHUSDT' });
  let before = getOpenRouterCostReconciliation(db);
  assert.equal(before.calls, 2);
  assert.equal(before.reconciled_calls, 0);
  assert.equal(before.unreconciled_calls, 2, 'nothing claimed as verified yet');
  assert.ok(Math.abs(before.estimated - 0.52) < 1e-6, `estimated 0.42 + 0.10, got ${before.estimated}`);

  // reconcile only the first
  await withConfig(OR_CFG, () => reconcileOpenRouterCosts({
    db, limit: 1,
    fetchImpl: async (url) => (String(url).includes('gen-2')
      ? jsonResponse({ data: { total_cost: 0.05 } })
      : new Response('nope', { status: 500 })),
  }));
  const after = getOpenRouterCostReconciliation(db);
  assert.equal(after.reconciled_calls + after.unreconciled_calls, after.calls);
  assert.ok(Math.abs(after.estimated - 0.52) < 1e-6, 'estimated total unchanged by reconciliation');
});
