#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { blocksJson, buildBlocks, filterRecentBlocks, renderBlocksText } from './blocks.js';
import { DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR, deleteCache, getCodexStaleFiles, getStaleFiles, loadCache, saveCache, saveQuickstats } from './cache.js';
import { parseAllProjects } from './claude-parser.js';
import { parseCodexSessions } from './codex-parser.js';
import { correlateSessions } from './correlator.js';
import { analyzeGitRepo, findNestedGitRepos, getGitUser, resolveMovedRepoPaths } from './git-analyzer.js';
import { serveMcpStdio } from './mcp.js';
import { computeMetrics } from './metrics.js';
import { loadPricingOverlay, overlayInfo } from './pricing.js';
import { renderReportHtml, renderReportMarkdown, renderReportText, reportModel } from './report.js';
import { createServer } from './server.js';
import { installStatusline, runStatusline } from './statusline.js';
import { buildPeriodTable, periodTableJson, renderPeriodTableText } from './tables.js';
import { checkForUpdate } from './update-check.js';

const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

// ── pretty CLI output helpers ──
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const icon = {
  ok: `${c.green}✔${c.reset}`,
  dot: `${c.cyan}◆${c.reset}`,
  arrow: `${c.cyan}▸${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  err: `${c.red}✖${c.reset}`,
};
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
// Progress/banner output. main() reroutes this to stderr under --json so
// stdout carries only the JSON document.
let progress = console.log;

// Bucket a session's absolute filesWritten paths across a set of nested
// sub-repos. Returns Map<subRepo, string[]> of RELATIVE paths per sub-repo.
// A file that lives directly in the workspace parent (outside any sub-repo)
// is dropped from every clone — nothing to correlate against.
function bucketFilesBySubRepo(filesAbs, subRepos) {
  const buckets = new Map(subRepos.map(s => [s, []]));
  for (const abs of filesAbs || []) {
    let best = null;
    for (const sub of subRepos) {
      const prefix = sub.endsWith(path.sep) ? sub : sub + path.sep;
      if (abs.startsWith(prefix)) {
        if (!best || sub.length > best.length) best = sub;
      }
    }
    if (best) buckets.get(best).push(abs.slice(best.length + 1));
  }
  return buckets;
}

// Fields zeroed on non-winner clones so total session spend/tokens is
// conserved after explosion. The clones still carry filesWritten + repoPath +
// timestamps so commit correlation works — they just don't double-count cost.
function zeroedMetricsFields() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    webSearchRequests: 0,
    cost: { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, serverToolCost: 0, totalCost: 0 },
    cacheSavingsDollars: 0,
    estimatedCost: 0,
    modelBreakdown: {},
    usageEvents: [],
    dailyUsage: {},
    toolCalls: {},
    skillCalls: {},
    userMessageCount: 0,
    assistantMessageCount: 0,
    totalBashCalls: 0,
    readOnlyBashCalls: 0,
    subagentTranscriptCount: 0,
    bashCommands: [],
  };
}

// How many levels to walk into a workspace-parent cwd looking for nested git
// repos. Fixed rather than user-configurable — zero-config, like the rest of
// the pipeline's discovery — since the walk only ever runs for sessions whose
// cwd itself has no `.git` (an ordinary single-repo session is untouched), and
// the skip-list in findNestedGitRepos already bounds it away from noise/perf
// traps (node_modules, build output, venvs, symlink cycles).
const NESTED_REPO_DEPTH = 3;

// Split any session whose cwd is a workspace parent (not a git repo itself,
// but containing nested repos within NESTED_REPO_DEPTH levels) into
// per-sub-repo virtual sessions. Full session cost is assigned to the
// sub-repo with the most files; the rest carry files + timestamps only so
// their commits still correlate.
export function explodeWorkspaceSessions(sessions, depth = NESTED_REPO_DEPTH) {
  if (!(depth > 0)) return sessions;
  const out = [];
  for (const session of sessions) {
    if (!session.repoPath || !session.filesWrittenAbsolute?.length) {
      out.push(session);
      continue;
    }
    if (existsSync(path.join(session.repoPath, '.git'))) {
      out.push(session);
      continue;
    }
    const nested = findNestedGitRepos(session.repoPath, depth);
    if (nested.length === 0) {
      out.push(session);
      continue;
    }
    const buckets = bucketFilesBySubRepo(session.filesWrittenAbsolute, nested);
    const populated = nested
      .filter(sub => buckets.get(sub).length > 0)
      .sort((a, b) => buckets.get(b).length - buckets.get(a).length);
    if (populated.length === 0) {
      out.push(session);
      continue;
    }
    let first = true;
    for (const subRepo of populated) {
      const files = buckets.get(subRepo);
      const suffix = path.basename(subRepo);
      const clone = first
        ? { ...session }
        // costZeroed marks this clone's cost/tokens as a conservation artifact,
        // not a real outcome — computeSessionGrade (metrics.js) must not grade
        // it, or a real commit landing on a $0 clone reads as a fabricated 'A'.
        : { ...session, ...zeroedMetricsFields(), costZeroed: true };
      clone.sessionId = `${session.sessionId}#${suffix}`;
      clone.repoPath = subRepo;
      clone.projectName = suffix;
      clone.filesWritten = files;
      out.push(clone);
      first = false;
    }
  }
  return out;
}

