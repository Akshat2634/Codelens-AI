// ccusage-style usage tables: `codelens-ai daily|weekly|monthly` aggregate
// each session's dailyUsage (per-day token classes + per-model splits, already
// priced per-day by the parsers) into period rows — plus the ROI columns
// (commits, $/commit) that a pure token accounting tool can't provide.
// Pure functions over the metrics payload's sessions; no parsing or git here.

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m',
};

const DAY_MS = 24 * 3600 * 1000;

// Local calendar day, matching the parsers' localDayStr / metrics' toDateStr —
// tables must bucket the same way or their totals drift from the dashboard's.
function toDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Week-start date (YYYY-MM-DD) containing the given day. Noon-anchored so DST
// transitions can't step over or repeat a date.
function weekStartOf(dateStr, startOfWeek) {
  const t = Date.parse(dateStr + 'T12:00:00');
  const dow = new Date(t).getDay(); // 0 = Sunday
  const startDow = startOfWeek === 'sunday' ? 0 : 1;
  const back = (dow - startDow + 7) % 7;
  return toDateStr(t - back * DAY_MS);
}

function periodKeyFn(period, startOfWeek) {
  if (period === 'monthly') return (dateStr) => dateStr.slice(0, 7);
  if (period === 'weekly') return (dateStr) => weekStartOf(dateStr, startOfWeek);
  return (dateStr) => dateStr;
}

function emptyRow(key) {
  return {
    period: key,
    inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: 0, cost: 0,
    sessions: 0, commits: 0, costPerCommit: null,
    models: [], byModel: {},
  };
}

// Aggregate correlated sessions into period rows.
//   period: 'daily' | 'weekly' | 'monthly'
//   startOfWeek: 'monday' (default) | 'sunday' — weekly only
//   cutoffMs: lookback start; clamps the fallback day for sessions without
//             per-day usage data so they can't create pre-window rows.
export function buildPeriodTable(sessions, { period = 'daily', startOfWeek = 'monday', cutoffMs = 0 } = {}) {
  const keyOf = periodKeyFn(period, startOfWeek);
  const rows = new Map();
  const ensure = (key) => {
    if (!rows.has(key)) rows.set(key, emptyRow(key));
    return rows.get(key);
  };

  for (const session of sessions) {
    // Same fallback rule as the metrics daily timeline: a session without
    // per-day data lands whole on its (window-clamped) start day.
    const startDate = toDateStr(Math.max(new Date(session.startTime).getTime(), cutoffMs));
    const usage = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? session.dailyUsage
      : {
          [startDate]: {
            inputTokens: session.totalInputTokens || 0,
            outputTokens: session.totalOutputTokens || 0,
            cacheReadTokens: session.cacheReadTokens || 0,
            cacheCreationTokens: session.cacheCreationTokens || 0,
            cost: session.cost?.totalCost || 0,
            byModel: session.modelBreakdown,
          },
        };

    for (const [date, day] of Object.entries(usage)) {
      const row = ensure(keyOf(date));
      row.inputTokens += day.inputTokens || 0;
      row.outputTokens += day.outputTokens || 0;
      row.cacheReadTokens += day.cacheReadTokens || 0;
      row.cacheCreationTokens += day.cacheCreationTokens || 0;
      row.cost += day.cost || 0;
      for (const [model, v] of Object.entries(day.byModel || {})) {
        if (!row.byModel[model]) row.byModel[model] = { tokens: 0, cost: 0 };
        row.byModel[model].tokens += v.tokens || 0;
        row.byModel[model].cost += v.cost || 0;
      }
    }

    // One session, counted once — on its first in-window activity day — so
    // sum(rows.sessions) equals the summary's session count.
    const firstDay = session.dailyUsage && Object.keys(session.dailyUsage).length > 0
      ? Object.keys(session.dailyUsage).sort()[0]
      : startDate;
    ensure(keyOf(firstDay)).sessions++;

    for (const commit of session.commits || []) {
      ensure(keyOf(toDateStr(commit.timestamp))).commits++;
    }
  }

  const sorted = [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
  const totals = emptyRow('total');
  for (const row of sorted) {
    row.totalTokens = row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
    row.costPerCommit = row.commits > 0 ? row.cost / row.commits : null;
    row.models = Object.entries(row.byModel).sort(([, a], [, b]) => b.cost - a.cost).map(([m]) => m);
    for (const k of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'cost', 'sessions', 'commits']) {
      totals[k] += row[k];
    }
    for (const [model, v] of Object.entries(row.byModel)) {
      if (!totals.byModel[model]) totals.byModel[model] = { tokens: 0, cost: 0 };
      totals.byModel[model].tokens += v.tokens;
      totals.byModel[model].cost += v.cost;
    }
  }
  totals.costPerCommit = totals.commits > 0 ? totals.cost / totals.commits : null;
  totals.models = Object.entries(totals.byModel).sort(([, a], [, b]) => b.cost - a.cost).map(([m]) => m);

  return { period, startOfWeek: period === 'weekly' ? startOfWeek : undefined, rows: sorted, totals };
}

