// Generates synthetic agent session files for CI smoke tests.
// Output: tests/fixtures/claude-projects/test-project/*.jsonl (Claude Code)
//         tests/fixtures/codex-sessions/YYYY/MM/DD/rollout-*.jsonl (OpenAI Codex)
//         tests/fixtures/copilot-sessions/<id>/events.jsonl (GitHub Copilot CLI)
//
// Shapes mirror what ~/.claude/projects/, ~/.codex/sessions/, and
// ~/.copilot/session-state/ contain in practice. The parsers pick these up and
// the dashboard renders with non-empty data for all three agent sources (which
// also makes the source tabs appear).

import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'claude-projects', 'test-project');
const CODEX_DIR = path.join(__dirname, 'codex-sessions');
const COPILOT_DIR = path.join(__dirname, 'copilot-sessions');
mkdirSync(OUT_DIR, { recursive: true });
rmSync(CODEX_DIR, { recursive: true, force: true });
rmSync(COPILOT_DIR, { recursive: true, force: true });

const FAKE_REPO = '/tmp/codelens-fixture-repo';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function session(sessionId, model, entries) {
  const lines = entries.map(e => JSON.stringify(e));
  writeFileSync(path.join(OUT_DIR, sessionId + '.jsonl'), lines.join('\n') + '\n');
}

// Write a Codex rollout into a date tree like Codex CLI's. Directory and
// filename are FIXED (only line timestamps are now-relative) so regeneration
// rewrites the same committed paths instead of deleting them and creating
// fresh names — like the Claude fixtures, whose <uuid>.jsonl names are stable.
// The parser gates on file mtime, not the folder date, so a fixed tree is fine.
function codexSession(sessionId, lines) {
  const dir = path.join(CODEX_DIR, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  );
}

