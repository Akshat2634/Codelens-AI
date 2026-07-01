import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

function parseGitLog(raw) {
  const commits = [];
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      if (current) commits.push(current);
      const rest = line.slice(7);
      // Format: hash|email|timestamp|subject|decorations
      // Subject may contain | so we split carefully
      const pipeIdx1 = rest.indexOf('|');
      const pipeIdx2 = rest.indexOf('|', pipeIdx1 + 1);
      const pipeIdx3 = rest.indexOf('|', pipeIdx2 + 1);

      if (pipeIdx1 === -1 || pipeIdx2 === -1 || pipeIdx3 === -1) continue;

      const hash = rest.slice(0, pipeIdx1);
      const email = rest.slice(pipeIdx1 + 1, pipeIdx2);
      const timestamp = rest.slice(pipeIdx2 + 1, pipeIdx3);
      const remaining = rest.slice(pipeIdx3 + 1);

      // Last field after last | is decorations (may be empty)
      const lastPipe = remaining.lastIndexOf('|');
      let subject, decorations;
      if (lastPipe !== -1) {
        subject = remaining.slice(0, lastPipe);
        decorations = remaining.slice(lastPipe + 1).trim();
      } else {
        subject = remaining;
        decorations = '';
      }

      current = {
        hash,
        authorEmail: email,
        timestamp,
        timestampMs: new Date(timestamp).getTime(),
        subject,
        decorations,
        branches: [],
        onMain: false,
        files: [],
        totalAdded: 0,
        totalDeleted: 0,
        netLines: 0,
      };

      // Parse decorations for branch info
      if (decorations) {
        const refs = decorations.split(',').map(r => r.trim());
        for (const ref of refs) {
          const cleaned = ref
            .replace('HEAD -> ', '')
            .replace('origin/', '')
            .trim();
          if (cleaned && !cleaned.startsWith('tag:')) {
            current.branches.push(cleaned);
          }
        }
      }
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

export function analyzeGitRepo(repoPath, days) {
  if (!existsSync(path.join(repoPath, '.git'))) {
    return { repoPath, commits: [], allCommits: [], defaultBranch: null };
  }

  const user = getGitUser(repoPath);

  try {
    const raw = execSync(
      `git -C "${repoPath}" log --no-merges --exclude=refs/stash --all --since="${days} days ago" --format="COMMIT:%H|%ae|%aI|%s|%D" --numstat`,
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

    // Enforce the lookback window on AUTHOR date (%aI), matching every downstream
    // metric (all of which bucket on author date). `--since` filters on committer
    // date, which can differ from author date after a rebase or cherry-pick.
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

    // Filter to the current user (case-insensitive — git records emails verbatim
    // and the case can vary) within the author-date window.
    const userEmail = (user.email || '').toLowerCase();
    const userCommits = allCommits.filter(c =>
      (c.authorEmail || '').toLowerCase() === userEmail &&
      Number.isFinite(c.timestampMs) && c.timestampMs >= cutoffMs
    );

    return { repoPath, commits: userCommits, allCommits, defaultBranch: branchName };
  } catch (err) {
    process.stderr.write(`Warning: Git analysis failed for ${repoPath}: ${err.message}\n`);
    return { repoPath, commits: [], allCommits: [], defaultBranch: null };
  }
}
