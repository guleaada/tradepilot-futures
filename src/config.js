// All tunables in one place. Every value can be overridden via .env / environment.
// FUTURES fork: adds leverage (hard-capped), futures-specific risk knobs, and
// drops the Grok/X-sentiment layer entirely (the xAI Live Search API is
// deprecated; the spot bot proved the system runs fine without it).
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const mock = process.env.TRADEPILOT_MOCK === '1';

// Hard ceiling on leverage, deliberately NOT env-overridable. At higher
// leverage, normal crypto wicks liquidate positions before the ATR stop can
// fire, which destroys the ability to measure strategy edge — every loss
// becomes a liquidation artifact instead of a strategy datapoint. Raise this
// constant deliberately, in code review, only after reviewing 30 days of data.
export const MAX_ALLOWED_LEVERAGE = 5;

// Binance requires an integer leverage >= 1. Values above the ceiling are
// clamped (index.js logs LEVERAGE_CLAMPED at startup when that happens).
const requestedLeverage = Math.max(1, Math.floor(num(process.env.FUTURES_LEVERAGE, 3)));

export const config = {
  // --- general ---
  mock, // mock mode: synthetic market data + canned AI regime, zero network calls
  rootDir: ROOT,
  dbPath: process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(ROOT, 'data', mock ? 'tradepilot-futures.mock.db' : 'tradepilot-futures.db'),
  reportsDir: path.join(ROOT, 'reports'),

  // --- market data ---
  // Indicators/signals come from SPOT klines (same proven client + geo-block
  // failover as the spot bot); orders execute on the futures testnet book.
  // USD-M futures track spot closely enough for 1h/4h/1d signals, and actual
  // fill prices are always recorded from the exchange response.
  pairs: list(process.env.PAIRS, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']),
  liquidityMinVolume24h: num(process.env.LIQUIDITY_MIN_VOLUME_24H, 10_000_000),
  binanceBase: process.env.BINANCE_BASE || 'https://api.binance.com',
  binanceFapiBase: process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com',
  binanceHosts: list(process.env.BINANCE_HOSTS, [
    process.env.BINANCE_BASE || 'https://api.binance.com',
    'https://data-api.binance.vision',
  ]),
  klineLimit: num(process.env.KLINE_LIMIT, 200),
  minPollMs: num(process.env.MIN_POLL_MS, 60_000),

  // --- loop cadence ---
  cycleMinutes: num(process.env.CYCLE_MINUTES, 15),
  aiCadenceHours: num(process.env.AI_CADENCE_HOURS, 4),
  aiMaxStaleHours: num(process.env.AI_MAX_STALE_HOURS, 8),

  // --- AI layer ---
  aiModel: process.env.AI_MODEL || 'claude-sonnet-4-6',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBase: process.env.ANTHROPIC_BASE || 'https://api.anthropic.com',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  aiDailyBudgetUsd: num(process.env.AI_DAILY_BUDGET_USD, 0.5),
  aiMaxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 1024),
  pricing: {
    inputPerMTok: num(process.env.AI_PRICE_INPUT_MTOK, 3.0),
    outputPerMTok: num(process.env.AI_PRICE_OUTPUT_MTOK, 15.0),
  },
  estInputTokens: num(process.env.AI_EST_INPUT_TOKENS, 2000),
  estOutputTokens: num(process.env.AI_EST_OUTPUT_TOKENS, 400),
  budgetDecayPoints: num(process.env.BUDGET_DECAY_POINTS, 20),

  // --- leverage (futures) ---
  leverage: Math.min(requestedLeverage, MAX_ALLOWED_LEVERAGE),
  requestedLeverage, // pre-clamp value, kept for the LEVERAGE_CLAMPED event
  leverageWasClamped: requestedLeverage > MAX_ALLOWED_LEVERAGE,
  // Maintenance margin rate used for the liquidation-price estimate. 0.5% is
  // conservative for the lowest USD-M notional tiers (BTC is 0.4%).
  maintMarginRate: num(process.env.MAINT_MARGIN_RATE, 0.005),
  // Liquidation must sit at least this multiple of the stop distance away
  // from entry; otherwise size is reduced (SIZE_REDUCED_FOR_LIQ_BUFFER).
  liqBufferMult: num(process.env.LIQ_BUFFER_MULT, 1.25),
  // Total open notional <= equity * leverage * this fraction: never use more
  // than half the available leveraged buying power.
  exposureCapFraction: num(process.env.LEVERAGE_EXPOSURE_CAP_FRACTION, 0.5),

  // --- risk rules (deterministic; never AI-controlled) ---
  startBalance: num(process.env.START_BALANCE, 1000),
  // Risk is 1% of equity per trade based on the ATR stop distance — NEVER
  // based on leverage. Leverage only affects margin required.
  riskPerTrade: num(process.env.RISK_PER_TRADE, 0.01),
  stopAtrMult: num(process.env.STOP_ATR_MULT, 1.5),
  tpAtrMult: num(process.env.TP_ATR_MULT, 2.5),
  maxPositions: num(process.env.MAX_POSITIONS, 2),
  maxNotionalPct: num(process.env.MAX_NOTIONAL_PCT, 0.25),
  dailyDrawdownHalt: num(process.env.DAILY_DRAWDOWN_HALT, 0.03),
  cooldownHours: num(process.env.COOLDOWN_HOURS, 4),
  regimeMinConfidence: num(process.env.REGIME_MIN_CONFIDENCE, 60),
  regimeFlipConfidence: num(process.env.REGIME_FLIP_CONFIDENCE, 70),
  rsiEntryMin: num(process.env.RSI_ENTRY_MIN, 45),
  rsiEntryMax: num(process.env.RSI_ENTRY_MAX, 70),
  // Symmetric short band: not oversold (>= 30), not knife-catching a bounce
  // (<= 55). Mirrors the long band [45, 70] around RSI 50.
  rsiShortEntryMin: num(process.env.RSI_SHORT_ENTRY_MIN, 30),
  rsiShortEntryMax: num(process.env.RSI_SHORT_ENTRY_MAX, 55),

  // --- entry filters (each degrades to the old behavior when disabled) ---
  volumeFilterEnabled: process.env.VOLUME_FILTER_ENABLED !== 'false',
  volumeMinRatio: num(process.env.VOLUME_MIN_RATIO, 1.1),
  mtfDailyFilterEnabled: process.env.MTF_DAILY_FILTER_ENABLED !== 'false',
  dynamicRsiEnabled: process.env.DYNAMIC_RSI_ENABLED !== 'false',
  correlationFilterEnabled: process.env.CORRELATION_FILTER_ENABLED !== 'false',
  correlationMax: num(process.env.CORRELATION_MAX, 0.85),
  weekendFilterEnabled: process.env.WEEKEND_FILTER_ENABLED === 'true',

  // --- trailing stop + partial exits (symmetric for shorts) ---
  trailingStopEnabled: process.env.TRAILING_STOP_ENABLED !== 'false',
  breakevenR: num(process.env.BREAKEVEN_R, 1.5),
  partialExitR: num(process.env.PARTIAL_EXIT_R, 2.0),
  partialExitFraction: num(process.env.PARTIAL_EXIT_FRACTION, 0.5),
  extendedTpR: num(process.env.EXTENDED_TP_R, 4.0),

  // --- regime-dependent risk sizing (direction-aware) ---
  regimeRiskScalingEnabled: process.env.REGIME_RISK_SCALING_ENABLED !== 'false',
  riskPctHighConf: num(process.env.RISK_PCT_HIGH_CONF, 0.015),
  maxNotionalHighConf: num(process.env.MAX_NOTIONAL_HIGH_CONF, 0.3),
  highConfThreshold: num(process.env.HIGH_CONF_THRESHOLD, 80),

  // --- emergency price-action exit (adverse move, direction-aware) ---
  emergencyExitEnabled: process.env.EMERGENCY_EXIT_ENABLED !== 'false',
  emergencyExitDropPct: num(process.env.EMERGENCY_EXIT_DROP_PCT, 0.05),

  // --- volatility targeting ---
  volTargetingEnabled: process.env.VOL_TARGETING_ENABLED !== 'false',
  volTargetAnnualized: num(process.env.VOL_TARGET_ANNUALIZED, 0.4),

  // --- Telegram alerts (optional; no-op when unset) ---
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // --- execution ---
  // There is exactly ONE executor: Binance USD-M FUTURES TESTNET. The base
  // URL is a frozen constant in engine/futuresTestnetExecutor.js — not
  // configurable, not env-overridable. NO mainnet/live futures executor
  // exists anywhere in this codebase, by design.
  executor: 'futures-testnet',
  binanceFuturesTestnetApiKey: process.env.BINANCE_FUTURES_TESTNET_API_KEY || '',
  binanceFuturesTestnetApiSecret: process.env.BINANCE_FUTURES_TESTNET_API_SECRET || '',

  // --- fill economics ---
  slippage: num(process.env.SLIPPAGE, 0.0005), // 0.05% against you per fill
  takerFee: num(process.env.TAKER_FEE, 0.0004), // 0.04% Binance USD-M taker fee per side
};

export default config;
