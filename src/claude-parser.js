import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Pricing per million tokens — from https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache reads = 0.1x base input, Cache writes (5min) = 1.25x base input
const PRICING = {
  // Opus 4.8: $5 input, $25 output (same as 4.7)
  'opus-48':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.7: $5 input, $25 output (same as 4.6)
  'opus-47':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.6: $5 input, $25 output
  'opus-46':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.5: $5 input, $25 output
  'opus-45':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.0 / 4.1 (legacy): $15 input, $75 output
  'opus-old':   { input: 15,    output: 75,    cacheRead: 1.50,   cacheWrite: 18.75  },
  // Fable 5 / Mythos 5: $10 input, $50 output — Anthropic's documentation:
  // https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5
  // Generally available; access was restored on 2026-07-01 after a temporary
  // suspension (2026-06-12 to 2026-06-30). These rates cost both live and
  // historical Fable usage in users' logs.
  fable:        { input: 10,    output: 50,    cacheRead: 1.00,   cacheWrite: 12.50  },
  // Sonnet 3.7 / 4.0 / 4.5 / 4.6 — and Sonnet 5 *standard* pricing (from 2026-09-01): $3 input, $15 output
  sonnet:       { input: 3,     output: 15,    cacheRead: 0.30,   cacheWrite: 3.75   },
  // Sonnet 5 introductory pricing, in effect through 2026-08-31: $2 input, $10 output.
  // Reverts to standard Sonnet-tier pricing (the `sonnet` row above) on 2026-09-01 — see
  // getPricingTier, which selects the tier by usage date. https://www.anthropic.com/news/claude-sonnet-5
  // Cache rates follow Anthropic's standard multiples of the (intro) input price: read 0.1x = $0.20,
  // 5-min write 1.25x = $2.50 (the 1-hour write 2x = $4.00 is derived in oneHourCachePremium).
  'sonnet-5-intro': { input: 2, output: 10,    cacheRead: 0.20,   cacheWrite: 2.50   },
  // Fast mode (research preview, Opus 4.8/4.7 only): same models at premium
  // per-token rates. Cache multipliers stack on top of the fast input price.
  // Requests carry usage.speed === 'fast'; we bucket them via a '[fast]' marker
  // on the model key. https://platform.claude.com/docs/en/about-claude/pricing
  'opus-48-fast': { input: 10,  output: 50,    cacheRead: 1.00,   cacheWrite: 12.50  },
  'opus-47-fast': { input: 30,  output: 150,   cacheRead: 3.00,   cacheWrite: 37.50  },
  // Haiku 4.5: $1 input, $5 output
  'haiku-new':  { input: 1,     output: 5,     cacheRead: 0.10,   cacheWrite: 1.25   },
  // Haiku 3.5: $0.80 input, $4 output
  'haiku-35':   { input: 0.80,  output: 4,     cacheRead: 0.08,   cacheWrite: 1.00   },
  // Haiku 3: $0.25 input, $1.25 output
  'haiku-3':    { input: 0.25,  output: 1.25,  cacheRead: 0.03,   cacheWrite: 0.30   },
};

const PER_MIL = 1_000_000;

// Claude Sonnet 5 launched with introductory pricing ($2/$10) that runs through
// 2026-08-31, reverting to standard Sonnet-tier pricing ($3/$15) on 2026-09-01.
// Usage is priced by the rate in effect on its date so historical logs stay
// accurate across the cutover. https://www.anthropic.com/news/claude-sonnet-5
const SONNET5_STANDARD_START_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z

function getModelFamily(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  return null;
}

function getPricingTier(modelName, usageDateMs = Date.now()) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  // Fable 5 / Mythos 5 share $10/$50 pricing
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  // Opus: check most specific version first. '[fast]' is our usage-bucket marker
  // for requests served in fast mode (usage.speed === 'fast'), which bills at
  // premium rates on Opus 4.8/4.7. On other models fast requests run (and bill)
  // at standard speed, so they fall through to the standard tier.
  const fast = lower.includes('[fast]');
  if (lower.includes('opus')) {
    if (lower.includes('4-8') || lower.includes('4.8')) return fast ? 'opus-48-fast' : 'opus-48';
    if (lower.includes('4-7') || lower.includes('4.7')) return fast ? 'opus-47-fast' : 'opus-47';
    if (lower.includes('4-6') || lower.includes('4.6')) return 'opus-46';
    if (lower.includes('4-5') || lower.includes('4.5')) return 'opus-45';
    return 'opus-old';
  }
  if (lower.includes('sonnet')) {
    // Sonnet 5 has date-dependent pricing: introductory $2/$10 through 2026-08-31,
    // then standard $3/$15 (the `sonnet` tier). `sonnet-5` won't match `sonnet-4-5`
    // (substring is `sonnet-4-5`, not `sonnet-5`), so older Sonnets are unaffected.
    if (lower.includes('sonnet-5') || lower.includes('sonnet5')) {
      return usageDateMs >= SONNET5_STANDARD_START_MS ? 'sonnet' : 'sonnet-5-intro';
    }
    // All older Sonnet versions (3.7, 4.0, 4.5, 4.6) share flat $3/$15 pricing
    return 'sonnet';
  }
  // Haiku version detection
  if (lower.includes('haiku')) {
    if (lower.includes('4-5') || lower.includes('4.5') || lower.includes('4-6') || lower.includes('4.6')) return 'haiku-new';
    if (lower.includes('3-5') || lower.includes('3.5')) return 'haiku-35';
    return 'haiku-3'; // Haiku 3 (claude-3-haiku)
  }
  return 'sonnet'; // default unknown models to Sonnet pricing
}

