// Deterministic strategy + risk rules for BOTH directions (long and short).
// This module is the ONLY component that opens or closes positions. No AI in
// here — the regime object is a plain input, and everything dangerous
// (sizing, leverage limits, liquidation buffers, stops, halts) is hard-coded
// logic. Every filter is gated by a config flag; with the flag off the
// behavior degrades to the plain rule set.
import { config } from '../config.js';
import { getDb, logEvent } from '../db.js';
import { percentileRank } from '../indicators.js';
import {
  closeTrade,
  directionSign,
  ensureDayOpenEquity,
  getAvailableBalance,
  getEquity,
  getOpenPosition,
  getOpenPositions,
  openTrade,
  partialCloseTrade,
  totalOpenNotional,
} from './portfolio.js';

// --- pure functions (unit-tested) ---

// The regime maps to at most one tradable direction. Chop (or anything
// unknown) trades nothing.
export function chooseDirection(regime) {
  if (!regime) return null;
  if (regime.regime === 'bullish') return 'long';
  if (regime.regime === 'bearish') return 'short';
  return null;
}

// Risk per trade is 1% of equity (1.5% when the regime agrees with the trade
// direction at confidence >= highConfThreshold and scaling is enabled). Size
// derives from the ATR stop distance — NEVER from leverage; leverage only
// affects the margin the position locks. Notional capped at 25% (30%
// high-confidence).
export function computePositionSize(equity, price, atrValue, cfg = config, regime = null, direction = 'long') {
  const stopDist = cfg.stopAtrMult * atrValue;
  if (!(stopDist > 0) || !(price > 0) || !(equity > 0)) {
    return { qty: 0, stopDist: 0, notional: 0, capped: false, riskPct: cfg.riskPerTrade };
  }
  const favorableRegime = direction === 'long' ? 'bullish' : 'bearish';
  const highConf =
    cfg.regimeRiskScalingEnabled &&
    regime &&
    regime.regime === favorableRegime &&
    regime.confidence >= (cfg.highConfThreshold ?? 80);
  const riskPct = highConf ? cfg.riskPctHighConf : cfg.riskPerTrade;
  const notionalPct = highConf ? cfg.maxNotionalHighConf : cfg.maxNotionalPct;
  let qty = (equity * riskPct) / stopDist;
  let capped = false;
  const maxNotional = equity * notionalPct;
  if (qty * price > maxNotional) {
    qty = maxNotional / price;
    capped = true;
  }
  return { qty, stopDist, notional: qty * price, capped, riskPct };
}

// --- trend-scaled dynamic take-profit ---
// Trend strength comes from ADX(14) on the 4h candles (direction-blind, same
// timeframe as the EMA50 trend filter). ADX was chosen over an EMA-slope
// proxy: standard definition, textbook-verifiable math, no extra
// normalization knobs. A missing/NaN ADX classifies as 'normal' — i.e.
// exactly today's fixed-TP behavior, never wider.
export function classifyTrend(adxValue, cfg = config) {
  if (!Number.isFinite(adxValue)) return 'normal';
  if (adxValue >= cfg.adxStrong) return 'strong';
  if (adxValue < cfg.adxWeak) return 'weak';
  return 'normal';
}

// TP distance multiplier (x ATR) for a trend class. With the flag off this is
// the fixed tpAtrMult — byte-identical to pre-dynamic-TP behavior. The STOP
// multiplier is deliberately not touched anywhere: risk stays fixed, only
// reward scales.
export function tpMultiplierFor(trendClass, cfg = config) {
  if (!cfg.dynamicTpEnabled) return cfg.tpAtrMult;
  if (trendClass === 'strong') return cfg.tpAtrMultStrong;
  if (trendClass === 'weak') return cfg.tpAtrMultWeak;
  return cfg.tpAtrMultNormal;
}

