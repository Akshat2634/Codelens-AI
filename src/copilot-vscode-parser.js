import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  findGitRoot,
  isReadOnlyCommand,
  isVerificationCommand,
  toRelativePath,
} from './claude-parser.js';
import { calculateCopilotCostBreakdown } from './copilot-parser.js';

// VS Code persists chat sessions separately from the standalone Copilot CLI:
//   <User>/workspaceStorage/<workspace-hash>/
//     workspace.json
//     chatSessions/<session-id>.jsonl
//
// The JSONL is an incremental document: kind 0 is a base snapshot, kind 1
// replaces a path, and kind 2 appends values to an array path. We intentionally
// retain only usage/correlation metadata while replaying it — prompts and model
// responses never enter Codelens's cache.

const COPILOT_EXTENSION_IDS = new Set(['github.copilot-chat', 'github.copilot']);
const FILE_PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'filename', 'file', 'target_file', 'targetFile']);
const SHELL_TOOL_NAMES = /^(bash|shell|run|execute|run_in_terminal|terminal|exec|command|str_shell)$/i;
const EDIT_TOOL_NAMES = /(edit|write|create|str_replace|apply_patch|patch|insert|append|modify)/i;

function localDayStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function extensionIdOf(agent) {
  const raw = agent?.extensionId;
  if (typeof raw === 'string') return raw.toLowerCase();
  return String(raw?._lower || raw?.value || '').toLowerCase();
}

function isCopilotRequest(request, responderUsername = '') {
  const extensionId = extensionIdOf(request?.agent);
  if (extensionId) return COPILOT_EXTENSION_IDS.has(extensionId);
  const agentId = String(request?.agent?.id || '').toLowerCase();
  if (agentId) return agentId.startsWith('github.copilot.');
  // Old snapshots can omit agent identity. Only then use the session-level
  // responder label as a compatibility fallback; an explicit third-party
  // extension must never be counted as Copilot.
  return String(responderUsername).trim().toLowerCase() === 'github copilot';
}

function parseArgs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizeToolName(raw) {
  return String(raw || 'unknown')
    .replace(/^copilot[_-]/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function canonicalToolCallId(raw) {
  return String(raw || '').replace(/__vscode-\d+$/i, '');
}

function commandFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of ['command', 'cmd', 'script', 'commandLine', 'input']) {
    if (typeof args[key] === 'string') return args[key];
  }
  if (Array.isArray(args.command)) return args.command.map(String).join(' ');
  return null;
}

function collectFilePaths(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (FILE_PATH_KEYS.has(key) && typeof child === 'string' && child.trim()) out.add(child.trim());
    if (key === 'uri' && child && typeof child === 'object') {
      const uriPath = child.fsPath || (child.scheme === 'file' ? child.path : null);
      if (typeof uriPath === 'string' && uriPath) out.add(uriPath);
    }
    if (child && typeof child === 'object') collectFilePaths(child, out);
  }
  return out;
}

function localPathFromUri(value) {
  if (value && typeof value === 'object') {
    if (typeof value.fsPath === 'string') return value.fsPath;
    value = value.external || value.path;
  }
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('file:')) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  return path.isAbsolute(value) ? value : null;
}

