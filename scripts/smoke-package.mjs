#!/usr/bin/env node
// Production-fidelity smoke test: pack the package exactly as it publishes,
// install it into a clean directory WITHOUT devDependencies (so chart.js is
// absent — mirroring an `npx codelens-ai` install), boot the CLI, and assert
// the dashboard and the vendored Chart.js bundle both serve.
//
// This reproduces the v0.8.20 failure end-to-end: the dashboard depended on
// chart.js being resolvable at the user's runtime, but npx shipped a partial
// chart.js and /vendor/chart.umd.min.js 404'd into a blank dashboard. Run in
// CI (`npm run test:package`) so a regression can't reach npm again.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const fixtures = path.join(repoRoot, 'tests', 'fixtures', 'claude-projects');
const codexFixtures = path.join(repoRoot, 'tests', 'fixtures', 'codex-sessions');
const PORT = 39217;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

const fail = (msg) => {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'codelens-smoke-'));
let server;
try {
  // 1. Refresh the vendored asset and pack exactly what publishes.
  run('npm', ['run', 'vendor:chart'], { cwd: repoRoot, stdio: 'inherit' });
  const packOut = run('npm', ['pack', '--silent'], { cwd: repoRoot }).trim();
  const tarball = packOut.split('\n').pop().trim();
  const tarballPath = path.join(repoRoot, tarball);
  console.log(`  • packed ${tarball}`);

  // 2. Install into a clean dir with production deps only (no devDeps →
  //    chart.js is NOT installed, exactly like a real `npx` install).
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  run('npm', ['install', tarballPath, '--omit=dev', '--no-audit', '--no-fund'], { cwd: tmp, stdio: 'inherit' });
  rmSync(tarballPath, { force: true });

  const installed = path.join(tmp, 'node_modules', 'codelens-ai');
  const bundled = path.join(installed, 'src', 'vendor', 'chart.umd.min.js');
  if (!existsSync(bundled)) fail('vendored chart.umd.min.js was not included in the published package');
  if (existsSync(path.join(tmp, 'node_modules', 'chart.js'))) {
    fail('chart.js was installed as a runtime dependency — it must be a devDependency (the bundle is vendored)');
  }
  console.log('  • installed package: chart.js absent, vendored bundle present');

  // 3. Boot the installed CLI against fixtures. --days 3650 so the fixture
  //    sessions (dated months back) fall inside the window and the server
  //    actually starts.
  server = spawn(
    'node',
    [path.join(installed, 'src', 'index.js'), '--no-open', '--port', String(PORT), '--days', '3650', '--claude-dir', fixtures, '--codex-dir', codexFixtures],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  // 4. Wait for the server to answer, then assert the routes.
  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 25_000;
  let up = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) fail(`server exited early (code ${server.exitCode}):\n${serverLog}`);
    try {
      const r = await fetch(`${base}/`);
      if (r.status === 200) { up = true; break; }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!up) fail(`server never became ready within 25s:\n${serverLog}`);

  const dash = await fetch(`${base}/`);
  if (dash.status !== 200) fail(`GET / returned ${dash.status}`);

  // The packed parsers must actually load the fixture sessions — both agents.
  const payload = await (await fetch(`${base}/api/all`)).json();
  if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    fail('packed CLI served an empty payload — no sessions parsed from fixtures');
  }
  const sources = payload.meta?.sources || {};
  if (!(sources.claude > 0)) fail('packed CLI parsed no Claude fixture sessions');
  if (!(sources.codex > 0)) fail('packed CLI parsed no Codex fixture sessions');
  console.log(`  • packed parsers loaded ${sources.claude} claude + ${sources.codex} codex fixture sessions`);

  const chart = await fetch(`${base}/vendor/chart.umd.min.js`);
  if (chart.status !== 200) fail(`GET /vendor/chart.umd.min.js returned ${chart.status} — this is the blank-dashboard bug`);
  const ct = chart.headers.get('content-type') || '';
  if (!/javascript/.test(ct)) fail(`chart bundle served with wrong content-type: ${ct}`);
  const body = await chart.text();
  if (body.length < 50_000 || !/Chart\.js v\d/.test(body)) fail('served chart bundle is not the real Chart.js UMD file');

  console.log(`  ✓ dashboard + vendored Chart.js serve from a clean install (${(body.length / 1024).toFixed(0)}KB, ${ct.split(';')[0]})`);
  console.log('\n  ✓ package smoke test passed');
} finally {
  if (server && server.exitCode === null) server.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}
