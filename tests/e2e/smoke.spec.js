import { expect, test } from '@playwright/test';

// Smoke E2E — runs against the fixture-backed server (see playwright.config.js).
// The goal is to catch regressions that break rendering end-to-end; not to
// exhaustively verify every component. Full coverage lives in tests/local/.

test.describe('Dashboard smoke (fixtures)', () => {
  test('server responds and API payload is well-formed', async ({ request }) => {
    const res = await request.get('/api/all');
    expect(res.status()).toBe(200);
    const payload = await res.json();
    expect(payload.meta).toBeTruthy();
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(payload.sessions.length).toBeGreaterThan(0);
    expect(payload.summary.totalCost).toBeGreaterThan(0);
    expect(Array.isArray(payload.insights)).toBe(true);
  });

  test('dashboard HTML loads and boots JS without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('.stats-section', { timeout: 15_000 });
    expect(errors, 'JS errors on first paint: ' + errors.join(' | ')).toEqual([]);
  });

  test('Performance Overview section renders with hero stats', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section');
    const heroCards = page.locator('.hero-stats .stat-card');
    await expect(heroCards).toHaveCount(4);
    // Stat values should be populated (not the skeleton "$0.00")
    const spendValue = await page.locator('.cost-card .value').textContent();
    expect(spendValue).toMatch(/\$\d/);
  });

  test('Weekly Narrative renders with fixture data', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.narrative', { timeout: 15_000 });
    const kicker = page.locator('.narrative-kicker');
    await expect(kicker).toHaveText(/Weekly Report/i);
    const headline = page.locator('.narrative-headline');
    await expect(headline).not.toBeEmpty();
    // At least one delta chip rendered
    const metrics = page.locator('.narrative-metric');
    const count = await metrics.count();
    expect(count).toBeGreaterThan(0);
  });

  test('insights section shows at most 8 items', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section');
    const insightCount = await page.locator('.insight-list .insight').count();
    expect(insightCount).toBeLessThanOrEqual(8);
  });

  test('sessions table renders fixture sessions', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sessions-section');
    const rows = page.locator('.sessions-section tbody tr').filter({ hasNot: page.locator('.expand-row') });
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('header + dashboard charts render without throwing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#chart-token-burn');
    await page.waitForSelector('#chart-timeline');
    await page.waitForSelector('#chart-models');
    await page.waitForSelector('#chart-tools');
    await page.waitForSelector('#chart-model-efficiency');
    // Give Chart.js a beat to finish animating
    await page.waitForTimeout(500);
    expect(errors, 'chart JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('per-source API views: claude and codex sessions are split', async ({ request }) => {
    const all = await (await request.get('/api/all')).json();
    expect(all.meta.source).toBe('all');
    expect(all.meta.sources.claude).toBeGreaterThan(0);
    expect(all.meta.sources.codex).toBeGreaterThan(0);

    const codex = await (await request.get('/api/all?source=codex')).json();
    expect(codex.meta.source).toBe('codex');
    expect(codex.sessions.length).toBe(all.meta.sources.codex);
    expect(codex.sessions.every(s => s.source === 'codex')).toBe(true);

    const claude = await (await request.get('/api/all?source=claude')).json();
    expect(claude.meta.source).toBe('claude');
    expect(claude.sessions.every(s => (s.source || 'claude') === 'claude')).toBe(true);
  });

  test('source tabs render and switching to Codex re-renders the dashboard', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Fixtures contain both Claude and Codex sessions, so tabs must show
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    const tabs = page.locator('.source-tabs .source-tab');
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/All Agents/i);

    await page.locator('.source-tabs .source-tab', { hasText: 'OpenAI Codex' }).click();
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/OpenAI Codex/i, { timeout: 10_000 });
    // Sessions table now shows only Codex sessions (GPT models)
    await page.waitForSelector('.sessions-section tbody tr');
    const modelCells = await page.locator('.sessions-section tbody tr:not(.expand-row) td:nth-child(3)').allTextContents();
    expect(modelCells.length).toBeGreaterThan(0);
    for (const cell of modelCells) {
      expect(cell).toMatch(/GPT|Codex|o\d/i);
    }
    expect(errors, 'JS errors during source switch: ' + errors.join(' | ')).toEqual([]);
  });
});

