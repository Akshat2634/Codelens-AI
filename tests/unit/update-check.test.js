import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkForUpdate, isNewerVersion } from '../../src/update-check.js';

const okFetch = (version) => () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version }) });
const failFetch = () => Promise.reject(new Error('network down'));
const tmpCache = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'update-check-')), 'version-check.json');

test('isNewerVersion compares three-part semver numerically', () => {
  assert.equal(isNewerVersion('0.9.6', '0.9.5'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.6'), true); // numeric, not lexicographic
  assert.equal(isNewerVersion('0.9.5', '0.9.5'), false);
  assert.equal(isNewerVersion('0.9.4', '0.9.5'), false);
});

test('checkForUpdate: returns an update when the registry reports a newer version', async () => {
  const result = await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: okFetch('0.9.6'), now: () => 1000, cacheFile: tmpCache() });
  assert.deepEqual(result, { current: '0.9.5', latest: '0.9.6' });
});

test('checkForUpdate: null when already on latest', async () => {
  const result = await checkForUpdate({ currentVersion: '0.9.6', fetchImpl: okFetch('0.9.6'), now: () => 1000, cacheFile: tmpCache() });
  assert.equal(result, null);
});

test('checkForUpdate: writes a disk cache and reuses it within the TTL (no second fetch)', async () => {
  const cacheFile = tmpCache();
  let calls = 0;
  const countingFetch = (...args) => { calls++; return okFetch('0.9.6')(...args); };
  await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: countingFetch, now: () => 1000, cacheFile });
  assert.equal(calls, 1);
  const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  assert.equal(cached.latest, '0.9.6');

  const result = await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: countingFetch, now: () => 1000 + 1000, ttlMs: 24 * 60 * 60 * 1000, cacheFile });
  assert.equal(calls, 1); // served from cache, no second network hit
  assert.deepEqual(result, { current: '0.9.5', latest: '0.9.6' });
});

test('checkForUpdate: refetches once the cache is past its TTL', async () => {
  const cacheFile = tmpCache();
  let version = '0.9.6';
  const dynamicFetch = () => okFetch(version)();
  await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: dynamicFetch, now: () => 0, ttlMs: 1000, cacheFile });
  version = '0.9.7';
  const result = await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: dynamicFetch, now: () => 2000, ttlMs: 1000, cacheFile });
  assert.deepEqual(result, { current: '0.9.5', latest: '0.9.7' });
});

test('checkForUpdate: offline never hits the network and returns null without a cache', async () => {
  let calls = 0;
  const spyFetch = () => { calls++; return okFetch('0.9.6')(); };
  const result = await checkForUpdate({ currentVersion: '0.9.5', offline: true, fetchImpl: spyFetch, cacheFile: tmpCache() });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('checkForUpdate: offline still uses a fresh cache if present', async () => {
  const cacheFile = tmpCache();
  await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: okFetch('0.9.6'), now: () => 1000, cacheFile });
  const result = await checkForUpdate({ currentVersion: '0.9.5', offline: true, now: () => 1000, cacheFile });
  assert.deepEqual(result, { current: '0.9.5', latest: '0.9.6' });
});

test('checkForUpdate: network failure degrades to null, never throws', async () => {
  const result = await checkForUpdate({ currentVersion: '0.9.5', fetchImpl: failFetch, cacheFile: tmpCache() });
  assert.equal(result, null);
});

test('checkForUpdate: a non-ok HTTP response degrades to null', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.9.5',
    fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
    cacheFile: tmpCache(),
  });
  assert.equal(result, null);
});
