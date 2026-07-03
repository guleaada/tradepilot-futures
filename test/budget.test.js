import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  addSpend,
  costFromUsage,
  estimateCallCost,
  getDailySpend,
  warnIfBudgetMisconfigured,
  wouldExceedBudget,
} from '../src/ai/budget.js';

test('spend accumulates per day and gates the cap', () => {
  const db = openDb(':memory:');
  const date = '2026-07-03';
  assert.equal(getDailySpend(db, date), 0);

  addSpend(0.2, db, date);
  addSpend(0.25, db, date);
  assert.ok(Math.abs(getDailySpend(db, date) - 0.45) < 1e-9);

  // next call estimated at $0.06 would push past the $0.50 cap -> skip
  assert.equal(wouldExceedBudget(0.06, 0.5, db, date), true);
  // a cheaper call still fits
  assert.equal(wouldExceedBudget(0.04, 0.5, db, date), false);
  // a new day starts fresh
  assert.equal(getDailySpend(db, '2026-07-04'), 0);
  assert.equal(wouldExceedBudget(0.06, 0.5, db, '2026-07-04'), false);
  db.close();
});

test('spend is isolated per provider', () => {
  const db = openDb(':memory:');
  const date = '2026-07-03';
  addSpend(0.3, db, date, 'anthropic');
  addSpend(0.1, db, date, 'someday-another-provider');
  assert.ok(Math.abs(getDailySpend(db, date, 'anthropic') - 0.3) < 1e-9);
  assert.ok(Math.abs(getDailySpend(db, date, 'someday-another-provider') - 0.1) < 1e-9);
  db.close();
});

test('cost math: usage tokens x pricing constants', () => {
  const pricing = { inputPerMTok: 3.0, outputPerMTok: 15.0 };
  // 2000 in + 400 out = 2000*3/1M + 400*15/1M = 0.006 + 0.006 = 0.012
  assert.ok(Math.abs(costFromUsage(2000, 400, pricing) - 0.012) < 1e-12);
  assert.equal(costFromUsage(0, 0, pricing), 0);
  // the default estimate must comfortably fit the default $0.50/day cap
  assert.ok(estimateCallCost() < 0.5);
});

test('an estimate above the whole daily cap logs BUDGET_MISCONFIGURED once per day', () => {
  const db = openDb(':memory:');
  const date = '2026-07-03';
  assert.equal(warnIfBudgetMisconfigured(0.05, 0.5, 'anthropic', db, date), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'BUDGET_MISCONFIGURED'").get().n, 0);

  assert.equal(warnIfBudgetMisconfigured(0.9, 0.5, 'anthropic', db, date), true);
  assert.equal(warnIfBudgetMisconfigured(0.9, 0.5, 'anthropic', db, date), true); // still misconfigured...
  // ...but only one event row for the day
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'BUDGET_MISCONFIGURED'").get().n, 1);
  db.close();
});
