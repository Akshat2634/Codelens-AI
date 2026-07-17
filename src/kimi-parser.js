import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { findGitRoot, isReadOnlyCommand, isVerificationCommand, toRelativePath } from './claude-parser.js';
import { lookupExternalRate } from './pricing.js';

// ── Kimi CLI (Moonshot AI) session parser ──
//
// Kimi CLI (`MoonshotAI/kimi-cli`, Python) keeps everything under one share
// directory ($KIMI_SHARE_DIR, default ~/.kimi):
//   kimi.json                                — work-dir registry: the ONLY
//                                              mapping from session folders
//                                              back to a cwd
//   config.toml                              — default_model + [models.*]
//   sessions/<md5-of-cwd>/<session-uuid>/    — one folder per session:
//     wire.jsonl                             — the event log this parser reads
//     context.jsonl                          — message history (no timestamps,
//                                              no usage; only read as a legacy
//                                              fallback when wire.jsonl is
//                                              missing)
//     context_N.jsonl                        — compaction/undo rotations (skip)
//     state.json                             — titles/todos ("Fork: " titles
//                                              mark forked sessions)
//     subagents/<agent-id>/                  — per-subagent copies (skip: the
//                                              parent wire.jsonl already
//                                              carries every subagent event)
//   sessions/<md5>/<session-uuid>.jsonl      — pre-0.59 layout: a bare context
//                                              file (messages only, no usage)
//
// wire.jsonl: line 1 may be {"type":"metadata","protocol_version":...}; every
// other line is {"timestamp": <epoch SECONDS float>, "message": {type, payload}}.
//   TurnBegin / SteerInput — real user prompts
//   StatusUpdate          — payload.token_usage carries ONE request's usage:
//                           { input_other, input_cache_read,
//                             input_cache_creation, output } (per-step values,
//                           not cumulative; null for MCP-only status updates)
//   ToolCall              — payload.function = { name, arguments: "<json>" };
//                           WriteFile/StrReplaceFile args carry `path`, Shell
//                           carries `command`. MCP tools keep their bare name.
//   SubagentEvent         — wraps a subagent's event (recursively); unwrap and
//                           count it here, NEVER also read subagents/*/wire.jsonl
//
// Double-count hazards handled below: forked sessions (/fork, /undo) COPY the
// original's wire records into a new session folder, so usage records are
// deduped across the whole parse run by StatusUpdate.message_id (falling back
// to timestamp+usage identity), with non-fork sessions parsed first so the
// original keeps its own spend.
//
// Token-field mapping onto the uniform session shape (Moonshot reports
// Anthropic-style cache splits; total input = other + cache_read + cache_creation):
//   totalInputTokens    = input_other (fresh, uncached input)
//   cacheReadTokens     = input_cache_read
//   cacheCreationTokens = input_cache_creation (billed at the INPUT rate —
//                         Moonshot publishes no cache-write premium)
//   totalOutputTokens   = output (reasoning tokens are not reported separately)
//
// The model id is NOT recorded in session files — only config.toml knows it
// (default_model, possibly a managed "<platform>/<model>" key). Sessions are
// attributed to the configured model, falling back to 'kimi-for-coding' (the
// subscription alias), whose $-equivalent is priced as the model it routed to
// on each usage date and flagged as estimated spend.

// Pricing per million tokens — https://platform.kimi.ai/docs/pricing/chat
// (international USD). cacheWrite is the price of input_cache_creation tokens:
// Moonshot publishes no write premium, so it equals the input (cache-miss)
// rate. moonshot-v1 predates cache-hit pricing entirely — cache reads bill at
// full input rate there. Ordered most-specific-first; a model id matches an
// entry when it equals the key or extends it with '-'.
const R = (input, cacheRead, output, extra = {}) => ({ input, cacheRead, cacheWrite: input, output, ...extra });