// `cacheWrite` is the default 5-minute TTL rate (1.25x input). 1-hour-TTL cache
// writes cost 2x input, so the 1h portion gets a premium of (2x - 1.25x) input.
function oneHourCachePremium(p, cacheCreation1hTokens) {
  return cacheCreation1hTokens * (2 * p.input - p.cacheWrite) / PER_MIL;
}

// US data residency (usage.inference_geo === 'us', bucketed via a '[us]' marker
// on the model key) bills a 1.1x multiplier on ALL token categories.
// https://platform.claude.com/docs/en/about-claude/pricing (data residency)
const GEO_US_MULTIPLIER = 1.1;
function geoMultiplier(modelName) {
  return modelName?.includes('[us]') ? GEO_US_MULTIPLIER : 1;
}

// Server-side web search bills $10 per 1,000 searches on top of token costs
// (web fetch is free). Counted from usage.server_tool_use.web_search_requests.
const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

function calculateCost(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, cacheCreation1hTokens = 0, usageDateMs = Date.now(), webSearchRequests = 0) {
  const tier = getPricingTier(modelName, usageDateMs);
  if (!tier) return 0;
  const p = PRICING[tier];
  return geoMultiplier(modelName) * (
    (inputTokens * p.input / PER_MIL) +
    (outputTokens * p.output / PER_MIL) +
    (cacheReadTokens * p.cacheRead / PER_MIL) +
    (cacheCreationTokens * p.cacheWrite / PER_MIL) +
    oneHourCachePremium(p, cacheCreation1hTokens)
  ) + webSearchRequests * WEB_SEARCH_COST_PER_REQUEST;
}

function calculateCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName, cacheCreation1hTokens = 0, usageDateMs = Date.now(), webSearchRequests = 0) {
  const tier = getPricingTier(modelName, usageDateMs);
  if (!tier) return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 };
  const p = PRICING[tier];
  const mult = geoMultiplier(modelName);
  const inputCost = mult * inputTokens * p.input / PER_MIL;
  const outputCost = mult * outputTokens * p.output / PER_MIL;
  const cacheReadCost = mult * cacheReadTokens * p.cacheRead / PER_MIL;
  const cacheCreationCost = mult * (cacheCreationTokens * p.cacheWrite / PER_MIL + oneHourCachePremium(p, cacheCreation1hTokens));
  const serverToolCost = webSearchRequests * WEB_SEARCH_COST_PER_REQUEST;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    serverToolCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost + serverToolCost,
  };
}

