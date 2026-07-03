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

test('bestDay/worstDay rank by commits-per-dollar when spend is non-trivial', () => {
  const mk = (d) => ({ hash: 'h' + d, timestamp: d + 'T10:00:00.000Z', timestampMs: new Date(d + 'T10:00:00.000Z').getTime(), subject: 's', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 });
  const session = mkCorrelated({
    filesWritten: ['src/foo.js'],
    dailyUsage: {
      '2026-04-10': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 10 },
      '2026-04-11': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 1 },
    },
    commits: [mk('2026-04-10'), mk('2026-04-11')],
    commitCount: 2, commitsOnMain: 2, linesAdded: 10,
  });
  const m = computeMetrics([session], [], { '/repo': { commits: session.commits, defaultBranch: 'main' } }, 365);
  // 04-11 ($1, 1 commit = 1.0/$) beats 04-10 ($10, 1 commit = 0.1/$)
  assert.equal(m.summary.bestDay.date, '2026-04-11');
  assert.equal(m.summary.worstDay.date, '2026-04-10');
});

test('bestDay falls back to commit count when all days are trivially cheap', () => {
  const session = mkCorrelated({
    filesWritten: ['src/foo.js'],
    dailyUsage: {
      '2026-04-10': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.10 },
      '2026-04-11': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.05 },
    },
    // both days below the $0.50 floor → rank by commit count, not the noisy ratio
    commits: [
      { hash: 'a', timestamp: '2026-04-10T10:00:00.000Z', timestampMs: new Date('2026-04-10T10:00:00.000Z').getTime(), subject: 's', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
      { hash: 'b', timestamp: '2026-04-10T11:00:00.000Z', timestampMs: new Date('2026-04-10T11:00:00.000Z').getTime(), subject: 's', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
      { hash: 'c', timestamp: '2026-04-11T10:00:00.000Z', timestampMs: new Date('2026-04-11T10:00:00.000Z').getTime(), subject: 's', branches: ['main'], onMain: true, files: [{ path: 'src/foo.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
    ],
    commitCount: 3, commitsOnMain: 3, linesAdded: 15,
  });
  const m = computeMetrics([session], [], { '/repo': { commits: session.commits, defaultBranch: 'main' } }, 365);
  assert.equal(m.summary.bestDay.date, '2026-04-10'); // 2 commits
  assert.equal(m.summary.worstDay.date, '2026-04-11'); // 1 commit
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

test('toolbelt coverage uses per-source vocabulary and collapses codex shell aliases', () => {
  const claude = mkCorrelated({
    sessionId: 'cl',
    source: 'claude',
    toolCalls: { Read: 5, Edit: 3, Bash: 2 },
  });
  const codex = mkCorrelated({
    sessionId: 'cx',
    source: 'codex',
    toolCalls: { shell: 4, exec_command: 2, local_shell_call: 1, apply_patch: 3, update_plan: 1 },
  });
  const m = computeMetrics([claude, codex], [], {}, 30);
  const bySession = Object.fromEntries(m.autonomyMetrics.perSession.map(a => [a.sessionId, a]));
  // Claude: 3 unique of the 14-tool Claude vocabulary
  assert.equal(bySession.cl.toolbeltCoverage, Math.round((3 / 14) * 100));
  // Codex: shell/exec_command/local_shell_call collapse to one logical tool →
  // 3 unique (shell, apply_patch, update_plan) of the 9-tool codex vocabulary
  assert.equal(bySession.cx.toolbeltCoverage, Math.round((3 / 9) * 100));
});

test('toolbelt coverage caps at 100 when tools exceed the known vocabulary', () => {
  const wide = mkCorrelated({
    sessionId: 'w',
    source: 'codex',
    toolCalls: {
      shell: 1, apply_patch: 1, update_plan: 1, web_search: 1, write_stdin: 1,
      read_thread_terminal: 1, request_user_input: 1, view_image: 1,
      tool_search: 1, 'mcp.custom': 1, 'mcp.other': 1,
    },
  });
  const m = computeMetrics([wide], [], {}, 30);
  assert.equal(m.autonomyMetrics.perSession[0].toolbeltCoverage, 100);
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
  assert.equal(m.autonomyMetrics.perSession[0].selfHealScore, 50);
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
