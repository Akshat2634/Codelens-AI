// One-command ROI report: the "is my AI subscription paying for itself"
// artifact, printable in the terminal or exportable as self-contained
// Markdown/HTML to hand to a manager. Everything is rendered from an
// already-computed metrics payload — no parsing or git work happens here.

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
  orange: '\x1b[38;5;208m',
};
const GRADE_COLOR = { A: c.green, B: c.cyan, C: c.yellow, D: c.yellow, F: c.red };

function fmtMoney(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  if (v > 0 && v < 0.005) return '<$0.01';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(v) {
  return Number.isFinite(v) ? v.toLocaleString() : 'n/a';
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
}

// The rows every rendering (text/markdown/html) shares, derived once.
export function reportModel(payload, payloads = null) {
  const s = payload.summary;
  const meta = payload.meta;
  const surv = payload.lineSurvival;

  const agents = [];
  // Per-agent one-liners when the run computed per-agent views.
  if (payloads?.claude && payloads.codex) {
    for (const [key, label] of [['claude', 'Claude Code'], ['codex', 'OpenAI Codex']]) {
      const p = payloads[key];
      agents.push({
        label,
        cost: p.summary.totalCost,
        commits: p.summary.totalCommits,
        costPerCommit: p.summary.avgCostPerCommit,
        survivalRate: p.lineSurvival.survivalRate,
        grade: p.summary.overallGrade,
      });
    }
  }

  // Top model families by cost that shipped commits — the "which model is
  // worth it" table.
  const models = Object.entries(payload.modelBreakdown || {})
    .filter(([, d]) => d.cost > 0)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, 5)
    .map(([family, d]) => ({
      family: family.charAt(0).toUpperCase() + family.slice(1),
      cost: d.cost,
      commits: d.commits,
      costPerCommit: d.avgCostPerCommit,
    }));

  const rec = s.reconciliation;
  const isRange = !!(meta.since && meta.until);
  const source = meta.source || 'all';
  // "(30 days)" / "(30 days, claude only)" / "" / "(claude only)" — the range
  // itself is already spelled out in `window` below, so "(30 days)" would be
  // redundant noise once --since/--until is active.
  const windowExtra = [!isRange ? `${meta.daysAnalyzed} days` : null, source !== 'all' ? `${source} only` : null]
    .filter(Boolean).join(', ');
  return {
    generatedAt: meta.generatedAt,
    window: `${fmtDate(meta.startDate)} – ${fmtDate(meta.endDate)}`,
    windowExtra: windowExtra ? ` (${windowExtra})` : '',
    days: meta.daysAnalyzed,
    source,
    grade: s.overallGrade,
    score: s.efficiencyScore?.score ?? null,
    verdict: s.efficiencyScore?.explanation || '',
    tip: s.efficiencyScore?.tip || '',
    totalCost: s.totalCost,
    pricingEstimatedPct: s.pricingEstimatedPct,
    plan: s.plan,
    sessions: s.totalSessions,
    commits: s.totalCommits,
    mainBranchPct: s.mainBranchPct,
    linesAdded: s.totalLinesAdded,
    netLines: s.totalNetLines,
    survivalRate: surv?.survivalRate ?? null,
    aiCodeSharePct: s.aiCodeSharePct,
    valueLeak: s.valueLeak,
    costPerCommit: s.avgCostPerCommit,
    attribution: rec ? {
      byConfidence: rec.commits.byConfidence,
      organic: rec.commits.organic,
      trailerMatched: rec.commits.trailerStamped?.matched ?? 0,
      trailerCrossAgent: rec.commits.trailerStamped?.crossAgent ?? 0,
      trailerOrganic: rec.commits.trailerStamped?.organic ?? 0,
    } : null,
    agents,
    models,
    insights: (payload.insights || []).slice(0, 3),
  };
}