// R-multiple the post-partial runner targets. Scales the base extendedTpR by
// the trade's stored TP multiple relative to normal, so a strong-trend trade
// (tp_mult 4.5 vs normal 2.5) sends its runner to 4.0 * 1.8 = 7.2R. Falls
// back to the flat extendedTpR when the flag is off or the trade predates
// the tp_mult column — identical to prior behavior.
export function runnerTargetR(position, cfg = config) {
  if (!cfg.dynamicTpEnabled || !(position.tp_mult > 0) || !(cfg.tpAtrMultNormal > 0)) {
    return cfg.extendedTpR;
  }
  return cfg.extendedTpR * (position.tp_mult / cfg.tpAtrMultNormal);
}

// Isolated-margin liquidation estimate for a USD-M linear contract.
// effLeverage = notional / margin. The liquidation distance from entry is
// roughly (1/effLeverage - maintMarginRate) of the entry price.
export function estLiquidationPrice(entry, direction, effLeverage, mmr = config.maintMarginRate) {
  return entry * (1 - directionSign(direction) * (1 / effLeverage - mmr));
}

// Liquidation must always sit BEYOND the stop-loss (by liqBufferMult), so the
// ATR stop — not the liquidation engine — always ends the trade. If the
// configured leverage puts liquidation too close, hold the margin computed
// for the original size constant and shrink the position until the effective
// leverage (notional / margin) is safe. Never scales up.
export function applyLiquidationBuffer({ qty, price, stopDist, direction, cfg = config }) {
  if (!(qty > 0) || !(stopDist > 0) || !(price > 0)) return { qty, reduced: false, maxEffLeverage: null };
  const stopFrac = stopDist / price;
  const maxEffLeverage = 1 / (stopFrac * cfg.liqBufferMult + cfg.maintMarginRate);
  if (cfg.leverage <= maxEffLeverage) return { qty, reduced: false, maxEffLeverage };
  return { qty: qty * (maxEffLeverage / cfg.leverage), reduced: true, maxEffLeverage };
}

// Exit checks for an open position, direction-aware: emergency price-action
// exit first, then stop, take-profit, or a strong regime flip AGAINST the
// position (bearish flip closes longs; bullish flip closes shorts).
export function evaluateExit(position, price, regime, cfg = config) {
  const d = directionSign(position.direction);
  if (cfg.emergencyExitEnabled && d * (position.entry_price - price) >= position.entry_price * cfg.emergencyExitDropPct) {
    return 'emergency_exit';
  }
  if (d * (price - position.stop_price) <= 0) return 'stop';
  if (d * (price - position.tp_price) >= 0) return 'tp';
  const opposite = position.direction === 'short' ? 'bullish' : 'bearish';
  if (regime && regime.regime === opposite && regime.confidence >= cfg.regimeFlipConfidence) {
    return 'regime_flip';
  }
  return null;
}

// Dynamic RSI zones from the ATR percentile, per direction. The short band is
// the mirror of the long band around RSI 50 (e.g. long [45,70] -> short
// [30,55]): not oversold, not knife-catching a bounce.
export function dynamicRsiBounds(atrSeries, cfg = config) {
  const mirror = (b) => ({ min: 100 - b.max, max: 100 - b.min });
  const normal = {
    long: { min: cfg.rsiEntryMin, max: cfg.rsiEntryMax },
    short: { min: cfg.rsiShortEntryMin, max: cfg.rsiShortEntryMax },
  };
  if (!cfg.dynamicRsiEnabled) return normal;
  const window = (atrSeries || []).filter((v) => Number.isFinite(v)).slice(-336); // 14d of 1h ATRs
  if (window.length < 20) return normal;
  const rank = percentileRank(window, window[window.length - 1]);
  if (rank === null) return normal;
  if (rank < 0.4) {
    const long = { min: 48, max: 65 }; // calm tape: demand cleaner momentum
    return { long, short: mirror(long) };
  }
  if (rank > 0.6) {
    const long = { min: 42, max: 75 }; // volatile tape: wider band
    return { long, short: mirror(long) };
  }
  return normal;
}

// Weekend / low-liquidity window: Friday 20:00 UTC through Sunday 20:00 UTC.
export function isWeekendBlocked(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const hour = date.getUTCHours();
  if (day === 5 && hour >= 20) return true;
  if (day === 6) return true;
  if (day === 0 && hour < 20) return true;
  return false;
}

