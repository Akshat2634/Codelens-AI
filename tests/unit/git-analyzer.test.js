import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveMovedRepoPaths } from '../../src/git-analyzer.js';

function makeRepo(root, ...segments) {
  const dir = path.join(root, ...segments);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
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
