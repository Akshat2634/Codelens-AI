// Generates synthetic Claude Code session JSONL files for CI smoke tests.
// Output: tests/fixtures/claude-projects/test-project/*.jsonl
//
// Shape mirrors what ~/.claude/projects/ contains in practice — user / assistant
// messages with usage tokens, tool calls, and a sessionId. The parser will pick
// these up and the dashboard will render with non-empty data.

import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'claude-projects', 'test-project');
mkdirSync(OUT_DIR, { recursive: true });

const FAKE_REPO = '/tmp/codelens-fixture-repo';

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function session(sessionId, model, entries) {
  const lines = entries.map(e => JSON.stringify(e));
  writeFileSync(path.join(OUT_DIR, sessionId + '.jsonl'), lines.join('\n') + '\n');
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

console.log('Wrote 4 synthetic sessions to ' + OUT_DIR);
