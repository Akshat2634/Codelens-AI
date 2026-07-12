import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callMcpTool, MCP_TOOLS } from '../../src/mcp.js';

// Minimal payload shaped like computeMetrics output — just the fields the MCP
// tool handlers (and reportModel/buildPeriodTable/buildBlocks) actually read.
const DAY = '2026-07-10';
function fakeSession(overrides = {}) {
  return {
    sessionId: 'sess-1',
    projectName: 'demo-repo',
    source: 'claude',
    startTime: `${DAY}T10:00:00.000Z`,
    endTime: `${DAY}T11:00:00.000Z`,
    cost: { totalCost: 4.2 },
    commitCount: 2,
    commits: [{ hash: 'abc', timestamp: new Date(`${DAY}T10:30:00.000Z`).getTime() }],
    linesAdded: 120,
    grade: 'B',
    totalInputTokens: 1000,
    totalOutputTokens: 2000,
    cacheReadTokens: 50000,
    cacheCreationTokens: 3000,
    dailyUsage: {
      [DAY]: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50000, cacheCreationTokens: 3000, cost: 4.2, byModel: { 'claude-opus-4-8': { tokens: 56000, cost: 4.2 } } },
    },
    usageEvents: [
      { ts: new Date(`${DAY}T10:00:00.000Z`).getTime(), input: 1000, output: 2000, cacheRead: 50000, cacheCreate: 3000, cost: 4.2 },
    ],
    ...overrides,
  };
}

function fakeView(source, sessions) {
  return {
    meta: {
      generatedAt: '2026-07-11T00:00:00.000Z',
      startDate: `${DAY}T10:00:00.000Z`,
      endDate: `${DAY}T11:00:00.000Z`,
      daysAnalyzed: 30,
      source,
      sources: { claude: 1, codex: 0 },
    },
    summary: {
      overallGrade: 'B',
      efficiencyScore: { score: 72, explanation: 'ok', tip: '' },
      totalCost: 4.2,
      pricingEstimatedPct: 0,
      plan: null,
      totalSessions: sessions.length,
      totalCommits: 2,
      mainBranchPct: 50,
      totalLinesAdded: 120,
      totalNetLines: 100,
      aiCodeSharePct: 40,
      valueLeak: { cost: 0.5, pct: 12 },
      avgCostPerCommit: 2.1,
      reconciliation: null,
    },
    lineSurvival: { survivalRate: 95 },
    modelBreakdown: { opus: { cost: 4.2, commits: 2, avgCostPerCommit: 2.1 } },
    insights: [{ type: 'info', text: 'looks fine' }],
    sessions,
    projects: [
      { repoName: 'demo-repo', remoteSlug: 'me/demo-repo', totalCost: 4.2, sessions: 1, commits: 2, linesAdded: 120, mainBranchPct: 50 },
    ],
  };
}

const mkCtx = (payloads, { refreshed = null } = {}) => ({
  days: 30,
  getPayloads: () => payloads,
  refresh: async () => refreshed,
});

const parse = (result) => {
  assert.ok(!result.isError, `expected success, got: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
};

const PAYLOADS = { all: fakeView('all', [fakeSession()]) };

test('MCP_TOOLS: every tool has a name, description, and object schema', () => {
  assert.ok(MCP_TOOLS.length >= 6);
  for (const t of MCP_TOOLS) {
    assert.ok(t.name && t.description, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('roi_summary returns the report model', async () => {
  const doc = parse(await callMcpTool('roi_summary', {}, mkCtx(PAYLOADS)));
  assert.equal(doc.grade, 'B');
  assert.equal(doc.totalCost, 4.2);
  assert.equal(doc.commits, 2);
  assert.equal(doc.survivalRate, 95);
  assert.equal(doc.insights.length, 1);
});

test('usage aggregates by period with model breakdown', async () => {
  const doc = parse(await callMcpTool('usage', { period: 'daily' }, mkCtx(PAYLOADS)));
  assert.equal(doc.report, 'daily');
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.rows[0].period, DAY);
  assert.equal(doc.rows[0].cost, 4.2);
  assert.equal(doc.rows[0].commits, 1); // one in-window commit on that day
  const monthly = parse(await callMcpTool('usage', { period: 'monthly' }, mkCtx(PAYLOADS)));
  assert.equal(monthly.rows[0].period, DAY.slice(0, 7));
});

test('blocks groups usage events into billing windows', async () => {
  const doc = parse(await callMcpTool('blocks', {}, mkCtx(PAYLOADS)));
  assert.equal(doc.report, 'blocks');
  assert.equal(doc.blocks.filter((b) => !b.isGap).length, 1);
  assert.equal(doc.blocks[0].totalTokens, 56000);
});

test('sessions returns compact rows, newest first, capped by limit', async () => {
  const older = fakeSession({ sessionId: 'sess-0', startTime: '2026-07-01T10:00:00.000Z' });
  const payloads = { all: fakeView('all', [older, fakeSession()]) };
  const doc = parse(await callMcpTool('sessions', { limit: 1 }, mkCtx(payloads)));
  assert.equal(doc.total, 2);
  assert.equal(doc.sessions.length, 1);
  assert.equal(doc.sessions[0].sessionId, 'sess-1'); // newest
  assert.equal(doc.sessions[0].cost, 4.2);
  assert.equal(doc.sessions[0].grade, 'B');
});

test('projects returns per-repo ROI ranked by cost', async () => {
  const doc = parse(await callMcpTool('projects', {}, mkCtx(PAYLOADS)));
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.projects[0].name, 'demo-repo');
  assert.equal(doc.projects[0].remote, 'me/demo-repo');
  assert.equal(doc.projects[0].costPerCommit, 2.1);
});

test('source: per-agent view is used when present, errors when absent', async () => {
  const payloads = { all: fakeView('all', [fakeSession()]), claude: fakeView('claude', [fakeSession()]) };
  const doc = parse(await callMcpTool('sessions', { source: 'claude' }, mkCtx(payloads)));
  assert.equal(doc.source, 'claude');
  const missing = await callMcpTool('sessions', { source: 'codex' }, mkCtx(payloads));
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /codex/);
});

test('no payloads: tools answer with a clear error instead of throwing', async () => {
  const res = await callMcpTool('roi_summary', {}, mkCtx(null));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /No AI coding agent sessions/);
});

test('refresh re-runs the pipeline and reports fresh counts', async () => {
  let payloads = null;
  const ctx = {
    days: 30,
    getPayloads: () => payloads,
    refresh: async () => {
      payloads = PAYLOADS;
      return payloads;
    },
  };
  const doc = parse(await callMcpTool('refresh', {}, ctx));
  assert.equal(doc.refreshed, true);
  assert.equal(doc.sessions, 1);
  // ...and the other tools now see the refreshed data
  const roi = parse(await callMcpTool('roi_summary', {}, ctx));
  assert.equal(roi.grade, 'B');
});

test('refresh with still-no-sessions reports it as an error message', async () => {
  const res = await callMcpTool('refresh', {}, mkCtx(null, { refreshed: null }));
  assert.equal(res.isError, true);
});

test('unknown tool name returns an error result', async () => {
  const res = await callMcpTool('nope', {}, mkCtx(PAYLOADS));
  assert.equal(res.isError, true);
});