async function buildPayload(claudeDir, codexDir, days, project, forceRefresh = false, planConfigs = {}, sourceFilter = null, offline = false) {
  // Step 0: Load the external pricing overlay before any costing happens, so
  // models the hardcoded tables don't know get a real published rate instead of
  // the Sonnet estimate. Cached to disk (~24h TTL); --refresh forces a refetch,
  // --offline stays on the cache. Never throws — falls back to hardcoded pricing.
  await loadPricingOverlay({ offline, refresh: forceRefresh });
  const ov = overlayInfo();
  if (ov.source === 'network') progress(`  ${icon.ok} Pricing refreshed ${c.dim}── ${ov.models} models from LiteLLM${c.reset}`);

  // Step 1: Parse sessions from every agent source (with caching)
  const startParse = Date.now();
  // Same cutoff computation as the parsers, so the cache staleness scan and
  // the parsers agree on which files are inside the lookback window.
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffMs = cutoffDate.getTime();
  // cutoffDay keys the cache to the day it was built: sessions are clipped to
  // the rolling window at parse time, so yesterday's cache would serve
  // yesterday's clipping. Costs one full re-parse per day.
  const cacheOptions = { days, project: project || null, claudeDir, codexDir, cutoffDay: cutoffDate.toDateString() };

  if (forceRefresh) {
    deleteCache(cacheOptions);
    progress(`  ${icon.arrow} Cache cleared, performing full parse...`);
  }

  const cached = forceRefresh ? null : loadCache(cacheOptions);
  const inWindow = (s) => new Date(s.endTime || s.startTime).getTime() >= cutoffMs;

  // Each source keeps its own file index and staleness scan, so a fresh Codex
  // rollout doesn't force a full Claude re-parse (and vice versa) — the
  // unchanged side is served straight from the cache.
  let claudeSessions = null;
  let claudeIndex = null;
  let codexSessions = null;
  let codexIndex = null;
  const parseNotes = [];

  if (cached) {
    const stale = getStaleFiles(claudeDir, cached.fileIndex, cutoffMs, project);
    if (stale.newFiles.length === 0 && stale.modifiedFiles.length === 0 && stale.deletedFiles.length === 0) {
      // Re-apply the window filter (same rule as the parser: keep sessions with
      // any activity in the window). The cutoffDay cache key means this cache
      // was built today, so per-session clipping is already current.
      claudeSessions = cached.sessions.filter(s => (s.source || 'claude') === 'claude' && inWindow(s));
      claudeIndex = cached.fileIndex;
      parseNotes.push(`claude: ${claudeSessions.length} cached`);
    } else {
      parseNotes.push(`claude: ${stale.newFiles.length} new, ${stale.modifiedFiles.length} updated, ${stale.deletedFiles.length} deleted`);
    }
    const staleCodex = getCodexStaleFiles(codexDir, cached.codexFileIndex || {}, cutoffMs);
    if (staleCodex.newFiles.length === 0 && staleCodex.modifiedFiles.length === 0 && staleCodex.deletedFiles.length === 0) {
      codexSessions = cached.sessions.filter(s => s.source === 'codex' && inWindow(s));
      codexIndex = cached.codexFileIndex || {};
      parseNotes.push(`codex: ${codexSessions.length} cached`);
    } else {
      parseNotes.push(`codex: ${staleCodex.newFiles.length} new, ${staleCodex.modifiedFiles.length} updated, ${staleCodex.deletedFiles.length} deleted`);
    }
  }

  if (!claudeSessions) {
    const result = await parseAllProjects(claudeDir, days, project);
    claudeSessions = result.sessions;
    claudeIndex = result.fileIndex;
    if (!cached) parseNotes.push(`claude: ${claudeSessions.length} parsed`);
  }
  if (!codexSessions) {
    const result = await parseCodexSessions(codexDir, days, project);
    codexSessions = result.sessions;
    codexIndex = result.fileIndex;
    if (!cached) parseNotes.push(`codex: ${codexSessions.length} parsed`);
  }

  const rawParsed = [...claudeSessions, ...codexSessions];
  progress(`  ${icon.ok} Parsing sessions ${c.dim}── ${parseNotes.join(' · ')} (${fmt(Date.now() - startParse)})${c.reset}`);

  // Save the cache as soon as parsing is done — even if the run then bails
  // (e.g. a --source filter that matches nothing), the parse work is kept.
  saveCache(rawParsed, claudeIndex, codexIndex, cacheOptions);

  // When a session's cwd is a WORKSPACE PARENT of git repos (not a repo
  // itself), split it into per-sub-repo virtual sessions so nested repos are
  // actually correlated. Always on (see NESTED_REPO_DEPTH) — a no-op for the
  // common case of a session whose cwd is itself a repo. Runs post-cache so
  // the raw parse is preserved.
  const allParsed = explodeWorkspaceSessions(rawParsed);
  const addedByExplosion = allParsed.length - rawParsed.length;
  if (addedByExplosion > 0) {
    progress(`  ${icon.ok} Nested repos ${c.dim}── expanded ${addedByExplosion} workspace session${addedByExplosion === 1 ? '' : 's'} into sub-repo sessions${c.reset}`);
  }

  // Optional --source filter: analyze a single agent's sessions only. The cache
  // still stores everything parsed, so switching sources doesn't re-parse.
  const sessions = sourceFilter
    ? allParsed.filter(s => (s.source || 'claude') === sourceFilter)
    : allParsed;

  if (sessions.length === 0) {
    return null;
  }

  // Step 2: Analyze git repos
  const startGit = Date.now();
  const repoPathsSet = new Set(sessions.map(s => s.repoPath).filter(Boolean));
  // Resolve against every parsed session's repoPath, not just this view's
  // (source-filtered) subset — under --source codex there may be no valid
  // codex repoPath left to alias to, but a Claude session for the same repo
  // (parsed in the same run) usually still has the current, correct path.
  const allRepoPaths = new Set(allParsed.map(s => s.repoPath).filter(Boolean));
  const { aliasMap, unresolved } = resolveMovedRepoPaths([...allRepoPaths], allParsed);
  const analysisCache = {};
  const commitsByRepo = {};
  for (const repoPath of repoPathsSet) {
    const analysisPath = aliasMap.get(repoPath) || repoPath;
    if (!(analysisPath in analysisCache)) {
      analysisCache[analysisPath] = analyzeGitRepo(analysisPath, days);
    }
    commitsByRepo[repoPath] = analysisCache[analysisPath];
  }
  progress(`  ${icon.ok} Analyzing git repos ${c.dim}── ${repoPathsSet.size} repos (${fmt(Date.now() - startGit)})${c.reset}`);
  const resolvedInView = [...repoPathsSet].filter(p => aliasMap.has(p));
  const unresolvedInView = unresolved.filter(p => repoPathsSet.has(p));
  if (resolvedInView.length > 0) {
    progress(`  ${icon.ok} Resolved ${resolvedInView.length} moved repo path(s) by folder name ${c.dim}(sessions recorded a path that no longer exists)${c.reset}`);
  }
  if (unresolvedInView.length > 0) {
    progress(`  ${icon.warn} ${c.yellow}${unresolvedInView.length} repo path(s) no longer exist and couldn't be auto-resolved — their sessions won't show commits:${c.reset} ${unresolvedInView.join(', ')}`);
  }

  // Step 3: Correlate sessions with commits. All sources correlate together so
  // a commit is claimed by at most ONE session across agents — per-source views
  // then filter the correlated set, never re-attribute.
  const { correlatedSessions, organicCommits } = correlateSessions(sessions, commitsByRepo, cutoffMs);
  progress(`  ${icon.ok} Correlating sessions ${c.dim}── done${c.reset}`);

  // Step 4: Compute metrics — one payload over everything, plus a per-agent
  // view when more than one agent has sessions (drives the dashboard tabs).
  const gitUser = getGitUser();
  const sourceCounts = {
    claude: correlatedSessions.filter(s => (s.source || 'claude') === 'claude').length,
    codex: correlatedSessions.filter(s => s.source === 'codex').length,
  };
  // Dominant plan tier the Codex rollouts self-report (rate_limits.plan_type)
  // — a hint the dashboard can surface next to --codex-plan. Computed over all
  // parsed codex sessions so it's stable across views and --source filters.
  const planTypeCounts = new Map();
  for (const s of codexSessions) {
    if (s.codexPlanType) planTypeCounts.set(s.codexPlanType, (planTypeCounts.get(s.codexPlanType) || 0) + 1);
  }
  let codexPlanDetected = null;
  for (const [planType, count] of planTypeCounts) {
    if (codexPlanDetected === null || count > planTypeCounts.get(codexPlanDetected)) codexPlanDetected = planType;
  }
  // organicCommits passed to a view must be "every in-window commit this view's
  // sessions did NOT claim", so reconciliation.commits.aiMatched + organic
  // always equals the window's commit count (the audit the attribution panel
  // promises). For the combined view that's the joint organic set; for a
  // per-agent view it also includes commits the OTHER agent claimed — from this
  // agent's ROI perspective those are code it didn't write.
  const mkView = (subset, planConfig, sourceName, viewOrganic, otherAgentClaimed = 0) => {
    const p = computeMetrics(subset, viewOrganic, commitsByRepo, days, planConfig);
    p.meta.source = sourceName;
    p.meta.sources = sourceCounts;
    p.meta.gitUser = gitUser;
    p.meta.codexPlanDetected = codexPlanDetected;
    // Per-agent views fold the OTHER agent's AI-claimed commits into their
    // organic set (see viewOrganic above) — expose the folded count so the
    // dashboard can label those commits as the other agent's, not manual.
    p.meta.otherAgentClaimedCommits = otherAgentClaimed;
    return p;
  };

  // Distinct commits claimed by sessions matching a predicate (dedup by hash —
  // correlation assigns each commit to one session, but guard anyway).
  const commitsClaimedBy = (pred) => {
    const seen = new Set();
    const out = [];
    for (const s of correlatedSessions) {
      if (!pred(s)) continue;
      for (const commit of (s.commits || [])) {
        if (!seen.has(commit.hash)) { seen.add(commit.hash); out.push(commit); }
      }
    }
    return out;
  };

  // The combined view's plan is the sum of the flat fees for the agents that
  // actually have sessions. If any active agent lacks a plan, a combined
  // utilization would divide multi-agent spend by a fee covering only part of
  // it — so omit the plan on the combined view (each per-agent tab still shows
  // its own). Under --source the view holds one agent, so only its plan applies.
  const activeAgents = ['claude', 'codex'].filter(a => sourceCounts[a] > 0);
  const activePlans = activeAgents.map(a => planConfigs[a]);
  const combinedPlan = sourceFilter
    ? planConfigs[sourceFilter] || null
    : activePlans.length === 0 || activePlans.some(p => !p) ? null
    : activePlans.length === 1 ? activePlans[0]
    : { name: 'combined', monthlyCost: activePlans.reduce((s, p) => s + p.monthlyCost, 0) };

  const payloads = { all: mkView(correlatedSessions, combinedPlan, sourceFilter || 'all', organicCommits) };
  if (sourceCounts.claude > 0 && sourceCounts.codex > 0) {
    const isClaude = s => (s.source || 'claude') === 'claude';
    // Flag the folded copies (shallow clones — the originals are shared with
    // the other view's matched set) so metrics can tell "no session claimed
    // this commit" from "the OTHER agent's session claimed it" — a
    // trailer-stamped commit of the second kind must not be reported as
    // missing session logs.
    const claimedByOther = (c) => ({ ...c, claimedByOtherAgent: true });
    const codexClaimed = commitsClaimedBy(s => s.source === 'codex').map(claimedByOther);
    const claudeClaimed = commitsClaimedBy(isClaude).map(claimedByOther);
    payloads.claude = mkView(correlatedSessions.filter(isClaude), planConfigs.claude, 'claude', [...organicCommits, ...codexClaimed], codexClaimed.length);
    payloads.codex = mkView(correlatedSessions.filter(s => s.source === 'codex'), planConfigs.codex, 'codex', [...organicCommits, ...claudeClaimed], claudeClaimed.length);
  }

  return payloads;
}

