import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveWindow } from './window.js';

// Directory names that should never be recursed into when walking for nested
// git repos: package/build dirs (some npm packages ship a stray `.git` — every
// one would explode into a bogus repo), language virtualenvs, common caches.
const NESTED_REPO_SKIP_NAMES = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.cache', '.turbo', '.parcel-cache',
  'target', 'vendor',
]);

// Walk `rootPath` up to `maxDepth` levels deep and return every subdirectory
// that IS a git repo (has a `.git` entry — dir for normal repos, file for
// submodules). Does not recurse into a discovered repo (a repo inside a repo
// is a submodule/worktree; its commits belong to the outer analysis).
// Symlinks are skipped to prevent cycles and escape via a stray link.
// Any readdir failure yields an empty walk — the feature is opt-in and must
// never throw.
export function findNestedGitRepos(rootPath, maxDepth) {
  if (!rootPath || !Number.isFinite(maxDepth) || maxDepth < 1) return [];
  if (!existsSync(rootPath)) return [];
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.claude') {
        // Skip hidden dirs. `.claude` itself is not a repo but is walked into
        // below so its `worktrees` child can be excluded specifically.
        continue;
      }
      if (NESTED_REPO_SKIP_NAMES.has(name)) continue;
      // `.claude/worktrees/*` entries resolve to the outer repo via
      // findGitRoot's upward walk — reporting them here as separate nested
      // repos would double-count their commits. Scoped to a `worktrees` dir
      // directly under `.claude` so an unrelated project folder that happens
      // to be named `worktrees` elsewhere in the tree isn't skipped.
      if (name === 'worktrees' && path.basename(dir) === '.claude') continue;
      const full = path.join(dir, name);
      if (existsSync(path.join(full, '.git'))) {
        found.push(full);
        continue; // do not recurse into a discovered repo
      }
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(rootPath, 1);
  return found;
}

// Resolve the git user for a specific repo (repo-local config overrides global).
// Without -C this reads config relative to the process CWD, which can be a
// different repo (or none) than the one being analyzed — a repo-local
// user.email would then never match and every commit would be filtered out.
export function getGitUser(repoPath = null) {
  const git = repoPath ? `git -C "${repoPath}"` : 'git';
  try {
    const name = execSync(`${git} config user.name`, { encoding: 'utf-8' }).trim();
    const email = execSync(`${git} config user.email`, { encoding: 'utf-8' }).trim();
    return { name, email };
  } catch {
    return { name: 'unknown', email: 'unknown' };
  }
}

// Canonical repo identity from the `origin` remote URL. Lets the Projects
// breakdown collapse clones, git worktrees, and moved/renamed checkouts of the
// SAME repo into one entry (they share a remote) while keeping genuinely
// different repos that merely share a folder name apart (different remotes).
// Handles https, ssh://, and scp-style (git@host:owner/repo) URLs; strips
// credentials, a trailing `.git`, and case. Returns { id, slug } or null when
// the repo has no origin remote (purely local).
// Pure URL → canonical identity, split out so it's testable without a repo.
export function normalizeRemoteUrl(url) {
  if (!url?.trim()) return null;
  let s = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const scp = s.match(/^[^/@]+@([^:]+):(.+)$/); // git@github.com:owner/repo
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^/@]+@/, ''); // strip scheme + credentials
  }
  s = s.toLowerCase();
  const parts = s.split('/').filter(Boolean); // [host, owner, repo, ...]
  if (parts.length === 0) return null;
  const slug = parts.length >= 2 ? parts.slice(-2).join('/') : parts[0];
  return { id: s, slug };
}

export function getRepoRemote(repoPath) {
  let url;
  try {
    url = execSync(`git -C "${repoPath}" remote get-url origin`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'], // silence "no such remote" on stderr
    }).trim();
  } catch {
    return null;
  }
  return normalizeRemoteUrl(url);
}

