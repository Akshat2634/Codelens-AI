import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  calculateCopilotCost,
  getCopilotModelFamily,
  getCopilotPricing,
  listCopilotSessionFiles,
  parseCopilotSessions,
} from '../../src/copilot-parser.js';
import { __resetOverlayForTest, __setOverlayForTest } from '../../src/pricing.js';

// ── helpers ──

// Write a Copilot session directory (session-state/<id>/events.jsonl [+ yaml]).
function writeSession(root, id, lines, workspaceYaml) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  if (workspaceYaml !== undefined) writeFileSync(path.join(dir, 'workspace.yaml'), workspaceYaml);
  writeFileSync(
    path.join(dir, 'events.jsonl'),
    lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  );
  return dir;
}

function iso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

const CWD = '/tmp/copilot-fixture-repo';

// A complete, well-formed session with one model's shutdown usage.
function basicSession(id, model, ts, usage, extra = []) {
  return [
    { type: 'session.start', timestamp: ts, data: { sessionId: id, cwd: CWD, gitBranch: 'main', model, client: 'cli' } },
    { type: 'user.message', timestamp: ts, data: { role: 'user', kind: 'plain', text: 'do a thing' } },
    { type: 'assistant.turn_start', timestamp: ts, data: {} },
    ...extra,
    { type: 'session.shutdown', timestamp: ts, data: { modelMetrics: { [model]: { usage, requests: { count: 2, cost: 5 } } } } },
  ];
}

// ── model family ──

test('getCopilotModelFamily claims only Gemini (Claude/GPT go to their own parsers)', () => {
  assert.equal(getCopilotModelFamily('gemini-2.5-pro'), 'gemini');
  assert.equal(getCopilotModelFamily('gemini-2.0-flash'), 'gemini');
  assert.equal(getCopilotModelFamily('claude-sonnet-4.5'), null);
  assert.equal(getCopilotModelFamily('gpt-5'), null);
  assert.equal(getCopilotModelFamily(null), null);
});

// ── pricing (GitHub Copilot's published table) ──

test('getCopilotPricing prices Claude models at Anthropic rates incl. cache write', () => {
  // Sonnet 4.5: $3 input / $15 output / $0.30 cache read / $3.75 cache write.
  const p = getCopilotPricing('claude-sonnet-4.5');
  assert.equal(p.input, 3);
  assert.equal(p.output, 15);
  assert.equal(p.cachedInput, 0.3);
  assert.equal(p.cacheWrite, 3.75);
  assert.equal(p.estimate, false);
});

test('getCopilotPricing prices GPT models at OpenAI rates with no cache-write premium', () => {
  const p = getCopilotPricing('gpt-5');
  assert.equal(p.input, 1.25);
  assert.equal(p.output, 10);
  assert.equal(p.cacheWrite, 0, 'OpenAI automatic caching has no write premium');
  assert.equal(p.estimate, false);
});

test('getCopilotPricing falls back to a flagged estimate for unknown models with no overlay', () => {
  __resetOverlayForTest();
  const p = getCopilotPricing('gemini-9-ultra');
  assert.equal(p.estimate, true, 'unknown model with no overlay is an estimate');
  assert.ok(p.input > 0 && p.output > 0);
});

test('getCopilotPricing uses the external overlay only for unknown future models', () => {
  __setOverlayForTest({ 'copilot-future-model': { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 } });
  const p = getCopilotPricing('copilot-future-model');
  assert.equal(p.input, 1.25);
  assert.equal(p.output, 10);
  assert.equal(p.cachedInput, 0.31);
  assert.equal(p.estimate, false, 'overlay rates are real, not estimated');
  __resetOverlayForTest();
});

