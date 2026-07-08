// Metals (XAU/XAG) rules: wider stops, R-preserving TP, ADX trend floor —
// and proof that crypto pairs behave byte-identically to the pre-metals code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getFuturesTicker24h } from '../src/data/binance.js';
import {
  computePositionSize,
  entryAllowed,
  isMetal,
  runPairRules,
  stopMultFor,
} from '../src/engine/rules.js';
import { getOpenPosition } from '../src/engine/portfolio.js';
import { filterPairsByLiquidity } from '../src/index.js';

const cfg = {
  ...config,
  leverage: 3,
  weekendFilterEnabled: false,
  volTargetingEnabled: false,
  metalsStopAtrMult: 1.8,
  metalsMinAdx: 22,
};

test('isMetal covers exactly gold and silver — and XPTUSDT exists nowhere', () => {
  assert.equal(isMetal('XAUUSDT'), true);
  assert.equal(isMetal('XAGUSDT'), true);
  assert.equal(isMetal('BTCUSDT'), false);
  assert.equal(isMetal('XPTUSDT'), false);
  assert.equal(isMetal(null), false);
  assert.ok(config.pairs.includes('XAUUSDT'));
  assert.ok(config.pairs.includes('XAGUSDT'));
  assert.ok(!config.pairs.includes('XPTUSDT'), 'platinum deliberately excluded');
});

test('metals size against the wider 1.8x-ATR stop; crypto keeps 1.5x — dollar risk identical', () => {
  assert.equal(stopMultFor('XAUUSDT', cfg), 1.8);
  assert.equal(stopMultFor('BTCUSDT', cfg), 1.5);
  assert.equal(stopMultFor(null, cfg), 1.5);

  // equity 1000, ATR 4: crypto stop dist 6, metals stop dist 7.2
  const crypto = computePositionSize(1000, 100, 4, cfg, null, 'long', 'BTCUSDT');
  const metal = computePositionSize(1000, 100, 4, cfg, null, 'long', 'XAUUSDT');
  assert.ok(Math.abs(crypto.stopDist - 6) < 1e-9);
  assert.ok(Math.abs(metal.stopDist - 7.2) < 1e-9);
  // both risk exactly $10: qty x stopDist = equity x 1%
  assert.ok(Math.abs(crypto.qty * crypto.stopDist - 10) < 1e-9);
  assert.ok(Math.abs(metal.qty * metal.stopDist - 10) < 1e-9);
  // omitting the pair arg reproduces the old signature exactly
  const legacy = computePositionSize(1000, 100, 4, cfg, null, 'long');
  assert.equal(legacy.qty, crypto.qty);
});

test('metals entries demand ADX >= 22; crypto entries never see the gate', () => {
  const base = {
    direction: 'long',
    regime: { regime: 'bullish', confidence: 70, trade_allowed: true },
    price: 105, ema50_4h: 100, dailyEma50: 95, rsi1h: 55, volumeRatio: 1.2,
    hasOpen: false, openCount: 0, inCooldown: false, halted: false,
  };
  assert.equal(entryAllowed({ ...base, pair: 'XAUUSDT', adx4h: 21.99 }, cfg).reason, 'metals_weak_trend');
  assert.equal(entryAllowed({ ...base, pair: 'XAUUSDT', adx4h: null }, cfg).reason, 'metals_weak_trend');
  assert.equal(entryAllowed({ ...base, pair: 'XAUUSDT', adx4h: 22 }, cfg).ok, true);
  // crypto: no ADX requirement, even with it missing entirely
  assert.equal(entryAllowed({ ...base, pair: 'BTCUSDT', adx4h: null }, cfg).ok, true);
  assert.equal(entryAllowed({ ...base, pair: 'BTCUSDT', adx4h: 5 }, cfg).ok, true);
  // and with no pair at all (old callers), behavior is unchanged
  assert.equal(entryAllowed(base, cfg).ok, true);
});

const fakeExecutor = {
  async openPosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 1 };
  },
  async closePosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 2 };
  },
};

test('a gold entry uses the 1.8x stop and an R-preserving TP; reward:risk matches crypto', async () => {
  const db = openDb(':memory:');
  const gold = {
    pair: 'XAUUSDT', price: 2600, atr1h: 20, rsi1h: 55, ema50_4h: 2550, dailyEma50: 2500,
    volumeRatio: 1.2, adx4h: 35, // strong trend -> tpMult 4.5
    regime: { regime: 'bullish', confidence: 70, trade_allowed: true },
    executor: fakeExecutor, cfg, db,
  };
  const actions = await runPairRules(gold);
  const open = actions.find((a) => a.type === 'open');
  assert.ok(open, `expected an open, got ${JSON.stringify(actions)}`);
  // stop = entry - 1.8 x ATR = 2600 - 36
  assert.ok(Math.abs(open.stop - 2564) < 1e-9);
  // tp = entry + 4.5 x ATR x (1.8/1.5) = 2600 + 108 -> same 3.0R as crypto
  assert.ok(Math.abs(open.tp - 2708) < 1e-9);
  const rr = (open.tp - open.entry) / (open.entry - open.stop);
  assert.ok(Math.abs(rr - 3.0) < 1e-9, 'reward:risk preserved at 3R for strong trend');
  const pos = getOpenPosition('XAUUSDT', db);
  assert.ok(Math.abs(pos.initial_risk - 36) < 1e-9);
  db.close();
});

test('a crypto entry is byte-identical to pre-metals behavior', async () => {
  const db = openDb(':memory:');
  const btc = {
    pair: 'AVAXUSDT', price: 105, atr1h: 4, rsi1h: 55, ema50_4h: 100, dailyEma50: 95,
    volumeRatio: 1.2, adx4h: 35,
    regime: { regime: 'bullish', confidence: 70, trade_allowed: true },
    executor: fakeExecutor, cfg, db,
  };
  const open = (await runPairRules(btc)).find((a) => a.type === 'open');
  assert.ok(Math.abs(open.stop - (105 - 1.5 * 4)) < 1e-9, 'crypto stop still 1.5x ATR');
  assert.ok(Math.abs(open.tp - (105 + 4.5 * 4)) < 1e-9, 'crypto TP untouched (rScale = 1)');
  const rr = (open.tp - open.entry) / (open.entry - open.stop);
  assert.ok(Math.abs(rr - 3.0) < 1e-9, 'same 3R reward:risk as the gold entry');
  db.close();
});

test('mock liquidity filter keeps gold and silver in the universe', async () => {
  const db = openDb(':memory:');
  const origMock = config.mock;
  config.mock = true;
  try {
    const kept = await filterPairsByLiquidity(db, { getTicker24h: getFuturesTicker24h });
    assert.ok(kept.includes('XAUUSDT'), 'gold survives the $10M filter');
    assert.ok(kept.includes('XAGUSDT'), 'silver survives the $10M filter');
  } finally {
    config.mock = origMock;
  }
  db.close();
});
