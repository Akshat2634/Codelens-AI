// 5-hour billing blocks + burn rate — `codelens-ai blocks`.
//
// Claude bills usage in rolling 5-hour windows: the window opens with your first
// message and lasts exactly 5 hours. This groups every session's per-event usage
// timeline (session.usageEvents, epoch-ms timestamps) into those windows so you
// can see per-block spend, your current burn rate, and — for the open block — a
// linear projection of where it lands. Mirrors ccusage's blocks algorithm
// (floor the block start to the UTC hour; a new block begins after 5h from the
// start OR a 5h idle gap), on top of Codelens's version-aware per-event cost.
//
// Pure functions over the metrics payload's sessions; no parsing or git here.

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_HOURS = 5;

// Block start is floored to the top of the hour in UTC — the billing window
// aligns to clock hours, so two sessions an hour apart share one block.
function floorToHourUtc(ms) {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

// Burn rate over a block's ACTUAL active span (first→last event). The HIGH/
// NORMAL indicator deliberately excludes cache tokens (input+output only) so
// thresholds stay comparable to pre-cache behavior, matching ccusage; the raw
// tokens/min counts every class. Null when the span is zero (a single event).
function burnRateOf(block) {
  const durationMinutes = (block.actualEndTime - block.firstTs) / 60000;
  if (!(durationMinutes > 0)) return null;
  const t = block.tokens;
  return {
    durationMinutes,
    tokensPerMinute: block.totalTokens / durationMinutes,
    tokensPerMinuteIndicator: (t.input + t.output) / durationMinutes,
    costPerHour: (block.cost / durationMinutes) * 60,
  };
}

// Linear extrapolation of the open block to the end of its 5h window.
function projectBlock(block, nowMs) {
  const remainingMinutes = Math.max(0, (block.endTime - nowMs) / 60000);
  const rate = block.burnRate;
  if (!rate) return { remainingMinutes, projectedTotalTokens: block.totalTokens, projectedTotalCost: block.cost };
  return {
    remainingMinutes,
    projectedTotalTokens: Math.round(block.totalTokens + rate.tokensPerMinute * remainingMinutes),
    projectedTotalCost: block.cost + (rate.costPerHour / 60) * remainingMinutes,
  };
}

// Group every session's usageEvents into 5-hour billing blocks.
//   sessions:     correlated/parsed sessions (each with .usageEvents)
//   sessionHours: window length (default 5; --session-length overrides)
//   nowMs:        clock for active-block detection (injectable for tests)
//   tokenLimit:   number, or 'max' to use the largest prior block as the ceiling
export function buildBlocks(sessions, { sessionHours = DEFAULT_SESSION_HOURS, nowMs = Date.now(), tokenLimit = null } = {}) {
  const durationMs = sessionHours * HOUR_MS;

  const events = [];
  for (const s of sessions || []) {
    for (const e of s.usageEvents || []) {
      if (Number.isFinite(e.ts)) events.push(e);
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const blocks = [];
  let cur = null;
  const open = (startMs) => {
    cur = {
      id: new Date(startMs).toISOString(),
      isGap: false,
      startTime: startMs,
      endTime: startMs + durationMs,
      firstTs: null,
      actualEndTime: null,
      tokens: emptyTokens(),
      totalTokens: 0,
      cost: 0,
      events: 0,
    };
    blocks.push(cur);
  };

  for (const e of events) {
    if (cur === null) {
      open(floorToHourUtc(e.ts));
    } else if (e.ts - cur.startTime > durationMs || e.ts - cur.actualEndTime > durationMs) {
      // Window elapsed or a 5h+ idle gap: close this block. Represent a long
      // idle span as a zero-token gap block so the timeline reads honestly.
      const gapStart = cur.actualEndTime;
      if (e.ts - gapStart > durationMs) {
        blocks.push({
          id: `gap-${new Date(gapStart).toISOString()}`,
          isGap: true,
          startTime: gapStart,
          endTime: e.ts,
          firstTs: gapStart,
          actualEndTime: e.ts,
          tokens: emptyTokens(),
          totalTokens: 0,
          cost: 0,
          events: 0,
        });
      }
      open(floorToHourUtc(e.ts));
    }
    if (cur.firstTs === null) cur.firstTs = e.ts;
    cur.actualEndTime = e.ts;
    cur.tokens.input += e.input || 0;
    cur.tokens.output += e.output || 0;
    cur.tokens.cacheRead += e.cacheRead || 0;
    cur.tokens.cacheCreate += e.cacheCreate || 0;
    cur.totalTokens += (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheCreate || 0);
    cur.cost += e.cost || 0;
    cur.events++;
  }

  // First pass: active flag + burn rate for every real block.
  for (const b of blocks) {
    if (b.isGap) { b.isActive = false; continue; }
    // Open block: last activity within one window AND the 5h window hasn't elapsed.
    b.isActive = (nowMs - b.actualEndTime) < durationMs && nowMs < b.endTime;
    b.burnRate = burnRateOf(b);
  }

  // `--token-limit max` uses the largest PRIOR block (excludes the open one) as
  // the ceiling, so a fresh active block doesn't read as 100% against itself.
  const maxPriorTokens = blocks.reduce((m, b) => (!b.isGap && !b.isActive ? Math.max(m, b.totalTokens) : m), 0);
  const limit = tokenLimit === 'max' ? maxPriorTokens : (Number.isFinite(tokenLimit) ? tokenLimit : null);

  // Second pass: projection + limit gauge for the open block.
  for (const b of blocks) {
    if (!b.isActive) continue;
    b.projection = projectBlock(b, nowMs);
    if (limit != null && limit > 0) {
      b.limit = limit;
      b.percentOfLimit = Math.round((b.totalTokens / limit) * 100);
      b.projectedPercentOfLimit = Math.round((b.projection.projectedTotalTokens / limit) * 100);
    }
  }

  const activeBlock = blocks.find((b) => b.isActive) || null;
  return { sessionHours, nowMs, blocks, activeBlock, limit };
}

// Keep only blocks with activity in the last `days` days (ccusage's --recent
// defaults to 3). Gap blocks are dropped from the recent view.
export function filterRecentBlocks(result, days = 3) {
  const cutoff = result.nowMs - days * 24 * HOUR_MS;
  return { ...result, blocks: result.blocks.filter((b) => !b.isGap && b.actualEndTime >= cutoff) };
}

// ── rendering ──

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
  orange: '\x1b[38;5;208m',
};

const fmtInt = (n) => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
const fmtMoney = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.005) return '<$0.01';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtTokens = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
function fmtClock(ms) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDuration(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return '0m';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
// tokens/min thresholds mirror ccusage's statusline indicator (input+output).
function burnLabel(rate) {
  if (!rate) return { text: '—', color: c.dim };
  const tpm = rate.tokensPerMinuteIndicator;
  if (tpm > 5000) return { text: 'HIGH', color: c.red };
  if (tpm > 2000) return { text: 'MODERATE', color: c.yellow };
  return { text: 'NORMAL', color: c.green };
}

// Detailed single-block view — used for `--active` and as the header of a full
// listing's open block.
function renderActiveBlock(b, k) {
  const L = [];
  const rate = b.burnRate;
  const proj = b.projection;
  L.push(`  ${k.bold}${k.green}● Active block${k.reset} ${k.dim}${fmtClock(b.startTime)} → ${fmtClock(b.endTime)}${k.reset}`);
  const remaining = proj ? fmtDuration(proj.remainingMinutes) : '—';
  L.push(`  ${k.dim}${'Time left in window'.padEnd(24)}${k.reset}${remaining}`);
  L.push(`  ${k.dim}${'Spent so far'.padEnd(24)}${k.reset}${k.orange}${fmtMoney(b.cost)}${k.reset} ${k.dim}·${k.reset} ${fmtInt(b.totalTokens)} tokens`);
  if (rate) {
    const bl = burnLabel(rate);
    L.push(`  ${k.dim}${'Burn rate'.padEnd(24)}${k.reset}${fmtInt(rate.tokensPerMinute)} tok/min ${k.dim}·${k.reset} ${k.orange}${fmtMoney(rate.costPerHour)}/hr${k.reset} ${bl.color}${bl.text}${k.reset}`);
  }
  if (proj) {
    L.push(`  ${k.dim}${'Projected end-of-block'.padEnd(24)}${k.reset}${k.orange}${fmtMoney(proj.projectedTotalCost)}${k.reset} ${k.dim}·${k.reset} ${fmtInt(proj.projectedTotalTokens)} tokens`);
  }
  if (b.limit) {
    const pc = b.projectedPercentOfLimit;
    const col = pc >= 100 ? k.red : pc >= 80 ? k.yellow : k.green;
    L.push(`  ${k.dim}${'Token limit'.padEnd(24)}${k.reset}${col}${b.percentOfLimit}% used${k.reset} ${k.dim}·${k.reset} projected ${col}${pc}%${k.reset} ${k.dim}of ${fmtInt(b.limit)}${k.reset}`);
  }
  return L.join('\n');
}

export function renderBlocksText(result, { active = false, color = true } = {}) {
  const k = color ? c : new Proxy({}, { get: () => '' });

  if (active) {
    if (!result.activeBlock) return `\n  ${k.dim}No active 5-hour block — no usage in the current window.${k.reset}\n`;
    return '\n' + renderActiveBlock(result.activeBlock, k) + '\n';
  }

  const blocks = result.blocks.filter((b) => !b.isGap);
  if (blocks.length === 0) return `\n  ${k.dim}No usage blocks in this window.${k.reset}\n`;

  const cols = [
    { h: 'Window (start → end)', align: 'left' },
    { h: 'Dur', align: 'right' },
    { h: 'Tokens', align: 'right' },
    { h: 'Tok/min', align: 'right' },
    { h: 'Cost', align: 'right' },
    { h: 'Burn', align: 'left' },
  ];
  const rowOf = (b) => {
    const rate = b.burnRate;
    const bl = burnLabel(rate);
    const label = `${fmtClock(b.startTime)} → ${fmtClock(b.endTime)}${b.isActive ? '  ●' : ''}`;
    return {
      cells: [
        label,
        fmtDuration(b.burnRate ? b.burnRate.durationMinutes : 0),
        fmtTokens(b.totalTokens),
        rate ? fmtInt(rate.tokensPerMinute) : '—',
        fmtMoney(b.cost),
        bl.text,
      ],
      active: b.isActive,
      burnColor: bl.color,
    };
  };
  const dataRows = blocks.map(rowOf);
  const widths = cols.map((col, i) => Math.max(col.h.length, ...dataRows.map((r) => r.cells[i].length)));
  const pad = (s, i) => cols[i].align === 'right' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const rule = k.dim + widths.map((w) => '─'.repeat(w)).join('─┼─') + k.reset;

  const L = [];
  L.push('  ' + cols.map((col, i) => k.bold + pad(col.h, i) + k.reset).join(k.dim + ' │ ' + k.reset));
  L.push('  ' + rule);
  for (const r of dataRows) {
    const cells = r.cells.map((cell, i) => {
      let s = pad(cell, i);
      if (i === 4) s = k.orange + s + k.reset;           // Cost
      else if (i === 5) s = r.burnColor + s + k.reset;   // Burn label
      else if (r.active) s = k.bold + s + k.reset;
      return s;
    });
    L.push('  ' + cells.join(k.dim + ' │ ' + k.reset));
  }
  if (result.activeBlock) {
    L.push('');
    L.push(renderActiveBlock(result.activeBlock, k));
  }
  return L.join('\n');
}

// JSON export — all fields always present; matches ccusage's blocks JSON shape
// (burnRate / projectedTotal* on the active block) plus Codelens's cost fields.
export function blocksJson(result, meta = {}) {
  const blockJson = (b) => ({
    id: b.id,
    isGap: b.isGap,
    isActive: !!b.isActive,
    startTime: new Date(b.startTime).toISOString(),
    endTime: new Date(b.endTime).toISOString(),
    actualEndTime: b.actualEndTime ? new Date(b.actualEndTime).toISOString() : null,
    tokenCounts: b.tokens,
    totalTokens: b.totalTokens,
    cost: Math.round(b.cost * 10000) / 10000,
    events: b.events,
    burnRate: b.burnRate ? {
      tokensPerMinute: Math.round(b.burnRate.tokensPerMinute),
      tokensPerMinuteIndicator: Math.round(b.burnRate.tokensPerMinuteIndicator),
      costPerHour: Math.round(b.burnRate.costPerHour * 10000) / 10000,
    } : null,
    projection: b.projection ? {
      remainingMinutes: Math.round(b.projection.remainingMinutes),
      projectedTotalTokens: b.projection.projectedTotalTokens,
      projectedTotalCost: Math.round(b.projection.projectedTotalCost * 10000) / 10000,
    } : null,
    ...(b.limit ? { tokenLimit: b.limit, percentOfLimit: b.percentOfLimit, projectedPercentOfLimit: b.projectedPercentOfLimit } : {}),
  });
  return {
    report: 'blocks',
    sessionHours: result.sessionHours,
    ...meta,
    blocks: result.blocks.map(blockJson),
    activeBlock: result.activeBlock ? blockJson(result.activeBlock) : null,
  };
}