// Price-change dates. kimi-k2-turbo-preview launched 2025-08-01 at a 50%-off
// promo, ran at full price from 2025-09-01, and was cut to its final rate on
// 2025-11-06 (the K2 Thinking launch repricing). The kimi-for-coding
// subscription alias is priced as the model Moonshot routed it to over time:
// K2 Thinking at launch (Oct 2025) → K2.5 (2026-01-27) → K2.6 (~2026-04-20) →
// K2.7 Code (~2026-06-12).
const TURBO_FULL_MS = Date.UTC(2025, 8, 1); // 2025-09-01
const TURBO_CUT_MS = Date.UTC(2025, 10, 6); // 2025-11-06
const CODING_K25_MS = Date.UTC(2026, 0, 27); // 2026-01-27
const CODING_K26_MS = Date.UTC(2026, 3, 20); // 2026-04-20
const CODING_K27_MS = Date.UTC(2026, 5, 12); // 2026-06-12

// Most-recent-first [sinceMs, rates]; the final row is the launch tier.
const tiered = (rows) => (dateMs) => rows.find(([since]) => dateMs >= since)[1];

// The kimi-for-coding / kimi-code alias bills subscription credits, not
// per-token dollars — its $-equivalent uses the routed model's real rates but
// is flagged estimated, since the alias has no published price of its own.
const KIMI_FOR_CODING = tiered([
  [CODING_K27_MS, R(0.95, 0.19, 4, { estimate: true })], // → kimi-k2.7-code
  [CODING_K26_MS, R(0.95, 0.16, 4, { estimate: true })], // → kimi-k2.6
  [CODING_K25_MS, R(0.60, 0.10, 3, { estimate: true })], // → kimi-k2.5
  [0, R(0.60, 0.15, 2.5, { estimate: true })], // → kimi-k2-thinking
]);

const KIMI_PRICING = [
  ['kimi-k3', R(3, 0.30, 15)], // flat across the full 1M window
  ['kimi-k2.7-code', R(0.95, 0.19, 4)], // high-speed variant bills $8/M output via kimi-for-coding-highspeed
  ['kimi-k2.6', R(0.95, 0.16, 4)],
  ['kimi-k2.5', R(0.60, 0.10, 3)],
  ['kimi-k2-thinking-turbo', R(1.15, 0.15, 8)],
  ['kimi-k2-thinking', R(0.60, 0.15, 2.5)],
  ['kimi-k2-turbo-preview', tiered([
    [TURBO_CUT_MS, R(1.15, 0.15, 8)],
    [TURBO_FULL_MS, R(2.40, 0.60, 10)],
    [0, R(1.20, 0.30, 5)], // launch promo (50% off through Aug 2025)
  ])],
  ['kimi-k2-0905-preview', R(0.60, 0.15, 2.5)],
  ['kimi-k2-0711-preview', R(0.60, 0.15, 2.5)],
  ['kimi-thinking-preview', R(0.60, 0.15, 2.5)],
  ['kimi-latest-128k', R(2, 0.15, 5)],
  ['kimi-latest-32k', R(1, 0.15, 3)],
  ['kimi-latest-8k', R(0.20, 0.15, 2)],
  // Auto-tier ids are re-bucketed per request onto the tier ids above
  // (autoTierBillingModel); a direct lookup prices at the 128k ceiling.
  ['kimi-latest', R(2, 0.15, 5)],
  ['kimi-for-coding-highspeed', tiered([
    [CODING_K27_MS, R(0.95, 0.19, 8, { estimate: true })], // → kimi-k2.7-code high-speed
    [0, R(1.15, 0.15, 8, { estimate: true })], // → kimi-k2-thinking-turbo
  ])],
  ['kimi-for-coding', KIMI_FOR_CODING],
  ['kimi-code', KIMI_FOR_CODING], // legacy alias for kimi-for-coding
  ['moonshot-v1-128k', R(2, 2, 5)],
  ['moonshot-v1-32k', R(1, 1, 3)],
  ['moonshot-v1-8k', R(0.20, 0.20, 2)],
  ['moonshot-v1-auto', R(2, 2, 5)],
];