// Analysis flags shared by the dashboard (default) command and `report`.
const addAnalysisOptions = (cmd) => cmd
  .option('-d, --days <number>', 'number of days to look back', '30')
  .option('--project <name>', 'filter to specific project')
  .option('--refresh', 'force full re-parse, ignore cache')
  .option('--claude-dir <path>', 'override path to Claude Code projects directory (for testing/CI)')
  .option('--codex-dir <path>', 'override path to OpenAI Codex sessions directory (for testing/CI)')
  .option('--source <agent>', 'analyze a single agent only: claude | codex | all')
  .option('--offline', 'skip the network pricing refresh; use cached/hardcoded pricing only')
  .option('--plan <tier>', 'Claude subscription mode — effective $/commit vs your flat plan: pro | max5 | max20')
  .option('--plan-cost <amount>', 'custom Claude monthly subscription cost in USD (overrides --plan)')
  .option('--codex-plan <tier>', 'Codex/ChatGPT subscription mode: free | go | plus | pro100 | pro | team | business | business-annual')
  .option('--codex-plan-cost <amount>', 'custom Codex monthly subscription cost in USD (overrides --codex-plan)');

// Validate the shared flags, run the full pipeline, and handle the byproducts
// every command shares (invokedAs stamping, statusline quickstats). Returns
// everything the calling command needs to render or serve.
async function runAnalysis(opts) {
  const days = parseInt(opts.days, 10);
  // Validate before any work: a bad --days would otherwise clobber the cache
  // with days:NaN and die later with a cryptic "Invalid time value".
  if (!/^\d+$/.test(String(opts.days)) || days < 1) {
    console.error(`  ${icon.err} ${c.red}--days must be a positive integer, got "${opts.days}".${c.reset}`);
    process.exit(1);
  }

  // Optional subscription "effective cost" mode, per agent.
  // Monthly USD: Anthropic plans / OpenAI ChatGPT plans (Codex is included in
  // ChatGPT Plus, Pro, Business, Enterprise and Edu — no Codex-only tier).
  const parsePlan = (planOpt, planCostOpt, tiers, flagName, namePrefix) => {
    if (planCostOpt !== undefined) {
      const custom = parseFloat(planCostOpt);
      if (Number.isFinite(custom) && custom > 0) {
        return { name: 'custom', monthlyCost: custom };
      }
      console.error(`  ${icon.err} ${c.red}${flagName}-cost must be a positive number.${c.reset}`);
      process.exit(1);
    }
    if (!planOpt) return null;
    const key = String(planOpt).toLowerCase();
    if (Object.hasOwn(tiers, key)) {
      return { name: namePrefix + key, monthlyCost: tiers[key] };
    }
    console.error(`  ${icon.err} ${c.red}Unknown ${flagName} "${planOpt}".${c.reset} Use ${Object.keys(tiers).join(', ')}, or ${flagName}-cost <amount>.`);
    process.exit(1);
  };
  // ChatGPT tiers (Codex is included in the plan): Free $0, Go $8, Plus $20,
  // Pro starts at $100 (5x) with a $200 20x tier, and Business is $20/seat/mo
  // annually or $25/seat/mo monthly. `team` is what real rollouts report in
  // rate_limits.plan_type for business seats — priced as the monthly tier.
  const planConfigs = {
    claude: parsePlan(opts.plan, opts.planCost, { pro: 20, max5: 100, max20: 200 }, '--plan', ''),
    codex: parsePlan(opts.codexPlan, opts.codexPlanCost, { free: 0, go: 8, plus: 20, pro100: 100, pro: 200, team: 25, business: 25, 'business-annual': 20 }, '--codex-plan', 'codex-'),
  };

  // `all` is the no-filter default — the name every API route and doc uses.
  let sourceFilter = opts.source ? String(opts.source).toLowerCase() : null;
  if (sourceFilter === 'all') sourceFilter = null;
  if (sourceFilter && sourceFilter !== 'claude' && sourceFilter !== 'codex') {
    console.error(`  ${icon.err} ${c.red}Unknown --source "${opts.source}".${c.reset} Use claude, codex, or all.`);
    process.exit(1);
  }

  // Defaults live in cache.js so custom-dir runs get their own cache file.
  // Codex CLI stores rollout files under $CODEX_HOME/sessions (~/.codex by default).
  const claudeDir = opts.claudeDir ? path.resolve(opts.claudeDir) : DEFAULT_CLAUDE_DIR;
  const codexDir = opts.codexDir ? path.resolve(opts.codexDir) : DEFAULT_CODEX_DIR;
  // An explicit override pointing nowhere is almost certainly a typo — but the
  // other agent's default dir may still hold sessions, so warn without exiting.
  if (opts.claudeDir && !existsSync(claudeDir)) {
    console.error(`  ${icon.warn} ${c.yellow}--claude-dir does not exist:${c.reset} ${claudeDir}`);
  }
  if (opts.codexDir && !existsSync(codexDir)) {
    console.error(`  ${icon.warn} ${c.yellow}--codex-dir does not exist:${c.reset} ${codexDir}`);
  }

  const payloads = await buildPayload(claudeDir, codexDir, days, opts.project, opts.refresh, planConfigs, sourceFilter, !!opts.offline);
  if (payloads) {
    const invokedAs = path.basename(process.argv[1]);
    for (const p of Object.values(payloads)) {
      p.meta.invokedAs = invokedAs.includes('claude-roi') ? 'claude-roi' : 'codelens-ai';
    }
    // Refresh the statusline's fast-path stats — but only from unfiltered
    // default-dir runs: a --source/--project run computes a partial view whose
    // numbers must not masquerade as global "today" stats, and custom-dir
    // (test/CI) runs are skipped inside saveQuickstats.
    if (!sourceFilter && !opts.project) {
      const today = payloads.all.summary.costByPeriod?.today;
      const now = new Date();
      // Snapshot the open 5-hour block so the statusline can show a live burn
      // rate without parsing. The block's endTime bounds staleness: the
      // statusline hides it once now passes endTime (i.e. after ≤5h).
      const { activeBlock } = buildBlocks(payloads.all.sessions);
      const blockSnapshot = activeBlock ? {
        endTime: activeBlock.endTime,
        cost: activeBlock.cost,
        totalTokens: activeBlock.totalTokens,
        tokensPerMinute: activeBlock.burnRate ? Math.round(activeBlock.burnRate.tokensPerMinute) : null,
        tokensPerMinuteIndicator: activeBlock.burnRate ? Math.round(activeBlock.burnRate.tokensPerMinuteIndicator) : null,
        costPerHour: activeBlock.burnRate ? activeBlock.burnRate.costPerHour : null,
      } : null;
      saveQuickstats({
        day: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
        generatedAt: now.toISOString(),
        todayCost: today?.cost ?? 0,
        todayCommits: today?.commits ?? 0,
        grade: payloads.all.summary.overallGrade,
        activeBlock: blockSnapshot,
      }, { claudeDir, codexDir });
    }
  }
  return { payloads, days, claudeDir, codexDir, planConfigs, sourceFilter };
}

