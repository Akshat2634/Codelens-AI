import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isAttributable } from './correlator.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BLAME_FILE_CAP = 600; // safety bound on per-repo blame work

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

// Classify a commit subject for rework / quality signals. Conventional-commit aware
// but tolerant of free-form messages.
function classifySubject(subject) {
  const s = (subject || '').trim();
  const isRevert = /^revert[:\s"]/i.test(s) || /\breverts? commit\b/i.test(s);
  // Bug-fix only when the commit declares itself one (leading keyword or conventional
  // `fix:`/`fix(scope):` / `hotfix`), not merely mentioning "fixed" mid-message — the
  // looser form massively over-counts rework.
  const isFix = /^(fix|bugfix|hotfix|patch)\b/i.test(s) || /^(fix|bugfix|hotfix)(\([^)]*\))?!?:/i.test(s) || /^\w+(\([^)]*\))?!?:\s*fix\b/i.test(s);
  let type = 'other';
  const cc = s.match(/^(\w+)(\([^)]*\))?!?:/);
  if (cc) type = cc[1].toLowerCase();
  else if (isRevert) type = 'revert';
  else if (isFix) type = 'fix';
  return { isRevert, isFix, type };
}

// Map commit hash -> joined Co-authored-by trailer values, in one cheap log pass.
// %x09 = tab, separator=%x2C joins multiple trailers with commas (no embedded newlines
// to break line parsing). Degrades gracefully on older git that lacks the placeholder.
function getAiAuthorship(repoPath, days) {
  const map = new Map();
  try {
    const raw = execSync(
      `git -C "${repoPath}" log --all --since="${days} days ago" --format="%H%x09%(trailers:key=Co-authored-by,valueonly,separator=%x2C)"`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    for (const line of raw.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const hash = line.slice(0, tab);
      const trailers = line.slice(tab + 1).trim();
      if (hash && trailers) map.set(hash, trailers);
    }
  } catch {
    // Older git or no trailers — AI authorship falls back to email matching only.
  }
  return map;
}

function parseGitLog(raw) {
  const commits = [];
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      if (current) commits.push(current);
      const rest = line.slice(7);
      // Format: hash|authorEmail|committerEmail|timestamp|subject|decorations
      // Subject may contain | so we locate the 4 fixed leading fields, then split
      // the remainder into subject + decorations on the LAST pipe.
      const p1 = rest.indexOf('|');
      const p2 = rest.indexOf('|', p1 + 1);
      const p3 = rest.indexOf('|', p2 + 1);
      const p4 = rest.indexOf('|', p3 + 1);

      if (p1 === -1 || p2 === -1 || p3 === -1 || p4 === -1) continue;

      const hash = rest.slice(0, p1);
      const email = rest.slice(p1 + 1, p2);
      const committerEmail = rest.slice(p2 + 1, p3);
      const timestamp = rest.slice(p3 + 1, p4);
      const remaining = rest.slice(p4 + 1);

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

      const cls = classifySubject(subject);
      current = {
        hash,
        authorEmail: email,
        committerEmail,
        timestamp,
        timestampMs: new Date(timestamp).getTime(),
        subject,
        decorations,
        branches: [],
        onMain: false,
        isRevert: cls.isRevert,
        isFix: cls.isFix,
        commitType: cls.type,
        aiAuthored: false,
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
    return { repoPath, commits: [], allCommits: [], defaultBranch: null };
  }

  const user = getGitUser();

  try {
    const raw = execSync(
      `git -C "${repoPath}" log --all --since="${days} days ago" --format="COMMIT:%H|%ae|%ce|%aI|%s|%D" --numstat`,
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );

    const allCommits = parseGitLog(raw);

    // Get default branch hashes for onMain tagging
    const { hashes: mainHashes, branchName } = getMainBranchHashes(repoPath);
    for (const commit of allCommits) {
      commit.onMain = mainHashes.has(commit.hash);
    }

    // AI-authorship cross-validation: detect commits whose Co-authored-by trailers
    // (or author/committer email) name an AI coding agent. Used to validate the
    // session→commit correlation and surface AI work the heuristic may have missed.
    const aiByHash = getAiAuthorship(repoPath, days);
    for (const commit of allCommits) {
      const hay = `${commit.authorEmail} ${commit.committerEmail} ${aiByHash.get(commit.hash) || ''}`.toLowerCase();
      commit.aiAuthored = /anthropic\.com|noreply@anthropic|claude|\bcursor\b|copilot|aider|devin|codeium/.test(hay);
    }

    // Filter to current user
    const userCommits = allCommits.filter(c => c.authorEmail === user.email);

    return { repoPath, commits: userCommits, allCommits, defaultBranch: branchName };
  } catch (err) {
    process.stderr.write(`Warning: Git analysis failed for ${repoPath}: ${err.message}\n`);
    return { repoPath, commits: [], allCommits: [], defaultBranch: null };
  }
}

/**
 * True line-survival via git blame at HEAD (opt-in; expensive).
 *
 * For each file an AI-correlated commit touched, blame HEAD and count how many lines
 * are STILL attributed to their original AI commit. Because blame attributes a line to
 * its LAST-touching commit, "surviving" here means the line has not been edited since
 * the AI introduced it — any later change (even by the same author) counts as not
 * surviving. Lines are bucketed by the age of their introducing commit to derive a
 * decay curve and an estimated half-life. Returns null when there is too little
 * history to say anything honest.
 *
 * @param {string} repoPath
 * @param {Array<{hash:string,timestampMs:number,files:Array<{path:string,added:number}>}>} aiCommits
 */
export function blameAiSurvival(repoPath, aiCommits, nowMs = Date.now()) {
  if (!existsSync(path.join(repoPath, '.git')) || !aiCommits.length) return null;

  const aiHashes = new Set(aiCommits.map(c => c.hash));
  const files = new Set();
  for (const c of aiCommits) {
    for (const f of c.files) if (isAttributable(f.path)) files.add(f.path);
  }
  const fileList = [...files].slice(0, BLAME_FILE_CAP);
  const cappedFiles = files.size > BLAME_FILE_CAP;

  // surviving lines per AI commit hash (blamed to that hash at HEAD)
  const survivingByHash = new Map();
  for (const file of fileList) {
    try {
      const out = execSync(
        `git -C "${repoPath}" blame --line-porcelain HEAD -- "${file}"`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }
      );
      for (const line of out.split('\n')) {
        const m = line.match(/^([0-9a-f]{40}) /);
        if (m && aiHashes.has(m[1])) survivingByHash.set(m[1], (survivingByHash.get(m[1]) || 0) + 1);
      }
    } catch {
      // File renamed/deleted at HEAD, binary, or unreadable — its AI lines simply
      // count as not surviving (they're not present under this path at HEAD).
    }
  }

  // Aggregate + weekly cohorts (by age of the introducing commit).
  let introduced = 0;
  let surviving = 0;
  const cohorts = new Map(); // ageWeeks -> { introduced, surviving }
  for (const c of aiCommits) {
    const added = c.files.filter(f => isAttributable(f.path)).reduce((a, f) => a + f.added, 0);
    if (added === 0) continue;
    const surv = Math.min(survivingByHash.get(c.hash) || 0, added); // cap (blame counts current lines)
    introduced += added;
    surviving += surv;
    const ageWeeks = Math.max(0, Math.floor((nowMs - c.timestampMs) / WEEK_MS));
    if (!cohorts.has(ageWeeks)) cohorts.set(ageWeeks, { introduced: 0, surviving: 0 });
    const cw = cohorts.get(ageWeeks);
    cw.introduced += added;
    cw.surviving += surv;
  }

  if (introduced === 0) return null;
  return finalizeBlame(introduced, surviving, cohorts, { cappedFiles, blamedFiles: fileList.length });
}