// Unknown/future Moonshot models are priced at the current default coding
// model's rates and flagged as estimated spend (a silent $0 would understate
// spend with no warning), unless the LiteLLM overlay knows the real rate.
const KIMI_FALLBACK = R(0.95, 0.19, 4, { estimate: true });

const PER_MIL = 1_000_000;

// kimi-latest / moonshot-v1-auto bill the context tier each REQUEST fits in —
// re-bucket onto the concrete tier id so the model breakdown shows real rates.
function autoTierBillingModel(modelName, requestInputTokens) {
  const id = normalizeKimiModelId(modelName);
  if (id !== 'kimi-latest' && id !== 'moonshot-v1-auto') return modelName;
  const prefix = id === 'kimi-latest' ? 'kimi-latest' : 'moonshot-v1';
  const tier = requestInputTokens <= 8192 ? '8k' : requestInputTokens <= 32768 ? '32k' : '128k';
  return `${prefix}-${tier}`;
}

function normalizeKimiModelId(modelName) {
  return String(modelName || '').toLowerCase().trim();
}

export function getKimiModelFamily(modelName) {
  if (!modelName) return null;
  const id = normalizeKimiModelId(modelName);
  if (id.startsWith('kimi')) return 'kimi';
  if (id.startsWith('moonshot')) return 'moonshot';
  return null;
}

export function getKimiPricing(modelName, usageDateMs = Date.now()) {
  if (!getKimiModelFamily(modelName)) return null;
  const id = normalizeKimiModelId(modelName);
  for (const [key, price] of KIMI_PRICING) {
    if (id === key || id.startsWith(`${key}-`)) {
      return typeof price === 'function' ? price(usageDateMs) : price;
    }
  }
  // Not in the hardcoded table — the external LiteLLM overlay may know the
  // real published rate (keys like moonshot/kimi-k4). No cache-write premium
  // exists on this platform, so creation tokens bill at the overlay's input
  // rate, not its Anthropic-style 1.25x default.
  const ext = lookupExternalRate(modelName);
  if (ext) return { input: ext.input, cacheRead: ext.cacheRead, cacheWrite: ext.input, output: ext.output };
  return KIMI_FALLBACK;
}

function calculateKimiCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs = Date.now()) {
  const p = getKimiPricing(modelName, usageDateMs) || KIMI_FALLBACK;
  const inputCost = inputTokens * p.input / PER_MIL;
  const outputCost = outputTokens * p.output / PER_MIL;
  const cacheReadCost = cacheReadTokens * p.cacheRead / PER_MIL;
  const cacheCreationCost = cacheCreationTokens * p.cacheWrite / PER_MIL;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    serverToolCost: 0,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost,
  };
}

export function calculateKimiCost(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs = Date.now()) {
  return calculateKimiCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, usageDateMs).totalCost;
}

// One parse-source file per session: wire.jsonl for modern sessions, the
// session dir's context.jsonl when wire.jsonl is missing (migrated but never
// resumed), or the pre-0.59 bare <session-id>.jsonl. Rotated context_N.jsonl
// files and subagents/ subtrees are never listed — parsing them would
// double-count compacted history and subagent usage.
export function listKimiSessionFiles(kimiDir, out = []) {
  if (!kimiDir) return out;
  const sessionsRoot = path.join(kimiDir, 'sessions');
  let hashDirs;
  try {
    hashDirs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const hd of hashDirs) {
    if (!hd.isDirectory() || hd.name.startsWith('.')) continue;
    const hashDir = path.join(sessionsRoot, hd.name);
    let entries;
    try {
      entries = readdirSync(hashDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(path.join(hashDir, entry.name)); // legacy bare context file
      } else if (entry.isDirectory()) {
        const wire = path.join(hashDir, entry.name, 'wire.jsonl');
        if (existsSync(wire)) {
          out.push(wire);
        } else {
          const ctx = path.join(hashDir, entry.name, 'context.jsonl');
          if (existsSync(ctx)) out.push(ctx);
        }
      }
    }
  }
  return out;
}

