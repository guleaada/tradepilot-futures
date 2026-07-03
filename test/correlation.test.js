import test from 'node:test';
import assert from 'node:assert/strict';
import { correlation, percentileRank, returns } from '../src/indicators.js';

test('correlation: perfectly correlated, inverted, and degenerate inputs', () => {
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
  assert.equal(correlation([1, 2], [1, 2]), null); // too short
  assert.equal(correlation([1, 1, 1, 1], [1, 2, 3, 4]), null); // zero variance
});

test('correlation of returns flags co-moving price series', () => {
  // two pairs moving in lockstep (scaled copies) -> return correlation 1
  const a = [100, 102, 101, 104, 103, 106, 108];
  const b = a.map((v) => v * 30);
  const corr = correlation(returns(a), returns(b));
  assert.ok(Math.abs(corr - 1) < 1e-12);
  // a pair moving independently -> well below a 0.85 blocking threshold
  const c = [100, 99, 103, 100, 105, 101, 104];
  const corrAC = correlation(returns(a), returns(c));
  assert.ok(corrAC < 0.85, `expected < 0.85, got ${corrAC}`);
});

test('percentileRank basics', () => {
  assert.equal(percentileRank([1, 2, 3, 4, 5], 5), 1);
  assert.equal(percentileRank([1, 2, 3, 4, 5], 1), 0.2);
  assert.equal(percentileRank([1, 2, 3, 4], 2.5), 0.5);
  assert.equal(percentileRank([], 1), null);
});
