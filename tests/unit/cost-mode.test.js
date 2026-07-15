import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCostMode, COST_MODES, reconcilePricing, validateCostMode } from '../../src/cost-mode.js';

// Minimal session shape with only the fields applyCostMode/reconcilePricing read.
function mkSession(overrides = {}) {
  return {
    cost: { totalCost: 10, overlayTotalCost: 8, costModeIncomplete: false, ...overrides.cost },
    modelBreakdown: overrides.modelBreakdown || {
      opus: { tokens: 1000, cost: 6, overlayCost: 5 },
      sonnet: { tokens: 500, cost: 4, overlayCost: 3 },
    },
    dailyUsage: overrides.dailyUsage || {
      '2026-07-01': { cost: 10, overlayTotalCost: 8, costModeIncomplete: false, byModel: {} },
    },
  };
}

test('validateCostMode accepts the three known modes and rejects anything else', () => {
  for (const mode of COST_MODES) assert.equal(validateCostMode(mode), null);
  assert.match(validateCostMode('bogus'), /Unknown --cost-mode "bogus"/);
});

test('applyCostMode: calculate is a no-op passthrough', () => {
  const s = mkSession();
  applyCostMode(s, 'calculate');
  assert.equal(s.cost.totalCost, 10);
  assert.equal(s.dailyUsage['2026-07-01'].cost, 10);
});

test('applyCostMode: auto blends overlay-where-available with calculated fallback per model', () => {
  // opus has overlay data (5); sonnet has none (overlayCost null) -> falls back to its calculated cost (4).
  const s = mkSession({
    modelBreakdown: { opus: { tokens: 1000, cost: 6, overlayCost: 5 }, sonnet: { tokens: 500, cost: 4, overlayCost: null } },
    cost: { totalCost: 10, overlayTotalCost: 5, costModeIncomplete: true },
  });
  applyCostMode(s, 'auto');
  assert.equal(s.cost.totalCost, 9);
});

test('applyCostMode: display uses the pure overlay total when every model has overlay data', () => {
  const s = mkSession(); // both models have overlayCost; costModeIncomplete: false; overlayTotalCost: 8
  applyCostMode(s, 'display');
  assert.equal(s.cost.totalCost, 8);
});

test('applyCostMode: display leaves totalCost at the calculated value when overlay data is incomplete', () => {
  const s = mkSession({ cost: { totalCost: 10, overlayTotalCost: 5, costModeIncomplete: true } });
  applyCostMode(s, 'display');
  assert.equal(s.cost.totalCost, 10, 'incomplete overlay coverage must not silently produce a partial total');
  assert.equal(s.cost.costModeIncomplete, true, 'the flag survives for callers (report.js) to surface transparently');
});

test('applyCostMode adjusts each dailyUsage entry independently of the session total', () => {
  const s = mkSession({
    dailyUsage: {
      '2026-07-01': { cost: 6, overlayTotalCost: 5, costModeIncomplete: false, byModel: {} },
      '2026-07-02': { cost: 4, overlayTotalCost: 2, costModeIncomplete: true, byModel: {} },
    },
  });
  applyCostMode(s, 'display');
  assert.equal(s.dailyUsage['2026-07-01'].cost, 5, 'complete day switches to its own overlay total');
  assert.equal(s.dailyUsage['2026-07-02'].cost, 4, 'incomplete day keeps its calculated total');
});

test('applyCostMode is a safe no-op on a session with no cost bucket', () => {
  assert.doesNotThrow(() => applyCostMode({}, 'auto'));
  assert.doesNotThrow(() => applyCostMode(null, 'display'));
});

test('reconcilePricing aggregates hardcoded vs overlay totals per model across sessions, flags >5% divergence, skips models with no overlay rate', () => {
  const sessions = [
    { modelBreakdown: { opus: { cost: 11, overlayCost: 10 }, sonnet: { cost: 10.2, overlayCost: 10 }, haiku: { cost: 3, overlayCost: null } } },
    { modelBreakdown: { opus: { cost: 11, overlayCost: 10 } } }, // second session, same model — totals accumulate
  ];
  const rows = reconcilePricing(sessions);
  const byModel = Object.fromEntries(rows.map(r => [r.model, r]));

  assert.equal(byModel.opus.calculatedTotal, 22);
  assert.equal(byModel.opus.overlayTotal, 20);
  assert.ok(Math.abs(byModel.opus.pctDivergence - 10) < 1e-9);
  assert.equal(byModel.opus.flagged, true, '10% divergence exceeds the 5% flag threshold');

  assert.ok(Math.abs(byModel.sonnet.pctDivergence - 2) < 1e-9);
  assert.equal(byModel.sonnet.flagged, false, '2% divergence is under the flag threshold');

  assert.equal(byModel.haiku, undefined, 'models with no overlay rate have nothing to reconcile against, so are skipped');
  assert.equal(rows[0].model, 'opus', 'sorted by |divergence| descending — worst offenders first');
});

test('reconcilePricing returns an empty list when no session has overlay data', () => {
  const sessions = [{ modelBreakdown: { opus: { cost: 10, overlayCost: null } } }];
  assert.deepEqual(reconcilePricing(sessions), []);
});