// The deprecation nudge for the legacy claude-roi alias plus the version line.
function printBanner(commandLabel = '') {
  const invokedAs = path.basename(process.argv[1]);
  if (invokedAs.includes('claude-roi')) {
    progress(`  ${icon.warn} ${c.yellow}claude-roi has been renamed to codelens-ai${c.reset}`);
    progress(`    Switch to: ${c.cyan}npx codelens-ai${c.reset}\n`);
  }
  progress(`${icon.dot} ${c.bold}${c.cyan}codelens-ai${commandLabel}${c.reset} v${VERSION}\n`);
}

function printNoSessions(sourceFilter, days, claudeDir, codexDir) {
  if (sourceFilter) {
    progress(`  ${icon.warn} ${c.yellow}No ${sourceFilter} sessions found in the last ${days} days.${c.reset}`);
    progress(`    Drop --source to analyze every agent, or check ${sourceFilter === 'claude' ? claudeDir : codexDir}`);
  } else {
    progress(`  ${icon.warn} ${c.yellow}No AI coding agent sessions found.${c.reset}`);
    progress(`    Claude Code sessions are read from ${claudeDir} and OpenAI Codex sessions from ${codexDir}`);
  }
}

async function runDashboard(opts) {
  if (opts.json) progress = console.error;
  const port = parseInt(opts.port, 10);
  if (!/^\d+$/.test(String(opts.port)) || port < 1 || port > 65535) {
    console.error(`  ${icon.err} ${c.red}--port must be an integer between 1 and 65535, got "${opts.port}".${c.reset}`);
    process.exit(1);
  }
  printBanner();

  const { payloads, days, claudeDir, codexDir, planConfigs, sourceFilter } = await runAnalysis(opts);

  if (!payloads) {
    printNoSessions(sourceFilter, days, claudeDir, codexDir);
    if (opts.json) {
      // Still emit a parseable document: the warning went to stderr above.
      process.stdout.write('null', () => process.exit(0));
      return;
    }
    process.exit(0);
  }
  const payload = payloads.all;

  // Output
  if (opts.json) {
    // stdout to a pipe is async — exiting inside write()'s same tick would
    // truncate everything past the 64KB pipe buffer. Exit only once flushed.
    process.stdout.write(JSON.stringify(payload, null, 2), () => process.exit(0));
    return;
  }

  // Start server — pass a rebuild function so /api/refresh can re-run the pipeline
  const rebuild = async () => {
    const fresh = await buildPayload(claudeDir, codexDir, days, opts.project, true, planConfigs, sourceFilter, !!opts.offline);
    if (fresh) {
      for (const p of Object.values(fresh)) p.meta.invokedAs = payload.meta.invokedAs;
    }
    return fresh;
  };
  const app = createServer(payloads, rebuild);
  // Bind localhost by default: the dashboard exposes repo paths, commit
  // messages, and per-session costs — "all data stays local" must include the
  // LAN. --host 0.0.0.0 opts in to network exposure explicitly.
  const host = opts.host || '127.0.0.1';
  const server = app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`;
    console.log(`\n  ${icon.ok} ${c.green}Dashboard:${c.reset} ${c.bold}${url}${c.reset}`);
    if (host === '0.0.0.0' || host === '::') {
      console.log(`  ${icon.warn} ${c.yellow}Serving on all interfaces — anyone on your network can open this dashboard.${c.reset}`);
    }

    if (opts.open !== false) {
      import('open').then(mod => mod.default(url)).catch(() => {
        console.log('Could not auto-open browser. Visit the URL above.');
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`  ${icon.err} ${c.red}Port ${port} is already in use.${c.reset} Try: codelens-ai --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });
}

