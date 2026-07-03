import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { closeTrade, openTrade, pnlForDate } from '../src/engine/portfolio.js';
import { addSpend } from '../src/ai/budget.js';
import { computeDailySummary } from '../src/index.js';

// Open a trade and close it with exit_time stamped on a specific UTC date.
// Alternates direction to prove the daily P&L math is direction-blind.
function closedTradeOn(db, date, pnlSign, direction = 'long') {
  const stop = direction === 'long' ? 90 : 110;
  const tp = direction === 'long' ? 120 : 80;
  const id = openTrade({ pair: 'BTCUSDT', direction, qty: 1, fillPrice: 100, fee: 0, stopPrice: stop, tpPrice: tp, at: `${date}T09:00:00.000Z` }, db);
  // favorable exit -> positive pnl; adverse -> negative (mirrored for shorts)
  const favorable = direction === 'long' ? 110 : 90;
  const adverse = direction === 'long' ? 95 : 105;
  closeTrade(id, { fillPrice: pnlSign > 0 ? favorable : adverse, fee: 0, reason: 'tp', at: `${date}T15:30:00.000Z` }, db);
}

test('pnlForDate sums only trades closed on that UTC date, longs and shorts alike', () => {
  const db = openDb(':memory:');
  closedTradeOn(db, '2026-06-19', +1, 'long'); // +10
  closedTradeOn(db, '2026-06-19', +1, 'short'); // +10 (profitable short)
  closedTradeOn(db, '2026-06-18', -1, 'short'); // -5  (different day, excluded)
  closedTradeOn(db, '2026-06-20', +1, 'long'); // +10 (different day, excluded)
  assert.ok(Math.abs(pnlForDate(db, '2026-06-19') - 20) < 1e-9);
  assert.ok(Math.abs(pnlForDate(db, '2026-06-18') - -5) < 1e-9);
  assert.equal(pnlForDate(db, '2026-06-17'), 0); // no trades that day
  db.close();
});

test('daily summary reports the prior UTC day and is branded FUTURES TESTNET', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-06-20T06:00:00Z'); // morning send time
  addSpend(0.1234, db, '2026-06-19', 'anthropic');
  addSpend(0.0009, db, '2026-06-20', 'anthropic'); // today so far
  closedTradeOn(db, '2026-06-19', +1, 'short'); // +10 realized yesterday

  const s = computeDailySummary(db, now);
  assert.equal(s.today, '2026-06-20');
  assert.equal(s.summaryDate, '2026-06-19');
  assert.ok(Math.abs(s.prevClaude - 0.1234) < 1e-9, 'reads prior-day claude spend');
  assert.ok(Math.abs(s.prevPnl - 10) < 1e-9, 'reads prior-day realized P&L');
  // header must name the executor + leverage so it can never be confused
  // with the spot bot's messages
  assert.match(s.message, /TradePilot-Futures summary for 2026-06-19/);
  assert.match(s.message, /EXECUTOR: FUTURES TESTNET \(\dx leverage\)/);
  assert.match(s.message, /claude \$0\.1234/);
  assert.match(s.message, /today so far/);
  db.close();
});

test('daily summary equity/open positions are live (now), not historical', () => {
  const db = openDb(':memory:');
  const s = computeDailySummary(db, new Date('2026-06-20T06:00:00Z'));
  assert.equal(s.equity, 1000); // fresh portfolio starting balance, point-in-time
  assert.equal(s.open, 0);
  db.close();
});
