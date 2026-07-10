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
  // Newer GPT-5.x models must not fall into the gpt-5 bucket
  assert.deepEqual(getCodexPricing('gpt-5.6-sol'), { input: 5, cachedInput: 0.5, output: 30, longContext: { input: 10, cachedInput: 1, output: 45 } });
  assert.equal(getCodexPricing('gpt-5.6').input, 5, 'gpt-5.6 alias uses Sol pricing');
  assert.equal(getCodexPricing('gpt-5.6-terra').input, 2.5);
  assert.equal(getCodexPricing('gpt-5.6-luna').output, 6);
  assert.equal(getCodexPricing('gpt-5.6-luna[long]').output, 9);
  assert.equal(getCodexPricing('gpt-5.5').input, 5);
  assert.equal(getCodexPricing('gpt-5').input, 1.25);
  assert.equal(getCodexPricing('gpt-5.4-pro').output, 180);
  assert.equal(getCodexPricing('gpt-5.4-pro').cachedInput, 30, 'pro models have no cached-input discount');
  assert.equal(getCodexPricing('gpt-5.4-nano').input, 0.20);
  assert.equal(getCodexPricing('gpt-5.2-pro').cachedInput, 21, 'pro models have no cached-input discount');
  assert.equal(getCodexPricing('gpt-5.5[long]').input, 10, 'long-context marker uses long-context rates');
  assert.equal(getCodexPricing('gpt-5.4-pro[long]').output, 270);
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

test('sibling models are not swallowed by shorter prefixes at the wrong rate', () => {
  // gpt-4.1-mini/nano must not bill at full gpt-4.1 rates
  assert.equal(getCodexPricing('gpt-4.1-mini').input, 0.40);
  assert.equal(getCodexPricing('gpt-4.1-nano').input, 0.10);
  // gpt-5-pro must not bill at base gpt-5 rates
  assert.equal(getCodexPricing('gpt-5-pro').input, 15);
  // o3-pro / o1 family must not bill at o3 rates or fall to the gpt fallback
  assert.equal(getCodexPricing('o3-pro').input, 20);
  assert.equal(getCodexPricing('o3-pro').cachedInput, 20, 'pro models have no cached-input discount');
  assert.equal(getCodexPricing('o1-pro').cachedInput, 150, 'pro models have no cached-input discount');
  assert.equal(getCodexPricing('o1').input, 15);
  assert.equal(getCodexPricing('o1-mini').input, 1.10);
  // local open-weight models (codex --oss) are free, not fallback-priced
  const oss = getCodexPricing('gpt-oss-20b');
  assert.equal(oss.input, 0);
  assert.equal(oss.output, 0);
  assert.ok(!oss.estimate, 'free local models are exact, not estimated');
});

test('deep-research models are not swallowed by the o3/o4-mini prefixes', () => {
  // o3-deep-research is $10/$2.50/$40 — NOT the post-cut o3 rate ($2/$0.50/$8)
  const o3dr = getCodexPricing('o3-deep-research');
  assert.equal(o3dr.input, 10);
  assert.equal(o3dr.cachedInput, 2.5);
  assert.equal(o3dr.output, 40);
  // o4-mini-deep-research is $2/$0.50/$8 — not the o4-mini rate
  const o4dr = getCodexPricing('o4-mini-deep-research');
  assert.equal(o4dr.input, 2);
  assert.equal(o4dr.cachedInput, 0.5);
  assert.equal(o4dr.output, 8);
});

test('calculateCodexCost: cached input billed at the cached rate, reasoning not double-billed', () => {
  // 1M fresh input + 1M output + 1M cached on gpt-5-codex: $1.25 + $10 + $0.125
  const cost = calculateCodexCost(1_000_000, 1_000_000, 1_000_000, 'gpt-5-codex');
  assert.ok(Math.abs(cost - 11.375) < 1e-9, `expected 11.375, got ${cost}`);
});

