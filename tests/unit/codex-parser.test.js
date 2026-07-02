import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import {
  calculateCodexCost,
  getCodexModelFamily,
  getCodexPricing,
  listCodexSessionFiles,
  parseCodexSessions,
} from '../../src/codex-parser.js';

// ── helpers ──

function writeRollout(root, relDir, name, lines) {
  const dir = path.join(root, relDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

function iso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

const CWD = '/tmp/codex-fixture-repo';

function meta(id, ts, extra = {}) {
  return {
    timestamp: ts,
    type: 'session_meta',
    payload: {
      session_id: id, id, timestamp: ts, cwd: CWD,
      originator: 'codex_cli_rs', cli_version: '0.142.5', source: 'cli',
      git: { branch: 'main' },
      ...extra,
    },
  };
}

function turnContext(ts, model) {
  return { timestamp: ts, type: 'turn_context', payload: { cwd: CWD, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model, summary: 'auto' } };
}

function tokenCount(ts, last, total, extra = {}) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 }, ...extra } };
}

function usage(input, cached, output, reasoning = 0) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}

// ── model family / pricing ──

test('getCodexModelFamily maps OpenAI model ids', () => {
  assert.equal(getCodexModelFamily('gpt-5.3-codex'), 'codex');
  assert.equal(getCodexModelFamily('gpt-5.1-codex-max'), 'codex');
  assert.equal(getCodexModelFamily('codex-mini-latest'), 'codex');
  assert.equal(getCodexModelFamily('gpt-5.5'), 'gpt');
  assert.equal(getCodexModelFamily('gpt-4.1'), 'gpt');
  assert.equal(getCodexModelFamily('o3'), 'o-series');
  assert.equal(getCodexModelFamily('o4-mini'), 'o-series');
  // Claude models and junk are NOT claimed
  assert.equal(getCodexModelFamily('claude-sonnet-5'), null);
  assert.equal(getCodexModelFamily(null), null);
  assert.equal(getCodexModelFamily('mistral-large'), null);
});

test('getCodexPricing resolves most-specific id first', () => {
  // gpt-5.5 must not fall into the gpt-5 bucket
  assert.equal(getCodexPricing('gpt-5.5').input, 5);
  assert.equal(getCodexPricing('gpt-5').input, 1.25);
  // codex variants
  assert.equal(getCodexPricing('gpt-5.1-codex-max').input, 1.25);
  assert.equal(getCodexPricing('gpt-5.1-codex-mini').input, 0.25);
  assert.equal(getCodexPricing('gpt-5.3-codex').output, 14);
  // date suffixes are stripped
  assert.equal(getCodexPricing('gpt-5.2-2025-12-11').input, 1.75);
  // codex-mini-latest: cached discount is 75%, not 90%
  assert.equal(getCodexPricing('codex-mini-latest').cachedInput, 0.375);
  // non-OpenAI ids are not priced
  assert.equal(getCodexPricing('claude-opus-4-6'), null);
});

test('o3 pricing is date-tiered around the 2025-06-10 price cut', () => {
  const before = Date.parse('2025-05-01T00:00:00Z');
  const after = Date.parse('2025-07-01T00:00:00Z');
  assert.equal(getCodexPricing('o3', before).input, 10);
  assert.equal(getCodexPricing('o3', after).input, 2);
  // o3-mini is not caught by the o3 prefix
  assert.equal(getCodexPricing('o3-mini', before).input, 1.10);
});

test('unknown OpenAI models fall back to estimated gpt-5.5 rates', () => {
  const p = getCodexPricing('gpt-6-super');
  assert.equal(p.input, 5);
  assert.equal(p.estimate, true);
});

test('calculateCodexCost: cached input billed at the cached rate, reasoning not double-billed', () => {
  // 1M fresh input + 1M output + 1M cached on gpt-5-codex: $1.25 + $10 + $0.125
  const cost = calculateCodexCost(1_000_000, 1_000_000, 1_000_000, 'gpt-5-codex');
  assert.ok(Math.abs(cost - 11.375) < 1e-9, `expected 11.375, got ${cost}`);
});

// ── rollout parsing ──