function toRelativePath(absolutePath, repoPath) {
  if (!absolutePath) return null;
  // Handle worktree paths: .claude/worktrees/<name>/src/file.js → src/file.js
  const wtMatch = absolutePath.match(/\.claude\/worktrees\/[^/]+\/(.+)/);
  if (wtMatch) return wtMatch[1];
  // Normal: strip repo root prefix
  if (repoPath && absolutePath.startsWith(repoPath)) {
    let rel = absolutePath.slice(repoPath.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    return rel;
  }
  // Stale-alias cwd: the recorded repoPath can be a dead alias of the live
  // root (e.g. cwd logged as .../GitHub/repo while files landed under
  // .../GitHub.nosync/repo), so the prefix check fails even though the path
  // is inside the same-named repo folder. Suffix-match on the folder name
  // before collapsing to a bare basename — lastIndexOf picks the innermost
  // match, i.e. the shortest relative path.
  if (repoPath) {
    const marker = path.sep + path.basename(repoPath) + path.sep;
    const idx = absolutePath.lastIndexOf(marker);
    if (idx !== -1) return absolutePath.slice(idx + marker.length);
  }
  // Fallback: return just the filename
  return absolutePath.split('/').pop();
}

// Commands that are clearly NOT verification even if they contain matching keywords
const NON_VERIFICATION_PATTERNS = [
  /^\s*node\s+-e\b/,        // inline JS eval
  /^\s*find\s+/,            // file search
  /^\s*cat\s+/,             // file display
  /^\s*echo\s+/,            // printing
  /^\s*ls\b/,               // listing
  /^\s*rm\s+/,              // file deletion
  /^\s*cd\s+/,              // directory change (when standalone)
  /^\s*mkdir\s+/,           // directory creation
  /^\s*cp\s+/,              // file copy
  /^\s*mv\s+/,              // file move
  /^\s*touch\s+/,           // file creation
  /^\s*chmod\s+/,           // permission change
  /^\s*gh\s+pr\b/,          // GitHub PR operations
  /^\s*gh\s+issue\b/,       // GitHub issue operations
  /^\s*git\s+(add|commit|push|pull|checkout|branch|merge|stash|rebase)\b/, // git write ops
  /^\s*npm\s+(install|i|ci|publish|init)\b/, // npm non-test commands
  /^\s*pip\s+install\b/,    // pip install
  /^\s*brew\s+/,            // homebrew
  /^\s*curl\s+/,            // HTTP requests
  /^\s*wget\s+/,            // downloads
  /^\s*docker\s+/,          // docker commands
  /^\s*kill\s+/,            // process kill
  /^\s*pkill\s+/,           // process kill
  /^\s*open\s+/,            // open files/URLs
  /^\s*code\s+/,            // open in VS Code
  /^\s*pbcopy\b/,           // clipboard
  /^\s*sed\s+/,             // stream edit
  /^\s*awk\s+/,             // text processing
  /^\s*grep\s+/,            // search (not verification)
  /^\s*wc\s+/,              // word count
  /^\s*head\s+/,            // file preview
  /^\s*tail\s+/,            // file preview
  /^\s*(?:yarn|pnpm|bun)\s+(?:global\s+)?add\b/, // package install via non-npm managers
  /^\s*npx\s+playwright\s+install\b/, // playwright browser-binary install, not a test run
];

// Patterns that identify test/lint/typecheck commands (for autonomy self-heal score)
const VERIFICATION_PATTERNS = [
  // JavaScript/TypeScript
  /\bnpm\s+(test|run\s+(test|lint|check|typecheck|format:check))\b/,
  /\b(pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|typecheck|format:check)\b/,
  /\b(jest|vitest|mocha|ava|cypress|playwright)(?:\s|$)/,
  /\btsc(\s+--noEmit|\s+-p)\b/,
  /\b(eslint|biome|prettier\b.*--check)/,
  /\bnode\s+--check\b/,
  /\bnpx\s+(tsc|eslint|jest|vitest|prettier\s+--check)\b/,

  // Python
  /\b(pytest|python\s+-m\s+(pytest|unittest|mypy|ruff|flake8|pylint))\b/,
  /\b(mypy|ruff\s+check|flake8|pylint|pyright|bandit)\b/,

  // Go
  /\bgo\s+(test|vet)\b/,
  /\bgolangci-lint\b/,

  // Rust
  /\bcargo\s+(test|clippy|check)\b/,

  // Ruby
  /\b(rubocop|rspec|bundle\s+exec\s+(rspec|rubocop))\b/,

  // Java/Kotlin
  /\b(gradle|gradlew|mvn|maven)\s+(test|check|verify)\b/,

  // General
  /\bmake\s+(test|check|lint|verify)\b/,
  /\bpre-commit\s+run\b/,
];

// Evaluates one shell segment (no top-level && or ; left in it) against the
// verification/non-verification pattern lists.
function isSingleVerificationCommand(command) {
  if (!command || typeof command !== 'string') return false;
  // Strip env var prefixes to get the core command ("cd ..." is its own
  // segment after splitting, so it never needs stripping here).
  const core = command.replace(/^(?:\w+=\S+\s+)+/g, '').trim();
  // Exclude commands that are clearly not verification
  if (NON_VERIFICATION_PATTERNS.some(p => p.test(core))) return false;
  return VERIFICATION_PATTERNS.some(p => p.test(core));
}

// A compound command ("<setup/cleanup> && <test>") counts as verification if
// ANY segment is one — a leading rm/mkdir/git-checkout/etc. must not mask a
// real test/lint/typecheck call later in the chain.
function isVerificationCommand(command) {
  if (!command || typeof command !== 'string') return false;
  return command.split(/&&|;/).some(isSingleVerificationCommand);
}

// Read-only inspection commands (for the self-heal score): they examine state
// without changing it. Conservative allow-list keyed on the effective first
// token — anything ambiguous is NOT read-only.
const READ_ONLY_COMMANDS = new Set([
  'cat', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'head', 'tail', 'wc',
  'pwd', 'stat', 'nl', 'which', 'file', 'du', 'df', 'tree', 'realpath',
  'dirname', 'basename', 'type', 'printenv', 'env', 'echo', 'printf',
]);

// Evaluates one shell segment (no top-level &&, ;, or | left in it).
function isSingleReadOnlyCommand(command) {
  if (!command || typeof command !== 'string') return false;
  // Strip env var prefixes, same as isVerificationCommand ("cd ..." is its
  // own segment after splitting, handled explicitly below instead).
  const core = command.replace(/^(?:\w+=\S+\s+)+/g, '').trim();
  if (!core) return false;
  const tokens = core.split(/\s+/);
  const first = tokens[0];
  // A bare directory change doesn't read or write anything itself.
  if (first === 'cd') return true;
  // sed only reads with an explicit -n (print mode) and never with an
  // in-place flag (-i / -i.bak / -i''); combined or ambiguous flags don't qualify.
  if (first === 'sed') {
    const args = tokens.slice(1);
    return args.includes('-n') && !args.some(a => a.startsWith('-i'));
  }
  // find only reads unless -delete/-exec/-execdir let it mutate or run
  // arbitrary commands on the matched files.
  if (first === 'find') {
    return !tokens.slice(1).some(a => a === '-delete' || a === '-exec' || a === '-execdir');
  }
  return READ_ONLY_COMMANDS.has(first);
}

// A compound/piped command ("<opener> && <mutation>", "<search> | xargs rm")
// is read-only only if EVERY segment is — a read-only-looking opener must not
// give the whole chain a free pass when a later stage mutates state.
function isReadOnlyCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const segments = command.split(/&&|;|\|/).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(isSingleReadOnlyCommand);
}