test('Codex web search calls add OpenAI server-tool cost', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-web-search-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-web-search.jsonl', [
      meta('web-search', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(2), type: 'response_item', payload: { type: 'web_search_call', id: 'ws-1', status: 'completed' } },
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    const expectedTokenCost = (1000 * 5 + 100 * 30) / 1e6;
    const expected = expectedTokenCost + 0.01;
    assert.equal(s.toolCalls.web_search, 1);
    assert.equal(s.webSearchRequests, 1);
    assert.equal(s.cost.serverToolCost, 0.01);
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `expected ${expected}, got ${s.cost.totalCost}`);
    assert.equal(s.modelBreakdown['gpt-5.5'].tokens, 1100);
    assert.ok(Math.abs(s.modelBreakdown['gpt-5.5'].cost - expected) < 1e-9);
    const dailyCost = Object.values(s.dailyUsage).reduce((a, d) => a + d.cost, 0);
    assert.ok(Math.abs(dailyCost - expected) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long-context GPT-5.x Codex usage is priced at long-context rates', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-long-context-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-long-context.jsonl', [
      meta('long-context', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(2), type: 'event_msg', payload: { type: 'user_message', message: 'large repo analysis', kind: 'plain' } },
      tokenCount(iso(1.9), usage(300000, 200000, 1000), usage(300000, 200000, 1000)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    const expected = (100000 * 10 + 200000 * 1 + 1000 * 45) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `expected ${expected}, got ${s.cost.totalCost}`);
    assert.ok(s.modelBreakdown['gpt-5.5[long]'], 'long-context bucket should be visible in model breakdown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long-context boundary: exactly 272K input bills base rates, 272,001 bills long rates', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-lc-boundary-'));
  try {
    const t1 = iso(2);
    const t2 = new Date(Date.parse(t1) + 60_000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-boundary.jsonl', [
      meta('lc-boundary', t1),
      turnContext(t1, 'gpt-5.5'),
      // 272,000 input is AT the standard cap — still base rates
      tokenCount(t1, usage(272000, 0, 10), usage(272000, 0, 10)),
      // one token over the cap — long-context rates
      tokenCount(t2, usage(272001, 0, 20), usage(544001, 0, 30)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.ok(s.modelBreakdown['gpt-5.5'], 'exactly-272K request stays in the base bucket');
    assert.ok(s.modelBreakdown['gpt-5.5[long]'], '272,001-token request moves to the long bucket');
    const baseCost = (272000 * 5 + 10 * 30) / 1e6;
    const longCost = (272001 * 10 + 20 * 45) / 1e6;
    assert.ok(Math.abs(s.modelBreakdown['gpt-5.5'].cost - baseCost) < 1e-9, `expected base ${baseCost}, got ${s.modelBreakdown['gpt-5.5'].cost}`);
    assert.ok(Math.abs(s.modelBreakdown['gpt-5.5[long]'].cost - longCost) < 1e-9, `expected long ${longCost}, got ${s.modelBreakdown['gpt-5.5[long]'].cost}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long-context is decided by REQUEST size, not the model context-window capacity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-lc-capacity-'));
  try {
    // A tiny 5K-token request that merely reports a huge model_context_window
    // must be billed at BASE rates, not long-context (the capacity-trigger bug).
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-small.jsonl', [
      meta('small-req', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(1.9), type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 1_000_000, total_token_usage: usage(5000, 0, 100), last_token_usage: usage(5000, 0, 100) } } },
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    const base = (5000 * 5 + 100 * 30) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - base) < 1e-9, `expected base ${base}, got ${s.cost.totalCost}`);
    assert.ok(s.modelBreakdown['gpt-5.5'], 'small request stays in the base bucket');
    assert.ok(!s.modelBreakdown['gpt-5.5[long]'], 'huge context window alone must NOT trigger long-context billing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web search: duplicate call_ids and failed searches are not billed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-ws-guard-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-ws.jsonl', [
      meta('ws-guard', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(1.99), type: 'response_item', payload: { type: 'web_search_call', call_id: 'ws-1', status: 'completed' } },
      // exact replay of the same call — resumed/branched history
      { timestamp: iso(1.99), type: 'response_item', payload: { type: 'web_search_call', call_id: 'ws-1', status: 'completed' } },
      // a failed search — never billed
      { timestamp: iso(1.98), type: 'response_item', payload: { type: 'web_search_call', call_id: 'ws-2', status: 'failed' } },
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.webSearchRequests, 1, 'only the one completed, non-duplicate search is billed');
    assert.equal(s.toolCalls.web_search, 1);
    assert.ok(Math.abs(s.cost.serverToolCost - 0.01) < 1e-9, `expected $0.01, got ${s.cost.serverToolCost}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web-search fee lands in the same bucket as the model’s base tokens (no phantom row)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-ws-bucket-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-wsb.jsonl', [
      meta('ws-bucket', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(1.99), type: 'response_item', payload: { type: 'web_search_call', call_id: 'ws-1', status: 'completed' } },
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    // Tokens and the fee share the single 'gpt-5.5' bucket — no zero-token twin.
    assert.deepEqual(Object.keys(s.modelBreakdown), ['gpt-5.5']);
    assert.equal(s.modelBreakdown['gpt-5.5'].tokens, 1100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool_search_call response items are counted as tool calls with no fee', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-tool-search-'));
  try {
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-tsearch.jsonl', [
      meta('tsearch', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(1.99), type: 'response_item', payload: { type: 'tool_search_call', id: 'ts-1', status: 'completed' } },
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.toolCalls.tool_search, 1);
    assert.equal(s.cost.serverToolCost, 0, 'tool search carries no per-call fee');
    assert.equal(s.webSearchRequests, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex --oss models resolve to the free tier in dash and colon (Ollama) forms', () => {
  for (const id of ['gpt-oss', 'gpt-oss-20b', 'gpt-oss:20b', 'gpt-oss:120b']) {
    const p = getCodexPricing(id);
    assert.equal(p.input, 0, `${id} should be free`);
    assert.equal(p.output, 0, `${id} should be free`);
    assert.ok(!p.estimate, `${id} is an exact free rate, not an estimate`);
  }
});

test('a missing timestamp inside a spawn replay keeps the burst gated', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-replay-nots-'));
  try {
    const burstTs = iso(5).slice(0, 19) + '.100Z';
    const later = new Date(Date.parse(iso(5)) + 5000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-spawn.jsonl', [
      meta('spawn', burstTs, { source: { subagent: { thread_spawn: { parent: 'p' } } } }),
      turnContext(burstTs, 'gpt-5.5'),
      tokenCount(burstTs, usage(50000, 0, 5000), usage(50000, 0, 5000)),
      // replayed parent event with NO timestamp — must not end the burst
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(60000, 0, 6000), last_token_usage: usage(10000, 0, 1000) } } },
      // real post-burst usage
      tokenCount(later, usage(2000, 0, 200), usage(62000, 0, 6200)),
    ]);
    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 2000, 'only post-burst usage counts; the untimestamped replay line stays gated');
    assert.equal(s.totalOutputTokens, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('filesWritten normalize to repo-relative paths when the recorded cwd is a stale alias', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-alias-'));
  try {
    // session_meta cwd is a DEAD alias of the repo root (findGitRoot finds
    // nothing) while apply_patch bodies carry absolute paths under the
    // differently-prefixed LIVE root — the live GitHub vs GitHub.nosync case.
    const deadCwd = '/nonexistent-alias/GitHub/Codelens-AI';
    const liveRoot = '/nonexistent-alias/GitHub.nosync/Codelens-AI';
    const patch = (header) => `*** Begin Patch\n${header}\n@@\n*** End Patch`;
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-alias.jsonl', [
      meta('alias', iso(2), { cwd: deadCwd }),
      turnContext(iso(2), 'gpt-5.5'),
      { timestamp: iso(2), type: 'event_msg', payload: { type: 'user_message', message: 'fix', kind: 'plain' } },
      { timestamp: iso(1.99), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'a1', input: patch(`*** Update File: ${liveRoot}/src/codex-parser.js`) } },
      { timestamp: iso(1.98), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'a2', input: patch(`*** Add File: ${liveRoot}/tests/unit/codex-parser.test.js`) } },
      // relative path resolves against the dead cwd — must dedupe with the
      // absolute live-root form of the same file
      { timestamp: iso(1.97), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'a3', input: patch('*** Update File: src/codex-parser.js') } },
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.deepEqual(
      [...s.filesWritten].sort(),
      ['src/codex-parser.js', 'tests/unit/codex-parser.test.js'],
      'all paths normalize to repo-relative with no bare-basename or duplicate entries'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readOnlyBashCalls counts read-only shell commands without changing totalBashCalls', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-readonly-'));
  try {
    const exec = (ts, id, cmd) => ({ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: id } });
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-readonly.jsonl', [
      meta('readonly', iso(2)),
      turnContext(iso(2), 'gpt-5.5'),
      exec(iso(1.99), 'r1', 'cat src/server.js'),
      exec(iso(1.98), 'r2', 'npm test'),
      // bash -lc wrapper is unwrapped before classification
      { timestamp: iso(1.97), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', "sed -n '1,20p' src/server.js"] }), call_id: 'r3' } },
      exec(iso(1.96), 'r4', 'rm -rf dist'),
      tokenCount(iso(1.9), usage(1000, 0, 100), usage(1000, 0, 100)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalBashCalls, 4, 'totalBashCalls semantics unchanged');
    assert.equal(s.verificationBashCalls, 1);
    assert.equal(s.readOnlyBashCalls, 2, 'cat and sed -n are read-only; npm test and rm are not');
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
      // drifted cached-field alias must be diffed, not dropped
      noLast(iso(9.8), { input_tokens: 3000, cache_read_input_tokens: 1000, output_tokens: 300, total_tokens: 3300 }),
      // counter reset (context compaction): totals drop — new baseline, not negative
      noLast(iso(9.7), usage(500, 0, 50)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    // deltas: (1000,0,100) + (2000,1000,200) + reset-baseline (500,0,50)
    assert.equal(s.totalInputTokens, 1000 + 1000 + 500); // fresh = input - cached
    assert.equal(s.cacheReadTokens, 1000, 'cache_read_input_tokens alias must be diffed');
    assert.equal(s.totalOutputTokens, 350);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent (thread_spawn) replay burst and exact duplicates are not counted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-'));
  try {
    // One time base for all derived timestamps — independent iso() calls could
    // straddle a wall-clock second boundary and flake the same-second checks.
    const base = iso(5);
    const burstTs = base.slice(0, 19) + '.100Z';
    const burstTs2 = base.slice(0, 19) + '.200Z';
    const laterTs = new Date(Date.parse(base) + 5000).toISOString();
    const laterTs2 = new Date(Date.parse(base) + 6000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T10-00-00-sess-3.jsonl', [
      // structured source object marks a spawned subagent thread
      meta('sess-3', burstTs, { source: { subagent: { thread_spawn: { parent: 'sess-1' } } } }),
      turnContext(burstTs, 'gpt-5.5'),
      // replayed parent history: all in the spawn second — usage, messages,
      // tool calls, and patches must ALL be skipped
      { timestamp: burstTs, type: 'event_msg', payload: { type: 'user_message', message: 'replayed parent prompt', kind: 'plain' } },
      { timestamp: burstTs, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'replay-1' } },
      { timestamp: burstTs, type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'replay-2', success: true, status: 'completed', stdout: '', stderr: '', changes: { '/tmp/codex-fixture-repo/src/replayed.js': { type: 'update', unified_diff: '@@' } } } },
      tokenCount(burstTs, usage(50000, 40000, 5000), usage(50000, 40000, 5000)),
      tokenCount(burstTs2, usage(60000, 50000, 6000), usage(110000, 90000, 11000)),
      // real usage after the burst second
      { timestamp: laterTs, type: 'event_msg', payload: { type: 'user_message', message: 'real subagent prompt', kind: 'plain' } },
      tokenCount(laterTs, usage(2000, 1000, 200), usage(112000, 91000, 11200)),
      // exact duplicate of the real event — replayed histories repeat lines
      tokenCount(laterTs, usage(2000, 1000, 200), usage(112000, 91000, 11200)),
      { timestamp: laterTs2, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm run lint' }), call_id: 'real-1' } },
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 1000, 'only the post-burst event counts, once');
    assert.equal(s.cacheReadTokens, 1000);
    assert.equal(s.totalOutputTokens, 200);
    assert.equal(s.userMessageCount, 1, 'replayed parent prompt must not count');
    assert.equal(s.totalBashCalls, 1, 'replayed parent tool call must not count');
    assert.deepEqual(s.filesWritten, [], 'replayed parent patch must not count');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate token_count events with different timestamps are deduped', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-dup-'));
  try {
    // Real Codex rollouts re-log the identical last_token_usage for the same
    // completed turn seconds-to-minutes later (no new request in between) —
    // the duplicate must be recognized by its usage values, not its timestamp.
    const t1 = iso(2);
    const t2 = new Date(Date.parse(t1) + 90_000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T11-00-00-sess-4.jsonl', [
      meta('sess-4', t1),
      turnContext(t1, 'gpt-5.5'),
      tokenCount(t1, usage(2000, 1000, 200), usage(2000, 1000, 200)),
      tokenCount(t2, usage(2000, 1000, 200), usage(2000, 1000, 200)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 1000, 'same-value re-log must not be billed twice');
    assert.equal(s.cacheReadTokens, 1000);
    assert.equal(s.totalOutputTokens, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identical deltas whose cumulative total ADVANCED are genuine repeats, both counted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-repeat-'));
  try {
    // Two requests that happen to report the same last_token_usage are only a
    // re-log if the cumulative total is UNCHANGED — an advancing total proves a
    // new request happened and must be billed.
    const t1 = iso(2);
    const t2 = new Date(Date.parse(t1) + 90_000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T12-00-00-repeat.jsonl', [
      meta('repeat', t1),
      turnContext(t1, 'gpt-5.5'),
      tokenCount(t1, usage(2000, 1000, 200), usage(2000, 1000, 200)),
      tokenCount(t2, usage(2000, 1000, 200), usage(4000, 2000, 400)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 2000, 'advancing total means a genuine repeat request');
    assert.equal(s.cacheReadTokens, 2000);
    assert.equal(s.totalOutputTokens, 400);
    assert.equal(s.assistantMessageCount, 2, 'each real request is one assistant action');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all-zero compaction token_count events do not count as assistant actions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-compaction-'));
  try {
    const t1 = iso(2);
    const t2 = new Date(Date.parse(t1) + 60_000).toISOString();
    const t3 = new Date(Date.parse(t1) + 120_000).toISOString();
    writeRollout(root, '2026/07/01', 'rollout-2026-07-01T13-00-00-compact.jsonl', [
      meta('compact', t1),
      turnContext(t1, 'gpt-5.5'),
      tokenCount(t1, usage(1000, 0, 100), usage(1000, 0, 100)),
      // context compaction: all-zero last_token_usage, no model request
      tokenCount(t2, usage(0, 0, 0, 0), usage(1000, 0, 100)),
      tokenCount(t3, usage(500, 0, 50), usage(1500, 0, 150)),
    ]);

    const { sessions } = await parseCodexSessions(root, 30);
    const s = sessions[0];
    assert.equal(s.assistantMessageCount, 2, 'the zero compaction event is not an assistant action');
    assert.equal(s.totalInputTokens, 1500);
    assert.equal(s.totalOutputTokens, 150);
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
      'userMessageCount', 'assistantMessageCount', 'bashCommands',
      'totalBashCalls', 'verificationBashCalls', 'readOnlyBashCalls', 'estimatedCost',
      'cacheSavingsDollars', 'dailyUsage', 'source',
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
