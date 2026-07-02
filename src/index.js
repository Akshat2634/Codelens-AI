#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { DEFAULT_CLAUDE_DIR, DEFAULT_CODEX_DIR, deleteCache, getCodexStaleFiles, getStaleFiles, loadCache, saveCache } from './cache.js';
import { parseAllProjects } from './claude-parser.js';
import { parseCodexSessions } from './codex-parser.js';
import { correlateSessions } from './correlator.js';
import { analyzeGitRepo, getGitUser } from './git-analyzer.js';
import { computeMetrics } from './metrics.js';
import { createServer } from './server.js';

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

async function buildPayload(claudeDir, codexDir, days, project, forceRefresh = false, planConfigs = {}, sourceFilter = null) {
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
    console.log(`  ${icon.arrow} Cache cleared, performing full parse...`);
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
      parseNotes.push(`claude: ${stale.newFiles.length} new, ${stale.modifiedFiles.length} updated`);
    }
    const staleCodex = getCodexStaleFiles(codexDir, cached.codexFileIndex || {}, cutoffMs);
    if (staleCodex.newFiles.length === 0 && staleCodex.modifiedFiles.length === 0 && staleCodex.deletedFiles.length === 0) {
      codexSessions = cached.sessions.filter(s => s.source === 'codex' && inWindow(s));
      codexIndex = cached.codexFileIndex || {};
      parseNotes.push(`codex: ${codexSessions.length} cached`);
    } else {
      parseNotes.push(`codex: ${staleCodex.newFiles.length} new, ${staleCodex.modifiedFiles.length} updated`);
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

  const allParsed = [...claudeSessions, ...codexSessions];
  console.log(`  ${icon.ok} Parsing sessions ${c.dim}── ${parseNotes.join(' · ')} (${fmt(Date.now() - startParse)})${c.reset}`);

  // Save the cache as soon as parsing is done — even if the run then bails
  // (e.g. a --source filter that matches nothing), the parse work is kept.
  saveCache(allParsed, claudeIndex, codexIndex, cacheOptions);

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
  const commitsByRepo = {};
  for (const repoPath of repoPathsSet) {
    commitsByRepo[repoPath] = analyzeGitRepo(repoPath, days);
  }
  console.log(`  ${icon.ok} Analyzing git repos ${c.dim}── ${repoPathsSet.size} repos (${fmt(Date.now() - startGit)})${c.reset}`);

  // Step 3: Correlate sessions with commits. All sources correlate together so
  // a commit is claimed by at most ONE session across agents — per-source views
  // then filter the correlated set, never re-attribute.
  const { correlatedSessions, organicCommits } = correlateSessions(sessions, commitsByRepo, cutoffMs);
  console.log(`  ${icon.ok} Correlating sessions ${c.dim}── done${c.reset}`);

  // Step 4: Compute metrics — one payload over everything, plus a per-agent
  // view when more than one agent has sessions (drives the dashboard tabs).
  const gitUser = getGitUser();
  const sourceCounts = {
    claude: correlatedSessions.filter(s => (s.source || 'claude') === 'claude').length,
    codex: correlatedSessions.filter(s => s.source === 'codex').length,
  };
  const mkView = (subset, planConfig, sourceName) => {
    const p = computeMetrics(subset, organicCommits, commitsByRepo, days, planConfig);
    p.meta.source = sourceName;
    p.meta.sources = sourceCounts;
    p.meta.gitUser = gitUser;
    return p;
  };

  // The combined view's plan is the sum of whichever flat fees were supplied —
  // its API-equivalent spend spans both agents. Under --source, the view holds
  // a single agent's sessions, so only that agent's plan applies.
  const activePlans = [planConfigs.claude, planConfigs.codex].filter(Boolean);
  const combinedPlan = sourceFilter
    ? planConfigs[sourceFilter] || null
    : activePlans.length === 0 ? null
    : activePlans.length === 1 ? activePlans[0]
    : { name: 'combined', monthlyCost: activePlans.reduce((s, p) => s + p.monthlyCost, 0) };

  const payloads = { all: mkView(correlatedSessions, combinedPlan, 'all') };
  if (sourceCounts.claude > 0 && sourceCounts.codex > 0) {
    payloads.claude = mkView(correlatedSessions.filter(s => (s.source || 'claude') === 'claude'), planConfigs.claude, 'claude');
    payloads.codex = mkView(correlatedSessions.filter(s => s.source === 'codex'), planConfigs.codex, 'codex');
  }

  return payloads;
}

