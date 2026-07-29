import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeGitRepo, findNestedGitRepos, normalizeRemoteUrl, resolveMovedRepoPaths } from '../../src/git-analyzer.js';

function makeRepo(root, ...segments) {
  const dir = path.join(root, ...segments);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

test('normalizeRemoteUrl canonicalizes https / ssh / scp forms to one identity', () => {
  const expected = { id: 'github.com/akshat2634/techops', slug: 'akshat2634/techops' };
  // Every clone-URL form for the same repo must map to the same identity so
  // clones/worktrees/moves collapse into one Projects entry.
  assert.deepEqual(normalizeRemoteUrl('https://github.com/Akshat2634/techops.git'), expected);
  assert.deepEqual(normalizeRemoteUrl('git@github.com:Akshat2634/techops.git'), expected);
  assert.deepEqual(normalizeRemoteUrl('ssh://git@github.com/Akshat2634/techops'), expected);
  assert.deepEqual(normalizeRemoteUrl('https://user:token@github.com/akshat2634/techops/'), expected);
  // Different owner → different identity (kept separate), even with the same name.
  assert.equal(normalizeRemoteUrl('git@github.com:someoneelse/techops.git').id, 'github.com/someoneelse/techops');
  // Empty / missing → null (repo has no origin remote → falls back to path).
  assert.equal(normalizeRemoteUrl(''), null);
  assert.equal(normalizeRemoteUrl(null), null);
});

// Real repo with tracked files, for the filesWritten corroboration path
// (git ls-files needs an actual index, not just a .git folder).
function makeGitRepo(root, segments, files) {
  const dir = path.join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  for (const f of files) {
    const fp = path.join(dir, f);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, 'x\n');
  }
  execSync('git add -A', { cwd: dir });
  return dir;
}

