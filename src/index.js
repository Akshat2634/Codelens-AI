#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import os from 'node:os';
import { parseAllProjects } from './claude-parser.js';
import { analyzeGitRepo, getGitUser } from './git-analyzer.js';
import { correlateSessions } from './correlator.js';
import { computeMetrics } from './metrics.js';
import { loadCache, saveCache, deleteCache, getStaleFiles } from './cache.js';
import { createServer } from './server.js';
import { readFileSync } from 'node:fs';

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

async function buildPayload(claudeDir, days, project, forceRefresh = false) {
  // Step 1: Parse sessions (with caching)
  let sessions;
  let fileIndex;
  const startParse = Date.now();

  if (forceRefresh) {
    deleteCache();
    console.log(`  ${icon.arrow} Cache cleared, performing full parse...`);
  }

  const cached = forceRefresh ? null : loadCache();

  if (cached) {
    const stale = getStaleFiles(claudeDir, cached.fileIndex);
    const newCount = stale.newFiles.length;
    const modifiedCount = stale.modifiedFiles.length;
    const deletedCount = stale.deletedFiles.length;
    const cachedCount = Object.keys(cached.fileIndex).length - modifiedCount - deletedCount;

    if (newCount === 0 && modifiedCount === 0 && deletedCount === 0) {
      sessions = cached.sessions;
      fileIndex = cached.fileIndex;
      console.log(`  ${icon.ok} Parsing sessions ${c.dim}── ${cached.sessions.length} cached (${fmt(Date.now() - startParse)})${c.reset}`);
    } else {
      const { sessions: freshSessions, fileIndex: freshIndex } = await parseAllProjects(claudeDir, days, project);
      sessions = freshSessions;
      fileIndex = freshIndex;
      console.log(`  ${icon.ok} Parsing sessions ${c.dim}── ${newCount} new, ${modifiedCount} updated, ${Math.max(0, cachedCount)} cached (${fmt(Date.now() - startParse)})${c.reset}`);
    }
  } else {
    const result = await parseAllProjects(claudeDir, days, project);
    sessions = result.sessions;
    fileIndex = result.fileIndex;
    console.log(`  ${icon.ok} Parsing sessions ${c.dim}── ${sessions.length} parsed (${fmt(Date.now() - startParse)})${c.reset}`);
  }

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

  // Step 3: Correlate sessions with commits
  const { correlatedSessions, organicCommits } = correlateSessions(sessions, commitsByRepo);
  console.log(`  ${icon.ok} Correlating sessions ${c.dim}── done${c.reset}`);

  // Step 4: Compute metrics
  const payload = computeMetrics(correlatedSessions, organicCommits, commitsByRepo, days);
  payload.meta.gitUser = getGitUser();

  // Save cache for next run
  saveCache(sessions, fileIndex);

  return payload;
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
    .option('--autonomy', 'print autonomy metrics table to stdout and exit');

  program.parse();
  const opts = program.opts();
  const port = parseInt(opts.port, 10);
  const days = parseInt(opts.days, 10);

  const invokedAs = path.basename(process.argv[1]);
  if (invokedAs.includes('claude-roi')) {
    console.log(`  ${icon.warn} ${c.yellow}claude-roi has been renamed to codelens-ai${c.reset}`);
    console.log(`    Switch to: ${c.cyan}npx codelens-ai${c.reset}\n`);
  }
  console.log(`${icon.dot} ${c.bold}${c.cyan}codelens-ai${c.reset} v${VERSION}\n`);

  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  const payload = await buildPayload(claudeDir, days, opts.project, opts.refresh);
  if (payload) payload.meta.invokedAs = invokedAs.includes('claude-roi') ? 'claude-roi' : 'codelens-ai';

  if (!payload) {
    console.log(`  ${icon.warn} ${c.yellow}No Claude Code sessions found.${c.reset}`);
    console.log(`    Make sure you have used Claude Code and session files exist in ~/.claude/projects/`);
    process.exit(0);
  }

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
  const rebuild = () => buildPayload(claudeDir, days, opts.project, true);
  const app = createServer(payload, rebuild);
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
