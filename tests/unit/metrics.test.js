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

test('projects merge by git remote across paths; same-name repos disambiguate', () => {
  // Same repo at two on-disk paths (a clone + a worktree) sharing one remote,
  // plus a genuinely different repo that happens to share the folder name.
  const sessions = [
    mkCorrelated({ sessionId: 'a', repoPath: '/home/me/techops', projectName: 'techops', commitCount: 8, commitsOnMain: 8 }),
    mkCorrelated({ sessionId: 'b', repoPath: '/tmp/wt/techops', projectName: 'techops', commitCount: 2, commitsOnMain: 1 }),
    mkCorrelated({ sessionId: 'c', repoPath: '/home/me/other/techops', projectName: 'techops', commitCount: 1, commitsOnMain: 1 }),
  ];
  const commitsByRepo = {
    '/home/me/techops': { remote: 'github.com/me/techops', remoteSlug: 'me/techops', commits: [], defaultBranch: 'main' },
    '/tmp/wt/techops': { remote: 'github.com/me/techops', remoteSlug: 'me/techops', commits: [], defaultBranch: 'main' },
    '/home/me/other/techops': { remote: 'github.com/acme/techops', remoteSlug: 'acme/techops', commits: [], defaultBranch: 'main' },
  };
  const m = computeMetrics(sessions, [], commitsByRepo, 30);
  // Two entries, not three: the two same-remote paths collapsed into one.
  assert.equal(m.projects.length, 2);
  const merged = m.projects.find(p => p.remote === 'github.com/me/techops');
  assert.equal(merged.commits, 10); // 8 + 2
  assert.equal(merged.sessions, 2);
  // Both surviving entries share the folder name "techops", so they get the
  // disambiguated owner/repo label instead of two identical "techops" cards.
  const names = m.projects.map(p => p.repoName).sort();
  assert.deepEqual(names, ['acme/techops', 'me/techops']);
});

test('projects with no remote fall back to path keying (unchanged behavior)', () => {
  const m = computeMetrics([mkCorrelated({ repoPath: '/repo', projectName: 'repo' })], [], {}, 30);
  assert.equal(m.projects.length, 1);
  assert.equal(m.projects[0].repoName, 'repo');
});

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
      files: [{ path: 'src/foo.js', added: 50, deleted: 0 }],
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

test('line survival: rework within 24h is churned; totals reconcile', () => {
  const now = Date.now();
  const t0 = now - 5 * 24 * 3600 * 1000; // old enough to be matured
  const t1 = t0 + 3600 * 1000; // +1h, within the 24h churn window
  const session = mkCorrelated({
    filesWritten: ['src/foo.js'],
    commits: [
      { hash: 'c1', timestamp: new Date(t0).toISOString(), timestampMs: t0, subject: 'add', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 100, deleted: 0 }], totalAdded: 100, totalDeleted: 0 },
      { hash: 'c2', timestamp: new Date(t1).toISOString(), timestampMs: t1, subject: 'rework', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 0, deleted: 30 }], totalAdded: 0, totalDeleted: 30 },
    ],
    commitCount: 2, commitsOnMain: 2, linesAdded: 100, linesDeleted: 30,
  });
  const cbr = { '/repo': { commits: session.commits, defaultBranch: 'main' } };
  const m = computeMetrics([session], [], cbr, 30);
  assert.equal(m.lineSurvival.totalAdded, 100);
  assert.equal(m.lineSurvival.totalChurned, 30);
  assert.equal(m.lineSurvival.maturing, 0);
  assert.equal(m.lineSurvival.survivalRate, 70);
  // reconciliation: summary == survival == sum(daily)
  assert.equal(m.summary.totalLinesAdded, m.lineSurvival.totalAdded);
  assert.equal(m.daily.reduce((a, d) => a + d.linesAdded, 0), m.summary.totalLinesAdded);
});

