// Chandelier ATR trailing stop (profit lever): once past breakeven, the stop
// ratchets toward the high-water mark by trailingAtrMult x ATR, tightening
// only, for both directions. Off => prior fixed-stop behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { chandelierStop, runPairRules } from '../src/engine/rules.js';
import { getOpenPosition, openTrade } from '../src/engine/portfolio.js';

const cfg = { trailingAtrEnabled: true, trailingAtrMult: 2.0 };

test('inactive until breakeven arms the trail', () => {
  const pre = { direction: 'long', entry_price: 100, stop_price: 94, hwm: 100, trailing_stop_active: 0 };
  assert.equal(chandelierStop(pre, 112, 3, cfg), null); // not armed yet
});

test('long: stop ratchets up toward the high-water mark, never loosens', () => {
  const pos = { direction: 'long', entry_price: 100, stop_price: 100, hwm: 100, trailing_stop_active: 1 };
  // price 120, ATR 3 -> candidate 120 - 6 = 114 > stop 100 -> tighten
  const up = chandelierStop(pos, 120, 3, cfg);
  assert.equal(up.newHwm, 120);
  assert.ok(Math.abs(up.newStop - 114) < 1e-9);

  // price pulls back to 116 (still above the trailed stop): hwm holds at 120,
  // candidate 114 == current stop -> no loosening, only hwm reported
  const held = chandelierStop({ ...pos, stop_price: 114, hwm: 120 }, 116, 3, cfg);
  assert.equal(held.newStop, undefined, 'stop never loosens on a pullback');
  assert.equal(held.newHwm, 120);

  // new high 130 -> stop ratchets to 124
  const higher = chandelierStop({ ...pos, stop_price: 114, hwm: 120 }, 130, 3, cfg);
  assert.ok(Math.abs(higher.newStop - 124) < 1e-9);
  assert.equal(higher.newHwm, 130);
});

test('short: stop ratchets down toward the low-water mark', () => {
  const pos = { direction: 'short', entry_price: 100, stop_price: 100, hwm: 100, trailing_stop_active: 1 };
  // price 80, ATR 3 -> candidate 80 + 6 = 86 < stop 100 -> tighten down
  const down = chandelierStop(pos, 80, 3, cfg);
  assert.equal(down.newHwm, 80);
  assert.ok(Math.abs(down.newStop - 86) < 1e-9);
  // bounce to 84: low-water holds at 80, stop stays 86 (no loosening up)
  const held = chandelierStop({ ...pos, stop_price: 86, hwm: 80 }, 84, 3, cfg);
  assert.equal(held.newStop, undefined);
  assert.equal(held.newHwm, 80);
});

test('disabled flag => no trailing at all', () => {
  const pos = { direction: 'long', entry_price: 100, stop_price: 100, hwm: 100, trailing_stop_active: 1 };
  assert.equal(chandelierStop(pos, 130, 3, { ...cfg, trailingAtrEnabled: false }), null);
});

// End-to-end: a long that armed breakeven, ran up, then reversed exits at the
// TRAILED stop (banking profit) instead of falling back to breakeven.
const fakeExecutor = {
  async openPosition(pair, direction, qty, price) { return { pair, fillPrice: price, fee: 0, executedQty: qty, orderId: 1 }; },
  async closePosition(pair, direction, qty, price) { return { pair, fillPrice: price, fee: 0, executedQty: qty, orderId: 2 }; },
};

test('a big run then reversal exits at the trailed stop, locking gains above breakeven', async () => {
  const db = openDb(':memory:');
  const rulesCfg = {
    trailingStopEnabled: true, breakevenR: 1.5, partialExitR: 99, partialExitFraction: 0.5, extendedTpR: 4.0,
    trailingAtrEnabled: true, trailingAtrMult: 2.0,
    emergencyExitEnabled: false, regimeFlipConfidence: 70, dynamicTpEnabled: false, tpAtrMult: 2.5,
  };
  // long entry 100, initial stop 94 (R=6), ATR 3, TP far away
  const id = openTrade({ pair: 'BTCUSDT', direction: 'long', qty: 1, fillPrice: 100, fee: 0, stopPrice: 94, tpPrice: 300, leverage: 3 }, db);

  const run = (price) => runPairRules({
    pair: 'BTCUSDT', price, atr1h: 3, rsi1h: 55, ema50_4h: 90,
    regime: { regime: 'bullish', confidence: 65, trade_allowed: true },
    executor: fakeExecutor, cfg: rulesCfg, db, entriesBlocked: true,
  });

  // cycle 1: price 112 (>=1.5R=109) arms breakeven; then chandelier trails to 112-6=106
  await run(112);
  let pos = getOpenPosition('BTCUSDT', db);
  assert.equal(pos.trailing_stop_active, 1);
  assert.ok(Math.abs(pos.stop_price - 106) < 1e-9, `stop trailed to 106, got ${pos.stop_price}`);
  assert.equal(pos.hwm, 112);

  // cycle 2: new high 130 -> stop ratchets to 124
  await run(130);
  pos = getOpenPosition('BTCUSDT', db);
  assert.ok(Math.abs(pos.stop_price - 124) < 1e-9, `stop trailed to 124, got ${pos.stop_price}`);

  // cycle 3: reversal to 123 (below the trailed 124) -> stop-out, banking +23 not breakeven
  const acts = await run(123);
  const close = acts.find((a) => a.type === 'close');
  assert.ok(close, 'closed on the trailed stop');
  assert.equal(close.reason, 'stop');
  assert.ok(close.pnl > 20, `banked the trailed gain, got ${close.pnl}`);
  db.close();
});
