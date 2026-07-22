import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  findGitRoot,
  getModelFamily as getClaudeModelFamily,
  getPricingTier,
  isReadOnlyCommand,
  isVerificationCommand,
  PRICING,
  toRelativePath,
} from './claude-parser.js';
import { getCodexModelFamily, getCodexPricing } from './codex-parser.js';
import { lookupExternalRate } from './pricing.js';

// ── GitHub Copilot CLI session parser ──
//
// The standalone GitHub Copilot CLI (npm `@github/copilot`, binary `copilot`,
// GA 2026-02-25 — NOT the retired `gh copilot` suggest/explain extension, and
// NOT the IDE completions surface) stores one directory per session:
//   $COPILOT_HOME/session-state/<session-id>/
//     ├─ events.jsonl     ← the transcript + usage record we parse
//     ├─ workspace.yaml    ← session metadata (cwd, git branch)
//     └─ plan.md           (optional)
// $COPILOT_HOME defaults to ~/.copilot and replaces the WHOLE path when set.
// (A global ~/.copilot/session-store.db SQLite index also exists but is only a
// subset of the files and would need a native dependency — we read the JSONL
// directly, exactly as claude-parser/codex-parser read their local files.)
//
// events.jsonl is genuine JSONL — one JSON object per line, streamed like Codex
// rollouts (a try/catch skip transparently handles the known U+2028/U+2029
// raw-character corruption bug that breaks JSON.parse). The envelope is an
// undocumented, reverse-engineered shape { type, timestamp, data } where `type`
// is a dotted event name (session.start, user.message, assistant.turn_start,
// tool.execution_start/complete, skill.invoked, subagent.started,
// session.shutdown, ...). Because the format is unofficial and versions across
// CLI releases, every field is read defensively (multiple aliases, tolerant of
// absent records).
//
// The LOAD-BEARING usage record is `session.shutdown`, whose data carries
// `modelMetrics` keyed by model id, each with:
//   usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}
//   requests.{count, cost}
// These are SESSION TOTALS (not per-request deltas), persisted at session end
// from ~early 2026 onward. ~1 in 8 recent sessions (crashed / force-killed) has
// no shutdown record — those are kept for commit correlation but marked
// `costZeroed` so a real commit landing on an unknown-cost session can't grade
// as a fabricated 'A' (metrics.computeSessionGrade returns null for it).
//
// Token-field mapping onto the uniform claude-parser session shape (source:
// 'copilot'):
//   totalInputTokens    = usage.inputTokens        (treated as FRESH input —
//                         cacheReadTokens is a SEPARATE field, so we do NOT
//                         subtract it; this matches the Anthropic convention
//                         and never under-counts. If a future capture proves
//                         inputTokens is inclusive of cache reads, subtract
//                         cacheRead here.)
//   cacheReadTokens     = usage.cacheReadTokens
//   cacheCreationTokens = usage.cacheWriteTokens   (Anthropic-style write; 0 for
//                         OpenAI/Gemini models, which have no write premium)
//   cacheCreation1hTokens = 0
//   totalOutputTokens   = usage.outputTokens       (reasoning already included —
//                         reasoningOutputTokens is informational only)
//
// Pricing: GitHub's usage-based (post-2026-06-01) per-token rates match each
// underlying provider's own rates (verified against models-and-pricing.yml —
// e.g. Claude Sonnet 4.5 $3/$15 with a $3.75 cache-write, identical to
// Anthropic), so we REUSE the authoritative provider tables instead of
// maintaining a drift-prone GitHub copy: Claude ids -> claude-parser's tiers,
// GPT/o ids -> codex-parser's table, everything else (Gemini, ...) -> the
// LiteLLM overlay, then a flagged Sonnet-ish estimate.

const PER_MIL = 1_000_000;

// Sentinel day-bucket for usage with no resolvable timestamp; resolved to the
// session's earliest real day after parsing (mirrors claude/codex parsers).
const UNBUCKETED_DAY = '__unbucketed__';

// Unknown/unpriced model — Sonnet-ish rates, flagged as estimated spend so a
// silent $0 never understates cost (mirrors CODEX_FALLBACK / the Sonnet
// last-resort in claude-parser). cacheWrite = 1.25x input like Anthropic.
const COPILOT_FALLBACK = { input: 3, cachedInput: 0.30, output: 15, cacheWrite: 3.75, estimate: true };

