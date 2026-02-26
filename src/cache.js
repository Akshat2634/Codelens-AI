import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-analytics');
const CACHE_FILE = path.join(CACHE_DIR, 'parsed-sessions.json');
const CACHE_VERSION = 1;

export function loadCache() {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveCache(sessions, fileIndex) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const data = {
    version: CACHE_VERSION,
    lastParsedAt: new Date().toISOString(),
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

export function getStaleFiles(claudeDir, cachedFileIndex) {
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
        currentFiles[filePath] = mtime;

        if (!cachedFileIndex[filePath]) {
          newFiles.push(filePath);
        } else if (mtime > cachedFileIndex[filePath]) {
          modifiedFiles.push(filePath);
        }
      } catch { continue; }
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
