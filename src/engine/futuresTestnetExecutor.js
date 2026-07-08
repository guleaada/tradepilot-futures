// Binance USD-M FUTURES TESTNET executor. Real order placement against a real
// futures order book, TESTNET FUNDS ONLY.
//
// Safety properties, in order of importance:
//   1. The base URL is a frozen constant — not in config, not env-overridable.
//      There is no way to point this executor at mainnet via configuration.
//   2. Startup asserts the URL contains 'testnet' and refuses to run otherwise.
//   3. Keys come from BINANCE_FUTURES_TESTNET_API_KEY/SECRET, created at
//      testnet.binancefuture.com — mainnet rejects them.
//   4. There is NO mainnet/live futures executor anywhere in this codebase.
//      Do not implement one. Do not stub one.
//   5. Leverage is set per symbol at init from config (already clamped to
//      MAX_ALLOWED_LEVERAGE), margin type is forced to ISOLATED, and position
//      mode is forced to one-way.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb, logEvent, nowIso } from '../db.js';
import { getCash, getOpenPositions, setCash } from './portfolio.js';

// Frozen on purpose. Do not make this configurable.
export const FUTURES_TESTNET_BASE = 'https://testnet.binancefuture.com';

export function assertFuturesTestnetBase(url = FUTURES_TESTNET_BASE) {
  if (typeof url !== 'string' || !url.includes('testnet')) {
    throw new Error(`FuturesTestnetExecutor refuses non-testnet base URL: ${url}`);
  }
  return url;
}