// Gemini is the only Copilot model family the Claude/Codex tables don't cover;
// claude/gpt/o ids are already claimed by those parsers' family detectors.
export function getCopilotModelFamily(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  if (lower.includes('gemini')) return 'gemini';
  return null;
}

// Resolve a Copilot model id to per-million rates + an `estimate` flag,
// delegating the actual matching (version tiers, date-tiering, long context,
// external overlay) to the authoritative provider functions. Copilot ids use
// dotted minor versions (claude-sonnet-4.5, opus-4.8) which getPricingTier's
// `[-.]` matcher already accepts.
export function getCopilotPricing(modelName, usageDateMs = Date.now()) {
  if (!modelName) return null;
  // Claude models keep Anthropic's per-tier rates (incl. the 1.25x cache-write).
  if (getClaudeModelFamily(modelName)) {
    const tier = getPricingTier(modelName, usageDateMs);
    if (tier) {
      const p = PRICING[tier];
      return { input: p.input, cachedInput: p.cacheRead, output: p.output, cacheWrite: p.cacheWrite, estimate: false };
    }
  }
  // GPT / o-series reuse the Codex (OpenAI) table. OpenAI's automatic caching
  // has no write premium, so cacheWrite is 0.
  if (getCodexModelFamily(modelName)) {
    const p = getCodexPricing(modelName, usageDateMs);
    if (p) return { input: p.input, cachedInput: p.cachedInput, output: p.output, cacheWrite: 0, estimate: !!p.estimate };
  }
  // Gemini and anything else: the external LiteLLM overlay carries real rates.
  const ext = lookupExternalRate(modelName);
  if (ext) return { input: ext.input, cachedInput: ext.cacheRead, output: ext.output, cacheWrite: ext.cacheWrite ?? 0, estimate: false };
  return COPILOT_FALLBACK;
}

function calculateCopilotCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs = Date.now()) {
  const p = getCopilotPricing(modelName, usageDateMs) || COPILOT_FALLBACK;
  const inputCost = inputTokens * p.input / PER_MIL;
  const outputCost = outputTokens * p.output / PER_MIL;
  const cacheReadCost = cacheReadTokens * p.cachedInput / PER_MIL;
  const cacheCreationCost = cacheCreationTokens * (p.cacheWrite ?? 0) / PER_MIL;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    serverToolCost: 0,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost,
  };
}

export function calculateCopilotCost(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs = Date.now()) {
  return calculateCopilotCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs).totalCost;
}

// List every session's events.jsonl under session-state/. Each session is a
// sub-directory named by its session id; the transcript is <id>/events.jsonl.
export function listCopilotSessionFiles(copilotDir, out = []) {
  if (!copilotDir) return out;
  let entries;
  try {
    entries = readdirSync(copilotDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const eventsFile = path.join(copilotDir, entry.name, 'events.jsonl');
    if (existsSync(eventsFile)) out.push(eventsFile);
  }
  return out;
}

async function* eventLines(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  yield* rl;
}

function localDayStr(dateLike) {
  const dt = new Date(dateLike);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function createEmptyCopilotSession(sessionId) {
  return {
    sessionId,
    source: 'copilot',
    repoPath: null,
    projectName: null,
    gitBranch: null,
    entrypoint: 'copilot-cli',
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
    copilotPlanType: null,
  };
}

// Minimal, dependency-free grab of a scalar value from a YAML sidecar. Copilot's
// workspace.yaml is small and flat enough that a keyed line scan is sufficient
// (avoids pulling in a YAML dependency for two fields).
function readYamlValue(text, keys) {
  for (const key of keys) {
    const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mi'));
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v && v !== 'null' && v !== '~') return v;
    }
  }
  return null;
}

// Copilot's edit-family tools name the target path under one of several arg
// keys depending on the tool. Pull whatever path-like value is present.
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file', 'targetFile'];
function extractToolFilePath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of FILE_PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
  }
  return null;
}

const SHELL_TOOL_NAMES = /^(bash|shell|run|execute|run_in_terminal|terminal|exec|command|str_shell)$/i;
const EDIT_TOOL_NAMES = /(edit|write|create|str_replace|apply_patch|patch|insert|append|modify)/i;

function commandFromToolArgs(args) {
  if (!args || typeof args !== 'object') return null;
  for (const key of ['command', 'cmd', 'script', 'commandLine', 'input']) {
    if (typeof args[key] === 'string') return args[key];
  }
  if (Array.isArray(args.command)) return args.command.map(String).join(' ');
  return null;
}

