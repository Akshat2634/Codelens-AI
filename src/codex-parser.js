import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';
import { findGitRoot, isVerificationCommand, toRelativePath } from './claude-parser.js';

// ── OpenAI Codex CLI session parser ──
//
// Codex CLI (the Rust `openai/codex` agent) writes one rollout file per session:
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// ($CODEX_HOME defaults to ~/.codex; early 2025 builds wrote flat into
// sessions/, and since 2026 a background worker zstd-compresses rollouts older
// than ~7 days to .jsonl.zst — all three layouts are handled here.)
//
// Every line is an envelope { timestamp, type, payload }:
//   session_meta   — session id, cwd, originator, cli_version, git branch
//   turn_context   — per-turn config; carries the MODEL NAME (can change mid-session)
//   event_msg      — token_count (usage), user_message, agent_message,
//                    patch_apply_end (files changed), task lifecycle, ...
//   response_item  — the model-visible conversation: messages, function_call
//                    (shell/exec_command), custom_tool_call (apply_patch), ...
//
// token_count events carry payload.info.total_token_usage (CUMULATIVE for the
// session) and payload.info.last_token_usage (just the most recent request).
// cached_input_tokens is a subset of input_tokens; reasoning_output_tokens is
// a subset of output_tokens (billed at the output rate — never add it again).
//
// The parser produces session objects in the exact shape claude-parser.js
// produces (plus source: 'codex'), so the correlator/metrics/server pipeline
// treats both agents identically. Token-field mapping onto the Claude shape:
//   totalInputTokens    = input_tokens - cached_input_tokens  (fresh input)
//   cacheReadTokens     = cached_input_tokens
//   cacheCreationTokens = 0  (OpenAI's automatic caching has no write premium)
//   totalOutputTokens   = output_tokens (reasoning included)