function detectDefaultBranch(repoPath) {
  // 1. Check what the remote HEAD points to (most reliable)
  try {
    const ref = execSync(
      `git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    // Returns e.g. "refs/remotes/origin/main"
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch {
    // No remote HEAD set, fall through
  }

  // 2. Fallback: check for common default branch names
  try {
    const branches = execSync(`git -C "${repoPath}" branch --list`, { encoding: 'utf-8' });
    const branchList = branches.split('\n').map(b => b.replace('*', '').trim()).filter(Boolean);
    for (const name of ['main', 'master', 'develop', 'development', 'staging', 'trunk']) {
      if (branchList.includes(name)) return name;
    }
    // 3. Last resort: return the first branch
    if (branchList.length > 0) return branchList[0];
  } catch {
    // ignore
  }

  return null;
}

function getMainBranchHashes(repoPath) {
  const mainBranch = detectDefaultBranch(repoPath);
  if (!mainBranch) return { hashes: new Set(), branchName: null };

  // Union local and remote-tracking refs: a missing or stale local main must
  // not under-report the "commits on main" rate when origin/main has them.
  const hashes = new Set();
  for (const ref of [mainBranch, `origin/${mainBranch}`]) {
    try {
      const raw = execSync(
        `git -C "${repoPath}" log ${ref} --format=%H`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }
      );
      for (const h of raw.trim().split('\n')) {
        if (h) hashes.add(h);
      }
    } catch {
      // ref doesn't exist locally — try the next one
    }
  }
  return { hashes, branchName: mainBranch };
}

// Git C-quotes paths containing non-ASCII or special characters
// ("src/caf\303\251.js"). Unquote them or file-overlap matching silently
// fails for those files.
function unquoteGitPath(raw) {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const escapes = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Resolve git's --numstat rename syntax to the NEW path so it matches the
// current file paths captured from session tool calls (filesWritten):
//   "lib/{old => new}/file.js" -> "lib/new/file.js"
//   "old.js => new.js"         -> "new.js"
// Non-rename paths pass through unchanged.
function parseNumstatPath(raw) {
  if (!raw.includes(' => ')) return raw;
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, , newMid, tail] = brace;
    return (pre + newMid + tail).replace(/\/{2,}/g, '/');
  }
  const parts = raw.split(' => ');
  return parts[parts.length - 1];
}

// Agents that stamp commits with a Co-authored-by trailer, mapped to the
// session `source` names used across the codebase. Emails are the strong
// signal (vendor domains are stable while display names vary across agent
// versions); display names alone must be unambiguous product names — a bare
// human first name ("Claude Martin <claude@company.com>", "Devin Jones")
// must never be classified as an AI stamp, since these counts feed the
// attribution audit as near-ground-truth.
const AI_TRAILER_EMAIL_PATTERNS = [
  [/@anthropic\.com/i, 'claude'],
  [/@openai\.com|chatgpt/i, 'codex'],
  [/copilot@|copilot\[bot\]|copilot@users\.noreply\.github\.com/i, 'copilot'],
  [/cursoragent|@cursor\.(com|sh)/i, 'cursor'],
  [/@devin\.ai/i, 'devin'],
  [/@aider\.chat/i, 'aider'],
  [/jules\[bot\]|google-labs-jules|gemini/i, 'gemini'],
];
const AI_TRAILER_NAME_PATTERNS = [
  // "Claude" alone is a human name; require a product qualifier.
  [/\bclaude\s+(code|fable|mythos|opus|sonnet|haiku|\d)/i, 'claude'],
  [/\bcodex\b/i, 'codex'],
  [/\bcopilot\b/i, 'copilot'],
  [/\bcursor\s+agent\b/i, 'cursor'],
  [/\bgemini\b/i, 'gemini'],
  [/\baider\b/i, 'aider'],
  [/\bdevin\s+ai\b/i, 'devin'],
];
function detectAiTrailer(coAuthorValues) {
  for (const value of coAuthorValues) {
    // "Display Name <email>" — match email and name against separate rules.
    const emailMatch = value.match(/<([^>]*)>/);
    const email = emailMatch ? emailMatch[1] : '';
    const name = emailMatch ? value.slice(0, emailMatch.index) : value;
    for (const [re, agent] of AI_TRAILER_EMAIL_PATTERNS) {
      if (email && re.test(email)) return agent;
    }
    for (const [re, agent] of AI_TRAILER_NAME_PATTERNS) {
      if (re.test(name)) return agent;
    }
  }
  return null;
}

// %S (the ref by which `git log --all` reached the commit) arrives as a full
// refname — refs/heads/x, refs/remotes/origin/x, refs/tags/x. Reduce it to a
// display name. Git doesn't record the branch a commit was CREATED on; for
// off-main commits this is a ref that currently contains it, which in
// practice is the feature branch. null when there's no usable name: git
// < 2.21 echoes the %S token verbatim, and bare HEAD is detached work.
function normalizeSourceRef(ref) {
  if (!ref || ref.startsWith('%')) return null;
  const name = ref
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^refs\/(heads|tags)\//, '');
  return (!name || name === 'HEAD') ? null : name;
}

// One-time note when git predates %(trailers:...) options (git < 2.22): the
// placeholder passes through unparsed, so trailer attribution is unavailable
// but everything else still works.
let warnedTrailersUnsupported = false;

function parseGitLog(raw) {
  const commits = [];
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      if (current) commits.push(current);
      // Format: hash \x01 email \x01 timestamp \x01 subject \x01 co-author
      // trailers (\x02-separated) \x01 source ref (%S). Control-char
      // separators instead of `|`: subjects and trailer values can
      // legitimately contain pipes, but never control characters, so
      // splitting is exact instead of best-effort.
      const parts = line.slice(7).split('\x01');
      if (parts.length < 4) continue;

      const [hash, email, timestamp, subject] = parts;
      let trailersField = parts[4] || '';
      if (trailersField.startsWith('%(trailers')) {
        // git < 2.22 echoes the unsupported placeholder verbatim.
        trailersField = '';
        if (!warnedTrailersUnsupported) {
          warnedTrailersUnsupported = true;
          process.stderr.write('note: git < 2.22 detected — Co-authored-by trailer attribution is unavailable (upgrade git to enable it)\n');
        }
      }
      const coAuthors = trailersField.split('\x02').map(v => v.trim()).filter(Boolean);

      current = {
        hash,
        authorEmail: email,
        timestamp,
        timestampMs: new Date(timestamp).getTime(),
        subject,
        // Near-ground-truth AI attribution: agents stamp their commits with
        // Co-authored-by trailers. null when no known agent trailer is present.
        aiTrailer: detectAiTrailer(coAuthors),
        // A ref containing this commit — the feature branch name for off-main
        // work. Which ref wins for on-main commits is traversal-order
        // dependent (main, a tag, ...), so display defers to onMain there.
        branch: normalizeSourceRef(parts[5] || ''),
        onMain: false,
        files: [],
        totalAdded: 0,
        totalDeleted: 0,
        netLines: 0,
      };
    } else if (current && line.trim()) {
      // numstat line: "2\t2\tpath/to/file" or "-\t-\tbinary_file"
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parseNumstatPath(unquoteGitPath(parts.slice(2).join('\t'))); // unquote + resolve renames
        current.files.push({ path: filePath, added, deleted });
        current.totalAdded += added;
        current.totalDeleted += deleted;
        current.netLines += (added - deleted);
      }
    }
  }
  if (current) commits.push(current);
  return commits;
}

// Sessions record the repo's absolute cwd at the time they ran. If the repo
// is later moved or renamed on disk (a project folder reorganization, a
// Dropbox/iCloud ".nosync" exclusion, a new machine with a different home
// layout, ...), that exact path stops existing and analyzeGitRepo() would
// silently return zero commits for it forever — orphaning every session tied
// to the old location even though the git history is fully intact elsewhere.
//
// Resolve by folder name: if a missing repoPath's basename matches exactly
// one OTHER path in the same set that still exists on disk, treat them as
// the same repository. This only draws on paths already known from the
// user's own parsed sessions (not a filesystem-wide search), and only acts
// on an unambiguous match — a basename shared by more than one still-valid
// path is left unresolved rather than guessed.
//
// A basename alone can still pair two unrelated repos that share a folder
// name (api, backend, ...), so when the dead path's sessions recorded any
// filesWritten (repo-relative), the alias is only accepted if at least one of
// those paths is tracked by the candidate repo. Chat-only sessions have
// nothing to corroborate with — the plain name match stands for them.
export function resolveMovedRepoPaths(repoPaths, sessions = []) {
  const candidatesByName = new Map();
  for (const p of repoPaths) {
    if (!existsSync(path.join(p, '.git'))) continue;
    const base = path.basename(p);
    if (!candidatesByName.has(base)) candidatesByName.set(base, []);
    candidatesByName.get(base).push(p);
  }

  const writtenByRepoPath = new Map(); // repoPath -> Set of repo-relative filesWritten
  for (const s of sessions) {
    if (!s.repoPath || !s.filesWritten || s.filesWritten.length === 0) continue;
    if (!writtenByRepoPath.has(s.repoPath)) writtenByRepoPath.set(s.repoPath, new Set());
    for (const f of s.filesWritten) writtenByRepoPath.get(s.repoPath).add(f);
  }

  const trackedFilesCache = new Map(); // candidate repoPath -> Set of tracked paths (null on git failure)
  const trackedFiles = (repo) => {
    if (!trackedFilesCache.has(repo)) {
      try {
        const raw = execSync(
          `git -C "${repo}" ls-files`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 }
        );
        trackedFilesCache.set(repo, new Set(raw.split('\n').filter(Boolean).map(unquoteGitPath)));
      } catch {
        trackedFilesCache.set(repo, null);
      }
    }
    return trackedFilesCache.get(repo);
  };

  const aliasMap = new Map(); // stale repoPath -> resolved repoPath
  const unresolved = [];
  for (const p of repoPaths) {
    if (existsSync(path.join(p, '.git'))) continue;
    const candidates = (candidatesByName.get(path.basename(p)) || []).filter(c => c !== p);
    if (candidates.length !== 1) {
      unresolved.push(p);
      continue;
    }
    const written = writtenByRepoPath.get(p);
    if (written && written.size > 0) {
      const tracked = trackedFiles(candidates[0]);
      if (!tracked || ![...written].some(f => tracked.has(f))) {
        unresolved.push(p);
        continue;
      }
    }
    aliasMap.set(p, candidates[0]);
  }
  return { aliasMap, unresolved };
}

export function analyzeGitRepo(repoPath, days, since = null, until = null) {
  const remote = getRepoRemote(repoPath);
  if (!existsSync(path.join(repoPath, '.git'))) {
    return { repoPath, commits: [], defaultBranch: null, remote: remote?.id || null, remoteSlug: remote?.slug || null };
  }

  const user = getGitUser(repoPath);

  try {
    // --since/--until here are just a rough over-fetch pre-filter (git's own
    // approxidate parsing) — the JS-side author-date filter below is what's
    // actually authoritative, same division of labor as the existing
    // "N days ago" string always had. Safe to interpolate: `since`/`until` are
    // validated YYYY-MM-DD by window.js:validateDateStr before reaching here.
    const sinceArg = since || `${days} days ago`;
    const untilArg = until ? ` --until="${until} 23:59:59"` : '';
    const raw = execSync(
      `git -C "${repoPath}" log --no-merges --exclude=refs/stash --all --since="${sinceArg}"${untilArg} --format="COMMIT:%H%x01%ae%x01%aI%x01%s%x01%(trailers:key=Co-authored-by,valueonly,separator=%x02)%x01%S" --numstat`,
      { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 }
    );

    let allCommits = parseGitLog(raw);

    // Get default branch hashes for onMain tagging
    const { hashes: mainHashes, branchName } = getMainBranchHashes(repoPath);
    for (const commit of allCommits) {
      commit.onMain = mainHashes.has(commit.hash);
    }

    // `--all` returns rebase-merge / cherry-pick copies of the same change as
    // distinct hashes (feature branch + its rewritten copy on main). Author
    // email, author date (%aI, preserved by rebase/cherry-pick), and the
    // per-file diffstat identify the underlying patch — keep one copy,
    // preferring the one on the default branch, so commit and line counts
    // aren't double-counted after a "Rebase and merge".
    const byPatch = new Map();
    const deduped = [];
    for (const commit of allCommits) {
      const sig = `${commit.authorEmail}|${commit.timestamp}|` +
        commit.files.map(f => `${f.path}:${f.added}:${f.deleted}`).sort().join(',');
      const existing = byPatch.get(sig);
      if (existing === undefined) {
        byPatch.set(sig, deduped.length);
        deduped.push(commit);
      } else if (commit.onMain && !deduped[existing].onMain) {
        deduped[existing] = commit;
      }
    }
    allCommits = deduped;

    // Second dedup pass: GitHub "Squash and merge" (and retained branch-vs-main
    // copies) produce a NEW commit on the default branch with a DIFFERENT author
    // date — and often a " (#123)" PR-number subject suffix — than the original
    // feature-branch commit, so the exact-%aI signature above never collapses
    // them and both survive under `--all`, double-counting commits and lines
    // (observed at ~20-30% inflation on real repos). Collapse a pair only on
    // unambiguous evidence: same author, IDENTICAL per-file diffstat, matching
    // subject (ignoring a trailing PR-number suffix), one copy on the default
    // branch and one off it, and author dates within a short window. Drop the
    // off-branch twin, keep the on-main copy. Requiring an identical diffstat +
    // subject + one-on/one-off-main keeps genuinely distinct commits that merely
    // share a subject (repeated version bumps, "regenerate lockfile") from ever
    // being merged.
    const SQUASH_WINDOW_MS = 10 * 60 * 1000;
    const normalizeSubject = (s) => (s || '').replace(/\s*\(#\d+\)\s*$/, '').trim();
    const patchKey = (c) => `${(c.authorEmail || '').toLowerCase()}|${normalizeSubject(c.subject)}|` +
      c.files.map(f => `${f.path}:${f.added}:${f.deleted}`).sort().join(',');
    const squashGroups = new Map();
    for (const commit of allCommits) {
      if (!commit.files || commit.files.length === 0) continue; // need a diffstat to match on
      const key = patchKey(commit);
      if (!squashGroups.has(key)) squashGroups.set(key, []);
      squashGroups.get(key).push(commit);
    }
    const dropHashes = new Set();
    for (const group of squashGroups.values()) {
      if (group.length < 2) continue;
      const onMainCopies = group.filter(c => c.onMain);
      if (onMainCopies.length === 0) continue; // no canonical main copy → leave as-is
      for (const c of group) {
        if (c.onMain) continue; // keep every on-main copy
        // Drop an off-main twin only if a matching on-main copy is within the window.
        if (onMainCopies.some(m => Math.abs((c.timestampMs || 0) - (m.timestampMs || 0)) <= SQUASH_WINDOW_MS)) {
          dropHashes.add(c.hash);
        }
      }
    }
    if (dropHashes.size > 0) {
      allCommits = allCommits.filter(c => !dropHashes.has(c.hash));
    }

    // Enforce the lookback window on AUTHOR date (%aI), matching every downstream
    // metric (all of which bucket on author date). `--since`/`--until` filter on
    // committer date, which can differ from author date after a rebase or
    // cherry-pick. Same window resolution as the session parsers (setDate is
    // DST-aware; a fixed days*24h product drifts an hour across DST changes).
    const { cutoffMs, untilMs } = resolveWindow({ days, since, until });

    // Filter to the current user (case-insensitive — git records emails verbatim
    // and the case can vary) within the author-date window.
    const userEmail = (user.email || '').toLowerCase();
    const userCommits = allCommits.filter(c =>
      (c.authorEmail || '').toLowerCase() === userEmail &&
      Number.isFinite(c.timestampMs) && c.timestampMs >= cutoffMs &&
      (!untilMs || c.timestampMs <= untilMs)
    );

    return { repoPath, commits: userCommits, defaultBranch: branchName, remote: remote?.id || null, remoteSlug: remote?.slug || null };
  } catch (err) {
    process.stderr.write(`Warning: Git analysis failed for ${repoPath}: ${err.message}\n`);
    return { repoPath, commits: [], defaultBranch: null, remote: remote?.id || null, remoteSlug: remote?.slug || null };
  }
}