function extractToolUse(session, msg, seenToolUseIds) {
  const content = msg.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    const toolName = block.name;
    if (!toolName) continue;

    // Skip blocks already counted. The same tool_use id reappears when an
    // assistant message is re-sent under a duplicate requestId; counting it again
    // would inflate tool/bash totals (tokens are already deduped separately).
    if (block.id && seenToolUseIds) {
      if (seenToolUseIds.has(block.id)) continue;
      seenToolUseIds.add(block.id);
    }

    // Count tool calls
    session.toolCalls[toolName] = (session.toolCalls[toolName] || 0) + 1;

    // Track which named Skill was invoked (input.skill), not just that the
    // generic Skill tool fired — this is what makes a "top skills" ranking
    // possible instead of a single undifferentiated count.
    if (toolName === 'Skill' && typeof block.input?.skill === 'string' && block.input.skill) {
      session.skillCalls[block.input.skill] = (session.skillCalls[block.input.skill] || 0) + 1;
    }

    // Track Bash commands for autonomy self-heal scoring. Only verification
    // commands keep their text (for the "top tests" list) — storing every
    // command was pure memory/cache ballast, as nothing downstream reads
    // non-verification entries.
    if (toolName === 'Bash') {
      const command = block.input?.command || block.input?.content;
      if (command) {
        session.totalBashCalls++;
        if (isVerificationCommand(command)) {
          session.verificationBashCalls++;
          session.bashCommands.push({ command: command.slice(0, 200), isVerification: true });
        }
        if (isReadOnlyCommand(command)) session.readOnlyBashCalls++;
      }
    }

    // Track files written. Write/Edit/MultiEdit carry input.file_path;
    // NotebookEdit uses input.notebook_path. All four are file-editing tools
    // and must land in filesWritten so file-overlap correlation can attribute
    // commits — omitting MultiEdit/NotebookEdit leaves such a session with no
    // files, forcing weaker time-only (chat-only) attribution or orphaning.
    const filePath = block.input?.file_path || block.input?.notebook_path;
    if (!filePath) continue;

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
      if (!session.filesWritten.includes(filePath)) {
        session.filesWritten.push(filePath);
      }
    }
  }
}

function createEmptySession(sessionId) {
  return {
    sessionId,
    repoPath: null,
    projectName: null,
    gitBranch: null,
    entrypoint: null,
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 },
    model: null,
    modelBreakdown: {},
    toolCalls: {},
    skillCalls: {},
    filesWritten: [],
    userMessageCount: 0,
    assistantMessageCount: 0,
    bashCommands: [],
    totalBashCalls: 0,
    verificationBashCalls: 0,
    readOnlyBashCalls: 0,
    estimatedCost: 0,
    // Subagent transcripts merged into this session (subagents/agent-*.jsonl) —
    // >0 means work was delegated, not just handled by the main conversation.
    subagentTranscriptCount: 0,
    // What the cache-read tokens would have cost at full input price minus what
    // was paid — computed per pricing tier (a flat 9x of cacheReadCost is wrong
    // for tiers like haiku-3 whose cache-read price isn't exactly 0.1x input).
    cacheSavingsDollars: 0,
  };
}

// Sentinel day-bucket for usage rows with no resolvable timestamp; resolved to
// the session's earliest real day (clamped to the window) after parsing.
const UNBUCKETED_DAY = '__unbucketed__';