test('line survival: lines added in the last 24h are right-censored from the rate', () => {
  const now = Date.now();
  const recent = now - 3600 * 1000; // 1h ago — too young to judge
  const session = mkCorrelated({
    filesWritten: ['src/foo.js'],
    commits: [{ hash: 'r', timestamp: new Date(recent).toISOString(), timestampMs: recent, subject: 'add', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 40, deleted: 0 }], totalAdded: 40, totalDeleted: 0 }],
    commitCount: 1, commitsOnMain: 1, linesAdded: 40,
  });
  const cbr = { '/repo': { commits: session.commits, defaultBranch: 'main' } };
  const m = computeMetrics([session], [], cbr, 30);
  assert.equal(m.lineSurvival.totalAdded, 40);
  assert.equal(m.lineSurvival.maturing, 40);
  // Nothing has matured yet → the rate is unmeasurable, reported as null. A
  // fabricated 100% here would bank full survival marks into the efficiency
  // score and grade with zero evidence.
  assert.equal(m.lineSurvival.survivalRate, null);
  // …and null survival is neutral (not a free 50/50) in the efficiency score.
  assert.ok(m.summary.efficiencyScore.explanation.includes('survival pending'));
});

test('model breakdown attributes whole commits to the dominant family', () => {
  const session = mkCorrelated({
    modelBreakdown: { 'claude-opus-4-8': { tokens: 1000, cost: 5 }, 'claude-sonnet-4-6': { tokens: 200, cost: 0.6 } },
    commits: [{ hash: 'a', timestamp: '2026-04-20T10:30:00.000Z', timestampMs: new Date('2026-04-20T10:30:00.000Z').getTime(), subject: 's', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 10, deleted: 0 }], totalAdded: 10, totalDeleted: 0 }],
    commitCount: 3, commitsOnMain: 1, linesAdded: 10,
  });
  const cbr = { '/repo': { commits: session.commits, defaultBranch: 'main' } };
  const m = computeMetrics([session], [], cbr, 30);
  assert.equal(m.modelBreakdown.opus.commits, 3, 'all commits to dominant family');
  assert.equal(m.modelBreakdown.sonnet.commits, 0, 'non-dominant family gets no commits');
  assert.equal(m.modelBreakdown.opus.sessions, 1);
  assert.equal(m.modelBreakdown.sonnet.sessions, 1, 'still counted as a family the session used');
  assert.ok(Number.isInteger(m.modelBreakdown.opus.commits));
});

test('reconciliation aggregates commit confidence and line populations', () => {
  const sessionHigh = mkCorrelated({
    sessionId: 'h', attributionConfidence: 'high',
    filesWritten: ['src/foo.js'],
    commits: [{
      hash: 'h1', timestamp: '2026-04-20T10:30:00.000Z', timestampMs: new Date('2026-04-20T10:30:00.000Z').getTime(),
      subject: 's', branches: ['main'], onMain: true,
      files: [{ path: 'src/foo.js', added: 20, deleted: 0 }, { path: 'src/bar.js', added: 10, deleted: 0 }],
      totalAdded: 30, totalDeleted: 0,
    }],
    commitCount: 1, commitsOnMain: 1, linesAdded: 20, linesDeleted: 0,
  });
  const organic = [{
    hash: 'o1', timestamp: '2026-04-19T10:00:00.000Z', timestampMs: new Date('2026-04-19T10:00:00.000Z').getTime(),
    subject: 'manual', branches: ['main'], onMain: true,
    files: [{ path: 'src/baz.js', added: 50, deleted: 0 }], totalAdded: 50, totalDeleted: 0,
  }];
  const cbr = { '/repo': { commits: sessionHigh.commits.concat(organic), defaultBranch: 'main' } };
  const m = computeMetrics([sessionHigh], organic, cbr, 30);
  const r = m.summary.reconciliation;
  assert.equal(r.commits.aiMatched, 1);
  assert.equal(r.commits.organic, 1);
  assert.deepEqual(r.commits.byConfidence, { high: 1, medium: 0, low: 0 });
  assert.equal(r.lines.aiAttributed, 20);       // overlap (foo.js only)
  assert.equal(r.lines.aiCommitsTotal, 30);     // full commit (foo.js + bar.js)
  assert.equal(r.lines.organic, 50);            // unmatched commit
});

