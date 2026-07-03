import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeGitRepo, resolveMovedRepoPaths } from '../../src/git-analyzer.js';

function makeRepo(root, ...segments) {
  const dir = path.join(root, ...segments);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

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
