import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReportHtml, renderReportMarkdown, renderReportText, reportModel } from '../../src/report.js';

// Minimal metrics payload with the fields reportModel reads.
function mkPayload(overrides = {}) {
  return {
    meta: {
      generatedAt: '2026-07-04T12:00:00.000Z',
      daysAnalyzed: 30,
      startDate: '2026-06-04T00:00:00.000Z',
      endDate: '2026-07-04T00:00:00.000Z',
      source: 'all',
      ...overrides.meta,
    },
    summary: {
      totalCost: 142.5,
      pricingEstimatedPct: 0,
      plan: null,
      totalSessions: 12,
      totalCommits: 38,
      mainBranchPct: 71,
      totalLinesAdded: 12480,
      totalNetLines: 9102,
      avgCostPerCommit: 3.75,
      overallGrade: 'B',
      efficiencyScore: { score: 68, tier: 'Solid', explanation: 'Good cost per commit.', tip: '' },
      aiCodeSharePct: 62,
      valueLeak: { cost: 18.4, pct: 13, sessionCount: 4 },
      reconciliation: {
        commits: {
          aiMatched: 38,
          organic: 12,
          byConfidence: { high: 24, medium: 10, low: 4 },
          trailerStamped: { matched: 9, organic: 2 },
        },
        lines: { aiAttributed: 12480, aiCommitsTotal: 15000, organic: 5000 },
      },
      ...overrides.summary,
    },
    lineSurvival: { survivalRate: 85, ...overrides.lineSurvival },
    modelBreakdown: overrides.modelBreakdown || {
      opus: { cost: 100, commits: 30, avgCostPerCommit: 3.33, sessions: 8 },
      sonnet: { cost: 42.5, commits: 8, avgCostPerCommit: 5.31, sessions: 4 },
    },
    insights: overrides.insights || [
      { type: 'success', text: 'Only 13% of spend didn\'t reach a commit — very little value leak.' },
    ],
  };
}

test('reportModel extracts the headline rows', () => {
  const m = reportModel(mkPayload());
  assert.equal(m.grade, 'B');
  assert.equal(m.commits, 38);
  assert.equal(m.aiCodeSharePct, 62);
  assert.equal(m.valueLeak.pct, 13);
  assert.equal(m.attribution.trailerMatched, 9);
  assert.equal(m.attribution.trailerOrganic, 2);
  assert.equal(m.models[0].family, 'Opus', 'sorted by cost, capitalised');
  assert.equal(m.days, 30);
});

test('reportModel adds per-agent rows only when both agent views exist', () => {
  const all = mkPayload();
  assert.deepEqual(reportModel(all, { all }).agents, []);
  const payloads = { all, claude: mkPayload(), codex: mkPayload({ summary: { overallGrade: 'C' } }) };
  const m = reportModel(all, payloads);
  assert.equal(m.agents.length, 2);
  assert.equal(m.agents[0].label, 'Claude Code');
  assert.equal(m.agents[1].grade, 'C');
});

test('terminal report includes the key figures', () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition
  const text = renderReportText(reportModel(mkPayload())).replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(text.includes('Grade B'));
  assert.ok(text.includes('$142.50'));
  assert.ok(text.includes('38'));
  assert.ok(text.includes('62% of merged lines'));
  assert.ok(text.includes('$18.40 (13%)'));
  assert.ok(text.includes('9') && text.includes('Trailer-confirmed'));
  assert.ok(text.includes('85%'));
});

test('markdown report renders tables with the key figures', () => {
  const md = renderReportMarkdown(reportModel(mkPayload()));
  assert.ok(md.startsWith('# AI coding ROI report'));
  assert.ok(md.includes('| Spend (API-equivalent) | $142.50 |'));
  assert.ok(md.includes('| AI code share | 62% of merged lines |'));
  assert.ok(md.includes('| Value leak | $18.40 (13%) spend with no committed code |'));
  assert.ok(md.includes('Co-authored-by'));
});

test('plan figures appear when a subscription plan is configured', () => {
  const payload = mkPayload({
    summary: {
      plan: {
        name: 'max20', monthlyCost: 200, windowDays: 30, windowCost: 200,
        apiEquivalentCost: 142.5, utilizationRatio: 0.71,
        effectiveCostPerCommit: 5.26, effectiveCostPerSurvivingLine: 0.02,
      },
    },
  });
  const md = renderReportMarkdown(reportModel(payload));
  assert.ok(md.includes('| Plan (max20) | $200.00 for this window |'));
  assert.ok(md.includes('| Plan utilization | 0.71x'));
  assert.ok(md.includes('(effective $5.26 on plan)'));
});

test('html report is self-contained and escapes data-derived strings', () => {
  const payload = mkPayload({
    insights: [{ type: 'info', text: '<script>alert(1)</script> risky insight' }],
  });
  const html = renderReportHtml(reportModel(payload));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'insight text must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('http://') && !html.includes('https://cdn'), 'no external resources');
  assert.ok(html.includes('Grade B'));
});
