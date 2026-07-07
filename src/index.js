// TradePilot-Futures entry point + orchestration loop.
//
//   npm start      -> continuous loop (one cycle every cycleMinutes)
//   npm run cycle  -> single pass (used by GitHub Actions)
//
// FUTURES TESTNET fork: trades BOTH directions (long + short) with capped
// leverage. The ONLY executor is the Binance USD-M futures TESTNET — there is
// no paper simulator and, deliberately, no mainnet executor.
//
// Defensive everywhere: a failure on one pair logs an event and the loop
// continues. The process never crashes the loop on network/AI/DB errors.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config, MAX_ALLOWED_LEVERAGE } from './config.js';
import { closeDb, getDb, logEvent, nowIso } from './db.js';
import { getDailyKlines, getFundingRate, getFuturesTicker24h, getKlines, getTicker24h } from './data/binance.js';
import { adx, atr, correlation, ema, last, returns, rsi, sma, volatility } from './indicators.js';
import { buildMarketSummary, getRegime, regimeCallOutcomes } from './ai/regime.js';
import { sendAlert } from './alert.js';
import {
  assertFuturesTestnetBase,
  createMockFuturesFetch,
  FUTURES_TESTNET_BASE,
  FuturesTestnetExecutor,
} from './engine/futuresTestnetExecutor.js';
import { dynamicRsiBounds, runPairRules } from './engine/rules.js';
import {
  applyFunding,
  drawdownFromPeak,
  fundingCost,
  getCash,
  getEquity,
  getOpenPositions,
  lastFundingBoundary,
  pnlForDate,
  snapshotEquity,
  trailing7dStats,
  volTargetScaleFromDb,
} from './engine/portfolio.js';
import { consoleSummary } from './report/daily.js';
import { getDailySpend } from './ai/budget.js';

// Selected in main(). Always the futures TESTNET executor (with the mock
// transport under TRADEPILOT_MOCK=1). No live executor exists in this codebase.
let executor = null;
let activePairs = config.pairs;

// Test-only seams: let suites drive runCycle deterministically without going
// through main()/network. Not used in production.
export function __setActivePairs(pairs) { activePairs = pairs; }
export function __setExecutor(ex) { executor = ex; }

export function buildExecutor() {
  assertFuturesTestnetBase(FUTURES_TESTNET_BASE); // refuse to start unless the URL is testnet
  console.log('EXECUTOR: BINANCE USD-M FUTURES TESTNET — no real funds');
  if (config.mock) {
    return new FuturesTestnetExecutor({ apiKey: 'mock', apiSecret: 'mock', fetchImpl: createMockFuturesFetch() });
  }
  return new FuturesTestnetExecutor();
}

// Refuse to trade on a corrupted database.
function checkDbIntegrity(db) {
  const rows = db.pragma('integrity_check');
  const result = rows?.[0]?.integrity_check ?? 'unknown';
  if (result !== 'ok') {
    console.error(`CRITICAL: SQLite integrity_check failed: ${result}`);
    process.exit(1);
  }
}

