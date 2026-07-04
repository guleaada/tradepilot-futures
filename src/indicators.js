// Hand-rolled indicators — no TA library. All functions return arrays aligned
// with the input; positions before the seed period are null.

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// EMA seeded with the SMA of the first `period` values.
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI.
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Wilder's ATR over candles: [{high, low, close}, ...]
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trs = new Array(candles.length).fill(0);
  trs[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += trs[i];
  let prev = seed / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder's ADX over candles: [{high, low, close}, ...]. Trend STRENGTH
// (direction-blind), 0-100. Chosen over an EMA-slope proxy because it is the
// standard, has textbook-verifiable math like the other indicators here, and
// needs no extra tuning knobs (the slope proxy would need its own
// normalization window + percentile thresholds).
//
// Textbook definition: +DM_i = max(high_i - high_{i-1}, 0) when it exceeds
// the down-move (else 0), mirrored for -DM; smooth TR/+DM/-DM with Wilder's
// running sums; DI = 100 * smDM / smTR; DX = 100 * |+DI - -DI| / (+DI + -DI);
// ADX = Wilder-smoothed DX (seeded with the mean of the first `period` DXs).
// First value lands at index 2*period - 1; earlier positions are null.
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= 2 * period) return out;

  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const pc = candles[i - 1].close;
    trs[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }

  const dxFrom = (smTR, smPlus, smMinus) => {
    if (!(smTR > 0)) return 0;
    const pDI = (smPlus / smTR) * 100;
    const mDI = (smMinus / smTR) * 100;
    const sum = pDI + mDI;
    return sum > 0 ? (Math.abs(pDI - mDI) / sum) * 100 : 0;
  };

  // Wilder smoothing: seed with plain sums over bars 1..period, then
  // sm' = sm - sm/period + current.
  let smTR = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTR += trs[i];
    smPlus += plusDM[i];
    smMinus += minusDM[i];
  }
  const dx = new Array(n).fill(null);
  dx[period] = dxFrom(smTR, smPlus, smMinus);
  for (let i = period + 1; i < n; i++) {
    smTR = smTR - smTR / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    dx[i] = dxFrom(smTR, smPlus, smMinus);
  }

  // ADX seed = mean of the first `period` DX values (indices period..2p-1).
  let seed = 0;
  for (let i = period; i < 2 * period; i++) seed += dx[i];
  let prev = seed / period;
  out[2 * period - 1] = prev;
  for (let i = 2 * period; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Percentage returns of a price series: r_i = p_i / p_{i-1} - 1.
export function returns(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

export function stdev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Pearson correlation between two equal-length series. Returns null when the
// inputs are too short or have zero variance.
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const meanA = xa.reduce((s, v) => s + v, 0) / n;
  const meanB = xb.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i] - meanA;
    const db = xb[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

// Fraction of window values <= the current (last) value, in [0, 1].
export function percentileRank(window, current) {
  const vals = window.filter((v) => Number.isFinite(v));
  if (!vals.length || !Number.isFinite(current)) return null;
  return vals.filter((v) => v <= current).length / vals.length;
}

// Simple volatility: stdev of percentage returns over the trailing window.
export function volatility(values, period = 20) {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(slice[i] / slice[i - 1] - 1);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}
