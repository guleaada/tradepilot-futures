# TradePilot-Futures

**A PAPER futures fork of TradePilot on the Binance USD-M FUTURES TESTNET. It trades BOTH directions (long + short) with leverage capped at 5x (default 3x). No real funds — mainnet futures trading is intentionally not implemented anywhere in this codebase.**

This bot runs in **PARALLEL with the spot TradePilot for a 30-day A/B comparison**: same hybrid architecture (Claude regime layer + deterministic rule engine + SQLite logging + Telegram alerts + daily HTML report), same signals cadence, its own repo, its own database, its own workflow. At the end of the window the two equity curves, win rates, and expectancies can be compared head-to-head — the only variables are shorting and leverage.

## Why leverage is capped

Leverage is clamped to a hard ceiling of **5x** (`MAX_ALLOWED_LEVERAGE` in [src/config.js](src/config.js), deliberately not env-overridable), with a tested default of **3x**. The reason is measurement, not timidity: at higher leverage, ordinary crypto wicks put the liquidation price *inside* the ATR stop, so positions die by liquidation before the strategy's stop can fire. Every loss then measures the liquidation engine, not the strategy — which destroys the ability to estimate edge, the entire point of this 30-day experiment. Position sizing already ignores leverage (risk is always 1% of equity from the ATR stop distance; leverage only changes margin locked), so extra leverage adds liquidation risk without adding any return to the measured strategy. Raise the ceiling deliberately, in code review, only after the 30 days of data say the stops behave.

## What it does

Every 15 minutes (GitHub Actions cron, or a local loop):

