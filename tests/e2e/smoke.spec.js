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
});