async function runReport(opts) {
  // Progress goes to stderr so `codelens-ai report > roi.txt` captures only
  // the report itself.
  progress = console.error;
  printBanner(' report');

  const { payloads, days, claudeDir, codexDir, sourceFilter } = await runAnalysis(opts);
  if (!payloads) {
    printNoSessions(sourceFilter, days, claudeDir, codexDir);
    process.exit(0);
  }

  const model = reportModel(payloads.all, payloads);
  const wrote = [];
  if (opts.md !== undefined) {
    const mdPath = typeof opts.md === 'string' ? opts.md : 'codelens-report.md';
    writeFileSync(mdPath, renderReportMarkdown(model));
    wrote.push(mdPath);
  }
  if (opts.html !== undefined) {
    const htmlPath = typeof opts.html === 'string' ? opts.html : 'codelens-report.html';
    writeFileSync(htmlPath, renderReportHtml(model));
    wrote.push(htmlPath);
  }
  if (wrote.length > 0) {
    for (const f of wrote) progress(`  ${icon.ok} ${c.green}Report written:${c.reset} ${path.resolve(f)}`);
    process.exit(0);
  }
  // Same flush-before-exit as --json: exit only once stdout has drained.
  process.stdout.write(`${renderReportText(model)}\n`, () => process.exit(0));
}

