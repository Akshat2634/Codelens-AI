import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubagentTranscripts } from './claude-parser.js';
import { listCodexSessionFiles } from './codex-parser.js';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-analytics');
const CACHE_FILE = path.join(CACHE_DIR, 'parsed-sessions.json');

// Default session locations — shared with index.js so the "is this a custom
// dir?" check below can't drift from the CLI's own defaults.
export const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
export const DEFAULT_CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
// The primary cache file is reserved for the plain ~/.codex layout. Comparing
// against DEFAULT_CODEX_DIR (which bakes in $CODEX_HOME at load) would let a
// run with a temporary CODEX_HOME map onto parsed-sessions.json and evict the
// cache built from the user's real sessions — overrides must fall through to
// the hashed filename below, same as --codex-dir.
const PLAIN_CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');

// Runs against custom --claude-dir/--codex-dir (tests, CI, fixtures) get their
// own cache file, so they never evict the cache built from the user's real
// sessions — before this, one `npm run test:e2e` cost the next real run a full
// re-parse.
function cacheFileFor(options = {}) {
  const claudeDir = options.claudeDir || DEFAULT_CLAUDE_DIR;
  const codexDir = options.codexDir || DEFAULT_CODEX_DIR;
  if (claudeDir === DEFAULT_CLAUDE_DIR && codexDir === PLAIN_CODEX_DIR) return CACHE_FILE;
  const hash = createHash('sha1').update(`${claudeDir}|${codexDir}`).digest('hex').slice(0, 8);
  return path.join(CACHE_DIR, `parsed-sessions-${hash}.json`);
}
// Bump whenever parsing or pricing logic changes so cached sessions (which store
// already-computed costs) are recomputed on upgrade instead of served stale.
// 6: Sonnet 5 date-aware pricing (intro $2/$10 → standard $3/$15 on 2026-09-01).
// 7: fast-mode/US-residency billing markers, web-search fees, cache keyed on
//    (days, project) so a cache built for one window/filter can't serve another.
// 8: window-clipped usage for sessions spanning the cutoff, per-tier
//    cacheSavingsDollars on each session.
// 9: per-day-priced cache savings, per-model daily splits (dailyUsage.byModel),
//    subagent transcripts extend session span, untimestamped usage day-bucketed,
//    cache keyed on claudeDir.
// 10: OpenAI Codex sessions (source field on every session, codexFileIndex,
//     cache keyed on codexDir).
// 11: Current OpenAI Codex pricing table refresh (GPT-5.4 pro/nano, no cached
//     discount for pro variants).
// 12: GPT-5.5/GPT-5.4 long-context pricing for Codex usage buckets.
// 13: OpenAI Codex web_search_call server-tool fees.
// 14: token dedup criterion changed and readOnlyBashCalls added to sessions —
//     cached sessions from 13 carry double-counted totals.
// 15: filesRead and non-verification bashCommands dropped from sessions (no
//     consumers; pure cache/memory ballast) — cached sessions from 14 still
//     carry them and would keep the bloat alive.
// 16: per-event usageEvents timeline added to sessions (5-hour billing blocks /
//     burn rate) — cached sessions from 15 lack it, so `blocks` would see no data.
// 17: external LiteLLM pricing overlay auto-prices models the hardcoded tables
//     don't know — cached sessions from 16 priced those at the Sonnet estimate,
//     so a re-parse is needed to pick up the real per-model rate.
// 18: GPT-5.6 family and corrected GPT-5.2/o-series Pro pricing.
// 19: filesWrittenAbsolute added to sessions for --depth's workspace-parent
//     explosion — cached sessions from 18 lack it, so --depth would silently
//     no-op against a warm cache until something else invalidated it.
// 20: per-model overlayCost + session-level overlayTotalCost/costModeIncomplete
//     added for --cost-mode auto|display and --debug pricing reconciliation —
//     cached sessions from 19 lack them, so those modes would see no overlay
//     comparison data until re-parsed.
const CACHE_VERSION = 20;

