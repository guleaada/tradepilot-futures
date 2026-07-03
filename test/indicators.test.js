import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, ema, last, rsi, sma, volatility } from '../src/indicators.js';

test('EMA matches hand-computed values', () => {
  // period 3, k = 0.5; seed = SMA(2,4,6) = 4; next: 8*0.5 + 4*0.5 = 6
  const out = ema([2, 4, 6, 8], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 4);
  assert.equal(out[3], 6);
});

test('SMA matches hand-computed values', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test('RSI is 100 for monotonic gains and 0 for monotonic losses', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(last(rsi(up, 14)), 100);
  assert.equal(last(rsi(down, 14)), 0);
});

test('RSI stays strictly between 0 and 100 for mixed series', () => {
  const mixed = Array.from({ length: 60 }, (_, i) => 100 + 5 * Math.sin(i / 3) + 0.2 * i);
  const value = last(rsi(mixed, 14));
  assert.ok(value > 0 && value < 100, `rsi=${value}`);
});

test('ATR equals the constant true range when candles are contiguous', () => {
  // high-low = 2 on every candle, opens at prior close -> every TR = 2 -> ATR = 2
  const candles = [];
  let close = 100;
  for (let i = 0; i < 30; i++) {
    candles.push({ high: close + 1, low: close - 1, close });
  }
  assert.ok(Math.abs(last(atr(candles, 14)) - 2) < 1e-9);
});

test('volatility is zero for a flat series and positive for a noisy one', () => {
  const flat = Array(30).fill(100);
  const noisy = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.equal(volatility(flat, 20), 0);
  assert.ok(volatility(noisy, 20) > 0);
});
