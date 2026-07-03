// End-to-end rule-engine behavior for the futures-specific paths: short
// entries, the no-simultaneous-long-and-short guarantee, the liquidation
// buffer, and the leverage-exposure cap — all through runPairRules with a
// fake executor (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { chooseDirection, dynamicRsiBounds, runPairRules } from '../src/engine/rules.js';
import { getMarginLocked, getOpenPosition } from '../src/engine/portfolio.js';

const fakeExecutor = {
  async openPosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 1 };
  },
  async closePosition(pair, direction, qty, marketPrice) {
    return { pair, fillPrice: marketPrice, fee: 0, executedQty: qty, orderId: 2 };
  },
};

// Baseline futures config for these tests: fixed leverage 3, filters that the
// inputs below satisfy, weekend filter off so runs don't depend on wall-clock.
const cfg = {
  ...config,
  leverage: 3,
  maxPositions: 2,
  weekendFilterEnabled: false,
  volTargetingEnabled: false,
  exposureCapFraction: 0.5,
  liqBufferMult: 1.25,
  maintMarginRate: 0.005,
};

const bearish = { regime: 'bearish', confidence: 72, trade_allowed: true };
const bullish = { regime: 'bullish', confidence: 72, trade_allowed: true };

const shortSetup = {
  pair: 'SOLUSDT',
  price: 100,
  atr1h: 4, // stop dist 6 -> stop 106, tp 90
  rsi1h: 45,
  ema50_4h: 105,
  dailyEma50: 110,
  volumeRatio: 1.2,
  executor: fakeExecutor,
  cfg,
};

test('chooseDirection maps regimes to sides', () => {
  assert.equal(chooseDirection(bullish), 'long');
  assert.equal(chooseDirection(bearish), 'short');
  assert.equal(chooseDirection({ regime: 'chop', confidence: 90 }), null);
  assert.equal(chooseDirection(null), null);
});

test('dynamic RSI short zones mirror the long zones around 50', () => {
  const ascending = Array.from({ length: 100 }, (_, i) => i + 1); // high vol
  assert.deepEqual(dynamicRsiBounds(ascending, cfg), {
    long: { min: 42, max: 75 },
    short: { min: 25, max: 58 },
  });
  const descending = Array.from({ length: 100 }, (_, i) => 100 - i); // low vol
  assert.deepEqual(dynamicRsiBounds(descending, cfg), {
    long: { min: 48, max: 65 },
    short: { min: 35, max: 52 },
  });
  assert.deepEqual(dynamicRsiBounds([1, 2, 3], cfg).short, { min: cfg.rsiShortEntryMin, max: cfg.rsiShortEntryMax });
});

test('a bearish regime opens a SHORT with mirrored stop/tp and locked margin', async () => {
  const db = openDb(':memory:');
  const actions = await runPairRules({ ...shortSetup, regime: bearish, db });
  const open = actions.find((a) => a.type === 'open');
  assert.ok(open, `expected an open action, got ${JSON.stringify(actions)}`);
  assert.equal(open.direction, 'short');
  assert.equal(open.leverage, 3);
  // stop = entry + 1.5*ATR, tp = entry - 2.5*ATR
  assert.ok(Math.abs(open.stop - 106) < 1e-9);
  assert.ok(Math.abs(open.tp - 90) < 1e-9);
  // risk sizing: 1% of 1000 = $10 over a $6 stop -> qty 1.667
  assert.ok(Math.abs(open.qty - 10 / 6) < 1e-9);

  const pos = getOpenPosition('SOLUSDT', db);
  assert.equal(pos.direction, 'short');
  assert.equal(pos.leverage, 3);
  // isolated margin = notional / leverage
  assert.ok(Math.abs(pos.margin - (open.qty * 100) / 3) < 1e-9);
  assert.ok(Math.abs(getMarginLocked(db) - pos.margin) < 1e-9);
  db.close();
});

test('no simultaneous long + short on one symbol: an open short blocks a long entry', async () => {
  const db = openDb(':memory:');
  await runPairRules({ ...shortSetup, regime: bearish, db });
  assert.ok(getOpenPosition('SOLUSDT', db));

  // regime flips bullish but UNDER the flip-confidence threshold: the short
  // stays open, and the long entry is refused because the symbol is taken
  const weakBull = { regime: 'bullish', confidence: 65, trade_allowed: true };
  const actions = await runPairRules({
    ...shortSetup, price: 104, rsi1h: 55, ema50_4h: 100, dailyEma50: 95, regime: weakBull, db,
  });
  assert.equal(getOpenPosition('SOLUSDT', db).direction, 'short', 'short still open');
  const noEntry = actions.find((a) => a.type === 'no_entry');
  assert.equal(noEntry.reason, 'position_open');
  db.close();
});

