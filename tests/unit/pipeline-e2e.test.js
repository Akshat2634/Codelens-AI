import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Full-pipeline integration test: a REAL git repository plus a real session
// file, driven through the actual CLI (`--json`). This is the only test that
// exercises the product's core value proposition end-to-end — session parsing,
// git analysis, trailer detection, correlation, and the headline ROI metrics —
// with no mocks between the layers.

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.js');

function gitCommit(dir, message, extraMessage, isoDate) {
  execSync('git add -A', { cwd: dir });
  const msgFlags = extraMessage
    ? `-m ${JSON.stringify(message)} -m ${JSON.stringify(extraMessage)}`
    : `-m ${JSON.stringify(message)}`;
  execSync(`git commit -q ${msgFlags}`, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@codelens.dev',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@codelens.dev',
      GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
    },
  });
}

test('full pipeline: session + real repo -> trailer-confirmed commit, AI share, value leak', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-e2e-'));
  try {
    // ── A real repository with one AI commit and one manual commit ──
    const repo = path.join(root, 'myrepo');
    mkdirSync(repo, { recursive: true });
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email test@codelens.dev', { cwd: repo });
    execSync('git config user.name Test', { cwd: repo });

    const now = Date.now();
    const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

    // AI commit: 12 lines in the file the session wrote, stamped with the
    // agent trailer, landing 30 minutes after the session started.
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'app.js'), Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n');
    gitCommit(repo, 'add app feature', 'Co-Authored-By: Claude <noreply@anthropic.com>', iso(30));

    // Manual commit: 3 lines, no trailer, well outside any session window.
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'notes.md'), 'a\nb\nc\n');
    gitCommit(repo, 'manual notes', null, iso(600));

    // ── A Claude Code session that wrote src/app.js, 60-45 minutes ago ──
    const claudeDir = path.join(root, 'claude-projects');
    const projDir = path.join(claudeDir, 'myrepo-project');
    mkdirSync(projDir, { recursive: true });
    const sid = 'cccccccc-1111-2222-3333-444444444444';
    const lines = [
      {
        type: 'user', sessionId: sid, cwd: repo, gitBranch: 'main', timestamp: iso(60),
        message: { content: [{ type: 'text', text: 'Build the app feature.' }] },
      },
      {
        type: 'assistant', requestId: 'req-1', timestamp: iso(55),
        message: {
          model: 'claude-sonnet-4-6-20250929',
          usage: { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(repo, 'src', 'app.js') } },
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'assistant', requestId: 'req-2', timestamp: iso(45),
        message: {
          model: 'claude-sonnet-4-6-20250929',
          usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    ];
    writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const codexDir = path.join(root, 'codex-sessions'); // empty — claude-only run
    mkdirSync(codexDir, { recursive: true });

    // ── Run the real CLI ──
    const stdout = execFileSync(process.execPath, [
      INDEX, '--json', '--claude-dir', claudeDir, '--codex-dir', codexDir, '--days', '30',
    ], { encoding: 'utf-8', env: { ...process.env, HOME: root } });
    const payload = JSON.parse(stdout);

    // Correlation: the AI commit matched, the manual one stayed organic.
    assert.equal(payload.summary.totalSessions, 1);
    assert.equal(payload.summary.totalCommits, 1, 'AI commit matched by file overlap');
    assert.equal(payload.summary.organicCommitCount, 1, 'manual commit stays organic');
    assert.equal(payload.summary.totalLinesAdded, 12);

    // Trailer attribution: the commit is stamped and confirmed against the session.
    assert.deepEqual(payload.summary.reconciliation.commits.trailerStamped, { matched: 1, crossAgent: 0, organic: 0 });
    const session = payload.sessions[0];
    assert.equal(session.trailerConfirmedCommits, 1);
    assert.equal(session.attributionConfidence, 'high');
    assert.equal(session.commits[0].aiTrailer, 'claude');

    // Headline metrics: 12 AI lines of 15 merged -> 80%; every dollar reached
    // a commit -> zero value leak.
    assert.equal(payload.summary.aiCodeSharePct, 80);
    assert.equal(payload.summary.valueLeak.pct, 0);
    assert.equal(payload.summary.valueLeak.sessionCount, 0);
    assert.ok(payload.summary.totalCost > 0, 'session usage was costed');

    // Analysis flags placed BEFORE the subcommand must reach it (positional
    // options would otherwise let the parent swallow them and report would
    // silently analyze the real home dirs with defaults).
    const reportOut = execFileSync(process.execPath, [
      INDEX, '--claude-dir', claudeDir, '--codex-dir', codexDir, '--days', '17', 'report',
    ], { encoding: 'utf-8', env: { ...process.env, HOME: root } });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI for text assertions
    const reportText = reportOut.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(reportText.includes('(17 days)'), `parent-placed --days honored: ${reportText.split('\n')[1]}`);
    assert.ok(reportText.includes('80% of merged lines'), 'report shows AI code share from the fixture repo');
    assert.ok(reportText.includes('Trailer-confirmed'), 'report shows the trailer audit line');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested workspace-parent sessions automatically explode into per-sub-repo clones (no flag needed)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-depth-'));
  try {
    // Workspace directory with TWO nested git repos — the parent has no .git.
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const repoA = path.join(workspace, 'repo-a');
    const repoB = path.join(workspace, 'repo-b');
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execSync('git init -q -b main', { cwd: repo });
      execSync('git config user.email test@codelens.dev', { cwd: repo });
      execSync('git config user.name Test', { cwd: repo });
    }

    const now = Date.now();
    const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

    // One commit per sub-repo, both within the session window.
    mkdirSync(path.join(repoA, 'src'), { recursive: true });
    writeFileSync(path.join(repoA, 'src', 'a.js'), 'a\n'.repeat(10));
    gitCommit(repoA, 'repo-a feature', null, iso(30));

    mkdirSync(path.join(repoB, 'src'), { recursive: true });
    writeFileSync(path.join(repoB, 'src', 'b.js'), 'b\n'.repeat(5));
    gitCommit(repoB, 'repo-b tweak', null, iso(25));

    // Session with cwd at the WORKSPACE PARENT, editing files in both repos.
    const claudeDir = path.join(root, 'claude-projects');
    const projDir = path.join(claudeDir, 'workspace-project');
    mkdirSync(projDir, { recursive: true });
    const sid = 'dddddddd-aaaa-bbbb-cccc-eeeeeeeeeeee';
    const lines = [
      {
        type: 'user', sessionId: sid, cwd: workspace, gitBranch: 'main', timestamp: iso(60),
        message: { content: [{ type: 'text', text: 'Work in both repos.' }] },
      },
      {
        type: 'assistant', requestId: 'req-1', timestamp: iso(50),
        message: {
          model: 'claude-sonnet-4-6-20250929',
          usage: { input_tokens: 3000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(repoA, 'src', 'a.js') } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: path.join(repoB, 'src', 'b.js') } },
          ],
        },
      },
    ];
    writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const codexDir = path.join(root, 'codex-sessions');
    mkdirSync(codexDir, { recursive: true });

    // No --depth flag, no special options — a workspace-parent cwd is
    // detected automatically and exploded into per-sub-repo clones.
    const result = JSON.parse(execFileSync(process.execPath, [
      INDEX, '--json', '--claude-dir', claudeDir, '--codex-dir', codexDir, '--days', '30',
    ], { encoding: 'utf-8', env: { ...process.env, HOME: root } }));
    assert.equal(result.summary.totalSessions, 2, 'session automatically exploded into two clones');
    assert.equal(result.summary.totalCommits, 2, 'both sub-repo commits correlated');
    assert.ok(result.summary.totalCost > 0);

    // Sub-repo names surface as project names.
    const projectNames = new Set(result.sessions.map(s => s.projectName));
    assert.ok(projectNames.has('repo-a'));
    assert.ok(projectNames.has('repo-b'));

    // Cost is CONSERVED: only one clone keeps it, the other reads $0.
    const costs = result.sessions.map(s => s.cost.totalCost).sort((a, b) => a - b);
    assert.equal(costs[0], 0);
    assert.ok(costs[1] > 0);
    assert.equal(costs[0] + costs[1], result.summary.totalCost);

    // The zeroed clone still has its own real commit, but must not be graded —
    // a $0-cost session with a real commit would otherwise read as a
    // fabricated 'A', purely an artifact of the cost-conservation split.
    const zeroedSession = result.sessions.find(s => s.cost.totalCost === 0);
    assert.equal(zeroedSession.commitCount, 1, 'the zeroed clone still gets its own real commit');
    assert.equal(zeroedSession.grade, null, 'a zeroed clone must not be graded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace-parent cwd that still EXISTS is not flagged as a moved/deleted repo', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-exists-'));
  try {
    const now = Date.now();
    const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();

    // A plain folder that EXISTS but is not a git repo and has no nested repos
    // — exactly the `talosred` case: repos would live in sub-folders, but this
    // session's cwd is just the bare parent, so it can't be exploded.
    const existingParent = path.join(root, 'workspace-parent');
    mkdirSync(existingParent, { recursive: true });

    // A path that does NOT exist on disk — a genuinely moved/deleted repo.
    const missingRepo = path.join(root, 'ghost-repo');

    const claudeDir = path.join(root, 'claude-projects');
    const projDir = path.join(claudeDir, 'proj');
    mkdirSync(projDir, { recursive: true });

    const mkSession = (sid, cwd, file) => [
      {
        type: 'user', sessionId: sid, cwd, gitBranch: 'main', timestamp: iso(60),
        message: { content: [{ type: 'text', text: 'work' }] },
      },
      {
        type: 'assistant', requestId: `${sid}-req`, timestamp: iso(50),
        message: {
          model: 'claude-sonnet-4-6-20250929',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: `${sid}-t1`, name: 'Edit', input: { file_path: file } }],
        },
      },
    ];
    const existsSid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const ghostSid = 'bbbbbbbb-1111-2222-3333-444444444444';
    writeFileSync(path.join(projDir, `${existsSid}.jsonl`),
      mkSession(existsSid, existingParent, path.join(existingParent, 'notes.md')).map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(path.join(projDir, `${ghostSid}.jsonl`),
      mkSession(ghostSid, missingRepo, path.join(missingRepo, 'src', 'x.js')).map(l => JSON.stringify(l)).join('\n') + '\n');

    const codexDir = path.join(root, 'codex-sessions');
    mkdirSync(codexDir, { recursive: true });

    // Progress (incl. the warning) goes to stderr under --json.
    const r = spawnSync(process.execPath, [
      INDEX, '--json', '--claude-dir', claudeDir, '--codex-dir', codexDir, '--days', '30',
    ], { encoding: 'utf-8', env: { ...process.env, HOME: root } });

    // The existing-but-not-a-repo parent must NOT be reported as "no longer
    // exist" — it's right there on disk. (Its path only ever appears in stderr
    // via that warning, so its absence proves the false alarm is gone.)
    assert.ok(!r.stderr.includes(existingParent),
      `existing workspace parent must not be flagged as missing.\nstderr:\n${r.stderr}`);

    // The genuinely-missing path IS still warned about, by name.
    assert.match(r.stderr, /no longer exist/);
    assert.ok(r.stderr.includes(missingRepo),
      `the truly-missing repo path must still be reported.\nstderr:\n${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
