import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  applyFunding,
  closeTrade,
  fundingCost,
  getCash,
  lastFundingBoundary,
  openTrade,
  totalFundingPaid,
} from '../src/engine/portfolio.js';
import { applyFundingCosts } from '../src/index.js';

test('funding boundaries are the 8h UTC marks (00:00 / 08:00 / 16:00)', () => {
  const at = (h, m = 0) => Date.UTC(2026, 6, 3, h, m);
  assert.equal(lastFundingBoundary(at(9, 30)), at(8));
  assert.equal(lastFundingBoundary(at(8, 0)), at(8));
  assert.equal(lastFundingBoundary(at(7, 59)), at(0));
  assert.equal(lastFundingBoundary(at(23, 45)), at(16));
});

test('funding sign convention: longs pay positive rates, shorts receive them', () => {
  // qty 2, mark 100, rate +0.01% -> long pays $0.02, short receives $0.02
  assert.ok(Math.abs(fundingCost('long', 2, 100, 0.0001) - 0.02) < 1e-12);
  assert.ok(Math.abs(fundingCost('short', 2, 100, 0.0001) - -0.02) < 1e-12);
  // negative rate flips both
  assert.ok(Math.abs(fundingCost('long', 2, 100, -0.0001) - -0.02) < 1e-12);
  assert.ok(Math.abs(fundingCost('short', 2, 100, -0.0001) - 0.02) < 1e-12);
});

test('applyFunding debits the wallet now and closeTrade folds it into reported P&L', () => {
  const db = openDb(':memory:');
  const id = openTrade({ pair: 'BTCUSDT', direction: 'long', qty: 1, fillPrice: 100, fee: 0, stopPrice: 94, tpPrice: 115, leverage: 3 }, db);
  applyFunding(id, 0.05, '2026-07-03T08:00:00.000Z', db);
  assert.ok(Math.abs(getCash(db) - 999.95) < 1e-9);
  const row = db.prepare('SELECT funding_paid, last_funding_ts FROM trades WHERE id = ?').get(id);
  assert.ok(Math.abs(row.funding_paid - 0.05) < 1e-12);
  assert.equal(row.last_funding_ts, '2026-07-03T08:00:00.000Z');

  // close at +10: reported pnl = 10 - funding 0.05 = 9.95, and the wallet
  // lands at start + pnl exactly (funding already left when it accrued)
  const pnl = closeTrade(id, { fillPrice: 110, fee: 0, reason: 'tp' }, db);
  assert.ok(Math.abs(pnl - 9.95) < 1e-9);
  assert.ok(Math.abs(getCash(db) - (1000 + 9.95)) < 1e-9);
  assert.ok(Math.abs(totalFundingPaid(db) - 0.05) < 1e-12);
  db.close();
});

test('applyFundingCosts charges positions held through a boundary, exactly once', async () => {
  const db = openDb(':memory:');
  const now = Date.UTC(2026, 6, 3, 9, 0); // boundary at 08:00
  // held through the boundary (opened 05:00)
  const heldId = openTrade(
    { pair: 'BTCUSDT', direction: 'long', qty: 2, fillPrice: 100, fee: 0, stopPrice: 94, tpPrice: 115, leverage: 3, at: '2026-07-03T05:00:00.000Z' },
    db,
  );
  // opened AFTER the boundary: must not be charged
  openTrade(
    { pair: 'ETHUSDT', direction: 'short', qty: 1, fillPrice: 50, fee: 0, stopPrice: 53, tpPrice: 42, leverage: 3, at: '2026-07-03T08:30:00.000Z' },
    db,
  );
  const markets = {
    BTCUSDT: { price: 100, fundingRate: 0.0001 },
    ETHUSDT: { price: 50, fundingRate: 0.0001 },
  };

  await applyFundingCosts(markets, db, now);
  let held = db.prepare('SELECT funding_paid FROM trades WHERE id = ?').get(heldId);
  assert.ok(Math.abs(held.funding_paid - 0.02) < 1e-12, 'long pays qty*mark*rate');
  const fresh = db.prepare("SELECT funding_paid FROM trades WHERE pair = 'ETHUSDT'").get();
  assert.equal(fresh.funding_paid, 0, 'position opened after the boundary is not charged');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'FUNDING_APPLIED'").get().n, 1);

  // same cycle again (or a later cycle before the next boundary): no double charge
  await applyFundingCosts(markets, db, now + 15 * 60_000);
  held = db.prepare('SELECT funding_paid FROM trades WHERE id = ?').get(heldId);
  assert.ok(Math.abs(held.funding_paid - 0.02) < 1e-12, 'not charged twice for the same boundary');

  // next boundary passes: charged again
  await applyFundingCosts(markets, db, Date.UTC(2026, 6, 3, 16, 5));
  held = db.prepare('SELECT funding_paid FROM trades WHERE id = ?').get(heldId);
  assert.ok(Math.abs(held.funding_paid - 0.04) < 1e-12);

  // a null rate (endpoint unreachable) skips the charge rather than guessing
  await applyFundingCosts({ BTCUSDT: { price: 100, fundingRate: null } }, db, Date.UTC(2026, 6, 4, 0, 5));
  held = db.prepare('SELECT funding_paid FROM trades WHERE id = ?').get(heldId);
  assert.ok(Math.abs(held.funding_paid - 0.04) < 1e-12);
  db.close();
});