function localDayStr(dateLike) {
  const dt = new Date(dateLike);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// cutoffMs clips usage accumulation to the lookback window: a session started
// before the window but resumed inside it (--resume appends to the same JSONL)
// keeps only its in-window tokens/cost, so totals and the daily timeline agree
// with the window instead of dropping or over-counting the session. Message and
// tool counts stay whole-session — they describe the session, not the window.
async function parseSessionFile(filePath, cutoffMs = 0) {
  const sessionId = path.basename(filePath, '.jsonl');
  const session = createEmptySession(sessionId);
  const seenRequestIds = new Set();
  const seenToolUseIds = new Set();
  const modelTokens = {}; // model -> { input, output, cacheRead, cacheCreate }
  const dailyModelTokens = {}; // dateStr -> model -> { input, output, cacheRead, cacheCreate }
  let lastSeenTimestamp = null;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    if (obj.type === 'user' && obj.message) {
      // Extract repo path from cwd (most reliable source)
      if (!session.repoPath && obj.cwd) {
        session.repoPath = obj.cwd;
      }
      if (!session.gitBranch && obj.gitBranch) {
        session.gitBranch = obj.gitBranch;
      }
      // Client surface the session ran from (e.g. 'cli', 'claude-vscode') —
      // first value wins, consistent with cwd/gitBranch above.
      if (!session.entrypoint && obj.entrypoint) {
        session.entrypoint = obj.entrypoint;
      }
      if (obj.sessionId) {
        session.sessionId = obj.sessionId;
      }

      // Track timestamps
      if (obj.timestamp) {
        lastSeenTimestamp = obj.timestamp;
        if (!session.startTime || obj.timestamp < session.startTime) {
          session.startTime = obj.timestamp;
        }
        if (!session.endTime || obj.timestamp > session.endTime) {
          session.endTime = obj.timestamp;
        }
      }

      // Count user messages (only actual user content, not tool results or
      // system-injected meta entries). Entries flagged isMeta:true — skill
      // base-directory notices, slash-command definitions, image placeholders —
      // are injected context, not genuine user turns; counting them inflates
      // userMessageCount, which feeds the chat-only attribution floor, the
      // orphaned-session threshold, and the autopilot ratio.
      if (obj.isMeta !== true) {
        const content = obj.message.content;
        if (Array.isArray(content)) {
          const hasUserText = content.some(b => b.type === 'text');
          if (hasUserText) session.userMessageCount++;
        } else if (typeof content === 'string') {
          session.userMessageCount++;
        }
      }

      continue;
    }

    if (obj.type !== 'assistant' || !obj.message) continue;

    const msg = obj.message;

    // Skip synthetic/error messages
    if (msg.model === '<synthetic>') continue;

    // Track timestamps
    if (obj.timestamp) {
      lastSeenTimestamp = obj.timestamp;
      if (!session.startTime || obj.timestamp < session.startTime) {
        session.startTime = obj.timestamp;
      }
      if (!session.endTime || obj.timestamp > session.endTime) {
        session.endTime = obj.timestamp;
      }
    }

    // Deduplicate by requestId to avoid double-counting tokens
    const requestId = obj.requestId;
    const isNewRequest = requestId && !seenRequestIds.has(requestId);
    if (requestId) seenRequestIds.add(requestId);

    // Accumulate usage only for new requests, and only inside the lookback
    // window (usage without a resolvable timestamp is kept rather than lost)
    const usageTs = obj.timestamp || lastSeenTimestamp;
    const inWindow = !cutoffMs || !usageTs || Date.parse(usageTs) >= cutoffMs;
    if (isNewRequest || !requestId) {
      const usage = inWindow ? msg.usage : null;
      if (usage) {
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreate = usage.cache_creation_input_tokens || 0;
        // 1-hour-TTL portion of the cache writes (priced at 2x vs 1.25x for 5m).
        // Absent in older log formats — falls back to 0 (all priced at the 5m rate).
        const cacheCreate1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
        // Server-side web search bills $10/1k requests on top of tokens.
        const webSearch = usage.server_tool_use?.web_search_requests || 0;
        // Bucket usage by model + billing markers so premium-billed requests are
        // costed at their true rates: '[fast]' = fast mode (usage.speed), '[us]'
        // = US data residency 1.1x (usage.inference_geo). Markers flow through
        // getPricingTier/geoMultiplier and are visible in the model breakdown.
        const markers = (usage.speed === 'fast' ? '[fast]' : '')
          + (usage.inference_geo === 'us' ? '[us]' : '');
        const model = (msg.model || 'unknown') + markers;

        session.totalInputTokens += input;
        session.totalOutputTokens += output;
        session.cacheReadTokens += cacheRead;
        session.cacheCreationTokens += cacheCreate;
        session.cacheCreation1hTokens += cacheCreate1h;
        session.webSearchRequests += webSearch;

        // Track per-model breakdown
        if (!modelTokens[model]) {
          modelTokens[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, webSearch: 0 };
        }
        modelTokens[model].input += input;
        modelTokens[model].output += output;
        modelTokens[model].cacheRead += cacheRead;
        modelTokens[model].cacheCreate += cacheCreate;
        modelTokens[model].cacheCreate1h += cacheCreate1h;
        modelTokens[model].webSearch += webSearch;

        // Track per-day per-model tokens for daily usage attribution. Usage
        // kept without a resolvable timestamp buckets under a sentinel day,
        // resolved after the parse — left day-less it would appear in session
        // totals but in no day, so the daily timeline and period cards (which
        // read only dailyUsage) would stop reconciling with the hero numbers.
        const dateStr = usageTs ? localDayStr(usageTs) : UNBUCKETED_DAY;
        if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
        if (!dailyModelTokens[dateStr][model]) {
          dailyModelTokens[dateStr][model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, webSearch: 0 };
        }
        dailyModelTokens[dateStr][model].input += input;
        dailyModelTokens[dateStr][model].output += output;
        dailyModelTokens[dateStr][model].cacheRead += cacheRead;
        dailyModelTokens[dateStr][model].cacheCreate += cacheCreate;
        dailyModelTokens[dateStr][model].cacheCreate1h += cacheCreate1h;
        dailyModelTokens[dateStr][model].webSearch += webSearch;
      }

      session.assistantMessageCount++;
    }

    // Always extract tool use info (different content blocks can appear in split
    // messages); dedup by tool_use id so duplicate-requestId re-sends aren't recounted.
    extractToolUse(session, msg, seenToolUseIds);
  }

  // Compute costs from model breakdown
  let maxTokens = 0;
  let primaryModel = null;
  // Cost attributed to models with no known pricing (billed at the Sonnet
  // fallback) — surfaced so the dashboard can flag estimated spend rather than
  // presenting a silently-wrong number as fact.
  session.estimatedCost = 0;

  // Date used to pick time-sensitive rates (e.g. Sonnet 5's intro vs standard
  // pricing), clamped to the window cutoff: under clipping every accumulated
  // token is in-window, so a straddling session must not price them at its
  // pre-window start date. Per-day costs below re-resolve the rate per day.
  const rawStartMs = session.startTime ? Date.parse(session.startTime) : Date.now();
  const sessionDateMs = cutoffMs ? Math.max(rawStartMs, cutoffMs) : rawStartMs;

  for (const [model, tokens] of Object.entries(modelTokens)) {
    const cost = calculateCost(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, tokens.cacheCreate1h, sessionDateMs, tokens.webSearch);
    // Avoided cost of cache reads at this model's actual rates
    const tier = getPricingTier(model, sessionDateMs);
    if (tier) {
      const p = PRICING[tier];
      session.cacheSavingsDollars += geoMultiplier(model) * tokens.cacheRead * (p.input - p.cacheRead) / PER_MIL;
    }
    const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    session.modelBreakdown[model] = { tokens: totalTokens, cost };
    if (getModelFamily(model) === null) session.estimatedCost += cost;

    if (totalTokens > maxTokens) {
      maxTokens = totalTokens;
      primaryModel = model;
    }
  }
  session.model = primaryModel;

  // Calculate total cost breakdown
  session.cost = calculateCostBreakdown(
    session.totalInputTokens,
    session.totalOutputTokens,
    session.cacheReadTokens,
    session.cacheCreationTokens,
    primaryModel,
    session.cacheCreation1hTokens,
    sessionDateMs,
    session.webSearchRequests
  );

  // If multiple models used, recalculate cost from per-model breakdown for accuracy
  if (Object.keys(modelTokens).length > 1) {
    let totalCost = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    let cacheCreationCost = 0;
    let serverToolCost = 0;

    for (const [model, tokens] of Object.entries(modelTokens)) {
      const breakdown = calculateCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, tokens.cacheCreate1h, sessionDateMs, tokens.webSearch);
      inputCost += breakdown.inputCost;
      outputCost += breakdown.outputCost;
      cacheReadCost += breakdown.cacheReadCost;
      cacheCreationCost += breakdown.cacheCreationCost;
      serverToolCost += breakdown.serverToolCost;
      totalCost += breakdown.totalCost;
    }

    session.cost = { inputCost, outputCost, cacheReadCost, cacheCreationCost, serverToolCost, totalCost };
  }

  // Resolve usage that couldn't be day-bucketed (rows before the first
  // timestamp in the file) to the session's earliest known day, clamped to the
  // window cutoff so it lands inside the window everything else was clipped to.
  if (dailyModelTokens[UNBUCKETED_DAY]) {
    const realDays = Object.keys(dailyModelTokens).filter(d => d !== UNBUCKETED_DAY).sort();
    let targetMs = realDays.length > 0
      ? Date.parse(realDays[0] + 'T12:00:00')
      : rawStartMs;
    if (cutoffMs) targetMs = Math.max(targetMs, cutoffMs);
    const target = localDayStr(targetMs);
    const day = dailyModelTokens[target] || (dailyModelTokens[target] = {});
    for (const [model, tk] of Object.entries(dailyModelTokens[UNBUCKETED_DAY])) {
      if (!day[model]) day[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, webSearch: 0 };
      for (const k of Object.keys(tk)) day[model][k] += tk[k];
    }
    delete dailyModelTokens[UNBUCKETED_DAY];
  }

  // Compute per-day usage with accurate per-model cost. Each day is priced at the
  // rate in effect on it (not the session's start-day rate), so a session that
  // straddles a pricing change — e.g. Sonnet 5's 2026-09-01 intro→standard cutover —
  // is costed correctly on each side. We also accumulate the session-level breakdown,
  // per-model cost, and cache savings here so they reconcile exactly with the
  // daily timeline.
  session.dailyUsage = {};
  const dailyModelCost = {};
  const dailyTotal = { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 };
  let dailyCoveredTokens = 0;
  let dailySavings = 0;
  for (const [dateStr, models] of Object.entries(dailyModelTokens)) {
    let dayCost = 0;
    let dayInput = 0, dayOutput = 0, dayCacheRead = 0, dayCacheCreate = 0;
    const dayByModel = {};
    // Price this day at the rate in effect on it (noon UTC avoids boundary TZ skew).
    const dayMs = Date.parse(dateStr + 'T12:00:00Z');
    for (const [model, tokens] of Object.entries(models)) {
      const bd = calculateCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model, tokens.cacheCreate1h, dayMs, tokens.webSearch);
      dayCost += bd.totalCost;
      dailyModelCost[model] = (dailyModelCost[model] || 0) + bd.totalCost;
      dailyTotal.inputCost += bd.inputCost;
      dailyTotal.outputCost += bd.outputCost;
      dailyTotal.cacheReadCost += bd.cacheReadCost;
      dailyTotal.cacheCreationCost += bd.cacheCreationCost;
      dailyTotal.serverToolCost += bd.serverToolCost;
      dailyTotal.totalCost += bd.totalCost;
      // Avoided cost of this day's cache reads, at the rate in effect on it
      const dayTier = getPricingTier(model, dayMs);
      if (dayTier) {
        const p = PRICING[dayTier];
        dailySavings += geoMultiplier(model) * tokens.cacheRead * (p.input - p.cacheRead) / PER_MIL;
      }
      dailyCoveredTokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
      dayInput += tokens.input;
      dayOutput += tokens.output;
      dayCacheRead += tokens.cacheRead;
      dayCacheCreate += tokens.cacheCreate;
      dayByModel[model] = {
        tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate,
        cost: bd.totalCost,
      };
    }
    session.dailyUsage[dateStr] = {
      inputTokens: dayInput,
      outputTokens: dayOutput,
      cacheReadTokens: dayCacheRead,
      cacheCreationTokens: dayCacheCreate,
      cost: dayCost,
      // Per-model split so windowed views (e.g. the weekly narrative) can
      // divide spend and lines by what was actually used inside the window.
      byModel: dayByModel,
    };
  }

  // When every usage row carried a timestamp (the common case), the per-day buckets
  // cover the whole session — adopt their per-day-priced totals as authoritative so
  // session.cost, per-model cost, and cache savings reconcile with the daily
  // timeline even across a mid-session pricing cutover. If some usage lacked a
  // timestamp (couldn't be bucketed by day), keep the start-day-priced totals
  // above so no tokens are dropped.
  const sessionTotalTokens = session.totalInputTokens + session.totalOutputTokens + session.cacheReadTokens + session.cacheCreationTokens;
  if (sessionTotalTokens > 0 && dailyCoveredTokens === sessionTotalTokens) {
    session.cost = dailyTotal;
    session.cacheSavingsDollars = dailySavings;
    for (const [model, cost] of Object.entries(dailyModelCost)) {
      if (session.modelBreakdown[model]) session.modelBreakdown[model].cost = cost;
    }
  }

  // Calculate duration
  if (session.startTime && session.endTime) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    session.durationMinutes = Math.round((end - start) / 60000 * 10) / 10;
  }

  // Normalize filesWritten to relative paths (for file-based commit correlation)
  // Resolve the actual git root from repoPath (which may be a worktree path or a
  // subdirectory of the repo — sessions launched from repo/subdir must still
  // resolve to the repo root or git analysis finds no .git and correlation fails)
  let gitRoot = session.repoPath;
  if (gitRoot) {
    const wtRootMatch = gitRoot.match(/^(.+?)\/\.claude\/worktrees\/[^/]+$/);
    if (wtRootMatch) gitRoot = wtRootMatch[1];
    gitRoot = findGitRoot(gitRoot) || gitRoot;
  }
  if (gitRoot) {
    session.filesWritten = session.filesWritten
      .map(fp => toRelativePath(fp, gitRoot))
      .filter(Boolean);
    // Also normalize repoPath to the actual git root
    session.repoPath = gitRoot;
  }

  return session;
}