// md5(cwd) -> cwd from kimi.json — the only mapping back from a sessions
// subfolder to the work directory. Remote (kaos) work dirs are prefixed
// "<kaos>_<md5>"; their paths live on another machine, so they yield no
// local repoPath (usage still counts, commits can't correlate).
function loadWorkDirMap(kimiDir) {
  const map = new Map();
  try {
    const meta = JSON.parse(readFileSync(path.join(kimiDir, 'kimi.json'), 'utf-8'));
    for (const wd of meta.work_dirs || []) {
      if (!wd?.path) continue;
      const hash = createHash('md5').update(wd.path, 'utf-8').digest('hex');
      const remote = Boolean(wd.kaos && wd.kaos !== 'local');
      map.set(remote ? `${wd.kaos}_${hash}` : hash, { path: wd.path, remote });
    }
  } catch {
    // Missing/corrupt kimi.json — sessions parse with no cwd.
  }
  return map;
}

// Session files record no model id. config.toml's default_model — possibly a
// managed "<platform>/<model>" key resolved through [models.<key>] — is the
// best available attribution. Targeted line scan; a TOML dependency isn't
// warranted for two keys.
export function resolveConfiguredKimiModel(kimiDir) {
  try {
    const raw = readFileSync(path.join(kimiDir, 'config.toml'), 'utf-8');
    const def = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m)?.[1];
    if (!def) return null;
    let inSection = false;
    for (const line of raw.split('\n')) {
      const section = line.match(/^\s*\[(.+)\]\s*$/);
      if (section) {
        const name = section[1].trim();
        // Managed keys are quoted table names: [models."kimi-code/kimi-for-coding"]
        inSection = name.startsWith('models.')
          && name.slice('models.'.length).trim().replace(/^"(.*)"$/, '$1') === def;
        continue;
      }
      if (inSection) {
        const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
        if (m) return m[1];
      }
    }
    // No [models] entry — a managed key's tail is the model id itself.
    return def.includes('/') ? def.split('/').pop() : def;
  } catch {
    return null;
  }
}