function trackShellCommand(session, command) {
  if (!command) return;
  session.totalBashCalls++;
  if (isVerificationCommand(command)) {
    session.verificationBashCalls++;
    session.bashCommands.push({ command: command.slice(0, 200), isVerification: true });
  }
  if (isReadOnlyCommand(command)) session.readOnlyBashCalls++;
}

// Parse whatever shape a tool call's arguments arrived in (object or JSON string).
function parseArgs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

// cutoffMs clips usage accumulation to the lookback window, mirroring the other
// parsers. Copilot usage is a single session-total record (session.shutdown),
// so clipping is effectively "count it if the shutdown is inside the window".
async function parseCopilotEvents(filePath, cutoffMs = 0) {
  const sessionDir = path.dirname(filePath);
  const session = createEmptyCopilotSession(path.basename(sessionDir));

  // Sidecar metadata: cwd / git branch. Read first so an events.jsonl that
  // never carries them still resolves a repoPath for correlation.
  try {
    const yaml = readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf-8');
    session.repoPath = readYamlValue(yaml, ['cwd', 'workingDirectory', 'working_directory', 'directory', 'root']) || session.repoPath;
    session.gitBranch = readYamlValue(yaml, ['branch', 'gitBranch', 'git_branch']) || session.gitBranch;
  } catch {
    // No sidecar (older CLI, or a session that never wrote one) — fall back to
    // fields on session.start below.
  }

  const modelTokens = {}; // model -> { input, output, cacheRead, cacheCreate }
  const dailyModelTokens = {}; // dateStr -> model -> { input, output, cacheRead, cacheCreate }
  const rawFiles = new Set();
  let turnStarts = 0;
  let assistantMessages = 0;
  let requestCount = 0; // summed modelMetrics.requests.count — the model-request analog
  let sawShutdownUsage = false;
  let sawToolStart = false;
  const completeOnlyTools = []; // completions held back until we know no starts were logged

  const trackToolCall = (name) => {
    if (!name) return;
    session.toolCalls[name] = (session.toolCalls[name] || 0) + 1;
  };

  const touchTimestamp = (ts) => {
    if (!ts) return;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return;
    if (!session.startTime || ms < Date.parse(session.startTime)) session.startTime = ts;
    if (!session.endTime || ms > Date.parse(session.endTime)) session.endTime = ts;
  };

  // Accumulate one model's session-total usage into the model + daily buckets
  // and push a usageEvents record (one per model, stamped at the session-end
  // day) for the 5-hour billing blocks / burn rate.
  const accumulateModelUsage = (model, u, dayMs) => {
    const input = Math.max(0, Number(u.inputTokens ?? u.input_tokens ?? u.input ?? 0));
    const cacheRead = Math.max(0, Number(u.cacheReadTokens ?? u.cache_read_tokens ?? u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0));
    const cacheCreate = Math.max(0, Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? u.cacheCreationTokens ?? u.cache_creation_tokens ?? 0));
    const output = Math.max(0, Number(u.outputTokens ?? u.output_tokens ?? u.output ?? 0));
    const reasoning = Math.max(0, Number(u.reasoningTokens ?? u.reasoning_tokens ?? u.reasoningOutputTokens ?? 0));
    if (input === 0 && cacheRead === 0 && cacheCreate === 0 && output === 0) return;

    session.totalInputTokens += input;
    session.totalOutputTokens += output;
    session.reasoningOutputTokens += reasoning;
    session.cacheReadTokens += cacheRead;
    session.cacheCreationTokens += cacheCreate;

    if (!modelTokens[model]) modelTokens[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    modelTokens[model].input += input;
    modelTokens[model].output += output;
    modelTokens[model].cacheRead += cacheRead;
    modelTokens[model].cacheCreate += cacheCreate;

    const dateStr = Number.isFinite(dayMs) ? localDayStr(dayMs) : UNBUCKETED_DAY;
    if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
    if (!dailyModelTokens[dateStr][model]) dailyModelTokens[dateStr][model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    dailyModelTokens[dateStr][model].input += input;
    dailyModelTokens[dateStr][model].output += output;
    dailyModelTokens[dateStr][model].cacheRead += cacheRead;
    dailyModelTokens[dateStr][model].cacheCreate += cacheCreate;

    if (Number.isFinite(dayMs)) {
      session.usageEvents.push({
        ts: dayMs,
        input, output, cacheRead, cacheCreate,
        cost: calculateCopilotCost(input, output, cacheRead, cacheCreate, model, dayMs),
      });
    }
  };

  for await (const line of eventLines(filePath)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // malformed line (incl. the U+2028/U+2029 corruption bug) — skip
    }

    const type = String(obj.type || obj.event || obj.name || '').toLowerCase();
    const ts = obj.timestamp || obj.time || obj.ts || obj.data?.timestamp || null;
    const data = obj.data || obj.payload || obj;
    if (ts) touchTimestamp(ts);

    // ── session lifecycle ──
    if (type === 'session.start' || type === 'session.started' || type === 'session_start' || type === 'session.created') {
      session.sessionId = data.sessionId || data.session_id || data.id || session.sessionId;
      const cwd = data.cwd || data.workingDirectory || data.working_directory || data.workspace?.path || data.workspacePath;
      if (cwd && !session.repoPath) session.repoPath = cwd;
      const branch = data.gitBranch || data.git?.branch || data.branch;
      if (branch && !session.gitBranch) session.gitBranch = branch;
      // Some builds record the client surface (cli / vscode / jetbrains).
      const surface = String(data.client || data.source || data.surface || '').toLowerCase();
      if (surface.includes('vscode') || surface.includes('vs-code')) session.entrypoint = 'copilot-vscode';
      else if (surface.includes('jetbrains') || surface.includes('intellij')) session.entrypoint = 'copilot-jetbrains';
      continue;
    }

    if (type === 'session.shutdown' || type === 'session.end' || type === 'session_shutdown' || type === 'session.stopped') {
      // The authoritative usage record: modelMetrics keyed by model id.
      const metrics = data.modelMetrics || data.model_metrics || data.usage?.modelMetrics || data.metrics?.model;
      const shutdownMs = ts ? Date.parse(ts) : (session.endTime ? Date.parse(session.endTime) : Date.now());
      if (metrics && typeof metrics === 'object') {
        for (const [model, m] of Object.entries(metrics)) {
          if (!m || typeof m !== 'object') continue;
          const usage = m.usage || m;
          // Window clipping: a session-total record dated before the cutoff is
          // not this window's spend.
          if (cutoffMs && Number.isFinite(shutdownMs) && shutdownMs < cutoffMs) continue;
          accumulateModelUsage(model, usage, shutdownMs);
          sawShutdownUsage = true;
          const reqs = m.requests || m.request;
          if (reqs && Number.isFinite(Number(reqs.count))) requestCount += Number(reqs.count);
        }
      }
      continue;
    }

    // ── conversation ──
    if (type === 'user.message' || type === 'user_message' || type === 'user.prompt') {
      // Skip injected/system-authored user turns; count real prompts only.
      const role = String(data.role || 'user').toLowerCase();
      const kind = String(data.kind || data.messageType || 'plain').toLowerCase();
      if (role === 'user' && (kind === 'plain' || kind === 'user' || kind === '')) session.userMessageCount++;
      continue;
    }
    if (type === 'assistant.turn_start' || type === 'assistant.turnstart' || type === 'turn.start') {
      turnStarts++;
      continue;
    }
    if (type === 'assistant.message' || type === 'assistant_message') {
      assistantMessages++;
      continue;
    }

    // ── tools / skills / subagents ──
    if (type === 'tool.execution_start' || type === 'tool.execution_complete' || type === 'tool.call' || type === 'tool_call' || type === 'tool.execution_end') {
      const name = data.tool || data.name || data.toolName || data.tool_name || 'unknown';
      const isComplete = type.includes('complete') || type.includes('end');
      const isStart = !isComplete; // execution_start / tool.call / tool_call are invocations
      const args = parseArgs(data.arguments ?? data.args ?? data.input ?? data.parameters);
      // Count each call once — on the invocation. Completions are held back and
      // only counted if the session never logged a start (older/partial logs),
      // so a start+complete pair never double-counts.
      if (isStart) {
        sawToolStart = true;
        trackToolCall(name);
        if (SHELL_TOOL_NAMES.test(name)) trackShellCommand(session, commandFromToolArgs(args));
      } else {
        completeOnlyTools.push({ name, args });
      }
      // File paths dedupe via the Set, so reading them from either event is safe.
      if (EDIT_TOOL_NAMES.test(name)) {
        const fp = extractToolFilePath(args);
        if (fp) rawFiles.add(fp);
      }
      continue;
    }

    if (type === 'skill.invoked' || type === 'skill.start' || type === 'skill.started' || type === 'skill_invoked') {
      const name = data.skill || data.name || data.skillName || data.skill_name;
      if (name) session.skillCalls[name] = (session.skillCalls[name] || 0) + 1;
      continue;
    }

    if (type === 'subagent.started' || type === 'subagent.start' || type === 'agent.spawned' || type === 'subagent.completed') {
      if (type.includes('start') || type.includes('spawn')) session.subagentTranscriptCount++;
      continue;
    }

    // assistant.turn_end / tool nested output / compaction / unknown: ignored.
  }

  // Sessions that only logged tool completions (never starts) still need their
  // tools + shell commands counted — replay the held-back completions.
  if (!sawToolStart) {
    for (const { name, args } of completeOnlyTools) {
      trackToolCall(name);
      if (SHELL_TOOL_NAMES.test(name)) trackShellCommand(session, commandFromToolArgs(args));
    }
  }

  // Assistant "actions" drive the autopilot ratio. Prefer the count of model
  // requests (the Codex/Claude analog of one assistant API message); fall back
  // to turn starts, then assistant messages.
  session.assistantMessageCount = requestCount > 0 ? requestCount : (turnStarts > 0 ? turnStarts : assistantMessages);

  // Resolve unbucketed usage to the earliest known day (mirrors the other
  // parsers), clamped into the analyzed window.
  const rawStartMs = session.startTime ? Date.parse(session.startTime) : Date.now();
  if (dailyModelTokens[UNBUCKETED_DAY]) {
    const realDays = Object.keys(dailyModelTokens).filter(d => d !== UNBUCKETED_DAY).sort();
    let targetMs = realDays.length > 0 ? Date.parse(realDays[0] + 'T12:00:00') : rawStartMs;
    if (cutoffMs) targetMs = Math.max(targetMs, cutoffMs);
    const target = localDayStr(targetMs);
    const day = dailyModelTokens[target] || (dailyModelTokens[target] = {});
    for (const [model, tk] of Object.entries(dailyModelTokens[UNBUCKETED_DAY])) {
      if (!day[model]) day[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      for (const k of Object.keys(tk)) day[model][k] += tk[k];
    }
    delete dailyModelTokens[UNBUCKETED_DAY];
  }

  // Session-level cost + primary model (same structure as codex-parser).
  const sessionDateMs = cutoffMs ? Math.max(rawStartMs, cutoffMs) : rawStartMs;
  let maxTokens = 0;
  let primaryModel = null;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    const bd = calculateCopilotCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, sessionDateMs);
    const p = getCopilotPricing(model, sessionDateMs) || COPILOT_FALLBACK;
    session.cacheSavingsDollars += tokens.cacheRead * (p.input - p.cachedInput) / PER_MIL;
    if (p.estimate) session.estimatedCost += bd.totalCost;
    const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    session.modelBreakdown[model] = { tokens: totalTokens, cost: bd.totalCost };
    session.cost.inputCost += bd.inputCost;
    session.cost.outputCost += bd.outputCost;
    session.cost.cacheReadCost += bd.cacheReadCost;
    session.cost.cacheCreationCost += bd.cacheCreationCost;
    session.cost.totalCost += bd.totalCost;
    if (totalTokens > maxTokens) {
      maxTokens = totalTokens;
      primaryModel = model;
    }
  }
  session.model = primaryModel;

  // Per-day cost timeline (reconciles with session.cost, like codex-parser).
  session.dailyUsage = {};
  const dailyModelCost = {};
  const dailyTotal = { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 };
  let dailyCoveredTokens = 0;
  let dailySavings = 0;
  let dailyEstimated = 0;
  for (const [dateStr, models] of Object.entries(dailyModelTokens)) {
    let dayCost = 0;
    let dayInput = 0;
    let dayOutput = 0;
    let dayCacheRead = 0;
    let dayCacheCreate = 0;
    const dayByModel = {};
    const dayMs = Date.parse(dateStr + 'T12:00:00Z');
    for (const [model, tokens] of Object.entries(models)) {
      const bd = calculateCopilotCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, dayMs);
      dayCost += bd.totalCost;
      dailyModelCost[model] = (dailyModelCost[model] || 0) + bd.totalCost;
      dailyTotal.inputCost += bd.inputCost;
      dailyTotal.outputCost += bd.outputCost;
      dailyTotal.cacheReadCost += bd.cacheReadCost;
      dailyTotal.cacheCreationCost += bd.cacheCreationCost;
      dailyTotal.totalCost += bd.totalCost;
      const p = getCopilotPricing(model, dayMs) || COPILOT_FALLBACK;
      dailySavings += tokens.cacheRead * (p.input - p.cachedInput) / PER_MIL;
      if (p.estimate) dailyEstimated += bd.totalCost;
      dailyCoveredTokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
      dayInput += tokens.input;
      dayOutput += tokens.output;
      dayCacheRead += tokens.cacheRead;
      dayCacheCreate += tokens.cacheCreate;
      dayByModel[model] = { tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate, cost: bd.totalCost };
    }
    session.dailyUsage[dateStr] = {
      inputTokens: dayInput,
      outputTokens: dayOutput,
      cacheReadTokens: dayCacheRead,
      cacheCreationTokens: dayCacheCreate,
      cost: dayCost,
      byModel: dayByModel,
    };
  }

  const sessionTotalTokens = session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens + session.cacheCreationTokens;
  if (sessionTotalTokens > 0 && dailyCoveredTokens === sessionTotalTokens) {
    session.cost = dailyTotal;
    session.cacheSavingsDollars = dailySavings;
    session.estimatedCost = dailyEstimated;
    for (const [model, cost] of Object.entries(dailyModelCost)) {
      if (session.modelBreakdown[model]) session.modelBreakdown[model].cost = cost;
    }
  }

  // A session with no persisted usage record (crashed / force-killed, ~1 in 8)
  // has real work but UNKNOWN cost — mark it costZeroed so its commits still
  // correlate and show, but metrics.computeSessionGrade won't grade a $0 cost
  // as a fabricated 'A'. (Only when the session did real work: pure-empty
  // sessions are dropped in parseCopilotSessions.)
  if (!sawShutdownUsage && sessionTotalTokens === 0) session.costZeroed = true;

  if (session.startTime && session.endTime) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    session.durationMinutes = Math.round((end - start) / 60000 * 10) / 10;
  }

  // Normalize touched files to repo-root-relative paths for commit correlation
  // (identical tail to codex-parser): snapshot absolutes for the workspace
  // explosion pass, then collapse to repo-relative.
  let gitRoot = session.repoPath;
  if (gitRoot) gitRoot = findGitRoot(gitRoot) || gitRoot;
  const resolved = [...rawFiles].map(f =>
    path.isAbsolute(f) ? f : path.join(session.repoPath || '/', f)
  );
  session.filesWrittenAbsolute = [...new Set(resolved)];
  session.filesWritten = [...new Set(
    resolved.map(f => toRelativePath(f, gitRoot)).filter(Boolean)
  )];
  if (gitRoot) session.repoPath = gitRoot;

  return session;
}

