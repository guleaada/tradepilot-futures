// Virtual FUTURES portfolio: wallet cash, isolated margin, long/short
// positions, funding. All state in SQLite.
//
// Margin model (differs from the spot fork's "cash buys coins" model):
//   - cash is the USDT wallet balance. It moves ONLY on fees, funding, and
//     realized P&L — never by position notional.
//   - opening a position LOCKS isolated margin (= notional / leverage);
//     available balance = cash - locked margin.
//   - equity = cash + unrealized P&L of open positions (margin is part of
//     cash, just not spendable).
//   - unrealized P&L = direction * (mark - entry) * qty  (direction: long +1,
//     short -1).
// Invariant: for a fully closed trade, cash moved by exactly trades.pnl
// (price P&L - both fees - funding), which the tests assert.
import { getDb, nowIso } from '../db.js';
import { returns, stdev } from '../indicators.js';
import { config } from '../config.js';

export function directionSign(direction) {
  return direction === 'short' ? -1 : 1;
}

export function getCash(db = getDb()) {
  return db.prepare('SELECT cash FROM portfolio WHERE id = 1').get().cash;
}

export function setCash(cash, db = getDb()) {
  // Defense in depth: better-sqlite3 binds NaN as NULL, which would trip the
  // NOT NULL constraint with an opaque error AFTER an exchange order already
  // filled. Fail loud and early instead — a non-finite wallet is always a
  // fill-parsing bug upstream.
  if (!Number.isFinite(cash)) throw new Error(`refusing to write non-finite cash: ${cash}`);
  db.prepare('UPDATE portfolio SET cash = ? WHERE id = 1').run(cash);
}

export function getOpenPositions(db = getDb()) {
  return db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY id").all();
}

export function getOpenPosition(pair, db = getDb()) {
  // One row per pair max — the entry gate blocks a second position (so a
  // simultaneous long + short on the same symbol is impossible).
  return db.prepare("SELECT * FROM trades WHERE status = 'open' AND pair = ?").get(pair);
}

export function unrealizedPnl(position, mark) {
  return directionSign(position.direction) * (mark - position.entry_price) * position.qty;
}

// Sum of isolated margin locked by open positions.
export function getMarginLocked(db = getDb()) {
  return getOpenPositions(db).reduce((s, p) => s + (p.margin || 0), 0);
}

// Wallet balance not locked as margin — what new entries can draw on.
export function getAvailableBalance(db = getDb()) {
  return getCash(db) - getMarginLocked(db);
}

// Equity = wallet cash + mark-to-market P&L of open positions. Falls back to
// entry price (zero unrealized) when no live price is available for a pair.
export function getEquity(prices = {}, db = getDb()) {
  const cash = getCash(db);
  return getOpenPositions(db).reduce(
    (eq, p) => eq + unrealizedPnl(p, prices[p.pair] ?? p.entry_price),
    cash,
  );
}

// Total open notional (marked to market), for the leverage-exposure cap.
export function totalOpenNotional(prices = {}, db = getDb()) {
  return getOpenPositions(db).reduce(
    (s, p) => s + p.qty * (prices[p.pair] ?? p.entry_price),
    0,
  );
}

