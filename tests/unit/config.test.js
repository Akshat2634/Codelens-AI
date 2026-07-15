import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteCache, loadCache, saveCache } from '../../src/cache.js';
import { __resetPricingOverridesForTest, getPricingOverride, loadConfig } from '../../src/config.js';

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), 'codelens-config-'));
const writeJson = (dir, name, obj) => {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(obj));
  return file;
};

// No user/project config exists at these paths — loadConfig must treat both as absent.
function missingPaths(dir) {
  return { userConfigPath: path.join(dir, 'no-user.json'), projectConfigPath: path.join(dir, 'no-project.json') };
}

function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('loadConfig: no files present returns built-in-ish defaults', () => {
  const dir = tmpDir();
  const cfg = loadConfig(missingPaths(dir));
  assert.equal(cfg.days, undefined);
  assert.equal(cfg.port, undefined);
  assert.deepEqual(cfg.pricingOverrides, {});
  assert.equal(cfg.pricingOverridesHash, null);
  assert.equal(cfg.loaded.user, false);
  assert.equal(cfg.loaded.project, false);
  __resetPricingOverridesForTest();
});

test('loadConfig: reports which of user/project config files were actually found', () => {
  const dir = tmpDir();
  // Neither present.
  const { userConfigPath, projectConfigPath } = missingPaths(dir);
  const neither = loadConfig({ userConfigPath, projectConfigPath });
  assert.deepEqual(neither.loaded, { user: false, project: false });
  assert.deepEqual(neither.configPaths, { user: userConfigPath, project: projectConfigPath });

  // Only the user config present.
  const realUserPath = writeJson(dir, 'user-only.json', { days: 1 });
  const userOnly = loadConfig({ userConfigPath: realUserPath, projectConfigPath });
  assert.deepEqual(userOnly.loaded, { user: true, project: false });

  // Both present.
  const realProjectPath = writeJson(dir, 'project-only.json', { days: 2 });
  const both = loadConfig({ userConfigPath: realUserPath, projectConfigPath: realProjectPath });
  assert.deepEqual(both.loaded, { user: true, project: true });
  __resetPricingOverridesForTest();
});

test('loadConfig: project config overrides user config for scalar keys', () => {
  const dir = tmpDir();
  const userConfigPath = writeJson(dir, 'user.json', { days: 14, port: 4000 });
  const projectConfigPath = writeJson(dir, 'project.json', { days: 7 });
  const cfg = loadConfig({ userConfigPath, projectConfigPath });
  assert.equal(cfg.days, 7); // project wins
  assert.equal(cfg.port, 4000); // falls through from user, untouched by project
  __resetPricingOverridesForTest();
});

test('loadConfig: pricingOverrides merge per-model, project wins on shared keys', () => {
  const dir = tmpDir();
  const userConfigPath = writeJson(dir, 'user.json', {
    pricingOverrides: { 'model-a': { input: 1, output: 2 }, 'model-b': { input: 3, output: 4 } },
  });
  const projectConfigPath = writeJson(dir, 'project.json', {
    pricingOverrides: { 'model-b': { input: 30, output: 40 }, 'model-c': { input: 5, output: 6 } },
  });
  const cfg = loadConfig({ userConfigPath, projectConfigPath });
  assert.equal(cfg.pricingOverrides['model-a'].input, 1); // user-only entry still comes through
  assert.equal(cfg.pricingOverrides['model-b'].input, 30); // project wins on the shared key
  assert.equal(cfg.pricingOverrides['model-c'].input, 5); // project-only entry
  __resetPricingOverridesForTest();
});

test('loadConfig: omitted cacheRead/cacheWrite fall back to the standard ratios', () => {
  const dir = tmpDir();
  const { userConfigPath } = missingPaths(dir);
  const projectConfigPath = writeJson(dir, 'project.json', {
    pricingOverrides: { 'my-internal-model': { input: 0.1, output: 0.4 } },
  });
  const cfg = loadConfig({ userConfigPath, projectConfigPath });
  const rate = cfg.pricingOverrides['my-internal-model'];
  assert.ok(Math.abs(rate.cacheRead - 0.01) < 1e-9, `cacheRead: ${rate.cacheRead}`); // 0.1x input
  assert.ok(Math.abs(rate.cacheWrite - 0.125) < 1e-9, `cacheWrite: ${rate.cacheWrite}`); // 1.25x input
  __resetPricingOverridesForTest();
});

