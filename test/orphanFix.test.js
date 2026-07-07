// Regression locks for the NEARUSDT incident (2026-07-05/06): the real
// futures TESTNET omits avgPrice/cumQuote from RESULT order responses, which
// produced NaN fills -> NaN fees -> "NOT NULL constraint failed:
// portfolio.cash" AFTER the exchange order had already filled — leaving
// unmanaged orphan positions on the exchange with no stop and no local row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createMockFuturesFetch, FuturesTestnetExecutor } from '../src/engine/futuresTestnetExecutor.js';
import { getCash, openTrade, setCash } from '../src/engine/portfolio.js';

function makeExecutor(mockOpts = {}) {
  const db = openDb(':memory:');
  const fetchImpl = createMockFuturesFetch(mockOpts);
  const ex = new FuturesTestnetExecutor({ apiKey: 'test-key', apiSecret: 'test-secret', leverage: 3, fetchImpl, db });
  return { ex, db, fetchImpl };
}

test('a RESULT response without avgPrice/cumQuote yields a finite fill (signal-price fallback)', async () => {
  const { ex, db } = makeExecutor({ omitAvgPrice: true });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const fill = await ex.openPosition('BTCUSDT', 'long', 0.004, 66842);
  assert.equal(fill.skipped, undefined);
  assert.ok(Number.isFinite(fill.fillPrice), `fillPrice must be finite, got ${fill.fillPrice}`);
  assert.equal(fill.fillPrice, 66842, 'falls back to the signal price when the response omits both');
  assert.ok(Number.isFinite(fill.fee) && fill.fee > 0, `fee must be finite, got ${fill.fee}`);
  assert.ok(Math.abs(fill.fee - 0.004 * 66842 * 0.0004) < 1e-9);

  // and the whole trade can be booked without tripping the cash constraint
  const id = openTrade(
    { pair: 'BTCUSDT', direction: 'long', qty: fill.executedQty, fillPrice: fill.fillPrice, fee: fill.fee, stopPrice: 66000, tpPrice: 68000, leverage: 3 },
    db,
  );
  assert.ok(id > 0);
  assert.ok(Number.isFinite(getCash(db)));
  db.close();
});

test('setCash refuses non-finite values loudly (no more silent NULL binds)', () => {
  const db = openDb(':memory:');
  assert.throws(() => setCash(NaN, db), /non-finite cash/);
  assert.throws(() => setCash(undefined, db), /non-finite cash/);
  assert.ok(Math.abs(getCash(db) - 1000) < 1e-9, 'cash untouched by the rejected writes');
  db.close();
});

test('reconcile flattens orphan exchange positions with a reduce-only market order', async () => {
  // exchange holds 1862 NEAR long; local trades table has nothing
  const { ex, db, fetchImpl } = makeExecutor({
    prices: { BTCUSDT: 66900, ETHUSDT: 2670, NEARUSDT: 1.97 },
    positions: [{ symbol: 'NEARUSDT', positionAmt: 1862 }],
    walletBalance: 1000,
  });
  await ex.init(['BTCUSDT', 'ETHUSDT', 'NEARUSDT']);
  const ordersBefore = fetchImpl.counters.order;

  const clean = await ex.reconcile(db);
  assert.equal(clean, false, 'a cycle that had to flatten an orphan blocks new entries');
  assert.equal(fetchImpl.counters.order, ordersBefore + 1, 'exactly one flattening order sent');
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'ORPHAN_POSITION_CLOSED'").get();
  assert.ok(ev, 'orphan close is logged');
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.symbol, 'NEARUSDT');
  assert.equal(detail.positionAmt, 1862);
  db.close();
});

test('reconcile leaves positions alone when they match a local open trade', async () => {
  const { ex, db, fetchImpl } = makeExecutor({
    prices: { BTCUSDT: 66900, ETHUSDT: 2670 },
    positions: [{ symbol: 'ETHUSDT', positionAmt: -0.09 }], // short we actually hold
    walletBalance: 1000,
  });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  openTrade({ pair: 'ETHUSDT', direction: 'short', qty: 0.09, fillPrice: 2670, fee: 0.1, stopPrice: 2702, tpPrice: 2617, leverage: 3 }, db);
  setCash(1000, db); // keep the wallet aligned with the mock for the drift check
  const ordersBefore = fetchImpl.counters.order;

  const clean = await ex.reconcile(db);
  assert.equal(fetchImpl.counters.order, ordersBefore, 'no flattening order for a tracked position');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ORPHAN_POSITION_CLOSED'").get().n, 0);
  assert.equal(clean, true);
  db.close();
});

test('reconcile adopts the exchange wallet on drift (STATE_RESYNCED) and blocks the cycle', async () => {
  const { ex, db } = makeExecutor({ walletBalance: 987.65 }); // local starts at 1000
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const clean = await ex.reconcile(db);
  assert.equal(clean, false);
  assert.ok(Math.abs(getCash(db) - 987.65) < 1e-9, 'exchange wallet adopted as local cash');
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'STATE_RESYNCED'").get();
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.localCash, 1000);
  assert.equal(detail.exchangeWallet, 987.65);
  db.close();
});

test('rejected entries persist NO_ENTRY events with the reason', async () => {
  const { openDb: _ } = {};
  const db = openDb(':memory:');
  const { runPairRules } = await import('../src/engine/rules.js');
  const { config } = await import('../src/config.js');
  const cfg = { ...config, weekendFilterEnabled: false, volTargetingEnabled: false };
  const executor = {
    async openPosition() { throw new Error('should not be called'); },
    async closePosition() { throw new Error('should not be called'); },
  };
  // chop regime -> no direction
  await runPairRules({ pair: 'BTCUSDT', price: 100, atr1h: 4, rsi1h: 50, ema50_4h: 100, regime: { regime: 'chop', confidence: 90, trade_allowed: false }, executor, cfg, db });
  // bearish but RSI oversold -> rsi_out_of_band
  await runPairRules({ pair: 'ETHUSDT', price: 95, atr1h: 4, rsi1h: 20, ema50_4h: 100, dailyEma50: 110, volumeRatio: 1.2, regime: { regime: 'bearish', confidence: 72, trade_allowed: true }, executor, cfg, db });
  const events = db.prepare("SELECT detail FROM events WHERE type = 'NO_ENTRY' ORDER BY id").all().map((r) => JSON.parse(r.detail));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { pair: 'BTCUSDT', reason: 'no_directional_regime' });
  assert.deepEqual(events[1], { pair: 'ETHUSDT', reason: 'rsi_out_of_band', direction: 'short' });
  db.close();
});