// Binance HMAC-SHA256 request signing (signature over the raw query string).
export function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Floor a quantity to the symbol's LOT_SIZE stepSize. Never rounds up.
export function roundToStep(qty, stepSize) {
  const step = Number(stepSize);
  if (!(step > 0)) return qty;
  const decimals = (String(stepSize).split('.')[1] || '').replace(/0+$/, '').length;
  const floored = Math.floor(qty / step + 1e-9) * step;
  return Number(floored.toFixed(decimals));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class FuturesTestnetExecutor {
  constructor({
    apiKey = config.binanceFuturesTestnetApiKey,
    apiSecret = config.binanceFuturesTestnetApiSecret,
    leverage = config.leverage,
    fetchImpl = fetch,
    db = null,
  } = {}) {
    this.base = assertFuturesTestnetBase(FUTURES_TESTNET_BASE);
    if (!apiKey || !apiSecret) {
      throw new Error('requires BINANCE_FUTURES_TESTNET_API_KEY and BINANCE_FUTURES_TESTNET_API_SECRET (create them at testnet.binancefuture.com — they do not work on mainnet)');
    }
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.leverage = leverage;
    this.fetchImpl = fetchImpl;
    this._db = db;
    this.timeOffset = 0;
    this.filters = {}; // pair -> { stepSize, minQty, minNotional }
    this.recvWindow = 5000;
  }

  get db() {
    return this._db ?? getDb();
  }

  // Sync server time, load exchange filters, force one-way position mode,
  // then set leverage + ISOLATED margin per symbol. Call once per run.
  async init(pairs = config.pairs) {
    await this.syncTime();
    const info = await this.#public('/fapi/v1/exchangeInfo');
    const wanted = new Set(pairs);
    for (const sym of info.symbols || []) {
      if (!wanted.has(sym.symbol)) continue;
      const lot = (sym.filters || []).find((f) => f.filterType === 'LOT_SIZE') || {};
      const notional = (sym.filters || []).find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
      this.filters[sym.symbol] = {
        stepSize: lot.stepSize ?? '0.001',
        minQty: Number(lot.minQty ?? 0),
        minNotional: Number(notional.notional ?? notional.minNotional ?? 0),
      };
    }

    // One-way position mode: opening a short is a plain SELL, no positionSide
    // bookkeeping. -4059 = "No need to change position side" — already one-way.
    try {
      await this.#signed('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' });
    } catch (err) {
      if (err.binanceCode !== -4059) throw err;
    }

    for (const pair of pairs) {
      if (!this.filters[pair]) continue;
      await this.#signed('POST', '/fapi/v1/leverage', { symbol: pair, leverage: String(this.leverage) });
      // ISOLATED only — never cross-margin. -4046 = "No need to change margin type".
      try {
        await this.#signed('POST', '/fapi/v1/marginType', { symbol: pair, marginType: 'ISOLATED' });
      } catch (err) {
        if (err.binanceCode !== -4046) throw err;
      }
      logEvent('LEVERAGE_SET', { pair, leverage: this.leverage, marginType: 'ISOLATED' }, this.db);
    }
  }

  async syncTime() {
    const data = await this.#public('/fapi/v1/time');
    this.timeOffset = Number(data.serverTime) - Date.now();
  }

  // Reconcile exchange state against local state at cycle start. Two duties:
  //
  //   1. ORPHAN POSITIONS: an exchange position on a managed symbol with no
  //      local open trade means an entry filled but its bookkeeping crashed
  //      (it happened: NaN fills on NEARUSDT left unmanaged longs with no
  //      stop). Orphans are FLATTENED with a reduce-only market order — the
  //      trades table is the source of truth for what we hold.
  //   2. WALLET DRIFT: beyond tolerance, adopt the exchange wallet as local
  //      cash (the exchange is the source of truth for money), log
  //      STATE_RESYNCED loudly, and still block entries for this cycle.
  //
  // Returns true when nothing needed fixing. Never throws.
  async reconcile(db = this.db) {
    try {
      const account = await this.#signed('GET', '/fapi/v2/account', {});

      const localOpen = new Set(getOpenPositions(db).map((p) => p.pair));
      let flattened = 0;
      for (const pos of account.positions || []) {
        const amt = Number(pos.positionAmt);
        if (!amt || localOpen.has(pos.symbol) || !this.filters[pos.symbol]) continue;
        try {
          const order = await this.#signed('POST', '/fapi/v1/order', {
            symbol: pos.symbol,
            side: amt > 0 ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: String(Math.abs(amt)),
            reduceOnly: 'true',
            newOrderRespType: 'RESULT',
          });
          flattened += 1;
          logEvent('ORPHAN_POSITION_CLOSED', { symbol: pos.symbol, positionAmt: amt, orderId: order.orderId ?? null }, db);
        } catch (err) {
          logEvent('ORPHAN_POSITION_CLOSE_FAILED', { symbol: pos.symbol, positionAmt: amt, error: String(err).slice(0, 200) }, db);
        }
      }

      const wallet = Number(account.totalWalletBalance ?? NaN);
      const local = getCash(db);
      const tolerance = Math.max(1, local * 0.005);
      if (!Number.isFinite(wallet)) {
        logEvent('STATE_MISMATCH', { localCash: local, exchangeWallet: wallet }, db);
        return false;
      }
      if (Math.abs(wallet - local) > tolerance) {
        setCash(wallet, db);
        logEvent('STATE_RESYNCED', { localCash: local, exchangeWallet: wallet }, db);
        return false;
      }
      return flattened === 0;
    } catch (err) {
      logEvent('STATE_MISMATCH', { error: String(err).slice(0, 300) }, db);
      return false;
    }
  }

  // Executor interface. One-way mode: opening a long is BUY, opening a short
  // is SELL; closing is the opposite side with reduceOnly so a close can
  // never accidentally flip the position.
  async openPosition(pair, direction, qty, marketPrice) {
    return this.#marketOrder(pair, direction === 'short' ? 'SELL' : 'BUY', qty, marketPrice, { direction });
  }

  async closePosition(pair, direction, qty, marketPrice) {
    return this.#marketOrder(pair, direction === 'short' ? 'BUY' : 'SELL', qty, marketPrice, { direction, reduceOnly: true });
  }

  async #marketOrder(pair, side, qty, signalPrice, { direction, reduceOnly = false } = {}) {
    const f = this.filters[pair];
    if (!f) throw new Error(`no exchange filters loaded for ${pair} — call init() first`);

    const quantity = roundToStep(qty, f.stepSize);
    // Below-minimum orders are skipped, never rounded up.
    if (quantity <= 0 || quantity < f.minQty || quantity * signalPrice < f.minNotional) {
      logEvent('ORDER_BELOW_MIN_NOTIONAL', { pair, side, direction, qty, rounded: quantity, minQty: f.minQty, minNotional: f.minNotional, signalPrice }, this.db);
      return { pair, skipped: 'below_min_notional' };
    }

    const params = {
      symbol: pair,
      side,
      type: 'MARKET',
      quantity: String(quantity),
      newOrderRespType: 'RESULT',
      ...(reduceOnly ? { reduceOnly: 'true' } : {}),
    };
    let data;
    try {
      data = await this.#signed('POST', '/fapi/v1/order', params);
    } catch (err) {
      this.#recordOrder({ pair, side, direction, requestedQty: quantity, executedQty: null, signalPrice, fillPrice: null, status: 'ERROR', orderId: null, raw: { request: params, error: String(err).slice(0, 500) } });
      if (err.binanceCode === -2019) {
        logEvent('ORDER_REJECTED_MARGIN_INSUFFICIENT', { pair, side, direction, quantity }, this.db);
        return { pair, skipped: 'margin_insufficient' };
      }
      if (err.binanceCode === -1013 || err.binanceCode === -4164) {
        logEvent('ORDER_FILTER_FAILURE', { pair, side, direction, quantity, error: String(err).slice(0, 200) }, this.db);
        return { pair, skipped: 'filter_failure' };
      }
      throw err;
    }

    // Actual fill data from the response — not our signal price. CAUTION: the
    // futures TESTNET omits avgPrice/cumQuote from RESULT responses (mainnet
    // includes them; discovered live via NaN fills on NEARUSDT). Derive the
    // fill price defensively — quote, then avgPrice, then the signal price —
    // and never let a non-finite number into the books; the raw response is
    // preserved in the orders table either way.
    const executedQty = Number(data.executedQty);
    const quote = Number(data.cumQuote);
    let fillPrice = Number(data.avgPrice);
    if (!(fillPrice > 0)) {
      fillPrice = quote > 0 && executedQty > 0 ? quote / executedQty : signalPrice;
    }
    // The order response does not itemize commission; charge the taker rate
    // on the filled notional (USD-M taker is 0.04%).
    const fee = (quote > 0 ? quote : executedQty * fillPrice) * config.takerFee;

    this.#recordOrder({ pair, side, direction, requestedQty: quantity, executedQty, signalPrice, fillPrice, status: data.status, orderId: data.orderId, raw: { request: params, response: data } });

    if (data.status !== 'FILLED' || !(executedQty > 0)) {
      logEvent('ORDER_NOT_FILLED', { pair, side, direction, quantity, status: data.status }, this.db);
      return { pair, skipped: 'not_filled' };
    }

    return { pair, fillPrice, fee, executedQty, orderId: data.orderId, notional: quote };
  }

  #recordOrder({ pair, side, direction, requestedQty, executedQty, signalPrice, fillPrice, status, orderId, raw }) {
    try {
      this.db
        .prepare(
          `INSERT INTO orders (ts, pair, side, direction, type, requested_qty, executed_qty, signal_price, fill_price, status, order_id, raw_json)
           VALUES (?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(nowIso(), pair, side, direction ?? null, requestedQty, executedQty, signalPrice, fillPrice, status, orderId === null ? null : String(orderId), JSON.stringify(raw));
    } catch { /* audit logging must never break execution */ }
  }

  async #public(path) {
    const res = await this.fetchImpl(`${this.base}${path}`);
    if (!res.ok) throw new Error(`Binance futures testnet HTTP ${res.status} for ${path}`);
    return res.json();
  }

  async #signed(method, path, params, { maxAttempts = 4 } = {}) {
    let resynced = false;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const qs = new URLSearchParams({
        ...params,
        recvWindow: String(this.recvWindow),
        timestamp: String(Date.now() + this.timeOffset),
      }).toString();
      const url = `${this.base}${path}?${qs}&signature=${sign(qs, this.apiSecret)}`;

      let res;
      try {
        res = await this.fetchImpl(url, { method, headers: { 'X-MBX-APIKEY': this.apiKey } });
      } catch (err) {
        lastErr = err;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      const data = await res.json().catch(() => ({}));

      // Timestamp drift: resync once and retry.
      if (data && data.code === -1021 && !resynced) {
        resynced = true;
        await this.syncTime();
        continue;
      }
      if (!res.ok || (data && typeof data.code === 'number' && data.code < 0)) {
        const err = new Error(`Binance ${data.code ?? res.status}: ${data.msg ?? 'request failed'}`);
        err.binanceCode = data.code;
        throw err;
      }
      return data;
    }
    throw lastErr ?? new Error(`Binance futures testnet retries exhausted for ${path}`);
  }
}

// --- deterministic mock transport (tests + TRADEPILOT_MOCK demo cycles) ---
// Simulates the handful of futures-testnet endpoints the executor touches,
// including the leverage / margin-type / position-mode setup calls. Fill
// prices sit slightly away from the synthetic signal so fill-vs-signal
// reporting has something to show. Works for LONG and SHORT scenarios: the
// order handler fills SELL as readily as BUY.
export function createMockFuturesFetch({
  // Fill prices sit near each pair's mock last close (uptrend ~= base*1.12,
  // downtrend ~= base*0.88) so fill-vs-signal slippage stays realistic. Every
  // liquidity-filter-surviving mock pair needs an entry here, or an order for
  // it throws "no exchange filters loaded".
  prices = {
    BTCUSDT: 66900, ETHUSDT: 2670, BNBUSDT: 522,
    AVAXUSDT: 33.6, LINKUSDT: 13.2, ARBUSDT: 0.9, INJUSDT: 22,
    SUIUSDT: 3.36, DOGEUSDT: 0.106, NEARUSDT: 5.6, LTCUSDT: 88,
    XAUUSDT: 2912, XAGUSDT: 26.4,
  },
  walletBalance = 1000,
  failFirstOrderWith = null, // e.g. { code: -1021, msg: 'Timestamp outside recvWindow' }
  marginTypeAlreadySet = false, // respond -4046 to POST /fapi/v1/marginType
  // Reproduce the REAL testnet's RESULT shape, which omits avgPrice/cumQuote
  // (only price:"0.0000" + cumQty). The default keeps the documented mainnet
  // shape; tests flip this to lock the NaN-fill regression.
  omitAvgPrice = false,
  positions = [], // /fapi/v2/account positions, e.g. [{ symbol, positionAmt }]
} = {}) {
  let nextOrderId = 5000;
  let pendingFailure = failFirstOrderWith;
  const counters = { time: 0, exchangeInfo: 0, account: 0, order: 0, leverage: 0, marginType: 0, positionSide: 0 };
  const leverageSet = {}; // symbol -> leverage, so tests can assert init behavior

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  const mockFetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.pathname === '/fapi/v1/time') {
      counters.time += 1;
      return json({ serverTime: Date.now() });
    }
    if (u.pathname === '/fapi/v1/exchangeInfo') {
      counters.exchangeInfo += 1;
      return json({
        symbols: Object.keys(prices).map((symbol) => ({
          symbol,
          filters: [
            { filterType: 'LOT_SIZE', stepSize: symbol === 'BTCUSDT' ? '0.001' : '0.01', minQty: symbol === 'BTCUSDT' ? '0.001' : '0.01' },
            { filterType: 'MIN_NOTIONAL', notional: '20' },
          ],
        })),
      });
    }
    if (u.pathname === '/fapi/v1/positionSide/dual' && method === 'POST') {
      counters.positionSide += 1;
      return json({ code: 200, msg: 'success' });
    }
    if (u.pathname === '/fapi/v1/leverage' && method === 'POST') {
      counters.leverage += 1;
      const symbol = u.searchParams.get('symbol');
      leverageSet[symbol] = Number(u.searchParams.get('leverage'));
      return json({ symbol, leverage: leverageSet[symbol], maxNotionalValue: '1000000' });
    }
    if (u.pathname === '/fapi/v1/marginType' && method === 'POST') {
      counters.marginType += 1;
      if (marginTypeAlreadySet) return json({ code: -4046, msg: 'No need to change margin type.' }, 400);
      return json({ code: 200, msg: 'success' });
    }
    if (u.pathname === '/fapi/v2/account') {
      counters.account += 1;
      return json({
        totalWalletBalance: String(walletBalance),
        availableBalance: String(walletBalance),
        positions: positions.map((p) => ({ symbol: p.symbol, positionAmt: String(p.positionAmt), entryPrice: String(p.entryPrice ?? 0) })),
      });
    }
    if (u.pathname === '/fapi/v1/order' && method === 'POST') {
      counters.order += 1;
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = null;
        return json(failure, 400);
      }
      const symbol = u.searchParams.get('symbol');
      const side = u.searchParams.get('side');
      const qty = Number(u.searchParams.get('quantity'));
      const price = prices[symbol];
      const base = {
        symbol,
        orderId: nextOrderId++,
        status: 'FILLED',
        side,
        executedQty: String(qty),
        reduceOnly: u.searchParams.get('reduceOnly') === 'true',
      };
      return json(omitAvgPrice
        ? { ...base, price: '0.0000', cumQty: String(qty) } // real-testnet shape
        : { ...base, avgPrice: String(price), cumQuote: String(qty * price) });
    }
    return json({ code: -1100, msg: `mock: unhandled ${method} ${u.pathname}` }, 400);
  };

  mockFetch.counters = counters;
  mockFetch.leverageSet = leverageSet;
  return mockFetch;
}