function workspaceRootFor(sessionFile) {
  const workspaceDir = path.dirname(path.dirname(sessionFile));
  try {
    const metadata = JSON.parse(readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'));
    const folder = localPathFromUri(metadata.folder);
    if (folder) return folder;
    const workspaceFile = localPathFromUri(metadata.workspace || metadata.configuration);
    if (!workspaceFile) return null;
    try {
      const config = JSON.parse(readFileSync(workspaceFile, 'utf8'));
      const roots = (config.folders || [])
        .map(item => {
          if (typeof item?.uri === 'string') return localPathFromUri(item.uri);
          if (typeof item?.path !== 'string') return null;
          return path.resolve(path.dirname(workspaceFile), item.path);
        })
        .filter(Boolean);
      if (roots.length === 1) return roots[0];
    } catch { }
    return path.dirname(workspaceFile);
  } catch {
    return null;
  }
}

function requestState() {
  return {
    isCopilot: false,
    hasUserMessage: false,
    hasAssistantResponse: false,
    timestamp: null,
    responseTimestamp: null,
    completedAt: null,
    modelId: null,
    resolvedModel: null,
    promptTokens: null,
    completionTokens: null,
    copilotCredits: null,
    reasoningTokens: 0,
    tools: new Map(),
    files: new Set(),
  };
}

function upsertTool(request, rawTool, { fallback = false } = {}) {
  const callId = canonicalToolCallId(rawTool?.id || rawTool?.toolCallId || rawTool?.tool_call_id);
  const key = callId || `${normalizeToolName(rawTool?.name || rawTool?.toolId)}:${request.tools.size}`;
  if (fallback && request.tools.has(key)) return;
  request.tools.set(key, {
    name: normalizeToolName(rawTool?.name || rawTool?.toolId),
    args: parseArgs(rawTool?.arguments ?? rawTool?.input ?? rawTool?.toolSpecificData),
  });
}

function processResponseParts(request, parts) {
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue;
    request.hasAssistantResponse = true;
    if (part.kind === 'toolInvocationSerialized') upsertTool(request, part, { fallback: true });
    if (part.kind === 'textEditGroup') {
      const filePath = localPathFromUri(part.uri);
      if (filePath) request.files.add(filePath);
    }
  }
}

function processResult(request, result) {
  const metadata = result?.metadata;
  if (!metadata || typeof metadata !== 'object') return;
  request.resolvedModel = metadata.resolvedModel || request.resolvedModel;
  if (!Number.isFinite(request.promptTokens) && Number.isFinite(metadata.promptTokens)) request.promptTokens = metadata.promptTokens;
  if (!Number.isFinite(request.completionTokens) && Number.isFinite(metadata.outputTokens)) request.completionTokens = metadata.outputTokens;
  let reasoning = 0;
  for (const round of metadata.toolCallRounds || []) {
    reasoning += Number(round?.thinking?.tokens) || 0;
    for (const tool of round?.toolCalls || []) upsertTool(request, tool);
  }
  request.reasoningTokens = reasoning;
  request.hasAssistantResponse = true;
}

function processRequestSnapshot(request, raw, responderUsername) {
  if (!raw || typeof raw !== 'object') return;
  request.isCopilot ||= isCopilotRequest(raw, responderUsername);
  request.hasUserMessage ||= !!raw.message;
  request.hasAssistantResponse ||= Array.isArray(raw.response) && raw.response.length > 0;
  request.timestamp = toEpochMs(raw.timestamp) ?? request.timestamp;
  request.responseTimestamp = toEpochMs(raw.responseTimestamp) ?? request.responseTimestamp;
  request.completedAt = toEpochMs(raw.modelState?.completedAt) ?? request.completedAt;
  request.modelId = raw.modelId || request.modelId;
  processResult(request, raw.result);
  if (Number.isFinite(raw.promptTokens)) request.promptTokens = raw.promptTokens;
  if (Number.isFinite(raw.completionTokens)) request.completionTokens = raw.completionTokens;
  if (Number.isFinite(raw.copilotCredits)) request.copilotCredits = raw.copilotCredits;
  processResponseParts(request, raw.response);
}

