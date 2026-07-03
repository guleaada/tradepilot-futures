// Regression lock on indicator math against a fixed synthetic dataset.
//
// Dataset (100 candles, i = 0..99):
//   close_i = 100 + 10*sin(i/7) + 0.3*i
//   high_i  = close_i + 1.5,  low_i = close_i - 1.5,  open_i = close_{i-1}
//
// Expected values were derived independently from the textbook definitions
// (not by calling indicators.js):
//   EMA(50):  seed = SMA(close_0..close_49), then E = c*k + E*(1-k), k = 2/51
//   RSI(14):  Wilder — seed avgGain/avgLoss = mean of first 14 up/down moves,
//             then avg' = (avg*13 + move)/14; RSI = 100 - 100/(1 + RS)
//   ATR(14):  Wilder — TR = max(h-l, |h-pc|, |l-pc|), seed = SMA(TR_1..TR_14),
//             then ATR' = (ATR*13 + TR)/14
// Reference run output:
//   EMA50 = 123.5083441339   RSI14 = 91.0455711948   ATR14 = 3.0417887988
import test from 'node:test';
import assert from 'node:assert/strict';
import { atr, ema, last, rsi } from '../src/indicators.js';

function dataset() {
  const candles = [];
  let prev = null;
  for (let i = 0; i < 100; i++) {
    const close = 100 + 10 * Math.sin(i / 7) + 0.3 * i;
    candles.push({ open: prev ?? close, high: close + 1.5, low: close - 1.5, close });
    prev = close;
  }
  return candles;
}

test('EMA(50) regression matches the independently derived value', () => {
  const closes = dataset().map((c) => c.close);
  assert.ok(Math.abs(last(ema(closes, 50)) - 123.5083441339) < 1e-9);
});

test('RSI(14) regression matches the independently derived value', () => {
  const closes = dataset().map((c) => c.close);
  assert.ok(Math.abs(last(rsi(closes, 14)) - 91.0455711948) < 1e-9);
});

test('ATR(14) regression matches the independently derived value', () => {
  assert.ok(Math.abs(last(atr(dataset(), 14)) - 3.0417887988) < 1e-9);
});
