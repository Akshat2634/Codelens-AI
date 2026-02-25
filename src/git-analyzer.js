import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function getGitUser() {
  try {
    const name = execSync('git config user.name', { encoding: 'utf-8' }).trim();
    const email = execSync('git config user.email', { encoding: 'utf-8' }).trim();
    return { name, email };
  } catch {
    return { name: 'unknown', email: 'unknown' };
  }
}

function getMainBranchHashes(repoPath) {
  // Determine main branch name
  let mainBranch = 'main';
  try {
    const branches = execSync(`git -C "${repoPath}" branch --list`, { encoding: 'utf-8' });
    if (branches.includes('main')) {
      mainBranch = 'main';
    } else if (branches.includes('master')) {
      mainBranch = 'master';
    } else {
      // No main/master branch found
      return new Set();
    }
  } catch {
    return new Set();
  }

  try {
    const raw = execSync(
      `git -C "${repoPath}" log ${mainBranch} --format=%H`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
    return new Set(raw.trim().split('\n').filter(Boolean));
  } catch {
    return new Set();
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
    return { repoPath, commits: [], allCommits: [] };
  }

  const user = getGitUser();

  try {
    // Use %x00 (null byte) for the last delimiter to avoid ambiguity with subject containing |
    // Actually, let's use a 5-pipe approach: hash|email|timestamp|subject|decorations
    // But subject can have |. So we use the fact that decorations is the LAST field.
    const raw = execSync(
      `git -C "${repoPath}" log --all --since="${days} days ago" --format="COMMIT:%H|%ae|%aI|%s|%D" --numstat`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );

    const allCommits = parseGitLog(raw);

    // Get main branch hashes for onMain tagging
    const mainHashes = getMainBranchHashes(repoPath);
    for (const commit of allCommits) {
      commit.onMain = mainHashes.has(commit.hash);
    }

    // Filter to current user
    const userCommits = allCommits.filter(c => c.authorEmail === user.email);

    return { repoPath, commits: userCommits, allCommits };
  } catch (err) {
    process.stderr.write(`Warning: Git analysis failed for ${repoPath}: ${err.message}\n`);
    return { repoPath, commits: [], allCommits: [] };
  }
}