// Recursively find subagent transcript files under a session's subagents/
// directory. Claude Code writes them both as direct children
// (subagents/agent-*.jsonl) and nested under workflow runs
// (subagents/workflows/<wf-id>/agent-*.jsonl) — a non-recursive scan silently
// drops all workflow-subagent usage from every displayed number.
// journal.jsonl is a workflow bookkeeping file with no usage — skip it.
// Manual walk because readdirSync's `recursive` option needs Node >= 20.
function listSubagentTranscripts(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSubagentTranscripts(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'journal.jsonl') {
      out.push(full);
    }
  }
  return out;
}

async function parseSessionWithSubagents(projectDir, sessionId, cutoffMs = 0) {
  const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
  const session = await parseSessionFile(mainFile, cutoffMs);

  // Merge every subagent transcript (including workflow-nested ones)
  const subagentDir = path.join(projectDir, sessionId, 'subagents');
  if (existsSync(subagentDir)) {
    const subagentFiles = listSubagentTranscripts(subagentDir);
    session.subagentTranscriptCount += subagentFiles.length;
    for (const af of subagentFiles) {
      try {
        const subSession = await parseSessionFile(af, cutoffMs);
        mergeSubagentIntoSession(session, subSession);
      } catch {
        // Skip unreadable/corrupt subagent files
      }
    }
    // Subagents can extend the session span (background agents run past the
    // last main-transcript message) — refresh the derived duration.
    if (session.startTime && session.endTime) {
      const start = new Date(session.startTime).getTime();
      const end = new Date(session.endTime).getTime();
      session.durationMinutes = Math.round((end - start) / 60000 * 10) / 10;
    }
  }

  return session;
}

