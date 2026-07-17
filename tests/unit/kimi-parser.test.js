import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  calculateKimiCost,
  getKimiModelFamily,
  getKimiPricing,
  listKimiSessionFiles,
  parseKimiSessions,
  resolveConfiguredKimiModel,
} from '../../src/kimi-parser.js';

// ── helpers ──

const CWD = '/tmp/kimi-fixture-repo';
const CWD_HASH = createHash('md5').update(CWD, 'utf-8').digest('hex');

function epochSec(hoursAgo) {
  return (Date.now() - hoursAgo * 3600_000) / 1000;
}

// Build a share dir: kimi.json registry + config.toml + sessions tree.
function makeShareDir(root, { configToml, workDirs } = {}) {
  mkdirSync(path.join(root, 'sessions'), { recursive: true });
  writeFileSync(path.join(root, 'kimi.json'), JSON.stringify({
    work_dirs: workDirs ?? [{ path: CWD, kaos: 'local', last_session_id: null }],
  }));
  writeFileSync(path.join(root, 'config.toml'), configToml ?? [
    'default_model = "moonshot-ai/kimi-k2.7-code"',
    '[models."moonshot-ai/kimi-k2.7-code"]',
    'model = "kimi-k2.7-code"',
  ].join('\n'));
}

function writeWire(root, sessionId, records, { hash = CWD_HASH, header = true, state = null } = {}) {
  const dir = path.join(root, 'sessions', hash, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  if (header) lines.push(JSON.stringify({ type: 'metadata', protocol_version: '1.10' }));
  for (const [sec, type, payload] of records) {
    lines.push(JSON.stringify({ timestamp: sec, message: { type, payload } }));
  }
  writeFileSync(path.join(dir, 'wire.jsonl'), lines.join('\n') + '\n');
  if (state) writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  return dir;
}

const toolCall = (id, name, args) => ({ type: 'function', id, function: { name, arguments: JSON.stringify(args) }, extras: null });
const statusUpdate = (messageId, inputOther, cacheRead, cacheCreate, output) => ({
  token_usage: { input_other: inputOther, input_cache_read: cacheRead, input_cache_creation: cacheCreate, output },
  message_id: messageId,
});

// ── model family / pricing ──

test('getKimiModelFamily maps Moonshot model ids', () => {
  assert.equal(getKimiModelFamily('kimi-k3'), 'kimi');
  assert.equal(getKimiModelFamily('kimi-k2.7-code'), 'kimi');
  assert.equal(getKimiModelFamily('kimi-for-coding'), 'kimi');
  assert.equal(getKimiModelFamily('moonshot-v1-32k'), 'moonshot');
  // Claude/OpenAI models and junk are NOT claimed
  assert.equal(getKimiModelFamily('claude-sonnet-5'), null);
  assert.equal(getKimiModelFamily('gpt-5.5'), null);
  assert.equal(getKimiModelFamily(null), null);
});

test('getKimiPricing resolves most-specific id first', () => {
  assert.deepEqual(getKimiPricing('kimi-k3'), { input: 3, cacheRead: 0.30, cacheWrite: 3, output: 15 });
  assert.equal(getKimiPricing('kimi-k2.7-code').input, 0.95);
  assert.equal(getKimiPricing('kimi-k2.6').cacheRead, 0.16);
  assert.equal(getKimiPricing('kimi-k2.5').output, 3);
  // thinking-turbo must not be swallowed by the thinking prefix
  assert.equal(getKimiPricing('kimi-k2-thinking-turbo').output, 8);
  assert.equal(getKimiPricing('kimi-k2-thinking').output, 2.5);
  assert.equal(getKimiPricing('kimi-k2-0905-preview').input, 0.60);
  // context-tier ids
  assert.equal(getKimiPricing('kimi-latest-8k').input, 0.20);
  assert.equal(getKimiPricing('kimi-latest').input, 2, 'bare kimi-latest prices at the 128k ceiling');
  // moonshot-v1 predates cache-hit pricing: cached reads bill at input rate
  assert.equal(getKimiPricing('moonshot-v1-32k').cacheRead, 1);
  assert.equal(getKimiPricing('moonshot-v1-8k-vision-preview').input, 0.20, 'vision variants share the tier rate');
  // cache creation carries no write premium on this platform
  assert.equal(getKimiPricing('kimi-k2.5').cacheWrite, getKimiPricing('kimi-k2.5').input);
  // non-Moonshot ids are not priced
  assert.equal(getKimiPricing('gpt-5.5'), null);
});

test('kimi-k2-turbo-preview pricing is date-tiered across the promo and the 2025-11-06 cut', () => {
  const promo = Date.parse('2025-08-15T00:00:00Z');
  const full = Date.parse('2025-10-01T00:00:00Z');
  const cut = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(getKimiPricing('kimi-k2-turbo-preview', promo).input, 1.20);
  assert.equal(getKimiPricing('kimi-k2-turbo-preview', full).input, 2.40);
  assert.equal(getKimiPricing('kimi-k2-turbo-preview', cut).input, 1.15);
  assert.equal(getKimiPricing('kimi-k2-turbo-preview', cut).output, 8);
});

test('kimi-for-coding subscription alias is priced as the model it routed to, flagged estimated', () => {
  const thinkingEra = Date.parse('2025-12-01T00:00:00Z');
  const k25Era = Date.parse('2026-02-01T00:00:00Z');
  const k26Era = Date.parse('2026-05-01T00:00:00Z');
  const k27Era = Date.parse('2026-07-01T00:00:00Z');
  assert.equal(getKimiPricing('kimi-for-coding', thinkingEra).output, 2.5);
  assert.equal(getKimiPricing('kimi-for-coding', k25Era).cacheRead, 0.10);
  assert.equal(getKimiPricing('kimi-for-coding', k26Era).cacheRead, 0.16);
  assert.equal(getKimiPricing('kimi-for-coding', k27Era).cacheRead, 0.19);
  assert.equal(getKimiPricing('kimi-for-coding', k27Era).estimate, true);
  // legacy alias + high-speed tier
  assert.equal(getKimiPricing('kimi-code', k27Era).input, 0.95);
  assert.equal(getKimiPricing('kimi-for-coding-highspeed', k27Era).output, 8);
});

test('unknown Moonshot models fall back to estimated current-default rates', () => {
  const p = getKimiPricing('kimi-k9-hyper');
  assert.equal(p.input, 0.95);
  assert.equal(p.estimate, true);
});

test('calculateKimiCost bills all four token classes, cache creation at input rate', () => {
  // 1M fresh + 1M output + 1M cache read + 1M cache creation on kimi-k2.5:
  // $0.60 + $3.00 + $0.10 + $0.60
  const cost = calculateKimiCost(1_000_000, 1_000_000, 1_000_000, 1_000_000, 'kimi-k2.5');
  assert.ok(Math.abs(cost - 4.30) < 1e-9, `expected 4.30, got ${cost}`);
});

// ── wire.jsonl parsing ──

test('parses a wire session: tokens, cost, files, commands, timestamps', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-parse-'));
  try {
    makeShareDir(root);
    const t = epochSec(20);
    writeWire(root, 'sess-1', [
      [t, 'TurnBegin', { user_input: 'Fix the bug' }],
      [t + 1, 'ToolCall', toolCall('c1', 'Shell', { command: 'npm test' })],
      [t + 2, 'StatusUpdate', statusUpdate('m1', 11000, 10000, 500, 900)],
      [t + 3, 'ToolCall', toolCall('c2', 'StrReplaceFile', { path: 'src/server.js', edit: { old: 'a', new: 'b' } })],
      [t + 4, 'StatusUpdate', statusUpdate('m2', 3000, 12000, 0, 600)],
      [t + 5, 'ToolCall', toolCall('c3', 'ReadFile', { path: 'src/other.js' })],
      [t + 6, 'TurnEnd', {}],
    ]);

    const { sessions, fileIndex } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 1);
    assert.equal(Object.keys(fileIndex).length, 1);
    const s = sessions[0];
    assert.equal(s.source, 'kimi');
    assert.equal(s.sessionId, 'sess-1');
    assert.equal(s.entrypoint, 'kimi-cli');
    assert.equal(s.repoPath, CWD, 'cwd recovered through the kimi.json md5 registry');
    assert.equal(s.projectName, 'kimi-fixture-repo');
    assert.equal(s.model, 'kimi-k2.7-code', 'model resolved from config.toml managed key');
    assert.equal(s.totalInputTokens, 14000);
    assert.equal(s.cacheReadTokens, 22000);
    assert.equal(s.cacheCreationTokens, 500);
    assert.equal(s.totalOutputTokens, 1500);
    // kimi-k2.7-code: (14000*0.95 + 1500*4 + 22000*0.19 + 500*0.95) per 1M
    const expected = (14000 * 0.95 + 1500 * 4 + 22000 * 0.19 + 500 * 0.95) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `expected ${expected}, got ${s.cost.totalCost}`);
    assert.equal(s.estimatedCost, 0, 'a real model id is exact, not estimated');
    assert.equal(s.userMessageCount, 1);
    assert.equal(s.assistantMessageCount, 2, 'one per usage-carrying StatusUpdate');
    assert.deepEqual(s.filesWritten, ['src/server.js'], 'write tools only — ReadFile is not a written file');
    assert.equal(s.toolCalls.Shell, 1);
    assert.equal(s.toolCalls.StrReplaceFile, 1);
    assert.equal(s.toolCalls.ReadFile, 1);
    assert.equal(s.totalBashCalls, 1);
    assert.equal(s.verificationBashCalls, 1, 'npm test is a verification command');
    assert.equal(s.usageEvents.length, 2);
    assert.ok(Date.parse(s.endTime) > Date.parse(s.startTime));
    // dailyUsage reconciles with session totals
    const dailyCost = Object.values(s.dailyUsage).reduce((a, d) => a + d.cost, 0);
    assert.ok(Math.abs(dailyCost - s.cost.totalCost) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent events are unwrapped and counted once; instances counted by agent id', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-subagent-'));
  try {
    makeShareDir(root);
    const t = epochSec(4);
    const wrap = (agentId, event) => ({ parent_tool_call_id: 'call-parent', agent_id: agentId, subagent_type: 'coder', event });
    writeWire(root, 'sess-sub', [
      [t, 'TurnBegin', { user_input: 'delegate' }],
      [t + 1, 'ToolCall', toolCall('call-parent', 'Agent', { prompt: 'do it', subagent_type: 'coder' })],
      [t + 2, 'StatusUpdate', statusUpdate('m1', 1000, 0, 0, 100)],
      // Subagent usage arrives wrapped (even doubly, for nested subagents) —
      // it must be unwrapped, counted once, and attributed to this session.
      [t + 3, 'SubagentEvent', wrap('a1', { type: 'StatusUpdate', payload: statusUpdate('m2', 2000, 0, 0, 200) })],
      [t + 4, 'SubagentEvent', wrap('a1', { type: 'SubagentEvent', payload: wrap('a2', { type: 'StatusUpdate', payload: statusUpdate('m3', 500, 0, 0, 50) }) })],
      [t + 5, 'SubagentEvent', wrap('a1', { type: 'ToolCall', payload: toolCall('c9', 'WriteFile', { path: `${CWD}/src/sub.js`, content: 'x' }) })],
    ]);

    const { sessions } = await parseKimiSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 3500);
    assert.equal(s.totalOutputTokens, 350);
    assert.equal(s.subagentTranscriptCount, 2, 'distinct subagent ids a1 + a2');
    assert.deepEqual(s.filesWritten, ['src/sub.js'], 'subagent writes count toward correlation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forked sessions do not double-bill copied usage records (original wins)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-fork-'));
  try {
    makeShareDir(root);
    const t = epochSec(6);
    const shared = [
      [t, 'TurnBegin', { user_input: 'original work' }],
      [t + 1, 'StatusUpdate', statusUpdate('m-shared', 4000, 1000, 0, 400)],
    ];
    writeWire(root, 'sess-orig', [...shared, [t + 2, 'TurnEnd', {}]]);
    // /fork copies the original's records verbatim into a new session, then
    // appends new activity. "Fork: " titles mark the copy.
    writeWire(root, 'sess-fork', [
      ...shared,
      [t + 100, 'StatusUpdate', statusUpdate('m-fork-new', 700, 0, 0, 70)],
    ], { state: { custom_title: 'Fork: original work' } });

    const { sessions } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 2);
    const orig = sessions.find(s => s.sessionId === 'sess-orig');
    const fork = sessions.find(s => s.sessionId === 'sess-fork');
    assert.equal(orig.totalInputTokens, 4000, 'the original keeps its own spend');
    assert.equal(fork.totalInputTokens, 700, 'the fork bills only its new activity');
    assert.equal(orig.totalInputTokens + fork.totalInputTokens, 4700, 'total is conserved, never doubled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions from an unknown or remote work dir keep usage but no local repoPath', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-workdir-'));
  try {
    makeShareDir(root, {
      workDirs: [{ path: '/srv/remote-checkout', kaos: 'devbox', last_session_id: null }],
    });
    const remoteHash = `devbox_${createHash('md5').update('/srv/remote-checkout', 'utf-8').digest('hex')}`;
    const t = epochSec(3);
    writeWire(root, 'sess-remote', [
      [t, 'TurnBegin', { user_input: 'remote' }],
      [t + 1, 'StatusUpdate', statusUpdate('m1', 1000, 0, 0, 100)],
    ], { hash: remoteHash });
    writeWire(root, 'sess-unmapped', [
      [t, 'TurnBegin', { user_input: 'mystery' }],
      [t + 1, 'StatusUpdate', statusUpdate('m2', 2000, 0, 0, 200)],
    ], { hash: 'f'.repeat(32) });

    const { sessions } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 2);
    const remote = sessions.find(s => s.sessionId === 'sess-remote');
    assert.equal(remote.repoPath, null, 'a kaos work dir lives on another machine');
    assert.equal(remote.projectName, 'remote-checkout', 'still named after the remote folder');
    assert.equal(remote.totalInputTokens, 1000);
    const unmapped = sessions.find(s => s.sessionId === 'sess-unmapped');
    assert.equal(unmapped.repoPath, null);
    assert.equal(unmapped.projectName, 'kimi');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('window clipping: usage before the cutoff is excluded, session is kept', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-clip-'));
  try {
    makeShareDir(root);
    const oldSec = epochSec(40 * 24);
    writeWire(root, 'sess-clip', [
      [oldSec, 'TurnBegin', { user_input: 'old prompt' }],
      [oldSec + 1, 'StatusUpdate', statusUpdate('m1', 100000, 0, 0, 10000)],
      [epochSec(1), 'StatusUpdate', statusUpdate('m2', 5000, 0, 0, 500)],
    ]);

    const { sessions } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 1, 'resumed-in-window session is kept');
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 5000, 'pre-window usage clipped');
    assert.equal(s.totalOutputTokens, 500);
    assert.equal(s.userMessageCount, 1, 'whole-session counts stay whole-session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kimi-latest usage is billed at the context tier each request fits in', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-latest-'));
  try {
    makeShareDir(root, { configToml: 'default_model = "kimi-latest"' });
    const t = epochSec(2);
    writeWire(root, 'sess-tier', [
      [t, 'TurnBegin', { user_input: 'tiering' }],
      [t + 1, 'StatusUpdate', statusUpdate('m1', 4000, 0, 0, 100)], // fits 8k
      [t + 2, 'StatusUpdate', statusUpdate('m2', 100000, 0, 0, 200)], // needs 128k
    ]);

    const { sessions } = await parseKimiSessions(root, 30);
    const s = sessions[0];
    assert.ok(s.modelBreakdown['kimi-latest-8k'], 'small request bills the 8k tier');
    assert.ok(s.modelBreakdown['kimi-latest-128k'], 'large request bills the 128k tier');
    const expected = (4000 * 0.20 + 100 * 2) / 1e6 + (100000 * 2 + 200 * 5) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `expected ${expected}, got ${s.cost.totalCost}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing config.toml falls back to the kimi-for-coding alias with estimated spend', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-noconfig-'));
  try {
    makeShareDir(root);
    rmSync(path.join(root, 'config.toml'));
    const t = epochSec(2);
    writeWire(root, 'sess-alias', [
      [t, 'TurnBegin', { user_input: 'x' }],
      [t + 1, 'StatusUpdate', statusUpdate('m1', 1000, 0, 0, 100)],
    ]);

    const { sessions } = await parseKimiSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.model, 'kimi-for-coding');
    assert.ok(s.cost.totalCost > 0);
    assert.ok(Math.abs(s.estimatedCost - s.cost.totalCost) < 1e-9, 'alias-priced spend is flagged estimated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfiguredKimiModel handles managed keys, plain keys, and absence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-config-'));
  try {
    // Quoted managed key resolved through its [models."..."] table
    writeFileSync(path.join(root, 'config.toml'), [
      'default_model = "kimi-code/kimi-for-coding"',
      '[models."kimi-code/kimi-for-coding"]',
      'model = "kimi-for-coding"',
    ].join('\n'));
    assert.equal(resolveConfiguredKimiModel(root), 'kimi-for-coding');

    // Plain key with an unquoted table
    writeFileSync(path.join(root, 'config.toml'), [
      'default_model = "my-kimi"',
      '[models.my-kimi]',
      'model = "kimi-k3"',
    ].join('\n'));
    assert.equal(resolveConfiguredKimiModel(root), 'kimi-k3');

    // Managed key with no [models] table — the tail is the model id
    writeFileSync(path.join(root, 'config.toml'), 'default_model = "kimi-code/kimi-k2.6"\n');
    assert.equal(resolveConfiguredKimiModel(root), 'kimi-k2.6');

    rmSync(path.join(root, 'config.toml'));
    assert.equal(resolveConfiguredKimiModel(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── legacy context fallback + file discovery ──

test('legacy bare context files parse messages and tool calls with mtime timestamps', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-legacy-'));
  try {
    makeShareDir(root);
    const hashDir = path.join(root, 'sessions', CWD_HASH);
    mkdirSync(hashDir, { recursive: true });
    const lines = [
      { role: '_system_prompt', content: 'You are Kimi.' },
      { role: '_checkpoint', id: 0 },
      { role: 'user', content: '<system>CHECKPOINT 0</system>' }, // synthetic — not a prompt
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool_calls: [toolCall('c1', 'WriteFile', { path: 'src/x.js', content: 'x' })] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      { role: '_usage', token_count: 1234 }, // context-size marker, never billed
    ];
    writeFileSync(path.join(hashDir, 'legacy-1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.sessionId, 'legacy-1');
    assert.equal(s.userMessageCount, 1, 'checkpoint marker is not a prompt');
    assert.equal(s.assistantMessageCount, 1);
    assert.equal(s.cost.totalCost, 0, 'no usage exists in the legacy era');
    assert.deepEqual(s.filesWritten, ['src/x.js']);
    assert.ok(s.startTime, 'file mtime stands in for the session time');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listKimiSessionFiles prefers wire.jsonl, skips rotations/subagents, tolerates a missing dir', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-list-'));
  try {
    makeShareDir(root);
    const dir = writeWire(root, 'sess-a', [[epochSec(1), 'TurnBegin', { user_input: 'x' }]]);
    // context + rotations + subagent copies must not be listed for sess-a
    writeFileSync(path.join(dir, 'context.jsonl'), '{"role":"user","content":"x"}\n');
    writeFileSync(path.join(dir, 'context_1.jsonl'), '{"role":"user","content":"old"}\n');
    mkdirSync(path.join(dir, 'subagents', 'a1'), { recursive: true });
    writeFileSync(path.join(dir, 'subagents', 'a1', 'wire.jsonl'), '{}\n');
    // a migrated dir session without wire.jsonl falls back to context.jsonl
    const ctxOnly = path.join(root, 'sessions', CWD_HASH, 'sess-b');
    mkdirSync(ctxOnly, { recursive: true });
    writeFileSync(path.join(ctxOnly, 'context.jsonl'), '{"role":"user","content":"y"}\n');
    // legacy bare file
    writeFileSync(path.join(root, 'sessions', CWD_HASH, 'legacy.jsonl'), '{"role":"user","content":"z"}\n');

    const files = listKimiSessionFiles(root).sort();
    assert.deepEqual(files, [
      path.join(root, 'sessions', CWD_HASH, 'legacy.jsonl'),
      path.join(ctxOnly, 'context.jsonl'),
      path.join(dir, 'wire.jsonl'),
    ].sort());
    assert.deepEqual(listKimiSessionFiles(path.join(root, 'nope')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('files untouched since the cutoff are skipped entirely', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-mtime-'));
  try {
    makeShareDir(root);
    const dir = writeWire(root, 'sess-old', [
      [epochSec(24 * 60), 'TurnBegin', { user_input: 'ancient' }],
      [epochSec(24 * 60) + 1, 'StatusUpdate', statusUpdate('m1', 1000, 0, 0, 100)],
    ]);
    const past = (Date.now() - 60 * 24 * 3600_000) / 1000;
    utimesSync(path.join(dir, 'wire.jsonl'), past, past);

    const { sessions, fileIndex } = await parseKimiSessions(root, 30);
    assert.equal(sessions.length, 0);
    assert.deepEqual(fileIndex, {}, 'out-of-window files are not tracked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions produced are shape-compatible with claude-parser sessions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kimi-shape-'));
  try {
    makeShareDir(root);
    const t = epochSec(2);
    writeWire(root, 'sess-shape', [
      [t, 'TurnBegin', { user_input: 'shape' }],
      [t + 1, 'StatusUpdate', statusUpdate('m1', 100, 0, 0, 10)],
    ]);
    const { sessions } = await parseKimiSessions(root, 30);
    const s = sessions[0];
    // Every field the correlator/metrics/server pipeline reads must exist
    for (const key of [
      'sessionId', 'repoPath', 'projectName', 'gitBranch', 'startTime', 'endTime',
      'durationMinutes', 'totalInputTokens', 'totalOutputTokens', 'cacheCreationTokens',
      'cacheReadTokens', 'cost', 'model', 'modelBreakdown', 'toolCalls', 'filesWritten',
      'userMessageCount', 'assistantMessageCount', 'bashCommands',
      'totalBashCalls', 'verificationBashCalls', 'readOnlyBashCalls', 'estimatedCost',
      'cacheSavingsDollars', 'dailyUsage', 'source', 'entrypoint', 'usageEvents',
    ]) {
      assert.ok(key in s, `missing session field: ${key}`);
    }
    for (const key of ['inputCost', 'outputCost', 'cacheReadCost', 'cacheCreationCost', 'serverToolCost', 'totalCost']) {
      assert.ok(key in s.cost, `missing cost field: ${key}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