// Drop illiquid pairs for this run, judged by the FUTURES 24h quote volume
// (getFuturesTicker24h; falls back to spot volume as a proxy where the
// futures endpoint is geo-blocked — see data/binance.js). Lenient by design —
// a pair is only excluded on a *confirmed* low volume reading. Any lookup
// failure or non-finite/zero volume KEEPS the pair, so a data hiccup can
// never silently zero out the whole universe.
export async function filterPairsByLiquidity(db, deps = {}) {
  const ticker = deps.getTicker24h ?? getFuturesTicker24h;
  const kept = [];
  for (const pair of config.pairs) {
    try {
      const t = await ticker(pair);
      const vol = Number(t?.quoteVolume);
      if (!Number.isFinite(vol) || vol <= 0) {
        kept.push(pair); // unknown volume -> keep
        logEvent('LIQUIDITY_CHECK_UNAVAILABLE', { pair, quoteVolume: t?.quoteVolume ?? null }, db);
        console.log(`[${pair}] liquidity unknown (quoteVolume=${t?.quoteVolume}) — keeping pair`);
      } else if (vol >= config.liquidityMinVolume24h) {
        kept.push(pair);
      } else {
        logEvent('PAIR_EXCLUDED', { pair, quoteVolume24h: vol, min: config.liquidityMinVolume24h, source: t?.source ?? 'unknown' }, db);
        console.log(`[${pair}] excluded: 24h quote volume ${Math.round(vol).toLocaleString()} < ${config.liquidityMinVolume24h.toLocaleString()} (${t?.source ?? 'unknown'})`);
      }
    } catch (err) {
      kept.push(pair); // lookup threw (e.g. geo-block) -> keep, never silently drop
      logEvent('LIQUIDITY_CHECK_UNAVAILABLE', { pair, error: String(err).slice(0, 200) }, db);
    }
  }

  // Safety net: if filtering somehow emptied the universe, trade the configured
  // majors rather than trading nothing and hiding it.
  if (kept.length === 0 && config.pairs.length > 0) {
    logEvent('LIQUIDITY_FILTER_BYPASSED', { configuredPairs: config.pairs }, db);
    await sendAlert(`⚠️ TradePilot-Futures: liquidity filter returned 0 pairs — falling back to the full configured list (${config.pairs.join(', ')}).`);
    return [...config.pairs];
  }
  return kept;
}

async function loadMarket(pair) {
  const [k1h, k4h, kDaily, ticker, fundingRate] = await Promise.all([
    getKlines(pair, '1h'),
    getKlines(pair, '4h'),
    getDailyKlines(pair),
    getTicker24h(pair),
    getFundingRate(pair),
  ]);
  const closes1h = k1h.map((k) => k.close);
  const closes4h = k4h.map((k) => k.close);
  const closesDaily = kDaily.map((k) => k.close);
  const volumes1h = k1h.map((k) => k.volume);
  const volSma20 = last(sma(volumes1h, 20));
  const price = ticker.lastPrice || closes1h[closes1h.length - 1];
  return {
    price,
    closes1h,
    last5: k1h.slice(-5).map((k) => ({
      o: +k.open.toFixed(2), h: +k.high.toFixed(2), l: +k.low.toFixed(2), c: +k.close.toFixed(2),
    })),
    rsi1h: last(rsi(closes1h, 14)),
    atr1h: last(atr(k1h, 14)),
    atrSeries1h: atr(k1h, 14),
    ema20_1h: last(ema(closes1h, 20)),
    ema50_1h: last(ema(closes1h, 50)),
    ema200_1h: last(ema(closes1h, 200)),
    ema20_4h: last(ema(closes4h, 20)),
    ema50_4h: last(ema(closes4h, 50)),
    ema200_4h: last(ema(closes4h, 200)),
    adx4h: last(adx(k4h, 14)), // trend strength for the dynamic take-profit
    dailyEma50: last(ema(closesDaily, 50)),
    volumeRatio: volSma20 > 0 ? volumes1h[volumes1h.length - 1] / volSma20 : null,
    vol20: volatility(closes1h, 20),
    change24hPct: ticker.priceChangePercent,
    volume24h: ticker.quoteVolume,
    fundingRate,
  };
}

// Is the candidate pair too correlated with any currently open position?
// Correlation is direction-agnostic on purpose: two open positions on
// co-moving pairs concentrate risk whether they are long or short.
function correlationBlockedFor(pair, markets, db, cfg = config) {
  if (!cfg.correlationFilterEnabled) return false;
  const candidate = markets[pair];
  if (!candidate) return false;
  const candReturns = returns(candidate.closes1h.slice(-21)); // 20-period return correlation
  for (const pos of getOpenPositions(db)) {
    if (pos.pair === pair) continue;
    const other = markets[pos.pair];
    if (!other) continue;
    const corr = correlation(candReturns, returns(other.closes1h.slice(-21)));
    if (corr !== null && corr >= cfg.correlationMax) {
      logEvent('CORRELATION_BLOCKED', { pair, against: pos.pair, correlation: Number(corr.toFixed(3)) }, db);
      return true;
    }
  }
  return false;
}

