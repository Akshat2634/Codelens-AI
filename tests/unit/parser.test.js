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
  isVerificationCommand,
  PRICING,
  parseAllProjects,
  toRelativePath,
} from '../../src/claude-parser.js';

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
  assert.equal(getPricingTier('claude-haiku-4-5'), 'haiku-new');
  assert.equal(getPricingTier('claude-haiku-3-5'), 'haiku-35');
  assert.equal(getPricingTier('claude-3-haiku-20240307'), 'haiku-3');
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
  for (const key of ['opus-48', 'opus-47', 'opus-46', 'opus-45', 'opus-old', 'sonnet', 'sonnet-5-intro', 'haiku-new', 'haiku-35', 'haiku-3']) {
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
  // Unknown models fall back to sonnet pricing — so it won't be 0, but should be deterministic.
  const unknown = calculateCost(1000, 1000, 0, 0, 'gpt-4');
  const sonnet = calculateCost(1000, 1000, 0, 0, 'claude-sonnet-4-5');
  assert.equal(unknown, sonnet);
  // Null model → 0 (no tier)
  assert.equal(calculateCost(1000, 1000, 0, 0, null), 0);
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