test('parses a modern envelope rollout: tokens, cost, files, commands, plan type', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-parse-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-sess-1.jsonl', [
      meta('sess-1', iso(20)),
      turnContext(iso(20), 'gpt-5.3-codex'),
      { timestamp: iso(20), type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug', kind: 'plain' } },
      // injected context blocks must NOT count as prompts
      { timestamp: iso(20), type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>...</environment_context>', kind: 'environment_context' } },
      { timestamp: iso(19.9), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'c1' } },
      tokenCount(iso(19.9), usage(11000, 10000, 500, 400), usage(11000, 10000, 500, 400), { rate_limits: { plan_type: 'plus' } }),
      { timestamp: iso(19.8), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/server.js\n@@\n*** End Patch' } },
      { timestamp: iso(19.8), type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c2', success: true, status: 'completed', stdout: '', stderr: '', changes: { [CWD + '/src/server.js']: { type: 'update', unified_diff: '@@', move_path: null } } } },
      tokenCount(iso(19.7), usage(14000, 12000, 1000, 500), usage(25000, 22000, 1500, 900)),
      { timestamp: iso(19.6), type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.source, 'codex');
    assert.equal(s.sessionId, 'sess-1');
    assert.equal(s.gitBranch, 'main');
    // deltas summed: fresh input = (11000-10000) + (14000-12000) = 3000
    assert.equal(s.totalInputTokens, 3000);
    assert.equal(s.cacheReadTokens, 22000);
    assert.equal(s.totalOutputTokens, 1500);
    assert.equal(s.reasoningOutputTokens, 900);
    assert.equal(s.cacheCreationTokens, 0);
    // gpt-5.3-codex: 3000*1.75 + 1500*14 + 22000*0.175 per 1M
    const expected = (3000 * 1.75 + 1500 * 14 + 22000 * 0.175) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `expected ${expected}, got ${s.cost.totalCost}`);
    assert.equal(s.model, 'gpt-5.3-codex');
    assert.equal(s.userMessageCount, 1, 'environment_context must not count as a prompt');
    assert.equal(s.assistantMessageCount, 2, 'one per model request');
    assert.deepEqual(s.filesWritten, ['src/server.js']);
    assert.equal(s.toolCalls.exec_command, 1);
    assert.equal(s.toolCalls.apply_patch, 1);
    assert.equal(s.totalBashCalls, 1);
    assert.equal(s.verificationBashCalls, 1, 'npm test is a verification command');
    assert.equal(s.codexPlanType, 'plus');
    assert.equal(s.estimatedCost, 0);
    // dailyUsage reconciles with session totals
    const dailyCost = Object.values(s.dailyUsage).reduce((a, d) => a + d.cost, 0);
    assert.ok(Math.abs(dailyCost - s.cost.totalCost) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cumulative-only token counts (no last_token_usage) are diffed, with reset handling', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-cumulative-'));
  try {
    const noLast = (ts, total) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-sess-2.jsonl', [
      meta('sess-2', iso(10)),
      turnContext(iso(10), 'gpt-5'),
      noLast(iso(9.9), usage(1000, 0, 100)),
      noLast(iso(9.8), usage(3000, 1000, 300)),
      // counter reset (context compaction): totals drop — new baseline, not negative
      noLast(iso(9.7), usage(500, 0, 50)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    // deltas: (1000,0,100) + (2000,1000,200) + reset-baseline (500,0,50)
    assert.equal(s.totalInputTokens, 1000 + 1000 + 500); // fresh = input - cached
    assert.equal(s.cacheReadTokens, 1000);
    assert.equal(s.totalOutputTokens, 350);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent (thread_spawn) replay burst and exact duplicates are not counted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-'));
  try {
    const burstTs = iso(5).slice(0, 19) + '.100Z';
    const burstTs2 = iso(5).slice(0, 19) + '.200Z';
    const laterTs = new Date(Date.parse(iso(5)) + 5000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-sess-3.jsonl', [
      // structured source object marks a spawned subagent thread
      meta('sess-3', iso(5), { source: { subagent: { thread_spawn: { parent: 'sess-1' } } } }),
      turnContext(iso(5), 'gpt-5.5'),
      // replayed parent history: all in the same second — must be skipped
      tokenCount(burstTs, usage(50000, 40000, 5000), usage(50000, 40000, 5000)),
      tokenCount(burstTs2, usage(60000, 50000, 6000), usage(110000, 90000, 11000)),
      // real usage after the burst second
      tokenCount(laterTs, usage(2000, 1000, 200), usage(112000, 91000, 11200)),
      // exact duplicate of the real event — replayed histories repeat lines
      tokenCount(laterTs, usage(2000, 1000, 200), usage(112000, 91000, 11200)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 1000, 'only the post-burst event counts, once');
    assert.equal(s.cacheReadTokens, 1000);
    assert.equal(s.totalOutputTokens, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy pre-envelope rollouts parse messages without token data', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-legacy-'));
  try {
    // v0.20-era: bare SessionMeta line, then bare ResponseItems, no envelopes
    writeRollout(root, '2025/05/07', 'rollout-2025-05-07T17-24-21-legacy-1.jsonl', [
      { id: 'legacy-1', timestamp: iso(24), instructions: null, git: { branch: 'dev' } },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -x'] }), call_id: 'l1' },
      { record_type: 'state' },
    ]);

    const { sessions } = await parseCodexSessions(root, 60);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.sessionId, 'legacy-1');
    assert.equal(s.gitBranch, 'dev');
    assert.equal(s.userMessageCount, 1);
    assert.equal(s.assistantMessageCount, 1);
    assert.equal(s.cost.totalCost, 0, 'no token data in legacy era');
    assert.equal(s.totalBashCalls, 1);
    assert.equal(s.verificationBashCalls, 1, 'bash -lc wrapper is unwrapped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('window clipping: usage before the cutoff is excluded, session is kept', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-clip-'));
  try {
    const oldTs = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    writeRollout(root, '2026/05/01', 'rollout-2026-05-01T10-00-00-sess-4.jsonl', [
      meta('sess-4', oldTs),
      turnContext(oldTs, 'gpt-5.5'),
      // pre-window usage (40 days ago) — clipped
      tokenCount(oldTs, usage(100000, 0, 10000), usage(100000, 0, 10000)),
      { timestamp: oldTs, type: 'event_msg', payload: { type: 'user_message', message: 'old prompt', kind: 'plain' } },
      // in-window usage (now)
      tokenCount(iso(1), usage(5000, 0, 500), usage(105000, 0, 10500)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    assert.equal(sessions.length, 1, 'resumed-in-window session is kept');
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 5000, 'pre-window usage clipped');
    assert.equal(s.totalOutputTokens, 500);
    // whole-session counts stay whole-session
    assert.equal(s.userMessageCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zstd-compressed rollouts parse when the runtime supports zstd', { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-zst-'));
  try {
    const lines = [
      meta('sess-5', iso(3)),
      turnContext(iso(3), 'gpt-5.4-mini'),
      { timestamp: iso(3), type: 'event_msg', payload: { type: 'user_message', message: 'compressed session', kind: 'plain' } },
      tokenCount(iso(2.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ];
    const dir = path.join(root, '2026', '06', '20');
    mkdirSync(dir, { recursive: true });
    const raw = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(path.join(dir, 'rollout-2026-06-20T09-00-00-sess-5.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(raw)));

    const { sessions, fileIndex } = await parseCodexSessions(root, 30);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'sess-5');
    assert.equal(sessions[0].totalInputTokens, 1000);
    assert.equal(Object.keys(fileIndex).length, 1, 'compressed file is tracked in the file index');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate rollouts for the same session dedupe to the fuller transcript', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-dupe-'));
  try {
    const shortLines = [
      meta('sess-6', iso(8)),
      turnContext(iso(8), 'gpt-5.5'),
      { timestamp: iso(8), type: 'event_msg', payload: { type: 'user_message', message: 'one', kind: 'plain' } },
    ];
    const fullLines = [
      ...shortLines,
      { timestamp: iso(7.9), type: 'event_msg', payload: { type: 'user_message', message: 'two', kind: 'plain' } },
      tokenCount(iso(7.8), usage(500, 0, 50), usage(500, 0, 50)),
    ];
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T08-00-00-sess-6.jsonl', shortLines);
    writeRollout(root, '2026/07/02', 'rollout-2026-07-02T08-00-00-sess-6.jsonl', fullLines);

    const { sessions } = await parseCodexSessions(root, 30);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].userMessageCount, 2, 'fuller transcript wins');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCodexSessionFiles finds dated, flat, and compressed rollouts; missing dir is empty', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-list-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-a.jsonl', ['{}']);
    writeRollout(root, '.', 'rollout-2025-05-07T17-24-21-b.jsonl', ['{}']);
    writeRollout(root, '2026/06/01', 'rollout-2026-06-01T10-00-00-c.jsonl.zst', ['not-really-zst']);
    writeRollout(root, '2026/07/01', 'not-a-rollout.jsonl', ['{}']);
    const files = listCodexSessionFiles(root);
    assert.equal(files.length, 3);
    assert.ok(files.every(f => path.basename(f).startsWith('rollout-')));
    assert.deepEqual(listCodexSessionFiles(path.join(root, 'does-not-exist')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions produced are shape-compatible with claude-parser sessions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-shape-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-sess-7.jsonl', [
      meta('sess-7', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(2), type: 'event_msg', payload: { type: 'user_message', message: 'shape', kind: 'plain' } },
      tokenCount(iso(1.9), usage(100, 0, 10), usage(100, 0, 10)),
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    // Every field the correlator/metrics/server pipeline reads must exist
    for (const key of [
      'sessionId', 'repoPath', 'projectName', 'gitBranch', 'startTime', 'endTime',
      'durationMinutes', 'totalInputTokens', 'totalOutputTokens', 'cacheCreationTokens',
      'cacheReadTokens', 'cost', 'model', 'modelBreakdown', 'toolCalls', 'filesWritten',
      'filesRead', 'userMessageCount', 'assistantMessageCount', 'bashCommands',
      'totalBashCalls', 'verificationBashCalls', 'estimatedCost', 'cacheSavingsDollars',
      'dailyUsage', 'source',
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
