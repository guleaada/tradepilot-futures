// Trend-scaled dynamic take-profit: ADX math, trend classification, TP
// selection, runner scaling, and the flag-off path being byte-identical to
// the fixed-TP behavior — plus the expanded-universe liquidity pruning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { adx } from '../src/indicators.js';
import { getFuturesTicker24h } from '../src/data/binance.js';
import {
  classifyTrend,
  runPairRules,
  runnerTargetR,
  tpMultiplierFor,
  trailingStopActions,
} from '../src/engine/rules.js';
import { getOpenPosition } from '../src/engine/portfolio.js';
import { filterPairsByLiquidity } from '../src/index.js';

// --- ADX(14) ---

// Regression lock on the same synthetic dataset family as
// indicators.regression.test.js: close_i = 100 + 10*sin(i/7) + 0.3*i,
// high/low = close +/- 1.5, 100 candles. Expected value derived from an
// INDEPENDENT reference implementation of the textbook Wilder definition
// (explicit DI series, plain-sum seeds, Wilder smoothing) — not by calling
// indicators.js. Reference run output: ADX14 = 58.9796576098.
function dataset() {
  const candles = [];
  let prev = null;
  for (let i = 0; i < 100; i++) {
    const close = 100 + 10 * Math.sin(i / 7) + 0.3 * i;
    candles.push({ open: prev ?? close, high: close + 1.5, low: close - 1.5, close });
    prev = close;
  }
  return candles;
}

test('ADX(14) regression-locks against the textbook Wilder definition', () => {
  const series = adx(dataset(), 14);
  assert.ok(Math.abs(series[series.length - 1] - 58.9796576098) < 1e-9);
  // aligned-array convention: first value at index 2*period - 1
  assert.equal(series.findIndex((v) => v !== null), 27);
  assert.equal(series[26], null);
});

test('ADX properties: monotonic trend saturates high, pure chop reads low', () => {
  const trend = Array.from({ length: 80 }, (_, i) => ({ high: 100 + 2 * i + 1, low: 100 + 2 * i - 1, close: 100 + 2 * i }));
  const chop = Array.from({ length: 80 }, (_, i) => {
    const c = 100 + 3 * Math.sin(i * 2.1);
    return { high: c + 1, low: c - 1, close: c };
  });
  const t = adx(trend, 14);
  const c = adx(chop, 14);
  assert.ok(t[t.length - 1] > 90, `trend ADX should saturate, got ${t[t.length - 1]}`);
  assert.ok(c[c.length - 1] < 15, `chop ADX should be low, got ${c[c.length - 1]}`);
  // too little data -> all null
  assert.ok(adx(trend.slice(0, 28), 14).every((v) => v === null));
});

// --- classification & TP selection ---

const tpCfg = {
  dynamicTpEnabled: true,
  tpAtrMult: 2.5,
  tpAtrMultWeak: 2.0,
  tpAtrMultNormal: 2.5,
  tpAtrMultStrong: 4.5,
  adxStrong: 30,
  adxWeak: 18,
  extendedTpR: 4.0,
};

test('trend classification honors the threshold boundaries exactly', () => {
  assert.equal(classifyTrend(30, tpCfg), 'strong'); // >= strong
  assert.equal(classifyTrend(29.99, tpCfg), 'normal');
  assert.equal(classifyTrend(18, tpCfg), 'normal'); // >= weak is normal
  assert.equal(classifyTrend(17.99, tpCfg), 'weak');
  assert.equal(classifyTrend(0, tpCfg), 'weak');
  assert.equal(classifyTrend(75, tpCfg), 'strong');
  // missing ADX degrades to today's behavior, never wider
  assert.equal(classifyTrend(null, tpCfg), 'normal');
  assert.equal(classifyTrend(NaN, tpCfg), 'normal');
});