// Write a GitHub Copilot CLI session: one directory per session id under
// session-state/, holding events.jsonl (the transcript + usage) and a
// workspace.yaml metadata sidecar (cwd + branch). Directory name is the
// session id, matching the real ~/.copilot/session-state layout.
function copilotSession(sessionId, branch, lines) {
  const dir = path.join(COPILOT_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'workspace.yaml'), `cwd: ${FAKE_REPO}\nbranch: ${branch}\n`);
  writeFileSync(path.join(dir, 'events.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// ── Session 1: Shipped work (Sonnet, 3 days ago)
const s1 = 'aaaaaaaa-1111-2222-3333-444444444444';
session(s1, 'claude-sonnet-4-6-20250929', [
  {
    type: 'user', sessionId: s1, cwd: FAKE_REPO, gitBranch: 'main',
    timestamp: iso(3 * 24 * 60),
    message: { content: [{ type: 'text', text: 'Add a health-check endpoint.' }] },
  },
  {
    type: 'assistant', requestId: 'req-1a',
    timestamp: iso(3 * 24 * 60 - 1),
    message: {
      model: 'claude-sonnet-4-6-20250929',
      usage: { input_tokens: 4200, output_tokens: 880, cache_read_input_tokens: 12000, cache_creation_input_tokens: 2000 },
      content: [
        { type: 'text', text: 'Reading the router setup first.' },
        { type: 'tool_use', name: 'Read', input: { file_path: FAKE_REPO + '/src/router.js' } },
      ],
    },
  },
  {
    type: 'assistant', requestId: 'req-1b',
    timestamp: iso(3 * 24 * 60 - 2),
    message: {
      model: 'claude-sonnet-4-6-20250929',
      usage: { input_tokens: 5000, output_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0 },
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: FAKE_REPO + '/src/router.js' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  },
]);

// ── Session 2: Orphaned session (Opus, 2 days ago, no commits)
const s2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const s2Entries = [];
for (let i = 0; i < 14; i++) {
  s2Entries.push({
    type: 'user', sessionId: s2, cwd: FAKE_REPO, gitBranch: 'feature/x',
    timestamp: iso(2 * 24 * 60 - i),
    message: { content: [{ type: 'text', text: 'Explore option ' + i }] },
  });
  s2Entries.push({
    type: 'assistant', requestId: 'req-2-' + i,
    timestamp: iso(2 * 24 * 60 - i - 0.5),
    message: {
      model: 'claude-opus-4-6-20250805',
      usage: { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 },
      content: [
        { type: 'text', text: 'Analysis step ' + i },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
      ],
    },
  });
}
session(s2, 'claude-opus-4-6-20250805', s2Entries);

// ── Session 3: Quick fix (Sonnet, yesterday)
const s3 = 'cccccccc-1111-2222-3333-444444444444';
session(s3, 'claude-sonnet-4-6-20250929', [
  {
    type: 'user', sessionId: s3, cwd: FAKE_REPO, gitBranch: 'main',
    timestamp: iso(24 * 60),
    message: { content: [{ type: 'text', text: 'Fix the typo in README.' }] },
  },
  {
    type: 'assistant', requestId: 'req-3a',
    timestamp: iso(24 * 60 - 1),
    message: {
      model: 'claude-sonnet-4-6-20250929',
      usage: { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: FAKE_REPO + '/README.md' } },
      ],
    },
  },
]);

// ── Session 4: Older activity for prior-week narrative comparison (10 days ago)
const s4 = 'dddddddd-1111-2222-3333-444444444444';
session(s4, 'claude-sonnet-4-6-20250929', [
  {
    type: 'user', sessionId: s4, cwd: FAKE_REPO, gitBranch: 'main',
    timestamp: iso(10 * 24 * 60),
    message: { content: [{ type: 'text', text: 'Refactor the auth middleware.' }] },
  },
  {
    type: 'assistant', requestId: 'req-4a',
    timestamp: iso(10 * 24 * 60 - 1),
    message: {
      model: 'claude-sonnet-4-6-20250929',
      usage: { input_tokens: 6000, output_tokens: 1800, cache_read_input_tokens: 20000, cache_creation_input_tokens: 3000 },
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: FAKE_REPO + '/src/auth.js' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  },
]);

// ── Session 5: Sonnet 5 work (intro-priced, ~4 days ago)
const s5 = 'eeeeeeee-1111-2222-3333-444444444444';
session(s5, 'claude-sonnet-5', [
  {
    type: 'user', sessionId: s5, cwd: FAKE_REPO, gitBranch: 'main',
    timestamp: iso(4 * 24 * 60),
    message: { content: [{ type: 'text', text: 'Wire up the new pricing tier.' }] },
  },
  {
    type: 'assistant', requestId: 'req-5a',
    timestamp: iso(4 * 24 * 60 - 1),
    message: {
      model: 'claude-sonnet-5',
      usage: { input_tokens: 5200, output_tokens: 1400, cache_read_input_tokens: 16000, cache_creation_input_tokens: 1800 },
      content: [
        { type: 'text', text: 'Adding the tier and tests.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: FAKE_REPO + '/src/pricing.js' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  },
]);

// ── Codex Session 1: Shipped work (gpt-5.3-codex, ~30h ago)
const cx1 = '11111111-aaaa-bbbb-cccc-000000000001';
codexSession(cx1, [
  { timestamp: iso(30 * 60), type: 'session_meta', payload: { session_id: cx1, id: cx1, timestamp: iso(30 * 60), cwd: FAKE_REPO, originator: 'codex_cli_rs', cli_version: '0.142.5', source: 'cli', git: { branch: 'main' } } },
  { timestamp: iso(30 * 60), type: 'turn_context', payload: { cwd: FAKE_REPO, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5.3-codex', effort: 'medium', summary: 'auto' } },
  { timestamp: iso(30 * 60), type: 'event_msg', payload: { type: 'user_message', message: 'Add rate limiting to the API.', kind: 'plain' } },
  { timestamp: iso(30 * 60 - 1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: FAKE_REPO }), call_id: 'cx1-c1' } },
  { timestamp: iso(30 * 60 - 1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 18000, cached_input_tokens: 15000, output_tokens: 900, reasoning_output_tokens: 600, total_tokens: 18900 }, last_token_usage: { input_tokens: 18000, cached_input_tokens: 15000, output_tokens: 900, reasoning_output_tokens: 600, total_tokens: 18900 }, model_context_window: 272000 }, rate_limits: { plan_type: 'plus' } } },
  { timestamp: iso(30 * 60 - 2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'cx1-c2', input: '*** Begin Patch\n*** Update File: src/limiter.js\n@@\n-old\n+new\n*** End Patch' } },
  { timestamp: iso(30 * 60 - 2), type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'cx1-c2', success: true, status: 'completed', stdout: 'ok', stderr: '', changes: { [FAKE_REPO + '/src/limiter.js']: { type: 'update', unified_diff: '@@', move_path: null } } } },
  { timestamp: iso(30 * 60 - 3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 41000, cached_input_tokens: 34000, output_tokens: 2400, reasoning_output_tokens: 1500, total_tokens: 43400 }, last_token_usage: { input_tokens: 23000, cached_input_tokens: 19000, output_tokens: 1500, reasoning_output_tokens: 900, total_tokens: 24500 } } } },
  { timestamp: iso(30 * 60 - 4), type: 'event_msg', payload: { type: 'agent_message', message: 'Rate limiting added with tests.' } },
]);

// ── Codex Session 2: Prior-week work for narrative comparison (gpt-5.1-codex-max, 9 days ago)
const cx2 = '11111111-aaaa-bbbb-cccc-000000000002';
codexSession(cx2, [
  { timestamp: iso(9 * 24 * 60), type: 'session_meta', payload: { session_id: cx2, id: cx2, timestamp: iso(9 * 24 * 60), cwd: FAKE_REPO, originator: 'codex_cli_rs', cli_version: '0.138.0', source: 'cli', git: { branch: 'feature/codex' } } },
  { timestamp: iso(9 * 24 * 60), type: 'turn_context', payload: { cwd: FAKE_REPO, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5.1-codex-max', effort: 'high', summary: 'auto' } },
  { timestamp: iso(9 * 24 * 60), type: 'event_msg', payload: { type: 'user_message', message: 'Refactor the config loader.', kind: 'plain' } },
  { timestamp: iso(9 * 24 * 60 - 1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 52000, cached_input_tokens: 45000, output_tokens: 3100, reasoning_output_tokens: 2000, total_tokens: 55100 }, last_token_usage: { input_tokens: 52000, cached_input_tokens: 45000, output_tokens: 3100, reasoning_output_tokens: 2000, total_tokens: 55100 } } } },
  { timestamp: iso(9 * 24 * 60 - 2), type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'cx2-c1', success: true, status: 'completed', stdout: 'ok', stderr: '', changes: { [FAKE_REPO + '/src/config.js']: { type: 'update', unified_diff: '@@', move_path: null } } } },
  { timestamp: iso(9 * 24 * 60 - 3), type: 'event_msg', payload: { type: 'agent_message', message: 'Config loader refactored.' } },
]);