test('getCopilotPricing keeps GitHub pricing available offline for Gemini and Copilot-only models', () => {
  __resetOverlayForTest();
  const gemini = getCopilotPricing('gemini-2.5-pro');
  const raptor = getCopilotPricing('raptor-mini');
  assert.deepEqual(gemini, { input: 1.25, cachedInput: 0.125, output: 10, cacheWrite: 0, estimate: false });
  assert.deepEqual(raptor, { input: 0.25, cachedInput: 0.025, output: 2, cacheWrite: 0, estimate: false });
});

test('getCopilotPricing flags aggregate long-context model usage as estimated unless its tier is recorded', () => {
  const aggregate = getCopilotPricing('gpt-5.4');
  const long = getCopilotPricing('gpt-5.4', Date.now(), 0, 'long_context');
  assert.equal(aggregate.estimate, true);
  assert.equal(aggregate.input, 2.5, 'default price is a lower-bound when the tier is unknown');
  assert.deepEqual(long, { input: 5, cachedInput: 0.5, output: 22.5, cacheWrite: 0, estimate: false });
});

test('calculateCopilotCost sums input/output/cacheRead/cacheWrite at the right rates', () => {
  // Sonnet 4.5: 1M input, 1M output, 1M cache read, 1M cache write.
  const cost = calculateCopilotCost(1_000_000, 1_000_000, 1_000_000, 1_000_000, 'claude-sonnet-4.5');
  // 3 + 15 + 0.30 + 3.75
  assert.ok(Math.abs(cost - 22.05) < 1e-9, `expected 22.05, got ${cost}`);
});

// ── parsing ──