export function renderReportText(model) {
  const gc = GRADE_COLOR[model.grade] || c.reset;
  const L = [];
  const rule = c.dim + '─'.repeat(62) + c.reset;
  const label = (t) => `${c.dim}${t.padEnd(22)}${c.reset}`;

  L.push('');
  L.push(`  ${c.bold}${c.cyan}AI coding ROI report${c.reset} ${c.dim}· ${model.window}${model.windowExtra}${c.reset}`);
  L.push(`  ${rule}`);
  L.push(`  ${gc}${c.bold}Grade ${model.grade}${c.reset}${model.score !== null ? `${c.dim} · efficiency ${model.score}/100${c.reset}` : ''}`);
  if (model.verdict) L.push(`  ${c.dim}${model.verdict}${c.reset}`);
  L.push(`  ${rule}`);
  L.push(`  ${label('Spend (API-equiv)')}${c.orange}${fmtMoney(model.totalCost)}${c.reset}${model.pricingEstimatedPct > 0 ? ` ${c.dim}(~${model.pricingEstimatedPct}% estimated)${c.reset}` : ''}`);
  if (model.plan) {
    L.push(`  ${label(`Plan (${model.plan.name})`)}${fmtMoney(model.plan.windowCost)} ${c.dim}for this window${c.reset}`);
    if (model.plan.utilizationRatio !== null) {
      const ur = model.plan.utilizationRatio;
      const urc = ur >= 1 ? c.green : c.yellow;
      L.push(`  ${label('Plan utilization')}${urc}${ur}x${c.reset} ${c.dim}API-equivalent value vs flat fee${c.reset}`);
    }
  }
  L.push(`  ${label('Sessions')}${fmtInt(model.sessions)}`);
  L.push(`  ${label('Commits shipped')}${fmtInt(model.commits)}${model.commits > 0 ? ` ${c.dim}(${model.mainBranchPct}% on default branch)${c.reset}` : ''}`);
  L.push(`  ${label('Lines added')}${fmtInt(model.linesAdded)} ${c.dim}(net ${fmtInt(model.netLines)})${c.reset}`);
  L.push(`  ${label('Cost per commit')}${fmtMoney(model.costPerCommit)}${model.plan?.effectiveCostPerCommit != null ? ` ${c.dim}(effective ${fmtMoney(model.plan.effectiveCostPerCommit)} on plan)${c.reset}` : ''}`);
  if (model.survivalRate !== null) L.push(`  ${label('Line survival (24h)')}${model.survivalRate}%`);
  if (model.aiCodeSharePct !== null) L.push(`  ${label('AI code share')}${model.aiCodeSharePct}% ${c.dim}of merged lines this window${c.reset}`);
  if (model.valueLeak) {
    const vlc = model.valueLeak.pct >= 40 ? c.red : model.valueLeak.pct >= 15 ? c.yellow : c.green;
    L.push(`  ${label('Value leak')}${vlc}${fmtMoney(model.valueLeak.cost)} (${model.valueLeak.pct}%)${c.reset} ${c.dim}spend with no committed code${c.reset}`);
  }

  if (model.agents.length > 0) {
    L.push(`  ${rule}`);
    L.push(`  ${c.bold}Agents${c.reset}`);
    for (const a of model.agents) {
      L.push(`  ${label(a.label)}${fmtMoney(a.cost)} ${c.dim}·${c.reset} ${fmtInt(a.commits)} commits ${c.dim}·${c.reset} ${fmtMoney(a.costPerCommit)}/commit ${GRADE_COLOR[a.grade] || ''}${a.grade}${c.reset}`);
    }
  }

  if (model.models.length > 0) {
    L.push(`  ${rule}`);
    L.push(`  ${c.bold}Models${c.reset}`);
    for (const m of model.models) {
      L.push(`  ${label(m.family)}${fmtMoney(m.cost)}${m.costPerCommit != null ? ` ${c.dim}·${c.reset} ${fmtMoney(m.costPerCommit)}/commit (${m.commits})` : ''}`);
    }
  }

  if (model.attribution) {
    const at = model.attribution;
    L.push(`  ${rule}`);
    L.push(`  ${c.bold}Attribution audit${c.reset}`);
    L.push(`  ${label('AI commits')}${fmtInt(model.commits)} ${c.dim}(${at.byConfidence.high} high / ${at.byConfidence.medium} medium / ${at.byConfidence.low} low confidence)${c.reset}`);
    L.push(`  ${label('Manual commits')}${fmtInt(at.organic - at.trailerOrganic)}`);
    if (at.trailerMatched > 0) L.push(`  ${label('Trailer-confirmed')}${fmtInt(at.trailerMatched)} ${c.dim}commits stamped Co-authored-by the matching agent${c.reset}`);
    if (at.trailerCrossAgent > 0) L.push(`  ${label('Trailer cross-agent')}${fmtInt(at.trailerCrossAgent)} ${c.dim}stamped by a different agent than the matched session${c.reset}`);
    if (at.trailerOrganic > 0) L.push(`  ${label('AI-stamped, no logs')}${fmtInt(at.trailerOrganic)} ${c.dim}co-authored commits with no session in this window${c.reset}`);
  }

  if (model.insights.length > 0) {
    L.push(`  ${rule}`);
    L.push(`  ${c.bold}Insights${c.reset}`);
    const mark = { warning: `${c.yellow}!${c.reset}`, success: `${c.green}+${c.reset}`, info: `${c.cyan}i${c.reset}`, tip: `${c.cyan}*${c.reset}` };
    for (const i of model.insights) {
      L.push(`  ${mark[i.type] || ' '} ${i.text}`);
    }
  }
  L.push('');
  return L.join('\n');
}