async function main() {
  const program = new Command();
  program
    .name('codelens-ai')
    .description('Correlate AI coding agent token usage with git output to measure ROI')
    .version(VERSION)
    .option('-p, --port <number>', 'port to serve dashboard', '3457')
    .option('-d, --days <number>', 'number of days to look back', '30')
    .option('--no-open', 'do not auto-open browser')
    .option('--json', 'output raw JSON to stdout instead of starting server')
    .option('--project <name>', 'filter to specific project')
    .option('--refresh', 'force full re-parse, ignore cache')
    .option('--autonomy', 'print autonomy metrics table to stdout and exit')
    .option('--claude-dir <path>', 'override path to Claude Code projects directory (for testing/CI)')
    .option('--codex-dir <path>', 'override path to OpenAI Codex sessions directory (for testing/CI)')
    .option('--source <agent>', 'analyze a single agent only: claude | codex')
    .option('--plan <tier>', 'Claude subscription mode — effective $/commit vs your flat plan: pro | max5 | max20')
    .option('--plan-cost <amount>', 'custom Claude monthly subscription cost in USD (overrides --plan)')
    .option('--codex-plan <tier>', 'Codex/ChatGPT subscription mode: plus | pro100 | pro | business')
    .option('--codex-plan-cost <amount>', 'custom Codex monthly subscription cost in USD (overrides --codex-plan)');

  program.parse();
  const opts = program.opts();
  const port = parseInt(opts.port, 10);
  const days = parseInt(opts.days, 10);

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
    if (tiers[key]) {
      return { name: namePrefix + key, monthlyCost: tiers[key] };
    }
    console.error(`  ${icon.err} ${c.red}Unknown ${flagName} "${planOpt}".${c.reset} Use ${Object.keys(tiers).join(', ')}, or ${flagName}-cost <amount>.`);
    process.exit(1);
  };
  // ChatGPT tiers (Codex is included in the plan): Plus $20, Pro $100 (the
  // "5x" tier launched Apr 2026), Pro $200 ("20x"), Business ~$25/seat/mo.
  const planConfigs = {
    claude: parsePlan(opts.plan, opts.planCost, { pro: 20, max5: 100, max20: 200 }, '--plan', ''),
    codex: parsePlan(opts.codexPlan, opts.codexPlanCost, { plus: 20, pro100: 100, pro: 200, business: 25 }, '--codex-plan', 'codex-'),
  };

  const sourceFilter = opts.source ? String(opts.source).toLowerCase() : null;
  if (sourceFilter && sourceFilter !== 'claude' && sourceFilter !== 'codex') {
    console.error(`  ${icon.err} ${c.red}Unknown --source "${opts.source}".${c.reset} Use claude or codex.`);
    process.exit(1);
  }

  const invokedAs = path.basename(process.argv[1]);
  if (invokedAs.includes('claude-roi')) {
    console.log(`  ${icon.warn} ${c.yellow}claude-roi has been renamed to codelens-ai${c.reset}`);
    console.log(`    Switch to: ${c.cyan}npx codelens-ai${c.reset}\n`);
  }
  console.log(`${icon.dot} ${c.bold}${c.cyan}codelens-ai${c.reset} v${VERSION}\n`);

  // Defaults live in cache.js so custom-dir runs get their own cache file.
  // Codex CLI stores rollout files under $CODEX_HOME/sessions (~/.codex by default).
  const claudeDir = opts.claudeDir ? path.resolve(opts.claudeDir) : DEFAULT_CLAUDE_DIR;
  const codexDir = opts.codexDir ? path.resolve(opts.codexDir) : DEFAULT_CODEX_DIR;

  const payloads = await buildPayload(claudeDir, codexDir, days, opts.project, opts.refresh, planConfigs, sourceFilter);
  if (payloads) {
    for (const p of Object.values(payloads)) {
      p.meta.invokedAs = invokedAs.includes('claude-roi') ? 'claude-roi' : 'codelens-ai';
    }
  }

  if (!payloads) {
    if (sourceFilter) {
      console.log(`  ${icon.warn} ${c.yellow}No ${sourceFilter} sessions found in the last ${days} days.${c.reset}`);
      console.log(`    Drop --source to analyze every agent, or check the session directory for ${sourceFilter}.`);
    } else {
      console.log(`  ${icon.warn} ${c.yellow}No AI coding agent sessions found.${c.reset}`);
      console.log(`    Claude Code sessions are read from ~/.claude/projects/ and OpenAI Codex sessions from ~/.codex/sessions/`);
    }
    process.exit(0);
  }
  const payload = payloads.all;

  // Output
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  if (opts.autonomy) {
    const am = payload.autonomyMetrics;
    const GRADE_COLOR = { A: '\x1b[32m', B: '\x1b[36m', C: '\x1b[33m', D: '\x1b[33m', F: '\x1b[31m' };
    const gc = GRADE_COLOR[am.overall.grade] || '\x1b[0m';
    const line = '\u2500'.repeat(35);
    console.log('');
    console.log(`  ${gc}Autonomy Score: ${am.overall.grade}\x1b[0m (${am.overall.score}/100)`);
    console.log(`  ${line}`);
    console.log(`  Autopilot Ratio     ${am.autopilotRatio}x`);
    console.log(`  Self-Heal Score     ${am.selfHealScore}%`);
    console.log(`  Toolbelt Coverage   ${am.toolbeltCoverage}%`);
    console.log(`  Commit Velocity     ${am.commitVelocity !== null ? am.commitVelocity + ' steps/commit' : 'N/A'}`);
    console.log(`  ${line}`);
    if (am.topVerificationCommands.length > 0) {
      const top3 = am.topVerificationCommands.slice(0, 3)
        .map(cmd => `${cmd.command} (${cmd.count})`).join(', ');
      console.log(`  Top Tests: ${top3}`);
    }
    console.log('');
    process.exit(0);
  }

  // Start server — pass a rebuild function so /api/refresh can re-run the pipeline
  const rebuild = async () => {
    const fresh = await buildPayload(claudeDir, codexDir, days, opts.project, true, planConfigs, sourceFilter);
    if (fresh) {
      for (const p of Object.values(fresh)) p.meta.invokedAs = payload.meta.invokedAs;
    }
    return fresh;
  };
  const app = createServer(payloads, rebuild);
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  ${icon.ok} ${c.green}Dashboard:${c.reset} ${c.bold}${url}${c.reset}`);

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

main().catch(err => {
  console.error(`  ${icon.err} ${c.red}Error:${c.reset}`, err.message);
  process.exit(1);
});
