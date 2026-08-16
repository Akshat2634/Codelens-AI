import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  listCopilotVsCodeSessionFiles,
  parseCopilotVsCodeSessions,
} from '../../src/copilot-vscode-parser.js';

function writeWorkspace(root, repo, sessionId, records, workspaceId = 'workspace-a') {
  const workspaceDir = path.join(root, workspaceId);
  const chatDir = path.join(workspaceDir, 'chatSessions');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(path.join(workspaceDir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(repo).href }));
  writeFileSync(
    path.join(chatDir, `${sessionId}.jsonl`),
    records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n',
  );
}

function copilotRequest(timestamp, overrides = {}) {
  return {
    requestId: `request-${timestamp}`,
    timestamp,
    responseTimestamp: timestamp,
    message: { text: 'synthetic fixture prompt', parts: [] },
    response: [],
    modelId: 'copilot/auto',
    agent: {
      extensionId: { value: 'GitHub.copilot-chat', _lower: 'github.copilot-chat' },
      id: 'github.copilot.editsAgent',
      extensionDisplayName: 'GitHub Copilot',
    },
    modeInfo: { kind: 'agent' },
    ...overrides,
  };
}

test('VS Code Copilot parser replays incremental usage into the shared copilot session shape', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-vscode-'));
  const repo = path.join(root, 'fixture-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const now = Date.now();
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const edited = path.join(repo, 'src', 'app.js');
  try {
    writeWorkspace(root, repo, sessionId, [
      {
        kind: 0,
        v: {
          version: 3,
          sessionId,
          creationDate: now - 60_000,
          responderUsername: 'GitHub Copilot',
          requests: [copilotRequest(now - 50_000)],
        },
      },
      {
        kind: 1,
        k: ['requests', 0, 'result'],
        v: {
          metadata: {
            resolvedModel: 'gpt-5-mini',
            promptTokens: 900,
            outputTokens: 150,
            toolCallRounds: [{
              thinking: { tokens: 40 },
              toolCalls: [
                { id: 'call-edit__vscode-1', name: 'create_file', arguments: JSON.stringify({ filePath: edited }) },
                { id: 'call-test__vscode-2', name: 'run_in_terminal', arguments: JSON.stringify({ command: 'npm test' }) },
              ],
            }],
          },
        },
      },
      { kind: 1, k: ['requests', 0, 'promptTokens'], v: 1_000 },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: 200 },
      { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 2.5 },
      { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: now - 40_000 } },
      {
        kind: 2,
        k: ['requests', 0, 'response'],
        v: [{
          kind: 'textEditGroup',
          uri: { scheme: 'file', fsPath: edited, path: edited },
          edits: [],
          done: true,
        }],
      },
      {
        kind: 2,
        k: ['requests'],
        v: [copilotRequest(now - 20_000, {
          promptTokens: 500,
          completionTokens: 100,
          copilotCredits: 1.5,
          modelState: { value: 1, completedAt: now - 10_000 },
          response: [{ value: 'synthetic fixture response' }],
          result: { metadata: { resolvedModel: 'claude-sonnet-5', toolCallRounds: [] } },
        })],
      },
      '{malformed',
    ]);

    const { sessions, fileIndex } = await parseCopilotVsCodeSessions([root], 30, null);
    assert.equal(sessions.length, 1);
    assert.equal(Object.keys(fileIndex).length, 1);
    const session = sessions[0];
    assert.equal(session.source, 'copilot');
    assert.equal(session.entrypoint, 'copilot-vscode');
    assert.equal(session.repoPath, repo);
    assert.equal(session.projectName, 'fixture-repo');
    assert.equal(session.totalInputTokens, 1_500);
    assert.equal(session.totalOutputTokens, 300);
    assert.equal(session.reasoningOutputTokens, 40);
    assert.equal(session.recordedCopilotCredits, 4);
    assert.equal(session.cost.totalCost, 0.04);
    assert.equal(session.estimatedCost, 0);
    assert.equal(session.costSource, 'recorded-ai-credits');
    assert.equal(session.model, 'gpt-5-mini');
    assert.equal(session.modelBreakdown['gpt-5-mini'].cost, 0.025);
    assert.equal(session.modelBreakdown['claude-sonnet-5'].cost, 0.015);
    assert.deepEqual(session.toolCalls, { create_file: 1, run_in_terminal: 1 });
    assert.equal(session.totalBashCalls, 1);
    assert.equal(session.verificationBashCalls, 1);
    assert.deepEqual(session.filesWritten, [path.join('src', 'app.js')]);
    assert.equal(session.userMessageCount, 2);
    assert.equal(session.assistantMessageCount, 2);
    assert.equal(session.usageEvents.length, 2);
    assert.equal(session.malformedEventCount, 1);
    assert.equal(session.costZeroed, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code parser keeps an active Copilot session without usage for correlation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-vscode-incomplete-'));
  const repo = path.join(root, 'fixture-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const now = Date.now();
  const edited = path.join(repo, 'src', 'draft.js');
  try {
    writeWorkspace(root, repo, 'incomplete-session', [{
      kind: 0,
      v: {
        version: 3,
        sessionId: 'incomplete-session',
        creationDate: now,
        responderUsername: 'GitHub Copilot',
        requests: [copilotRequest(now, {
          response: [
            { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'call-1', toolSpecificData: { commandLine: 'npm test' } },
            { kind: 'textEditGroup', uri: { scheme: 'file', fsPath: edited, path: edited }, edits: [] },
          ],
        })],
      },
    }]);

    const { sessions } = await parseCopilotVsCodeSessions([root], 30, null);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].costZeroed, true);
    assert.equal(sessions[0].cost.totalCost, 0);
    assert.equal(sessions[0].toolCalls.run_in_terminal, 1);
    assert.deepEqual(sessions[0].filesWritten, [path.join('src', 'draft.js')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code parser excludes sessions owned by another chat provider', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-vscode-filter-'));
  const repo = path.join(root, 'fixture-repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const now = Date.now();
  try {
    writeWorkspace(root, repo, 'other-provider', [{
      kind: 0,
      v: {
        version: 3,
        sessionId: 'other-provider',
        creationDate: now,
        // The explicit extension identity wins even if a stale session-level
        // label still says GitHub Copilot.
        responderUsername: 'GitHub Copilot',
        requests: [{
          ...copilotRequest(now),
          agent: { extensionId: { value: 'Other.chat', _lower: 'other.chat' }, id: 'other.chat.agent' },
          promptTokens: 1_000,
          completionTokens: 100,
          copilotCredits: 5,
        }],
      },
    }]);
    const { sessions } = await parseCopilotVsCodeSessions([root], 30, null);
    assert.deepEqual(sessions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code session discovery accepts a workspaceStorage root or one workspace directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'copilot-vscode-list-'));
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  try {
    writeWorkspace(root, repo, 'session-a', [{ kind: 0, v: { sessionId: 'session-a', requests: [] } }]);
    const workspaceDir = path.join(root, 'workspace-a');
    assert.equal(listCopilotVsCodeSessionFiles([root]).length, 1);
    assert.equal(listCopilotVsCodeSessionFiles([workspaceDir]).length, 1);
    assert.deepEqual(listCopilotVsCodeSessionFiles(['/missing/vscode/workspaceStorage']), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
