import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyLiquidationBuffer,
  computePositionSize,
  estLiquidationPrice,
} from '../src/engine/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cfg = {
  riskPerTrade: 0.01,
  stopAtrMult: 1.5,
  maxNotionalPct: 0.25,
};

test('risk-based sizing: qty = (equity * 1%) / (1.5 * ATR) — leverage never enters', () => {
  // equity 1000 -> risk $10; ATR 4 -> stop distance 6; qty = 10/6
  const { qty, stopDist, capped } = computePositionSize(1000, 50, 4, cfg);
  assert.ok(Math.abs(stopDist - 6) < 1e-9);
  assert.ok(Math.abs(qty - 10 / 6) < 1e-9);
  assert.equal(capped, false);
  // identical for a short: risk symmetric, direction only picks the regime match
  const short = computePositionSize(1000, 50, 4, cfg, null, 'short');
  assert.ok(Math.abs(short.qty - 10 / 6) < 1e-9);
});

test('notional is capped at 25% of equity', () => {
  const { qty, notional, capped } = computePositionSize(1000, 60000, 100, cfg);
  assert.equal(capped, true);
  assert.ok(Math.abs(qty - 250 / 60000) < 1e-12);
  assert.ok(Math.abs(notional - 250) < 1e-9);
});

test('degenerate inputs produce zero size', () => {
  assert.equal(computePositionSize(1000, 50, 0, cfg).qty, 0);
  assert.equal(computePositionSize(0, 50, 4, cfg).qty, 0);
  assert.equal(computePositionSize(1000, 0, 4, cfg).qty, 0);
});

test('regime risk scaling is direction-aware: bearish high-conf scales SHORTS, not longs', () => {
  const riskCfg = {
    riskPerTrade: 0.01, stopAtrMult: 1.5, maxNotionalPct: 0.25,
    regimeRiskScalingEnabled: true, riskPctHighConf: 0.015, maxNotionalHighConf: 0.3, highConfThreshold: 80,
  };
  const bear = { regime: 'bearish', confidence: 85 };
  const bull = { regime: 'bullish', confidence: 85 };
  assert.equal(computePositionSize(1000, 50, 4, riskCfg, bear, 'short').riskPct, 0.015);
  assert.equal(computePositionSize(1000, 50, 4, riskCfg, bear, 'long').riskPct, 0.01);
  assert.equal(computePositionSize(1000, 50, 4, riskCfg, bull, 'long').riskPct, 0.015);
  assert.equal(computePositionSize(1000, 50, 4, riskCfg, bull, 'short').riskPct, 0.01);
});

test('liquidation price estimate: distance shrinks as effective leverage rises', () => {
  // long at 5x, mmr 0.5%: liq at entry * (1 - (0.2 - 0.005)) = 80.5% of entry
  assert.ok(Math.abs(estLiquidationPrice(100, 'long', 5, 0.005) - 80.5) < 1e-9);
  // short mirrors above entry
  assert.ok(Math.abs(estLiquidationPrice(100, 'short', 5, 0.005) - 119.5) < 1e-9);
  // lower leverage -> liquidation further away
  assert.ok(estLiquidationPrice(100, 'long', 2, 0.005) < estLiquidationPrice(100, 'long', 5, 0.005));
});

test('liquidation buffer: normal ATR stops at <=5x never trigger a reduction', () => {
  const liqCfg = { leverage: 5, maintMarginRate: 0.005, liqBufferMult: 1.25 };
  // 3% stop at 5x: liq distance is ~19.5%, far beyond 1.25 * 3%
  const out = applyLiquidationBuffer({ qty: 1, price: 100, stopDist: 3, direction: 'long', cfg: liqCfg });
  assert.equal(out.reduced, false);
  assert.equal(out.qty, 1);
});

test('liquidation buffer: size is reduced until the stop is hit before liquidation', () => {
  const liqCfg = { leverage: 5, maintMarginRate: 0.005, liqBufferMult: 1.25 };
  // 25% stop at 5x: liq distance (~19.5%) is INSIDE the stop -> must reduce
  const out = applyLiquidationBuffer({ qty: 1, price: 100, stopDist: 25, direction: 'long', cfg: liqCfg });
  assert.equal(out.reduced, true);
  // closed form: maxEffLeverage = 1 / (0.25 * 1.25 + 0.005); qty scales by maxEff/leverage
  const maxEff = 1 / (0.25 * 1.25 + 0.005);
  assert.ok(Math.abs(out.qty - maxEff / 5) < 1e-12);

  // verify the property the buffer exists for: with margin held at the
  // original size's allocation, the reduced position's liquidation distance
  // is exactly liqBufferMult * stop distance (i.e. stop always fires first)
  const margin = (1 * 100) / liqCfg.leverage;
  const effLev = (out.qty * 100) / margin;
  const liq = estLiquidationPrice(100, 'long', effLev, liqCfg.maintMarginRate);
  assert.ok(Math.abs((100 - liq) - 25 * 1.25) < 1e-9);

  // symmetric for shorts
  const short = applyLiquidationBuffer({ qty: 1, price: 100, stopDist: 25, direction: 'short', cfg: liqCfg });
  assert.ok(Math.abs(short.qty - out.qty) < 1e-12);
});

// The clamp lives at config load time, so exercise it in a child process with
// the env var actually set.
function loadConfigWith(env) {
  const script = `
    import(new URL('src/config.js', 'file://' + process.cwd().replace(/([^/])$/, '$1/')).href)
      .then(({ config, MAX_ALLOWED_LEVERAGE }) => {
        console.log(JSON.stringify({
          leverage: config.leverage,
          requested: config.requestedLeverage,
          clamped: config.leverageWasClamped,
          ceiling: MAX_ALLOWED_LEVERAGE,
        }));
      });
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  return JSON.parse(out.toString().trim());
}

test('leverage defaults to 3 and clamps at the hard ceiling of 5', () => {
  const def = loadConfigWith({ FUTURES_LEVERAGE: '' });
  assert.equal(def.leverage, 3);
  assert.equal(def.clamped, false);

  const four = loadConfigWith({ FUTURES_LEVERAGE: '4' });
  assert.equal(four.leverage, 4);
  assert.equal(four.clamped, false);

  const twenty = loadConfigWith({ FUTURES_LEVERAGE: '20' });
  assert.equal(twenty.ceiling, 5);
  assert.equal(twenty.leverage, 5, 'clamped to MAX_ALLOWED_LEVERAGE');
  assert.equal(twenty.requested, 20);
  assert.equal(twenty.clamped, true);

  // sub-1 / garbage values floor to 1x, never 0 or negative
  const zero = loadConfigWith({ FUTURES_LEVERAGE: '0' });
  assert.equal(zero.leverage, 1);
});
