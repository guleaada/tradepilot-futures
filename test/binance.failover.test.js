// Proves the real root-cause fix: when the primary spot host returns HTTP 451
// (Binance geo-block on cloud/CI IPs), the client fails over to the next host
// (data-api.binance.vision) instead of throwing and zeroing out the cycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getTicker24h } from '../src/data/binance.js';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

test('spot fetch fails over from a 451 primary host to the mirror', async () => {
  const origHosts = [...config.binanceHosts];
  const origFetch = globalThis.fetch;
  const seen = [];
  config.binanceHosts = ['https://primary.test', 'https://mirror.test'];
  globalThis.fetch = async (url) => {
    seen.push(url);
    if (url.startsWith('https://primary.test')) return jsonResponse({ msg: 'blocked' }, 451);
    return jsonResponse({ lastPrice: '66000', priceChangePercent: '1.2', volume: '1000', quoteVolume: '50000000' });
  };
  try {
    const t = await getTicker24h('BTCUSDT');
    assert.equal(t.quoteVolume, 50_000_000);
    assert.equal(t.lastPrice, 66000);
    assert.ok(seen.some((u) => u.startsWith('https://primary.test')), 'primary attempted');
    assert.ok(seen.some((u) => u.startsWith('https://mirror.test')), 'mirror used on failover');
  } finally {
    config.binanceHosts = origHosts;
    globalThis.fetch = origFetch;
  }
});

test('a 451 on every host surfaces as an error (caller catches and keeps the pair)', async () => {
  const origHosts = [...config.binanceHosts];
  const origFetch = globalThis.fetch;
  config.binanceHosts = ['https://a.test', 'https://b.test'];
  globalThis.fetch = async () => jsonResponse({ msg: 'blocked' }, 451);
  try {
    await assert.rejects(() => getTicker24h('ETHUSDT'), /HTTP 451/);
  } finally {
    config.binanceHosts = origHosts;
    globalThis.fetch = origFetch;
  }
});