// ── rendering ──

// 'claude-opus-4-8-20250601' → 'opus-4-8'; pricing markers ([fast], [us],
// [long]) are billing-relevant, keep them visible.
export function shortModel(name) {
  return String(name)
    .replace(/^claude-/, '')
    .replace(/-\d{8}(?=\[|$)/, '');
}

const fmtInt = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
const fmtMoney = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.005) return '<$0.01';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function modelsCell(models, max = 2) {
  const short = models.map(shortModel);
  if (short.length <= max) return short.join(', ');
  return `${short.slice(0, max).join(', ')} +${short.length - max}`;
}

// Fixed-width text table. Sub-rows (per-model, --breakdown) only carry total
// tokens + cost: the per-day per-model split is tracked as {tokens, cost}, not
// by token class, so the class columns stay blank rather than fake a split.
export function renderPeriodTableText(table, { breakdown = false, color = true } = {}) {
  const k = color ? c : new Proxy({}, { get: () => '' });
  const periodHeader = { daily: 'Date', weekly: 'Week of', monthly: 'Month' }[table.period] || 'Period';

  const cols = [
    { h: periodHeader, align: 'left' },
    { h: 'Models', align: 'left' },
    { h: 'Input', align: 'right' },
    { h: 'Output', align: 'right' },
    { h: 'Cache Cr', align: 'right' },
    { h: 'Cache Rd', align: 'right' },
    { h: 'Total', align: 'right' },
    { h: 'Cost', align: 'right' },
    { h: 'Commits', align: 'right' },
    { h: '$/Commit', align: 'right' },
  ];

  const dataLines = []; // { cells, kind: 'row' | 'sub' | 'total' }
  const rowCells = (r) => [
    r.period, modelsCell(r.models),
    fmtInt(r.inputTokens), fmtInt(r.outputTokens),
    fmtInt(r.cacheCreationTokens), fmtInt(r.cacheReadTokens),
    fmtInt(r.totalTokens), fmtMoney(r.cost),
    r.commits > 0 ? fmtInt(r.commits) : '—', fmtMoney(r.costPerCommit),
  ];
  for (const r of table.rows) {
    dataLines.push({ cells: rowCells(r), kind: 'row' });
    if (breakdown) {
      for (const [model, v] of Object.entries(r.byModel).sort(([, a], [, b]) => b.cost - a.cost)) {
        dataLines.push({
          cells: ['', `└ ${shortModel(model)}`, '', '', '', '', fmtInt(v.tokens), fmtMoney(v.cost), '', ''],
          kind: 'sub',
        });
      }
    }
  }
  dataLines.push({ cells: rowCells({ ...table.totals, period: 'Total' }), kind: 'total' });

  const widths = cols.map((col, i) => Math.max(col.h.length, ...dataLines.map(l => l.cells[i].length)));
  const pad = (s, i) => cols[i].align === 'right' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const rule = k.dim + widths.map(w => '─'.repeat(w)).join('─┼─').replace(/┼/g, '┼') + k.reset;

  const L = [];
  L.push('  ' + cols.map((col, i) => k.bold + pad(col.h, i) + k.reset).join(k.dim + ' │ ' + k.reset));
  L.push('  ' + rule);
  for (const line of dataLines) {
    if (line.kind === 'total') L.push('  ' + rule);
    const cells = line.cells.map((cell, i) => {
      let painted = pad(cell, i);
      if (line.kind === 'sub') painted = k.dim + painted + k.reset;
      else if (i === 7) painted = k.orange + painted + k.reset;          // Cost
      else if (i === 9 && cell !== '—') painted = k.cyan + painted + k.reset; // $/Commit
      else if (line.kind === 'total') painted = k.bold + painted + k.reset;
      return painted;
    });
    L.push('  ' + cells.join(k.dim + ' │ ' + k.reset));
  }
  return L.join('\n');
}

// JSON export: every field always present (0 / null when N/A) so consumers
// never need existence checks — same convention ccusage established.
export function periodTableJson(table, meta = {}) {
  const rowJson = (r) => ({
    period: r.period,
    models: r.models,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cacheReadTokens: r.cacheReadTokens,
    totalTokens: r.totalTokens,
    cost: Math.round(r.cost * 10000) / 10000,
    sessions: r.sessions,
    commits: r.commits,
    costPerCommit: r.costPerCommit !== null ? Math.round(r.costPerCommit * 10000) / 10000 : null,
    modelBreakdown: Object.fromEntries(Object.entries(r.byModel).map(([m, v]) => [m, {
      tokens: v.tokens, cost: Math.round(v.cost * 10000) / 10000,
    }])),
  });
  return {
    report: table.period,
    ...(table.startOfWeek ? { startOfWeek: table.startOfWeek } : {}),
    ...meta,
    rows: table.rows.map(rowJson),
    totals: rowJson(table.totals),
  };
}