// `codelens-ai daily|weekly|monthly` — ccusage-style usage tables over the
// same analyzed window, with the ROI columns (commits, $/commit) on top.
async function runTable(period, opts) {
  // Progress to stderr so `codelens-ai daily --json | jq` gets clean stdout.
  progress = console.error;
  printBanner(` ${period}`);

  if (period === 'weekly' && opts.startOfWeek !== 'monday' && opts.startOfWeek !== 'sunday') {
    console.error(`  ${icon.err} ${c.red}--start-of-week must be monday or sunday, got "${opts.startOfWeek}".${c.reset}`);
    process.exit(1);
  }

  const { payloads, days, claudeDir, codexDir, sourceFilter } = await runAnalysis(opts);
  if (!payloads) {
    printNoSessions(sourceFilter, days, claudeDir, codexDir);
    if (opts.json) {
      process.stdout.write('null', () => process.exit(0));
      return;
    }
    process.exit(0);
  }

  const payload = payloads.all;
  // Same cutoff the pipeline used — clamps fallback days for sessions that
  // started before the window (mirrors the metrics daily timeline).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const table = buildPeriodTable(payload.sessions, {
    period,
    startOfWeek: opts.startOfWeek,
    cutoffMs: cutoff.getTime(),
  });

  if (opts.json) {
    const doc = periodTableJson(table, { source: payload.meta.source, daysAnalyzed: days });
    process.stdout.write(JSON.stringify(doc, null, 2), () => process.exit(0));
    return;
  }
  const src = payload.meta.source !== 'all' ? `, ${payload.meta.source} only` : '';
  const title = `\n  ${c.bold}${c.cyan}Usage by ${period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month'}${c.reset} ${c.dim}· last ${days} days${src}${c.reset}\n`;
  process.stdout.write(`${title}\n${renderPeriodTableText(table, { breakdown: opts.breakdown })}\n\n`, () => process.exit(0));
}