// Pricing per million tokens — https://developers.openai.com/api/docs/pricing
// Ordered most-specific-first; a model id matches an entry when it equals the
// key or extends it with '-' (so 'gpt-5.5' never matches the 'gpt-5' entry,
// but 'gpt-5.1-codex-max' matches 'gpt-5.1-codex-max' before 'gpt-5.1-codex').
// Every OpenAI price change so far shipped as a NEW model id, so a flat map
// covers 2025–2026 history — except o3's 80% price cut on 2025-06-10, which is
// date-tiered below. GPT-5.5 / GPT-5.4 publish separate long-context rates,
// carried as `longContext` on the same entry. `estimate: true` marks rates that
// are informed proxies (no published API price); their cost is surfaced as
// estimated spend.
const CODEX_PRICING = [
  // Codex-branded models
  ['gpt-5.3-codex-spark', { input: 1.75, cachedInput: 0.175, output: 14, estimate: true }], // research preview, no API price — proxied at gpt-5.3-codex rates
  ['gpt-5.3-codex',       { input: 1.75, cachedInput: 0.175, output: 14 }],
  ['gpt-5.2-codex',       { input: 1.75, cachedInput: 0.175, output: 14 }],
  ['gpt-5.1-codex-mini',  { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5.1-codex-max',   { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5.1-codex',       { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5-codex-mini',    { input: 0.25, cachedInput: 0.025, output: 2, estimate: true }], // ChatGPT-only; proxied at gpt-5.1-codex-mini rates
  ['gpt-5-codex',         { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['codex-mini',          { input: 1.50, cachedInput: 0.375, output: 6 }], // codex-mini-latest; cached discount is 75%, not 90%
  // Mainline GPT models selectable in Codex
  // Pro variants do not publish a cached-input discount; if a rollout ever
  // reports cached tokens for them, bill those tokens at full input rate.
  ['gpt-5.5-pro',         { input: 30,   cachedInput: 30,    output: 180, longContext: { input: 60, cachedInput: 60, output: 270 } }],
  ['gpt-5.5',             { input: 5,    cachedInput: 0.50,  output: 30,  longContext: { input: 10, cachedInput: 1, output: 45 } }],
  ['gpt-5.4-pro',         { input: 30,   cachedInput: 30,    output: 180, longContext: { input: 60, cachedInput: 60, output: 270 } }],
  ['gpt-5.4-mini',        { input: 0.75, cachedInput: 0.075, output: 4.5 }],
  ['gpt-5.4-nano',        { input: 0.20, cachedInput: 0.02,  output: 1.25 }],
  ['gpt-5.4',             { input: 2.50, cachedInput: 0.25,  output: 15,  longContext: { input: 5, cachedInput: 0.50, output: 22.5 } }],
  ['gpt-5.2',             { input: 1.75, cachedInput: 0.175, output: 14 }],
  ['gpt-5.1',             { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-5-nano',          { input: 0.05, cachedInput: 0.005, output: 0.40 }],
  ['gpt-5-mini',          { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5-pro',           { input: 15,   cachedInput: 15,    output: 120 }],
  ['gpt-5',               { input: 1.25, cachedInput: 0.125, output: 10 }],
  ['gpt-4.1-mini',        { input: 0.40, cachedInput: 0.10,  output: 1.60 }],
  ['gpt-4.1-nano',        { input: 0.10, cachedInput: 0.025, output: 0.40 }],
  ['gpt-4.1',             { input: 2,    cachedInput: 0.50,  output: 8 }],
  // Local open-weight models (codex --oss) run on the user's machine — free
  ['gpt-oss',             { input: 0,    cachedInput: 0,     output: 0 }],
  // Early Codex CLI models (2025 logs) + o-series siblings that would
  // otherwise be swallowed by a shorter prefix at the wrong rate
  ['o4-mini',             { input: 1.10, cachedInput: 0.275, output: 4.40 }],
  ['o3-pro',              { input: 20,   cachedInput: 5,     output: 80 }],
  ['o3-mini',             { input: 1.10, cachedInput: 0.55,  output: 4.40 }],
  ['o3',                  { input: 2,    cachedInput: 0.50,  output: 8 }], // post-2025-06-10 (80% cut); earlier dates tiered below
  ['o1-pro',              { input: 150,  cachedInput: 37.50, output: 600 }],
  ['o1-mini',             { input: 1.10, cachedInput: 0.55,  output: 4.40 }],
  ['o1',                  { input: 15,   cachedInput: 7.50,  output: 60 }],
];

// o3 launched 2025-04-16 at $10/$2.50/$40 and was cut 80% on 2025-06-10.
const O3_PRICE_CUT_MS = Date.UTC(2025, 5, 10); // 2025-06-10T00:00:00Z
const O3_EARLY = { input: 10, cachedInput: 2.50, output: 40 };

// Unknown/future models (e.g. a new gpt-5.6) are priced at the current Codex
// default's rates and flagged as estimated spend, mirroring claude-parser's
// Sonnet fallback — a silent $0 would understate spend with no warning.
const CODEX_FALLBACK = { input: 5, cachedInput: 0.50, output: 30, estimate: true };

const PER_MIL = 1_000_000;
// OpenAI web search is $10 per 1,000 calls; search content tokens are already
// included in normal token_count events when they are billed.
const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;
// GPT-5.5/GPT-5.4 charge long-context rates once a SINGLE request's input
// exceeds this many tokens (OpenAI bills per request, not per session). All
// current long-context tiers share the 200K boundary.
const LONG_CONTEXT_INPUT_TOKENS = 200_000;
// Sentinel day-bucket for usage with no resolvable timestamp; resolved to the
// session's earliest real day after parsing (mirrors claude-parser).
const UNBUCKETED_DAY = '__unbucketed__';

function normalizeCodexModelId(modelName) {
  // Strip our '[long]' billing marker, API date suffixes
  // ('gpt-5.2-2025-12-11' → 'gpt-5.2'), and '-latest'. ('[fast]'/'[us]' are
  // Claude-only markers and never appear on a Codex id, so they aren't stripped
  // here — getCodexPricing is only ever fed Codex ids plus our '[long]'.)
  return modelName.toLowerCase()
    .replace(/\[long\]/g, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-latest$/, '');
}

// Long context is a property of the actual request size, NOT the model's static
// context-window capacity (which token_count reports identically on every event
// as `model_context_window`). Keying on capacity billed every request on a
// large-window model at long-context rates; only per-request input counts.
function useLongContextPricing(modelName, price, requestInputTokens = 0) {
  if (!price?.longContext) return false;
  return String(modelName || '').toLowerCase().includes('[long]')
    || requestInputTokens >= LONG_CONTEXT_INPUT_TOKENS;
}

function billingModelName(modelName, requestInputTokens = 0) {
  const p = getCodexPricing(modelName);
  return useLongContextPricing(modelName, p, requestInputTokens)
    ? `${modelName}[long]`
    : modelName;
}

export function getCodexModelFamily(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  if (!/^(gpt-|o\d|codex)/.test(lower)) return null;
  if (lower.includes('codex')) return 'codex';
  if (/^o\d/.test(lower)) return 'o-series';
  return 'gpt';
}

export function getCodexPricing(modelName, usageDateMs = Date.now()) {
  if (!modelName) return null;
  const id = normalizeCodexModelId(modelName);
  if (!/^(gpt-|o\d|codex)/.test(id)) return null;
  for (const [key, price] of CODEX_PRICING) {
    // '-' is the version separator; ':' is Ollama's tag separator, so
    // codex --oss ids like 'gpt-oss:20b' resolve to the free 'gpt-oss' entry
    // instead of the paid fallback.
    if (id === key || id.startsWith(key + '-') || id.startsWith(key + ':')) {
      if (key === 'o3' && usageDateMs < O3_PRICE_CUT_MS) return O3_EARLY;
      return useLongContextPricing(modelName, price) ? price.longContext : price;
    }
  }
  return CODEX_FALLBACK;
}

// Cost breakdown in the same shape claude-parser produces. `input` here is
// FRESH input (cached already subtracted during accumulation). Buckets whose
// model never resolved (no turn_context seen — 'unknown') are priced at the
// fallback and flagged as estimated, like claude-parser's Sonnet fallback.
function calculateCodexCostBreakdown(inputTokens, outputTokens, cacheReadTokens, modelName, usageDateMs = Date.now(), webSearchRequests = 0) {
  const p = getCodexPricing(modelName, usageDateMs) || CODEX_FALLBACK;
  const inputCost = inputTokens * p.input / PER_MIL;
  const outputCost = outputTokens * p.output / PER_MIL;
  const cacheReadCost = cacheReadTokens * p.cachedInput / PER_MIL;
  const serverToolCost = webSearchRequests * WEB_SEARCH_COST_PER_REQUEST;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost: 0,
    serverToolCost,
    totalCost: inputCost + outputCost + cacheReadCost + serverToolCost,
  };
}

export function calculateCodexCost(inputTokens, outputTokens, cacheReadTokens, modelName, usageDateMs = Date.now(), webSearchRequests = 0) {
  return calculateCodexCostBreakdown(inputTokens, outputTokens, cacheReadTokens, modelName, usageDateMs, webSearchRequests).totalCost;
}

// Recursively list rollout files under the sessions dir. Handles the dated
// tree (YYYY/MM/DD/), the early flat layout, and zstd-compressed rollouts.
export function listCodexSessionFiles(codexDir, out = []) {
  if (!codexDir) return out;
  let entries;
  try {
    entries = readdirSync(codexDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(codexDir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) listCodexSessionFiles(full, out);
    } else if (entry.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// zstd support landed in node:zlib in Node 22.15/23.8 — on older runtimes
// compressed rollouts (sessions older than ~7 days) are skipped with a warning.
const canZstd = typeof zlib.zstdDecompressSync === 'function';
let warnedZstd = false;

async function* rolloutLines(filePath) {
  if (filePath.endsWith('.zst')) {
    const text = zlib.zstdDecompressSync(readFileSync(filePath)).toString('utf-8');
    yield* text.split('\n');
    return;
  }
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  yield* rl;
}

function localDayStr(dateLike) {
  const dt = new Date(dateLike);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function createEmptyCodexSession(sessionId) {
  return {
    sessionId,
    source: 'codex',
    repoPath: null,
    projectName: null,
    gitBranch: null,
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
    cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 },
    model: null,
    modelBreakdown: {},
    toolCalls: {},
    filesWritten: [],
    filesRead: [],
    userMessageCount: 0,
    assistantMessageCount: 0,
    bashCommands: [],
    totalBashCalls: 0,
    verificationBashCalls: 0,
    estimatedCost: 0,
    cacheSavingsDollars: 0,
    codexPlanType: null,
  };
}

// Extract file paths from an apply_patch body:
//   *** Add File: src/x.js / *** Update File: src/y.js / *** Delete File: ...
//   (+ optional "*** Move to: new/path" after an Update header)
function extractPatchPaths(patchText, out) {
  if (typeof patchText !== 'string') return;
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  let m;
  while ((m = re.exec(patchText)) !== null) {
    const p = (m[1] || m[2] || '').trim();
    if (p) out.add(p);
  }
}

// Shell command string from the various call shapes. `shell`-era arguments
// carry {"command": ["bash","-lc","<cmd>"]}; `exec_command` carries {"cmd": "..."}.
function commandFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  if (typeof args.cmd === 'string') return args.cmd;
  const cmd = args.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    // ["bash", "-lc", "<the actual command>"] → unwrap; otherwise join argv
    if (cmd.length === 3 && /^(ba|z|da|fi)?sh$/.test(path.basename(String(cmd[0]))) && String(cmd[1]).startsWith('-')) {
      return String(cmd[2]);
    }
    return cmd.map(String).join(' ');
  }
  return null;
}

function trackShellCommand(session, command) {
  if (!command) return;
  const isVerif = isVerificationCommand(command);
  session.totalBashCalls++;
  if (isVerif) session.verificationBashCalls++;
  session.bashCommands.push({ command: command.slice(0, 200), isVerification: isVerif });
}

// cutoffMs clips usage accumulation to the lookback window, mirroring
// claude-parser: a session resumed inside the window keeps only its in-window
// tokens/cost, while message and tool counts stay whole-session.
async function parseCodexRollout(filePath, cutoffMs = 0) {
  // rollout-2026-07-02T09-15-03-<uuid>.jsonl → default id from the filename
  const base = path.basename(filePath).replace(/\.jsonl(\.zst)?$/, '');
  const defaultId = base.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '') || base;
  const session = createEmptyCodexSession(defaultId);

  const modelTokens = {}; // model -> { input, output, cacheRead, webSearch }
  const dailyModelTokens = {}; // dateStr -> model -> { input, output, cacheRead, webSearch }
  const rawFiles = new Set(); // paths as logged (absolute or cwd-relative)
  let currentModel = null;
  let prevTotal = null; // last seen total_token_usage, for delta fallback
  let eventUserMessages = 0;
  let itemUserMessages = 0;
  let agentMessages = 0;
  let itemAssistantMessages = 0;
  let tokenCountResponses = 0;
  const seenUsage = new Set(); // exact-duplicate token events (replays) are skipped
  const seenWebSearch = new Set(); // web_search_call ids already billed (replays)
  // Subagent rollouts (thread_spawn) REPLAY the parent's entire history,
  // re-timestamped into the spawn second — counting those events inflates
  // usage massively (ccusage saw 91x). Skip token events until the timestamp
  // moves past the replay burst's first second.
  let spawnReplay = false;
  let replaySecond = null;

  // Compare timestamps numerically — one rollout can mix precisions (legacy
  // meta lines lack milliseconds), where lexicographic order is wrong.
  const touchTimestamp = (ts) => {
    if (!ts) return;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return;
    if (!session.startTime || ms < Date.parse(session.startTime)) session.startTime = ts;
    if (!session.endTime || ms > Date.parse(session.endTime)) session.endTime = ts;
  };

  // Replay-burst gate for spawned subagent threads: everything re-stamped
  // into the spawn second (the session_meta second) is parent history. The
  // first line stamped in a later second ends the burst. Trade-off (shared
  // with ccusage's fix for the same bug): a subagent whose real activity
  // falls entirely inside the spawn second is skipped too.
  const inReplayBurst = (ts) => {
    if (!spawnReplay) return false;
    const second = ts ? ts.slice(0, 19) : null;
    if (replaySecond === null) replaySecond = second;
    // A missing/unparseable timestamp can't prove the burst is over — stay in
    // the burst rather than risk counting the rest of the replayed parent
    // history (the multi-x inflation this gate exists to prevent).
    if (second === null || second === replaySecond) return true;
    spawnReplay = false;
    return false;
  };

  // The cached-tokens field name drifted across Codex versions.
  const cachedOf = (u) => u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens ?? 0;

  const accumulateUsage = (delta, ts, model) => {
    const cached = cachedOf(delta);
    const rawInput = delta.input_tokens || 0;
    const billingModel = billingModelName(model, rawInput);
    const freshInput = Math.max(0, rawInput - cached);
    const output = delta.output_tokens || 0;
    const reasoning = delta.reasoning_output_tokens || 0;
    if (freshInput === 0 && cached === 0 && output === 0) return;

    // Window clipping: usage before the lookback cutoff is not accumulated.
    if (cutoffMs && ts && Date.parse(ts) < cutoffMs) return;
    session.totalInputTokens += freshInput;
    session.totalOutputTokens += output;
    session.reasoningOutputTokens += reasoning;
    session.cacheReadTokens += cached;

    if (!modelTokens[billingModel]) modelTokens[billingModel] = { input: 0, output: 0, cacheRead: 0, webSearch: 0 };
    modelTokens[billingModel].input += freshInput;
    modelTokens[billingModel].output += output;
    modelTokens[billingModel].cacheRead += cached;

    const dateStr = ts ? localDayStr(ts) : UNBUCKETED_DAY;
    if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
    if (!dailyModelTokens[dateStr][billingModel]) dailyModelTokens[dateStr][billingModel] = { input: 0, output: 0, cacheRead: 0, webSearch: 0 };
    dailyModelTokens[dateStr][billingModel].input += freshInput;
    dailyModelTokens[dateStr][billingModel].output += output;
    dailyModelTokens[dateStr][billingModel].cacheRead += cached;
  };

  const accumulateWebSearch = (ts, model) => {
    if (cutoffMs && ts && Date.parse(ts) < cutoffMs) return;
    // Bucket the fee under the same base billing name token usage resolves to
    // (a search call has no input size, so never the '[long]' variant) — not a
    // raw model string that could diverge from the token buckets.
    const billingModel = billingModelName(model || 'unknown');
    session.webSearchRequests++;

    if (!modelTokens[billingModel]) modelTokens[billingModel] = { input: 0, output: 0, cacheRead: 0, webSearch: 0 };
    modelTokens[billingModel].webSearch += 1;

    const dateStr = ts ? localDayStr(ts) : UNBUCKETED_DAY;
    if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
    if (!dailyModelTokens[dateStr][billingModel]) dailyModelTokens[dateStr][billingModel] = { input: 0, output: 0, cacheRead: 0, webSearch: 0 };
    dailyModelTokens[dateStr][billingModel].webSearch += 1;
  };

  for await (const line of rolloutLines(filePath)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    // Legacy pre-envelope rollouts (Rust builds through ~v0.4x, 2025): line 1
    // is a bare SessionMeta {id, timestamp, ...}, following lines are bare
    // ResponseItems. No token counts exist in that era — messages only.
    if (!obj.type && obj.id && obj.timestamp && !obj.payload) {
      session.sessionId = obj.id;
      if (obj.cwd && !session.repoPath) session.repoPath = obj.cwd;
      if (obj.git?.branch) session.gitBranch = obj.git.branch;
      touchTimestamp(obj.timestamp);
      continue;
    }

    // Envelope lines carry { timestamp, type, payload }; legacy pre-envelope
    // lines are bare ResponseItems whose own `type` (message/function_call/…)
    // would otherwise be mistaken for an envelope type — discriminate on the
    // presence of `payload`.
    const ts = obj.timestamp || null;
    let kind;
    let payload;
    if (obj.payload !== undefined && obj.type) {
      kind = obj.type;
      payload = obj.payload;
    } else if (obj.type) {
      kind = 'response_item';
      payload = obj;
    } else {
      continue; // legacy {record_type:'state'} lines and other unknowns
    }
    if (!payload) continue;

    if (kind === 'session_meta') {
      session.sessionId = payload.session_id || payload.id || session.sessionId;
      if (payload.cwd) session.repoPath = payload.cwd;
      if (payload.git?.branch) session.gitBranch = payload.git.branch;
      // A structured `source` (vs the plain "cli"/"vscode" string) marks a
      // subagent thread spawned from a parent session — its rollout begins
      // with a replay of the parent history (usage, messages, tool calls all
      // re-stamped to the spawn second) that must not be counted.
      if (payload.source && typeof payload.source === 'object') {
        spawnReplay = true;
        const metaTs = ts || payload.timestamp;
        if (metaTs) replaySecond = metaTs.slice(0, 19);
      }
      touchTimestamp(ts || payload.timestamp);
      continue;
    }

    if (kind === 'turn_context') {
      if (payload.model) currentModel = payload.model;
      if (!session.repoPath && payload.cwd) session.repoPath = payload.cwd;
      touchTimestamp(ts);
      continue;
    }

    if (kind === 'event_msg') {
      const et = payload.type;
      if (et === 'token_count') {
        touchTimestamp(ts);
        const info = payload.info;
        const planType = payload.rate_limits?.plan_type;
        if (planType) session.codexPlanType = planType;
        if (info) {
          const model = info.model || currentModel || 'unknown';

          // Replay-burst skip: parent-history usage is not this session's.
          if (inReplayBurst(ts)) {
            if (info.total_token_usage) prevTotal = info.total_token_usage;
            continue;
          }

          let delta = null;
          if (info.last_token_usage) {
            delta = info.last_token_usage;
            if (info.total_token_usage) prevTotal = info.total_token_usage;
          } else if (info.total_token_usage) {
            // Older shape: cumulative totals only — accumulate the per-event
            // delta, normalizing the drifted cached-field aliases on BOTH
            // sides. A field going DOWN means the counter reset (new context
            // window); treat the new value as a fresh baseline.
            const cur = info.total_token_usage;
            const norm = (u) => ({
              input_tokens: u?.input_tokens || 0,
              cached_input_tokens: u ? cachedOf(u) : 0,
              output_tokens: u?.output_tokens || 0,
              reasoning_output_tokens: u?.reasoning_output_tokens || 0,
            });
            const curN = norm(cur);
            const prevN = norm(prevTotal);
            delta = {};
            for (const k of Object.keys(curN)) {
              const d = curN[k] - prevN[k];
              delta[k] = d >= 0 ? d : curN[k];
            }
            prevTotal = cur;
          }
          if (delta) {
            // Exact-duplicate events appear when Codex re-logs the same
            // completed turn's usage (branched threads, resumed sessions,
            // or a heartbeat re-announcement seconds-to-minutes later with
            // no new request in between) — count each once. The timestamp
            // is deliberately NOT part of the key: real duplicates carry
            // different timestamps, so identity is the reported usage
            // itself. Only dedup timestamped events: without a timestamp,
            // two identical deltas are more plausibly two real requests
            // than a replay.
            const dupKey = `${model}|${delta.input_tokens || 0}|${cachedOf(delta)}|${delta.output_tokens || 0}|${delta.reasoning_output_tokens || 0}`;
            if (!ts || !seenUsage.has(dupKey)) {
              seenUsage.add(dupKey);
              tokenCountResponses++;
              accumulateUsage(delta, ts, model);
            }
          }
        }
      } else if (et === 'user_message') {
        // Only real prompts — Codex also logs injected user_instructions /
        // environment_context blocks under the same event type.
        if ((!payload.kind || payload.kind === 'plain') && !inReplayBurst(ts)) {
          eventUserMessages++;
          touchTimestamp(ts);
        }
      } else if (et === 'agent_message') {
        if (!inReplayBurst(ts)) agentMessages++;
        touchTimestamp(ts);
      } else if (et === 'patch_apply_end') {
        // The structured record of file modifications: changes is a map of
        // absolute path -> {type: add|delete|update, move_path?}. Only count
        // applied patches (and not replayed parent history).
        touchTimestamp(ts);
        if ((payload.success ?? true) && payload.status !== 'failed' && payload.status !== 'declined' && payload.changes && !inReplayBurst(ts)) {
          for (const [file, change] of Object.entries(payload.changes)) {
            rawFiles.add(file);
            if (change?.move_path) rawFiles.add(String(change.move_path));
          }
        }
      } else if (et === 'task_started' || et === 'task_complete') {
        touchTimestamp(ts);
      }
      continue;
    }

    if (kind === 'response_item') {
      // Replayed parent history in spawned-thread rollouts also re-emits the
      // conversation and tool calls — skip those alongside the token events.
      if (inReplayBurst(ts)) continue;
      const it = payload.type;
      if (it === 'message') {
        const text = Array.isArray(payload.content)
          ? payload.content.map(c => c?.text || '').join('')
          : String(payload.content || '');
        if (payload.role === 'user') {
          // Skip injected context blocks so legacy counting matches the
          // event_msg 'plain' rule.
          if (!/^\s*<(user_instructions|environment_context|ENVIRONMENT_CONTEXT)/i.test(text)) {
            itemUserMessages++;
          }
        } else if (payload.role === 'assistant') {
          itemAssistantMessages++;
        }
        touchTimestamp(ts);
      } else if (it === 'function_call' || it === 'custom_tool_call') {
        const name = payload.name || 'unknown';
        session.toolCalls[name] = (session.toolCalls[name] || 0) + 1;
        touchTimestamp(ts);
        if (name === 'exec_command' || name === 'shell' || name === 'container.exec') {
          let args = null;
          try {
            args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
          } catch { }
          trackShellCommand(session, commandFromArgs(args));
        } else if (name === 'apply_patch') {
          // Fallback for rollouts without patch_apply_end events; the paths
          // dedupe with the structured ones after normalization.
          let patch = payload.input;
          if (patch === undefined && typeof payload.arguments === 'string') {
            try { patch = JSON.parse(payload.arguments)?.input; } catch { }
          }
          extractPatchPaths(patch, rawFiles);
        }
      } else if (it === 'local_shell_call') {
        session.toolCalls.shell = (session.toolCalls.shell || 0) + 1;
        touchTimestamp(ts);
        trackShellCommand(session, commandFromArgs(payload.action));
      } else if (it === 'web_search_call') {
        touchTimestamp(ts);
        // Web searches carry real per-call fees, so — like token_count events —
        // they need the same guards: only bill completed calls, and count each
        // call_id once so replayed/resumed history doesn't double-charge.
        const status = payload.status;
        const searchId = payload.call_id || payload.id;
        const billable = (!status || status === 'completed')
          && (!searchId || !seenWebSearch.has(searchId));
        if (searchId) seenWebSearch.add(searchId);
        if (billable) {
          session.toolCalls.web_search = (session.toolCalls.web_search || 0) + 1;
          accumulateWebSearch(ts, currentModel || 'unknown');
        }
      }
    }
    // compacted / world_state / inter_agent_* / unknown types: ignore
  }

  // Message counts: prefer the persisted event stream (new format); fall back
  // to response_item messages for legacy rollouts that predate event_msg.
  session.userMessageCount = eventUserMessages > 0 ? eventUserMessages : itemUserMessages;
  // "Assistant actions per prompt" drives the autopilot ratio; each model
  // request (token_count) is one action — the Claude-parser analog of one
  // assistant API message. Legacy fallback: final messages + tool calls.
  session.assistantMessageCount = tokenCountResponses > 0
    ? tokenCountResponses
    : (agentMessages > 0 ? agentMessages : itemAssistantMessages);

  // Costs — same per-day-priced structure as claude-parser, so a session
  // straddling a price change (o3's 2025-06-10 cut) is costed correctly on
  // each side and session.cost reconciles exactly with the daily timeline.
  const rawStartMs = session.startTime ? Date.parse(session.startTime) : Date.now();
  const sessionDateMs = cutoffMs ? Math.max(rawStartMs, cutoffMs) : rawStartMs;

  let maxTokens = 0;
  let primaryModel = null;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    const bd = calculateCodexCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, model, sessionDateMs, tokens.webSearch);
    const p = getCodexPricing(model, sessionDateMs) || CODEX_FALLBACK;
    session.cacheSavingsDollars += tokens.cacheRead * (p.input - p.cachedInput) / PER_MIL;
    if (p.estimate) session.estimatedCost += bd.totalCost - bd.serverToolCost;
    const totalTokens = tokens.input + tokens.output + tokens.cacheRead;
    session.modelBreakdown[model] = { tokens: totalTokens, cost: bd.totalCost };
    session.cost.inputCost += bd.inputCost;
    session.cost.outputCost += bd.outputCost;
    session.cost.cacheReadCost += bd.cacheReadCost;
    session.cost.serverToolCost += bd.serverToolCost;
    session.cost.totalCost += bd.totalCost;
    if (totalTokens > maxTokens) {
      maxTokens = totalTokens;
      primaryModel = model;
    }
  }
  session.model = primaryModel;

  // Resolve usage that couldn't be day-bucketed to the earliest known day,
  // clamped into the analyzed window (mirrors claude-parser).
  if (dailyModelTokens[UNBUCKETED_DAY]) {
    const realDays = Object.keys(dailyModelTokens).filter(d => d !== UNBUCKETED_DAY).sort();
    let targetMs = realDays.length > 0 ? Date.parse(realDays[0] + 'T12:00:00') : rawStartMs;
    if (cutoffMs) targetMs = Math.max(targetMs, cutoffMs);
    const target = localDayStr(targetMs);
    const day = dailyModelTokens[target] || (dailyModelTokens[target] = {});
    for (const [model, tk] of Object.entries(dailyModelTokens[UNBUCKETED_DAY])) {
      if (!day[model]) day[model] = { input: 0, output: 0, cacheRead: 0, webSearch: 0 };
      for (const k of Object.keys(tk)) day[model][k] += tk[k];
    }
    delete dailyModelTokens[UNBUCKETED_DAY];
  }

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
    const dayByModel = {};
    const dayMs = Date.parse(dateStr + 'T12:00:00Z');
    for (const [model, tokens] of Object.entries(models)) {
      const bd = calculateCodexCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, model, dayMs, tokens.webSearch);
      dayCost += bd.totalCost;
      dailyModelCost[model] = (dailyModelCost[model] || 0) + bd.totalCost;
      dailyTotal.inputCost += bd.inputCost;
      dailyTotal.outputCost += bd.outputCost;
      dailyTotal.cacheReadCost += bd.cacheReadCost;
      dailyTotal.serverToolCost += bd.serverToolCost;
      dailyTotal.totalCost += bd.totalCost;
      const p = getCodexPricing(model, dayMs) || CODEX_FALLBACK;
      dailySavings += tokens.cacheRead * (p.input - p.cachedInput) / PER_MIL;
      if (p.estimate) dailyEstimated += bd.totalCost - bd.serverToolCost;
      dailyCoveredTokens += tokens.input + tokens.output + tokens.cacheRead;
      dayInput += tokens.input;
      dayOutput += tokens.output;
      dayCacheRead += tokens.cacheRead;
      dayByModel[model] = { tokens: tokens.input + tokens.output + tokens.cacheRead, cost: bd.totalCost };
    }
    session.dailyUsage[dateStr] = {
      inputTokens: dayInput,
      outputTokens: dayOutput,
      cacheReadTokens: dayCacheRead,
      cacheCreationTokens: 0,
      cost: dayCost,
      byModel: dayByModel,
    };
  }

  const sessionTotalTokens = session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens;
  if (sessionTotalTokens > 0 && dailyCoveredTokens === sessionTotalTokens) {
    session.cost = dailyTotal;
    session.cacheSavingsDollars = dailySavings;
    session.estimatedCost = dailyEstimated;
    for (const [model, cost] of Object.entries(dailyModelCost)) {
      if (session.modelBreakdown[model]) session.modelBreakdown[model].cost = cost;
    }
  }

  if (session.startTime && session.endTime) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    session.durationMinutes = Math.round((end - start) / 60000 * 10) / 10;
  }

  // Normalize touched files to repo-root-relative paths for commit correlation.
  // patch_apply_end keys are absolute; apply_patch bodies are usually relative
  // to the session cwd — resolve those first so both collapse to one form.
  let gitRoot = session.repoPath;
  if (gitRoot) gitRoot = findGitRoot(gitRoot) || gitRoot;
  const resolved = [...rawFiles].map(f =>
    path.isAbsolute(f) ? f : path.join(session.repoPath || '/', f)
  );
  session.filesWritten = [...new Set(
    resolved.map(f => toRelativePath(f, gitRoot)).filter(Boolean)
  )];
  if (gitRoot) session.repoPath = gitRoot;

  return session;
}

export async function parseCodexSessions(codexDir, days, projectFilter) {
  if (!codexDir || !existsSync(codexDir)) {
    return { sessions: [], fileIndex: {} };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();

  const sessions = [];
  const fileIndex = {};

  for (const filePath of listCodexSessionFiles(codexDir)) {
    let mtime;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoffMs) continue;

    // Track every in-window file (even ones we skip) so cache staleness
    // detection stays quiet about files that will never parse differently.
    fileIndex[filePath] = mtime;

    if (filePath.endsWith('.zst') && !canZstd) {
      if (!warnedZstd) {
        warnedZstd = true;
        process.stderr.write('Warning: skipping zstd-compressed Codex rollouts — Node >= 22.15 is required to read .jsonl.zst files\n');
      }
      continue;
    }

    try {
      const session = await parseCodexRollout(filePath, cutoffMs);

      // Skip empty sessions (no conversation and no usage)
      if (!session.startTime) continue;
      const msgCount = session.userMessageCount + session.assistantMessageCount;
      if (msgCount === 0 && session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens === 0) {
        continue;
      }

      // Keep sessions with ANY activity inside the window (usage was clipped
      // to the window during parsing, same rule as claude-parser)
      if (new Date(session.endTime || session.startTime).getTime() < cutoffMs) continue;

      session.projectName = session.repoPath ? path.basename(session.repoPath) : 'codex';
      if (projectFilter && !session.projectName.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue;
      }
      sessions.push(session);
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse ${filePath}: ${err.message}\n`);
    }
  }

  // Deduplicate by sessionId — a resumed/re-materialized session can leave
  // both a .jsonl and a stale .jsonl.zst copy; keep the fuller transcript.
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