function processRequestUpdate(request, fieldPath, value, responderUsername) {
  const field = fieldPath[0];
  if (!field) processRequestSnapshot(request, value, responderUsername);
  else if (field === 'result' && fieldPath.length === 1) processResult(request, value);
  else if (field === 'result' && fieldPath[1] === 'metadata') {
    const metadataField = fieldPath[2];
    if (!metadataField) processResult(request, { metadata: value });
    else if (metadataField === 'resolvedModel') request.resolvedModel = value || request.resolvedModel;
    else if (metadataField === 'promptTokens' && Number.isFinite(value)) request.promptTokens = value;
    else if (metadataField === 'outputTokens' && Number.isFinite(value)) request.completionTokens = value;
    else if (metadataField === 'toolCallRounds') processResult(request, { metadata: { toolCallRounds: value } });
  }
  else if (field === 'response') processResponseParts(request, value);
  else if (field === 'agent') request.isCopilot ||= isCopilotRequest({ agent: value }, responderUsername);
  else if (field === 'modelId') request.modelId = value || request.modelId;
  else if (field === 'timestamp') request.timestamp = toEpochMs(value) ?? request.timestamp;
  else if (field === 'responseTimestamp') request.responseTimestamp = toEpochMs(value) ?? request.responseTimestamp;
  else if (field === 'modelState') request.completedAt = toEpochMs(value?.completedAt) ?? request.completedAt;
  else if (field === 'promptTokens' && Number.isFinite(value)) request.promptTokens = value;
  else if (field === 'completionTokens' && Number.isFinite(value)) request.completionTokens = value;
  else if (field === 'copilotCredits' && Number.isFinite(value)) request.copilotCredits = value;
}

function createSession(sessionId) {
  return {
    sessionId,
    source: 'copilot',
    repoPath: null,
    projectName: null,
    gitBranch: null,
    entrypoint: 'copilot-vscode',
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reasoningOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    usageEvents: [],
    cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 },
    model: null,
    modelBreakdown: {},
    toolCalls: {},
    skillCalls: {},
    subagentTranscriptCount: 0,
    filesWritten: [],
    userMessageCount: 0,
    assistantMessageCount: 0,
    bashCommands: [],
    totalBashCalls: 0,
    verificationBashCalls: 0,
    readOnlyBashCalls: 0,
    estimatedCost: 0,
    cacheSavingsDollars: 0,
    multiRepoContext: false,
    recordedCopilotCredits: 0,
  };
}

function addCost(target, amount) {
  for (const key of ['inputCost', 'outputCost', 'cacheReadCost', 'cacheCreationCost', 'serverToolCost', 'totalCost']) {
    target[key] += amount[key] || 0;
  }
}

function requestCost(request, model, usageMs) {
  const input = Number(request.promptTokens) || 0;
  const output = Number(request.completionTokens) || 0;
  const nominal = calculateCopilotCostBreakdown(input, output, 0, 0, model, usageMs, null);
  if (!Number.isFinite(request.copilotCredits)) return { breakdown: nominal, estimated: nominal.totalCost };
  const exact = request.copilotCredits * 0.01;
  if (!(nominal.totalCost > 0)) {
    return {
      breakdown: { inputCost: exact, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: exact },
      estimated: 0,
    };
  }
  const scale = exact / nominal.totalCost;
  return {
    breakdown: {
      inputCost: nominal.inputCost * scale,
      outputCost: nominal.outputCost * scale,
      cacheReadCost: 0,
      cacheCreationCost: 0,
      serverToolCost: 0,
      totalCost: exact,
    },
    estimated: 0,
  };
}

