// Best-effort "a newer version exists" nudge — printed once per run when the
// local install is behind npm's published `latest`.
//
// Why this exists: `npx codelens-ai` (no version pin) resolves to whatever is
// already on $PATH or already cached — if a user has an old global install or
// a stale npx cache, they silently run ancient code with none of the current
// subcommands and get confusing Commander parse errors instead of a real
// hint. This check can't fix an already-installed old binary (that code
// can't know about a check added later), but once a user is on ANY version
// that ships this, they'll be told to upgrade instead of getting stuck again.
//
// Cached to disk with a TTL so normal use makes at most one registry request
// a day; --offline (and any network failure) skips it silently — this must
// never throw or meaningfully delay a real command.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'agent-analytics');
const CACHE_FILE = path.join(CACHE_DIR, 'version-check.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // once a day

function readCache(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'));
  } catch {
    return null;
  }
}
function writeCache(cacheFile, data) {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(data));
  } catch {
    // Best-effort — a read-only cache dir just means we ask again next run.
  }
}

// Numeric, three-part semver compare (no pre-release handling — this package
// doesn't publish any). Returns true if `a` is strictly newer than `b`.
export function isNewerVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/**
 * Check npm's registry for a newer published version.
 *   currentVersion — the running package.json version.
 *   offline        — never hit the network; a stale/missing cache means "no answer".
 *   ttlMs/fetchImpl/now/cacheFile — injectable for tests.
 * Returns { current, latest } when an update is available, otherwise null.
 * Never throws.
 */
export async function checkForUpdate({
  currentVersion,
  packageName = 'codelens-ai',
  offline = false,
  ttlMs = DEFAULT_TTL_MS,
  fetchImpl = fetch,
  now = Date.now,
  cacheFile = CACHE_FILE,
} = {}) {
  const cached = readCache(cacheFile);
  const fresh = cached && Number.isFinite(cached.checkedAt) && now() - cached.checkedAt < ttlMs;

  let latest = fresh ? cached.latest : null;
  if (!latest && !offline) {
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      latest = doc.version || null;
      writeCache(cacheFile, { latest, checkedAt: now() });
    } catch {
      return null; // offline, DNS hiccup, registry down — stay silent
    }
  }

  return latest && isNewerVersion(latest, currentVersion) ? { current: currentVersion, latest } : null;
}

export const __cacheFile = CACHE_FILE;
