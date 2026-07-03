import test from 'node:test';
import assert from 'node:assert/strict';
import { entryAllowed, evaluateExit } from '../src/engine/rules.js';

const cfg = {
  regimeFlipConfidence: 70,
  regimeMinConfidence: 60,
  maxPositions: 2,
  rsiEntryMin: 45,
  rsiEntryMax: 70,
  rsiShortEntryMin: 30,
  rsiShortEntryMax: 55,
};

const longPos = { direction: 'long', entry_price: 100, stop_price: 95, tp_price: 110 };
const shortPos = { direction: 'short', entry_price: 100, stop_price: 106, tp_price: 85 };

test('long: stop-loss fires at or below stop price', () => {
  assert.equal(evaluateExit(longPos, 94, null, cfg), 'stop');
  assert.equal(evaluateExit(longPos, 95, null, cfg), 'stop');
  assert.equal(evaluateExit(longPos, 96, null, cfg), null);
});

test('long: take-profit fires at or above tp price', () => {
  assert.equal(evaluateExit(longPos, 110, null, cfg), 'tp');
  assert.equal(evaluateExit(longPos, 120, null, cfg), 'tp');
});

test('short: stop-loss fires at or ABOVE stop price (mirror of long)', () => {
  assert.equal(evaluateExit(shortPos, 107, null, cfg), 'stop');
  assert.equal(evaluateExit(shortPos, 106, null, cfg), 'stop');
  assert.equal(evaluateExit(shortPos, 104, null, cfg), null);
});

test('short: take-profit fires at or BELOW tp price', () => {
  assert.equal(evaluateExit(shortPos, 85, null, cfg), 'tp');
  assert.equal(evaluateExit(shortPos, 80, null, cfg), 'tp');
});

test('regime flip closes only the OPPOSITE direction at confidence >= 70', () => {
  // bearish flip closes longs
  assert.equal(evaluateExit(longPos, 100, { regime: 'bearish', confidence: 80 }, cfg), 'regime_flip');
  assert.equal(evaluateExit(longPos, 100, { regime: 'bearish', confidence: 60 }, cfg), null);
  assert.equal(evaluateExit(longPos, 100, { regime: 'chop', confidence: 90 }, cfg), null);
  // bullish flip closes shorts — a bearish call never closes a short
  assert.equal(evaluateExit(shortPos, 100, { regime: 'bullish', confidence: 80 }, cfg), 'regime_flip');
  assert.equal(evaluateExit(shortPos, 100, { regime: 'bullish', confidence: 60 }, cfg), null);
  assert.equal(evaluateExit(shortPos, 100, { regime: 'bearish', confidence: 95 }, cfg), null);
});

test('emergency exit is direction-aware: adverse 5% move, either side', () => {
  const emCfg = { ...cfg, emergencyExitEnabled: true, emergencyExitDropPct: 0.05 };
  // long 5% under water
  assert.equal(evaluateExit({ ...longPos, stop_price: 90 }, 95, null, emCfg), 'emergency_exit');
  // short 5% under water (price ABOVE entry) — stop set wide so emergency wins
  assert.equal(evaluateExit({ ...shortPos, stop_price: 120 }, 105, null, emCfg), 'emergency_exit');
  // favorable moves never trigger it
  assert.equal(evaluateExit({ ...longPos, stop_price: 90 }, 105, null, emCfg), null);
  assert.equal(evaluateExit({ ...shortPos, stop_price: 120 }, 95, null, emCfg), null);
});

test('long entry gate enforces every condition', () => {
  const good = {
    direction: 'long',
    regime: { regime: 'bullish', confidence: 65, trade_allowed: true },
    price: 105,
    ema50_4h: 100,
    rsi1h: 55,
    hasOpen: false,
    openCount: 0,
    inCooldown: false,
    halted: false,
  };
  assert.equal(entryAllowed(good, cfg).ok, true);
  assert.equal(entryAllowed({ ...good, halted: true }, cfg).reason, 'risk_halt');
  assert.equal(entryAllowed({ ...good, hasOpen: true }, cfg).reason, 'position_open');
  assert.equal(entryAllowed({ ...good, openCount: 2 }, cfg).reason, 'max_positions');
  assert.equal(entryAllowed({ ...good, inCooldown: true }, cfg).reason, 'cooldown');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, regime: 'chop' } }, cfg).reason, 'regime_not_bullish');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, regime: 'bearish' } }, cfg).reason, 'regime_not_bullish');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, trade_allowed: false } }, cfg).reason, 'trade_not_allowed');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, confidence: 59 } }, cfg).reason, 'low_confidence');
  assert.equal(entryAllowed({ ...good, price: 99 }, cfg).reason, 'below_ema50_4h');
  assert.equal(entryAllowed({ ...good, rsi1h: 75 }, cfg).reason, 'rsi_out_of_band');
  assert.equal(entryAllowed({ ...good, rsi1h: 40 }, cfg).reason, 'rsi_out_of_band');
});

test('short entry gate mirrors the long gate', () => {
  const good = {
    direction: 'short',
    regime: { regime: 'bearish', confidence: 65, trade_allowed: true },
    price: 95,
    ema50_4h: 100,
    rsi1h: 45,
    hasOpen: false,
    openCount: 0,
    inCooldown: false,
    halted: false,
  };
  assert.equal(entryAllowed(good, cfg).ok, true);
  // needs a BEARISH regime
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, regime: 'bullish' } }, cfg).reason, 'regime_not_bearish');
  assert.equal(entryAllowed({ ...good, regime: { ...good.regime, regime: 'chop' } }, cfg).reason, 'regime_not_bearish');
  // needs price BELOW the 4h EMA50
  assert.equal(entryAllowed({ ...good, price: 101 }, cfg).reason, 'above_ema50_4h');
  // symmetric RSI band [30, 55]: not oversold, not knife-catching a bounce
  assert.equal(entryAllowed({ ...good, rsi1h: 25 }, cfg).reason, 'rsi_out_of_band');
  assert.equal(entryAllowed({ ...good, rsi1h: 60 }, cfg).reason, 'rsi_out_of_band');
  assert.equal(entryAllowed({ ...good, rsi1h: 30 }, cfg).ok, true);
  assert.equal(entryAllowed({ ...good, rsi1h: 55 }, cfg).ok, true);
  // needs price BELOW the daily EMA50 when the MTF filter is on
  const mtf = { ...cfg, mtfDailyFilterEnabled: true };
  assert.equal(entryAllowed({ ...good, dailyEma50: 90 }, mtf).reason, 'wrong_side_of_daily_ema50');
  assert.equal(entryAllowed({ ...good, dailyEma50: 99 }, mtf).ok, true);
  // shared blocks still apply
  assert.equal(entryAllowed({ ...good, hasOpen: true }, cfg).reason, 'position_open');
  assert.equal(entryAllowed({ ...good, openCount: 2 }, cfg).reason, 'max_positions');
});
