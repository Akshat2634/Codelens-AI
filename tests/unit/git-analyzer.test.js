import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveMovedRepoPaths } from '../../src/git-analyzer.js';

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
