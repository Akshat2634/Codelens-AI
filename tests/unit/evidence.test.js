import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEvidence,
  renderEvidenceMarkdown,
  renderEvidenceText,
  selectEvidenceSession,
} from '../../src/evidence.js';

function session(overrides = {}) {
  return {
    sessionId: 'session-1234567890',
    source: 'codex',
    entrypoint: 'codex-cli',
    projectName: 'demo-repo',
    contextType: 'repository',
    repoPath: '/work/demo-repo',
    startTime: '2026-08-20T10:00:00.000Z',
    endTime: '2026-08-20T10:45:00.000Z',
    model: 'gpt-5.6-sol',
    cost: { totalCost: 1.25 },
    filesWritten: ['src/app.js', 'tests/app.test.js'],
    filesChanged: 2,
    linesAdded: 42,
    linesDeleted: 7,
    commits: [{
      hash: 'abcdef1234567890',
      subject: 'add evidence view',
      onMain: true,
      aiTrailer: 'codex',
      timestamp: '2026-08-20T10:50:00.000Z',
    }],
    commitCount: 1,
    commitsOnMain: 1,
    attributionConfidence: 'high',
    trailerConfirmedCommits: 1,
    totalBashCalls: 4,
    readOnlyBashCalls: 1,
    verificationBashCalls: 2,
    bashCommands: [
      { command: 'npm test', isVerification: true },
      { command: 'npm test', isVerification: true },
    ],
    toolCalls: { shell_command: 4, apply_patch: 2 },
    ...overrides,
  };
}

test('buildEvidence reports observed facts without claiming verification passed', () => {
  const evidence = buildEvidence(session());

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.coverage, 'rich');
  assert.equal(evidence.attribution.status, 'matched');
  assert.equal(evidence.attribution.confidence, 'high');
  assert.equal(evidence.attribution.trailerConfirmedCommits, 1);
  assert.equal(evidence.verification.status, 'observed');
  assert.equal(evidence.verification.result, 'unknown');
  assert.equal(evidence.verification.commandCount, 2);
  assert.equal(evidence.verification.repeatCount, 1);
  assert.deepEqual(evidence.verification.commands, ['npm test']);
  assert.notEqual(evidence.verification.result, 'passed');
  assert.notEqual(evidence.verification.status, 'failed');
});

test('buildEvidence marks missing verification as not observed, not failed', () => {
  const evidence = buildEvidence(session({
    totalBashCalls: 3,
    verificationBashCalls: 0,
    bashCommands: [],
  }));

  assert.equal(evidence.coverage, 'partial');
  assert.equal(evidence.verification.status, 'not_observed');
  assert.equal(evidence.verification.result, 'unknown');
  assert.match(evidence.verification.note, /not evidence that checks failed/i);
});

test('buildEvidence ignores unmarked shell commands while preserving the verification count fallback', () => {
  const evidence = buildEvidence(session({
    totalBashCalls: 2,
    verificationBashCalls: 1,
    bashCommands: [{ command: 'npm install' }],
  }));

  assert.equal(evidence.verification.status, 'observed');
  assert.equal(evidence.verification.commandCount, 1);
  assert.deepEqual(evidence.verification.commands, []);
});

test('costZeroed remains unavailable instead of becoming a fabricated zero-dollar run', () => {
  const evidence = buildEvidence(session({ costZeroed: true, cost: { totalCost: 0 } }));

  assert.equal(evidence.session.cost, null);
  assert.equal(evidence.session.costStatus, 'not_available');
  assert.match(renderEvidenceText(evidence, { color: false }), /Model \/ cost\s+gpt-5\.6-sol · unknown/);
});

test('task sessions keep repository outcome and attribution explicitly not applicable', () => {
  const evidence = buildEvidence(session({
    projectName: null,
    contextType: 'task',
    taskName: 'write-release-notes',
    repoPath: '/work/write-release-notes',
    commits: [],
    commitCount: 0,
    commitsOnMain: 0,
    attributionConfidence: null,
    trailerConfirmedCommits: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
  }));

  assert.equal(evidence.context.type, 'task');
  assert.equal(evidence.context.name, 'write-release-notes');
  assert.equal(evidence.outcome.status, 'not_applicable');
  assert.equal(evidence.attribution.status, 'not_applicable');
  assert.equal(evidence.attribution.confidence, null);
});

test('selectEvidenceSession chooses latest or an exact session id', () => {
  const older = session({ sessionId: 'older', endTime: '2026-08-19T10:00:00.000Z' });
  const newer = session({ sessionId: 'newer', endTime: '2026-08-21T10:00:00.000Z' });

  assert.equal(selectEvidenceSession([older, newer]).sessionId, 'newer');
  assert.equal(selectEvidenceSession([older, newer], 'older').sessionId, 'older');
  assert.equal(selectEvidenceSession([older, newer], 'missing'), null);
});

test('text and Markdown render the honesty boundary and useful evidence', () => {
  const evidence = buildEvidence(session());
  const text = renderEvidenceText(evidence, { color: false });
  const markdown = renderEvidenceMarkdown(evidence);

  for (const output of [text, markdown]) {
    assert.match(output, /Session evidence/i);
    assert.match(output, /npm test/);
    assert.match(output, /result.*unknown/i);
    assert.match(output, /abcdef1/);
    assert.doesNotMatch(output, /tests passed/i);
  }
});