function mergeSubagentIntoSession(parent, sub) {
  // Extend the session's time span: a background subagent that ran past the
  // main conversation is still session activity, and the span drives window
  // keeping, the correlation window, and duration.
  if (sub.startTime && (!parent.startTime || sub.startTime < parent.startTime)) {
    parent.startTime = sub.startTime;
  }
  if (sub.endTime && (!parent.endTime || sub.endTime > parent.endTime)) {
    parent.endTime = sub.endTime;
  }

  parent.totalInputTokens += sub.totalInputTokens;
  parent.totalOutputTokens += sub.totalOutputTokens;
  parent.cacheCreationTokens += sub.cacheCreationTokens;
  parent.cacheCreation1hTokens += sub.cacheCreation1hTokens || 0;
  parent.cacheReadTokens += sub.cacheReadTokens;
  parent.webSearchRequests += sub.webSearchRequests || 0;

  parent.cost.inputCost += sub.cost.inputCost;
  parent.cost.outputCost += sub.cost.outputCost;
  parent.cost.cacheReadCost += sub.cost.cacheReadCost;
  parent.cost.cacheCreationCost += sub.cost.cacheCreationCost;
  parent.cost.serverToolCost = (parent.cost.serverToolCost || 0) + (sub.cost.serverToolCost || 0);
  parent.cost.totalCost += sub.cost.totalCost;
  parent.cacheSavingsDollars = (parent.cacheSavingsDollars || 0) + (sub.cacheSavingsDollars || 0);
  parent.estimatedCost = (parent.estimatedCost || 0) + (sub.estimatedCost || 0);

  // Message counts intentionally NOT merged — we only report
  // the main-conversation messages, not internal subagent chatter.

  // Merge model breakdown
  for (const [model, data] of Object.entries(sub.modelBreakdown)) {
    if (!parent.modelBreakdown[model]) {
      parent.modelBreakdown[model] = { tokens: 0, cost: 0 };
    }
    parent.modelBreakdown[model].tokens += data.tokens;
    parent.modelBreakdown[model].cost += data.cost;
  }

  // Merge tool calls
  for (const [tool, count] of Object.entries(sub.toolCalls)) {
    parent.toolCalls[tool] = (parent.toolCalls[tool] || 0) + count;
  }

  // Merge skill calls (a subagent can invoke Skill itself)
  for (const [skill, count] of Object.entries(sub.skillCalls || {})) {
    parent.skillCalls[skill] = (parent.skillCalls[skill] || 0) + count;
  }

  // Merge bash command tracking
  parent.totalBashCalls += sub.totalBashCalls;
  parent.verificationBashCalls += sub.verificationBashCalls;
  parent.readOnlyBashCalls += sub.readOnlyBashCalls;
  parent.bashCommands.push(...sub.bashCommands);

  // Merge daily usage
  if (sub.dailyUsage) {
    if (!parent.dailyUsage) parent.dailyUsage = {};
    for (const [dateStr, dayData] of Object.entries(sub.dailyUsage)) {
      if (!parent.dailyUsage[dateStr]) {
        parent.dailyUsage[dateStr] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0 };
      }
      parent.dailyUsage[dateStr].inputTokens += dayData.inputTokens;
      parent.dailyUsage[dateStr].outputTokens += dayData.outputTokens;
      parent.dailyUsage[dateStr].cacheReadTokens += dayData.cacheReadTokens;
      parent.dailyUsage[dateStr].cacheCreationTokens += dayData.cacheCreationTokens;
      parent.dailyUsage[dateStr].cost += dayData.cost;
      if (dayData.byModel) {
        const target = parent.dailyUsage[dateStr];
        if (!target.byModel) target.byModel = {};
        for (const [model, v] of Object.entries(dayData.byModel)) {
          if (!target.byModel[model]) target.byModel[model] = { tokens: 0, cost: 0 };
          target.byModel[model].tokens += v.tokens;
          target.byModel[model].cost += v.cost;
        }
      }
    }
  }

  // Merge files
  for (const f of sub.filesWritten) {
    if (!parent.filesWritten.includes(f)) parent.filesWritten.push(f);
  }
}