test('subscription plan mode computes effective cost + utilization', () => {
  const session = mkCorrelated({
    cost: { totalCost: 50, inputCost: 25, outputCost: 20, cacheReadCost: 3, cacheCreationCost: 2 },
    commits: [{
      hash: 'p1', timestamp: '2026-04-20T10:30:00.000Z', timestampMs: new Date('2026-04-20T10:30:00.000Z').getTime(),
      subject: 's', branches: ['main'], onMain: true,
      files: [{ path: 'src/foo.js', added: 100, deleted: 0 }], totalAdded: 100, totalDeleted: 0,
    }],
    commitCount: 1, commitsOnMain: 1, linesAdded: 100,
  });
  const cbr = { '/repo': { commits: session.commits, defaultBranch: 'main' } };

  // No plan → summary.plan is null (backward compatible)
  assert.equal(computeMetrics([session], [], cbr, 30).summary.plan, null);

  // max5 = $100/mo, 30-day window → windowCost $100; totalCost $50; 1 commit; 100 surviving lines
  const m = computeMetrics([session], [], cbr, 30, { name: 'max5', monthlyCost: 100 });
  const p = m.summary.plan;
  assert.ok(p, 'plan should be populated');
  assert.equal(p.windowCost, 100);
  assert.equal(p.apiEquivalentCost, 50);
  assert.equal(p.utilizationRatio, 0.5);          // 50 API-equiv / 100 fee
  assert.equal(p.effectiveCostPerCommit, 100);     // 100 fee / 1 commit
  assert.equal(p.effectiveCostPerSurvivingLine, 1); // 100 fee / 100 surviving lines
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
      files: [{ path: 'src/foo.js', added: 30, deleted: 0 }],
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

test('selfHealScore excludes read-only shell calls from the denominator', () => {
  // Codex routes file reading through the shell — 62 of 100 calls being
  // sed/rg/ls must not deflate the verification share of actual work
  const codex = mkCorrelated({
    totalBashCalls: 100,
    readOnlyBashCalls: 62,
    verificationBashCalls: 19,
  });
  const m = computeMetrics([codex], [], {}, 30);
  assert.equal(m.autonomyMetrics.selfHealScore, 50); // 19 / (100 - 62)
  assert.equal(m.sessions[0].selfHealScore, 50);
  // perSession is an internal join table — it must not ship in the payload
  assert.equal('perSession' in m.autonomyMetrics, false);
  // Displayed raw counts stay untouched
  assert.equal(m.autonomyMetrics.totalBashCalls, 100);
  assert.equal(m.autonomyMetrics.totalVerificationCalls, 19);
});

test('selfHealScore clamps at 100 and tolerates sessions cached before readOnlyBashCalls', () => {
  // verification ⊄ read-only is possible in odd data — clamp, don't exceed 100
  const clamp = mkCorrelated({ totalBashCalls: 10, readOnlyBashCalls: 9, verificationBashCalls: 5 });
  assert.equal(computeMetrics([clamp], [], {}, 30).autonomyMetrics.selfHealScore, 100);
  // Old cached sessions have no readOnlyBashCalls field → old behavior
  const legacy = mkCorrelated({ totalBashCalls: 10, verificationBashCalls: 4 });
  assert.equal(computeMetrics([legacy], [], {}, 30).autonomyMetrics.selfHealScore, 40);
});

test('self-heal denominator floor is aligned at 0 for both the score and the exposed field', () => {
  // Synthetic repro of the old "pwd && npm test" double-count shape (a
  // command flagged as BOTH verification and read-only, which real
  // classification can no longer produce — isReadOnlyCommand('pwd && npm
  // test') is now false). With zero real attempted calls, the denominator
  // must floor at 0 for BOTH the score math and the displayed field, so the
  // dashboard never shows a fabricated non-zero score ("100% verified")
  // paired with a "0 shell calls" denominator.
  const doubleCounted = mkCorrelated({
    totalBashCalls: 1,
    readOnlyBashCalls: 1,
    verificationBashCalls: 1,
  });
  const m = computeMetrics([doubleCounted], [], {}, 30);
  assert.equal(m.autonomyMetrics.attemptedBashCalls, 0);
  assert.equal(m.autonomyMetrics.selfHealScore, 0);
  assert.equal(m.sessions[0].selfHealScore, 0);
});

test('an all-read-only session is neutral (50), not punished (0), and does not trigger the low self-heal warning', () => {
  // Every bash call is read-only inspection — zero state-changing calls
  // means there is nothing to have tested, which is exactly the
  // "not enough evidence" case MIN_BASH_FOR_SELFHEAL exists to protect.
  const allReadOnly = mkCorrelated({
    totalBashCalls: 25,
    readOnlyBashCalls: 25,
    verificationBashCalls: 0,
  });
  const m = computeMetrics([allReadOnly], [], {}, 30);
  assert.equal(m.autonomyMetrics.attemptedBashCalls, 0);
  assert.equal(m.autonomyMetrics.breakdown.selfHealWeighted, 50);
  assert.ok(
    !m.insights.some(i => i.text.includes('low self-healing')),
    'a purely-exploratory read-only session should not generate a self-contradictory "0% of 0" warning'
  );
});

test('self-heal insight uses agent-neutral shell wording', () => {
  const session = mkCorrelated({
    totalBashCalls: 30,
    readOnlyBashCalls: 0,
    verificationBashCalls: 0,
  });
  const m = computeMetrics([session], [], {}, 30);
  const warning = m.insights.find(i => i.text.includes('low self-healing'));
  assert.ok(warning, 'low self-heal warning should fire');
  assert.ok(warning.text.includes('shell commands'));
  assert.ok(!m.insights.some(i => i.text.includes('bash commands')));
});

test('model cost insight requires 3+ commits per family and names families explicitly', () => {
  const opusHeavy = mkCorrelated({
    sessionId: 'op',
    cost: { totalCost: 30, inputCost: 15, outputCost: 15, cacheReadCost: 0, cacheCreationCost: 0 },
    modelBreakdown: { 'claude-opus-4-8': { tokens: 1000, cost: 30 } },
    commits: [], commitCount: 3,
  });
  const sonnetCheap = mkCorrelated({
    sessionId: 'so',
    cost: { totalCost: 3, inputCost: 1.5, outputCost: 1.5, cacheReadCost: 0, cacheCreationCost: 0 },
    modelBreakdown: { 'claude-sonnet-4-6': { tokens: 1000, cost: 3 } },
    commits: [], commitCount: 3,
  });
  const m = computeMetrics([opusHeavy, sonnetCheap], [], {}, 30);
  const insight = m.insights.find(i => i.text.includes('-family models cost'));
  assert.ok(insight, 'cost comparison should fire when both families have 3+ commits');
  assert.equal(insight.text, 'Opus-family models cost 10.0x more per commit than Sonnet-family models.');

  // One family resting on a 1-commit sample → no comparison
  const sonnetTiny = mkCorrelated({ ...sonnetCheap, commitCount: 1 });
  const m2 = computeMetrics([opusHeavy, sonnetTiny], [], {}, 30);
  assert.ok(!m2.insights.some(i => i.text.includes('-family models cost')));
});

test('weekly narrative distinguishes first week from a quiet prior week', () => {
  const now = Date.now();
  const mkWeekSession = (overrides = {}) => mkCorrelated({
    startTime: new Date(now - 24 * 3600 * 1000).toISOString(),
    endTime: new Date(now - 23 * 3600 * 1000).toISOString(),
    commits: [{
      hash: 'wk', timestamp: new Date(now - 23 * 3600 * 1000).toISOString(),
      timestampMs: now - 23 * 3600 * 1000,
      subject: 's', branches: ['main'], onMain: true,
      files: [{ path: 'src/foo.js', added: 10, deleted: 0 }],
      totalAdded: 10, totalDeleted: 0,
    }],
    commitCount: 1, commitsOnMain: 1, linesAdded: 10,
    ...overrides,
  });

  // No history before this week → genuinely the first week
  let m = computeMetrics([mkWeekSession()], [], {}, 90);
  assert.ok(m.weeklyNarrative.headline.includes('first week of measured activity'));

  // Months of intermittent history with a quiet prior week → not "first week"
  const old = mkCorrelated({
    sessionId: 'old',
    startTime: new Date(now - 60 * 24 * 3600 * 1000).toISOString(),
    endTime: new Date(now - 60 * 24 * 3600 * 1000 + 3600 * 1000).toISOString(),
  });
  m = computeMetrics([mkWeekSession({ sessionId: 'recent' }), old], [], {}, 90);
  assert.ok(m.weeklyNarrative.headline.includes('no activity last week to compare'));
  assert.ok(!m.weeklyNarrative.headline.includes('first week'));
});

test('daily timeline gap-fills zero rows between active days', () => {
  const session = mkCorrelated({
    dailyUsage: {
      '2026-04-10': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 2 },
      '2026-04-14': { inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 },
    },
  });
  const m = computeMetrics([session], [], {}, 365);
  assert.deepEqual(
    m.daily.map(d => d.date),
    ['2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13', '2026-04-14'],
    'dates should be contiguous across the gap'
  );
  // Gap rows carry the full row shape with zeroed values
  assert.deepEqual(m.daily[1], {
    date: '2026-04-11', cost: 0, sessions: 0, commits: 0,
    linesAdded: 0, linesDeleted: 0, netLines: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0,
  });
  // Zero rows sum to nothing — totals are unchanged by the fill
  assert.equal(m.daily.reduce((a, d) => a + d.cost, 0), 3);
  assert.equal(m.daily.reduce((a, d) => a + d.sessions, 0), 1);
  assert.equal(m.daily.reduce((a, d) => a + d.totalTokens, 0), 430);
});

test('daily timeline with a single active day is not gap-filled', () => {
  const session = mkCorrelated({
    dailyUsage: {
      '2026-04-10': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 2 },
    },
  });
  const m = computeMetrics([session], [], {}, 365);
  assert.equal(m.daily.length, 1);
  assert.equal(m.daily[0].date, '2026-04-10');
});