test('trend class picks the matching TP multiplier; disabled flag restores the fixed multiple', () => {
  assert.equal(tpMultiplierFor('strong', tpCfg), 4.5);
  assert.equal(tpMultiplierFor('normal', tpCfg), 2.5);
  assert.equal(tpMultiplierFor('weak', tpCfg), 2.0);
  const off = { ...tpCfg, dynamicTpEnabled: false, tpAtrMult: 2.5 };
  assert.equal(tpMultiplierFor('strong', off), 2.5, 'flag off ignores trend entirely');
  assert.equal(tpMultiplierFor('weak', off), 2.5);
});

test('runner target scales with the trade tp_mult; flat when off or legacy', () => {
  // strong trade: 4.0 * (4.5 / 2.5) = 7.2R
  assert.ok(Math.abs(runnerTargetR({ tp_mult: 4.5 }, tpCfg) - 7.2) < 1e-12);
  // weak trade: 4.0 * (2.0 / 2.5) = 3.2R
  assert.ok(Math.abs(runnerTargetR({ tp_mult: 2.0 }, tpCfg) - 3.2) < 1e-12);
  assert.equal(runnerTargetR({ tp_mult: 2.5 }, tpCfg), 4.0);
  // legacy row (no tp_mult) and flag-off both fall back to the flat 4R
  assert.equal(runnerTargetR({}, tpCfg), 4.0);
  assert.equal(runnerTargetR({ tp_mult: 4.5 }, { ...tpCfg, dynamicTpEnabled: false }), 4.0);
});

test('partial-exit runner uses the scaled target for both directions', () => {
  const base = {
    entry_price: 100, qty: 10, initial_risk: 6,
    trailing_stop_active: 0, partial_exit_done: 0, tp_mult: 4.5,
  };
  const cfgT = { ...tpCfg, trailingStopEnabled: true, breakevenR: 1.5, partialExitR: 2.0, partialExitFraction: 0.5 };
  // long at +2R: runner targets entry + 7.2R = 143.2
  const long = trailingStopActions({ ...base, direction: 'long', stop_price: 94 }, 112, cfgT);
  assert.ok(Math.abs(long.find((a) => a.action === 'partial_exit').newTp - 143.2) < 1e-9);
  // short at -2R: runner targets entry - 7.2R = 56.8
  const short = trailingStopActions({ ...base, direction: 'short', stop_price: 106 }, 88, cfgT);
  assert.ok(Math.abs(short.find((a) => a.action === 'partial_exit').newTp - 56.8) < 1e-9);
  // flag off: the classic 4R target (124 / 76)
  const off = { ...cfgT, dynamicTpEnabled: false };
  assert.equal(trailingStopActions({ ...base, direction: 'long', stop_price: 94 }, 112, off).find((a) => a.action === 'partial_exit').newTp, 124);
});

// --- end-to-end through runPairRules ---

const fakeExecutor = {
  async openPosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 1 };
  },
  async closePosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 2 };
  },
};

