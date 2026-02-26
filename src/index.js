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

const VERSION = '0.2.0';

async function main() {
  const program = new Command();
  program
    .name('claude-roi')
    .description('Correlate Claude Code token usage with git output to measure AI coding agent ROI')
    .version(VERSION)
    .option('-p, --port <number>', 'port to serve dashboard', '3457')
    .option('-d, --days <number>', 'number of days to look back', '30')
    .option('--no-open', 'do not auto-open browser')
    .option('--json', 'output raw JSON to stdout instead of starting server')
    .option('--project <name>', 'filter to specific project')
    .option('--refresh', 'force full re-parse, ignore cache');

  program.parse();
  const opts = program.opts();
  const port = parseInt(opts.port, 10);
  const days = parseInt(opts.days, 10);

  console.log(`\x1b[36mclaude-roi\x1b[0m v${VERSION}`);

  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  // Step 1: Parse sessions (with caching)
  let sessions;
  let fileIndex;
  const startParse = Date.now();

  if (opts.refresh) {
    deleteCache();
    console.log('Cache cleared, performing full parse...');
  }

  const cached = opts.refresh ? null : loadCache();

  if (cached) {
    // Incremental parse: only process new/modified files
    const stale = getStaleFiles(claudeDir, cached.fileIndex);
    const newCount = stale.newFiles.length;
    const modifiedCount = stale.modifiedFiles.length;
    const deletedCount = stale.deletedFiles.length;
    const cachedCount = Object.keys(cached.fileIndex).length - modifiedCount - deletedCount;

    if (newCount === 0 && modifiedCount === 0 && deletedCount === 0) {
      // Nothing changed, use cache as-is
      sessions = cached.sessions;
      fileIndex = cached.fileIndex;
      console.log(`Parsing sessions... ${cached.sessions.length} cached (${Date.now() - startParse}ms)`);
    } else {
      // Parse only new/modified files
      const { sessions: freshSessions, fileIndex: freshIndex } = await parseAllProjects(claudeDir, days, opts.project);

      // For a simpler approach: just do a full re-parse when files change
      // This avoids complex merging logic while still benefiting from caching
      // when nothing has changed
      sessions = freshSessions;
      fileIndex = freshIndex;
      console.log(`Parsing sessions... ${newCount} new, ${modifiedCount} updated, ${Math.max(0, cachedCount)} cached (${Date.now() - startParse}ms)`);
    }
  } else {
    // Full parse
    const result = await parseAllProjects(claudeDir, days, opts.project);
    sessions = result.sessions;
    fileIndex = result.fileIndex;
    console.log(`Parsing sessions... ${sessions.length} parsed (${Date.now() - startParse}ms)`);
  }

  if (sessions.length === 0) {
    console.log('\x1b[33mNo Claude Code sessions found.\x1b[0m');
    console.log('Make sure you have used Claude Code and session files exist in ~/.claude/projects/');
    process.exit(0);
  }

  // Step 2: Analyze git repos
  const startGit = Date.now();
  const repoPathsSet = new Set(sessions.map(s => s.repoPath).filter(Boolean));
  const commitsByRepo = {};
  for (const repoPath of repoPathsSet) {
    commitsByRepo[repoPath] = analyzeGitRepo(repoPath, days);
  }
  console.log(`Analyzing ${repoPathsSet.size} git repo(s)... done (${Date.now() - startGit}ms)`);

  // Step 3: Correlate sessions with commits
  const { correlatedSessions, organicCommits } = correlateSessions(sessions, commitsByRepo);
  console.log('Correlating sessions with commits... done');

  // Step 4: Compute metrics
  const payload = computeMetrics(correlatedSessions, organicCommits, commitsByRepo, days);
  payload.meta.gitUser = getGitUser();

  // Save cache for next run
  saveCache(sessions, fileIndex);

  // Step 5: Output
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  // Start server
  const app = createServer(payload);
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\x1b[32mDashboard:\x1b[0m ${url}`);

    if (opts.open !== false) {
      import('open').then(mod => mod.default(url)).catch(() => {
        console.log('Could not auto-open browser. Visit the URL above.');
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31mPort ${port} is already in use.\x1b[0m Try: claude-roi --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });
}

main().catch(err => {
  console.error('\x1b[31mError:\x1b[0m', err.message);
  process.exit(1);
});