test('valueLeak sums the cost of zero-commit sessions', () => {
  const ts = '2026-04-20T10:30:00.000Z';
  const commit = { hash: 'v1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 's', onMain: true, files: [{ path: 'src/foo.js', added: 10, deleted: 0 }], totalAdded: 10, totalDeleted: 0 };
  const shipped = mkCorrelated({
    sessionId: 'ship', commits: [commit], commitCount: 1, commitsOnMain: 1, linesAdded: 10,
    cost: { totalCost: 6, inputCost: 3, outputCost: 3, cacheReadCost: 0, cacheCreationCost: 0 },
  });
  const leaked1 = mkCorrelated({ sessionId: 'l1', cost: { totalCost: 3, inputCost: 2, outputCost: 1, cacheReadCost: 0, cacheCreationCost: 0 } });
  const leaked2 = mkCorrelated({ sessionId: 'l2', cost: { totalCost: 1, inputCost: 1, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 } });
  const m = computeMetrics([shipped, leaked1, leaked2], [], { '/repo': { commits: [commit], defaultBranch: 'main' } }, 30);
  assert.equal(m.summary.valueLeak.cost, 4);
  assert.equal(m.summary.valueLeak.pct, 40); // 4 of 10 total
  assert.equal(m.summary.valueLeak.sessionCount, 2);
});

test('aiCodeSharePct divides AI-attributed lines by all lines merged in the window', () => {
  const ts = '2026-04-20T10:30:00.000Z';
  // AI commit: 40 added lines total, 30 in the file the session wrote
  const aiCommit = {
    hash: 'ai1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 's', onMain: true,
    files: [{ path: 'src/foo.js', added: 30, deleted: 0 }, { path: 'manual.md', added: 10, deleted: 0 }],
    totalAdded: 40, totalDeleted: 0,
  };
  const session = mkCorrelated({ commits: [aiCommit], commitCount: 1, commitsOnMain: 1, linesAdded: 30 });
  // Organic commit adds another 60 lines
  const organic = { hash: 'org1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 'manual', onMain: true, files: [{ path: 'x.js', added: 60, deleted: 0 }], totalAdded: 60, totalDeleted: 0 };
  const m = computeMetrics([session], [organic], { '/repo': { commits: [aiCommit, organic], defaultBranch: 'main' } }, 30);
  // 30 AI-attributed of (40 + 60) window lines = 30%
  assert.equal(m.summary.aiCodeSharePct, 30);
});

test('aiCodeSharePct is null when the window has no added lines', () => {
  const m = computeMetrics([mkCorrelated()], [], {}, 30);
  assert.equal(m.summary.aiCodeSharePct, null);
});

test('reconciliation counts trailer-stamped commits, matched and organic', () => {
  const ts = '2026-04-20T10:30:00.000Z';
  const stamped = {
    hash: 't1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 's', onMain: true, aiTrailer: 'claude',
    files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0,
  };
  const session = mkCorrelated({
    source: 'claude',
    commits: [stamped], commitCount: 1, commitsOnMain: 1, linesAdded: 5,
    trailerConfirmedCommits: 1, attributionConfidence: 'high',
  });
  const organicStamped = { hash: 't2', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 'o', onMain: true, aiTrailer: 'codex', files: [{ path: 'y.js', added: 3, deleted: 0 }], totalAdded: 3, totalDeleted: 0 };
  const organicPlain = { hash: 't3', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 'p', onMain: true, files: [{ path: 'z.js', added: 2, deleted: 0 }], totalAdded: 2, totalDeleted: 0 };
  const m = computeMetrics([session], [organicStamped, organicPlain], { '/repo': { commits: [stamped, organicStamped, organicPlain], defaultBranch: 'main' } }, 30);
  assert.deepEqual(m.summary.reconciliation.commits.trailerStamped, { matched: 1, crossAgent: 0, organic: 1 });
});

test('trailer-stamped commits claimed by a DIFFERENT agent land in the crossAgent bucket', () => {
  const ts = '2026-04-20T10:30:00.000Z';
  // A claude-stamped commit claimed by a codex session (e.g. the claude
  // session log aged out) — neither confirmed nor organic, but still stamped.
  const stamped = {
    hash: 'x1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 's', onMain: true, aiTrailer: 'claude',
    files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0,
  };
  const codexSession = mkCorrelated({
    source: 'codex',
    commits: [stamped], commitCount: 1, commitsOnMain: 1, linesAdded: 5,
    trailerConfirmedCommits: 0,
  });
  const m = computeMetrics([codexSession], [], { '/repo': { commits: [stamped], defaultBranch: 'main' } }, 30);
  assert.deepEqual(m.summary.reconciliation.commits.trailerStamped, { matched: 0, crossAgent: 1, organic: 0 });
});

test('per-agent views do not report the other agent\'s claimed commits as trailer-organic', () => {
  const ts = '2026-04-20T10:30:00.000Z';
  // index.js folds the OTHER agent's claimed commits into a per-agent view's
  // organic set with claimedByOtherAgent — they matched a session, so the
  // "no session in this window" audit line must not count them.
  const otherAgentCommit = {
    hash: 'o1', timestamp: ts, timestampMs: new Date(ts).getTime(), subject: 's', onMain: true, aiTrailer: 'codex',
    claimedByOtherAgent: true,
    files: [{ path: 'x.js', added: 4, deleted: 0 }], totalAdded: 4, totalDeleted: 0,
  };
  const m = computeMetrics([mkCorrelated()], [otherAgentCommit], {}, 30);
  assert.equal(m.summary.reconciliation.commits.trailerStamped.organic, 0);
  assert.ok(!m.insights.some(i => i.text.includes('co-author trailer')), 'no false missing-logs insight');
});

test('skillBreakdown aggregates per-skill counts across sessions', () => {
  const s1 = mkCorrelated({ sessionId: 's1', skillCalls: { 'deep-research': 2, worktree: 1 } });
  const s2 = mkCorrelated({ sessionId: 's2', skillCalls: { 'deep-research': 1 } });
  const m = computeMetrics([s1, s2], [], {}, 30);
  assert.deepEqual(m.skillBreakdown, { 'deep-research': 3, worktree: 1 });
});

test('mcpServerBreakdown groups mcp__<server>__<tool> tool names by server', () => {
  const session = mkCorrelated({
    toolCalls: { Read: 5, 'mcp__claude_ai_Linear__list_issues': 2, 'mcp__claude_ai_Linear__get_issue': 1, mcp__playwright__browser_click: 4 },
  });
  const m = computeMetrics([session], [], {}, 30);
  assert.deepEqual(m.mcpServerBreakdown, { claude_ai_Linear: 3, playwright: 4 });
});

test('clientBreakdown counts sessions by entrypoint, defaulting to unknown', () => {
  const s1 = mkCorrelated({ sessionId: 's1', entrypoint: 'cli' });
  const s2 = mkCorrelated({ sessionId: 's2', entrypoint: 'claude-vscode' });
  const s3 = mkCorrelated({ sessionId: 's3' }); // no entrypoint field
  const m = computeMetrics([s1, s2, s3], [], {}, 30);
  assert.deepEqual(m.clientBreakdown, { cli: 1, 'claude-vscode': 1, unknown: 1 });
});

test('agentTypeBreakdown and featureAdoption reflect subagent, skill, MCP, and plan-mode usage', () => {
  const delegated = mkCorrelated({ sessionId: 's1', subagentTranscriptCount: 2, skillCalls: { review: 1 } });
  const mainOnly = mkCorrelated({
    sessionId: 's2',
    toolCalls: { Read: 1, 'mcp__playwright__browser_click': 1, ExitPlanMode: 1 },
  });
  const m = computeMetrics([delegated, mainOnly], [], {}, 30);

  assert.deepEqual(m.agentTypeBreakdown, {
    main_only: { sessions: 1, pct: 50 },
    delegated: { sessions: 1, pct: 50 },
  });

  const byFeature = Object.fromEntries(m.featureAdoption.map((f) => [f.feature, f]));
  assert.deepEqual(byFeature['Sub-agents'], { feature: 'Sub-agents', sessions: 1, pct: 50 });
  assert.deepEqual(byFeature.Skills, { feature: 'Skills', sessions: 1, pct: 50 });
  assert.deepEqual(byFeature['MCP servers'], { feature: 'MCP servers', sessions: 1, pct: 50 });
  assert.deepEqual(byFeature['Plan mode'], { feature: 'Plan mode', sessions: 1, pct: 50 });
});

test('skillBreakdown, mcpServerBreakdown, and clientBreakdown are empty (not missing) on empty input', () => {
  const m = computeMetrics([], [], {}, 30);
  assert.deepEqual(m.skillBreakdown, {});
  assert.deepEqual(m.mcpServerBreakdown, {});
  assert.deepEqual(m.clientBreakdown, {});
  assert.deepEqual(m.agentTypeBreakdown, { main_only: { sessions: 0, pct: 0 }, delegated: { sessions: 0, pct: 0 } });
});