// Trailing-stop / partial-exit state machine for an open position, symmetric
// for shorts. Pure: returns the actions to apply, in order. R is the initial
// risk distance, fixed at entry (|entry - initial stop|); "favorable" is
// price above entry for longs, below entry for shorts.
export function trailingStopActions(position, price, cfg = config) {
  if (!cfg.trailingStopEnabled) return [];
  const d = directionSign(position.direction);
  const entry = position.entry_price;
  const R = position.initial_risk ?? (position.trailing_stop_active ? null : d * (entry - position.stop_price));
  if (!(R > 0)) return [];
  const favorable = d * (price - entry);
  const actions = [];
  if (!position.trailing_stop_active && favorable >= cfg.breakevenR * R) {
    actions.push({ action: 'breakeven', newStop: entry });
  }
  if (!position.partial_exit_done && favorable >= cfg.partialExitR * R) {
    actions.push({
      action: 'partial_exit',
      closeQty: position.qty * cfg.partialExitFraction,
      newStop: entry,
      // Runner target scales with the trade's dynamic-TP class (see
      // runnerTargetR): flat extendedTpR when the flag is off.
      newTp: entry + d * runnerTargetR(position, cfg) * R,
    });
  }
  return actions;
}

// Chandelier ATR trailing stop. Pure. Only arms once the trade is past
// breakeven (trailing_stop_active), so the fixed 1.5x-ATR stop protects the
// trade before then. Tracks a high-water mark (highest price for a long,
// lowest for a short) and trails the stop trailingAtrMult x ATR behind it.
// The stop RATCHETS: it only ever moves in the favorable direction, never
// loosens. Returns { newHwm, newStop } when the stop should tighten, or just
// { newHwm } when only the high-water mark advanced, or null when inactive.
export function chandelierStop(position, price, atr, cfg = config) {
  if (!cfg.trailingAtrEnabled) return null;
  if (!position.trailing_stop_active) return null; // pre-breakeven: fixed stop rules
  if (!(atr > 0) || !(price > 0)) return null;
  const d = directionSign(position.direction);
  const hwm = position.hwm ?? position.entry_price;
  const newHwm = d > 0 ? Math.max(hwm, price) : Math.min(hwm, price);
  const candidate = newHwm - d * cfg.trailingAtrMult * atr;
  // Ratchet: tighten only. For a long the stop may only rise; for a short,
  // only fall. d*(candidate - stop) > 0 captures both directions.
  if (d * (candidate - position.stop_price) > 0) {
    return { newHwm, newStop: candidate };
  }
  return { newHwm };
}

// All entry conditions in one place, direction-aware. Returns { ok, reason }.
// Long: bullish regime, price ABOVE the 4h EMA50 (and daily EMA50), RSI in
// the long band. Short: bearish regime, price BELOW the 4h EMA50 (and daily
// EMA50), RSI in the symmetric short band. Everything else is shared.
export function entryAllowed(input, cfg = config) {
  const {
    direction, regime, price, ema50_4h, dailyEma50, rsi1h,
    volumeRatio, correlationBlocked, weekendBlocked,
    hasOpen, openCount, inCooldown, halted,
  } = input;
  const isShort = direction === 'short';
  const rsiMin = input.rsiMin ?? (isShort ? cfg.rsiShortEntryMin : cfg.rsiEntryMin);
  const rsiMax = input.rsiMax ?? (isShort ? cfg.rsiShortEntryMax : cfg.rsiEntryMax);

  const fail = (reason) => ({ ok: false, reason });

  if (halted) return fail('risk_halt');
  // One position per symbol — this also makes a simultaneous long+short on
  // the same pair impossible.
  if (hasOpen) return fail('position_open');
  if (openCount >= cfg.maxPositions) return fail('max_positions');
  if (inCooldown) return fail('cooldown');
  if (cfg.weekendFilterEnabled && weekendBlocked) return fail('weekend_filter');
  const requiredRegime = isShort ? 'bearish' : 'bullish';
  if (!regime || regime.regime !== requiredRegime) return fail(`regime_not_${requiredRegime}`);
  if (!regime.trade_allowed) return fail('trade_not_allowed');
  if (regime.confidence < cfg.regimeMinConfidence) return fail('low_confidence');
  const d = isShort ? -1 : 1;
  if (ema50_4h === null || ema50_4h === undefined || !(d * (price - ema50_4h) > 0)) {
    return fail(isShort ? 'above_ema50_4h' : 'below_ema50_4h');
  }
  if (cfg.mtfDailyFilterEnabled && dailyEma50 !== null && dailyEma50 !== undefined && !(d * (price - dailyEma50) > 0)) {
    return fail('wrong_side_of_daily_ema50');
  }
  if (rsi1h === null || rsi1h === undefined || rsi1h < rsiMin || rsi1h > rsiMax) {
    return fail('rsi_out_of_band');
  }
  if (cfg.volumeFilterEnabled && volumeRatio !== null && volumeRatio !== undefined && volumeRatio < cfg.volumeMinRatio) {
    return fail('low_volume');
  }
  if (cfg.correlationFilterEnabled && correlationBlocked) return fail('correlation_blocked');
  return { ok: true, reason: 'entry' };
}

