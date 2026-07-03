import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  assertFuturesTestnetBase,
  createMockFuturesFetch,
  FUTURES_TESTNET_BASE,
  FuturesTestnetExecutor,
  roundToStep,
  sign,
} from '../src/engine/futuresTestnetExecutor.js';

function makeExecutor(overrides = {}) {
  const db = openDb(':memory:');
  const fetchImpl = overrides.fetchImpl ?? createMockFuturesFetch(overrides.mockOpts);
  const ex = new FuturesTestnetExecutor({ apiKey: 'test-key', apiSecret: 'test-secret', leverage: overrides.leverage ?? 3, fetchImpl, db });
  return { ex, db, fetchImpl };
}

test('HMAC-SHA256 signing matches the Binance docs test vector', () => {
  const qs = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  assert.equal(sign(qs, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('quantity rounding floors to stepSize and never rounds up', () => {
  assert.equal(roundToStep(0.123456, '0.001'), 0.123);
  assert.equal(roundToStep(0.0895, '0.01'), 0.08);
  assert.equal(roundToStep(1.999999, '0.001'), 1.999);
  assert.equal(roundToStep(5.999, '1'), 5);
  // exact multiples survive float division
  assert.equal(roundToStep(0.0042, '0.0001'), 0.0042);
});

test('mainnet guard: refuses any non-testnet base URL', () => {
  assert.ok(FUTURES_TESTNET_BASE.includes('testnet'));
  assert.equal(FUTURES_TESTNET_BASE, 'https://testnet.binancefuture.com');
  assert.equal(assertFuturesTestnetBase(FUTURES_TESTNET_BASE), FUTURES_TESTNET_BASE);
  assert.throws(() => assertFuturesTestnetBase('https://fapi.binance.com'), /refuses non-testnet/);
  assert.throws(() => assertFuturesTestnetBase('https://api.binance.com'), /refuses non-testnet/);
  assert.throws(() => assertFuturesTestnetBase(''), /refuses non-testnet/);
});

test('constructor requires futures testnet API keys', () => {
  assert.throws(
    () => new FuturesTestnetExecutor({ apiKey: '', apiSecret: '', fetchImpl: createMockFuturesFetch() }),
    /BINANCE_FUTURES_TESTNET_API_KEY/,
  );
});

test('init forces one-way mode, sets leverage and ISOLATED margin per symbol', async () => {
  const { ex, db, fetchImpl } = makeExecutor();
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  assert.equal(fetchImpl.counters.positionSide, 1, 'one-way mode set once');
  assert.equal(fetchImpl.counters.leverage, 2, 'leverage set for each symbol');
  assert.equal(fetchImpl.counters.marginType, 2, 'margin type set for each symbol');
  assert.deepEqual(fetchImpl.leverageSet, { BTCUSDT: 3, ETHUSDT: 3 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'LEVERAGE_SET'").get().n, 2);
  db.close();
});

test('init tolerates -4046 (margin type already ISOLATED)', async () => {
  const { ex, db } = makeExecutor({ mockOpts: { marginTypeAlreadySet: true } });
  await ex.init(['BTCUSDT', 'ETHUSDT']); // must not throw
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'LEVERAGE_SET'").get().n, 2);
  db.close();
});

test('below-min-notional order is skipped, never rounded up', async () => {
  const { ex, db } = makeExecutor({ mockOpts: { prices: { BTCUSDT: 15000, ETHUSDT: 2670 } } });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  // 0.001 BTC * 15000 = $15 < $20 min notional
  const fill = await ex.openPosition('BTCUSDT', 'long', 0.0013, 15000);
  assert.equal(fill.skipped, 'below_min_notional');
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'ORDER_BELOW_MIN_NOTIONAL'").get());
  // no order was sent to the exchange
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  db.close();
});

test('opening a LONG is a BUY that records real fill data and an audit row', async () => {
  const { ex, db } = makeExecutor();
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const fill = await ex.openPosition('BTCUSDT', 'long', 0.00374, 66842);
  assert.equal(fill.skipped, undefined);
  assert.equal(fill.executedQty, 0.003); // floored to 0.001 step
  assert.equal(fill.fillPrice, 66900); // mock book price, not the signal
  assert.ok(fill.orderId >= 5000);
  // fee = taker rate on filled notional
  assert.ok(Math.abs(fill.fee - 0.003 * 66900 * 0.0004) < 1e-9);

  const row = db.prepare('SELECT * FROM orders').get();
  assert.equal(row.pair, 'BTCUSDT');
  assert.equal(row.side, 'BUY');
  assert.equal(row.direction, 'long');
  assert.equal(row.status, 'FILLED');
  assert.equal(row.signal_price, 66842);
  assert.equal(row.fill_price, 66900);
  db.close();
});

test('opening a SHORT is a SELL; closing it is a reduce-only BUY', async () => {
  const { ex, db } = makeExecutor();
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const open = await ex.openPosition('ETHUSDT', 'short', 0.08, 2665);
  assert.equal(open.skipped, undefined);
  assert.equal(open.executedQty, 0.08);
  const openRow = db.prepare('SELECT * FROM orders WHERE id = 1').get();
  assert.equal(openRow.side, 'SELL');
  assert.equal(openRow.direction, 'short');
  assert.equal(JSON.parse(openRow.raw_json).request.reduceOnly, undefined);

  const close = await ex.closePosition('ETHUSDT', 'short', 0.08, 2660);
  assert.equal(close.skipped, undefined);
  const closeRow = db.prepare('SELECT * FROM orders WHERE id = 2').get();
  assert.equal(closeRow.side, 'BUY');
  assert.equal(JSON.parse(closeRow.raw_json).request.reduceOnly, 'true', 'a close can never flip the position');
  db.close();
});

test('-1021 timestamp error triggers one resync and a retry that succeeds', async () => {
  const fetchImpl = createMockFuturesFetch({
    failFirstOrderWith: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' },
  });
  const { ex, db } = makeExecutor({ fetchImpl });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const timeCallsBefore = fetchImpl.counters.time;

  const fill = await ex.openPosition('BTCUSDT', 'long', 0.004, 66900);
  assert.equal(fill.skipped, undefined);
  assert.ok(fill.orderId, 'order eventually filled');
  assert.equal(fetchImpl.counters.order, 2, 'order endpoint hit twice (fail + retry)');
  assert.equal(fetchImpl.counters.time, timeCallsBefore + 1, 'time was resynced exactly once');
  db.close();
});

test('-2019 (margin insufficient) skips the order instead of crashing the loop', async () => {
  const fetchImpl = createMockFuturesFetch({
    failFirstOrderWith: { code: -2019, msg: 'Margin is insufficient.' },
  });
  const { ex, db } = makeExecutor({ fetchImpl });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  const fill = await ex.openPosition('BTCUSDT', 'long', 0.004, 66900);
  assert.equal(fill.skipped, 'margin_insufficient');
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'ORDER_REJECTED_MARGIN_INSUFFICIENT'").get());
  db.close();
});

test('reconcile flags STATE_MISMATCH when the exchange wallet disagrees with local cash', async () => {
  // local cash starts at 1000 (fresh portfolio); exchange reports 700
  const { ex, db } = makeExecutor({ mockOpts: { walletBalance: 700 } });
  await ex.init(['BTCUSDT', 'ETHUSDT']);
  assert.equal(await ex.reconcile(db), false);
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'STATE_MISMATCH'").get();
  const detail = JSON.parse(ev.detail);
  assert.equal(detail.localCash, 1000);
  assert.equal(detail.exchangeWallet, 700);

  // and agrees when balances match
  const { ex: ex2, db: db2 } = makeExecutor({ mockOpts: { walletBalance: 1000 } });
  await ex2.init(['BTCUSDT', 'ETHUSDT']);
  assert.equal(await ex2.reconcile(db2), true);
  db.close();
  db2.close();
});