// `codelens-ai blocks` — group usage into Claude's rolling 5-hour billing
// windows, with burn rate and a projection for the open block.
async function runBlocks(opts) {
  progress = console.error;
  printBanner(' blocks');

  // --session-length: window length in hours (default 5).
  const sessionHours = opts.sessionLength !== undefined ? parseFloat(opts.sessionLength) : 5;
  if (!(sessionHours > 0)) {
    console.error(`  ${icon.err} ${c.red}--session-length must be a positive number of hours.${c.reset}`);
    process.exit(1);
  }
  // --token-limit: a number, or the literal "max" (largest prior block).
  let tokenLimit = null;
  if (opts.tokenLimit !== undefined) {
    tokenLimit = String(opts.tokenLimit).toLowerCase() === 'max' ? 'max' : parseInt(opts.tokenLimit, 10);
    if (tokenLimit !== 'max' && !(Number.isFinite(tokenLimit) && tokenLimit > 0)) {
      console.error(`  ${icon.err} ${c.red}--token-limit must be a positive integer or "max".${c.reset}`);
      process.exit(1);
    }
  }

  const { payloads, days, claudeDir, codexDir, sourceFilter } = await runAnalysis(opts);
  if (!payloads) {
    printNoSessions(sourceFilter, days, claudeDir, codexDir);
    if (opts.json) {
      process.stdout.write('null', () => process.exit(0));
      return;
    }
    process.exit(0);
  }

  const payload = payloads.all;
  let result = buildBlocks(payload.sessions, { sessionHours, tokenLimit });
  if (opts.recent) result = filterRecentBlocks(result, 3);

  if (opts.json) {
    const doc = blocksJson(result, { source: payload.meta.source, daysAnalyzed: days });
    process.stdout.write(JSON.stringify(doc, null, 2), () => process.exit(0));
    return;
  }
  const src = payload.meta.source !== 'all' ? `, ${payload.meta.source} only` : '';
  const scope = opts.active ? 'active 5-hour block' : opts.recent ? '5-hour blocks · last 3 days' : `5-hour blocks · last ${days} days`;
  const title = `\n  ${c.bold}${c.cyan}Billing blocks${c.reset} ${c.dim}· ${scope}${src}${c.reset}\n`;
  process.stdout.write(`${title}${renderBlocksText(result, { active: opts.active })}\n\n`, () => process.exit(0));
}

// `codelens-ai mcp` — serve the reports as MCP tools over stdio, for MCP
// clients like Claude Code (`claude mcp add codelens -- npx -y codelens-ai mcp`).
async function runMcp(opts) {
  // Stdout carries ONLY JSON-RPC frames — a single stray console.log corrupts
  // the transport — so every bit of progress/banner output goes to stderr.
  progress = console.error;
  printBanner(' mcp');

  // Start analysis and connect the transport concurrently. MCP clients can
  // complete initialize/tools-list immediately even when parsing a large local
  // history takes a while; tool calls wait on this shared load. Unlike a
  // one-shot CLI command, an analysis failure must not take this long-lived
  // server down with it — `load` captures it instead of rethrowing, so tool
  // calls report a clear error and `refresh` still gets a chance to recover.
  let payloads = null;
  let lastError = null;
  const load = (forceRefresh) => runAnalysis(forceRefresh ? { ...opts, refresh: true } : opts)
    .then((result) => {
      payloads = result.payloads;
      lastError = null;
      return result;
    })
    .catch((error) => {
      lastError = error;
      return null;
    });
  const initialLoad = load();
  const ctx = {
    days: parseInt(opts.days, 10),
    ready: () => initialLoad,
    getPayloads: () => payloads,
    getError: () => lastError?.message,
    refresh: async () => {
      // Clearing all source logs is a real state transition: do not keep
      // serving the pre-refresh snapshot after reporting that nothing remains.
      await load(true);
      return payloads;
    },
  };
  await serveMcpStdio(ctx, VERSION);

  const initial = await initialLoad;
  if (!payloads) {
    if (lastError) {
      progress(`  ${icon.err} ${c.red}Initial analysis failed:${c.reset} ${lastError.message}`);
    } else {
      // Still serve: an MCP client has already spawned us, so exiting here reads
      // as a broken server. Tools answer with a clear "no sessions" message.
      printNoSessions(initial.sourceFilter, initial.days, initial.claudeDir, initial.codexDir);
    }
  }
  progress(`  ${icon.ok} ${c.green}MCP server ready${c.reset} ${c.dim}── ${payloads ? payloads.all.sessions.length : 0} sessions loaded, serving on stdio${c.reset}`);
}

