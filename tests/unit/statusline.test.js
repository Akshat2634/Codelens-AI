import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { composeStatusline, installStatusline } from '../../src/statusline.js';

// Strip ANSI sequences so assertions read the visible text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A fixed "now" so day matching and reset countdowns are deterministic.
const NOW = new Date('2026-07-04T12:00:00').getTime();
const TODAY = '2026-07-04';

test('statusline shows session cost, today ROI, rate limits, and context', () => {
  const input = {
    cost: { total_cost_usd: 4.2 },
    context_window: { used_percentage: 23 },
    rate_limits: {
      five_hour: { used_percentage: 83.5, resets_at: Math.floor(NOW / 1000) + 75 * 60 },
      seven_day: { used_percentage: 41.2 },
    },
  };
  const quickstats = { day: TODAY, todayCost: 12.4, todayCommits: 3, grade: 'A' };
  const line = plain(composeStatusline(input, quickstats, NOW));
  assert.ok(line.includes('$4.20 session'), `session cost in: ${line}`);
  assert.ok(line.includes('today $12.40'), `today cost in: ${line}`);
  assert.ok(line.includes('3 commits'), `commit count in: ${line}`);
  assert.ok(line.includes('$4.13/commit'), `cost per commit in: ${line}`);
  assert.ok(line.includes(' A'), `grade in: ${line}`);
  assert.ok(line.includes('5h 84%'), `five-hour limit in: ${line}`);
  assert.ok(line.includes('(resets 1h15m)'), `reset countdown at >=80% in: ${line}`);
  assert.ok(line.includes('wk 41%'), `weekly limit in: ${line}`);
  assert.ok(line.includes('ctx 23%'), `context usage in: ${line}`);
});

test('statusline omits the today segment when quickstats are from another day', () => {
  const quickstats = { day: '2026-07-03', todayCost: 12.4, todayCommits: 3, grade: 'A' };
  const line = plain(composeStatusline({ cost: { total_cost_usd: 1 } }, quickstats, NOW));
  assert.ok(!line.includes('today'), `stale quickstats must not render: ${line}`);
  assert.ok(line.includes('$1.00 session'));
});

test('statusline omits the reset countdown below the 80% warning threshold', () => {
  const input = { rate_limits: { five_hour: { used_percentage: 30, resets_at: Math.floor(NOW / 1000) + 3600 } } };
  const line = plain(composeStatusline(input, null, NOW));
  assert.ok(line.includes('5h 30%'));
  assert.ok(!line.includes('resets'), `no countdown at 30%: ${line}`);
});

test('statusline degrades to a hint when there is no data at all', () => {
  const line = plain(composeStatusline({}, null, NOW));
  assert.ok(line.includes('codelens-ai'), `fallback line: ${line}`);
});

test('statusline never renders $0.00-per-commit for zero commits', () => {
  const quickstats = { day: TODAY, todayCost: 5, todayCommits: 0, grade: 'F' };
  const line = plain(composeStatusline({}, quickstats, NOW));
  assert.ok(line.includes('today $5.00'), `today spend still shows: ${line}`);
  assert.ok(!line.includes('/commit'), `no per-commit for 0 commits: ${line}`);
});

test('statusline shows the active-block burn rate while the window is open', () => {
  const quickstats = {
    day: TODAY,
    activeBlock: {
      endTime: NOW + 2 * 60 * 60 * 1000, // window still open
      cost: 0.36, totalTokens: 236200,
      tokensPerMinute: 2567, tokensPerMinuteIndicator: 1650, costPerHour: 0.23,
    },
  };
  const line = plain(composeStatusline({}, quickstats, NOW));
  assert.ok(line.includes('burn 2.6K/min'), `compact burn rate in: ${line}`);
  assert.ok(line.includes('$0.23/hr'), `cost per hour in: ${line}`);
});

test('statusline hides the burn segment once the block window has closed', () => {
  const quickstats = {
    day: TODAY,
    activeBlock: {
      endTime: NOW - 60 * 1000, // window already ended → stale
      tokensPerMinute: 2567, tokensPerMinuteIndicator: 1650, costPerHour: 0.23,
    },
  };
  const line = plain(composeStatusline({ cost: { total_cost_usd: 1 } }, quickstats, NOW));
  assert.ok(!line.includes('burn'), `expired block must not render a burn rate: ${line}`);
});

test('statusline burn colors by the input+output indicator, not total tok/min', () => {
  // total tok/min is high (cache-heavy) but the indicator is low → should be green (not red).
  const quickstats = {
    day: TODAY,
    activeBlock: {
      endTime: NOW + 60 * 60 * 1000,
      tokensPerMinute: 9000, tokensPerMinuteIndicator: 500, costPerHour: 0.1,
    },
  };
  const raw = composeStatusline({}, quickstats, NOW);
  assert.ok(raw.includes('\x1b[32m'), 'green (NORMAL) indicator color expected');
  assert.ok(!raw.includes('\x1b[31m9'), 'must not paint the rate red on a low indicator');
});

test('installStatusline creates settings.json with the statusLine entry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'statusline-install-'));
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const result = installStatusline({ settingsPath, command: 'codelens-ai statusline' });
    assert.equal(result.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.deepEqual(written.statusLine, { type: 'command', command: 'codelens-ai statusline', padding: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installStatusline refuses to replace a different statusline without force', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'statusline-install-'));
  try {
    const settingsPath = path.join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool' }, model: 'opus' }));
    const refused = installStatusline({ settingsPath, command: 'codelens-ai statusline' });
    assert.equal(refused.changed, false);
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine.command, 'other-tool');

    const forced = installStatusline({ settingsPath, command: 'codelens-ai statusline', force: true });
    assert.equal(forced.changed, true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(written.statusLine.command, 'codelens-ai statusline');
    assert.equal(written.model, 'opus', 'other settings preserved');
    // The pre-modification content is backed up
    const backup = JSON.parse(readFileSync(`${settingsPath}.codelens-backup`, 'utf-8'));
    assert.equal(backup.statusLine.command, 'other-tool');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installStatusline is idempotent for an identical command', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'statusline-install-'));
  try {
    const settingsPath = path.join(dir, 'settings.json');
    installStatusline({ settingsPath, command: 'codelens-ai statusline' });
    const again = installStatusline({ settingsPath, command: 'codelens-ai statusline' });
    assert.equal(again.changed, false);
    assert.match(again.message, /already installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatusline settles even when stdin never ends (statusline must not hang)', async () => {
  const { PassThrough } = await import('node:stream');
  const { runStatusline } = await import('../../src/statusline.js');
  const stdin = new PassThrough();
  stdin.write('{"cost":{"total_cost_usd":1}}'); // JSON arrives but the stream stays open
  let out = '';
  const stdout = { write: (s) => { out += s; } };
  const started = Date.now();
  await runStatusline({ stdin, stdout }); // resolves via the 2s timeout
  assert.ok(Date.now() - started < 4000, 'settled within the timeout window');
  assert.ok(out.includes('$1.00'), `line rendered from partial stdin: ${out}`);
});
