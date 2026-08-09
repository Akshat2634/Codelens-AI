import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/index.js', import.meta.url));

// HOME is pointed at a temp dir so cache reads/writes (os.homedir()-based)
// never touch the user's real ~/.cache/agent-analytics. cwd matters too: a
// project codelens.json is read from process.cwd().
function runCli(args, env = {}, cwd = undefined) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd,
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

test('a project codelens.json sets the --days default, but an explicit flag still wins', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-validation-'));
  try {
    const claudeDir = path.join(root, 'claude-projects');
    const codexDir = path.join(root, 'codex-sessions');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(root, 'codelens.json'), JSON.stringify({ days: 14 }));

    // --source claude (rather than the default) so the "no sessions" message
    // names the days actually in effect — the only place it's observable here.
    const fromConfig = runCli(['--json', '--source', 'claude', '--claude-dir', claudeDir, '--codex-dir', codexDir], { HOME: root }, root);
    assert.match(fromConfig.stderr, /in the last 14 days/);

    const fromFlag = runCli(['--json', '--source', 'claude', '--claude-dir', claudeDir, '--codex-dir', codexDir, '--days', '3'], { HOME: root }, root);
    assert.match(fromFlag.stderr, /in the last 3 days/);
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