function btcDominanceApprox(markets) {
  const btc = markets.BTCUSDT;
  if (!btc) return null;
  const total = Object.values(markets).reduce((s, m) => s + (m.volume24h || 0), 0);
  return total > 0 ? Number(((btc.volume24h / total) * 100).toFixed(2)) : null;
}

// Charge funding to any open position that was held through the most recent
// 8h funding boundary (00:00 / 08:00 / 16:00 UTC). Longs pay positive rates,
// shorts receive them (and vice versa). last_funding_ts guards against
// charging the same boundary twice; a null rate (endpoint unreachable) skips
// the charge rather than guessing.
export async function applyFundingCosts(markets, db, nowMs = Date.now()) {
  const boundaryMs = lastFundingBoundary(nowMs);
  const boundaryIso = new Date(boundaryMs).toISOString();
  for (const pos of getOpenPositions(db)) {
    const openedMs = Date.parse(pos.entry_time);
    const alreadyAppliedMs = pos.last_funding_ts ? Date.parse(pos.last_funding_ts) : null;
    if (openedMs >= boundaryMs) continue; // opened after the boundary: not held through it
    if (alreadyAppliedMs !== null && alreadyAppliedMs >= boundaryMs) continue; // already charged
    const market = markets[pos.pair];
    const rate = market?.fundingRate;
    if (!Number.isFinite(rate)) continue;
    const mark = market.price ?? pos.entry_price;
    const cost = fundingCost(pos.direction, pos.qty, mark, rate);
    applyFunding(pos.id, cost, boundaryIso, db);
    logEvent('FUNDING_APPLIED', {
      pair: pos.pair, tradeId: pos.id, direction: pos.direction,
      boundary: boundaryIso, rate, mark, cost: Number(cost.toFixed(6)),
    }, db);
    console.log(`[${pos.pair}] funding ${cost >= 0 ? 'paid' : 'received'} $${Math.abs(cost).toFixed(4)} (${pos.direction}, rate ${rate})`);
  }
}

// Pure: build the daily-summary numbers and message. Reports the just-COMPLETED
// UTC day (yesterday relative to send time) for spend and P&L — the alert fires
// in the morning, before the day's first 4h-cadence Claude call, so "today"
// would legitimately read $0.0000. Equity and open positions stay live/now.
// The header names the executor and leverage so this can never be confused
// with the spot bot's messages.
export function computeDailySummary(db, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const summaryDate = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const equity = getEquity({}, db);
  const open = getOpenPositions(db).length;
  const prevClaude = getDailySpend(db, summaryDate, 'anthropic');
  const prevPnl = pnlForDate(db, summaryDate);
  const todayClaude = getDailySpend(db, today, 'anthropic');
  const todayPnlVal = pnlForDate(db, today);
  const message =
    `📊 TradePilot-Futures summary for ${summaryDate} — EXECUTOR: FUTURES TESTNET (${config.leverage}x leverage)\n` +
    `equity now $${equity.toFixed(2)} | open positions ${open} | P&L on ${summaryDate} $${prevPnl.toFixed(2)}\n` +
    `AI spend ${summaryDate}: claude $${prevClaude.toFixed(4)}\n` +
    `today so far: P&L $${todayPnlVal.toFixed(2)} | claude $${todayClaude.toFixed(4)}`;
  return { today, summaryDate, equity, open, prevClaude, prevPnl, message };
}

async function maybeSendDailySummaryAlert(db) {
  // Guard keys off the SEND day (today) so we send exactly once per calendar
  // day, even though the figures reported are for the prior day.
  const today = new Date().toISOString().slice(0, 10);
  const sent = db
    .prepare("SELECT id FROM events WHERE type = 'ALERT_DAILY_SUMMARY' AND ts >= ? LIMIT 1")
    .get(`${today}T00:00:00`);
  if (sent) return;
  const summary = computeDailySummary(db);
  const ok = await sendAlert(summary.message);
  if (ok) logEvent('ALERT_DAILY_SUMMARY', { date: today, reported: summary.summaryDate }, db);
}

