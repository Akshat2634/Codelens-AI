import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Pricing per million tokens — from https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache reads = 0.1x base input, Cache writes (5min) = 1.25x base input
const PRICING = {
  // Opus 4.6: $5 input, $25 output
  'opus-46':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.5: $5 input, $25 output
  'opus-45':    { input: 5,     output: 25,    cacheRead: 0.50,   cacheWrite: 6.25   },
  // Opus 4.0 / 4.1 (legacy): $15 input, $75 output
  'opus-old':   { input: 15,    output: 75,    cacheRead: 1.50,   cacheWrite: 18.75  },
  // Sonnet 4.0 / 4.5 / 4.6: $3 input, $15 output
  sonnet:       { input: 3,     output: 15,    cacheRead: 0.30,   cacheWrite: 3.75   },
  // Haiku 4.5: $1 input, $5 output
  'haiku-new':  { input: 1,     output: 5,     cacheRead: 0.10,   cacheWrite: 1.25   },
  // Haiku 3.5: $0.80 input, $4 output
  'haiku-35':   { input: 0.80,  output: 4,     cacheRead: 0.08,   cacheWrite: 1.00   },
  // Haiku 3: $0.25 input, $1.25 output
  'haiku-3':    { input: 0.25,  output: 1.25,  cacheRead: 0.03,   cacheWrite: 0.30   },
};

const PER_MIL = 1_000_000;

function getModelFamily(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

function getPricingTier(modelName) {
  if (!modelName) return null;
  const lower = modelName.toLowerCase();
  // Opus: check most specific version first
  if (lower.includes('opus')) {
    if (lower.includes('4-6') || lower.includes('4.6')) return 'opus-46';
    if (lower.includes('4-5') || lower.includes('4.5')) return 'opus-45';
    return 'opus-old';
  }
  // All Sonnet versions (3.7, 4.0, 4.5, 4.6) share $3/$15 pricing
  if (lower.includes('sonnet')) return 'sonnet';
  // Haiku version detection
  if (lower.includes('haiku')) {
    if (lower.includes('4-5') || lower.includes('4.5') || lower.includes('4-6') || lower.includes('4.6')) return 'haiku-new';
    if (lower.includes('3-5') || lower.includes('3.5')) return 'haiku-35';
    return 'haiku-3'; // Haiku 3 (claude-3-haiku)
  }
  return 'sonnet'; // default unknown models to Sonnet pricing
}

function calculateCost(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName) {
  const tier = getPricingTier(modelName);
  if (!tier) return 0;
  const p = PRICING[tier];
  return (
    (inputTokens * p.input / PER_MIL) +
    (outputTokens * p.output / PER_MIL) +
    (cacheReadTokens * p.cacheRead / PER_MIL) +
    (cacheCreationTokens * p.cacheWrite / PER_MIL)
  );
}

function calculateCostBreakdown(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelName) {
  const tier = getPricingTier(modelName);
  if (!tier) return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0 };
  const p = PRICING[tier];
  const inputCost = inputTokens * p.input / PER_MIL;
  const outputCost = outputTokens * p.output / PER_MIL;
  const cacheReadCost = cacheReadTokens * p.cacheRead / PER_MIL;
  const cacheCreationCost = cacheCreationTokens * p.cacheWrite / PER_MIL;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost,
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
];