test('parseCopilotSessions parses a shutdown session into the uniform shape', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    writeSession(root, 'sess-a', basicSession('sess-a', 'claude-sonnet-4.5', iso(2),
      { inputTokens: 5000, outputTokens: 1200, cacheReadTokens: 18000, cacheWriteTokens: 2000, reasoningTokens: 0 },
      [
        { type: 'tool.execution_start', timestamp: iso(2), data: { tool: 'str_replace', arguments: { file_path: CWD + '/src/app.js' } } },
        { type: 'tool.execution_complete', timestamp: iso(2), data: { tool: 'str_replace' } },
        { type: 'tool.execution_start', timestamp: iso(2), data: { tool: 'bash', arguments: { command: 'npm test' } } },
        { type: 'skill.invoked', timestamp: iso(2), data: { skill: 'simplify' } },
      ]));

    const { sessions } = await parseCopilotSessions(root, 30, null);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.source, 'copilot');
    assert.equal(s.sessionId, 'sess-a');
    assert.equal(s.entrypoint, 'copilot-cli');
    assert.equal(s.gitBranch, 'main');
    assert.equal(s.model, 'claude-sonnet-4.5');
    assert.equal(s.totalInputTokens, 5000, 'inputTokens treated as fresh input (cache read separate)');
    assert.equal(s.cacheReadTokens, 18000);
    assert.equal(s.cacheCreationTokens, 2000, 'cacheWriteTokens -> cacheCreationTokens');
    assert.equal(s.totalOutputTokens, 1200);
    assert.equal(s.userMessageCount, 1);
    assert.equal(s.assistantMessageCount, 2, 'assistant actions come from summed requests.count');
    // tool.execution_start counted once (completion is not double-counted)
    assert.equal(s.toolCalls.str_replace, 1);
    assert.equal(s.toolCalls.bash, 1);
    assert.equal(s.skillCalls.simplify, 1);
    assert.equal(s.totalBashCalls, 1);
    assert.equal(s.verificationBashCalls, 1, 'npm test is a verification command');
    assert.deepEqual(s.filesWritten, ['src/app.js']);
    // Cost: 5000*3 + 1200*15 + 18000*0.30 + 2000*3.75 all /1e6
    const expected = (5000 * 3 + 1200 * 15 + 18000 * 0.3 + 2000 * 3.75) / 1e6;
    assert.ok(Math.abs(s.cost.totalCost - expected) < 1e-9, `cost ${s.cost.totalCost} vs ${expected}`);
    assert.equal(s.costZeroed, undefined, 'a session with real usage is not cost-zeroed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions accumulates usage across multiple models in one shutdown', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    writeSession(root, 'sess-multi', [
      { type: 'session.start', timestamp: iso(3), data: { sessionId: 'sess-multi', cwd: CWD, gitBranch: 'main', model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(3), data: { role: 'user', kind: 'plain', text: 'hi' } },
      { type: 'session.shutdown', timestamp: iso(3), data: { modelMetrics: {
        'claude-sonnet-4.5': { usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, requests: { count: 1 } },
        'gpt-5': { usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, requests: { count: 1 } },
      } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 3000);
    assert.equal(s.totalOutputTokens, 800);
    assert.equal(Object.keys(s.modelBreakdown).length, 2);
    assert.ok(s.modelBreakdown['claude-sonnet-4.5']);
    assert.ok(s.modelBreakdown['gpt-5']);
    // Primary model = the one with the most tokens (gpt-5: 2300 > sonnet: 1500)
    assert.equal(s.model, 'gpt-5');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions counts a re-logged shutdown record once, not twice', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    // A build that emits BOTH shutdown aliases (session.end at end-of-turn,
    // session.shutdown at process exit) repeats the same session TOTALS. Summing
    // them would silently double the session's cost.
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    writeSession(root, 'sess-relog', [
      { type: 'session.start', timestamp: iso(3), data: { sessionId: 'sess-relog', cwd: CWD, model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(3), data: { role: 'user', kind: 'plain', text: 'hi' } },
      { type: 'session.shutdown', timestamp: iso(3), data: { modelMetrics: { 'gpt-5': { usage, requests: { count: 3 } } } } },
      { type: 'session.end', timestamp: iso(3), data: { modelMetrics: { 'gpt-5': { usage, requests: { count: 3 } } } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 1000);
    assert.equal(s.totalOutputTokens, 100);
    // The request count feeds the autopilot ratio — it must not double either.
    assert.equal(s.assistantMessageCount, 3);
    assert.equal(s.usageEvents.length, 1);
    assert.ok(!s.costZeroed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions still sums two shutdown records with genuinely different totals', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    // The dedup keys on the reported usage itself, so a resumed session whose
    // second run did different work is counted in full — only verbatim
    // re-logs collapse.
    writeSession(root, 'sess-resume', [
      { type: 'session.start', timestamp: iso(4), data: { sessionId: 'sess-resume', cwd: CWD, model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(4), data: { role: 'user', kind: 'plain', text: 'run one' } },
      { type: 'session.shutdown', timestamp: iso(4), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 1000, outputTokens: 100 }, requests: { count: 2 } } } } },
      { type: 'user.message', timestamp: iso(3), data: { role: 'user', kind: 'plain', text: 'run two' } },
      { type: 'session.shutdown', timestamp: iso(3), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 2500, outputTokens: 400 }, requests: { count: 3 } } } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const s = sessions[0];
    assert.equal(s.totalInputTokens, 3500);
    assert.equal(s.totalOutputTokens, 500);
    assert.equal(s.assistantMessageCount, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions treats a zero-usage shutdown as known-$0, not unknown cost', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    // A persisted all-zero record means the session really spent nothing. That
    // must stay distinct from a crashed session, whose cost is UNKNOWN.
    writeSession(root, 'sess-zero', [
      { type: 'session.start', timestamp: iso(2), data: { sessionId: 'sess-zero', cwd: CWD, model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(2), data: { role: 'user', kind: 'plain', text: 'never answered' } },
      { type: 'session.shutdown', timestamp: iso(2), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 0, outputTokens: 0 }, requests: { count: 0 } } } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const s = sessions[0];
    assert.equal(s.cost.totalCost, 0);
    assert.ok(!s.costZeroed, 'a persisted zero-usage record is a known $0, so it stays gradeable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions reads cwd/branch from workspace.yaml when events omit them', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    writeSession(root, 'sess-yaml', [
      { type: 'session.start', timestamp: iso(2), data: { sessionId: 'sess-yaml', model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(2), data: { role: 'user', kind: 'plain', text: 'x' } },
      { type: 'session.shutdown', timestamp: iso(2), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 100, outputTokens: 50 }, requests: { count: 1 } } } } },
    ], `cwd: ${CWD}\nbranch: feature/z\n`);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const s = sessions[0];
    assert.equal(s.repoPath, CWD);
    assert.equal(s.gitBranch, 'feature/z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions uses session.context_changed when there is no YAML or session.start metadata', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    writeSession(root, 'sess-context', [
      { type: 'user.message', timestamp: iso(2), data: { role: 'user', kind: 'plain', text: 'x' } },
      { type: 'session.context_changed', timestamp: iso(2), data: { cwd: CWD, gitRoot: CWD, branch: 'feature/context' } },
      { type: 'session.shutdown', timestamp: iso(2), data: { modelMetrics: { 'gemini-2.5-pro': { usage: { inputTokens: 100, outputTokens: 50 }, requests: { count: 1 } } } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].repoPath, CWD);
    assert.equal(sessions[0].projectName, 'copilot-fixture-repo');
    assert.equal(sessions[0].gitBranch, 'feature/context');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions marks a usage-less (crashed) session costZeroed, not a fabricated $0', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    // No session.shutdown record (crashed / force-killed) — real work, unknown cost.
    writeSession(root, 'sess-crash', [
      { type: 'session.start', timestamp: iso(2), data: { sessionId: 'sess-crash', cwd: CWD, gitBranch: 'main', model: 'gpt-5' } },
      { type: 'user.message', timestamp: iso(2), data: { role: 'user', kind: 'plain', text: 'work' } },
      { type: 'tool.execution_start', timestamp: iso(2), data: { tool: 'create_file', arguments: { file_path: CWD + '/src/new.js' } } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    assert.equal(sessions.length, 1, 'kept for commit correlation');
    const s = sessions[0];
    assert.equal(s.cost.totalCost, 0);
    assert.equal(s.costZeroed, true, 'unknown-cost session must not grade as a fabricated A');
    assert.deepEqual(s.filesWritten, ['src/new.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCopilotSessions skips malformed lines and truly empty sessions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    // Malformed JSON line + a real one.
    writeSession(root, 'sess-mixed', [
      'this is not json',
      JSON.stringify({ type: 'session.start', timestamp: iso(2), data: { sessionId: 'sess-mixed', cwd: CWD, model: 'gpt-5' } }),
      JSON.stringify({ type: 'user.message', timestamp: iso(2), data: { role: 'user', kind: 'plain', text: 'x' } }),
      JSON.stringify({ type: 'session.shutdown', timestamp: iso(2), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 100, outputTokens: 20 }, requests: { count: 1 } } } } }),
    ]);
    // Empty session (metadata only, no activity/usage) — should be dropped.
    writeSession(root, 'sess-empty', [
      { type: 'session.start', timestamp: iso(2), data: { sessionId: 'sess-empty', cwd: CWD, model: 'gpt-5' } },
    ]);
    const { sessions } = await parseCopilotSessions(root, 30, null);
    const ids = sessions.map(s => s.sessionId);
    assert.ok(ids.includes('sess-mixed'), 'malformed line skipped, rest parsed');
    assert.ok(!ids.includes('sess-empty'), 'empty session dropped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCopilotSessionFiles finds events.jsonl per session dir; missing dir is empty', () => {
  assert.deepEqual(listCopilotSessionFiles('/no/such/copilot/dir'), []);
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-'));
  try {
    writeSession(root, 'sA', [{ type: 'session.start', timestamp: iso(1), data: { sessionId: 'sA' } }]);
    mkdirSync(path.join(root, 'sB'), { recursive: true }); // dir with no events.jsonl
    const files = listCopilotSessionFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(path.join('sA', 'events.jsonl')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
