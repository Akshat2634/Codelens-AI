// Claude Code statusline integration.
//
// Claude Code invokes the configured command on every statusline refresh,
// piping session JSON to stdin (session_id, model, workspace, cost,
// context_window, rate_limits, ...). The first stdout line becomes the
// statusline. This runner must therefore be FAST and NEVER throw: it does no
// parsing or git work — it combines the stdin payload (session cost, official
// rate-limit percentages, context usage) with the quickstats file the main
// pipeline writes (today's spend, commits, $/commit, grade).
//
// What it shows that no other statusline can: today's cost-per-commit and ROI
// grade — spend correlated with shipped output, not just burn rate.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadQuickstats } from './cache.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m',
};

const GRADE_COLOR = { A: ANSI.green, B: ANSI.cyan, C: ANSI.yellow, D: ANSI.yellow, F: ANSI.red };

function pctColor(pct) {
  if (pct >= 80) return ANSI.red;
  if (pct >= 50) return ANSI.yellow;
  return ANSI.green;
}

function fmtMoney(v) {
  if (!Number.isFinite(v)) return null;
  if (v > 0 && v < 0.005) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

// "resets 1h23m" from an epoch-seconds timestamp; null when absent/past.
function fmtReset(resetsAtSec, nowMs) {
  if (!Number.isFinite(resetsAtSec)) return null;
  const deltaMin = Math.round((resetsAtSec * 1000 - nowMs) / 60000);
  if (deltaMin <= 0) return null;
  const h = Math.floor(deltaMin / 60);
  const m = deltaMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

function localDayStr(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Pure composer — testable without stdin. `input` is Claude Code's statusline
 * JSON (any subset of it), `quickstats` is the pipeline-written summary (or
 * null), `nowMs` anchors "today" and reset countdowns.
 */
export function composeStatusline(input, quickstats, nowMs = Date.now()) {
  const segments = [];
  const dim = (s) => `${ANSI.dim}${s}${ANSI.reset}`;

  // Session spend (from Claude Code itself — exact, not estimated).
  const sessionCost = fmtMoney(input?.cost?.total_cost_usd);
  if (sessionCost) {
    segments.push(`${ANSI.orange}${sessionCost}${ANSI.reset} ${dim('session')}`);
  }

  // Today's ROI from quickstats — only when generated today; yesterday's
  // commits under a "today" label would be misinformation.
  if (quickstats && quickstats.day === localDayStr(nowMs)) {
    const parts = [];
    const cost = fmtMoney(quickstats.todayCost);
    if (cost) parts.push(`${cost}`);
    if (Number.isFinite(quickstats.todayCommits) && quickstats.todayCommits > 0) {
      parts.push(`${quickstats.todayCommits} commit${quickstats.todayCommits === 1 ? '' : 's'}`);
      const perCommit = fmtMoney(quickstats.todayCost / quickstats.todayCommits);
      if (perCommit) parts.push(`${perCommit}/commit`);
    }
    if (parts.length > 0) {
      let seg = `${dim('today')} ${parts.join(dim(' · '))}`;
      if (quickstats.grade && GRADE_COLOR[quickstats.grade]) {
        seg += ` ${GRADE_COLOR[quickstats.grade]}${quickstats.grade}${ANSI.reset}`;
      }
      segments.push(seg);
    }
  }

  // Official rate limits — the numbers Anthropic's limiter actually enforces,
  // straight from Claude Code (not token-math estimates).
  const rl = input?.rate_limits;
  const rlParts = [];
  const fiveHour = rl?.five_hour?.used_percentage;
  if (Number.isFinite(fiveHour)) {
    let p = `${dim('5h')} ${pctColor(fiveHour)}${Math.round(fiveHour)}%${ANSI.reset}`;
    if (fiveHour >= 80) {
      const reset = fmtReset(rl.five_hour.resets_at, nowMs);
      if (reset) p += ` ${dim(`(resets ${reset})`)}`;
    }
    rlParts.push(p);
  }
  const sevenDay = rl?.seven_day?.used_percentage;
  if (Number.isFinite(sevenDay)) {
    rlParts.push(`${dim('wk')} ${pctColor(sevenDay)}${Math.round(sevenDay)}%${ANSI.reset}`);
  }
  if (rlParts.length > 0) segments.push(rlParts.join(' '));

  // Context window pressure.
  const ctx = input?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) {
    segments.push(`${dim('ctx')} ${pctColor(ctx)}${Math.round(ctx)}%${ANSI.reset}`);
  }

  if (segments.length === 0) {
    return `${ANSI.dim}codelens-ai · run the dashboard once to populate stats${ANSI.reset}`;
  }
  return segments.join(dim(' │ '));
}

function readStdin(stdin) {
  return new Promise((resolve) => {
    let data = '';
    const onData = (c) => { data += c; };
    // Every settle path must fully release stdin — merely resolving leaves a
    // flowing-mode stream ref'd on the event loop, and the process (invoked
    // by Claude Code every refresh) would hang forever if stdin stays open.
    const settle = () => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', settle);
      stdin.removeListener('error', settle);
      stdin.pause?.();
      stdin.unref?.();
      resolve(data);
    };
    // If nothing arrives quickly, resolve with what we have — the statusline
    // must never hang Claude Code's refresh loop.
    const timer = setTimeout(settle, 2000);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', settle);
    stdin.on('error', settle);
  });
}

/**
 * One-command setup: merge a statusLine entry into Claude Code's settings.
 * Refuses to clobber a different existing statusline unless `force` — and
 * backs the file up before any modification. Returns a status string for the
 * CLI to print; throws only on unreadable/unwritable settings.
 */
export function installStatusline({
  settingsPath = path.join(os.homedir(), '.claude', 'settings.json'),
  command = 'npx -y codelens-ai statusline',
  force = false,
} = {}) {
  let settings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error(`Could not parse ${settingsPath}: ${err.message}. Claude Code settings must be strict JSON — remove comments/trailing commas and re-run.`);
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new Error(`${settingsPath} does not contain a JSON object`);
    }
  }

  const existing = settings.statusLine;
  if (existing && existing.command === command) {
    return { changed: false, message: `Statusline already installed in ${settingsPath}` };
  }
  if (existing && !force) {
    return {
      changed: false,
      message: `A different statusline is already configured (${JSON.stringify(existing.command || existing)}).\n` +
        `    Re-run with --force to replace it.`,
    };
  }

  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.codelens-backup`);
  } else {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  settings.statusLine = { type: 'command', command, padding: 0 };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    changed: true,
    message: `Statusline installed in ${settingsPath}` +
      (existsSync(`${settingsPath}.codelens-backup`) ? ` (backup: ${settingsPath}.codelens-backup)` : ''),
  };
}

export async function runStatusline({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let input = {};
  try {
    const raw = await readStdin(stdin);
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    // Malformed stdin — degrade to quickstats-only output.
  }
  let quickstats = null;
  try {
    quickstats = loadQuickstats();
  } catch {
    // Missing/corrupt quickstats — degrade to stdin-only output.
  }
  stdout.write(`${composeStatusline(input, quickstats)}\n`);
}
