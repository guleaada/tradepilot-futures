// Daily HTML + console reporting. The equity curve is inline SVG — no chart libs.
// FUTURES fork: every view carries direction, leverage, and funding so this
// output can never be confused with the spot bot's.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDb } from '../db.js';
import {
  getAvailableBalance,
  getCash,
  getEquity,
  getMarginLocked,
  getOpenPositions,
  todayPnl,
  totalFundingPaid,
  unrealizedPnl,
  volTargetScaleFromDb,
} from '../engine/portfolio.js';
import { getDailySpend } from '../ai/budget.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function computeStats(db = getDb()) {
  const closed = db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY id").all();
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const snapshots = db.prepare('SELECT ts, equity FROM equity_snapshots ORDER BY id').all();

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const s of snapshots) {
    peak = Math.max(peak, s.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - s.equity) / peak);
  }

  const totalSpend = db.prepare('SELECT COALESCE(SUM(spend), 0) AS s FROM ai_budget').get().s;

  // Expectancy per trade: (avg win x win rate) - (avg loss x loss rate).
  const winRate = closed.length ? wins.length / closed.length : null;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = closed.length ? avgWin * winRate - avgLoss * (1 - winRate) : null;

  let curW = 0; let curL = 0; let maxConsecWins = 0; let maxConsecLosses = 0;
  for (const t of closed) {
    if (t.pnl > 0) { curW++; curL = 0; } else { curL++; curW = 0; }
    maxConsecWins = Math.max(maxConsecWins, curW);
    maxConsecLosses = Math.max(maxConsecLosses, curL);
  }

  // Per-direction P&L split — the whole point of the futures A/B experiment.
  const byDirection = db
    .prepare(
      `SELECT direction, COUNT(*) AS trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
              COALESCE(SUM(pnl), 0) AS total_pnl,
              COALESCE(SUM(funding_paid), 0) AS funding
       FROM trades WHERE status = 'closed' GROUP BY direction ORDER BY direction`,
    )
    .all();

  // Regime accuracy: how often each regime label at entry produced a winner.
  const regimeAccuracy = db
    .prepare(
      `SELECT regime_at_entry AS regime, COUNT(*) AS trades,
              SUM(CASE WHEN actual_return_pct > 0 THEN 1 ELSE 0 END) AS correct,
              AVG(actual_return_pct) AS avg_return_pct
       FROM regime_accuracy GROUP BY regime_at_entry ORDER BY trades DESC`,
    )
    .all();

  return {
    closedCount: closed.length,
    winRate,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    totalPnl: closed.reduce((a, t) => a + t.pnl, 0),
    maxDrawdown,
    totalAiSpend: totalSpend,
    expectancy,
    maxConsecWins,
    maxConsecLosses,
    byDirection,
    regimeAccuracy,
    closed,
    snapshots,
  };
}