// --- DB-backed helpers ---

export function isInCooldown(pair, db = getDb(), cfg = config, now = Date.now()) {
  const lastStop = db
    .prepare(
      "SELECT exit_time FROM trades WHERE pair = ? AND status = 'closed' AND exit_reason = 'stop' ORDER BY id DESC LIMIT 1",
    )
    .get(pair);
  if (!lastStop) return false;
  return now - Date.parse(lastStop.exit_time) < cfg.cooldownHours * 3_600_000;
}

// Daily drawdown halt: if equity drops dailyDrawdownHalt vs the day's open,
// block all NEW entries until the next UTC day. Exits still run.
export function isHalted(equity, db = getDb(), cfg = config, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const date = nowIso.slice(0, 10);
  const dayOpen = ensureDayOpenEquity(equity, db, date);
  const halted = equity <= dayOpen * (1 - cfg.dailyDrawdownHalt);
  if (halted) {
    const already = db
      .prepare("SELECT id FROM events WHERE type = 'RISK_HALT' AND ts >= ? LIMIT 1")
      .get(`${date}T00:00:00`);
    if (!already) logEvent('RISK_HALT', { equity, dayOpen, drawdownPct: (1 - equity / dayOpen) * 100 }, db, nowIso);
  }
  return halted;
}