async function parseVsCodeSessionFile(filePath, cutoffMs) {
  const requests = [];
  let responderUsername = '';
  let sessionId = path.basename(filePath, '.jsonl');
  let creationDate = null;
  let malformedLines = 0;
  const getRequest = (index) => {
    while (requests.length <= index) requests.push(requestState());
    return requests[index];
  };

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { malformedLines++; continue; }
    if (record.kind === 0 && record.v && typeof record.v === 'object') {
      requests.length = 0;
      responderUsername = record.v.responderUsername || '';
      sessionId = record.v.sessionId || sessionId;
      creationDate = toEpochMs(record.v.creationDate);
      for (const [index, raw] of (record.v.requests || []).entries()) {
        processRequestSnapshot(getRequest(index), raw, responderUsername);
      }
      continue;
    }
    if (!Array.isArray(record.k) || record.k[0] !== 'requests') continue;
    if (record.kind === 2 && record.k.length === 1 && Array.isArray(record.v)) {
      for (const raw of record.v) processRequestSnapshot(getRequest(requests.length), raw, responderUsername);
      continue;
    }
    const index = Number(record.k[1]);
    if (!Number.isInteger(index) || index < 0) continue;
    if (record.kind === 2 && record.k[2] === 'response') {
      processResponseParts(getRequest(index), record.v);
    } else if (record.kind === 1) {
      processRequestUpdate(getRequest(index), record.k.slice(2), record.v, responderUsername);
    }
  }

  const session = createSession(sessionId);
  if (malformedLines > 0) session.malformedEventCount = malformedLines;
  const workspaceRoot = workspaceRootFor(filePath);
  const rawFiles = new Set();
  const modelTotals = new Map();
  const daily = {};
  let recordedCostRequests = 0;
  let fallbackCostRequests = 0;
  let maxModelTokens = -1;

  for (const request of requests) {
    if (!request.isCopilot) continue;
    const startMs = request.timestamp || creationDate;
    const activityMs = request.completedAt || request.responseTimestamp || startMs;
    if (!activityMs || activityMs < cutoffMs) continue;
    const input = Number(request.promptTokens) || 0;
    const output = Number(request.completionTokens) || 0;
    const model = request.resolvedModel || request.modelId || 'copilot/auto';
    const { breakdown, estimated } = requestCost(request, model, activityMs);

    const startIso = new Date(startMs || activityMs).toISOString();
    const endIso = new Date(activityMs).toISOString();
    if (!session.startTime || (startMs || activityMs) < Date.parse(session.startTime)) session.startTime = startIso;
    if (!session.endTime || activityMs > Date.parse(session.endTime)) session.endTime = endIso;
    if (request.hasUserMessage) session.userMessageCount++;
    if (request.hasAssistantResponse || input + output > 0 || Number.isFinite(request.copilotCredits)) session.assistantMessageCount++;
    session.totalInputTokens += input;
    session.totalOutputTokens += output;
    session.reasoningOutputTokens += request.reasoningTokens || 0;
    addCost(session.cost, breakdown);
    session.estimatedCost += estimated;
    if (Number.isFinite(request.copilotCredits)) {
      session.recordedCopilotCredits += request.copilotCredits;
      recordedCostRequests++;
    } else if (input + output > 0) {
      fallbackCostRequests++;
    }

    const modelRow = modelTotals.get(model) || { tokens: 0, cost: 0 };
    modelRow.tokens += input + output;
    modelRow.cost += breakdown.totalCost;
    modelTotals.set(model, modelRow);
    if (modelRow.tokens > maxModelTokens) {
      maxModelTokens = modelRow.tokens;
      session.model = model;
    }

    const dayKey = localDayStr(activityMs);
    const day = daily[dayKey] || (daily[dayKey] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
      byModel: {},
    });
    day.inputTokens += input;
    day.outputTokens += output;
    day.cost += breakdown.totalCost;
    const dayModel = day.byModel[model] || (day.byModel[model] = { tokens: 0, cost: 0 });
    dayModel.tokens += input + output;
    dayModel.cost += breakdown.totalCost;
    if (input + output > 0 || breakdown.totalCost > 0) {
      session.usageEvents.push({ ts: activityMs, input, output, cacheRead: 0, cacheCreate: 0, cost: breakdown.totalCost });
    }

    for (const tool of request.tools.values()) {
      session.toolCalls[tool.name] = (session.toolCalls[tool.name] || 0) + 1;
      if (SHELL_TOOL_NAMES.test(tool.name)) {
        const command = commandFromArgs(tool.args);
        if (command) {
          session.totalBashCalls++;
          if (isVerificationCommand(command)) {
            session.verificationBashCalls++;
            session.bashCommands.push({ command: command.slice(0, 200), isVerification: true });
          }
          if (isReadOnlyCommand(command)) session.readOnlyBashCalls++;
        }
      }
      if (EDIT_TOOL_NAMES.test(tool.name)) {
        for (const file of collectFilePaths(tool.args)) rawFiles.add(file);
      }
    }
    for (const file of request.files) rawFiles.add(file);
  }

  session.modelBreakdown = Object.fromEntries(modelTotals);
  session.dailyUsage = daily;
  session.costSource = fallbackCostRequests > 0
    ? (recordedCostRequests > 0 ? 'recorded-ai-credits+estimated-token-pricing' : 'estimated-token-pricing')
    : 'recorded-ai-credits';

  const resolvedFiles = [...rawFiles].map(file => path.isAbsolute(file)
    ? file
    : path.join(workspaceRoot || '/', file));
  const roots = new Set();
  const workspaceGitRoot = workspaceRoot ? findGitRoot(workspaceRoot) : null;
  if (workspaceGitRoot) roots.add(workspaceGitRoot);
  for (const file of resolvedFiles) {
    const root = findGitRoot(path.dirname(file));
    if (root) roots.add(root);
  }
  if (roots.size === 1) session.repoPath = [...roots][0];
  else if (roots.size > 1) session.multiRepoContext = true;
  else session.repoPath = workspaceRoot;
  session.filesWrittenAbsolute = [...new Set(resolvedFiles)];
  session.filesWritten = session.multiRepoContext ? [] : [...new Set(
    resolvedFiles.map(file => toRelativePath(file, session.repoPath)).filter(Boolean)
  )];
  session.projectName = roots.size === 1 ? path.basename(session.repoPath) : null;

  if (session.startTime && session.endTime) {
    session.durationMinutes = Math.round((Date.parse(session.endTime) - Date.parse(session.startTime)) / 6000) / 10;
  }
  if (session.startTime && session.totalInputTokens + session.totalOutputTokens === 0 && recordedCostRequests === 0) {
    session.costZeroed = true;
  }
  return session;
}

