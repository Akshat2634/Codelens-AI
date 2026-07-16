import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/index.js', import.meta.url));

// HOME is pointed at a temp dir so cache reads/writes (os.homedir()-based)
// never touch the user's real ~/.cache/agent-analytics.
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('rejects non-integer --days before doing any work', () => {
  const r = runCli(['--days', 'abc']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--days must be a positive integer/);
});

test('rejects zero and negative --days', () => {
  for (const bad of ['0', '-5']) {
    const r = runCli([`--days=${bad}`]);
    assert.equal(r.status, 1, `--days=${bad} should exit 1`);
    assert.match(r.stderr, /--days must be a positive integer/);
  }
});

test('rejects out-of-range and non-integer --port', () => {
  for (const bad of ['abc', '0', '70000']) {
    const r = runCli([`--port=${bad}`]);
    assert.equal(r.status, 1, `--port=${bad} should exit 1`);
    assert.match(r.stderr, /--port must be an integer between 1 and 65535/);
  }
});

test('rejects an unknown --source value', () => {
  const r = runCli(['--source', 'bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown --source "bogus"/);
});

test('rejects --days combined with --since/--until', () => {
  for (const args of [
    ['--days', '30', '--since', '2026-06-01'],
    ['--days', '30', '--until', '2026-06-30'],
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.match(r.stderr, /--days cannot be combined with --since\/--until/);
  }
});

test('rejects a malformed --since or --until date', () => {
  for (const [flag, bad] of [['--since', '2026/06/01'], ['--until', 'not-a-date'], ['--since', '2026-13-40']]) {
    const r = runCli([flag, bad]);
    assert.equal(r.status, 1, `${flag} ${bad}`);
    assert.match(r.stderr, new RegExp(`${flag} must be YYYY-MM-DD`));
  }
});

test('rejects --until before --since', () => {
  const r = runCli(['--since', '2026-06-30', '--until', '2026-06-01']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--until \(2026-06-01\) is before --since \(2026-06-30\)/);
});

test('rejects an unknown --tz value', () => {
  const r = runCli(['--tz', 'Not/AZone']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown --tz "Not\/AZone"/);
});

test('accepts a valid --since/--until/--tz combination (no --days conflict)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-validation-'));
  try {
    const claudeDir = path.join(root, 'claude-projects');
    const codexDir = path.join(root, 'codex-sessions');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const r = runCli(
      ['--json', '--since', '2026-06-01', '--until', '2026-06-30', '--tz', 'America/New_York', '--claude-dir', claudeDir, '--codex-dir', codexDir],
      { HOME: root }
    );
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /--days|--since|--until|--tz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--json with zero sessions writes the literal null to stdout, progress to stderr', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-validation-'));
  try {
    const claudeDir = path.join(root, 'claude-projects');
    const codexDir = path.join(root, 'codex-sessions');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    // --source all must be accepted as the no-filter default (matches the
    // ?source=all name every API route uses).
    const r = runCli(
      ['--json', '--source', 'all', '--claude-dir', claudeDir, '--codex-dir', codexDir],
      { HOME: root }
    );

    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'null');
    assert.equal(JSON.parse(r.stdout), null);
    assert.doesNotMatch(r.stderr, /Unknown --source/);
    assert.match(r.stderr, /No AI coding agent sessions found/);
    // The hint must name the directories actually scanned, not the defaults.
    assert.ok(r.stderr.includes(claudeDir));
    assert.ok(r.stderr.includes(codexDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warns on stderr (without exiting) when an explicit override dir does not exist', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-validation-'));
  try {
    const claudeDir = path.join(root, 'claude-projects');
    mkdirSync(claudeDir, { recursive: true });
    const missingCodexDir = path.join(root, 'nope', 'codex-sessions');

    const r = runCli(
      ['--json', '--claude-dir', claudeDir, '--codex-dir', missingCodexDir],
      { HOME: root }
    );

    assert.equal(r.status, 0);
    assert.match(r.stderr, /--codex-dir does not exist/);
    assert.ok(r.stderr.includes(missingCodexDir));
    assert.equal(r.stdout, 'null');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--since 2026-06-01 --until 2026-06-30 shows exactly June, excluding a May session', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-validation-'));
  try {
    const claudeDir = path.join(root, 'claude-projects');
    const codexDir = path.join(root, 'codex-sessions');
    const proj = path.join(claudeDir, 'proj');
    mkdirSync(proj, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const mkLines = (sid, ts) => [
      { type: 'user', sessionId: sid, cwd: '/tmp/x', gitBranch: 'main', timestamp: ts, message: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', requestId: 'r1', timestamp: ts, message: { model: 'claude-sonnet-5', usage } },
    ];
    const juneSid = 'aaaaaaaa-0000-0000-0000-000000000001';
    const maySid = 'aaaaaaaa-0000-0000-0000-000000000002';
    writeFileSync(path.join(proj, `${juneSid}.jsonl`), mkLines(juneSid, '2026-06-15T12:00:00.000Z').map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(path.join(proj, `${maySid}.jsonl`), mkLines(maySid, '2026-05-15T12:00:00.000Z').map(l => JSON.stringify(l)).join('\n') + '\n');

    const r = runCli(
      ['--json', '--since', '2026-06-01', '--until', '2026-06-30', '--claude-dir', claudeDir, '--codex-dir', codexDir],
      { HOME: root }
    );
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.sessions.length, 1, 'only the June session is in range');
    assert.equal(doc.sessions[0].sessionId, juneSid);
    assert.equal(doc.meta.daysAnalyzed, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