// Walk up from a session's cwd to the enclosing git repo root, so sessions
// launched from a subdirectory still correlate (file paths and git analysis
// must both be relative to the repo root, not the cwd).
function findGitRoot(startPath) {
  let dir = startPath;
  while (dir && dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export async function parseAllProjects(claudeDir, days, projectFilter) {
  if (!existsSync(claudeDir)) {
    return { sessions: [], fileIndex: {} };
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();

  const sessions = [];
  const fileIndex = {};
  const projectFolders = readdirSync(claudeDir).filter(f => {
    if (f.startsWith('.')) return false;
    const fullPath = path.join(claudeDir, f);
    return statSync(fullPath).isDirectory();
  });

  for (const folder of projectFolders) {
    // Apply project filter if specified
    if (projectFilter) {
      const folderLower = folder.toLowerCase();
      if (!folderLower.includes(projectFilter.toLowerCase())) continue;
    }

    const projectDir = path.join(claudeDir, folder);
    const folderProjectName = folder;

    let files;
    try {
      files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = path.basename(file, '.jsonl');

      // Quick filter by mtime. A session counts as recent if EITHER the main
      // transcript or any subagent transcript was touched inside the window —
      // background subagents keep writing after the main conversation stops,
      // and gating on the main file alone would drop their in-window usage.
      let mainMtime;
      try {
        mainMtime = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      const subMtimes = [];
      for (const sf of listSubagentTranscripts(path.join(projectDir, sessionId, 'subagents'))) {
        try {
          subMtimes.push([sf, statSync(sf).mtimeMs]);
        } catch { }
      }
      if (Math.max(mainMtime, ...subMtimes.map(x => x[1])) < cutoffMs) continue;
      fileIndex[filePath] = mainMtime;
      // Track subagent transcript mtimes too, so cache staleness detection
      // catches sessions whose subagent files changed without the main file.
      for (const [sf, m] of subMtimes) fileIndex[sf] = m;

      try {
        const session = await parseSessionWithSubagents(projectDir, sessionId, cutoffMs);

        // Skip empty sessions (no messages)
        if (!session.startTime || (session.userMessageCount === 0 && session.assistantMessageCount === 0)) {
          continue;
        }

        // Keep sessions with ANY activity inside the window (a session started
        // before the window but resumed inside it was parsed with its usage
        // clipped to the window — dropping it whole would lose that usage).
        if (new Date(session.endTime).getTime() < cutoffMs) continue;

        // Derive project name from the session's actual repo path (cwd),
        // falling back to the folder name if repoPath is unavailable
        session.projectName = session.repoPath
          ? path.basename(session.repoPath)
          : folderProjectName;
        sessions.push(session);
      } catch (err) {
        process.stderr.write(`Warning: Failed to parse ${filePath}: ${err.message}\n`);
      }
    }
  }

  // Deduplicate sessions by sessionId (same session can appear in
  // multiple project dirs, e.g. main repo vs worktree paths)
  const seen = new Map();
  for (const s of sessions) {
    const id = s.sessionId;
    if (!seen.has(id)) {
      seen.set(id, s);
    } else {
      const existing = seen.get(id);
      const existingMsgs = existing.userMessageCount + existing.assistantMessageCount;
      const newMsgs = s.userMessageCount + s.assistantMessageCount;
      if (newMsgs > existingMsgs) {
        seen.set(id, s);
      }
    }
  }
  const deduped = Array.from(seen.values());

  // Sort by start time descending
  deduped.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return { sessions: deduped, fileIndex };
}

export {
  calculateCost,
  calculateCostBreakdown,
  findGitRoot,
  getModelFamily,
  getPricingTier,
  isReadOnlyCommand,
  isVerificationCommand,
  listSubagentTranscripts,
  PRICING,
  toRelativePath,
};
