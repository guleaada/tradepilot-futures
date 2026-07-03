import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { trailingStopActions } from '../src/engine/rules.js';
import { closeTrade, getCash, getMarginLocked, openTrade, partialCloseTrade } from '../src/engine/portfolio.js';

const cfg = {
  trailingStopEnabled: true,
  breakevenR: 1.5,
  partialExitR: 2.0,
  partialExitFraction: 0.5,
  extendedTpR: 4.0,
};

// LONG: entry 100, initial stop 94 -> R = 6. Breakeven at 109, partial at 112.
const freshLong = {
  direction: 'long',
  entry_price: 100,
  stop_price: 94,
  qty: 10,
  initial_risk: 6,
  trailing_stop_active: 0,
  partial_exit_done: 0,
};

// SHORT: entry 100, initial stop 106 -> R = 6. Breakeven at 91, partial at 88.
const freshShort = {
  direction: 'short',
  entry_price: 100,
  stop_price: 106,
  qty: 10,
  initial_risk: 6,
  trailing_stop_active: 0,
  partial_exit_done: 0,
};

test('long trailing stop state machine transitions in order', () => {
  assert.deepEqual(trailingStopActions(freshLong, 105, cfg), []); // below 1.5R

  const be = trailingStopActions(freshLong, 109, cfg); // exactly 1.5R
  assert.equal(be.length, 1);
  assert.deepEqual(be[0], { action: 'breakeven', newStop: 100 });

  const both = trailingStopActions(freshLong, 112, cfg); // 2.0R: breakeven + partial in one move
  assert.deepEqual(both.map((a) => a.action), ['breakeven', 'partial_exit']);
  assert.equal(both[1].closeQty, 5); // 50% of 10
  assert.equal(both[1].newTp, 124); // entry + 4.0R = 100 + 24

  // already at breakeven: only the partial remains
  const armed = { ...freshLong, trailing_stop_active: 1, stop_price: 100 };
  assert.deepEqual(trailingStopActions(armed, 112, cfg).map((a) => a.action), ['partial_exit']);

  // fully processed: nothing more to do
  const done = { ...armed, partial_exit_done: 1, qty: 5 };
  assert.deepEqual(trailingStopActions(done, 130, cfg), []);

  assert.deepEqual(trailingStopActions(freshLong, 130, { ...cfg, trailingStopEnabled: false }), []);
});

test('short trailing stop mirrors the long state machine', () => {
  assert.deepEqual(trailingStopActions(freshShort, 95, cfg), []); // only 5/6 R favorable
  // an ADVERSE move never arms anything
  assert.deepEqual(trailingStopActions(freshShort, 105, cfg), []);

  const be = trailingStopActions(freshShort, 91, cfg); // exactly 1.5R favorable (down)
  assert.deepEqual(be, [{ action: 'breakeven', newStop: 100 }]);

  const both = trailingStopActions(freshShort, 88, cfg); // 2.0R favorable
  assert.deepEqual(both.map((a) => a.action), ['breakeven', 'partial_exit']);
  assert.equal(both[1].closeQty, 5);
  assert.equal(both[1].newTp, 76); // entry - 4.0R = 100 - 24

  const done = { ...freshShort, trailing_stop_active: 1, stop_price: 100, partial_exit_done: 1, qty: 5 };
  assert.deepEqual(trailingStopActions(done, 70, cfg), []);
});

test('legacy rows without initial_risk derive R from entry/stop (pre-breakeven only)', () => {
  const legacyLong = { ...freshLong, initial_risk: null };
  assert.deepEqual(trailingStopActions(legacyLong, 109, cfg)[0], { action: 'breakeven', newStop: 100 });
  const legacyShort = { ...freshShort, initial_risk: null };
  assert.deepEqual(trailingStopActions(legacyShort, 91, cfg)[0], { action: 'breakeven', newStop: 100 });
  // once the stop has moved, R is unrecoverable without initial_risk -> no action
  const moved = { ...legacyLong, trailing_stop_active: 1, stop_price: 100 };
  assert.deepEqual(trailingStopActions(moved, 130, cfg), []);
});

