import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPeriodTable, periodTableJson, renderPeriodTableText, shortModel } from '../../src/tables.js';

// Minimal correlated-session stub — only the fields tables.js reads.
function mkSession(overrides = {}) {
  return {
    sessionId: 's1',
    startTime: '2026-04-20T10:00:00.000Z',
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
    cost: { totalCost: 3 },
    modelBreakdown: { 'claude-sonnet-4-6': { tokens: 1800, cost: 3 } },
    commits: [],
    dailyUsage: {
      '2026-04-20': {
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100,
        cost: 3,
        byModel: { 'claude-sonnet-4-6': { tokens: 1800, cost: 3 } },
      },
    },
    ...overrides,
  };
}

test('daily: one row per usage day with all token classes and cost', () => {
  const { rows, totals } = buildPeriodTable([mkSession()], { period: 'daily' });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.period, '2026-04-20');
  assert.equal(r.inputTokens, 1000);
  assert.equal(r.outputTokens, 500);
  assert.equal(r.cacheReadTokens, 200);
  assert.equal(r.cacheCreationTokens, 100);
  assert.equal(r.totalTokens, 1800);
  assert.equal(r.cost, 3);
  assert.equal(r.sessions, 1);
  assert.deepEqual(r.models, ['claude-sonnet-4-6']);
  assert.equal(totals.totalTokens, 1800);
  assert.equal(totals.cost, 3);
});

test('daily: a session spanning days lands on each actual usage day', () => {
  const s = mkSession({
    dailyUsage: {
      '2026-04-20': { inputTokens: 600, outputTokens: 300, cacheReadTokens: 100, cacheCreationTokens: 50, cost: 2, byModel: {} },
      '2026-04-21': { inputTokens: 400, outputTokens: 200, cacheReadTokens: 100, cacheCreationTokens: 50, cost: 1, byModel: {} },
    },
  });
  const { rows } = buildPeriodTable([s], { period: 'daily' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cost, 2);
  assert.equal(rows[1].cost, 1);
  // Session counted once, on its FIRST activity day.
  assert.equal(rows[0].sessions, 1);
  assert.equal(rows[1].sessions, 0);
});

test('daily: sessions without dailyUsage fall back to their clamped start day', () => {
  const s = mkSession({ dailyUsage: {}, startTime: '2026-04-10T10:00:00.000Z' });
  const cutoffMs = Date.parse('2026-04-15T00:00:00');
  const { rows } = buildPeriodTable([s], { period: 'daily', cutoffMs });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, '2026-04-15'); // clamped, not the pre-window start
  assert.equal(rows[0].inputTokens, 1000);    // whole-session totals
  assert.equal(rows[0].cost, 3);
});

test('weekly: buckets by week start, monday and sunday boundaries', () => {
  // 2026-04-20 is a Monday.
  const s = mkSession({
    dailyUsage: {
      '2026-04-19': { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1, byModel: {} }, // Sunday
      '2026-04-20': { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 2, byModel: {} }, // Monday
    },
  });
  const monday = buildPeriodTable([s], { period: 'weekly', startOfWeek: 'monday' });
  assert.deepEqual(monday.rows.map(r => r.period), ['2026-04-13', '2026-04-20']);
  const sunday = buildPeriodTable([s], { period: 'weekly', startOfWeek: 'sunday' });
  assert.deepEqual(sunday.rows.map(r => r.period), ['2026-04-19']);
  assert.equal(sunday.rows[0].cost, 3);
});

test('monthly: buckets by YYYY-MM and sums across sessions', () => {
  const a = mkSession();
  const b = mkSession({
    sessionId: 's2',
    dailyUsage: {
      '2026-05-02': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.5, byModel: { 'gpt-5.3-codex': { tokens: 15, cost: 0.5 } } },
    },
  });
  const { rows, totals } = buildPeriodTable([a, b], { period: 'monthly' });
  assert.deepEqual(rows.map(r => r.period), ['2026-04', '2026-05']);
  assert.equal(totals.cost, 3.5);
  assert.deepEqual(Object.keys(totals.byModel).sort(), ['claude-sonnet-4-6', 'gpt-5.3-codex']);
});

test('commits bucket by commit timestamp and drive $/commit', () => {
  const s = mkSession({
    commits: [
      { hash: 'a', timestamp: '2026-04-20T12:00:00.000Z' },
      { hash: 'b', timestamp: '2026-04-20T13:00:00.000Z' },
    ],
  });
  const { rows, totals } = buildPeriodTable([s], { period: 'daily' });
  assert.equal(rows[0].commits, 2);
  assert.equal(rows[0].costPerCommit, 1.5);
  assert.equal(totals.commits, 2);
  assert.equal(totals.costPerCommit, 1.5);
});

test('models are ranked by cost and byModel merges across sessions', () => {
  const a = mkSession();
  const b = mkSession({
    sessionId: 's2',
    dailyUsage: {
      '2026-04-20': {
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 9,
        byModel: { 'claude-opus-4-8': { tokens: 150, cost: 9 } },
      },
    },
  });
  const { rows } = buildPeriodTable([a, b], { period: 'daily' });
  assert.deepEqual(rows[0].models, ['claude-opus-4-8', 'claude-sonnet-4-6']); // opus costs more
  assert.equal(rows[0].byModel['claude-sonnet-4-6'].cost, 3);
});

test('shortModel strips claude- prefix and date suffix, keeps markers', () => {
  assert.equal(shortModel('claude-opus-4-8-20250601'), 'opus-4-8');
  assert.equal(shortModel('claude-sonnet-4-6'), 'sonnet-4-6');
  assert.equal(shortModel('gpt-5.3-codex'), 'gpt-5.3-codex');
  assert.equal(shortModel('claude-opus-4-8-20250601[fast]'), 'opus-4-8[fast]');
});

test('renderPeriodTableText: aligned table with totals rule and breakdown sub-rows', () => {
  const table = buildPeriodTable([mkSession()], { period: 'daily' });
  const plain = renderPeriodTableText(table, { breakdown: true, color: false });
  const lines = plain.split('\n');
  assert.match(lines[0], /Date/);
  assert.match(lines[0], /Cache Cr/);
  assert.match(plain, /2026-04-20/);
  assert.match(plain, /└ sonnet-4-6/);
  assert.match(plain, /Total/);
  assert.match(plain, /\$3\.00/);
  // every rendered line has the same visible width (alignment check)
  const widths = new Set(lines.filter(l => l.includes('│')).map(l => l.length));
  assert.equal(widths.size, 1, `expected uniform row widths, got ${[...widths].join(',')}`);
});

test('periodTableJson: all fields always present, rounded, with totals', () => {
  const table = buildPeriodTable([mkSession({ commits: [] })], { period: 'weekly', startOfWeek: 'monday' });
  const doc = periodTableJson(table, { source: 'all', daysAnalyzed: 30 });
  assert.equal(doc.report, 'weekly');
  assert.equal(doc.startOfWeek, 'monday');
  assert.equal(doc.source, 'all');
  const row = doc.rows[0];
  for (const key of ['period', 'models', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'cost', 'sessions', 'commits', 'costPerCommit', 'modelBreakdown']) {
    assert.ok(key in row, `missing ${key}`);
  }
  assert.equal(row.costPerCommit, null);
  assert.equal(doc.totals.totalTokens, 1800);
});