async function sendEventAlerts(db, cycleStartIso) {
  const rows = db
    .prepare("SELECT type, detail FROM events WHERE ts >= ? AND type IN ('RISK_HALT', 'REGIME_PARSE_FAILURE', 'ORPHAN_POSITION_CLOSED', 'STATE_RESYNCED')")
    .all(cycleStartIso);
  for (const row of rows) {
    await sendAlert(`⚠️ TradePilot-Futures ${row.type}: ${row.detail}`);
  }
  // 3rd consecutive budget skip today -> one alert.
  const today = new Date().toISOString().slice(0, 10);
  const skips = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'BUDGET_SKIPPED' AND ts >= ?")
    .get(`${today}T00:00:00`).n;
  if (skips === 3) {
    const newSkip = db
      .prepare("SELECT id FROM events WHERE type = 'BUDGET_SKIPPED' AND ts >= ? LIMIT 1")
      .get(cycleStartIso);
    if (newSkip) await sendAlert('⚠️ TradePilot-Futures: 3rd consecutive BUDGET_SKIPPED today — Claude regime calls are budget-starved.');
  }
}

// `db` is overridable for tests; production calls runCycle() with the singleton.
export async function runCycle(db = getDb()) {
  const cycleStartIso = nowIso();
  const prices = {};
  const markets = {};

  // Refresh the on-disk backup before touching anything.
  if (config.dbPath !== ':memory:' && fs.existsSync(config.dbPath)) {
    try {
      await db.backup(`${config.dbPath}.bak`);
    } catch (err) {
      console.error('db backup failed:', err.message);
    }
  }

  await maybeSendDailySummaryAlert(db);

  // A cycle that evaluates zero pairs must never look like a healthy cycle.
  // The event is logged every cycle; the alert is throttled to once per UTC
  // day so a persistent empty universe can't spam Telegram forever.
  if (activePairs.length === 0) {
    logEvent('NO_ACTIVE_PAIRS', { configuredPairs: config.pairs }, db);
    const today = new Date().toISOString().slice(0, 10);
    const alreadyAlerted = db
      .prepare("SELECT id FROM events WHERE type = 'NO_ACTIVE_PAIRS_ALERTED' AND ts >= ? LIMIT 1")
      .get(`${today}T00:00:00`);
    if (!alreadyAlerted) {
      await sendAlert('⚠️ TradePilot-Futures: 0 active pairs after liquidity filter — AI layer did not run this cycle');
      logEvent('NO_ACTIVE_PAIRS_ALERTED', { date: today }, db);
    }
    consoleSummary(prices, db);
    return;
  }

  // Reconcile local wallet against the exchange at cycle start. On
  // STATE_MISMATCH, exits still run but new entries are blocked this cycle.
  let entriesBlocked = false;
  if (executor && typeof executor.reconcile === 'function') {
    entriesBlocked = !(await executor.reconcile(db));
    if (entriesBlocked) console.warn('STATE_MISMATCH: blocking new entries this cycle (see events table)');
  }

  // Phase 1: load market data for every active pair (needed up front so the
  // correlation filter and BTC dominance can see all pairs at once).
  for (const pair of activePairs) {
    try {
      markets[pair] = await loadMarket(pair);
      prices[pair] = markets[pair].price;
    } catch (err) {
      console.error(`[${pair}] market load error:`, err.message);
      try {
        logEvent('ERROR', { pair, error: String(err).slice(0, 500) }, db);
      } catch { /* never let logging kill the loop */ }
    }
  }

  // Phase 1b: charge funding for positions held through a funding boundary,
  // so the report reflects real futures economics.
  try {
    await applyFundingCosts(markets, db);
  } catch (err) {
    console.error('funding accounting error:', err.message);
  }

  const volScale = volTargetScaleFromDb(db, config);
  if (volScale < 1) console.log(`volatility targeting: scaling new positions by ${volScale.toFixed(2)}`);

  // Phase 2: AI opinions + deterministic rules per pair.
  for (const pair of activePairs) {
    const market = markets[pair];
    if (!market) continue;
    try {
      const stats7d = trailing7dStats(db);
      const context = {
        portfolio_drawdown_pct: Number((drawdownFromPeak(db) * 100).toFixed(2)),
        btc_volume_dominance_pct_approx: btcDominanceApprox(markets),
        win_rate_7d: stats7d.winRate,
        profit_factor_7d: stats7d.profitFactor === Infinity ? 'inf' : stats7d.profitFactor,
      };
      const recentCalls = regimeCallOutcomes(pair, db, 5);
      const recentTrades = db
        .prepare("SELECT exit_time, direction, pnl, exit_reason FROM trades WHERE pair = ? AND status = 'closed' ORDER BY id DESC LIMIT 3")
        .all(pair);
      const summary = buildMarketSummary(pair, market, recentCalls, recentTrades, context);
      const regime = await getRegime(pair, summary, db);

      const actions = await runPairRules({
        pair,
        price: market.price,
        atr1h: market.atr1h,
        rsi1h: market.rsi1h,
        ema50_4h: market.ema50_4h,
        dailyEma50: market.dailyEma50,
        adx4h: market.adx4h,
        volumeRatio: market.volumeRatio,
        rsiBounds: dynamicRsiBounds(market.atrSeries1h, config),
        correlationBlocked: correlationBlockedFor(pair, markets, db, config),
        regime,
        executor,
        db,
        prices,
        entriesBlocked,
        volScale,
      });
      for (const a of actions) {
        if (a.type === 'open') {
          const dirTag = a.direction.toUpperCase();
          const dirEmoji = a.direction === 'short' ? '🔴' : '🟢';
          const slipBps = ((a.entry / a.signal - 1) * 10_000).toFixed(1);
          const trendTag = a.trend ? `[trend: ${a.trend}, tp ${a.tpMult}xATR] ` : '';
          console.log(`[${pair}] OPEN ${dirTag} ${a.leverage}x ${trendTag}qty=${a.qty.toFixed(6)} fill=${a.entry.toFixed(2)} (signal ${a.signal.toFixed(2)}, ${slipBps}bps) stop=${a.stop.toFixed(2)} tp=${a.tp.toFixed(2)}`);
          await sendAlert(`${dirEmoji} ${dirTag} ${pair} ${a.leverage}x ${trendTag}qty ${a.qty.toFixed(6)} @ ${a.entry.toFixed(2)} | stop ${a.stop.toFixed(2)} | tp ${a.tp.toFixed(2)}`);
        } else if (a.type === 'close') {
          const dirTag = a.direction.toUpperCase();
          const slipBps = ((a.exit / a.signal - 1) * 10_000).toFixed(1);
          console.log(`[${pair}] CLOSE ${dirTag} reason=${a.reason} pnl=$${a.pnl.toFixed(2)} fill=${a.exit.toFixed(2)} (signal ${a.signal.toFixed(2)}, ${slipBps}bps)`);
          const emoji = a.reason === 'emergency_exit' ? '🚨' : a.pnl >= 0 ? '✅' : '🔻';
          await sendAlert(`${emoji} CLOSE ${dirTag} ${pair} (${a.reason}) P&L $${a.pnl.toFixed(2)} @ ${a.exit.toFixed(2)}`);
        } else if (a.type === 'partial_exit') {
          console.log(`[${pair}] PARTIAL EXIT ${a.direction.toUpperCase()} closed=${a.closedQty.toFixed(6)} pnl=$${a.partialPnl.toFixed(2)} new tp=${a.newTp.toFixed(2)}`);
          await sendAlert(`🟡 PARTIAL EXIT ${a.direction.toUpperCase()} ${pair} closed ${a.closedQty.toFixed(6)} P&L $${a.partialPnl.toFixed(2)} | remainder TP ${a.newTp.toFixed(2)}`);
        } else if (a.type === 'breakeven') {
          console.log(`[${pair}] STOP -> BREAKEVEN at ${a.newStop.toFixed(2)}`);
        } else if (a.type === 'exit_skipped') {
          console.log(`[${pair}] EXIT SKIPPED (${a.reason}) — position stays open, retrying next cycle`);
        } else {
          console.log(`[${pair}] no entry (${a.reason}) | regime=${regime.regime}/${regime.confidence} price=${market.price.toFixed(2)} rsi1h=${market.rsi1h?.toFixed(1)}`);
        }
      }
    } catch (err) {
      console.error(`[${pair}] cycle error:`, err.message);
      try {
        logEvent('ERROR', { pair, error: String(err).slice(0, 500) }, db);
      } catch { /* never let logging kill the loop */ }
    }
  }

  try {
    snapshotEquity(getEquity(prices, db), getCash(db), db);
    await sendEventAlerts(db, cycleStartIso);
    await checkNoAiCallsToday(db);
  } catch (err) {
    console.error('snapshot/alert error:', err.message);
  }
  consoleSummary(prices, db);
}