async function main() {
  // A stale global install or npx cache runs old code with none of the
  // current subcommands — which fails with a cryptic Commander parse error
  // instead of a hint to upgrade. Cached to disk (~24h TTL) so this is a
  // registry hit at most once a day; capped at 400ms so a slow/broken network
  // never meaningfully delays a real command, and --offline skips it outright.
  const update = await Promise.race([
    checkForUpdate({ currentVersion: VERSION, offline: process.argv.includes('--offline') }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 400)),
  ]);
  if (update) {
    console.error(`  ${icon.warn} ${c.yellow}Update available:${c.reset} v${update.current} → v${update.latest} ${c.dim}── npx codelens-ai@latest, or: npm install -g codelens-ai@latest${c.reset}\n`);
  }

  const program = new Command();
  program
    .name('codelens-ai')
    .description('Correlate AI coding agent token usage with git output to measure ROI')
    .version(VERSION)
    // Options after a subcommand name belong to that subcommand — without
    // this, the parent's identically-named analysis flags (--days, --source,
    // ...) swallow the values and `report`/`statusline` see only defaults.
    .enablePositionalOptions()
    .option('-p, --port <number>', 'port to serve dashboard', '3457')
    .option('--host <address>', 'interface to bind the dashboard to (0.0.0.0 exposes it to your network)', '127.0.0.1')
    .option('--no-open', 'do not auto-open browser')
    .option('--json', 'output raw JSON to stdout instead of starting server');
  addAnalysisOptions(program);
  program.action(async (opts) => runDashboard(opts));

  const reportCmd = program
    .command('report')
    .description('print an ROI scorecard to the terminal, or export it with --md / --html')
    .option('--md [path]', 'write a Markdown report (default: codelens-report.md)')
    .option('--html [path]', 'write a self-contained HTML report (default: codelens-report.html)');
  addAnalysisOptions(reportCmd);
  reportCmd.action(async (opts) => runReport(opts));

  // The usage tables: `daily`, `weekly`, `monthly`. Shared flags + renderer;
  // weekly additionally takes --start-of-week.
  for (const [name, desc] of [
    ['daily', 'token usage and cost table aggregated by day'],
    ['weekly', 'token usage and cost table aggregated by week'],
    ['monthly', 'token usage and cost table aggregated by month'],
  ]) {
    const cmd = program
      .command(name)
      .description(desc)
      .option('-b, --breakdown', 'nest per-model rows under each period')
      .option('-j, --json', 'output JSON to stdout instead of a table');
    if (name === 'weekly') cmd.option('--start-of-week <day>', 'week boundary: monday | sunday', 'monday');
    addAnalysisOptions(cmd);
    cmd.action(async (opts) => runTable(name, opts));
  }

  // `codelens-ai blocks` — Claude's rolling 5-hour billing windows + burn rate.
  const blocksCmd = program
    .command('blocks')
    .description("group usage into Claude's 5-hour billing windows with burn rate & projection")
    .option('-a, --active', 'show only the current (open) block, in detail')
    .option('-r, --recent', 'show only blocks from the last 3 days')
    .option('--session-length <hours>', 'billing window length in hours', '5')
    .option('-t, --token-limit <n>', 'quota ceiling for the active block: a number, or "max"')
    .option('-j, --json', 'output JSON to stdout instead of a table');
  addAnalysisOptions(blocksCmd);
  blocksCmd.action(async (opts) => runBlocks(opts));

  // `codelens-ai mcp` — MCP server over stdio for Claude Code / Claude Desktop.
  const mcpCmd = program
    .command('mcp')
    .description('serve usage & ROI reports as MCP tools over stdio (add with: claude mcp add codelens -- npx -y codelens-ai mcp)');
  addAnalysisOptions(mcpCmd);
  mcpCmd.action(async (opts) => runMcp(opts));

  // `codelens-ai --days 90 report` places analysis flags on the PARENT (with
  // positional options, they'd otherwise be parsed there and silently ignored
  // while report runs with defaults). Forward parent CLI values into the
  // subcommand before it parses its own flags — its own flags still win.
  const ANALYSIS_SUBCOMMANDS = new Set(['report', 'daily', 'weekly', 'monthly', 'blocks', 'mcp']);
  program.hook('preSubcommand', (thisCommand, subcommand) => {
    if (!ANALYSIS_SUBCOMMANDS.has(subcommand.name())) return;
    for (const key of ['days', 'project', 'refresh', 'claudeDir', 'codexDir', 'source', 'offline', 'plan', 'planCost', 'codexPlan', 'codexPlanCost']) {
      if (thisCommand.getOptionValueSource(key) === 'cli') {
        subcommand.setOptionValueWithSource(key, thisCommand.getOptionValue(key), 'cli');
      }
    }
  });

  program
    .command('statusline')
    .description("Claude Code statusline: session cost, official rate limits, and today's $/commit (reads statusline JSON on stdin)")
    .option('--install', 'configure this statusline in ~/.claude/settings.json (backs up the file first)')
    .option('--force', 'with --install: replace an existing statusline configuration')
    .option('--command <cmd>', 'with --install: the command to configure', 'npx -y codelens-ai statusline')
    .action(async (opts) => {
      if (opts.install) {
        const result = installStatusline({ command: opts.command, force: opts.force });
        console.log(`  ${result.changed ? icon.ok : icon.warn} ${result.message}`);
        if (result.changed) {
          console.log('    Restart Claude Code (or open a new session) to see it.');
          console.log(`    Run ${c.cyan}npx codelens-ai${c.reset} or ${c.cyan}npx codelens-ai report${c.reset} periodically to refresh today's ROI stats.`);
        }
        return;
      }
      await runStatusline();
    });

  await program.parseAsync();
}

main().catch(err => {
  console.error(`  ${icon.err} ${c.red}Error:${c.reset}`, err.message);
  process.exit(1);
});
