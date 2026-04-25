import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correlateSessions } from '../../src/correlator.js';

// Build a minimal session skeleton that satisfies correlateSessions' expectations.
function mkSession(overrides = {}) {
  return {
    sessionId: 'sess-1',
    repoPath: '/repo',
    projectName: 'repo',
    startTime: '2026-04-20T10:00:00.000Z',
    endTime: '2026-04-20T11:00:00.000Z',
    filesWritten: [],
    userMessageCount: 5,
    assistantMessageCount: 20,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: { totalCost: 2.5, inputCost: 1, outputCost: 1, cacheReadCost: 0, cacheCreationCost: 0.5 },
    model: 'claude-sonnet-4-6',
    modelBreakdown: {},
    toolCalls: {},
    durationMinutes: 60,
    ...overrides,
  };
}

function mkCommit(overrides = {}) {
  const ts = '2026-04-20T10:30:00.000Z';
  return {
    hash: 'abc123',
    timestamp: ts,
    timestampMs: new Date(ts).getTime(),
    subject: 'test commit',
    branches: ['main'],
    onMain: true,
    files: [{ path: 'src/foo.js', added: 10, deleted: 2 }],
    totalAdded: 10,
    totalDeleted: 2,
    ...overrides,
  };
}

test('correlator matches commits to sessions by file overlap', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit();
  const { correlatedSessions, organicCommits } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );

  assert.equal(correlatedSessions.length, 1);
  assert.equal(correlatedSessions[0].commitCount, 1);
  assert.equal(correlatedSessions[0].commits[0].hash, 'abc123');
  assert.equal(correlatedSessions[0].linesAdded, 10);
  assert.equal(correlatedSessions[0].linesDeleted, 2);
  assert.equal(correlatedSessions[0].isOrphaned, false);
  assert.equal(organicCommits.length, 0);
});

test('commit outside time window is not matched', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  // Commit 6 hours after session end — outside the 2h fallback buffer
  const commit = mkCommit({
    timestamp: '2026-04-20T17:00:00.000Z',
    timestampMs: new Date('2026-04-20T17:00:00.000Z').getTime(),
  });
  const { correlatedSessions, organicCommits } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 0);
  assert.equal(organicCommits.length, 1);
});

test('chat-only session uses time-based fallback', () => {
  // No filesWritten → fallback to time-window matching
  const session = mkSession({ filesWritten: [] });
  const commit = mkCommit({ files: [{ path: 'src/bar.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
  assert.equal(correlatedSessions[0].matchedByFiles, false);
});

test('orphaned: >10 msgs and 0 matched commits', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'], userMessageCount: 10, assistantMessageCount: 30 });
  // No commits in repo
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].isOrphaned, true);
  assert.equal(correlatedSessions[0].commitCount, 0);
});

test('file-overlap match wins over time-only match', () => {
  // Two sessions both in the commit's time window; only session B has the file
  const sessionA = mkSession({
    sessionId: 'sess-A',
    filesWritten: ['src/other.js'],
    startTime: '2026-04-20T10:20:00.000Z',
    endTime: '2026-04-20T10:40:00.000Z',
  });
  const sessionB = mkSession({
    sessionId: 'sess-B',
    filesWritten: ['src/foo.js'],
    startTime: '2026-04-20T09:00:00.000Z',
    endTime: '2026-04-20T09:45:00.000Z',
  });
  const commit = mkCommit(); // 10:30, touches src/foo.js

  const { correlatedSessions } = correlateSessions(
    [sessionA, sessionB],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  const byId = Object.fromEntries(correlatedSessions.map(s => [s.sessionId, s]));
  assert.equal(byId['sess-B'].commitCount, 1, 'session B should win by file overlap');
  assert.equal(byId['sess-A'].commitCount, 0);
});

test('cost-per-commit computed when session matches commits', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit();
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.ok(correlatedSessions[0].costPerCommit > 0);
  assert.equal(correlatedSessions[0].costPerCommit, 2.5 / 1);
});
