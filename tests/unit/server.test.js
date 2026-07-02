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

async function withServer(fn) {
  const app = createServer({ summary: {}, meta: {} }, null);
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
