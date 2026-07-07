// Regression lock: a pair holding an OPEN position must be managed (exits run)
// even when it has dropped out of the liquidity-filtered activePairs set.
// Before the fix, runCycle iterated only activePairs, so a filtered-out
// position was stranded with no stop/TP — on leverage, a path to liquidation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { openTrade, getOpenPosition } from '../src/engine/portfolio.js';
import { runCycle, __setActivePairs, __setExecutor } from '../src/index.js';

// Minimal executor: fills any close at the signal price, no network.
const fakeExecutor = {
  async openPosition(pair, direction, qty, price) {
    return { pair, fillPrice: price, fee: 0, executedQty: qty, orderId: 1 };
  },
  async closePosition(pair, direction, qty, price) {
    return { pair, fillPrice: price, fee: 0, executedQty: qty, orderId: 2 };
  },
};

test('an open position on a liquidity-filtered pair still gets its exit managed', async () => {
  const origMock = config.mock;
  const origDbPath = config.dbPath;
  config.mock = true; // deterministic mock klines/regime, zero network
  config.dbPath = ':memory:'; // skip the on-disk backup side effect
  const db = openDb(':memory:');

  // Seed an open LONG on BTCUSDT with a stop ABOVE the mock price (~66900),
  // so the exit check must fire a stop-out the moment the pair is evaluated.
  const id = openTrade(
    { pair: 'BTCUSDT', direction: 'long', qty: 0.003, fillPrice: 66900, fee: 0, stopPrice: 70000, tpPrice: 80000, leverage: 3 },
    db,
  );
  assert.ok(getOpenPosition('BTCUSDT', db), 'position open before the cycle');

  // BTCUSDT is NOT in the liquid entry set — only ETHUSDT is. Pre-fix, the
  // BTC position would never be looked at.
  __setActivePairs(['ETHUSDT']);
  __setExecutor(fakeExecutor);
  try {
    await runCycle(db);
    // the stranded pair was flagged for exit-only management...
    const ev = db.prepare("SELECT detail FROM events WHERE type = 'MANAGING_ILLIQUID_POSITION'").get();
    assert.ok(ev, 'MANAGING_ILLIQUID_POSITION logged');
    assert.match(ev.detail, /BTCUSDT/);
    // ...and the stop actually executed, so the position is now closed
    assert.equal(getOpenPosition('BTCUSDT', db), undefined, 'stranded position was closed, not left unmanaged');
    const closed = db.prepare("SELECT exit_reason FROM trades WHERE id = ?").get(id);
    assert.equal(closed.exit_reason, 'stop');
  } finally {
    config.mock = origMock;
    config.dbPath = origDbPath;
    __setActivePairs(config.pairs);
    __setExecutor(null);
    db.close();
  }
});

test('a liquidity-filtered pair with an open position cannot take a NEW entry the same cycle', async () => {
  const origMock = config.mock;
  const origDbPath = config.dbPath;
  config.mock = true;
  config.dbPath = ':memory:';
  const db = openDb(':memory:');

  // Open BTCUSDT long that will stop out this cycle (stop above price). After
  // it closes, the entry gate must NOT re-open on this illiquid pair.
  openTrade(
    { pair: 'BTCUSDT', direction: 'long', qty: 0.003, fillPrice: 66900, fee: 0, stopPrice: 70000, tpPrice: 80000, leverage: 3 },
    db,
  );
  __setActivePairs(['ETHUSDT']); // BTC illiquid
  __setExecutor(fakeExecutor);
  try {
    await runCycle(db);
    assert.equal(getOpenPosition('BTCUSDT', db), undefined, 'closed and not re-entered');
    // exactly one BTC trade ever existed (the seed) — no new entry was opened
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trades WHERE pair = 'BTCUSDT'").get().n, 1);
  } finally {
    config.mock = origMock;
    config.dbPath = origDbPath;
    __setActivePairs(config.pairs);
    __setExecutor(null);
    db.close();
  }
});
