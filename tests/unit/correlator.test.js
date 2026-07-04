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
  // No filesWritten → fallback to time-window matching (default mkSession has
  // 25 messages — well above the chat-only substance floor)
  const session = mkSession({ filesWritten: [] });
  const commit = mkCommit({ files: [{ path: 'src/bar.js', added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
  // Time-only matches have no file evidence → always low confidence
  assert.equal(correlatedSessions[0].attributionConfidence, 'low');
});

test('tiny chat-only session cannot claim commits by time alone', () => {
  // 2 messages, no filesWritten — below the substance floor, so the nearby
  // manual commit stays organic instead of being absorbed
  const session = mkSession({ filesWritten: [], userMessageCount: 1, assistantMessageCount: 1 });
  const commit = mkCommit();
  const { correlatedSessions, organicCommits } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 0);
  assert.equal(correlatedSessions[0].linesAdded, 0);
  assert.equal(organicCommits.length, 1);
});

test('chat-only session at the message floor still matches by time', () => {
  const session = mkSession({ filesWritten: [], userMessageCount: 2, assistantMessageCount: 3 });
  const commit = mkCommit();
  const { correlatedSessions, organicCommits } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
  assert.equal(organicCommits.length, 0);
});

test('file-overlap matching is unaffected by the chat-only message floor', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'], userMessageCount: 1, assistantMessageCount: 0 });
  const commit = mkCommit();
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
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

test('attribution confidence: strong overlap + in-window commit is high', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit(); // 10:30, inside 10:00-11:00, 100% of added lines overlap
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].attributionConfidence, 'high');
});

test('attribution confidence: strong overlap with post-session commit is medium, not low', () => {
  // Agents never run `git commit` for the user — a commit landing after the
  // session but inside the 2h buffer must not read low when the file
  // evidence is overwhelming (the normal Codex flow).
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit({
    timestamp: '2026-04-20T11:30:00.000Z',
    timestampMs: new Date('2026-04-20T11:30:00.000Z').getTime(),
  });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
  assert.equal(correlatedSessions[0].attributionConfidence, 'medium');
});

test('attribution confidence: partial overlap (20-50%) is medium regardless of timing', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit({
    files: [
      { path: 'src/foo.js', added: 30, deleted: 0 },
      { path: 'src/bar.js', added: 70, deleted: 0 },
    ],
    totalAdded: 100,
    totalDeleted: 0,
  });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].attributionConfidence, 'medium');
});

test('attribution confidence: weak overlap (<20% of added lines) is low', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const commit = mkCommit({
    files: [
      { path: 'src/foo.js', added: 10, deleted: 0 },
      { path: 'src/bar.js', added: 90, deleted: 0 },
    ],
    totalAdded: 100,
    totalDeleted: 0,
  });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].attributionConfidence, 'low');
});

test('attribution confidence: null when no commits matched', () => {
  const session = mkSession({ filesWritten: ['src/foo.js'] });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].attributionConfidence, null);
});

test('a commit trailer naming the agent upgrades attribution to high confidence', () => {
  // Chat-only session (time-only match → normally low confidence), but the
  // commit is stamped Co-authored-by this agent — near-ground-truth.
  const session = mkSession({ filesWritten: [], source: 'claude' });
  const commit = mkCommit({ aiTrailer: 'claude' });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].commitCount, 1);
  assert.equal(correlatedSessions[0].trailerConfirmedCommits, 1);
  assert.equal(correlatedSessions[0].attributionConfidence, 'high');
});

test('a trailer naming a DIFFERENT agent does not upgrade confidence', () => {
  const session = mkSession({ filesWritten: [], source: 'claude' });
  const commit = mkCommit({ aiTrailer: 'codex' });
  const { correlatedSessions } = correlateSessions(
    [session],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  assert.equal(correlatedSessions[0].trailerConfirmedCommits, 0);
  assert.equal(correlatedSessions[0].attributionConfidence, 'low');
});

test('trailer breaks ties between equal file-overlap sessions from different agents', () => {
  // Both sessions wrote the same file and are equally distant in time; the
  // commit's Codex trailer must route it to the codex session.
  const claude = mkSession({ sessionId: 'cl', source: 'claude', filesWritten: ['src/foo.js'] });
  const codex = mkSession({ sessionId: 'cx', source: 'codex', filesWritten: ['src/foo.js'] });
  const commit = mkCommit({ aiTrailer: 'codex' });
  const { correlatedSessions } = correlateSessions(
    [claude, codex],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  const byId = Object.fromEntries(correlatedSessions.map(s => [s.sessionId, s]));
  assert.equal(byId.cx.commitCount, 1, 'trailer-matching agent claims the commit');
  assert.equal(byId.cl.commitCount, 0);
});

test('file overlap still beats a trailer match from a chat-only session', () => {
  // Trailer preference must not override file evidence: the session that
  // actually wrote the committed file wins over a trailer-matching
  // chat-only session.
  const wroteFile = mkSession({ sessionId: 'wf', source: 'codex', filesWritten: ['src/foo.js'] });
  const chatOnly = mkSession({ sessionId: 'co', source: 'claude', filesWritten: [] });
  const commit = mkCommit({ aiTrailer: 'claude' });
  const { correlatedSessions } = correlateSessions(
    [wroteFile, chatOnly],
    { '/repo': { commits: [commit], defaultBranch: 'main' } }
  );
  const byId = Object.fromEntries(correlatedSessions.map(s => [s.sessionId, s]));
  assert.equal(byId.wf.commitCount, 1, 'file evidence dominates');
  assert.equal(byId.co.commitCount, 0);
});