function equityCurveSvg(snapshots, width = 720, height = 220) {
  if (snapshots.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="20" y="40" font-family="monospace">Not enough equity snapshots yet.</text></svg>`;
  }
  const pad = 36;
  const eqs = snapshots.map((s) => s.equity);
  const min = Math.min(...eqs);
  const max = Math.max(...eqs);
  const span = max - min || 1;
  const pts = snapshots
    .map((s, i) => {
      const x = pad + (i / (snapshots.length - 1)) * (width - 2 * pad);
      const y = height - pad - ((s.equity - min) / span) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#fafafa" stroke="#ddd"/>
  <text x="${pad}" y="18" font-family="monospace" font-size="12">max ${max.toFixed(2)}</text>
  <text x="${pad}" y="${height - 8}" font-family="monospace" font-size="12">min ${min.toFixed(2)}</text>
  <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${pts}"/>
</svg>`;
}

export function generateReport(db = getDb(), date = new Date().toISOString().slice(0, 10)) {
  const stats = computeStats(db);
  const open = getOpenPositions(db);
  const cash = getCash(db);
  const equity = getEquity({}, db);
  const regimes = db.prepare('SELECT * FROM regime_calls ORDER BY id DESC LIMIT 10').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 20').all();
  const anthropicSpendToday = getDailySpend(db, date, 'anthropic');

  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const usd = (v) => `$${Number(v).toFixed(2)}`;
  const dirTag = (d) => (d === 'short' ? '🔴 SHORT' : '🟢 LONG');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>TradePilot-Futures ${esc(date)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #111; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: 4px 10px; font-size: 13px; text-align: right; }
  th { background: #f3f4f6; }
  td:first-child, th:first-child { text-align: left; }
  .neg { color: #dc2626; } .pos { color: #16a34a; }
  h2 { margin-top: 2rem; }
  .banner { background: #fef3c7; border: 1px solid #f59e0b; padding: 8px 12px; border-radius: 6px; }
</style></head><body>
<h1>TradePilot-Futures — Daily Report ${esc(date)}</h1>
<p class="banner"><strong>EXECUTOR: FUTURES TESTNET (${config.leverage}x leverage)</strong> — Binance USD-M futures testnet, isolated margin, long + short. <strong>No real funds.</strong> Mainnet futures trading is intentionally not implemented. Runs in parallel with the spot TradePilot for a 30-day A/B comparison.</p>

<h2>Equity curve</h2>
${equityCurveSvg(stats.snapshots)}

<h2>Summary</h2>
<table>
<tr><th>Equity</th><td>${usd(equity)}</td></tr>
<tr><th>Wallet cash</th><td>${usd(cash)}</td></tr>
<tr><th>Margin locked</th><td>${usd(getMarginLocked(db))}</td></tr>
<tr><th>Available balance</th><td>${usd(getAvailableBalance(db))}</td></tr>
<tr><th>Leverage</th><td>${config.leverage}x (isolated)</td></tr>
<tr><th>Closed trades</th><td>${stats.closedCount}</td></tr>
<tr><th>Win rate</th><td>${pct(stats.winRate)}</td></tr>
<tr><th>Profit factor</th><td>${stats.profitFactor === null ? 'n/a' : stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}</td></tr>
<tr><th>Total P&amp;L</th><td class="${stats.totalPnl >= 0 ? 'pos' : 'neg'}">${usd(stats.totalPnl)}</td></tr>
<tr><th>Total funding paid</th><td>${usd(totalFundingPaid(db))}</td></tr>
<tr><th>Max drawdown</th><td>${pct(stats.maxDrawdown)}</td></tr>
<tr><th>Expectancy / trade</th><td>${stats.expectancy === null ? 'n/a' : usd(stats.expectancy)}</td></tr>
<tr><th>Max consecutive wins / losses</th><td>${stats.maxConsecWins} / ${stats.maxConsecLosses}</td></tr>
<tr><th>Vol-targeting scale factor</th><td>${volTargetScaleFromDb(db).toFixed(2)}</td></tr>
<tr><th>Today AI spend (Claude)</th><td>$${anthropicSpendToday.toFixed(4)}</td></tr>
<tr><th>Total AI spend</th><td>$${stats.totalAiSpend.toFixed(4)}</td></tr>
</table>

<h2>P&amp;L by direction</h2>
<table>
<tr><th>Direction</th><th>Trades</th><th>Wins</th><th>Win rate</th><th>Total P&amp;L</th><th>Funding</th></tr>
${stats.byDirection.map((d) => `<tr><td>${esc(d.direction)}</td><td>${d.trades}</td><td>${d.wins}</td><td>${d.trades ? ((d.wins / d.trades) * 100).toFixed(1) : 'n/a'}%</td><td class="${d.total_pnl >= 0 ? 'pos' : 'neg'}">${usd(d.total_pnl)}</td><td>${usd(d.funding)}</td></tr>`).join('\n') || '<tr><td colspan="6">no closed trades yet</td></tr>'}
</table>

<h2>Regime accuracy (profitable trades per regime at entry)</h2>
<table>
<tr><th>Regime</th><th>Trades</th><th>Correct</th><th>Hit rate</th><th>Avg return %</th></tr>
${stats.regimeAccuracy.map((r) => `<tr><td>${esc(r.regime)}</td><td>${r.trades}</td><td>${r.correct}</td><td>${r.trades ? ((r.correct / r.trades) * 100).toFixed(1) : 'n/a'}%</td><td>${r.avg_return_pct === null ? 'n/a' : r.avg_return_pct.toFixed(2)}</td></tr>`).join('\n') || '<tr><td colspan="5">no completed trades with regime data yet</td></tr>'}
</table>

<h2>Open positions</h2>
<table>
<tr><th>Pair</th><th>Direction</th><th>Lev</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Take-profit</th><th>Margin</th><th>Funding paid</th><th>Opened</th></tr>
${open.map((p) => `<tr><td>${esc(p.pair)}</td><td>${dirTag(p.direction)}</td><td>${p.leverage ?? config.leverage}x</td><td>${p.qty.toFixed(6)}</td><td>${p.entry_price.toFixed(2)}</td><td>${p.stop_price.toFixed(2)}</td><td>${p.tp_price.toFixed(2)}</td><td>${usd(p.margin ?? 0)}</td><td>${usd(p.funding_paid ?? 0)}</td><td>${esc(p.entry_time)}</td></tr>`).join('\n') || '<tr><td colspan="10">none</td></tr>'}
</table>

<h2>Closed trades</h2>
<table>
<tr><th>Pair</th><th>Direction</th><th>Entry</th><th>Exit</th><th>Qty</th><th>P&amp;L</th><th>Funding</th><th>Reason</th><th>Closed at</th></tr>
${stats.closed.map((t) => `<tr><td>${esc(t.pair)}</td><td>${dirTag(t.direction)}</td><td>${t.entry_price.toFixed(2)}</td><td>${(t.exit_price ?? 0).toFixed(2)}</td><td>${t.qty.toFixed(6)}</td><td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${usd(t.pnl)}</td><td>${usd(t.funding_paid ?? 0)}</td><td>${esc(t.exit_reason)}</td><td>${esc(t.exit_time)}</td></tr>`).join('\n') || '<tr><td colspan="9">none</td></tr>'}
</table>

${orders.length ? `<h2>Recent orders — real fill vs signal price</h2>
<table>
<tr><th>Time</th><th>Pair</th><th>Side</th><th>Dir</th><th>Req qty</th><th>Exec qty</th><th>Signal</th><th>Fill</th><th>Slip (bps)</th><th>Status</th><th>Order ID</th></tr>
${orders.map((o) => {
  const slip = o.fill_price && o.signal_price ? ((o.fill_price / o.signal_price - 1) * 10_000).toFixed(1) : 'n/a';
  return `<tr><td>${esc(o.ts)}</td><td>${esc(o.pair)}</td><td>${esc(o.side)}</td><td>${esc(o.direction ?? '')}</td><td>${o.requested_qty ?? ''}</td><td>${o.executed_qty ?? ''}</td><td>${o.signal_price?.toFixed(2) ?? ''}</td><td>${o.fill_price?.toFixed(2) ?? ''}</td><td>${slip}</td><td>${esc(o.status)}</td><td>${esc(o.order_id ?? '')}</td></tr>`;
}).join('\n')}
</table>` : ''}

<h2>Last 10 regime calls</h2>
<table>
<tr><th>Time</th><th>Pair</th><th>Regime</th><th>Conf</th><th>Trade allowed</th><th>Cost</th><th>Reasoning</th></tr>
${regimes.map((r) => `<tr><td>${esc(r.ts)}</td><td>${esc(r.pair)}</td><td>${esc(r.regime)}</td><td>${r.confidence}</td><td>${r.trade_allowed ? 'yes' : 'no'}</td><td>$${(r.est_cost ?? 0).toFixed(4)}</td><td style="text-align:left">${esc(r.reasoning)}</td></tr>`).join('\n') || '<tr><td colspan="7">none</td></tr>'}
</table>
</body></html>`;

  fs.mkdirSync(config.reportsDir, { recursive: true });
  const file = path.join(config.reportsDir, `${date}.html`);
  fs.writeFileSync(file, html);
  return file;
}

export function consoleSummary(prices = {}, db = getDb()) {
  const equity = getEquity(prices, db);
  const cash = getCash(db);
  const open = getOpenPositions(db);
  const claudeSpend = getDailySpend(db, undefined, 'anthropic');
  const pnl = todayPnl(db);
  const lines = [
    '── TradePilot-Futures cycle summary ' + '─'.repeat(22),
    `EXECUTOR: FUTURES TESTNET (${config.leverage}x leverage) — no real funds`,
    `equity: $${equity.toFixed(2)}   cash: $${cash.toFixed(2)}   margin locked: $${getMarginLocked(db).toFixed(2)}   today P&L: $${pnl.toFixed(2)}   today AI spend: $${claudeSpend.toFixed(4)}`,
  ];
  if (open.length) {
    for (const p of open) {
      const mark = prices[p.pair] ?? p.entry_price;
      const upnl = unrealizedPnl(p, mark);
      lines.push(
        `  open ${p.direction.toUpperCase()} ${p.pair} ${p.leverage ?? config.leverage}x: qty ${p.qty.toFixed(6)} @ ${p.entry_price.toFixed(2)} | stop ${p.stop_price.toFixed(2)} | tp ${p.tp_price.toFixed(2)} | funding $${(p.funding_paid ?? 0).toFixed(4)} | uPnL $${upnl.toFixed(2)}`,
      );
    }
  } else {
    lines.push('  open positions: none');
  }
  lines.push('─'.repeat(58));
  const text = lines.join('\n');
  console.log(text);
  return text;
}

// `npm run report`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = generateReport();
  consoleSummary();
  console.log(`report written: ${file}`);
}