export function renderReportMarkdown(model) {
  const L = [];
  L.push('# AI coding ROI report');
  L.push('');
  L.push(`**${model.window}**${model.windowExtra} · generated by [codelens-ai](https://github.com/Akshat2634/Codelens-AI)`);
  L.push('');
  L.push(`## Grade: ${model.grade}${model.score !== null ? ` (${model.score}/100)` : ''}`);
  if (model.verdict) L.push(`> ${model.verdict}`);
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Spend (API-equivalent) | ${fmtMoney(model.totalCost)}${model.pricingEstimatedPct > 0 ? ` (~${model.pricingEstimatedPct}% estimated)` : ''} |`);
  if (model.plan) {
    L.push(`| Plan (${model.plan.name}) | ${fmtMoney(model.plan.windowCost)} for this window |`);
    if (model.plan.utilizationRatio !== null) L.push(`| Plan utilization | ${model.plan.utilizationRatio}x API-equivalent value vs flat fee |`);
  }
  L.push(`| Sessions | ${fmtInt(model.sessions)} |`);
  L.push(`| Commits shipped | ${fmtInt(model.commits)}${model.commits > 0 ? ` (${model.mainBranchPct}% on default branch)` : ''} |`);
  L.push(`| Lines added | ${fmtInt(model.linesAdded)} (net ${fmtInt(model.netLines)}) |`);
  L.push(`| Cost per commit | ${fmtMoney(model.costPerCommit)}${model.plan?.effectiveCostPerCommit != null ? ` (effective ${fmtMoney(model.plan.effectiveCostPerCommit)} on plan)` : ''} |`);
  if (model.survivalRate !== null) L.push(`| Line survival (24h) | ${model.survivalRate}% |`);
  if (model.aiCodeSharePct !== null) L.push(`| AI code share | ${model.aiCodeSharePct}% of merged lines |`);
  if (model.valueLeak) L.push(`| Value leak | ${fmtMoney(model.valueLeak.cost)} (${model.valueLeak.pct}%) spend with no committed code |`);
  L.push('');

  if (model.agents.length > 0) {
    L.push('## Agents');
    L.push('');
    L.push('| Agent | Spend | Commits | $/commit | Grade |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const a of model.agents) {
      L.push(`| ${a.label} | ${fmtMoney(a.cost)} | ${fmtInt(a.commits)} | ${fmtMoney(a.costPerCommit)} | ${a.grade} |`);
    }
    L.push('');
  }

  if (model.models.length > 0) {
    L.push('## Models');
    L.push('');
    L.push('| Model family | Spend | $/commit | Commits |');
    L.push('| --- | --- | --- | --- |');
    for (const m of model.models) {
      L.push(`| ${m.family} | ${fmtMoney(m.cost)} | ${m.costPerCommit != null ? fmtMoney(m.costPerCommit) : 'n/a'} | ${fmtInt(m.commits)} |`);
    }
    L.push('');
  }

  if (model.attribution) {
    const at = model.attribution;
    L.push('## Attribution audit');
    L.push('');
    L.push(`- **${fmtInt(model.commits)} AI commits** — ${at.byConfidence.high} high / ${at.byConfidence.medium} medium / ${at.byConfidence.low} low confidence`);
    L.push(`- **${fmtInt(at.organic - at.trailerOrganic)} manual commits**`);
    if (at.trailerMatched > 0) L.push(`- ${fmtInt(at.trailerMatched)} commits confirmed by \`Co-authored-by\` agent trailers`);
    if (at.trailerCrossAgent > 0) L.push(`- ${fmtInt(at.trailerCrossAgent)} trailer-stamped commits were claimed by a different agent's session`);
    if (at.trailerOrganic > 0) L.push(`- ${fmtInt(at.trailerOrganic)} AI-stamped commits had no session logs in this window`);
    L.push('');
  }

  if (model.insights.length > 0) {
    L.push('## Insights');
    L.push('');
    for (const i of model.insights) L.push(`- ${i.text}`);
    L.push('');
  }
  L.push(`*Costs are API-equivalent estimates from published per-token pricing${model.plan ? '; plan figures prorate your flat subscription fee' : ''}. All data computed locally from agent session logs and git history.*`);
  L.push('');
  return L.join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderReportHtml(model) {
  const gradeColors = { A: '#2e9e4f', B: '#0e7490', C: '#b45309', D: '#b45309', F: '#b91c1c' };
  const gc = gradeColors[model.grade] || '#334155';
  const row = (k, v) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`;

  const rows = [];
  rows.push(row('Spend (API-equivalent)', `<strong>${fmtMoney(model.totalCost)}</strong>${model.pricingEstimatedPct > 0 ? ` <span class="dim">(~${model.pricingEstimatedPct}% estimated)</span>` : ''}`));
  if (model.plan) {
    rows.push(row(`Plan (${escapeHtml(model.plan.name)})`, `${fmtMoney(model.plan.windowCost)} <span class="dim">for this window</span>`));
    if (model.plan.utilizationRatio !== null) rows.push(row('Plan utilization', `<strong>${model.plan.utilizationRatio}x</strong> <span class="dim">API-equivalent value vs flat fee</span>`));
  }
  rows.push(row('Sessions', fmtInt(model.sessions)));
  rows.push(row('Commits shipped', `<strong>${fmtInt(model.commits)}</strong>${model.commits > 0 ? ` <span class="dim">(${model.mainBranchPct}% on default branch)</span>` : ''}`));
  rows.push(row('Lines added', `${fmtInt(model.linesAdded)} <span class="dim">(net ${fmtInt(model.netLines)})</span>`));
  rows.push(row('Cost per commit', `<strong>${fmtMoney(model.costPerCommit)}</strong>${model.plan?.effectiveCostPerCommit != null ? ` <span class="dim">(effective ${fmtMoney(model.plan.effectiveCostPerCommit)} on plan)</span>` : ''}`));
  if (model.survivalRate !== null) rows.push(row('Line survival (24h)', `${model.survivalRate}%`));
  if (model.aiCodeSharePct !== null) rows.push(row('AI code share', `<strong>${model.aiCodeSharePct}%</strong> <span class="dim">of merged lines this window</span>`));
  if (model.valueLeak) rows.push(row('Value leak', `${fmtMoney(model.valueLeak.cost)} (${model.valueLeak.pct}%) <span class="dim">spend with no committed code</span>`));

  const agentRows = model.agents.map(a =>
    `<tr><td>${escapeHtml(a.label)}</td><td>${fmtMoney(a.cost)}</td><td>${fmtInt(a.commits)}</td><td>${fmtMoney(a.costPerCommit)}</td><td><span class="grade" style="background:${gradeColors[a.grade] || '#334155'}">${escapeHtml(a.grade)}</span></td></tr>`
  ).join('\n');
  const modelRows = model.models.map(m =>
    `<tr><td>${escapeHtml(m.family)}</td><td>${fmtMoney(m.cost)}</td><td>${m.costPerCommit != null ? fmtMoney(m.costPerCommit) : 'n/a'}</td><td>${fmtInt(m.commits)}</td></tr>`
  ).join('\n');

  const at = model.attribution;
  const attribution = at ? `
  <h2>Attribution audit</h2>
  <ul>
    <li><strong>${fmtInt(model.commits)} AI commits</strong> — ${at.byConfidence.high} high / ${at.byConfidence.medium} medium / ${at.byConfidence.low} low confidence</li>
    <li><strong>${fmtInt(at.organic - at.trailerOrganic)} manual commits</strong></li>
    ${at.trailerMatched > 0 ? `<li>${fmtInt(at.trailerMatched)} commits confirmed by <code>Co-authored-by</code> agent trailers</li>` : ''}
    ${at.trailerCrossAgent > 0 ? `<li>${fmtInt(at.trailerCrossAgent)} trailer-stamped commits were claimed by a different agent's session</li>` : ''}
    ${at.trailerOrganic > 0 ? `<li>${fmtInt(at.trailerOrganic)} AI-stamped commits had no session logs in this window</li>` : ''}
  </ul>` : '';

  const insights = model.insights.length > 0
    ? `<h2>Insights</h2>\n<ul>\n${model.insights.map(i => `<li>${escapeHtml(i.text)}</li>`).join('\n')}\n</ul>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI coding ROI report — ${escapeHtml(model.window)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1c1917; background: #faf9f7; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.05rem; margin-top: 28px; }
  .meta { color: #78716c; font-size: 0.85rem; margin-bottom: 20px; }
  .grade-banner { display: inline-block; padding: 8px 18px; border-radius: 10px; color: #fff; font-weight: 700; font-size: 1.3rem; background: ${gc}; }
  .verdict { color: #57534e; margin: 10px 0 22px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e7e5e4; font-size: 0.92rem; }
  td:first-child { color: #78716c; width: 42%; }
  th { color: #78716c; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .dim { color: #a8a29e; }
  .grade { color: #fff; padding: 1px 8px; border-radius: 6px; font-weight: 700; }
  .footer { margin-top: 34px; color: #a8a29e; font-size: 0.78rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e7e5e4; background: #17161a; }
    td, th { border-color: #33313a; }
    .verdict { color: #a8a29e; }
  }
</style>
</head>
<body>
  <h1>AI coding ROI report</h1>
  <div class="meta">${escapeHtml(model.window)}${escapeHtml(model.windowExtra)} · generated by codelens-ai</div>
  <div class="grade-banner">Grade ${escapeHtml(model.grade)}${model.score !== null ? ` · ${model.score}/100` : ''}</div>
  ${model.verdict ? `<p class="verdict">${escapeHtml(model.verdict)}</p>` : ''}
  <table>${rows.join('\n')}</table>
  ${model.agents.length > 0 ? `<h2>Agents</h2>\n<table><tr><th>Agent</th><th>Spend</th><th>Commits</th><th>$/commit</th><th>Grade</th></tr>\n${agentRows}</table>` : ''}
  ${model.models.length > 0 ? `<h2>Models</h2>\n<table><tr><th>Model family</th><th>Spend</th><th>$/commit</th><th>Commits</th></tr>\n${modelRows}</table>` : ''}
  ${attribution}
  ${insights}
  <div class="footer">Costs are API-equivalent estimates from published per-token pricing${model.plan ? '; plan figures prorate your flat subscription fee' : ''}. All data computed locally from agent session logs and git history — nothing leaves your machine.</div>
</body>
</html>
`;
}