function workspaceDirsUnder(root) {
  if (!root) return [];
  if (existsSync(path.join(root, 'chatSessions'))) return [root];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function listCopilotVsCodeSessionFiles(workspaceStorageDirs, out = []) {
  for (const root of workspaceStorageDirs || []) {
    for (const workspaceDir of workspaceDirsUnder(root)) {
      const chatDir = path.join(workspaceDir, 'chatSessions');
      try {
        for (const entry of readdirSync(chatDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(chatDir, entry.name));
        }
      } catch { }
    }
  }
  return out.sort();
}

export async function parseCopilotVsCodeSessions(workspaceStorageDirs, days, projectFilter) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();
  const fileIndex = {};
  const sessions = [];

  for (const filePath of listCopilotVsCodeSessionFiles(workspaceStorageDirs)) {
    let mtime;
    try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
    if (mtime < cutoffMs) continue;
    fileIndex[filePath] = mtime;
    try {
      const session = await parseVsCodeSessionFile(filePath, cutoffMs);
      if (!session.startTime) continue;
      const activity = session.userMessageCount + session.assistantMessageCount
        + Object.values(session.toolCalls).reduce((sum, count) => sum + count, 0)
        + session.totalInputTokens + session.totalOutputTokens;
      if (activity === 0) continue;
      const workspaceName = session.repoPath ? path.basename(session.repoPath) : '';
      if (projectFilter && !workspaceName.toLowerCase().includes(projectFilter.toLowerCase())) continue;
      sessions.push(session);
    } catch (error) {
      process.stderr.write(`Warning: Failed to parse VS Code Copilot session ${filePath}: ${error.message}\n`);
    }
  }

  const byId = new Map();
  for (const session of sessions) {
    const existing = byId.get(session.sessionId);
    const score = session.totalInputTokens + session.totalOutputTokens + session.userMessageCount + session.assistantMessageCount;
    const existingScore = existing
      ? existing.totalInputTokens + existing.totalOutputTokens + existing.userMessageCount + existing.assistantMessageCount
      : -1;
    if (score > existingScore) byId.set(session.sessionId, session);
  }
  const deduped = [...byId.values()].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  return { sessions: deduped, fileIndex };
}
