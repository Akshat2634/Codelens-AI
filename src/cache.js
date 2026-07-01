import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubagentTranscripts } from './claude-parser.js';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-analytics');
const CACHE_FILE = path.join(CACHE_DIR, 'parsed-sessions.json');
// Bump whenever parsing or pricing logic changes so cached sessions (which store
// already-computed costs) are recomputed on upgrade instead of served stale.
// 6: Sonnet 5 date-aware pricing (intro $2/$10 → standard $3/$15 on 2026-09-01).
// 7: fast-mode/US-residency billing markers, web-search fees, cache keyed on
//    (days, project) so a cache built for one window/filter can't serve another.
// 8: window-clipped usage for sessions spanning the cutoff, per-tier
//    cacheSavingsDollars on each session.
const CACHE_VERSION = 8;

export function loadCache(options = {}) {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION) return null;
    // Sessions were parsed with the lookback window and project filter baked in
    // (mtime cutoff, window clipping, folder filter). Serving them under
    // different options would display the wrong data — treat as a miss.
    if (data.days !== options.days) return null;
    if ((data.project || null) !== (options.project || null)) return null;
    // The rolling window moves daily and sessions are clipped to it at parse
    // time, so a cache built on an earlier day would serve stale clipping.
    if (options.cutoffDay && data.cutoffDay !== options.cutoffDay) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveCache(sessions, fileIndex, options = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data = {
    version: CACHE_VERSION,
    lastParsedAt: new Date().toISOString(),
    days: options.days,
    project: options.project || null,
    cutoffDay: options.cutoffDay || null,
    fileIndex,
    sessions,
  };
  writeFileSync(CACHE_FILE, JSON.stringify(data));
}

export function deleteCache() {
  if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
  }
}

export function getStaleFiles(claudeDir, cachedFileIndex, cutoffMs = 0) {
  const currentFiles = {};
  const newFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  // Scan all JSONL files on disk
  if (!existsSync(claudeDir)) return { currentFiles, newFiles, modifiedFiles, deletedFiles };

  const projectFolders = readdirSync(claudeDir).filter(f => {
    if (f.startsWith('.')) return false;
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
        // Files older than the lookback cutoff are never parsed (the parser
        // applies the same mtime filter), so they must not count as "new" —
        // otherwise any old session file forces a full re-parse on every run.
        if (mtime < cutoffMs) continue;
        currentFiles[filePath] = mtime;

        if (!cachedFileIndex[filePath]) {
          newFiles.push(filePath);
        } else if (mtime > cachedFileIndex[filePath]) {
          modifiedFiles.push(filePath);
        }

        // Subagent transcripts (including workflow-nested ones) are merged into
        // their parent session, so their changes must also invalidate the cache.
        const sessionId = file.slice(0, -'.jsonl'.length);
        for (const sf of listSubagentTranscripts(path.join(projectDir, sessionId, 'subagents'))) {
          try {
            const sm = statSync(sf).mtimeMs;
            currentFiles[sf] = sm;
            if (!cachedFileIndex[sf]) {
              newFiles.push(sf);
            } else if (sm > cachedFileIndex[sf]) {
              modifiedFiles.push(sf);
            }
          } catch { }
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
