import { test, expect } from '@playwright/test';

test.describe('Dashboard sections', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the app to render (spinner disappears)
    await page.waitForSelector('.stats-section');
  });

  test('Performance Overview section has heading and 4 stat cards', async ({ page }) => {
    const sections = page.locator('.stats-section');
    const perfSection = sections.first();

    await expect(perfSection.locator('h2')).toContainText('Performance Overview');
    const cards = perfSection.locator('.stat-card');
    await expect(cards).toHaveCount(4);

    // Each card should have a glow top-bar
    for (let i = 0; i < 4; i++) {
      await expect(cards.nth(i)).toHaveClass(/glow/);
    }

    // Check labels exist
    await expect(perfSection.locator('.stat-card .label')).toHaveCount(4);
    await expect(perfSection.locator('.stat-card .value')).toHaveCount(4);
  });

  test('Cost Breakdown section has heading and 4 period cards', async ({ page }) => {
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
  });

  test('Token Usage section has heading and 4 styled cards', async ({ page }) => {
    const tokenSection = page.locator('.stats-section').filter({ hasText: 'Token Usage' });

    await expect(tokenSection.locator('h2')).toContainText('Token Usage');
    const cards = tokenSection.locator('.token-stat-card');
    await expect(cards).toHaveCount(4);

    // Each card has a distinct class for its colored top border
    await expect(cards.nth(0)).toHaveClass(/burned/);
    await expect(cards.nth(1)).toHaveClass(/wasted/);
    await expect(cards.nth(2)).toHaveClass(/efficiency/);
    await expect(cards.nth(3)).toHaveClass(/per-commit/);

    // Verify labels are properly capitalized (not ALL-CAPS "WASTED")
    const wastedLabel = cards.nth(1).locator('.label');
    // The CSS text-transform makes it uppercase visually, but the source text should be "Tokens Wasted"
    await expect(wastedLabel).toContainText('Tokens Wasted');

    // All cards should have value and sub elements
    await expect(tokenSection.locator('.token-stat-card .value')).toHaveCount(4);
    await expect(tokenSection.locator('.token-stat-card .sub')).toHaveCount(4);
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

    // Verify border-top-color for each card
    const burnedCard = cards.nth(0);
    const borderColor = await burnedCard.evaluate(el => getComputedStyle(el).borderTopColor);
    // Should not be the default border color — should be a distinct accent color
    expect(borderColor).not.toBe('rgb(255, 255, 255)');
    expect(borderColor).not.toBe('transparent');
  });
});
