import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const vendored = path.join(repoRoot, 'src', 'vendor', 'chart.umd.min.js');

// Regression guard for the v0.8.20 production failure: the dashboard loads
// Chart.js from /vendor/chart.umd.min.js, and when that asset couldn't be
// served the whole dashboard rendered blank with an unhandled 404. These tests
// assert the bundle is vendored into the package and that the server actually
// serves it — in-tree, on every CI Node version. The end-to-end "does it still
// work once packed and installed" guard lives in scripts/smoke-package.mjs.

test('Chart.js UMD bundle is vendored into the package', () => {
  assert.ok(
    existsSync(vendored),
    'src/vendor/chart.umd.min.js is missing — run `npm run vendor:chart`'
  );
  assert.ok(
    statSync(vendored).size > 50_000,
    'vendored chart.umd.min.js looks too small to be the real Chart.js bundle'
  );
});

async function withServer(fn, opts) {
  const app = createServer({ summary: {}, meta: {} }, null, opts);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET / serves the dashboard and references the vendored chart script', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(
      body,
      /\/vendor\/chart\.umd\.min\.js/,
      'dashboard should load Chart.js from the vendored path'
    );
  });
});

test('GET /vendor/chart.umd.min.js serves the real bundle (200, JS)', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/vendor/chart.umd.min.js`);
    // A non-200 here is exactly the production bug: a blank dashboard.
    assert.equal(res.status, 200, 'Chart.js bundle must serve with 200');
    assert.match(res.headers.get('content-type') || '', /javascript/);
    const body = await res.text();
    assert.ok(body.length > 50_000, 'served chart bundle is too small');
    assert.match(body, /Chart\.js v\d/, 'served content is not the Chart.js UMD bundle');
  });
});

// The v0.8.22 incident: the chart bundle was gone at request time (a partial
// npx cache mid-extraction), and the route threw an unhandled error — an ugly
// 404 stack trace on stderr instead of a response. The route now reads the
// bundle into memory at boot, so if it can't, it must degrade to a clean,
// actionable 500 and never throw. Point the route at a nonexistent file to
// prove that path is handled rather than exploding.
test('GET /vendor/chart.umd.min.js degrades to a clean 500 when the bundle is unavailable', async () => {
  const missing = path.join(repoRoot, 'src', 'vendor', 'does-not-exist.js');
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/vendor/chart.umd.min.js`);
    assert.equal(res.status, 500, 'must return a handled 500, not throw or 404');
    const body = await res.text();
    assert.match(body, /reinstall/i, 'the 500 should tell the user how to recover');
  }, { chartJsPath: missing });
});

// ── Multi-agent source views ──
// The server holds one payload per agent source ({ all, claude, codex }) and
// routes select a view via ?source=. A bare single payload (the pre-Codex
// shape) must keep working, and unknown sources must fall back to `all`.

const mkPayload = (source) => ({
  meta: { source, sources: { claude: 2, codex: 1 } },
  summary: { totalCost: source === 'claude' ? 10 : source === 'codex' ? 5 : 15 },
  insights: [],
  daily: [{ date: '2026-07-01', cost: 1 }],
  sessions: [{ sessionId: `${source}-session`, source, cost: { totalCost: 1 }, commits: [], startTime: '2026-07-01T00:00:00Z', userMessageCount: 1, assistantMessageCount: 1 }],
  modelBreakdown: { [source]: { cost: 1 } },
});

async function withSourceServer(fn) {
  const payloads = { all: mkPayload('all'), claude: mkPayload('claude'), codex: mkPayload('codex') };
  const app = createServer(payloads, null, { chartJsPath: null });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/all?source= selects the per-agent view and falls back to all', async () => {
  await withSourceServer(async (port) => {
    const all = await (await fetch(`http://127.0.0.1:${port}/api/all`)).json();
    assert.equal(all.meta.source, 'all');
    assert.equal(all.summary.totalCost, 15);

    const claude = await (await fetch(`http://127.0.0.1:${port}/api/all?source=claude`)).json();
    assert.equal(claude.meta.source, 'claude');
    assert.equal(claude.summary.totalCost, 10);

    const codex = await (await fetch(`http://127.0.0.1:${port}/api/all?source=codex`)).json();
    assert.equal(codex.meta.source, 'codex');
    assert.equal(codex.summary.totalCost, 5);

    // Unknown source → all view, not an error
    const bogus = await (await fetch(`http://127.0.0.1:${port}/api/all?source=cursor`)).json();
    assert.equal(bogus.meta.source, 'all');

    // Prototype keys must not resolve through the payload map
    for (const probe of ['constructor', '__proto__', 'hasOwnProperty']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/all?source=${probe}`);
      assert.equal(res.status, 200, `?source=${probe} must not error`);
      assert.equal((await res.json()).meta.source, 'all');
    }

    // Repeated params arrive as an array — must fall back, not crash
    const arr = await (await fetch(`http://127.0.0.1:${port}/api/all?source=claude&source=codex`)).json();
    assert.equal(arr.meta.source, 'all');
  });
});

test('per-source selection applies to sub-resource routes too', async () => {
  await withSourceServer(async (port) => {
    const models = await (await fetch(`http://127.0.0.1:${port}/api/models?source=codex`)).json();
    assert.deepEqual(Object.keys(models), ['codex']);

    const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions?source=codex`)).json();
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].sessionId, 'codex-session');

    const summary = await (await fetch(`http://127.0.0.1:${port}/api/summary?source=claude`)).json();
    assert.equal(summary.totalCost, 10);
  });
});

test('a bare single payload (pre-Codex shape) still serves on every route', async () => {
  const app = createServer({ summary: { totalCost: 7 }, meta: {}, insights: [], sessions: [], modelBreakdown: {} }, null, { chartJsPath: null });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const all = await (await fetch(`http://127.0.0.1:${port}/api/all`)).json();
    assert.equal(all.summary.totalCost, 7);
    // ?source= on a single-payload server falls back to that payload
    const src = await (await fetch(`http://127.0.0.1:${port}/api/all?source=codex`)).json();
    assert.equal(src.summary.totalCost, 7);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
