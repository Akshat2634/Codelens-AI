import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Files excluded from line-count metrics (lock files, minified bundles, etc.)
const EXCLUDED_EXACT = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock', 'go.sum', 'flake.lock', 'bun.lockb',
]);

const EXCLUDED_PATTERNS = [
  /\.min\.js$/, /\.min\.css$/, /\.map$/,
  /(?:^|\/)dist\//, /(?:^|\/)build\//, /(?:^|\/)\.next\//,
  /(?:^|\/)__pycache__\//,
];

function isGeneratedFile(filePath) {
  const basename = path.posix.basename(filePath);
  if (EXCLUDED_EXACT.has(basename)) return true;
  return EXCLUDED_PATTERNS.some(re => re.test(filePath));
}

export function getGitUser() {
  try {
    const name = execSync('git config user.name', { encoding: 'utf-8' }).trim();
    const email = execSync('git config user.email', { encoding: 'utf-8' }).trim();
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

  try {
    const raw = execSync(
      `git -C "${repoPath}" log ${mainBranch} --format=%H`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    return {
      hashes: new Set(raw.trim().split('\n').filter(Boolean)),
      branchName: mainBranch,
    };
  } catch {
    return { hashes: new Set(), branchName: mainBranch };
  }
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
        const filePath = parts.slice(2).join('\t'); // handle filenames with tabs
        current.files.push({ path: filePath, added, deleted });
        // Exclude lock/generated files from headline metrics
        if (!isGeneratedFile(filePath)) {
          current.totalAdded += added;
          current.totalDeleted += deleted;
          current.netLines += (added - deleted);
        }
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

  const user = getGitUser();

  try {
    const raw = execSync(
      `git -C "${repoPath}" log --all --since="${days} days ago" --format="COMMIT:%H|%ae|%aI|%s|%D" --numstat`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );

    const allCommits = parseGitLog(raw);

    // Get default branch hashes for onMain tagging
    const { hashes: mainHashes, branchName } = getMainBranchHashes(repoPath);
    for (const commit of allCommits) {
      commit.onMain = mainHashes.has(commit.hash);
    }

    // Filter to current user
    const userCommits = allCommits.filter(c => c.authorEmail === user.email);

    return { repoPath, commits: userCommits, allCommits, defaultBranch: branchName };
  } catch (err) {
    process.stderr.write(`Warning: Git analysis failed for ${repoPath}: ${err.message}\n`);
    return { repoPath, commits: [], allCommits: [], defaultBranch: null };
  }
}