// ── Codex Session 3: Chat-only exploration (gpt-5.5, ~5h ago)
const cx3 = '11111111-aaaa-bbbb-cccc-000000000003';
codexSession(cx3, [
  { timestamp: iso(5 * 60), type: 'session_meta', payload: { session_id: cx3, id: cx3, timestamp: iso(5 * 60), cwd: FAKE_REPO, originator: 'codex_cli_rs', cli_version: '0.142.5', source: 'cli', git: { branch: 'main' } } },
  { timestamp: iso(5 * 60), type: 'turn_context', payload: { cwd: FAKE_REPO, approval_policy: 'on-request', sandbox_policy: { mode: 'read-only' }, model: 'gpt-5.5', effort: 'medium', summary: 'auto' } },
  { timestamp: iso(5 * 60), type: 'event_msg', payload: { type: 'user_message', message: 'How does the auth flow work?', kind: 'plain' } },
  { timestamp: iso(5 * 60 - 1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'grep -r authenticate src/', workdir: FAKE_REPO }), call_id: 'cx3-c1' } },
  { timestamp: iso(5 * 60 - 1), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000, cached_input_tokens: 7500, output_tokens: 700, reasoning_output_tokens: 300, total_tokens: 9700 }, last_token_usage: { input_tokens: 9000, cached_input_tokens: 7500, output_tokens: 700, reasoning_output_tokens: 300, total_tokens: 9700 } } } },
  { timestamp: iso(5 * 60 - 2), type: 'event_msg', payload: { type: 'agent_message', message: 'The auth flow uses middleware chaining…' } },
]);

