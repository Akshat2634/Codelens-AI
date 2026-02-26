import { test, expect } from '@playwright/test';

test.describe('Dashboard sections', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section');
  });

  test('Performance Overview section has 3+1 hero layout with grade ring', async ({ page }) => {
    const sections = page.locator('.stats-section');
    const perfSection = sections.first();

    await expect(perfSection.locator('h2')).toContainText('Performance Overview');
    const cards = perfSection.locator('.stat-card');
    await expect(cards).toHaveCount(4);

    // Each card should have a glow top-bar
    for (let i = 0; i < 4; i++) {
      await expect(cards.nth(i)).toHaveClass(/glow/);
    }

    // Check labels and values exist
    await expect(perfSection.locator('.stat-card .label')).toHaveCount(4);
    await expect(perfSection.locator('.stat-card .value')).toHaveCount(4);

    // 3+1 layout: hero-stats-left wraps the first 3 cards
    await expect(perfSection.locator('.hero-stats-left')).toHaveCount(1);
    await expect(perfSection.locator('.hero-stats-left .stat-card')).toHaveCount(3);

    // Grade card has a grade circle ring
    await expect(perfSection.locator('.grade-circle')).toHaveCount(1);

    // Legend dots on left cards
    await expect(perfSection.locator('.legend-dot')).toHaveCount(3);

    // Legend row below
    await expect(perfSection.locator('.hero-legend')).toHaveCount(1);
    await expect(perfSection.locator('.hero-legend .dot')).toHaveCount(4);
  });

  test('Cost Breakdown section is a compact single-card timeline', async ({ page }) => {
    const costSection = page.locator('.stats-section').filter({ hasText: 'Cost Breakdown' });

    await expect(costSection.locator('h2')).toContainText('Cost Breakdown');
    const cards = costSection.locator('.period-card');
    await expect(cards).toHaveCount(4);

    // Verify each period label
    await expect(cards.nth(0)).toHaveClass(/today/);
    await expect(cards.nth(0).locator('.period-label')).toHaveText('Today');

    await expect(cards.nth(1)).toHaveClass(/week/);
    await expect(cards.nth(1).locator('.period-label')).toHaveText('This Week');

    await expect(cards.nth(2)).toHaveClass(/month/);
    await expect(cards.nth(2).locator('.period-label')).toHaveText('This Month');

    await expect(cards.nth(3)).toHaveClass(/all-time/);
    await expect(cards.nth(3).locator('.period-label')).toHaveText('All Time');

    // Each card should show cost and meta
    for (let i = 0; i < 4; i++) {
      await expect(cards.nth(i).locator('.period-cost')).toContainText('$');
      await expect(cards.nth(i).locator('.period-meta')).toContainText('sessions');
      await expect(cards.nth(i).locator('.period-meta')).toContainText('commits');
    }

    // Single card wrapper (period-stats has background)
    const periodStats = costSection.locator('.period-stats');
    const bg = await periodStats.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)'); // has a solid background

    // Legend row
    await expect(costSection.locator('.cost-legend')).toHaveCount(1);
    await expect(costSection.locator('.cost-legend .dot')).toHaveCount(4);
  });

  test('Token Usage section has visual data indicators', async ({ page }) => {
    const tokenSection = page.locator('.stats-section').filter({ hasText: 'Token Usage' });

    await expect(tokenSection.locator('h2')).toContainText('Token Usage');
    const cards = tokenSection.locator('.token-stat-card');
    await expect(cards).toHaveCount(4);

    // Each card has a distinct class
    await expect(cards.nth(0)).toHaveClass(/burned/);
    await expect(cards.nth(1)).toHaveClass(/wasted/);
    await expect(cards.nth(2)).toHaveClass(/efficiency/);
    await expect(cards.nth(3)).toHaveClass(/per-commit/);

    // Verify label text
    const wastedLabel = cards.nth(1).locator('.label');
    await expect(wastedLabel).toContainText('Tokens Wasted');

    // All cards should have value and sub elements
    await expect(tokenSection.locator('.token-stat-card .value')).toHaveCount(4);
    await expect(tokenSection.locator('.token-stat-card .sub')).toHaveCount(4);

    // Visual indicators:
    // Burned card has stacked bar + legend
    await expect(cards.nth(0).locator('.token-stacked-bar')).toHaveCount(1);
    await expect(cards.nth(0).locator('.token-bar-legend')).toHaveCount(1);

    // Wasted card has waste bar
    await expect(cards.nth(1).locator('.waste-bar')).toHaveCount(1);

    // Efficiency card has SVG gauge
    await expect(cards.nth(2).locator('.efficiency-gauge')).toHaveCount(1);
    await expect(cards.nth(2).locator('.efficiency-gauge svg')).toHaveCount(1);

    // Per-commit card has comparison bars
    await expect(cards.nth(3).locator('.commit-bar-row')).toHaveCount(2);

    // Legend row
    await expect(tokenSection.locator('.token-legend')).toHaveCount(1);
    await expect(tokenSection.locator('.token-legend .dot')).toHaveCount(4);
  });

  test('All three stat sections render in correct order', async ({ page }) => {
    const sections = page.locator('.stats-section');
    await expect(sections).toHaveCount(3);

    await expect(sections.nth(0).locator('h2')).toContainText('Performance Overview');
    await expect(sections.nth(1).locator('h2')).toContainText('Cost Breakdown');
    await expect(sections.nth(2).locator('h2')).toContainText('Token Usage');
  });

  test('Token cards have colored top borders', async ({ page }) => {
    const tokenSection = page.locator('.stats-section').filter({ hasText: 'Token Usage' });
    const cards = tokenSection.locator('.token-stat-card');

    const burnedCard = cards.nth(0);
    const borderColor = await burnedCard.evaluate(el => getComputedStyle(el).borderTopColor);
    expect(borderColor).not.toBe('rgb(255, 255, 255)');
    expect(borderColor).not.toBe('transparent');
  });
});