// "Everything ran fine and did nothing" is itself a reportable bug. Once per
// UTC day, past the first AI cadence window, if zero regime calls have been
// recorded today, log and alert once.
async function checkNoAiCallsToday(db) {
  const now = new Date();
  if (now.getUTCHours() < config.aiCadenceHours) return; // still inside the first window
  const today = now.toISOString().slice(0, 10);
  const already = db
    .prepare("SELECT id FROM events WHERE type = 'NO_AI_CALLS_TODAY' AND ts >= ? LIMIT 1")
    .get(`${today}T00:00:00`);
  if (already) return;
  const calls = db
    .prepare('SELECT COUNT(*) AS n FROM regime_calls WHERE ts >= ?')
    .get(`${today}T00:00:00`).n;
  if (calls > 0) return;
  logEvent('NO_AI_CALLS_TODAY', { date: today, activePairs }, db);
  await sendAlert(`⚠️ TradePilot-Futures: no regime calls recorded today (${today}) despite the cycle running — the AI layer is not executing.`);
}

async function main() {
  const once = process.argv.includes('--once');
  console.log(`TradePilot-Futures — NO REAL FUNDS (USD-M futures testnet)${config.mock ? ' [MOCK DATA]' : ''}`);
  console.log(`pairs: ${config.pairs.join(', ')} | leverage: ${config.leverage}x (ceiling ${MAX_ALLOWED_LEVERAGE}x) | cycle: ${config.cycleMinutes}m | AI cadence: ${config.aiCadenceHours}h | budget: $${config.aiDailyBudgetUsd}/day`);

  const db = getDb();
  checkDbIntegrity(db);

  if (config.leverageWasClamped) {
    console.warn(`LEVERAGE_CLAMPED: FUTURES_LEVERAGE=${config.requestedLeverage} exceeds the hard ceiling ${MAX_ALLOWED_LEVERAGE} — using ${config.leverage}x`);
    logEvent('LEVERAGE_CLAMPED', { requested: config.requestedLeverage, ceiling: MAX_ALLOWED_LEVERAGE, using: config.leverage }, db);
  }

  executor = buildExecutor();
  if (typeof executor.init === 'function') await executor.init();

  activePairs = await filterPairsByLiquidity(db);
  console.log(`active pairs after liquidity filter: ${activePairs.join(', ') || '(none)'}`);

  await runCycle();
  if (once) {
    closeDb();
    return;
  }
  setInterval(() => {
    runCycle().catch((err) => console.error('cycle failed:', err.message));
  }, config.cycleMinutes * 60_000);
}

// Only run the loop when executed directly (node src/index.js). Importing the
// module (e.g. from tests) must not kick off main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exitCode = 1;
  });
}