test('long partial exit math: wallet, margin, fee scaling, and total P&L stay consistent', () => {
  const db = openDb(':memory:');
  // open long 2 @ 100 (3x), $0.20 entry fee -> only the fee leaves the wallet
  const id = openTrade({ pair: 'BTCUSDT', direction: 'long', qty: 2, fillPrice: 100, fee: 0.2, stopPrice: 94, tpPrice: 115, leverage: 3 }, db);
  assert.ok(Math.abs(getCash(db) - 999.8) < 1e-9);
  let row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  assert.equal(row.initial_risk, 6); // stored R distance
  assert.ok(Math.abs(row.margin - 200 / 3) < 1e-9); // isolated margin locked
  assert.ok(Math.abs(getMarginLocked(db) - 200 / 3) < 1e-9);

  // close 1 @ 112 with $0.112 fee:
  // price pnl = 12; wallet += 12 - 0.112; reported leg pnl also carries the
  // entry-fee share 0.1 -> 11.788
  const partialPnl = partialCloseTrade(id, { sellQty: 1, fillPrice: 112, fee: 0.112 }, db);
  assert.ok(Math.abs(partialPnl - 11.788) < 1e-9);
  row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  assert.equal(row.qty, 1);
  assert.equal(row.remainder_qty, 1);
  assert.equal(row.partial_exit_done, 1);
  assert.ok(Math.abs(row.entry_fee - 0.1) < 1e-9); // scaled to the remainder
  assert.ok(Math.abs(row.margin - 100 / 3) < 1e-9); // margin released proportionally
  assert.ok(Math.abs(row.partial_pnl - 11.788) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (999.8 + 11.888)) < 1e-9);

  // close remainder @ 124 with $0.124 fee:
  // remainder pnl = 24 - 0.124 - 0.1 = 23.776; total = + partial = 35.564
  const pnl = closeTrade(id, { fillPrice: 124, fee: 0.124, reason: 'tp' }, db);
  assert.ok(Math.abs(pnl - 35.564) < 1e-9);
  // invariant: wallet = starting balance + total trade P&L; margin fully released
  assert.ok(Math.abs(getCash(db) - (1000 + 35.564)) < 1e-9);
  assert.equal(getMarginLocked(db), 0);
  db.close();
});

test('short partial exit math mirrors the long side', () => {
  const db = openDb(':memory:');
  // open short 2 @ 100 (3x), $0.20 entry fee, stop 106, tp 85
  const id = openTrade({ pair: 'ETHUSDT', direction: 'short', qty: 2, fillPrice: 100, fee: 0.2, stopPrice: 106, tpPrice: 85, leverage: 3 }, db);
  assert.ok(Math.abs(getCash(db) - 999.8) < 1e-9);
  assert.equal(db.prepare('SELECT initial_risk FROM trades WHERE id = ?').get(id).initial_risk, 6);

  // price falls to 88: close 1 with $0.088 fee
  // price pnl = (100 - 88) * 1 = 12; reported leg pnl = 12 - 0.088 - 0.1 = 11.812
  const partialPnl = partialCloseTrade(id, { sellQty: 1, fillPrice: 88, fee: 0.088 }, db);
  assert.ok(Math.abs(partialPnl - 11.812) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (999.8 + 11.912)) < 1e-9);

  // close remainder @ 76 with $0.076 fee:
  // remainder pnl = 24 - 0.076 - 0.1 = 23.824; total = 35.636
  const pnl = closeTrade(id, { fillPrice: 76, fee: 0.076, reason: 'tp' }, db);
  assert.ok(Math.abs(pnl - 35.636) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (1000 + 35.636)) < 1e-9);

  const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  assert.equal(row.direction, 'short');
  assert.equal(row.status, 'closed');
  db.close();
});

test('a losing short debits the wallet by exactly the reported loss', () => {
  const db = openDb(':memory:');
  const id = openTrade({ pair: 'BTCUSDT', direction: 'short', qty: 1, fillPrice: 100, fee: 0.1, stopPrice: 106, tpPrice: 85, leverage: 3 }, db);
  // stopped out at 106: price pnl = -6; pnl = -6 - 0.106 - 0.1 = -6.206
  const pnl = closeTrade(id, { fillPrice: 106, fee: 0.106, reason: 'stop' }, db);
  assert.ok(Math.abs(pnl - -6.206) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (1000 - 6.206)) < 1e-9);
  db.close();
});

test('closing a trade with regime data records a regime_accuracy row (short included)', () => {
  const db = openDb(':memory:');
  const id = openTrade(
    { pair: 'ETHUSDT', direction: 'short', qty: 1, fillPrice: 100, fee: 0.1, stopPrice: 106, tpPrice: 85, regimeAtEntry: 'bearish', confidenceAtEntry: 72 },
    db,
  );
  closeTrade(id, { fillPrice: 90, fee: 0.09, reason: 'tp' }, db);
  const row = db.prepare('SELECT * FROM regime_accuracy').get();
  assert.equal(row.pair, 'ETHUSDT');
  assert.equal(row.regime_at_entry, 'bearish');
  assert.equal(row.confidence_at_entry, 72);
  assert.ok(row.actual_return_pct > 0, 'a profitable short is a CORRECT bearish call');
  db.close();
});