test('loadConfig: an unknown top-level key warns but does not crash', () => {
  const dir = tmpDir();
  const { userConfigPath } = missingPaths(dir);
  const projectConfigPath = writeJson(dir, 'project.json', { bogusKey: 1, days: 5 });
  let cfg;
  const lines = captureConsoleError(() => { cfg = loadConfig({ userConfigPath, projectConfigPath }); });
  assert.ok(lines.some(l => l.includes('bogusKey') && l.includes(projectConfigPath)));
  assert.equal(cfg.days, 5); // rest of the file still loads
  assert.equal(cfg.bogusKey, undefined);
  __resetPricingOverridesForTest();
});

test('loadConfig: a pricingOverrides entry missing input/output warns and is skipped', () => {
  const dir = tmpDir();
  const { userConfigPath } = missingPaths(dir);
  const projectConfigPath = writeJson(dir, 'project.json', {
    pricingOverrides: { 'bad-model': { input: 'not-a-number' }, 'good-model': { input: 1, output: 2 } },
  });
  let cfg;
  const lines = captureConsoleError(() => { cfg = loadConfig({ userConfigPath, projectConfigPath }); });
  assert.ok(lines.some(l => l.includes('bad-model')));
  assert.equal(cfg.pricingOverrides['bad-model'], undefined);
  assert.equal(cfg.pricingOverrides['good-model'].input, 1);
  __resetPricingOverridesForTest();
});

test('loadConfig: malformed JSON throws a friendly error naming the file', () => {
  const dir = tmpDir();
  const { userConfigPath } = missingPaths(dir);
  const projectConfigPath = path.join(dir, 'project.json');
  writeFileSync(projectConfigPath, '{ bad json');
  assert.throws(
    () => loadConfig({ userConfigPath, projectConfigPath }),
    (err) => err instanceof Error && err.message.includes(projectConfigPath) && err.message.includes('Malformed JSON'),
  );
});

test('getPricingOverride matches exact, date-stripped, and longest-prefix ids, same as the LiteLLM overlay', () => {
  const dir = tmpDir();
  const { userConfigPath } = missingPaths(dir);
  const projectConfigPath = writeJson(dir, 'project.json', {
    pricingOverrides: {
      'gpt-9': { input: 2, output: 8 },
      'gpt-9-turbo': { input: 3, output: 9 },
    },
  });
  loadConfig({ userConfigPath, projectConfigPath });
  assert.equal(getPricingOverride('gpt-9').input, 2); // exact
  assert.equal(getPricingOverride('gpt-9-20270101').input, 2); // date-stripped
  assert.equal(getPricingOverride('gpt-9-turbo-preview').input, 3); // longest-prefix
  assert.equal(getPricingOverride('mistral-large'), null); // no match
  __resetPricingOverridesForTest();
});

test('getPricingOverride is null once reset', () => {
  __resetPricingOverridesForTest();
  assert.equal(getPricingOverride('gpt-9'), null);
});

// ── cache invalidation on overridesHash (src/cache.js has no dedicated test file yet) ──

test('cache: same overridesHash (including both null/unconfigured) is a cache hit', () => {
  const opts = { days: 30, claudeDir: '/fake/claude-config-test-a', codexDir: '/fake/codex-config-test-a' };
  try {
    saveCache([], {}, {}, opts); // no overridesHash at all — the zero-config case
    assert.ok(loadCache(opts), 'zero-config users must not see a forced cache miss');
  } finally {
    deleteCache(opts);
  }
});

test('cache: changing overridesHash invalidates the cache', () => {
  const base = { days: 30, claudeDir: '/fake/claude-config-test-b', codexDir: '/fake/codex-config-test-b' };
  try {
    saveCache([], {}, {}, { ...base, overridesHash: 'abc123' });
    assert.equal(loadCache({ ...base, overridesHash: 'def456' }), null, 'a different overridesHash must miss');
    assert.ok(loadCache({ ...base, overridesHash: 'abc123' }), 'the same overridesHash must still hit');
  } finally {
    deleteCache({ ...base, overridesHash: 'abc123' });
  }
});