export function openTrade(
  {
    pair, direction = 'long', qty, fillPrice, fee, stopPrice, tpPrice,
    leverage = config.leverage, orderId = null,
    trendClass = null, tpMult = null,
    regimeAtEntry = null, confidenceAtEntry = null, at = nowIso(),
  },
  db = getDb(),
) {
  const margin = (fillPrice * qty) / leverage;
  const available = getAvailableBalance(db);
  if (margin + fee > available + 1e-9) {
    throw new Error(`insufficient margin: need ${margin + fee}, available ${available}`);
  }
  const tx = db.transaction(() => {
    setCash(getCash(db) - fee, db); // only the fee leaves the wallet; margin is locked, not spent
    const info = db
      .prepare(
        `INSERT INTO trades
           (pair, direction, status, entry_time, entry_price, qty, stop_price, tp_price, entry_fee,
            entry_order_id, initial_risk, regime_at_entry, confidence_at_entry, entry_qty,
            leverage, margin, funding_paid, trend_class, tp_mult)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        pair, direction, at, fillPrice, qty, stopPrice, tpPrice, fee,
        orderId === null ? null : String(orderId),
        Math.abs(fillPrice - stopPrice), // initial R distance, fixed for the life of the trade
        regimeAtEntry, confidenceAtEntry,
        qty, // original entry quantity, fixed for the life of the trade
        leverage, margin,
        trendClass, tpMult, // dynamic-TP class + ATR multiple, frozen at entry
      );
    return info.lastInsertRowid;
  });
  return tx();
}

// Close part of an open position. Realized partial P&L accumulates in
// partial_pnl; entry_fee and margin are scaled down proportionally so the
// final close's remainder math stays consistent.
export function partialCloseTrade(tradeId, { sellQty, fillPrice, fee }, db = getDb()) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || trade.status !== 'open') throw new Error(`trade ${tradeId} not open`);
  if (!(sellQty > 0) || sellQty >= trade.qty) throw new Error(`invalid partial qty ${sellQty} of ${trade.qty}`);
  const pricePnl = directionSign(trade.direction) * (fillPrice - trade.entry_price) * sellQty;
  const entryFeeShare = trade.entry_fee * (sellQty / trade.qty);
  // Reported leg P&L carries its share of the entry fee; the wallet only
  // moves by pricePnl - exit fee (the entry fee already left at open time).
  const partialPnl = pricePnl - fee - entryFeeShare;
  const remainder = trade.qty - sellQty;
  const scale = remainder / trade.qty;
  const tx = db.transaction(() => {
    setCash(getCash(db) + pricePnl - fee, db);
    db.prepare(
      `UPDATE trades
       SET qty = ?, remainder_qty = ?, entry_fee = ?, margin = ?, partial_exit_done = 1,
           partial_pnl = COALESCE(partial_pnl, 0) + ?
       WHERE id = ?`,
    ).run(remainder, remainder, trade.entry_fee * scale, (trade.margin || 0) * scale, partialPnl, tradeId);
  });
  tx();
  return partialPnl;
}

export function closeTrade(tradeId, { fillPrice, fee, reason, orderId = null, at = nowIso() }, db = getDb()) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade || trade.status !== 'open') throw new Error(`trade ${tradeId} not open`);
  const pricePnl = directionSign(trade.direction) * (fillPrice - trade.entry_price) * trade.qty;
  // Total trade P&L = remainder leg - all costs (both fees, funding) + any
  // realized partial-exit P&L. funding_paid was already charged to cash as it
  // accrued; it belongs in the reported trade P&L, not in the cash delta here.
  const pnl = pricePnl - fee - trade.entry_fee - (trade.funding_paid || 0) + (trade.partial_pnl || 0);
  const tx = db.transaction(() => {
    setCash(getCash(db) + pricePnl - fee, db);
    db.prepare(
      `UPDATE trades
       SET status = 'closed', exit_time = ?, exit_price = ?, exit_fee = ?, pnl = ?, exit_reason = ?, exit_order_id = ?
       WHERE id = ?`,
    ).run(at, fillPrice, fee, pnl, reason, orderId === null ? null : String(orderId), tradeId);

    // Regime accuracy: how did the regime that was active at entry pay off?
    if (trade.regime_at_entry) {
      const originalQty = trade.entry_qty ?? trade.qty;
      const entryNotional = trade.entry_price * originalQty;
      const durationMin = (Date.parse(at) - Date.parse(trade.entry_time)) / 60_000;
      db.prepare(
        `INSERT INTO regime_accuracy (ts, pair, regime_at_entry, confidence_at_entry, actual_return_pct, duration_minutes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(at, trade.pair, trade.regime_at_entry, trade.confidence_at_entry,
        entryNotional > 0 ? (pnl / entryNotional) * 100 : null,
        Number.isFinite(durationMin) ? durationMin : null);
    }
  });
  tx();
  return pnl;
}

// --- funding (USD-M perpetuals settle every 8h at 00:00 / 08:00 / 16:00 UTC) ---

// Most recent funding boundary at or before `nowMs`.
export function lastFundingBoundary(nowMs = Date.now()) {
  const eightHours = 8 * 3_600_000;
  return Math.floor(nowMs / eightHours) * eightHours;
}

// Funding cost charged to the position holder (positive = we pay). With a
// positive funding rate longs pay shorts; negative, shorts pay longs.
export function fundingCost(direction, qty, markPrice, fundingRate) {
  return directionSign(direction) * qty * markPrice * fundingRate;
}

// Charge one funding settlement to an open trade: wallet cash moves now, the
// cost accumulates in funding_paid (so closeTrade folds it into reported
// P&L), and last_funding_ts guards against double-charging the same boundary.
export function applyFunding(tradeId, cost, boundaryIso, db = getDb()) {
  const tx = db.transaction(() => {
    setCash(getCash(db) - cost, db);
    db.prepare(
      'UPDATE trades SET funding_paid = COALESCE(funding_paid, 0) + ?, last_funding_ts = ? WHERE id = ?',
    ).run(cost, boundaryIso, tradeId);
  });
  tx();
}

// Records the first equity reading of each UTC day; used by the drawdown halt.
export function ensureDayOpenEquity(equity, db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  db.prepare('INSERT OR IGNORE INTO daily_equity (date, open_equity) VALUES (?, ?)').run(date, equity);
  return db.prepare('SELECT open_equity FROM daily_equity WHERE date = ?').get(date).open_equity;
}

// Hourly equity snapshots (skips if the last snapshot is < 1h old).
export function snapshotEquity(equity, cash, db = getDb(), ts = nowIso()) {
  const last = db.prepare('SELECT ts FROM equity_snapshots ORDER BY id DESC LIMIT 1').get();
  if (last && Date.parse(ts) - Date.parse(last.ts) < 3_600_000) return false;
  db.prepare('INSERT INTO equity_snapshots (ts, equity, cash) VALUES (?, ?, ?)').run(ts, equity, cash);
  return true;
}

export function todayPnl(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const row = db
    .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE status = 'closed' AND exit_time >= ?")
    .get(`${date}T00:00:00`);
  return row.pnl;
}

// Realized P&L for closed trades whose exit_time falls on a specific UTC date.
export function pnlForDate(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const row = db
    .prepare("SELECT COALESCE(SUM(pnl), 0) AS pnl FROM trades WHERE status = 'closed' AND exit_time >= ? AND exit_time < ?")
    .get(`${date}T00:00:00`, `${next}T00:00:00`);
  return row.pnl;
}

// Total funding charged across all trades (open + closed). Negative = net received.
export function totalFundingPaid(db = getDb()) {
  return db.prepare('SELECT COALESCE(SUM(funding_paid), 0) AS f FROM trades').get().f;
}

// --- portfolio risk metrics ---

// Volatility-targeting scale factor from an equity series (pure).
// Realized vol = stdev of hourly equity returns, annualized by sqrt(8760).
// Never scales up: result is in (0, 1].
export function volTargetScale(equitySeries, cfg = config) {
  if (!cfg.volTargetingEnabled) return 1;
  if (!equitySeries || equitySeries.length < 21) return 1;
  const rets = returns(equitySeries.slice(-21));
  const sd = stdev(rets);
  if (sd === null || !(sd > 0)) return 1;
  const annualized = sd * Math.sqrt(24 * 365);
  if (annualized <= cfg.volTargetAnnualized) return 1;
  return cfg.volTargetAnnualized / annualized;
}

export function volTargetScaleFromDb(db = getDb(), cfg = config) {
  const rows = db.prepare('SELECT equity FROM equity_snapshots ORDER BY id DESC LIMIT 21').all();
  return volTargetScale(rows.map((r) => r.equity).reverse(), cfg);
}

// Drawdown from peak equity, as a fraction (0 = at the peak).
export function drawdownFromPeak(db = getDb()) {
  const rows = db.prepare('SELECT equity FROM equity_snapshots ORDER BY id').all();
  if (!rows.length) return 0;
  const peak = Math.max(...rows.map((r) => r.equity));
  const current = rows[rows.length - 1].equity;
  return peak > 0 ? Math.max(0, (peak - current) / peak) : 0;
}

// Trailing 7-day win rate and profit factor from closed trades.
export function trailing7dStats(db = getDb(), now = Date.now()) {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const closed = db
    .prepare("SELECT pnl FROM trades WHERE status = 'closed' AND exit_time >= ?")
    .all(since);
  if (!closed.length) return { trades: 0, winRate: null, profitFactor: null };
  const wins = closed.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: closed.length,
    winRate: wins.length / closed.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
  };
}
