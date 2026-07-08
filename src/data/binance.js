// Binance public market data client. Real prices, no API key.
// Polite: per-URL cache (never refetch the same endpoint inside minPollMs)
// and exponential backoff on 429/418.
//
// FUTURES fork: signals still come from SPOT klines (same geo-block failover
// as the spot bot — fapi.binance.com is blocked on the same CI IPs and has no
// public mirror). Funding comes from the futures premiumIndex endpoint. Mock
// data gains per-pair TRENDS so demo cycles can open both longs and shorts.
import { config } from '../config.js';

const cache = new Map(); // url -> { ts, data }

async function fetchJson(url, { maxAttempts = 5, ttl = config.minPollMs } = {}) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        // Geo-block / forbidden are not transient — don't burn retries, let
        // the caller fail over to the next host immediately.
        if (res.status === 451 || res.status === 403) throw err;
        throw err;
      }
      const data = await res.json();
      cache.set(url, { ts: Date.now(), data });
      return data;
    } catch (err) {
      lastErr = err;
      if (err.status === 451 || err.status === 403) throw err; // no retry; fail over hosts
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr ?? new Error(`fetch failed: ${url}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Remember the host that last worked so we don't pay the geo-block round-trip
// on every call once we've found a reachable mirror.
let preferredHostIdx = 0;

// Fetch a spot market-data path, failing over across config.binanceHosts on a
// geo-block (451/403). Other errors propagate from fetchJson as before.
async function fetchSpot(path, opts = {}) {
  const hosts = config.binanceHosts.length ? config.binanceHosts : [config.binanceBase];
  const order = [preferredHostIdx, ...hosts.keys()].filter((v, i, a) => a.indexOf(v) === i && v < hosts.length);
  let lastErr;
  for (const idx of order) {
    try {
      const data = await fetchJson(`${hosts[idx]}${path}`, opts);
      preferredHostIdx = idx;
      return data;
    } catch (err) {
      lastErr = err;
      if (err.status === 451 || err.status === 403) continue; // try next host
      throw err; // non-geo error: surface immediately
    }
  }
  throw lastErr ?? new Error(`all Binance hosts failed for ${path}`);
}

function parseKline(k) {
  return {
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  };
}

export async function getKlines(pair, interval, limit = config.klineLimit, { ttl } = {}) {
  if (config.mock) return mockKlines(pair, interval, limit);
  const raw = await fetchSpot(`/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`, { ttl });
  return raw.map(parseKline);
}

// Daily candles change slowly — cache them for an hour instead of one minute.
export async function getDailyKlines(pair, limit = config.klineLimit) {
  return getKlines(pair, '1d', limit, { ttl: 3_600_000 });
}

export async function getTicker24h(pair) {
  if (config.mock) return mockTicker(pair);
  const raw = await fetchSpot(`/api/v3/ticker/24hr?symbol=${pair}`);
  return {
    lastPrice: Number(raw.lastPrice),
    priceChangePercent: Number(raw.priceChangePercent),
    volume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume),
  };
}

// FUTURES 24h ticker — the liquidity filter must judge pairs by USD-M perp
// volume, not spot volume. fapi.binance.com is geo-blocked on CI runner IPs
// (confirmed: funding came back unreachable on the first live cycle) and has
// no public mirror, so on failure this degrades to the SPOT ticker as a
// liquidity proxy (spot and perp liquidity correlate tightly on majors) with
// `source` marking which venue answered. Never uses the futures TESTNET
// ticker: testnet volumes reflect play-money activity, not real liquidity.
export async function getFuturesTicker24h(pair) {
  if (config.mock) return { ...mockTicker(pair), source: 'futures' };
  try {
    const raw = await fetchJson(`${config.binanceFapiBase}/fapi/v1/ticker/24hr?symbol=${pair}`, { maxAttempts: 2 });
    const quoteVolume = Number(raw.quoteVolume);
    if (Number.isFinite(quoteVolume) && quoteVolume > 0) {
      return {
        lastPrice: Number(raw.lastPrice),
        priceChangePercent: Number(raw.priceChangePercent),
        volume: Number(raw.volume),
        quoteVolume,
        source: 'futures',
      };
    }
  } catch { /* geo-block or outage: fall through to the spot proxy */ }
  return { ...(await getTicker24h(pair)), source: 'spot_proxy' };
}

// Funding rate from the futures premiumIndex endpoint. Mainnet fapi first
// (real market funding); when that is unreachable (geo-blocked CI), fall back
// to the futures TESTNET's premiumIndex — the venue we actually trade on, so
// its rate is what testnet economics would charge. Degrade to null on total
// failure: a null just means "no funding charged this cycle" (and the AI
// prompt notes it as unavailable).
const FUNDING_HOSTS = [
  () => config.binanceFapiBase,
  () => 'https://testnet.binancefuture.com',
];

export async function getFundingRate(pair) {
  if (config.mock) return mockFundingRate(pair);
  for (const host of FUNDING_HOSTS) {
    try {
      const raw = await fetchJson(`${host()}/fapi/v1/premiumIndex?symbol=${pair}`, { maxAttempts: 2 });
      const rate = Number(raw.lastFundingRate);
      if (Number.isFinite(rate)) return rate;
    } catch { /* try the next host */ }
  }
  return null;
}

// --- mock data (deterministic, used by tests and the demo cycle) ---

const MOCK_BASE = {
  BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150, BNBUSDT: 600, XRPUSDT: 0.5,
  AVAXUSDT: 30, LINKUSDT: 15, APTUSDT: 9, ARBUSDT: 0.8, INJUSDT: 25,
  SUIUSDT: 3, TIAUSDT: 5, DOGEUSDT: 0.12, NEARUSDT: 5, LTCUSDT: 100,
  XAUUSDT: 2600, XAGUSDT: 30,
};
// Distinct oscillation phases per pair so mock pairs are not perfectly
// correlated (lets the correlation filter behave realistically in demos).
// ETH's phase is chosen so the downtrend lands RSI mid-band (~46) at the
// last candle — inside the short entry zone, not oversold.
const MOCK_PHASE = {
  BTCUSDT: 0, ETHUSDT: 2.8, SOLUSDT: 3.1, BNBUSDT: 4.7, XRPUSDT: 0.8,
  AVAXUSDT: 1.2, LINKUSDT: 2.1, APTUSDT: 3.9, ARBUSDT: 5.3, INJUSDT: 0.4,
  SUIUSDT: 1.9, TIAUSDT: 2.5, DOGEUSDT: 3.4, NEARUSDT: 4.2, LTCUSDT: 5.8,
  XAUUSDT: 1.4, XAGUSDT: 0.8,
};
// Per-pair trend direction: +1 uptrend (long candidate), -1 downtrend (short
// candidate). BTC long + ETH short is the canonical mock A/B demo pair-up.
const MOCK_TREND = {
  BTCUSDT: 1, ETHUSDT: -1, SOLUSDT: 1, BNBUSDT: -1, XRPUSDT: 1,
  AVAXUSDT: 1, LINKUSDT: -1, APTUSDT: 1, ARBUSDT: 1, INJUSDT: -1,
  SUIUSDT: 1, TIAUSDT: -1, DOGEUSDT: -1, NEARUSDT: 1, LTCUSDT: -1,
  XAUUSDT: 1, XAGUSDT: -1,
};
// Explicit mock 24h quote volumes (USD) for the expanded pairs. APT and TIA
// sit deliberately BELOW the $10M threshold — together with SOL/XRP (derived
// below) they keep the PAIR_EXCLUDED path exercised in demos and tests. The
// original five keep their derived lastPrice*24000 volumes so long-standing
// mock behavior is unchanged.
const MOCK_QUOTE_VOL = {
  AVAXUSDT: 40_000_000, LINKUSDT: 35_000_000, APTUSDT: 6_000_000,
  ARBUSDT: 25_000_000, INJUSDT: 18_000_000, SUIUSDT: 22_000_000,
  TIAUSDT: 4_000_000, DOGEUSDT: 30_000_000, NEARUSDT: 15_000_000,
  LTCUSDT: 12_000_000,
  // Metals clear the $10M filter comfortably (gold especially).
  XAUUSDT: 45_000_000, XAGUSDT: 15_000_000,
};

export function mockTrend(pair) {
  return MOCK_TREND[pair] ?? 1;
}

// Positive funding on the long pair (longs pay), negative on the short pair
// (shorts pay), so both funding sign conventions get exercised in demos.
function mockFundingRate(pair) {
  return mockTrend(pair) > 0 ? 0.0001 : -0.0001;
}

export function mockKlines(pair, interval, limit = 200) {
  const base = MOCK_BASE[pair] ?? 100;
  const phase = MOCK_PHASE[pair] ?? 0;
  const trend = mockTrend(pair);
  const stepMs = interval === '1d' ? 86_400_000 : interval === '4h' ? 4 * 3600_000 : 3600_000;
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  let prevClose = base;
  for (let i = 0; i < limit; i++) {
    // Gentle trend with an oscillation. Uptrend keeps price above EMA50 with
    // RSI out of overbought; downtrend mirrors it (below EMA50, RSI in the
    // short band, not oversold).
    const close = base * (1 + trend * 0.0006 * i + 0.012 * Math.sin(i / 4 + phase));
    const open = prevClose;
    const high = Math.max(open, close) * 1.003;
    const low = Math.min(open, close) * 0.997;
    candles.push({
      openTime: start + i * stepMs,
      open,
      high,
      low,
      close,
      // Mild exponential growth keeps the latest volume ~12% above its
      // 20-period average, so the volume-confirmation filter can pass.
      volume: 500 * 1.012 ** i + 20 * Math.sin(i / 5 + phase),
      closeTime: start + (i + 1) * stepMs - 1,
    });
    prevClose = close;
  }
  return candles;
}

function mockTicker(pair) {
  const klines = mockKlines(pair, '1h', 200);
  const lastPrice = klines[klines.length - 1].close;
  // Mock quote volumes put SOL/XRP (derived) and APT/TIA (explicit) below the
  // liquidity threshold on purpose, so the PAIR_EXCLUDED path is exercised in
  // demos. BTC/ETH/BNB and most of the expanded list survive the filter.
  return {
    lastPrice,
    priceChangePercent: mockTrend(pair) * 2.4,
    volume: 24000,
    quoteVolume: MOCK_QUOTE_VOL[pair] ?? lastPrice * 24000,
  };
}