// Patterns that identify test/lint/typecheck commands (for autonomy self-heal score)
const VERIFICATION_PATTERNS = [
  // JavaScript/TypeScript
  /\bnpm\s+(test|run\s+(test|lint|check|typecheck|format:check))\b/,
  /\b(pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|typecheck|format:check)\b/,
  /\b(jest|vitest|mocha|ava|cypress|playwright)\s/,
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

function isVerificationCommand(command) {
  if (!command || typeof command !== 'string') return false;
  // Strip cd/path and env var prefixes to get the core command
  const core = command
    .replace(/^(?:cd\s+\S+\s*&&\s*)+/g, '')
    .replace(/^(?:cd\s+\S+\s*;\s*)+/g, '')
    .replace(/^(?:\w+=\S+\s+)+/g, '')
    .trim();
  // Exclude commands that are clearly not verification
  if (NON_VERIFICATION_PATTERNS.some(p => p.test(core))) return false;
  return VERIFICATION_PATTERNS.some(p => p.test(core));
}

function extractToolUse(session, msg) {
  const content = msg.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    const toolName = block.name;
    if (!toolName) continue;

    // Count tool calls
    session.toolCalls[toolName] = (session.toolCalls[toolName] || 0) + 1;

    // Track Bash commands for autonomy self-heal scoring
    if (toolName === 'Bash') {
      const command = block.input?.command || block.input?.content;
      if (command) {
        session.totalBashCalls++;
        const isVerif = isVerificationCommand(command);
        if (isVerif) session.verificationBashCalls++;
        session.bashCommands.push({ command: command.slice(0, 200), isVerification: isVerif });
      }
    }

    // Track files written/read
    const filePath = block.input?.file_path;
    if (!filePath) continue;

    if (toolName === 'Write' || toolName === 'Edit') {
      if (!session.filesWritten.includes(filePath)) {
        session.filesWritten.push(filePath);
      }
    } else if (toolName === 'Read') {
      if (!session.filesRead.includes(filePath)) {
        session.filesRead.push(filePath);
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
    startTime: null,
    endTime: null,
    durationMinutes: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0 },
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
  };
}

async function parseSessionFile(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  const session = createEmptySession(sessionId);
  const seenRequestIds = new Set();
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

      // Count user messages (only actual user content, not tool results)
      const content = obj.message.content;
      if (Array.isArray(content)) {
        const hasUserText = content.some(b => b.type === 'text');
        if (hasUserText) session.userMessageCount++;
      } else if (typeof content === 'string') {
        session.userMessageCount++;
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

    // Accumulate usage only for new requests
    if (isNewRequest || !requestId) {
      const usage = msg.usage;
      if (usage) {
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreate = usage.cache_creation_input_tokens || 0;
        const model = msg.model || 'unknown';

        session.totalInputTokens += input;
        session.totalOutputTokens += output;
        session.cacheReadTokens += cacheRead;
        session.cacheCreationTokens += cacheCreate;

        // Track per-model breakdown
        if (!modelTokens[model]) {
          modelTokens[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        }
        modelTokens[model].input += input;
        modelTokens[model].output += output;
        modelTokens[model].cacheRead += cacheRead;
        modelTokens[model].cacheCreate += cacheCreate;

        // Track per-day per-model tokens for daily usage attribution
        const msgTs = obj.timestamp || lastSeenTimestamp;
        if (msgTs) {
          const dt = new Date(msgTs);
          const dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
          if (!dailyModelTokens[dateStr]) dailyModelTokens[dateStr] = {};
          if (!dailyModelTokens[dateStr][model]) {
            dailyModelTokens[dateStr][model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          }
          dailyModelTokens[dateStr][model].input += input;
          dailyModelTokens[dateStr][model].output += output;
          dailyModelTokens[dateStr][model].cacheRead += cacheRead;
          dailyModelTokens[dateStr][model].cacheCreate += cacheCreate;
        }
      }

      session.assistantMessageCount++;
    }

    // Always extract tool use info (different content blocks can appear in split messages)
    extractToolUse(session, msg);
  }

  // Compute costs from model breakdown
  let maxTokens = 0;
  let primaryModel = null;

  for (const [model, tokens] of Object.entries(modelTokens)) {
    const cost = calculateCost(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model);
    const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    session.modelBreakdown[model] = { tokens: totalTokens, cost };

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
    primaryModel
  );

  // If multiple models used, recalculate cost from per-model breakdown for accuracy
  if (Object.keys(modelTokens).length > 1) {
    let totalCost = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    let cacheCreationCost = 0;

    for (const [model, tokens] of Object.entries(modelTokens)) {
      const breakdown = calculateCostBreakdown(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model);
      inputCost += breakdown.inputCost;
      outputCost += breakdown.outputCost;
      cacheReadCost += breakdown.cacheReadCost;
      cacheCreationCost += breakdown.cacheCreationCost;
      totalCost += breakdown.totalCost;
    }

    session.cost = { inputCost, outputCost, cacheReadCost, cacheCreationCost, totalCost };
  }

  // Compute per-day usage with accurate per-model cost
  session.dailyUsage = {};
  for (const [dateStr, models] of Object.entries(dailyModelTokens)) {
    let dayCost = 0;
    let dayInput = 0, dayOutput = 0, dayCacheRead = 0, dayCacheCreate = 0;
    for (const [model, tokens] of Object.entries(models)) {
      dayCost += calculateCost(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate, model);
      dayInput += tokens.input;
      dayOutput += tokens.output;
      dayCacheRead += tokens.cacheRead;
      dayCacheCreate += tokens.cacheCreate;
    }
    session.dailyUsage[dateStr] = {
      inputTokens: dayInput,
      outputTokens: dayOutput,
      cacheReadTokens: dayCacheRead,
      cacheCreationTokens: dayCacheCreate,
      cost: dayCost,
    };
  }

  // Calculate duration
  if (session.startTime && session.endTime) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    session.durationMinutes = Math.round((end - start) / 60000 * 10) / 10;
  }

  // Normalize filesWritten to relative paths (for file-based commit correlation)
  // Resolve the actual git root from repoPath (which may be a worktree path)
  let gitRoot = session.repoPath;
  if (gitRoot) {
    const wtRootMatch = gitRoot.match(/^(.+?)\/\.claude\/worktrees\/[^/]+$/);
    if (wtRootMatch) gitRoot = wtRootMatch[1];
  }
  if (gitRoot) {
    session.filesWritten = session.filesWritten
      .map(fp => toRelativePath(fp, gitRoot))
      .filter(Boolean);
    session.filesRead = session.filesRead
      .map(fp => toRelativePath(fp, gitRoot))
      .filter(Boolean);
    // Also normalize repoPath to the actual git root
    session.repoPath = gitRoot;
  }

  return session;
}

async function parseSessionWithSubagents(projectDir, sessionId) {
  const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
  const session = await parseSessionFile(mainFile);

  // Check for subagent directory
  const subagentDir = path.join(projectDir, sessionId, 'subagents');
  if (existsSync(subagentDir)) {
    try {
      const agentFiles = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'));
      for (const af of agentFiles) {
        const subSession = await parseSessionFile(path.join(subagentDir, af));
        mergeSubagentIntoSession(session, subSession);
      }
    } catch {
      // Skip if subagent directory is unreadable
    }
  }

  return session;
}

function mergeSubagentIntoSession(parent, sub) {
  parent.totalInputTokens += sub.totalInputTokens;
  parent.totalOutputTokens += sub.totalOutputTokens;
  parent.cacheCreationTokens += sub.cacheCreationTokens;
  parent.cacheReadTokens += sub.cacheReadTokens;

  parent.cost.inputCost += sub.cost.inputCost;
  parent.cost.outputCost += sub.cost.outputCost;
  parent.cost.cacheReadCost += sub.cost.cacheReadCost;
  parent.cost.cacheCreationCost += sub.cost.cacheCreationCost;
  parent.cost.totalCost += sub.cost.totalCost;

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

  // Merge bash command tracking
  parent.totalBashCalls += sub.totalBashCalls;
  parent.verificationBashCalls += sub.verificationBashCalls;
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
    }
  }

  // Merge files
  for (const f of sub.filesWritten) {
    if (!parent.filesWritten.includes(f)) parent.filesWritten.push(f);
  }
  for (const f of sub.filesRead) {
    if (!parent.filesRead.includes(f)) parent.filesRead.push(f);
  }
}

export async function parseAllProjects(claudeDir, days, projectFilter) {
  if (!existsSync(claudeDir)) {
    return [];
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

      // Quick filter by mtime
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoffMs) continue;
        fileIndex[filePath] = stat.mtimeMs;
      } catch {
        continue;
      }

      const sessionId = path.basename(file, '.jsonl');

      try {
        const session = await parseSessionWithSubagents(projectDir, sessionId);

        // Skip empty sessions (no messages)
        if (!session.startTime || (session.userMessageCount === 0 && session.assistantMessageCount === 0)) {
          continue;
        }

        // Apply date filter on session start time
        if (new Date(session.startTime).getTime() < cutoffMs) continue;

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

export { calculateCost, getModelFamily, PRICING };