export function loadCache(options = {}) {
  const cacheFile = cacheFileFor(options);
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const raw = readFileSync(cacheFile, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION) return null;
    // Sessions were parsed with the lookback window and project filter baked in
    // (mtime cutoff, window clipping, folder filter). Serving them under
    // different options would display the wrong data — treat as a miss.
    if (data.days !== options.days) return null;
    if ((data.project || null) !== (options.project || null)) return null;
    // A cache built from one --claude-dir / --codex-dir must not serve another.
    if ((data.claudeDir || null) !== (options.claudeDir || null)) return null;
    if ((data.codexDir || null) !== (options.codexDir || null)) return null;
    // The rolling window moves daily and sessions are clipped to it at parse
    // time, so a cache built on an earlier day would serve stale clipping.
    if (options.cutoffDay && data.cutoffDay !== options.cutoffDay) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveCache(sessions, fileIndex, codexFileIndex, options = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data = {
    version: CACHE_VERSION,
    lastParsedAt: new Date().toISOString(),
    days: options.days,
    project: options.project || null,
    claudeDir: options.claudeDir || null,
    codexDir: options.codexDir || null,
    cutoffDay: options.cutoffDay || null,
    fileIndex,
    codexFileIndex: codexFileIndex || {},
    sessions,
  };
  writeFileSync(cacheFileFor(options), JSON.stringify(data));
}

export function deleteCache(options = {}) {
  const cacheFile = cacheFileFor(options);
  if (existsSync(cacheFile)) {
    unlinkSync(cacheFile);
  }
}

// Tiny denormalized summary written after every full pipeline run, so the
// `codelens-ai statusline` fast path (invoked by Claude Code every few hundred
// ms) can show today's ROI without re-running any parsing or git work. Kept
// separate from the session cache — it must stay small enough to read in
// microseconds. Only default-directory runs write it: fixture/CI runs against
// --claude-dir/--codex-dir would otherwise overwrite the user's real stats.
const QUICKSTATS_FILE = path.join(CACHE_DIR, 'quickstats.json');

export function saveQuickstats(stats, options = {}) {
  // Same default-dir predicate as the session cache (accepts either raw CLI
  // overrides or resolved paths): anything that would hash to its own cache
  // file — fixture dirs, CI, a temporary $CODEX_HOME — must not overwrite the
  // stats built from the user's real sessions.
  if (cacheFileFor(options) !== CACHE_FILE) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(QUICKSTATS_FILE, JSON.stringify(stats));
  } catch {
    // Best-effort: the statusline degrades gracefully without it.
  }
}

export function loadQuickstats() {
  try {
    return JSON.parse(readFileSync(QUICKSTATS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function getStaleFiles(claudeDir, cachedFileIndex, cutoffMs = 0, projectFilter = null) {
  const currentFiles = {};
  const newFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  // Scan all JSONL files on disk
  if (!existsSync(claudeDir)) return { currentFiles, newFiles, modifiedFiles, deletedFiles };

  const projectFolders = readdirSync(claudeDir).filter(f => {
    if (f.startsWith('.')) return false;
    // Apply the same project filter as the parser: the cached fileIndex only
    // covers matching folders, so scanning the rest would flag every one of
    // their files as "new" and force a full re-parse on every --project run.
    if (projectFilter && !f.toLowerCase().includes(projectFilter.toLowerCase())) return false;
    const fullPath = path.join(claudeDir, f);
    try { return statSync(fullPath).isDirectory(); } catch { return false; }
  });

  for (const folder of projectFolders) {
    const projectDir = path.join(claudeDir, folder);
    let files;
    try {
      files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;

        // Subagent transcripts (including workflow-nested ones) are merged into
        // their parent session, so their changes must also invalidate the cache.
        const sessionId = file.slice(0, -'.jsonl'.length);
        const subFiles = [];
        for (const sf of listSubagentTranscripts(path.join(projectDir, sessionId, 'subagents'))) {
          try {
            subFiles.push([sf, statSync(sf).mtimeMs]);
          } catch { }
        }

        // Sessions whose main AND subagent transcripts all predate the cutoff
        // are never parsed (the parser applies the same gate), so they must not
        // count as "new" — but a fresh subagent transcript alone must
        // resurrect the whole session, matching the parser.
        if (Math.max(mtime, ...subFiles.map(x => x[1])) < cutoffMs) continue;
        currentFiles[filePath] = mtime;

        if (!cachedFileIndex[filePath]) {
          newFiles.push(filePath);
        } else if (mtime > cachedFileIndex[filePath]) {
          modifiedFiles.push(filePath);
        }

        for (const [sf, sm] of subFiles) {
          currentFiles[sf] = sm;
          if (!cachedFileIndex[sf]) {
            newFiles.push(sf);
          } else if (sm > cachedFileIndex[sf]) {
            modifiedFiles.push(sf);
          }
        }
      } catch { }
    }
  }

  // Find deleted files
  for (const filePath of Object.keys(cachedFileIndex)) {
    if (!currentFiles[filePath]) {
      deletedFiles.push(filePath);
    }
  }

  return { currentFiles, newFiles, modifiedFiles, deletedFiles };
}

// Codex counterpart of getStaleFiles. Codex rollout files live in a date tree
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) with no per-project folders,
// so there is no folder-level project filter — the parser filters by each
// session's cwd after parsing, and the cache is keyed on (project) anyway.
export function getCodexStaleFiles(codexDir, cachedFileIndex, cutoffMs = 0) {
  const currentFiles = {};
  const newFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  for (const filePath of listCodexSessionFiles(codexDir)) {
    let mtime;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    // Same gate as the parser: files untouched since the cutoff are never
    // parsed, so they must not register as "new".
    if (mtime < cutoffMs) continue;
    currentFiles[filePath] = mtime;
    if (!cachedFileIndex[filePath]) {
      newFiles.push(filePath);
    } else if (mtime > cachedFileIndex[filePath]) {
      modifiedFiles.push(filePath);
    }
  }

  for (const filePath of Object.keys(cachedFileIndex)) {
    if (!currentFiles[filePath]) {
      deletedFiles.push(filePath);
    }
  }

  return { currentFiles, newFiles, modifiedFiles, deletedFiles };
}