export async function parseCopilotSessions(copilotDir, days, projectFilter) {
  if (!copilotDir || !existsSync(copilotDir)) {
    return { sessions: [], fileIndex: {} };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();

  const sessions = [];
  const fileIndex = {};

  for (const filePath of listCopilotSessionFiles(copilotDir)) {
    let mtime;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoffMs) continue;
    fileIndex[filePath] = mtime;

    try {
      const session = await parseCopilotEvents(filePath, cutoffMs);

      // Drop truly empty sessions (no conversation, no tools, no usage).
      if (!session.startTime) continue;
      const msgCount = session.userMessageCount + session.assistantMessageCount;
      const toolCount = Object.values(session.toolCalls).reduce((a, b) => a + b, 0);
      if (msgCount === 0 && toolCount === 0 &&
        session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens === 0) {
        continue;
      }

      // Keep sessions with any activity inside the window.
      if (new Date(session.endTime || session.startTime).getTime() < cutoffMs) continue;

      session.projectName = session.repoPath ? path.basename(session.repoPath) : 'copilot';
      if (projectFilter && !session.projectName.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue;
      }
      sessions.push(session);
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse ${filePath}: ${err.message}\n`);
    }
  }

  // Deduplicate by sessionId (defensive — a session id maps to one directory,
  // but keep the fuller transcript if a duplicate ever appears).
  const seen = new Map();
  for (const s of sessions) {
    const existing = seen.get(s.sessionId);
    if (!existing) {
      seen.set(s.sessionId, s);
      continue;
    }
    const existingMsgs = existing.userMessageCount + existing.assistantMessageCount;
    const newMsgs = s.userMessageCount + s.assistantMessageCount;
    if (newMsgs > existingMsgs) seen.set(s.sessionId, s);
  }
  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { sessions: deduped, fileIndex };
}
