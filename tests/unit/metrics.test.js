import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics } from '../../src/metrics.js';

// Build a correlated session stub (shape from correlator.js output)
function mkCorrelated(overrides = {}) {
  return {
    sessionId: 's1',
    repoPath: '/repo',
    projectName: 'repo',
    startTime: '2026-04-20T10:00:00.000Z',
    endTime: '2026-04-20T11:00:00.000Z',
    durationMinutes: 60,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
    cost: { totalCost: 3, inputCost: 1, outputCost: 1, cacheReadCost: 0.5, cacheCreationCost: 0.5 },
    model: 'claude-sonnet-4-6',
    modelBreakdown: { 'claude-sonnet-4-6': { tokens: 1800, cost: 3 } },
    toolCalls: { Read: 5, Edit: 3, Bash: 2 },
    filesWritten: ['src/foo.js'],
    filesRead: ['README.md'],
    userMessageCount: 5,
    assistantMessageCount: 20,
    bashCommands: [],
    totalBashCalls: 2,
    verificationBashCalls: 1,
    commits: [],
    commitCount: 0,
    commitsOnMain: 0,
    linesAdded: 0,
    linesDeleted: 0,
    netLines: 0,
    filesChanged: 0,
    isOrphaned: false,
    matchedByFiles: true,
    uncommittedFiles: [],
    costPerCommit: null,
    costPerLine: null,
    costPerNetLine: null,
    dailyUsage: {},
    ...overrides,
  };
}

test('computeMetrics on empty input returns a well-formed payload', () => {
  const m = computeMetrics([], [], {}, 30);
  assert.equal(m.summary.totalCost, 0);
  assert.equal(m.summary.totalSessions, 0);
  assert.equal(m.summary.totalCommits, 0);
  assert.equal(m.summary.overallGrade, 'F');
  assert.deepEqual(m.daily, []);
  assert.ok(m.summary.efficiencyScore);
  assert.equal(m.summary.efficiencyScore.score, 0);
  assert.equal(m.weeklyNarrative, null);
});

test('computeMetrics aggregates cost, sessions, commits from correlated input', () => {
  const session = mkCorrelated({
    commits: [{
      hash: 'abc', timestamp: '2026-04-20T10:30:00.000Z', timestampMs: new Date('2026-04-20T10:30:00.000Z').getTime(),
      subject: 'add foo', branches: ['main'], onMain: true,
      files: [{ path: 'src/foo.js', added: 20, deleted: 5 }],
      totalAdded: 20, totalDeleted: 5,
    }],
    commitCount: 1,
    commitsOnMain: 1,
    linesAdded: 20,
    linesDeleted: 5,
    netLines: 15,
    costPerCommit: 3,
    costPerLine: 0.15,
  });

  const commitsByRepo = {
    '/repo': {
      commits: session.commits,
      defaultBranch: 'main',
    },
  };

  const m = computeMetrics([session], [], commitsByRepo, 30);
  assert.equal(m.summary.totalCost, 3);
  assert.equal(m.summary.totalSessions, 1);
  assert.equal(m.summary.totalCommits, 1);
  assert.equal(m.summary.totalCommitsOnMain, 1);
  assert.equal(m.summary.mainBranchPct, 100);
  assert.equal(m.summary.totalLinesAdded, 20);
  assert.ok(m.summary.avgCostPerCommit !== null);
});

test('efficiency grade reflects cost-per-commit and survival', () => {
  // Cheap + stable session → should land high
  const cheapGood = mkCorrelated({
    cost: { totalCost: 1, inputCost: 0.5, outputCost: 0.3, cacheReadCost: 0.1, cacheCreationCost: 0.1 },
    commits: [{
      hash: 'x', timestamp: '2026-04-20T10:30:00.000Z', timestampMs: new Date('2026-04-20T10:30:00.000Z').getTime(),
      subject: 's', branches: ['main'], onMain: true,
      files: [{ path: 'src/a.js', added: 50, deleted: 0 }],
      totalAdded: 50, totalDeleted: 0,
    }],
    commitCount: 1,
    commitsOnMain: 1,
    linesAdded: 50,
  });
  const commitsByRepo = { '/repo': { commits: cheapGood.commits, defaultBranch: 'main' } };
  const m = computeMetrics([cheapGood], [], commitsByRepo, 30);
  // $1/commit, 100% survival (single commit, no churn) → should be A
  assert.equal(m.summary.overallGrade, 'A');
  assert.ok(m.summary.efficiencyScore.score >= 80);
});

test('insights list is bounded and sorted by priority', () => {
  // Build 15 orphaned sessions to guarantee the orphan-rate warning fires
  const orphans = Array.from({ length: 15 }, (_, i) => mkCorrelated({
    sessionId: 'orphan-' + i,
    userMessageCount: 20,
    assistantMessageCount: 50,
    isOrphaned: true,
  }));
  const m = computeMetrics(orphans, [], {}, 30);
  assert.ok(m.insights.length <= 8, 'insights should be capped at 8');
  // Warnings should come first
  if (m.insights.length > 1 && m.insights[0].type === 'warning') {
    // Check no 'success' appears before the last 'warning'
    const lastWarningIdx = m.insights.map(i => i.type).lastIndexOf('warning');
    const firstSuccessIdx = m.insights.findIndex(i => i.type === 'success');
    if (firstSuccessIdx >= 0 && lastWarningIdx >= 0) {
      assert.ok(firstSuccessIdx > lastWarningIdx, 'warnings should sort before successes');
    }
  }
});

test('weeklyNarrative populated when this-week sessions exist', () => {
  const now = Date.now();
  const recent = mkCorrelated({
    startTime: new Date(now - 24 * 3600 * 1000).toISOString(),
    endTime: new Date(now - 23 * 3600 * 1000).toISOString(),
    commitCount: 3,
    commits: [{
      hash: 'h', timestamp: new Date(now - 23 * 3600 * 1000).toISOString(),
      timestampMs: now - 23 * 3600 * 1000,
      subject: 's', branches: ['main'], onMain: true,
      files: [{ path: 'src/a.js', added: 30, deleted: 0 }],
      totalAdded: 30, totalDeleted: 0,
    }],
    commitsOnMain: 1,
    linesAdded: 30,
  });
  const m = computeMetrics([recent], [], { '/repo': { commits: recent.commits, defaultBranch: 'main' } }, 30);
  assert.ok(m.weeklyNarrative, 'narrative should be populated');
  assert.ok(typeof m.weeklyNarrative.headline === 'string');
  assert.ok(Array.isArray(m.weeklyNarrative.metrics));
  assert.ok(Array.isArray(m.weeklyNarrative.bullets));
  // Metrics should include Commits, Spend, Cost/Commit, Lines Added
  const labels = m.weeklyNarrative.metrics.map(mm => mm.label);
  assert.ok(labels.includes('Commits'));
  assert.ok(labels.includes('Spend'));
});