// Run position management (trailing/partial/exits) then (maybe) one entry for
// a pair — long OR short, decided by the regime. Returns a list of actions
// taken. Executor calls are awaited (real network fills on testnet). An
// executor may return { skipped: <reason> }; never throws for skips.
export async function runPairRules({
  pair, price, atr1h, rsi1h, ema50_4h, dailyEma50 = null, regime, adx4h = null,
  volumeRatio = null, rsiBounds = null, correlationBlocked = false,
  executor, db = getDb(), cfg = config, prices = {}, entriesBlocked = false,
  volScale = 1, now = Date.now(),
}) {
  const actions = [];
  const atIso = new Date(now).toISOString();

  // Every rejected entry is persisted as a NO_ENTRY event so "why isn't it
  // trading" is answerable from the database (and the dashboard's blockers
  // panel) instead of from console scrollback.
  const noEntry = (reason, direction = null) => {
    logEvent('NO_ENTRY', { pair, reason, ...(direction ? { direction } : {}) }, db, atIso);
    actions.push({ type: 'no_entry', pair, ...(direction ? { direction } : {}), reason });
    return actions;
  };

  // 1. Trailing stop + partial exit state machine (direction-aware).
  let position = getOpenPosition(pair, db);
  if (position) {
    for (const act of trailingStopActions(position, price, cfg)) {
      if (act.action === 'breakeven') {
        db.prepare('UPDATE trades SET stop_price = ?, trailing_stop_active = 1 WHERE id = ?').run(act.newStop, position.id);
        logEvent('TRAILING_STOP_ACTIVATED', { pair, tradeId: position.id, newStop: act.newStop }, db, atIso);
        actions.push({ type: 'breakeven', pair, newStop: act.newStop });
      } else if (act.action === 'partial_exit') {
        const fill = await executor.closePosition(pair, position.direction, act.closeQty, price);
        if (fill.skipped) {
          logEvent('PARTIAL_EXIT_SKIPPED', { pair, reason: fill.skipped }, db, atIso);
        } else {
          const closedQty = Math.min(fill.executedQty ?? act.closeQty, position.qty * 0.999999);
          const partialPnl = partialCloseTrade(position.id, { sellQty: closedQty, fillPrice: fill.fillPrice, fee: fill.fee }, db);
          db.prepare('UPDATE trades SET stop_price = ?, tp_price = ?, trailing_stop_active = 1 WHERE id = ?')
            .run(act.newStop, act.newTp, position.id);
          logEvent('PARTIAL_EXIT', { pair, tradeId: position.id, direction: position.direction, closedQty, partialPnl, newTp: act.newTp }, db, atIso);
          actions.push({ type: 'partial_exit', pair, direction: position.direction, closedQty, partialPnl, newTp: act.newTp });
        }
      }
    }
    position = getOpenPosition(pair, db); // refresh after state changes
  }

  // 1b. Chandelier ATR trailing stop: once armed, advance the high-water mark
  // and ratchet the stop toward it. Runs BEFORE the exit check so a stop that
  // just tightened past the current price fires this same cycle.
  if (position) {
    const trail = chandelierStop(position, price, atr1h, cfg);
    if (trail) {
      if (trail.newStop !== undefined) {
        db.prepare('UPDATE trades SET stop_price = ?, hwm = ? WHERE id = ?').run(trail.newStop, trail.newHwm, position.id);
        logEvent('TRAILING_STOP_MOVED', { pair, tradeId: position.id, direction: position.direction, newStop: trail.newStop, hwm: trail.newHwm }, db, atIso);
        actions.push({ type: 'trail', pair, newStop: trail.newStop, hwm: trail.newHwm });
      } else if (trail.newHwm !== (position.hwm ?? position.entry_price)) {
        db.prepare('UPDATE trades SET hwm = ? WHERE id = ?').run(trail.newHwm, position.id);
      }
      position = getOpenPosition(pair, db); // refresh so the exit check sees the trailed stop
    }
  }

  // 2. Exits — checked every cycle against live price.
  if (position) {
    const reason = evaluateExit(position, price, regime, cfg);
    if (reason) {
      const fill = await executor.closePosition(pair, position.direction, position.qty, price);
      if (fill.skipped) {
        // Position stays open; we retry next cycle. State remains consistent.
        logEvent('EXIT_ORDER_SKIPPED', { pair, reason: fill.skipped, wanted: reason }, db, atIso);
        actions.push({ type: 'exit_skipped', pair, reason: fill.skipped });
      } else {
        const pnl = closeTrade(
          position.id,
          { fillPrice: fill.fillPrice, fee: fill.fee, reason, orderId: fill.orderId ?? null, at: atIso },
          db,
        );
        logEvent('TRADE_CLOSED', { pair, direction: position.direction, reason, pnl, exitPrice: fill.fillPrice, signal: price }, db, atIso);
        actions.push({ type: 'close', pair, direction: position.direction, reason, pnl, exit: fill.fillPrice, signal: price });
      }
    }
  }

  // 3. Entry gate — the regime picks the direction, the rules decide if it trades.
  const equity = getEquity({ ...prices, [pair]: price }, db);
  const halted = isHalted(equity, db, cfg, now) || entriesBlocked;
  const direction = chooseDirection(regime);
  if (!direction) {
    return noEntry('no_directional_regime');
  }
  const bounds = rsiBounds ?? dynamicRsiBounds(null, cfg);
  const dirBounds = direction === 'short' ? bounds.short : bounds.long;
  const gate = entryAllowed(
    {
      direction,
      regime,
      price,
      ema50_4h,
      dailyEma50,
      rsi1h,
      rsiMin: dirBounds.min,
      rsiMax: dirBounds.max,
      volumeRatio,
      correlationBlocked,
      weekendBlocked: isWeekendBlocked(new Date(now)),
      hasOpen: !!getOpenPosition(pair, db),
      openCount: getOpenPositions(db).length,
      inCooldown: isInCooldown(pair, db, cfg, now),
      halted,
    },
    cfg,
  );
  if (!gate.ok) {
    return noEntry(gate.reason, direction);
  }

  // 4. Sizing: risk-based (never leverage-based), volatility-targeted, then
  //    the liquidation buffer and the leverage-exposure cap.
  const sized = computePositionSize(equity, price, atr1h, cfg, regime, direction);
  let qty = sized.qty * Math.min(1, volScale);
  if (qty <= 0) {
    return noEntry('zero_size', direction);
  }

  // 4a. Liquidation buffer: the stop must always be hit before liquidation.
  const liqAdj = applyLiquidationBuffer({ qty, price, stopDist: sized.stopDist, direction, cfg });
  if (liqAdj.reduced) {
    logEvent('SIZE_REDUCED_FOR_LIQ_BUFFER', {
      pair, direction, originalQty: qty, reducedQty: liqAdj.qty,
      leverage: cfg.leverage, maxEffLeverage: Number(liqAdj.maxEffLeverage.toFixed(2)),
    }, db, atIso);
    qty = liqAdj.qty;
  }

  // 4b. Max-leverage-exposure cap: total open notional <= equity * leverage *
  //     exposureCapFraction (never more than half the leveraged buying power).
  const newNotional = qty * price;
  const openNotional = totalOpenNotional({ ...prices, [pair]: price }, db);
  const exposureCap = equity * cfg.leverage * cfg.exposureCapFraction;
  if (openNotional + newNotional > exposureCap) {
    logEvent('LEVERAGE_EXPOSURE_CAP', {
      pair, direction, openNotional, newNotional, cap: exposureCap, leverage: cfg.leverage,
    }, db, atIso);
    return noEntry('leverage_exposure_cap', direction);
  }

  // 4c. Margin pre-check (with slippage headroom), then fill.
  const estMargin = (newNotional * (1 + cfg.slippage)) / cfg.leverage;
  const estFee = newNotional * (1 + cfg.slippage) * cfg.takerFee;
  if (estMargin + estFee > getAvailableBalance(db)) {
    return noEntry('insufficient_margin', direction);
  }
  const fill = await executor.openPosition(pair, direction, qty, price);
  if (fill.skipped) {
    return noEntry(fill.skipped, direction);
  }
  const tradeQty = fill.executedQty ?? qty;
  const d = directionSign(direction);
  const stopPrice = fill.fillPrice - d * sized.stopDist; // stop distance NEVER scales with trend
  const trendClass = classifyTrend(adx4h, cfg);
  const tpMult = tpMultiplierFor(trendClass, cfg);
  const tpPrice = fill.fillPrice + d * tpMult * atr1h;
  const tradeId = openTrade(
    {
      pair, direction, qty: tradeQty, fillPrice: fill.fillPrice, fee: fill.fee, stopPrice, tpPrice,
      leverage: cfg.leverage,
      trendClass: cfg.dynamicTpEnabled ? trendClass : null,
      tpMult,
      orderId: fill.orderId ?? null,
      regimeAtEntry: regime?.regime ?? null,
      confidenceAtEntry: regime?.confidence ?? null,
      at: atIso,
    },
    db,
  );
  logEvent('TRADE_OPENED', {
    pair, tradeId, direction, leverage: cfg.leverage, qty: tradeQty,
    entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice, riskPct: sized.riskPct, volScale,
    trend: cfg.dynamicTpEnabled ? trendClass : null, tpMult,
    adx4h: Number.isFinite(adx4h) ? Number(adx4h.toFixed(2)) : null,
  }, db, atIso);
  actions.push({
    type: 'open', pair, tradeId, direction, leverage: cfg.leverage, qty: tradeQty,
    entry: fill.fillPrice, signal: price, stop: stopPrice, tp: tpPrice,
    trend: cfg.dynamicTpEnabled ? trendClass : null, tpMult,
  });
  return actions;
}