// Shared finalization for a single repo or the merged set: builds the weekly decay
// curve and the half-life estimate (youngest weekly cohort below 50% survival).
function finalizeBlame(introduced, surviving, cohortsMap, extra) {
  const byAgeWeeks = [...cohortsMap.entries()]
    .map(([ageWeeks, d]) => ({
      ageWeeks,
      introduced: d.introduced,
      surviving: d.surviving,
      survivalRatePct: Math.round((d.surviving / d.introduced) * 100),
    }))
    .sort((a, b) => a.ageWeeks - b.ageWeeks);

  // Requires ≥3 distinct weekly cohorts spanning ≥3 weeks, else not enough signal.
  const span = byAgeWeeks.length ? byAgeWeeks[byAgeWeeks.length - 1].ageWeeks : 0;
  const sufficientHistory = byAgeWeeks.length >= 3 && span >= 3;
  let halfLifeWeeks = null;
  if (sufficientHistory) {
    const below = byAgeWeeks.find(b => b.survivalRatePct < 50);
    halfLifeWeeks = below ? below.ageWeeks : null; // null ⇒ still above 50% across the window
  }

  return {
    introduced,
    surviving,
    survivalRatePct: Math.round((surviving / introduced) * 100),
    byAgeWeeks,
    halfLifeWeeks,
    sufficientHistory,
    ...extra,
  };
}

// Merge per-repo blame-survival results into one aggregate decay curve + half-life.
export function combineBlameSurvival(results) {
  const valid = results.filter(Boolean);
  if (!valid.length) return null;
  let introduced = 0, surviving = 0, blamedFiles = 0, cappedFiles = false;
  const cohorts = new Map();
  for (const r of valid) {
    introduced += r.introduced;
    surviving += r.surviving;
    blamedFiles += r.blamedFiles || 0;
    cappedFiles = cappedFiles || !!r.cappedFiles;
    for (const b of r.byAgeWeeks) {
      if (!cohorts.has(b.ageWeeks)) cohorts.set(b.ageWeeks, { introduced: 0, surviving: 0 });
      const cw = cohorts.get(b.ageWeeks);
      cw.introduced += b.introduced;
      cw.surviving += b.surviving;
    }
  }
  if (introduced === 0) return null;
  return finalizeBlame(introduced, surviving, cohorts, { cappedFiles, blamedFiles, repos: valid.length });
}