function localDayStr(dateLike) {
  const dt = new Date(dateLike);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function createEmptyKimiSession(sessionId) {
  return {
    sessionId,
    source: 'kimi',
    repoPath: null,
    projectName: null,
    gitBranch: null, // Kimi CLI records no git metadata in session files
    entrypoint: 'kimi-cli',
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
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
  };
}

function trackShellCommand(session, command) {
  if (!command || typeof command !== 'string') return;
  session.totalBashCalls++;
  if (isVerificationCommand(command)) {
    session.verificationBashCalls++;
    session.bashCommands.push({ command: command.slice(0, 200), isVerification: true });
  }
  if (isReadOnlyCommand(command)) session.readOnlyBashCalls++;
}

// cutoffMs clips usage accumulation to the lookback window (a session resumed
// inside the window keeps only its in-window tokens/cost); message and tool
// counts stay whole-session. seenUsage is SHARED across the whole parse run:
// forked sessions carry copies of the original's usage records, and the copy
// must not bill twice.
async function parseKimiWireFile(filePath, session, model, cutoffMs, seenUsage) {
  const modelTokens = {}; // billing model -> { input, output, cacheRead, cacheCreate }
  const dailyModelTokens = {}; // dateStr -> billing model -> { ... }
  const rawFiles = new Set();
  const subagentIds = new Set();
  let usageRequests = 0;

  let startMs = null;
  let endMs = null;
  const touch = (ms) => {
    if (!Number.isFinite(ms)) return;
    if (startMs === null || ms < startMs) startMs = ms;
    if (endMs === null || ms > endMs) endMs = ms;
  };

  const trackToolCall = (payload) => {
    const name = payload?.function?.name;
    if (!name) return;
    session.toolCalls[name] = (session.toolCalls[name] || 0) + 1;
    let args = null;
    try {
      args = typeof payload.function.arguments === 'string'
        ? JSON.parse(payload.function.arguments)
        : payload.function.arguments;
    } catch { }
    if (!args || typeof args !== 'object') return;
    if (name === 'Shell') {
      trackShellCommand(session, args.command);
    } else if ((name === 'WriteFile' || name === 'StrReplaceFile') && typeof args.path === 'string' && args.path) {
      rawFiles.add(args.path);
    }
  };

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (obj.type === 'metadata') continue; // wire protocol header

    // Records carry epoch SECONDS; a record without a usable timestamp can't
    // be window-clipped or day-bucketed, so it's skipped entirely.
    const ms = Number(obj.timestamp) * 1000;
    if (!Number.isFinite(ms) || !obj.message) continue;

    // Unwrap subagent events (recursively — a subagent can spawn subagents).
    // The parent wire.jsonl carries every subagent record, which is exactly
    // why subagents/*/wire.jsonl files are never read.
    let msg = obj.message;
    for (let depth = 0; msg?.type === 'SubagentEvent' && msg.payload && depth < 16; depth++) {
      const id = msg.payload.agent_id || msg.payload.parent_tool_call_id || msg.payload.task_tool_call_id;
      if (id) subagentIds.add(id);
      msg = msg.payload.event;
    }
    if (!msg?.type) continue;
    const payload = msg.payload || {};
    touch(ms);

    if (msg.type === 'TurnBegin' || msg.type === 'SteerInput') {
      session.userMessageCount++;
    } else if (msg.type === 'ToolCall') {
      trackToolCall(payload);
    } else if (msg.type === 'StatusUpdate') {
      const tu = payload.token_usage;
      if (!tu || typeof tu !== 'object') continue; // MCP-only status updates
      const freshInput = tu.input_other || 0;
      const cacheRead = tu.input_cache_read || 0;
      const cacheCreate = tu.input_cache_creation || 0;
      const output = tu.output || 0;
      if (freshInput === 0 && cacheRead === 0 && cacheCreate === 0 && output === 0) continue;

      // Fork dedup: /fork and /undo copy wire records (timestamps included)
      // into a new session. message_id is the provider's per-request id —
      // globally unique — so it's the primary key; older records without one
      // fall back to timestamp+usage identity.
      const dupKey = payload.message_id
        ? `id:${payload.message_id}`
        : `ts:${obj.timestamp}|${freshInput}|${cacheRead}|${cacheCreate}|${output}`;
      if (seenUsage.has(dupKey)) continue;
      seenUsage.add(dupKey);

      usageRequests++; // one model request = one assistant action
      if (cutoffMs && ms < cutoffMs) continue; // window clipping

      const billingModel = autoTierBillingModel(model, freshInput + cacheRead + cacheCreate);
      session.totalInputTokens += freshInput;
      session.totalOutputTokens += output;
      session.cacheReadTokens += cacheRead;
      session.cacheCreationTokens += cacheCreate;

      if (!modelTokens[billingModel]) modelTokens[billingModel] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      modelTokens[billingModel].input += freshInput;
      modelTokens[billingModel].output += output;
      modelTokens[billingModel].cacheRead += cacheRead;
      modelTokens[billingModel].cacheCreate += cacheCreate;

      const dateStr = localDayStr(ms);
      if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
      if (!dailyModelTokens[dateStr][billingModel]) dailyModelTokens[dateStr][billingModel] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      dailyModelTokens[dateStr][billingModel].input += freshInput;
      dailyModelTokens[dateStr][billingModel].output += output;
      dailyModelTokens[dateStr][billingModel].cacheRead += cacheRead;
      dailyModelTokens[dateStr][billingModel].cacheCreate += cacheCreate;

      // Per-event record for 5-hour billing blocks / burn rate, priced at the
      // event's own date so date-tiered rates stay accurate.
      session.usageEvents.push({
        ts: ms,
        input: freshInput, output, cacheRead, cacheCreate,
        cost: calculateKimiCost(freshInput, output, cacheRead, cacheCreate, billingModel, ms),
      });
    }
    // TurnEnd / StepBegin / ContentPart / ToolResult / approval flow /
    // compaction markers: time-tracked above, nothing to extract.
  }

  session.assistantMessageCount = usageRequests;
  // Distinct subagent instances seen in the wire; older wires (< protocol 1.6)
  // may carry no ids at all — fall back to Agent tool invocations.
  session.subagentTranscriptCount = subagentIds.size > 0 ? subagentIds.size : (session.toolCalls.Agent || 0);
  if (startMs !== null) session.startTime = new Date(startMs).toISOString();
  if (endMs !== null) session.endTime = new Date(endMs).toISOString();
  return { modelTokens, dailyModelTokens, rawFiles };
}

