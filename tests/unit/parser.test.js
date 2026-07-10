import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  calculateCost,
  calculateCostBreakdown,
  getModelFamily,
  getPricingTier,
  isReadOnlyCommand,
  isVerificationCommand,
  PRICING,
  parseAllProjects,
  toRelativePath,
} from '../../src/claude-parser.js';
import { __resetOverlayForTest, __setOverlayForTest } from '../../src/pricing.js';

test('getModelFamily maps common Claude model strings', () => {
  assert.equal(getModelFamily('claude-opus-4-7'), 'opus');
  assert.equal(getModelFamily('claude-sonnet-4-6-20250929'), 'sonnet');
  assert.equal(getModelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(getModelFamily('CLAUDE-OPUS-4-6'), 'opus');
  assert.equal(getModelFamily(null), null);
  assert.equal(getModelFamily(''), null);
  assert.equal(getModelFamily('gpt-4'), null);
});

test('getPricingTier resolves version-specific tiers', () => {
  assert.equal(getPricingTier('claude-opus-4-7'), 'opus-47');
  assert.equal(getPricingTier('claude-opus-4-6'), 'opus-46');
  assert.equal(getPricingTier('claude-opus-4-5'), 'opus-45');
  assert.equal(getPricingTier('claude-opus-4-1-20250805'), 'opus-old');
  assert.equal(getPricingTier('claude-sonnet-4-6'), 'sonnet');
  assert.equal(getPricingTier('claude-3-sonnet-20240229'), 'sonnet');
  assert.equal(getPricingTier('claude-haiku-4-5'), 'haiku-new');
  assert.equal(getPricingTier('claude-haiku-3-5'), 'haiku-35');
  assert.equal(getPricingTier('claude-3-haiku-20240307'), 'haiku-3');
  assert.equal(getPricingTier('claude-opus-5'), null, 'future Opus must not inherit legacy Opus pricing');
  assert.equal(getPricingTier('claude-haiku-5'), null, 'future Haiku must not inherit Haiku 3 pricing');
  assert.equal(getPricingTier('claude-fable-6'), null, 'future Fable must not inherit Fable 5 pricing');
  assert.equal(getPricingTier('claude-mythos-preview'), null, 'private preview pricing is not publicly documented');
  assert.equal(getPricingTier(null), null);
});

test('Fable 5 / Mythos 5 are recognized and priced at $10/$50', () => {
  assert.equal(getModelFamily('claude-fable-5'), 'fable');
  assert.equal(getModelFamily('claude-mythos-5'), 'fable');
  assert.equal(getPricingTier('claude-fable-5'), 'fable');
  assert.equal(getPricingTier('claude-mythos-5'), 'fable');
  // $10 input + $50 output per 1M tokens
  const cost = calculateCost(1_000_000, 1_000_000, 0, 0, 'claude-fable-5');
  assert.ok(Math.abs(cost - 60) < 0.0001, `expected 60, got ${cost}`);
});

test('Sonnet 5 is date-aware: intro $2/$10 through 2026-08-31, standard $3/$15 after', () => {
  // Sonnet 5 is the sonnet family (known model — must NOT count as estimated spend)
  assert.equal(getModelFamily('claude-sonnet-5'), 'sonnet');

  const introDay = Date.parse('2026-08-31T23:59:59Z'); // last instant of intro pricing
  const standardDay = Date.parse('2026-09-01T00:00:00Z'); // first instant of standard pricing

  // Tier selection flips exactly at the 2026-09-01 boundary
  assert.equal(getPricingTier('claude-sonnet-5', introDay), 'sonnet-5-intro');
  assert.equal(getPricingTier('claude-sonnet-5', standardDay), 'sonnet');
  assert.equal(getPricingTier('claude-sonnet-5-20260615', introDay), 'sonnet-5-intro');

  // Older Sonnets are NOT mistaken for Sonnet 5 ('sonnet-4-5' has no 'sonnet-5' substring)
  assert.equal(getPricingTier('claude-sonnet-4-5', introDay), 'sonnet');
  assert.equal(getPricingTier('claude-sonnet-4-6', standardDay), 'sonnet');
  assert.equal(getPricingTier('claude-3-5-sonnet-20241022', introDay), 'sonnet');

  // Cost math: 1M input + 1M output. Intro = $2 + $10 = $12; standard = $3 + $15 = $18.
  const introCost = calculateCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-5', 0, Date.parse('2026-07-15'));
  assert.ok(Math.abs(introCost - 12) < 0.0001, `expected 12, got ${introCost}`);
  const standardCost = calculateCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-5', 0, Date.parse('2026-10-01'));
  assert.ok(Math.abs(standardCost - 18) < 0.0001, `expected 18, got ${standardCost}`);

  // Intro cache rates follow the standard multiples of the $2 intro input price
  const introCache = calculateCost(0, 0, 1_000_000, 1_000_000, 'claude-sonnet-5', 0, Date.parse('2026-07-15'));
  assert.ok(Math.abs(introCache - (0.20 + 2.50)) < 0.0001, `expected 2.70, got ${introCache}`);
});

test('Sonnet 5 session straddling the cutover: session.cost reconciles with the daily timeline and prices each side correctly', async () => {
  // Two usages on either side of the 2026-09-01 cutover, far enough apart (Aug vs
  // Sep) to land on different days in every timezone: 1M input each.
  // Aug = intro $2/M, Sep = standard $3/M ⇒ total $5 — NOT $4 (all priced at the
  // session-start intro rate, the bug this guards).
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-sonnet5-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'ffffffff-1111-2222-3333-444444444444';
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/tmp/x', gitBranch: 'main', timestamp: '2026-08-15T12:00:00.000Z', message: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', requestId: 'r1', timestamp: '2026-08-15T12:00:00.000Z', message: { model: 'claude-sonnet-5', usage } },
      { type: 'assistant', requestId: 'r2', timestamp: '2026-09-15T12:00:00.000Z', message: { model: 'claude-sonnet-5', usage } },
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    // Large lookback so the (future-dated) fixture clears the cutoff filter.
    const { sessions } = await parseAllProjects(root, 100000);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');

    assert.ok(Math.abs(s.cost.totalCost - 5) < 1e-6, `expected $5 split-rate total, got ${s.cost.totalCost}`);
    const dailySum = Object.values(s.dailyUsage).reduce((a, d) => a + d.cost, 0);
    assert.ok(Math.abs(s.cost.totalCost - dailySum) < 1e-6, `session.cost ($${s.cost.totalCost}) must reconcile with daily timeline ($${dailySum})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRICING table covers every exported tier', () => {
  for (const key of ['fable', 'opus-48', 'opus-47', 'opus-46', 'opus-45', 'opus-old', 'opus-48-fast', 'opus-47-fast', 'sonnet', 'sonnet-5-intro', 'haiku-new', 'haiku-35', 'haiku-3']) {
    assert.ok(PRICING[key], `missing pricing tier ${key}`);
    const p = PRICING[key];
    assert.ok(p.input > 0 && p.output > 0, `invalid pricing for ${key}`);
    // Cache reads must be ~10% of input, cache writes ~1.25x — sanity checks
    assert.ok(p.cacheRead < p.input, `cacheRead should be cheaper than input for ${key}`);
    assert.ok(p.cacheWrite > p.input, `cacheWrite should be pricier than input for ${key}`);
  }
});

test('calculateCost matches manual math for Opus 4.6', () => {
  // Opus 4.6: $5/M input, $25/M output, $0.50/M cache read, $6.25/M cache write
  const cost = calculateCost(1_000_000, 100_000, 500_000, 10_000, 'claude-opus-4-6');
  const expected = (1_000_000 * 5 / 1e6) + (100_000 * 25 / 1e6) + (500_000 * 0.5 / 1e6) + (10_000 * 6.25 / 1e6);
  assert.ok(Math.abs(cost - expected) < 0.0001, `expected ${expected}, got ${cost}`);
});

test('1-hour cache writes cost more than the 5-minute default', () => {
  const fiveMin = calculateCost(0, 0, 0, 10_000, 'claude-opus-4-6'); // all 5m (default arg = 0)
  const oneHour = calculateCost(0, 0, 0, 10_000, 'claude-opus-4-6', 10_000); // all 1h
  assert.ok(oneHour > fiveMin, '1h cache write should cost more than 5m');
  // Opus input $5/1M → 1h = 2x = $10/1M, 5m = 1.25x = $6.25/1M; for 10k tokens:
  assert.ok(Math.abs(oneHour - 0.10) < 1e-9, `expected 0.10, got ${oneHour}`);
  assert.ok(Math.abs(fiveMin - 0.0625) < 1e-9, `expected 0.0625, got ${fiveMin}`);
});

test('calculateCost returns 0 for unknown/missing model', () => {
  // With no external overlay loaded, unknown models fall back to sonnet pricing
  // — so it won't be 0, but should be deterministic.
  __resetOverlayForTest();
  const unknown = calculateCost(1000, 1000, 0, 0, 'gpt-4');
  const sonnet = calculateCost(1000, 1000, 0, 0, 'claude-sonnet-4-5');
  assert.equal(unknown, sonnet);
  // Null model → 0 (no rates resolvable)
  assert.equal(calculateCost(1000, 1000, 0, 0, null), 0);
});

test('calculateCost prices unknown models from the external overlay when loaded', () => {
  // A model the hardcoded table doesn't know, but the overlay does.
  __setOverlayForTest({ 'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.125 } });
  const cost = calculateCost(1_000_000, 1_000_000, 0, 0, 'gpt-4o');
  assert.ok(Math.abs(cost - (2.5 + 10)) < 1e-9, `overlay-priced: ${cost}`);
  // A model in BOTH the table and the overlay still uses the table (hardcoded wins).
  __setOverlayForTest({ 'claude-sonnet-4-5': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 } });
  const sonnet = calculateCost(1_000_000, 0, 0, 0, 'claude-sonnet-4-5');
  assert.equal(sonnet, PRICING.sonnet.input); // $3, not the overlay's $999
  __resetOverlayForTest();
});

test('calculateCostBreakdown splits costs and sums correctly', () => {
  const b = calculateCostBreakdown(1_000_000, 100_000, 500_000, 10_000, 'claude-opus-4-6');
  assert.ok(b.inputCost > 0);
  assert.ok(b.outputCost > 0);
  assert.ok(b.cacheReadCost > 0);
  assert.ok(b.cacheCreationCost > 0);
  const sum = b.inputCost + b.outputCost + b.cacheReadCost + b.cacheCreationCost;
  assert.ok(Math.abs(sum - b.totalCost) < 0.0001);
});

test('fast mode, US inference, cache TTL, and web search modifiers stack correctly', () => {
  const b = calculateCostBreakdown(
    1_000_000, 1_000_000, 1_000_000, 1_000_000,
    'claude-opus-4-8[fast][us]', 1_000_000, Date.now(), 2,
  );
  assert.equal(b.inputCost, 11);          // $10 fast input × 1.1 US
  assert.equal(b.outputCost, 55);        // $50 fast output × 1.1 US
  assert.equal(b.cacheReadCost, 1.1);    // $1 fast cache read × 1.1 US
  assert.equal(b.cacheCreationCost, 22); // $20 fast 1h write × 1.1 US
  assert.equal(b.serverToolCost, 0.02);   // fixed $10 / 1,000 searches
  assert.ok(Math.abs(b.totalCost - 89.12) < 1e-9);
});

test('Claude Code usage fields drive billing markers and reconcile through parsing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-claude-billing-fields-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-999999999999';
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/tmp/x', gitBranch: 'main', entrypoint: 'claude-vscode', timestamp: now, message: { content: [{ type: 'text', text: 'go' }] } },
      {
        type: 'assistant', requestId: 'r1', timestamp: now,
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 1_000_000, output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
            server_tool_use: { web_search_requests: 2, web_fetch_requests: 3 },
            speed: 'fast', inference_geo: 'us', service_tier: 'standard',
          },
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s);
    assert.equal(s.entrypoint, 'claude-vscode');
    assert.equal(s.webSearchRequests, 2, 'bill only recorded server searches; web fetch is free');
    assert.equal(s.cacheCreation1hTokens, 1_000_000);
    assert.deepEqual(Object.keys(s.modelBreakdown), ['claude-opus-4-8[fast][us]']);
    assert.ok(Math.abs(s.cost.totalCost - 89.12) < 1e-9);
    assert.ok(Math.abs(s.cost.totalCost - Object.values(s.dailyUsage)[0].cost) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isVerificationCommand identifies common test/lint invocations', () => {
  assert.equal(isVerificationCommand('npm test'), true);
  assert.equal(isVerificationCommand('npm run lint'), true);
  assert.equal(isVerificationCommand('npm run typecheck'), true);
  assert.equal(isVerificationCommand('pnpm test'), true);
  assert.equal(isVerificationCommand('yarn run check'), true);
  assert.equal(isVerificationCommand('pytest -xvs'), true);
  assert.equal(isVerificationCommand('cargo test'), true);
  assert.equal(isVerificationCommand('go test ./...'), true);
  assert.equal(isVerificationCommand('tsc --noEmit'), true);
  assert.equal(isVerificationCommand('npx eslint src/'), true);
  // With cd/env prefix
  assert.equal(isVerificationCommand('cd /repo && npm test'), true);
  assert.equal(isVerificationCommand('CI=true pytest'), true);
});

test('isVerificationCommand rejects non-verification commands', () => {
  assert.equal(isVerificationCommand('git commit -m "wip"'), false);
  assert.equal(isVerificationCommand('npm install express'), false);
  assert.equal(isVerificationCommand('ls -la'), false);
  assert.equal(isVerificationCommand('cat package.json'), false);
  assert.equal(isVerificationCommand('echo hello'), false);
  assert.equal(isVerificationCommand('curl https://example.com'), false);
  assert.equal(isVerificationCommand('grep foo src/'), false);
  assert.equal(isVerificationCommand(''), false);
  assert.equal(isVerificationCommand(null), false);
  assert.equal(isVerificationCommand(undefined), false);
});

test('toRelativePath strips repo prefix and handles worktrees', () => {
  assert.equal(
    toRelativePath('/Users/me/proj/src/file.js', '/Users/me/proj'),
    'src/file.js'
  );
  // Worktree path: anything under .claude/worktrees/<name>/ becomes relative
  assert.equal(
    toRelativePath('/tmp/.claude/worktrees/abc/src/x.js', '/anything'),
    'src/x.js'
  );
  // Fallback: just the basename
  assert.equal(toRelativePath('/other/path/file.js', '/not-a-match'), 'file.js');
  // No absolute path
  assert.equal(toRelativePath(null, '/repo'), null);
});

test('toRelativePath suffix-matches the repo folder when the recorded cwd is a stale alias', () => {
  // Live case: cwd logged under GitHub/ (dead) while files landed under
  // GitHub.nosync/ — the prefix check fails but the repo folder name matches.
  assert.equal(
    toRelativePath(
      '/Users/me/Documents/GitHub.nosync/Codelens-AI/src/codex-parser.js',
      '/Users/me/Documents/GitHub/Codelens-AI'
    ),
    'src/codex-parser.js'
  );
  // lastIndexOf picks the innermost same-named folder → shortest relative path
  assert.equal(
    toRelativePath('/data/proj/vendor/proj/src/x.js', '/elsewhere/proj'),
    'src/x.js'
  );
  // No same-named folder anywhere in the path → basename fallback
  assert.equal(
    toRelativePath('/Users/me/other-repo/src/file.js', '/Users/me/Documents/GitHub/Codelens-AI'),
    'file.js'
  );
});

test('isReadOnlyCommand classifies read-only inspection commands', () => {
  assert.equal(isReadOnlyCommand('cat package.json'), true);
  assert.equal(isReadOnlyCommand('ls -la src/'), true);
  assert.equal(isReadOnlyCommand('rg -n "foo" src/'), true);
  assert.equal(isReadOnlyCommand('grep -r foo .'), true);
  assert.equal(isReadOnlyCommand('find . -name "*.js"'), true);
  assert.equal(isReadOnlyCommand('head -50 file.js'), true);
  assert.equal(isReadOnlyCommand('wc -l src/*.js'), true);
  assert.equal(isReadOnlyCommand('echo hello'), true);
  assert.equal(isReadOnlyCommand('printenv PATH'), true);
  // cd/env-var prefixes are stripped, same as isVerificationCommand
  assert.equal(isReadOnlyCommand('cd /repo && cat file.js'), true);
  assert.equal(isReadOnlyCommand('FOO=bar env'), true);
  // sed only reads with an explicit -n and never with an in-place flag
  assert.equal(isReadOnlyCommand("sed -n '1,20p' file.js"), true);
  assert.equal(isReadOnlyCommand("sed -i '' 's/a/b/' file.js"), false);
  assert.equal(isReadOnlyCommand("sed -n -i.bak 's/a/b/' file.js"), false);
  assert.equal(isReadOnlyCommand("sed 's/a/b/' file.js"), false);
});

test('isReadOnlyCommand is conservative: writes and ambiguity are not read-only', () => {
  assert.equal(isReadOnlyCommand('rm -rf dist'), false);
  assert.equal(isReadOnlyCommand('npm test'), false);
  assert.equal(isReadOnlyCommand('git status'), false);
  assert.equal(isReadOnlyCommand('node script.js'), false);
  assert.equal(isReadOnlyCommand('awk "{print $1}" file'), false);
  assert.equal(isReadOnlyCommand(''), false);
  assert.equal(isReadOnlyCommand(null), false);
  assert.equal(isReadOnlyCommand(undefined), false);
});

test('isVerificationCommand finds the real test/lint call inside a setup/cleanup chain', () => {
  // A leading rm/mkdir/git-checkout must not mask a genuine verification
  // command later in the chain — each && / ; segment is checked on its own.
  assert.equal(isVerificationCommand('rm -rf dist && npm run build && npm test'), true);
  assert.equal(isVerificationCommand('mkdir -p dist && npm test'), true);
  assert.equal(isVerificationCommand('git checkout main && npm test'), true);
  // A chain with no verification segment anywhere is still rejected.
  assert.equal(isVerificationCommand('rm -rf dist && mkdir -p dist'), false);
});

test('isReadOnlyCommand rejects compound/piped commands that mutate in a later segment', () => {
  // A read-only-looking opener (echo, find, grep) must not give the whole
  // chain a free pass when a later stage deletes/mutates.
  assert.equal(isReadOnlyCommand('echo starting && rm -rf dist'), false);
  assert.equal(isReadOnlyCommand("find . -name '*.log' -delete"), false);
  assert.equal(isReadOnlyCommand('grep -rl foo . | xargs rm'), false);
  // Control: an all-read-only chain of the same shape is still read-only.
  assert.equal(isReadOnlyCommand('echo starting && cat file.js'), true);
});

test('pwd && npm test is verification but no longer double-counted as read-only', () => {
  assert.equal(isVerificationCommand('pwd && npm test'), true);
  assert.equal(isReadOnlyCommand('pwd && npm test'), false);
});

test('isVerificationCommand excludes package installs that merely mention a test tool by name', () => {
  assert.equal(isVerificationCommand('yarn add jest --dev'), false);
  assert.equal(isVerificationCommand('pnpm add -D biome'), false);
  assert.equal(isVerificationCommand('npx playwright install'), false);
  assert.equal(isVerificationCommand('npx playwright install --with-deps chromium'), false);
  // Control case: an actual playwright test run must NOT regress to false.
  assert.equal(isVerificationCommand('npx playwright test'), true);
});

test('isVerificationCommand matches a bare trailing test-runner invocation', () => {
  assert.equal(isVerificationCommand('yarn jest'), true);
  assert.equal(isVerificationCommand('jest'), true);
  // Must not match the tool name inside an unrelated filename.
  assert.equal(isVerificationCommand('cat playwright.config.js'), false);
  assert.equal(
    isVerificationCommand('diff playwright.config.js playwright.config.js.bak'),
    false
  );
});

test('readOnlyBashCalls counts read-only Bash commands without changing totalBashCalls', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-readonly-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-555555555555';
    const now = new Date().toISOString();
    const bash = (id, command) => ({
      type: 'assistant', requestId: id, timestamp: now,
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    });
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/tmp/x', gitBranch: 'main', timestamp: now, message: { content: [{ type: 'text', text: 'go' }] } },
      bash('t1', 'cat src/index.js'),
      bash('t2', 'npm test'),
      bash('t3', "sed -i '' 's/a/b/' src/index.js"),
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.equal(s.totalBashCalls, 3, 'totalBashCalls semantics unchanged');
    assert.equal(s.verificationBashCalls, 1);
    assert.equal(s.readOnlyBashCalls, 1, 'only cat is read-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isMeta user entries are excluded from userMessageCount', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-ismeta-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-666666666666';
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/tmp/x', gitBranch: 'main', timestamp: now, message: { content: [{ type: 'text', text: 'real prompt 1' }] } },
      // System-injected meta entries (skill notices, slash-command defs, image
      // placeholders) carry isMeta:true — not genuine user turns.
      { type: 'user', isMeta: true, timestamp: now, message: { content: [{ type: 'text', text: 'Skill base directory notice (injected)' }] } },
      { type: 'user', isMeta: true, timestamp: now, message: { content: 'a slash-command definition' } },
      { type: 'user', timestamp: now, message: { content: [{ type: 'text', text: 'real prompt 2' }] } },
      { type: 'assistant', requestId: 'r1', timestamp: now, message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.equal(s.userMessageCount, 2, 'only genuine user turns counted; isMeta injections excluded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MultiEdit and NotebookEdit populate filesWritten (not just Write/Edit)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-multiedit-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-777777777777';
    const now = new Date().toISOString();
    const tool = (id, name, input) => ({
      type: 'assistant', requestId: id, timestamp: now,
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'tool_use', id, name, input }] },
    });
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/repo', gitBranch: 'main', timestamp: now, message: { content: [{ type: 'text', text: 'edit' }] } },
      tool('e1', 'Write', { file_path: '/repo/a.js' }),
      tool('e2', 'MultiEdit', { file_path: '/repo/b.js' }),
      tool('e3', 'NotebookEdit', { notebook_path: '/repo/nb.ipynb' }),
      tool('e4', 'Read', { file_path: '/repo/c.js' }),
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.ok(s.filesWritten.includes('a.js'), 'Write recorded');
    assert.ok(s.filesWritten.includes('b.js'), 'MultiEdit recorded');
    assert.ok(s.filesWritten.includes('nb.ipynb'), 'NotebookEdit recorded');
    assert.ok(!s.filesWritten.includes('c.js'), 'Read must not land in filesWritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Skill tool_use blocks are counted per skill name in skillCalls', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-skills-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-888888888888';
    const now = new Date().toISOString();
    const skill = (id, skillName) => ({
      type: 'assistant', requestId: id, timestamp: now,
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: skillName } }] },
    });
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/repo', gitBranch: 'main', entrypoint: 'cli', timestamp: now, message: { content: [{ type: 'text', text: 'go' }] } },
      skill('s1', 'deep-research'),
      skill('s2', 'deep-research'),
      skill('s3', 'worktree'),
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.equal(s.skillCalls['deep-research'], 2);
    assert.equal(s.skillCalls.worktree, 1);
    assert.equal(s.toolCalls.Skill, 3, 'generic tool count still tracked alongside the per-skill breakdown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('entrypoint is captured from the first user message that carries one', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-entrypoint-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-999999999999';
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: sid, cwd: '/repo', gitBranch: 'main', entrypoint: 'claude-vscode', timestamp: now, message: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'user', sessionId: sid, timestamp: now, message: { content: [{ type: 'text', text: 'again' }] } },
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.equal(s.entrypoint, 'claude-vscode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent transcripts under subagents/ are counted and their skill/tool calls merged', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codelens-subagents-'));
  try {
    const proj = path.join(root, 'proj');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
    const now = new Date().toISOString();
    const mainLines = [
      { type: 'user', sessionId: sid, cwd: '/repo', gitBranch: 'main', timestamp: now, message: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', requestId: 'r1', timestamp: now, message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'r1', name: 'Task', input: {} }] } },
    ];
    writeFileSync(path.join(proj, sid + '.jsonl'), mainLines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const subDir = path.join(proj, sid, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const subLines = [
      { type: 'user', timestamp: now, message: { content: [{ type: 'text', text: 'sub task' }] } },
      { type: 'assistant', requestId: 'sr1', timestamp: now, message: { model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: 'tool_use', id: 'sr1', name: 'Skill', input: { skill: 'correctness-review' } }] } },
    ];
    writeFileSync(path.join(subDir, 'agent-1.jsonl'), subLines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const { sessions } = await parseAllProjects(root, 30);
    const s = sessions.find(x => x.sessionId === sid);
    assert.ok(s, 'session should be parsed');
    assert.equal(s.subagentTranscriptCount, 1);
    assert.equal(s.skillCalls['correctness-review'], 1, 'subagent skill calls merge into the parent session');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
