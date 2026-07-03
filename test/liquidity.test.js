import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { filterPairsByLiquidity, runCycle, __setActivePairs, __setExecutor } from '../src/index.js';

const origPairs = [...config.pairs];

function restore() {
  config.pairs = [...origPairs];
}

test('keeps a pair when the ticker lookup throws (e.g. geo-block 451)', async () => {
  const db = openDb(':memory:');
  config.pairs = ['BTCUSDT', 'ETHUSDT'];
  const getTicker24h = async () => { const e = new Error('HTTP 451'); e.status = 451; throw e; };
  const kept = await filterPairsByLiquidity(db, { getTicker24h });
  assert.deepEqual(kept, ['BTCUSDT', 'ETHUSDT']); // never silently dropped
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'LIQUIDITY_CHECK_UNAVAILABLE'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'PAIR_EXCLUDED'").get().n, 0);
  restore();
  db.close();
});

test('keeps a pair when quoteVolume is zero or NaN', async () => {
  const db = openDb(':memory:');
  config.pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const vols = { BTCUSDT: 0, ETHUSDT: NaN, SOLUSDT: undefined };
  const getTicker24h = async (p) => ({ quoteVolume: vols[p] });
  const kept = await filterPairsByLiquidity(db, { getTicker24h });
  assert.deepEqual(kept, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'LIQUIDITY_CHECK_UNAVAILABLE'").get().n, 3);
  restore();
  db.close();
});

test('still excludes a pair on a confirmed low (finite, positive) volume', async () => {
  const db = openDb(':memory:');
  config.pairs = ['BTCUSDT', 'JUNKUSDT'];
  const getTicker24h = async (p) => ({ quoteVolume: p === 'BTCUSDT' ? 5e9 : 1000 });
  const kept = await filterPairsByLiquidity(db, { getTicker24h });
  assert.deepEqual(kept, ['BTCUSDT']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'PAIR_EXCLUDED'").get().n, 1);
  restore();
  db.close();
});

test('empty result falls back to the full configured pair list and logs the bypass', async () => {
  const db = openDb(':memory:');
  config.pairs = ['BTCUSDT', 'ETHUSDT'];
  // every pair confirmed below threshold -> filter would empty the universe
  const getTicker24h = async () => ({ quoteVolume: 1 });
  const kept = await filterPairsByLiquidity(db, { getTicker24h });
  assert.deepEqual(kept, ['BTCUSDT', 'ETHUSDT']); // bypassed back to configured list
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'LIQUIDITY_FILTER_BYPASSED'").get().n, 1);
  restore();
  db.close();
});

test('a cycle with zero active pairs logs NO_ACTIVE_PAIRS and runs no AI', async () => {
  const db = openDb(':memory:');
  const origDbPath = config.dbPath;
  config.dbPath = ':memory:'; // skip the on-disk backup side effect
  __setActivePairs([]);
  __setExecutor(null); // never reached on the empty-universe early return
  await runCycle(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'NO_ACTIVE_PAIRS'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM regime_calls').get().n, 0);
  config.dbPath = origDbPath;
  __setActivePairs([...origPairs]);
  restore();
  db.close();
});

test('a persistent empty universe logs NO_ACTIVE_PAIRS every cycle but alerts only once per day', async () => {
  const db = openDb(':memory:');
  const origDbPath = config.dbPath;
  config.dbPath = ':memory:'; // skip the on-disk backup side effect
  __setActivePairs([]);
  __setExecutor(null);

  await runCycle(db);
  await runCycle(db);
  await runCycle(db);

  // logged every cycle — useful for diagnosis
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'NO_ACTIVE_PAIRS'").get().n, 3);
  // but the alert-throttle marker only fires once per UTC day
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'NO_ACTIVE_PAIRS_ALERTED'").get().n, 1);

  config.dbPath = origDbPath;
  __setActivePairs([...origPairs]);
  restore();
  db.close();
});