// Legacy fallback (pre-0.59 bare <id>.jsonl, or a migrated dir without
// wire.jsonl): context.jsonl messages only — no timestamps, no usage. The
// file mtime stands in for the session's time so its written files can still
// correlate through the 2-hour buffer.
async function parseKimiContextFile(filePath, session) {
  const rawFiles = new Set();
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const role = obj.role;
    if (typeof role !== 'string' || role.startsWith('_')) continue; // _system_prompt/_checkpoint/_usage markers
    if (role === 'user') {
      // Synthetic checkpoint markers are injected as user messages.
      const content = obj.content;
      if (typeof content === 'string' && /^<system>.*<\/system>$/s.test(content.trim())) continue;
      session.userMessageCount++;
    } else if (role === 'assistant') {
      session.assistantMessageCount++;
      for (const call of obj.tool_calls || []) {
        const name = call?.function?.name;
        if (!name) continue;
        session.toolCalls[name] = (session.toolCalls[name] || 0) + 1;
        let args = null;
        try {
          args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
        } catch { }
        if (!args || typeof args !== 'object') continue;
        if (name === 'Shell') trackShellCommand(session, args.command);
        else if ((name === 'WriteFile' || name === 'StrReplaceFile') && typeof args.path === 'string' && args.path) {
          rawFiles.add(args.path);
        }
      }
    }
  }
  const mtimeIso = new Date(statSync(filePath).mtimeMs).toISOString();
  session.startTime = mtimeIso;
  session.endTime = mtimeIso;
  return { modelTokens: {}, dailyModelTokens: {}, rawFiles };
}

// Compute per-day-priced costs (mirrors claude/codex parsers) so a session
// straddling a price change — e.g. the kimi-k2-turbo cut — is costed
// correctly on each side and session.cost reconciles with the daily timeline.
function finalizeKimiSession(session, modelTokens, dailyModelTokens, rawFiles, cutoffMs) {
  const rawStartMs = session.startTime ? Date.parse(session.startTime) : Date.now();
  const sessionDateMs = cutoffMs ? Math.max(rawStartMs, cutoffMs) : rawStartMs;

  let maxTokens = 0;
  let primaryModel = null;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    const bd = calculateKimiCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, sessionDateMs);
    const p = getKimiPricing(model, sessionDateMs) || KIMI_FALLBACK;
    session.cacheSavingsDollars += tokens.cacheRead * (p.input - p.cacheRead) / PER_MIL;
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
    const dayMs = Date.parse(`${dateStr}T12:00:00Z`);
    for (const [model, tokens] of Object.entries(models)) {
      const bd = calculateKimiCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, dayMs);
      dayCost += bd.totalCost;
      dailyModelCost[model] = (dailyModelCost[model] || 0) + bd.totalCost;
      dailyTotal.inputCost += bd.inputCost;
      dailyTotal.outputCost += bd.outputCost;
      dailyTotal.cacheReadCost += bd.cacheReadCost;
      dailyTotal.cacheCreationCost += bd.cacheCreationCost;
      dailyTotal.totalCost += bd.totalCost;
      const p = getKimiPricing(model, dayMs) || KIMI_FALLBACK;
      dailySavings += tokens.cacheRead * (p.input - p.cacheRead) / PER_MIL;
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

  if (session.startTime && session.endTime) {
    session.durationMinutes = Math.round((Date.parse(session.endTime) - Date.parse(session.startTime)) / 60000 * 10) / 10;
  }

  // Normalize touched files to repo-root-relative paths for commit
  // correlation. WriteFile/StrReplaceFile paths may be relative to the
  // session's work dir — resolve those first.
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
}