function entrySetup(direction) {
  return direction === 'long'
    ? { pair: 'AVAXUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95, volumeRatio: 1.2, regime: { regime: 'bullish', confidence: 72, trade_allowed: true } }
    : { pair: 'LINKUSDT', price: 95, atr1h: 4, rsi1h: 45, ema50_4h: 100, dailyEma50: 110, volumeRatio: 1.2, regime: { regime: 'bearish', confidence: 72, trade_allowed: true } };
}

const rulesCfg = { ...config, ...tpCfg, leverage: 3, weekendFilterEnabled: false, volTargetingEnabled: false };

test('strong trend widens the TP, leaves the stop untouched, and is persisted + logged', async () => {
  const db = openDb(':memory:');
  const actions = await runPairRules({ ...entrySetup('long'), adx4h: 42, executor: fakeExecutor, cfg: rulesCfg, db });
  const open = actions.find((a) => a.type === 'open');
  assert.equal(open.trend, 'strong');
  assert.equal(open.tpMult, 4.5);
  assert.ok(Math.abs(open.stop - (105 - 1.5 * 4)) < 1e-9, 'stop distance unchanged (1.5xATR)');
  assert.ok(Math.abs(open.tp - (105 + 4.5 * 4)) < 1e-9, 'TP widened to 4.5xATR');

  const pos = getOpenPosition('AVAXUSDT', db);
  assert.equal(pos.trend_class, 'strong');
  assert.equal(pos.tp_mult, 4.5);
  const ev = JSON.parse(db.prepare("SELECT detail FROM events WHERE type = 'TRADE_OPENED'").get().detail);
  assert.equal(ev.trend, 'strong');
  assert.equal(ev.tpMult, 4.5);
  assert.equal(ev.adx4h, 42);
  db.close();
});

test('short TPs mirror per trend class; weak trend tightens', async () => {
  const db = openDb(':memory:');
  const strong = await runPairRules({ ...entrySetup('short'), adx4h: 35, executor: fakeExecutor, cfg: rulesCfg, db });
  const s = strong.find((a) => a.type === 'open');
  assert.ok(Math.abs(s.tp - (95 - 4.5 * 4)) < 1e-9, 'strong short TP = entry - 4.5xATR');
  assert.ok(Math.abs(s.stop - (95 + 1.5 * 4)) < 1e-9, 'short stop unchanged');
  db.close();

  const db2 = openDb(':memory:');
  const weak = await runPairRules({ ...entrySetup('short'), adx4h: 12, executor: fakeExecutor, cfg: rulesCfg, db: db2 });
  const w = weak.find((a) => a.type === 'open');
  assert.equal(w.trend, 'weak');
  assert.ok(Math.abs(w.tp - (95 - 2.0 * 4)) < 1e-9, 'weak short TP = entry - 2.0xATR');
  db2.close();
});

test('DYNAMIC_TP_ENABLED=false reproduces the fixed 2.5xATR behavior exactly', async () => {
  const db = openDb(':memory:');
  const off = { ...rulesCfg, dynamicTpEnabled: false };
  // even with a screaming-strong ADX, the TP must be the fixed multiple
  const actions = await runPairRules({ ...entrySetup('long'), adx4h: 80, executor: fakeExecutor, cfg: off, db });
  const open = actions.find((a) => a.type === 'open');
  assert.equal(open.trend, null, 'no trend class recorded when disabled');
  assert.equal(open.tpMult, 2.5);
  assert.ok(Math.abs(open.tp - (105 + 2.5 * 4)) < 1e-9);
  assert.ok(Math.abs(open.stop - (105 - 1.5 * 4)) < 1e-9);
  const pos = getOpenPosition('AVAXUSDT', db);
  assert.equal(pos.trend_class, null);
  db.close();
});

// --- expanded universe / liquidity pruning ---

test('mock liquidity data prunes the deliberately-thin expanded pairs', async () => {
  const db = openDb(':memory:');
  const origMock = config.mock;
  config.mock = true; // getFuturesTicker24h serves the deterministic mock tickers
  try {
    const kept = await filterPairsByLiquidity(db, { getTicker24h: getFuturesTicker24h });
    // 15 configured; SOL/XRP (derived volumes) and APT/TIA (explicit) are thin
    assert.equal(config.pairs.length, 15);
    assert.deepEqual(
      kept,
      config.pairs.filter((p) => !['SOLUSDT', 'XRPUSDT', 'APTUSDT', 'TIAUSDT'].includes(p)),
    );
    const excluded = db.prepare("SELECT detail FROM events WHERE type = 'PAIR_EXCLUDED'").all()
      .map((r) => JSON.parse(r.detail).pair).sort();
    assert.deepEqual(excluded, ['APTUSDT', 'SOLUSDT', 'TIAUSDT', 'XRPUSDT']);
  } finally {
    config.mock = origMock;
  }
  db.close();
});

test('futures ticker mock path reports quote volume with a source tag', async () => {
  const origMock = config.mock;
  config.mock = true;
  try {
    const t = await getFuturesTicker24h('APTUSDT');
    assert.equal(t.quoteVolume, 6_000_000); // deliberately below the $10M threshold
    assert.equal(t.source, 'futures');
    const big = await getFuturesTicker24h('AVAXUSDT');
    assert.ok(big.quoteVolume >= 10_000_000);
  } finally {
    config.mock = origMock;
  }
});
