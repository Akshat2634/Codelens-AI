import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  __resetOverlayForTest,
  __setOverlayForTest,
  loadPricingOverlay,
  lookupExternalRate,
  normalizeExternalId,
  overlayInfo,
} from '../../src/pricing.js';

// A minimal LiteLLM-shaped map (per-TOKEN costs, like the real file).
const FAKE_LITELLM = {
  'gpt-9': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008, cache_read_input_token_cost: 0.0000005, litellm_provider: 'openai' },
  'claude-opus-9': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025, cache_creation_input_token_cost: 0.00000625, cache_read_input_token_cost: 0.0000005, litellm_provider: 'anthropic' },
  'text-embedding-3': { input_cost_per_token: 0.00000002 }, // no output price → skipped
};
const okFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(FAKE_LITELLM) });
const failFetch = () => Promise.reject(new Error('network down'));
const tmpCache = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'pricing-')), 'pricing.json');

test('normalizeExternalId strips markers, provider prefix, and lowercases', () => {
  assert.equal(normalizeExternalId('claude-opus-4-8-20250601[fast][us]'), 'claude-opus-4-8-20250601');
  assert.equal(normalizeExternalId('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(normalizeExternalId('OpenAI/GPT-5'), 'gpt-5');
  assert.equal(normalizeExternalId(null), '');
});

test('lookupExternalRate: null when no overlay is loaded', () => {
  __resetOverlayForTest();
  assert.equal(lookupExternalRate('gpt-9'), null);
});

test('lookupExternalRate: exact, date-stripped, and longest-prefix matches', () => {
  __setOverlayForTest({ 'gpt-9': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }, 'gpt-9-turbo': { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 } });
  assert.equal(lookupExternalRate('gpt-9').input, 2); // exact
  assert.equal(lookupExternalRate('gpt-9-20270101').input, 2); // date-stripped
  assert.equal(lookupExternalRate('gpt-9-turbo').input, 3); // longest prefix wins over 'gpt-9'
  assert.equal(lookupExternalRate('gpt-9-turbo-preview').input, 3); // prefix match
  assert.equal(lookupExternalRate('mistral-large'), null); // no match
  __resetOverlayForTest();
});

test('loadPricingOverlay: network builds a per-MILLION overlay and writes cache', async () => {
  const cacheFile = tmpCache();
  try {
    const info = await loadPricingOverlay({ fetchImpl: okFetch, now: () => 1000, cacheFile });
    assert.equal(info.source, 'network');
    // per-token 0.000002 → per-million 2
    const r = lookupExternalRate('gpt-9');
    assert.equal(r.input, 2);
    assert.equal(r.output, 8);
    assert.equal(r.cacheRead, 0.5);
    // cache_creation absent for gpt-9 → default 1.25× input
    assert.equal(r.cacheWrite, 2.5);
    // anthropic entry carries a real cache_creation → 6.25
    assert.equal(lookupExternalRate('claude-opus-9').cacheWrite, 6.25);
    // embedding entry (no output price) is skipped
    assert.equal(lookupExternalRate('text-embedding-3'), null);
    // cache file persisted with the injected timestamp
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    assert.equal(onDisk.fetchedAt, 1000);
    assert.ok(onDisk.models['gpt-9']);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: a fresh cache is used without refetching', async () => {
  const cacheFile = tmpCache();
  try {
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 5000, models: FAKE_LITELLM }));
    let fetched = false;
    const info = await loadPricingOverlay({ fetchImpl: () => { fetched = true; return okFetch(); }, now: () => 5000 + 1000, cacheFile });
    assert.equal(info.source, 'cache');
    assert.equal(fetched, false, 'fresh cache must not hit the network');
    assert.equal(lookupExternalRate('gpt-9').input, 2);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: refresh refetches even with a fresh cache', async () => {
  const cacheFile = tmpCache();
  try {
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 5000, models: {} }));
    let fetched = false;
    await loadPricingOverlay({ refresh: true, fetchImpl: () => { fetched = true; return okFetch(); }, now: () => 5000 + 10, cacheFile });
    assert.equal(fetched, true);
    assert.equal(lookupExternalRate('gpt-9').input, 2);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: offline uses the cache and never fetches', async () => {
  const cacheFile = tmpCache();
  try {
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 1, models: FAKE_LITELLM }));
    let fetched = false;
    const info = await loadPricingOverlay({ offline: true, fetchImpl: () => { fetched = true; return okFetch(); }, cacheFile });
    assert.equal(fetched, false);
    assert.equal(info.source, 'cache');
    assert.equal(lookupExternalRate('gpt-9').input, 2);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: offline with no cache disables the overlay (graceful)', async () => {
  const cacheFile = tmpCache(); // dir exists but no pricing.json content yet
  rmSync(cacheFile, { force: true });
  try {
    const info = await loadPricingOverlay({ offline: true, cacheFile });
    assert.equal(info.source, 'disabled');
    assert.equal(lookupExternalRate('gpt-9'), null); // parsers fall back to hardcoded
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: network failure degrades to the cache', async () => {
  const cacheFile = tmpCache();
  try {
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 1, models: FAKE_LITELLM }));
    const info = await loadPricingOverlay({ refresh: true, fetchImpl: failFetch, cacheFile });
    assert.equal(info.source, 'cache');
    assert.equal(lookupExternalRate('gpt-9').input, 2);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});

test('loadPricingOverlay: network failure with no cache disables gracefully', async () => {
  const cacheFile = tmpCache();
  rmSync(cacheFile, { force: true });
  try {
    const info = await loadPricingOverlay({ refresh: true, fetchImpl: failFetch, cacheFile });
    assert.equal(info.source, 'disabled');
    assert.equal(overlayInfo().models, 0);
  } finally {
    rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    __resetOverlayForTest();
  }
});