// "Fork: "-titled sessions are copies of another session's history (see the
// dedup note above); parse originals first so they keep their own spend.
function isForkSession(sessionDir) {
  try {
    const state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    return typeof state.custom_title === 'string' && state.custom_title.startsWith('Fork: ');
  } catch {
    return false;
  }
}

export async function parseKimiSessions(kimiDir, days, projectFilter) {
  if (!kimiDir || !existsSync(path.join(kimiDir, 'sessions'))) {
    return { sessions: [], fileIndex: {} };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();

  const workDirs = loadWorkDirMap(kimiDir);
  const configuredModel = resolveConfiguredKimiModel(kimiDir) || 'kimi-for-coding';

  // Collect in-window parse jobs first so fork-copied sessions can be ordered
  // after the originals (the shared dedup set assigns copied usage to
  // whichever session parses first).
  const jobs = [];
  const fileIndex = {};
  for (const filePath of listKimiSessionFiles(kimiDir)) {
    let mtime;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoffMs) continue;
    fileIndex[filePath] = mtime;

    const isWire = path.basename(filePath) === 'wire.jsonl';
    const isDirSession = isWire || path.basename(filePath) === 'context.jsonl';
    const sessionDir = isDirSession ? path.dirname(filePath) : null;
    const sessionId = isDirSession ? path.basename(sessionDir) : path.basename(filePath, '.jsonl');
    const hashName = path.basename(isDirSession ? path.dirname(sessionDir) : path.dirname(filePath));
    jobs.push({
      filePath,
      isWire,
      sessionId,
      workDir: workDirs.get(hashName) || null,
      fork: sessionDir ? isForkSession(sessionDir) : false,
    });
  }
  jobs.sort((a, b) => (a.fork - b.fork) || a.filePath.localeCompare(b.filePath));

  const sessions = [];
  const seenUsage = new Set();
  for (const job of jobs) {
    try {
      const session = createEmptyKimiSession(job.sessionId);
      if (job.workDir && !job.workDir.remote) session.repoPath = job.workDir.path;

      const parsed = job.isWire
        ? await parseKimiWireFile(job.filePath, session, configuredModel, cutoffMs, seenUsage)
        : await parseKimiContextFile(job.filePath, session);

      // Skip empty sessions (no conversation and no usage)
      if (!session.startTime) continue;
      const msgCount = session.userMessageCount + session.assistantMessageCount;
      const tokenTotal = session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens + session.cacheCreationTokens;
      if (msgCount === 0 && tokenTotal === 0) continue;

      // Keep sessions with ANY activity inside the window (usage was clipped
      // to the window during parsing, same rule as the other parsers)
      if (Date.parse(session.endTime || session.startTime) < cutoffMs) continue;

      finalizeKimiSession(session, parsed.modelTokens, parsed.dailyModelTokens, parsed.rawFiles, cutoffMs);

      session.projectName = session.repoPath
        ? path.basename(session.repoPath)
        : (job.workDir ? path.basename(job.workDir.path) : 'kimi');
      if (projectFilter && !session.projectName.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue;
      }
      sessions.push(session);
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse ${job.filePath}: ${err.message}\n`);
    }
  }

  sessions.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  return { sessions, fileIndex };
}