test('a strong bullish flip CLOSES the short (and only then could a long open)', async () => {
  const db = openDb(':memory:');
  await runPairRules({ ...shortSetup, regime: bearish, db });

  const strongBull = { regime: 'bullish', confidence: 80, trade_allowed: true };
  // price still between stop (106) and tp (90) so only the flip can close it
  const actions = await runPairRules({ ...shortSetup, price: 102, regime: strongBull, db });
  const close = actions.find((a) => a.type === 'close');
  assert.ok(close, 'short closed on bullish regime flip');
  assert.equal(close.reason, 'regime_flip');
  assert.equal(close.direction, 'short');
  assert.equal(getOpenPosition('SOLUSDT', db), undefined);
  db.close();
});

test('short stop-out debits equity and starts the cooldown', async () => {
  const db = openDb(':memory:');
  // tighter ATR (stop dist 3%) so the stop fires before the 5% emergency exit
  const tight = { ...shortSetup, atr1h: 2 }; // short @ 100, stop 103, tp 95
  await runPairRules({ ...tight, regime: bearish, db });
  // price rises through the stop at 103
  const actions = await runPairRules({ ...tight, price: 103.5, regime: bearish, db });
  const close = actions.find((a) => a.type === 'close');
  assert.equal(close.reason, 'stop');
  assert.ok(close.pnl < 0);
  // immediately after a stop-out the pair is in cooldown
  const retry = await runPairRules({ ...tight, regime: bearish, db });
  assert.equal(retry.find((a) => a.type === 'no_entry').reason, 'cooldown');
  db.close();
});

test('liquidation buffer reduces size on entry and logs SIZE_REDUCED_FOR_LIQ_BUFFER', async () => {
  const db = openDb(':memory:');
  // Enormous ATR: stop distance 30% of price. At 5x the liquidation (~19.5%
  // away) would sit INSIDE the stop -> size must shrink until the stop fires
  // first.
  const wide = { ...shortSetup, atr1h: 20, cfg: { ...cfg, leverage: 5 } };
  const actions = await runPairRules({ ...wide, regime: bearish, db });
  const open = actions.find((a) => a.type === 'open');
  assert.ok(open, `expected an open action, got ${JSON.stringify(actions)}`);
  const ev = db.prepare("SELECT detail FROM events WHERE type = 'SIZE_REDUCED_FOR_LIQ_BUFFER'").get();
  assert.ok(ev, 'reduction event logged');
  const detail = JSON.parse(ev.detail);
  assert.ok(detail.reducedQty < detail.originalQty);
  assert.ok(Math.abs(open.qty - detail.reducedQty) < 1e-12);
  db.close();
});

test('leverage-exposure cap blocks entries past half the leveraged buying power', async () => {
  const db = openDb(':memory:');
  // Tiny cap fraction: equity 1000 * leverage 3 * 0.01 = $30 cap, while the
  // risk-sized notional is ~$167 -> blocked.
  const capped = { ...shortSetup, cfg: { ...cfg, exposureCapFraction: 0.01 } };
  const actions = await runPairRules({ ...capped, regime: bearish, db });
  assert.equal(actions.find((a) => a.type === 'no_entry').reason, 'leverage_exposure_cap');
  assert.ok(db.prepare("SELECT id FROM events WHERE type = 'LEVERAGE_EXPOSURE_CAP'").get());
  assert.equal(getOpenPosition('SOLUSDT', db), undefined);
  db.close();
});

test('short trailing sequence: breakeven, partial, extended tp — all mirrored down', async () => {
  const db = openDb(':memory:');
  await runPairRules({ ...shortSetup, regime: bearish, db }); // short 1.667 @ 100, R=6
  // price falls 2R to 88: breakeven + partial in one move
  const actions = await runPairRules({ ...shortSetup, price: 88, regime: bearish, db });
  assert.deepEqual(actions.filter((a) => a.type !== 'no_entry').map((a) => a.type), ['breakeven', 'partial_exit']);
  const pos = getOpenPosition('SOLUSDT', db);
  assert.equal(pos.stop_price, 100, 'stop moved down-to... entry (breakeven)');
  assert.ok(Math.abs(pos.tp_price - 76) < 1e-9, 'runner targets entry - 4R');
  assert.ok(Math.abs(pos.qty - (10 / 6) * 0.5) < 1e-9, 'half closed');
  const partial = actions.find((a) => a.type === 'partial_exit');
  assert.ok(partial.partialPnl > 0, 'partial on a falling price is a WIN for a short');
  db.close();
});