1. Pulls real market data (spot klines for indicators — same geo-block failover as the spot bot — plus the futures funding rate, mainnet-first with futures-testnet fallback). The default universe is **15 liquid USD-M perps** (BTC, ETH, SOL, BNB, XRP, AVAX, LINK, APT, ARB, INJ, SUI, TIA, DOGE, NEAR, LTC); the liquidity filter judges each by **futures 24h quote volume** (spot volume as the proxy where fapi is geo-blocked, e.g. CI runners) and prunes anything under $10M per run. `MAX_POSITIONS` stays 2: more pairs means more candidate setups for the same two slots, not more concurrent risk.
2. Asks Claude for a regime opinion per pair (`bullish` / `bearish` / `chop` + confidence), max once per 4h per pair, behind a hard $0.50/day budget cap with an optional free Groq pre-filter. **A confident bearish call is actionable here — it opens shorts** (in the spot bot it could only block longs).
3. Runs the deterministic rule engine — the only component that ever places orders:
   - **Long entry**: bullish regime (conf ≥ 60), price above the 4h EMA50 and daily EMA50, RSI in the long band (~45–70, ATR-adaptive), volume confirmation, not over-correlated with open positions.
   - **Short entry**: bearish regime (conf ≥ 60), price **below** the 4h EMA50 and daily EMA50, RSI in the symmetric short band (~30–55: not oversold, not knife-catching a bounce), same volume/correlation filters.
   - **Chandelier ATR trailing stop** (profit lever): once a trade is past breakeven, the stop ratchets to follow the high-water mark by 2·ATR — tightening only, never loosening. A strong run keeps heading toward its (wide, trend-scaled) TP, but a reversal is caught near the peak instead of falling back to breakeven. `TRAILING_ATR_ENABLED=false` restores the fixed stop-at-breakeven behavior.
   - **Stops/targets, symmetric with a trend-scaled TP**: stop = entry ∓ 1.5·ATR — the stop distance NEVER changes. The TP scales with trend strength, measured by **ADX(14) on the 4h candles** (chosen over an EMA-slope proxy: standard, textbook-verifiable, no extra tuning knobs): ADX ≥ 30 → strong → TP 4.5·ATR (let winners run), ADX < 18 → weak → 2.0·ATR, otherwise 2.5·ATR (today's default). `DYNAMIC_TP_ENABLED=false` restores the fixed 2.5·ATR exactly (test-proven). Breakeven at +1.5R favorable, 50% partial at +2R; the runner's target scales with the trade's TP class (strong-trend runner: 4R × 4.5/2.5 = 7.2R). Exits on stop, TP, or an opposite-direction regime flip with confidence ≥ 70. The daily report tracks **average realized R by trend class** so day-30 review shows whether the wider TPs actually captured bigger moves.
   - Max 2 positions, one per symbol — a simultaneous long+short on the same pair is structurally impossible.
4. Executes MARKET orders on the **futures testnet** (one-way mode; shorts open with SELL and close with reduce-only BUY), records actual fills, fees, and order IDs.
5. Charges **funding** to any position held through an 8h funding boundary (longs pay positive rates, shorts receive them), so reported P&L reflects real futures economics.
6. Logs everything to SQLite, alerts via Telegram (every message is branded `FUTURES TESTNET (Nx leverage)` so it can't be confused with the spot bot), and writes a daily HTML report with a per-direction P&L split.

## Futures-specific risk controls (deterministic, never AI-controlled)

- **Isolated margin only**, forced per symbol at startup (never cross-margin). Leverage set per symbol via the exchange API, clamped to the ceiling (`LEVERAGE_CLAMPED` logged if the env asks for more).
- **Risk is never leverage-based**: 1% of equity per trade from the ATR stop distance. Leverage only affects margin locked.
- **Liquidation buffer**: the estimated liquidation price must sit at least 1.25× the stop distance from entry, so the stop always fires before the liquidation engine. If not, size is reduced until it does (`SIZE_REDUCED_FOR_LIQ_BUFFER`). At ≤5x with normal ATR stops this never binds — by design.
- **Leverage-exposure cap**: total open notional ≤ equity × leverage × 0.5 — never more than half the leveraged buying power (`LEVERAGE_EXPOSURE_CAP` when it blocks).
- Carried over from spot: 3% daily drawdown halt, 4h cooldown after a stop-out, liquidity filter, correlation filter, volatility targeting, emergency exit on a 5% adverse move (direction-aware).
- **State reconciliation**: local wallet vs `/fapi/v2/account` every cycle; on mismatch, new entries are blocked that cycle (`STATE_MISMATCH`).

## Safety properties

- The executor base URL is a **frozen constant** `https://testnet.binancefuture.com` — not in config, not env-overridable. Startup asserts it contains `testnet` and refuses to run otherwise.
- Keys come from `BINANCE_FUTURES_TESTNET_API_KEY/SECRET` (created at [testnet.binancefuture.com](https://testnet.binancefuture.com)); mainnet rejects them.
- **There is no mainnet/live futures executor anywhere in this codebase, and none should be added.**
- The AI layer only ever emits `{regime, confidence, trade_allowed, reasoning}`. It cannot size, set leverage, or place orders.
- No Grok/X-sentiment layer: the xAI Live Search API is deprecated, so it was left out of this fork entirely.

## Setup

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY + futures testnet keys
npm test               # 85 tests, no network
TRADEPILOT_MOCK=1 npm run cycle   # offline demo: opens a LONG and a SHORT
npm run cycle          # one real cycle against the futures testnet
npm start              # continuous loop
npm run report         # write reports/YYYY-MM-DD.html
```

For CI (GitHub Actions, [.github/workflows/tradepilot-futures.yml](.github/workflows/tradepilot-futures.yml)): set the repo secrets `ANTHROPIC_API_KEY`, `BINANCE_FUTURES_TESTNET_API_KEY`, `BINANCE_FUTURES_TESTNET_API_SECRET`, and optionally `GROQ_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, plus the repo variable `FUTURES_LEVERAGE` (clamped to 5 in code). The workflow runs every 15 minutes, commits its own DB and reports back to the repo, and uses the same race-tolerant push handling as the spot bot (rebase `-X theirs`, 3 retries, never fails the job on a benign push race — a real push failure sends a distinct `DB_COMMIT_FAILED` Telegram alert).

## The A/B experiment

| | Spot TradePilot | TradePilot-Futures (this repo) |
|---|---|---|
| Venue | Binance Spot testnet / paper | Binance USD-M **futures testnet** |
| Directions | Long only | **Long + short** |
| Leverage | 1x | **3x default, 5x hard ceiling**, isolated |
| Bearish regime | Blocks entries | **Opens shorts** |
| Funding | n/a | Charged/received at each 8h boundary |
| Sentiment layer | Grok (now removed) | Not included |
| Everything else | — identical by design — |

Keep both bots running over the same 30 days, then compare `reports/` (equity curve, win rate, profit factor, expectancy, max drawdown, and this repo's per-direction P&L split) to decide whether shorting + modest leverage earns its added complexity.

## Repo layout

```
src/
  index.js                        orchestration loop (cycle, funding, alerts)
  config.js                       all tunables; MAX_ALLOWED_LEVERAGE ceiling
  db.js                           SQLite schema (direction, funding_paid, leverage, margin)
  indicators.js                   hand-rolled EMA/RSI/ATR/correlation (unchanged from spot)
  alert.js                        Telegram (best-effort, never throws)
  notify.js                       CI bookkeeping-failure notifier
  data/binance.js                 market data + host failover + trending mock data
  ai/regime.js                    Claude regime calls (shorting-aware prompt)
  ai/budget.js                    daily spend cap
  engine/rules.js                 deterministic long/short rules + futures risk controls
  engine/portfolio.js             margin-model portfolio, funding accounting
  engine/futuresTestnetExecutor.js  the ONLY executor — frozen testnet URL
  report/daily.js                 HTML + console reports (direction/leverage/funding)
test/                             85 tests incl. shorts, liq buffer, clamp, funding
```