test('resolveMovedRepoPaths aliases a missing path to its unambiguous same-name match', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const current = makeRepo(root, 'nosync', 'aiops');
    const stale = path.join(root, 'old', 'aiops'); // never created — simulates a moved/renamed repo

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current, stale]);

    assert.equal(aliasMap.get(stale), current);
    assert.deepEqual(unresolved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths leaves an ambiguous same-name match unresolved', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const a = makeRepo(root, 'a', 'foo');
    const b = makeRepo(root, 'b', 'foo');
    const stale = path.join(root, 'c', 'foo');

    const { aliasMap, unresolved } = resolveMovedRepoPaths([a, b, stale]);

    assert.equal(aliasMap.has(stale), false);
    assert.deepEqual(unresolved, [stale]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths leaves a missing path with no name match unresolved', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const current = makeRepo(root, 'nosync', 'aiops');
    const stale = path.join(root, 'old', 'techops'); // different basename — no candidate

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current, stale]);

    assert.equal(aliasMap.has(stale), false);
    assert.deepEqual(unresolved, [stale]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths does not touch paths that already exist', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const current = makeRepo(root, 'nosync', 'aiops');

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current]);

    assert.equal(aliasMap.size, 0);
    assert.deepEqual(unresolved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths accepts a name match corroborated by filesWritten', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const current = makeGitRepo(root, ['nosync', 'api'], ['src/app.js', 'README.md']);
    const stale = path.join(root, 'old', 'api');
    const sessions = [
      { repoPath: stale, filesWritten: ['src/app.js'] },
    ];

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current, stale], sessions);

    assert.equal(aliasMap.get(stale), current);
    assert.deepEqual(unresolved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths rejects a name match contradicted by filesWritten', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    // Unrelated repo that happens to share the folder name "api".
    const current = makeGitRepo(root, ['other', 'api'], ['lib/server.py']);
    const stale = path.join(root, 'gone', 'api');
    const sessions = [
      { repoPath: stale, filesWritten: ['src/app.js', 'src/routes.js'] },
    ];

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current, stale], sessions);

    assert.equal(aliasMap.has(stale), false);
    assert.deepEqual(unresolved, [stale]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMovedRepoPaths keeps the plain name match for chat-only sessions', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-'));
  try {
    const current = makeRepo(root, 'nosync', 'api');
    const stale = path.join(root, 'old', 'api');
    // No filesWritten anywhere for the dead path — nothing to corroborate
    // with, so the unambiguous basename match stands (pre-existing behavior).
    const sessions = [
      { repoPath: stale, filesWritten: [] },
      { repoPath: current, filesWritten: ['src/app.js'] },
    ];

    const { aliasMap, unresolved } = resolveMovedRepoPaths([current, stale], sessions);

    assert.equal(aliasMap.get(stale), current);
    assert.deepEqual(unresolved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Commit with a fully controlled author identity + date, so squash-twin
// scenarios (same change, different author date) can be reproduced.
function gitCommit(dir, file, content, message, isoDate) {
  writeFileSync(path.join(dir, file), content);
  execSync('git add -A', { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.com',
      GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.com',
      GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
    },
  });
}

test('analyzeGitRepo collapses a squash-merge twin, keeping the on-main copy', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-squash-'));
  try {
    const dir = path.join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email a@b.com', { cwd: dir });
    execSync('git config user.name A', { cwd: dir });
    // Dates relative to now so they always fall inside the lookback window,
    // regardless of the machine clock.
    const base = new Date(Date.now() - 5 * 86400000);
    const iso = (m) => new Date(base.getTime() + m * 60000).toISOString();

    gitCommit(dir, 'base.txt', 'base\n', 'base', iso(0));
    // Off-main feature-branch copy.
    execSync('git checkout -q -b feature', { cwd: dir });
    gitCommit(dir, 'shared.txt', 'hello\n', 'add shared feature', iso(60));
    // Squash copy on main: identical diffstat (shared.txt +1/-0), subject gains a
    // " (#123)" PR suffix, author date drifts 2 minutes — exactly what GitHub's
    // "Squash and merge" produces. The exact-%aI first pass misses it.
    execSync('git checkout -q main', { cwd: dir });
    gitCommit(dir, 'shared.txt', 'hello\n', 'add shared feature (#123)', iso(62));

    const { commits } = analyzeGitRepo(dir, 3650);
    const twins = commits.filter(c => c.subject.startsWith('add shared feature'));
    assert.equal(twins.length, 1, 'the squash twin should be deduped to a single commit');
    assert.equal(twins[0].onMain, true, 'the surviving copy is the on-main one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeGitRepo records the containing branch name for off-main commits', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-branch-'));
  try {
    const dir = path.join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email a@b.com', { cwd: dir });
    execSync('git config user.name A', { cwd: dir });
    const base = new Date(Date.now() - 5 * 86400000);
    const iso = (m) => new Date(base.getTime() + m * 60000).toISOString();

    gitCommit(dir, 'base.txt', 'base\n', 'base', iso(0));
    execSync('git checkout -q -b feature/PLA-1-branch-names', { cwd: dir });
    gitCommit(dir, 'feat.txt', 'work\n', 'feature work', iso(60));

    const { commits } = analyzeGitRepo(dir, 3650);
    const featureCommit = commits.find(c => c.subject === 'feature work');
    assert.equal(featureCommit.onMain, false);
    assert.equal(featureCommit.branch, 'feature/PLA-1-branch-names',
      'off-main commits carry the full refs/heads/-stripped branch name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeGitRepo does NOT merge same-subject commits with different diffstats', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-squash-'));
  try {
    const dir = path.join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email a@b.com', { cwd: dir });
    execSync('git config user.name A', { cwd: dir });
    const base = new Date(Date.now() - 5 * 86400000);
    const iso = (m) => new Date(base.getTime() + m * 60000).toISOString();

    gitCommit(dir, 'base.txt', 'base\n', 'base', iso(0));
    execSync('git checkout -q -b feature', { cwd: dir });
    gitCommit(dir, 'x.txt', 'a\nb\n', 'shared work', iso(60)); // +2 lines
    execSync('git checkout -q main', { cwd: dir });
    gitCommit(dir, 'x.txt', 'a\n', 'shared work (#9)', iso(62)); // +1 line — different diffstat

    const { commits } = analyzeGitRepo(dir, 3650);
    const both = commits.filter(c => c.subject.startsWith('shared work'));
    assert.equal(both.length, 2, 'commits sharing a subject but with different diffstats must not be collapsed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeGitRepo detects agent Co-authored-by trailers as aiTrailer', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-trailer-'));
  try {
    const dir = path.join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email a@b.com', { cwd: dir });
    execSync('git config user.name A', { cwd: dir });
    const base = new Date(Date.now() - 5 * 86400000);
    const iso = (m) => new Date(base.getTime() + m * 60000).toISOString();

    // Multi-line messages need separate -m flags — a JSON-quoted "\n" inside
    // a shell string stays a literal backslash-n and never becomes a trailer.
    const commitWithTrailer = (file, subject, trailer, isoDate) => {
      writeFileSync(path.join(dir, file), file + '\n');
      execSync('git add -A', { cwd: dir });
      const msgFlags = trailer
        ? `-m ${JSON.stringify(subject)} -m ${JSON.stringify(trailer)}`
        : `-m ${JSON.stringify(subject)}`;
      execSync(`git commit -q ${msgFlags}`, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.com',
          GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.com',
          GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
        },
      });
    };
    // Claude Code-style trailer (name varies by model; domain is stable)
    commitWithTrailer('a.txt', 'add a', 'Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>', iso(0));
    // Codex-style trailer
    commitWithTrailer('b.txt', 'add b', 'Co-authored-by: Codex <codex@openai.com>', iso(10));
    // Human co-author — must NOT be flagged as an agent
    commitWithTrailer('c.txt', 'add c', 'Co-authored-by: Bob Smith <bob@example.com>', iso(20));
    // No trailer at all
    commitWithTrailer('d.txt', 'add d', null, iso(30));
    // Generic CI automation — not an AI coding agent
    commitWithTrailer('f.txt', 'add f', 'Co-authored-by: github-actions[bot] <github-actions[bot]@users.noreply.github.com>', iso(35));
    // A HUMAN named Claude — a bare first name must never count as an AI stamp
    commitWithTrailer('g.txt', 'add g', 'Co-authored-by: Claude Martin <claude@example.fr>', iso(38));
    // Pipe in the subject must not break field parsing
    commitWithTrailer('e.txt', 'add e | with pipes | everywhere', 'Co-Authored-By: Claude <noreply@anthropic.com>', iso(40));

    const { commits } = analyzeGitRepo(dir, 3650);
    const bySubject = Object.fromEntries(commits.map(c => [c.subject, c]));
    assert.equal(bySubject['add a'].aiTrailer, 'claude');
    assert.equal(bySubject['add b'].aiTrailer, 'codex');
    assert.equal(bySubject['add c'].aiTrailer, null);
    assert.equal(bySubject['add d'].aiTrailer, null);
    assert.equal(bySubject['add f'].aiTrailer, null, 'github-actions[bot] is not an AI agent');
    assert.equal(bySubject['add g'].aiTrailer, null, 'a human named Claude is not an AI stamp');
    const piped = commits.find(c => c.subject.includes('with pipes'));
    assert.equal(piped.subject, 'add e | with pipes | everywhere', 'pipes in subject survive parsing');
    assert.equal(piped.aiTrailer, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos discovers direct-child repos at depth 1', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    const a = makeRepo(root, 'repo-a');
    const b = makeRepo(root, 'repo-b');
    const found = findNestedGitRepos(root, 1);
    assert.deepEqual(new Set(found), new Set([a, b]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos respects max depth', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    // repo at depth 3: root/lvl1/lvl2/repo
    const deep = makeRepo(root, 'lvl1', 'lvl2', 'deep-repo');
    assert.deepEqual(findNestedGitRepos(root, 2), [], 'depth 2 does not find repo at depth 3');
    assert.deepEqual(findNestedGitRepos(root, 3), [deep], 'depth 3 finds it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos skips node_modules, virtualenv, hidden dirs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    // Bogus repos in dirs that must be ignored — every npm package with a
    // stray .git would otherwise show up.
    makeRepo(root, 'node_modules', 'some-pkg');
    makeRepo(root, '.venv', 'lib');
    makeRepo(root, '.hidden', 'secret-repo');
    const good = makeRepo(root, 'legit-repo');
    assert.deepEqual(findNestedGitRepos(root, 3), [good]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos does not follow symlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    const real = makeRepo(root, 'real-repo');
    // Symlink pointing back at root would cycle if followed.
    try {
      symlinkSync(root, path.join(root, 'link-back'));
    } catch {
      return; // symlink perms unavailable — skip this assertion
    }
    const found = findNestedGitRepos(root, 3);
    assert.deepEqual(found, [real]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos does not recurse INTO a discovered repo', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    const outer = makeRepo(root, 'outer');
    // A repo inside a repo — submodule/worktree; must not be reported.
    makeRepo(root, 'outer', 'inner');
    const found = findNestedGitRepos(root, 3);
    assert.deepEqual(found, [outer]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos returns [] for missing / invalid input', () => {
  assert.deepEqual(findNestedGitRepos(null, 1), []);
  assert.deepEqual(findNestedGitRepos('/nonexistent-path-xyz-12345', 1), []);
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    assert.deepEqual(findNestedGitRepos(root, 0), [], 'depth 0 is off');
    assert.deepEqual(findNestedGitRepos(root, -1), [], 'negative depth is off');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos skips .claude/worktrees (they resolve to the outer repo already)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    // Real git worktrees mark themselves with a `.git` FILE (not a directory)
    // pointing back at the main repo's git dir — existsSync doesn't
    // distinguish, so the walk must special-case the `worktrees` dir itself.
    const worktreeDir = path.join(root, '.claude', 'worktrees', 'feature-x');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(path.join(worktreeDir, '.git'), 'gitdir: /some/other/repo/.git/worktrees/feature-x\n');
    const good = makeRepo(root, 'legit-repo');
    const found = findNestedGitRepos(root, 3);
    assert.deepEqual(found, [good]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findNestedGitRepos still finds a real repo under an unrelated "worktrees"-named dir', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nested-repos-'));
  try {
    // The .claude/worktrees skip must be scoped to that exact parent — a
    // project directory that happens to be named "worktrees" elsewhere in
    // the tree is unrelated and must still be discovered.
    const repo = makeRepo(root, 'myproject', 'worktrees', 'some-repo');
    const found = findNestedGitRepos(root, 3);
    assert.deepEqual(found, [repo]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeGitRepo --since/--until: excludes commits authored before --since or after --until', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-analyzer-until-'));
  try {
    const dir = path.join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email a@b.com', { cwd: dir });
    execSync('git config user.name A', { cwd: dir });

    gitCommit(dir, 'before.txt', 'a\n', 'before range', '2026-05-15T12:00:00Z');
    gitCommit(dir, 'in-range.txt', 'b\n', 'in range', '2026-06-15T12:00:00Z');
    gitCommit(dir, 'after.txt', 'c\n', 'after range', '2026-07-15T12:00:00Z');

    const { commits } = analyzeGitRepo(dir, null, '2026-06-01', '2026-06-30');
    assert.equal(commits.length, 1, 'only the June commit survives the --since/--until filter');
    assert.equal(commits[0].subject, 'in range');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