// ── Copilot Session 1: Shipped work (claude-sonnet-4.5 via Copilot, ~20h ago)
const cp1 = 'copilot-1111-2222-3333-000000000001';
copilotSession(cp1, 'main', [
  { type: 'session.start', timestamp: iso(20 * 60), data: { sessionId: cp1, cwd: FAKE_REPO, gitBranch: 'main', model: 'claude-sonnet-4.5', client: 'cli' } },
  { type: 'user.message', timestamp: iso(20 * 60 - 1), data: { role: 'user', kind: 'plain', text: 'Add input validation to the signup form.' } },
  { type: 'assistant.turn_start', timestamp: iso(20 * 60 - 2), data: {} },
  { type: 'tool.execution_start', timestamp: iso(20 * 60 - 3), data: { tool: 'str_replace', arguments: { file_path: FAKE_REPO + '/src/signup.js' } } },
  { type: 'tool.execution_complete', timestamp: iso(20 * 60 - 3), data: { tool: 'str_replace', status: 'success' } },
  { type: 'tool.execution_start', timestamp: iso(20 * 60 - 4), data: { tool: 'bash', arguments: { command: 'npm test' } } },
  { type: 'tool.execution_complete', timestamp: iso(20 * 60 - 4), data: { tool: 'bash', status: 'success' } },
  { type: 'assistant.message', timestamp: iso(20 * 60 - 5), data: { text: 'Added validation with tests.' } },
  { type: 'session.shutdown', timestamp: iso(20 * 60 - 6), data: { modelMetrics: { 'claude-sonnet-4.5': { usage: { inputTokens: 6200, outputTokens: 1500, cacheReadTokens: 22000, cacheWriteTokens: 2600, reasoningTokens: 0 }, requests: { count: 4, cost: 16 } } } } },
]);

// ── Copilot Session 2: Chat-only exploration (gpt-5 via Copilot, ~7h ago)
const cp2 = 'copilot-1111-2222-3333-000000000002';
copilotSession(cp2, 'main', [
  { type: 'session.start', timestamp: iso(7 * 60), data: { sessionId: cp2, cwd: FAKE_REPO, gitBranch: 'main', model: 'gpt-5', client: 'cli' } },
  { type: 'user.message', timestamp: iso(7 * 60 - 1), data: { role: 'user', kind: 'plain', text: 'How is rate limiting implemented here?' } },
  { type: 'assistant.turn_start', timestamp: iso(7 * 60 - 2), data: {} },
  { type: 'tool.execution_start', timestamp: iso(7 * 60 - 3), data: { tool: 'bash', arguments: { command: 'grep -r rateLimit src/' } } },
  { type: 'tool.execution_complete', timestamp: iso(7 * 60 - 3), data: { tool: 'bash', status: 'success' } },
  { type: 'assistant.message', timestamp: iso(7 * 60 - 4), data: { text: 'It uses a token-bucket middleware…' } },
  { type: 'session.shutdown', timestamp: iso(7 * 60 - 5), data: { modelMetrics: { 'gpt-5': { usage: { inputTokens: 8000, outputTokens: 900, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 300 }, requests: { count: 2, cost: 2 } } } } },
]);

// ── Copilot Session 3: Prior-week work for narrative comparison
//    (gemini-2.5-pro via Copilot, 8 days ago) — exercises the overlay-priced
//    Gemini family + the "Gemini" model label.
const cp3 = 'copilot-1111-2222-3333-000000000003';
copilotSession(cp3, 'feature/copilot', [
  { type: 'session.start', timestamp: iso(8 * 24 * 60), data: { sessionId: cp3, cwd: FAKE_REPO, gitBranch: 'feature/copilot', model: 'gemini-2.5-pro', client: 'cli' } },
  { type: 'user.message', timestamp: iso(8 * 24 * 60 - 1), data: { role: 'user', kind: 'plain', text: 'Document the config loader.' } },
  { type: 'assistant.turn_start', timestamp: iso(8 * 24 * 60 - 2), data: {} },
  { type: 'tool.execution_start', timestamp: iso(8 * 24 * 60 - 3), data: { tool: 'create_file', arguments: { file_path: FAKE_REPO + '/docs/config.md' } } },
  { type: 'tool.execution_complete', timestamp: iso(8 * 24 * 60 - 3), data: { tool: 'create_file', status: 'success' } },
  { type: 'session.shutdown', timestamp: iso(8 * 24 * 60 - 4), data: { modelMetrics: { 'gemini-2.5-pro': { usage: { inputTokens: 12000, outputTokens: 2200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requests: { count: 3, cost: 3 } } } } },
]);

console.log('Wrote 5 synthetic Claude sessions to ' + OUT_DIR);
console.log('Wrote 3 synthetic Codex sessions to ' + CODEX_DIR);
console.log('Wrote 3 synthetic Copilot sessions to ' + COPILOT_DIR);