test.describe('UI modernization (brand marks, face-off, command bar)', () => {
  test('agent brand marks render on tabs, sessions table, and footer', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    // Tabs: Claude tab carries the starburst, Codex tab the knot, All both.
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'Claude Code' }).locator('svg[data-agent-logo="claude"]')).toHaveCount(1);
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'OpenAI Codex' }).locator('svg[data-agent-logo="codex"]')).toHaveCount(1);
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'All Agents' }).locator('svg[data-agent-logo]')).toHaveCount(2);
    // Sessions table: every row is stamped with its agent's mark on the mixed view.
    await page.waitForSelector('.sessions-section tbody tr');
    const rows = await page.locator('.sessions-section tbody tr:not(.expand-row)').count();
    const rowMarks = await page.locator('.sessions-section tbody svg[data-agent-logo]').count();
    expect(rowMarks).toBe(rows);
    // Footer carries both marks.
    await expect(page.locator('#footer-agents svg[data-agent-logo]')).toHaveCount(2);
  });

  test('agent face-off renders on All Agents and hides on a per-agent tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.faceoff-section', { timeout: 15_000 });
    // Two cards with brand marks and grade badges, one VS divider. The Claude
    // card wears the mascot (head + watermark); the Codex card keeps the knot.
    await expect(page.locator('.faceoff-card')).toHaveCount(2);
    await expect(page.locator('.faceoff-card svg[data-agent-mascot="claude"]')).toHaveCount(2);
    await expect(page.locator('.faceoff-card svg[data-agent-logo="codex"]')).toHaveCount(2);
    await expect(page.locator('.faceoff-card .grade-badge')).toHaveCount(2);
    await expect(page.locator('.faceoff-vs')).toHaveText('VS');
    const spendRows = page.locator('.faceoff-card .fo-row', { hasText: 'Spend' });
    await expect(spendRows).toHaveCount(2);
    for (const text of await spendRows.allTextContents()) {
      expect(text).toMatch(/\$\d/);
    }
    // Per-agent view: the head-to-head disappears (there is no opponent).
    await page.locator('.source-tabs .source-tab', { hasText: 'Claude Code' }).click();
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/Claude Code/i, { timeout: 10_000 });
    await expect(page.locator('.faceoff-section')).toHaveCount(0);
  });

  test('sticky command bar appears on scroll with mirrored tabs and hides at top', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    const bar = page.locator('#command-bar');
    await expect(bar).not.toHaveClass(/visible/);
    await page.evaluate(() => window.scrollTo(0, 1600));
    await expect(bar).toHaveClass(/visible/, { timeout: 5_000 });
    await expect(page.locator('#command-tabs .source-tab')).toHaveCount(3);
    await expect(page.locator('#command-tabs svg[data-agent-logo]')).toHaveCount(4);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).not.toHaveClass(/visible/, { timeout: 5_000 });
  });

  test('scroll-reveal never leaves sections permanently hidden', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.scroll-reveal');
    // Instant jump to the bottom — the worst case for IntersectionObserver.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // The safety net reveals everything within ~4s even if observation missed.
    await page.waitForTimeout(4_600);
    const hidden = await page.locator('.scroll-reveal:not(.revealed)').count();
    expect(hidden).toBe(0);
  });

  test('share card renders with brand marks and no JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#share-btn');
    await page.click('#share-btn');
    await page.waitForSelector('.share-modal', { state: 'visible' });
    await page.waitForTimeout(1_500); // fonts + canvas draw
    const size = await page.locator('#share-canvas').evaluate(c => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);
    expect(errors, 'share card JS errors: ' + errors.join(' | ')).toEqual([]);
  });
});
