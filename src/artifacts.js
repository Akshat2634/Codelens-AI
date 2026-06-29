import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Generates shareable, self-contained artifacts from a computed payload — with NO
// network, daemon, or SMTP. Two outputs:
//   • a weekly digest HTML page (open it, or wire it into your own cron)
//   • an embeddable, survival-led SVG badge (+ copy-paste Markdown) for a README
// Both lead with durability/output-per-dollar rather than raw spend.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Plan-aware "spend this period" figure for headline use.
function spendLabel(summary) {
  const p = summary.pricing || { plan: 'api', apiEquivalentCost: summary.totalCost };
  if (p.plan === 'free') return `${Math.round((summary.totalInputTokens + summary.totalOutputTokens) / 1000)}K tokens`;
  if (p.isSubscription && p.proratedPlanCost != null) return `$${p.proratedPlanCost.toFixed(2)}`;
  return `$${(p.apiEquivalentCost ?? summary.totalCost).toFixed(2)}`;
}

const GRADE_COLOR = { A: '#22d3a8', B: '#3b82f6', C: '#f59e0b', D: '#f0883e', F: '#ef4444' };

export function buildBadgeSvg(payload) {
  const s = payload.summary;
  const ls = payload.lineSurvival || { surviving: 0, survivalRate: 0 };
  const grade = (s.efficiencyScore?.letter) || 'F';
  const gc = GRADE_COLOR[grade] || '#94a3b8';
  const streak = (payload.streaks?.longest) || 0;
  const cells = [
    { label: 'lines survived', value: ls.surviving.toLocaleString() },
    { label: 'survival', value: `${ls.survivalRate}%` },
    { label: 'spend', value: spendLabel(s) },
    { label: 'streak', value: `${streak}d` },
  ];
  const W = 540, H = 132, pad = 20, cellW = (W - pad * 2) / cells.length;
  const cellSvg = cells.map((c, i) => {
    const x = pad + i * cellW + cellW / 2;
    return `<text x="${x}" y="78" text-anchor="middle" font-size="22" font-weight="700" fill="#e8edf4">${esc(c.value)}</text>
    <text x="${x}" y="98" text-anchor="middle" font-size="11" fill="#8a94a6">${esc(c.label)}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Codelens AI coding ROI">
  <rect width="${W}" height="${H}" rx="14" fill="#0a0e17"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="#1f2937"/>
  <g font-family="ui-monospace,Menlo,monospace">
    <rect x="${pad}" y="18" width="4" height="20" rx="2" fill="#e67e22"/>
    <text x="${pad + 14}" y="34" font-size="15" font-weight="700" fill="#e8edf4">Codelens AI · AI coding ROI</text>
    <rect x="${W - pad - 34}" y="18" width="34" height="22" rx="6" fill="${gc}22" stroke="${gc}"/>
    <text x="${W - pad - 17}" y="34" text-anchor="middle" font-size="14" font-weight="800" fill="${gc}">${esc(grade)}</text>
    <line x1="${pad}" y1="48" x2="${W - pad}" y2="48" stroke="#1f2937"/>
    ${cellSvg}
    <text x="${pad}" y="120" font-size="10" fill="#5b6678">Durable lines that shipped, not just lines written · generated locally by codelens-ai</text>
  </g>
</svg>`;
}

export function buildBadgeMarkdown(svgRelPath) {
  return [
    `![Codelens AI — AI coding ROI](${svgRelPath})`,
    '',
    '<sub>Generated locally with [codelens-ai](https://www.npmjs.com/package/codelens-ai) — measures durable, shipped AI output, not raw lines.</sub>',
    '',
  ].join('\n');
}

export function buildDigestHtml(payload) {
  const s = payload.summary;
  const n = payload.weeklyNarrative;
  const q = payload.qualityOutcomes || {};
  const ls = payload.lineSurvival || { surviving: 0, survivalRate: 0 };
  const cc = payload.costControl || {};
  const grade = (s.efficiencyScore?.letter) || 'F';
  const gc = GRADE_COLOR[grade] || '#94a3b8';
  const generated = payload.meta?.generatedAt ? new Date(payload.meta.generatedAt).toLocaleString() : '';

  const metricRows = n?.metrics ? n.metrics.map(m => {
    const d = m.deltaPct;
    const better = m.direction === 'higher-better' ? (d > 0) : (d < 0);
    const chip = (d === null || d === undefined) ? ''
      : `<span style="color:${better ? '#22d3a8' : '#ef4444'};font-size:12px;">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
    return `<tr><td style="padding:6px 0;color:#8a94a6;">${esc(m.label)}</td><td style="padding:6px 0;text-align:right;font-weight:700;">${esc(m.value)} ${chip}</td></tr>`;
  }).join('') : '';

  // Cost waterfall: this week vs prior (from the weekly narrative).
  const tw = n ? n.thisWeek : null;
  const pw = n ? n.priorWeek : null;
  const maxCost = Math.max(tw ? tw.cost : 0, pw ? pw.cost : 0, 0.01);
  const waterfall = tw && pw ? `
    <div style="display:flex;gap:16px;align-items:flex-end;height:120px;margin-top:8px;">
      <div style="flex:1;text-align:center;">
        <div style="background:#3b82f6;border-radius:6px 6px 0 0;height:${Math.round((pw.cost / maxCost) * 90) + 4}px;"></div>
        <div style="font-size:11px;color:#8a94a6;margin-top:6px;">Last week<br>$${pw.cost.toFixed(2)}</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="background:#e67e22;border-radius:6px 6px 0 0;height:${Math.round((tw.cost / maxCost) * 90) + 4}px;"></div>
        <div style="font-size:11px;color:#8a94a6;margin-top:6px;">This week<br>$${tw.cost.toFixed(2)}</div>
      </div>
    </div>` : '<p style="color:#8a94a6;">Not enough history for a week-over-week comparison yet.</p>';

  const bullets = n?.bullets ? n.bullets.map(b => `<li style="margin:4px 0;">${esc(b)}</li>`).join('') : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codelens AI — Weekly Digest</title></head>
<body style="margin:0;background:#0a0e17;color:#e8edf4;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;">
<div style="max-width:680px;margin:0 auto;">
  <div style="display:flex;align-items:center;gap:10px;">
    <span style="width:5px;height:24px;background:#e67e22;border-radius:2px;display:inline-block;"></span>
    <h1 style="font-size:20px;margin:0;">Codelens AI — Weekly Digest</h1>
    <span style="margin-left:auto;background:${gc}22;border:1px solid ${gc};color:${gc};border-radius:8px;padding:3px 10px;font-weight:800;">${esc(grade)}</span>
  </div>
  <p style="color:#8a94a6;font-size:13px;margin:6px 0 24px;">${esc(generated)}</p>

  <p style="font-size:17px;line-height:1.5;margin:0 0 20px;">${n ? esc(n.headline) : 'No activity recorded this week.'}</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px;">
    <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;">
      <div style="color:#8a94a6;font-size:12px;text-transform:uppercase;">Surviving lines</div>
      <div style="font-size:24px;font-weight:800;color:#22d3a8;">${ls.surviving.toLocaleString()}</div>
      <div style="color:#8a94a6;font-size:12px;">${ls.survivalRate}% of added lines survived</div>
    </div>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;">
      <div style="color:#8a94a6;font-size:12px;text-transform:uppercase;">Spend this period</div>
      <div style="font-size:24px;font-weight:800;color:#e67e22;">${esc(spendLabel(s))}</div>
      <div style="color:#8a94a6;font-size:12px;">rework ${q.reworkRatePct ?? 0}% · cache ${cc.cacheHitRate ?? 0}%</div>
    </div>
  </div>

  <h2 style="font-size:14px;color:#8a94a6;text-transform:uppercase;letter-spacing:0.05em;">This week vs last</h2>
  <table style="width:100%;border-collapse:collapse;">${metricRows}</table>
  ${waterfall}

  ${bullets ? `<h2 style="font-size:14px;color:#8a94a6;text-transform:uppercase;letter-spacing:0.05em;margin-top:24px;">Highlights</h2><ul style="padding-left:18px;color:#c7cfdb;">${bullets}</ul>` : ''}

  <p style="color:#5b6678;font-size:12px;margin-top:32px;border-top:1px solid #1f2937;padding-top:16px;">
    Generated locally by codelens-ai — all data stays on your machine. Open this file or wire it into your own cron; Codelens adds no scheduler or telemetry.
  </p>
</div></body></html>`;
}

// Write digest + badge to disk. Returns the paths written.
export function writeArtifacts(payload, { digestPath, badgeDir } = {}) {
  const written = {};
  if (digestPath) {
    const out = path.resolve(digestPath);
    writeFileSync(out, buildDigestHtml(payload));
    written.digest = out;
  }
  if (badgeDir) {
    const svgOut = path.resolve(badgeDir, 'codelens-badge.svg');
    const mdOut = path.resolve(badgeDir, 'codelens-badge.md');
    writeFileSync(svgOut, buildBadgeSvg(payload));
    writeFileSync(mdOut, buildBadgeMarkdown('./codelens-badge.svg'));
    written.badgeSvg = svgOut;
    written.badgeMarkdown = mdOut;
  }
  return written;
}
