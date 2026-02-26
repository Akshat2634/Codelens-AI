import { test, expect } from '@playwright/test';

test.describe('Dashboard — Complete Top-to-Bottom Tests', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section');
  });

  // ═══════════════════════════════════════════
  // 1. HEADER
  // ═══════════════════════════════════════════
  test.describe('Header', () => {
    test('renders title, tagline, and meta badges', async ({ page }) => {
      const header = page.locator('header');
      await expect(header.locator('h1')).toHaveText('Codelens AI');
      await expect(header.locator('.tagline')).toContainText('token spend');

      const badges = header.locator('.meta-info .badge');
      await expect(badges).toHaveCount(2);
      await expect(badges.nth(0)).toContainText('Last');
      await expect(badges.nth(0)).toContainText('days');
      await expect(badges.nth(1)).toHaveText('All data stays local');
    });
  });

  // ═══════════════════════════════════════════
  // 2. PERFORMANCE OVERVIEW (Section 1)
  // ═══════════════════════════════════════════
  test.describe('Performance Overview', () => {
    test('renders 3+1 hero layout with all stat cards', async ({ page }) => {
      const section = page.locator('.stats-section').first();
      await expect(section.locator('h2')).toContainText('Performance Overview');

      const cards = section.locator('.stat-card');
      await expect(cards).toHaveCount(4);

      // All cards have glow class
      for (let i = 0; i < 4; i++) {
        await expect(cards.nth(i)).toHaveClass(/glow/);
      }

      // Labels and values exist on every card
      await expect(section.locator('.stat-card .label')).toHaveCount(4);
      await expect(section.locator('.stat-card .value')).toHaveCount(4);
    });

    test('has 3+1 layout structure', async ({ page }) => {
      const section = page.locator('.stats-section').first();
      // Left column has 3 cards
      await expect(section.locator('.hero-stats-left')).toHaveCount(1);
      await expect(section.locator('.hero-stats-left .stat-card')).toHaveCount(3);
      // Each left card has a colored legend dot
      await expect(section.locator('.hero-stats-left .legend-dot')).toHaveCount(3);
    });

    test('grade card has circular ring', async ({ page }) => {
      const section = page.locator('.stats-section').first();
      const gradeCard = section.locator('.stat-card.grade');
      await expect(gradeCard).toHaveCount(1);
      await expect(gradeCard.locator('.grade-circle')).toHaveCount(1);
      // Grade letter is visible
      const gradeValue = await gradeCard.locator('.value').textContent();
      expect(['A', 'B', 'C', 'D', 'F']).toContain(gradeValue.trim());
    });

    test('cost card displays dollar amount', async ({ page }) => {
      const costCard = page.locator('.stat-card.cost-card');
      await expect(costCard.locator('.value')).toContainText('$');
      await expect(costCard.locator('.sub')).toContainText('sessions');
    });

    test('commits card displays count', async ({ page }) => {
      const commitsCard = page.locator('.stat-card.commits-card');
      await expect(commitsCard.locator('.sub')).toContainText('lines added');
    });

    test('avg cost card displays value', async ({ page }) => {
      const avgCard = page.locator('.stat-card.avg-card');
      await expect(avgCard.locator('.sub')).toContainText('files changed');
    });

    test('legend row shows 4 color-coded items', async ({ page }) => {
      const legend = page.locator('.hero-legend');
      await expect(legend).toHaveCount(1);
      await expect(legend.locator('.dot')).toHaveCount(4);
      await expect(legend).toContainText('Cost');
      await expect(legend).toContainText('Output');
      await expect(legend).toContainText('Efficiency');
      await expect(legend).toContainText('Grade');
    });
  });

  // ═══════════════════════════════════════════
  // 3. COST BREAKDOWN (Section 2)
  // ═══════════════════════════════════════════
  test.describe('Cost Breakdown', () => {
    test('renders as compact single-card with 4 period columns', async ({ page }) => {
      const section = page.locator('.stats-section').filter({ hasText: 'Cost Breakdown' });
      await expect(section.locator('h2')).toContainText('Cost Breakdown');
      const cards = section.locator('.period-card');
      await expect(cards).toHaveCount(4);
    });

    test('period-stats is a single card (has background)', async ({ page }) => {
      const periodStats = page.locator('.period-stats');
      const bg = await periodStats.evaluate(el => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    });

    test('each period has correct label, cost, and meta', async ({ page }) => {
      const cards = page.locator('.stats-section').filter({ hasText: 'Cost Breakdown' }).locator('.period-card');

      const periods = [
        { cls: 'today', label: 'Today' },
        { cls: 'week', label: 'This Week' },
        { cls: 'month', label: 'This Month' },
        { cls: 'all-time', label: 'All Time' },
      ];

      for (let i = 0; i < 4; i++) {
        await expect(cards.nth(i)).toHaveClass(new RegExp(periods[i].cls));
        await expect(cards.nth(i).locator('.period-label')).toHaveText(periods[i].label);
        await expect(cards.nth(i).locator('.period-cost')).toContainText('$');
        await expect(cards.nth(i).locator('.period-meta')).toContainText('sessions');
        await expect(cards.nth(i).locator('.period-meta')).toContainText('commits');
      }
    });

    test('timeline dots are visible via ::before pseudo-elements', async ({ page }) => {
      const todayCard = page.locator('.period-card.today');
      const beforeHeight = await todayCard.evaluate(el => {
        const style = getComputedStyle(el, '::before');
        return style.height;
      });
      expect(beforeHeight).toBe('12px');
    });

    test('legend row shows 4 period labels', async ({ page }) => {
      const legend = page.locator('.cost-legend');
      await expect(legend).toHaveCount(1);
      await expect(legend.locator('.dot')).toHaveCount(4);
      await expect(legend).toContainText('Today');
      await expect(legend).toContainText('This Week');
      await expect(legend).toContainText('All Time');
    });
  });

  // ═══════════════════════════════════════════
  // 4. TOKEN USAGE (Section 3)
  // ═══════════════════════════════════════════
  test.describe('Token Usage', () => {
    test('renders 4 stat cards with correct classes', async ({ page }) => {
      const section = page.locator('.stats-section').filter({ hasText: 'Token Usage' });
      await expect(section.locator('h2')).toContainText('Token Usage');
      const cards = section.locator('.token-stat-card');
      await expect(cards).toHaveCount(4);

      await expect(cards.nth(0)).toHaveClass(/burned/);
      await expect(cards.nth(1)).toHaveClass(/wasted/);
      await expect(cards.nth(2)).toHaveClass(/efficiency/);
      await expect(cards.nth(3)).toHaveClass(/per-commit/);
    });

    test('all cards have label, value, and sub', async ({ page }) => {
      const section = page.locator('.stats-section').filter({ hasText: 'Token Usage' });
      await expect(section.locator('.token-stat-card .label')).toHaveCount(4);
      await expect(section.locator('.token-stat-card .value')).toHaveCount(4);
      await expect(section.locator('.token-stat-card .sub')).toHaveCount(4);
    });

    test('cards have colored top borders', async ({ page }) => {
      const burnedCard = page.locator('.token-stat-card.burned');
      const borderColor = await burnedCard.evaluate(el => getComputedStyle(el).borderTopColor);
      expect(borderColor).not.toBe('rgb(255, 255, 255)');
      expect(borderColor).not.toBe('transparent');
    });

    test('burned card has stacked bar with input/output legend', async ({ page }) => {
      const card = page.locator('.token-stat-card.burned');
      await expect(card.locator('.token-stacked-bar')).toHaveCount(1);
      const segments = card.locator('.token-stacked-bar .seg');
      await expect(segments).toHaveCount(2);
      // Legend shows Input and Output percentages
      const legend = card.locator('.token-bar-legend');
      await expect(legend).toContainText('Input');
      await expect(legend).toContainText('Output');
    });

    test('wasted card has waste bar with 0%/100% labels', async ({ page }) => {
      const card = page.locator('.token-stat-card.wasted');
      await expect(card.locator('.waste-bar')).toHaveCount(1);
      await expect(card.locator('.waste-bar .fill')).toHaveCount(1);
      const labels = card.locator('.waste-bar-label');
      await expect(labels).toContainText('0%');
      await expect(labels).toContainText('100%');
      await expect(labels).toContainText('wasted');
    });

    test('efficiency card has SVG ring gauge', async ({ page }) => {
      const card = page.locator('.token-stat-card.efficiency');
      await expect(card.locator('.efficiency-gauge')).toHaveCount(1);
      await expect(card.locator('.efficiency-gauge svg')).toHaveCount(1);
      await expect(card.locator('.efficiency-gauge svg circle')).toHaveCount(2); // track + fill
      await expect(card.locator('.efficiency-gauge .gauge-value')).toContainText('%');
    });

    test('per-commit card has 2 comparison bars', async ({ page }) => {
      const card = page.locator('.token-stat-card.per-commit');
      await expect(card.locator('.commit-bar-row')).toHaveCount(2);
      await expect(card.locator('.commit-bar-row .bar-track')).toHaveCount(2);
      await expect(card.locator('.commit-bar-row .bar-fill')).toHaveCount(2);
      // Labels
      await expect(card.locator('.commit-bar-row').first()).toContainText('/ commit');
      await expect(card.locator('.commit-bar-row').last()).toContainText('/ line');
    });

    test('legend row shows 4 token categories', async ({ page }) => {
      const legend = page.locator('.token-legend');
      await expect(legend).toHaveCount(1);
      await expect(legend.locator('.dot')).toHaveCount(4);
      await expect(legend).toContainText('Total Burned');
      await expect(legend).toContainText('Wasted');
      await expect(legend).toContainText('Efficient');
      await expect(legend).toContainText('Per Commit');
    });

    test('wasted label text is properly capitalized', async ({ page }) => {
      const label = page.locator('.token-stat-card.wasted .label');
      await expect(label).toContainText('Tokens Wasted');
    });
  });

  // ═══════════════════════════════════════════
  // 5. TOKEN FUNNEL
  // ═══════════════════════════════════════════
  test.describe('Token Funnel', () => {
    test('renders "Where Did Your Tokens Go?" card', async ({ page }) => {
      const funnel = page.locator('.token-funnel');
      await expect(funnel).toHaveCount(1);
      await expect(funnel.locator('h3')).toContainText('Where Did Your Tokens Go?');
    });

    test('has two funnel rows: By Type and By Outcome', async ({ page }) => {
      const funnel = page.locator('.token-funnel');
      const rows = funnel.locator('.funnel-row');
      await expect(rows).toHaveCount(2);

      // By Type
      await expect(rows.first().locator('.funnel-label-row .name')).toHaveText('By Type');
      // By Outcome
      await expect(rows.last().locator('.funnel-label-row .name')).toHaveText('By Outcome');
    });

    test('By Type funnel has 4 segments with legend', async ({ page }) => {
      const byType = page.locator('.token-funnel .funnel-row').first();
      const segments = byType.locator('.funnel-bar .segment');
      await expect(segments).toHaveCount(4);
      const legend = byType.locator('.funnel-legend');
      await expect(legend).toContainText('Input');
      await expect(legend).toContainText('Output');
      await expect(legend).toContainText('Cache Read');
      await expect(legend).toContainText('Cache Write');
    });

    test('By Outcome funnel has 3 segments with legend', async ({ page }) => {
      const byOutcome = page.locator('.token-funnel .funnel-row').last();
      const segments = byOutcome.locator('.funnel-bar .segment');
      await expect(segments).toHaveCount(3);
      const legend = byOutcome.locator('.funnel-legend');
      await expect(legend).toContainText('Productive');
      await expect(legend).toContainText('Exploratory');
      await expect(legend).toContainText('WASTED');
    });

    test('funnel bars have visible height', async ({ page }) => {
      const bar = page.locator('.token-funnel .funnel-bar').first();
      const height = await bar.evaluate(el => el.offsetHeight);
      expect(height).toBeGreaterThanOrEqual(32);
    });
  });

  // ═══════════════════════════════════════════
  // 6. SCALE CHECK / FUN FACTS
  // ═══════════════════════════════════════════
  test.describe('Scale Check', () => {
    test('renders fun facts section if data exists', async ({ page }) => {
      const scaleCheck = page.locator('.insights').filter({ hasText: 'Scale Check' });
      // May or may not exist depending on data — just check structure if present
      const count = await scaleCheck.count();
      if (count > 0) {
        await expect(scaleCheck.locator('h2')).toHaveText('Scale Check');
        const facts = scaleCheck.locator('.insight.info');
        expect(await facts.count()).toBeGreaterThan(0);
        // Each fact has ~ icon
        await expect(facts.first().locator('.icon')).toHaveText('~');
      }
    });
  });

  // ═══════════════════════════════════════════
  // 7. INSIGHTS
  // ═══════════════════════════════════════════
  test.describe('Insights', () => {
    test('renders insight cards with icons', async ({ page }) => {
      const insights = page.locator('.insights').filter({ hasText: 'Insights' });
      const count = await insights.count();
      if (count > 0) {
        await expect(insights.locator('h2')).toContainText('Insights');
        const cards = insights.locator('.insight');
        expect(await cards.count()).toBeGreaterThan(0);
        // Each insight has icon + text
        await expect(cards.first().locator('.icon')).toBeVisible();
      }
    });
  });

  // ═══════════════════════════════════════════
  // 8. CHARTS GRID
  // ═══════════════════════════════════════════
  test.describe('Charts Grid', () => {
    test('renders 6 chart cards in a grid', async ({ page }) => {
      const grid = page.locator('.charts-grid');
      await expect(grid).toHaveCount(1);
      const chartCards = grid.locator('.chart-card');
      await expect(chartCards).toHaveCount(6);
    });

    test('first 2 chart cards are full-width', async ({ page }) => {
      const fullWidth = page.locator('.charts-grid .chart-card.full-width');
      await expect(fullWidth).toHaveCount(2);
    });

    test('Token Burn Rate chart card exists with canvas', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').first();
      await expect(card.locator('h3')).toContainText('Token Burn Rate');
      await expect(card.locator('canvas#chart-token-burn')).toHaveCount(1);
    });

    test('Cost vs Output chart card has Log scale toggle', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').nth(1);
      await expect(card.locator('h3')).toContainText('Cost vs Output');
      await expect(card.locator('canvas#chart-timeline')).toHaveCount(1);
      const toggle = card.locator('.scale-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveText('Log scale');
    });

    test('Model Cost Breakdown chart card exists', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').nth(2);
      await expect(card.locator('h3')).toContainText('Model Cost Breakdown');
      await expect(card.locator('canvas#chart-models')).toHaveCount(1);
    });

    test('Tool Usage Distribution chart card exists', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').nth(3);
      await expect(card.locator('h3')).toContainText('Tool Usage Distribution');
      await expect(card.locator('canvas#chart-tools')).toHaveCount(1);
    });

    test('Session Length vs Efficiency chart card exists', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').nth(4);
      await expect(card.locator('h3')).toContainText('Session Length vs Efficiency');
      await expect(card.locator('canvas#chart-buckets')).toHaveCount(1);
    });

    test('Productivity Heatmap card has container', async ({ page }) => {
      const card = page.locator('.charts-grid .chart-card').nth(5);
      await expect(card.locator('h3')).toContainText('Productivity Heatmap');
      await expect(card.locator('#heatmap-container')).toHaveCount(1);
    });

    test('each chart card has info-tip tooltip', async ({ page }) => {
      const chartCards = page.locator('.charts-grid .chart-card');
      const count = await chartCards.count();
      for (let i = 0; i < count; i++) {
        await expect(chartCards.nth(i).locator('.info-tip')).toHaveCount(1);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 9. CACHE EFFICIENCY
  // ═══════════════════════════════════════════
  test.describe('Cache Efficiency', () => {
    test('renders cache efficiency card with progress bar', async ({ page }) => {
      const cacheSection = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' });
      await expect(cacheSection).toHaveCount(1);
      await expect(cacheSection.locator('h3')).toContainText('Cache Efficiency');
      await expect(cacheSection.locator('.survival-bar')).toHaveCount(1);
      await expect(cacheSection.locator('.survival-bar .fill')).toHaveCount(1);
    });

    test('displays cache stats: tokens, fresh input, savings, hit rate', async ({ page }) => {
      const stats = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' }).locator('.survival-stats');
      await expect(stats).toContainText('tokens from cache');
      await expect(stats).toContainText('fresh input tokens');
      await expect(stats).toContainText('saved');
      await expect(stats).toContainText('cache hit rate');
    });
  });

  // ═══════════════════════════════════════════
  // 10. LINE SURVIVAL RATE
  // ═══════════════════════════════════════════
  test.describe('Line Survival Rate', () => {
    test('renders survival card with progress bar', async ({ page }) => {
      const survivalSection = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' });
      await expect(survivalSection).toHaveCount(1);
      await expect(survivalSection.locator('h3')).toContainText('Line Survival Rate');
      await expect(survivalSection.locator('.survival-bar')).toHaveCount(1);
      await expect(survivalSection.locator('.survival-bar .fill')).toHaveCount(1);
    });

    test('displays survival stats', async ({ page }) => {
      const stats = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' }).locator('.survival-stats');
      await expect(stats).toContainText('lines added');
      await expect(stats).toContainText('churned within 24h');
      await expect(stats).toContainText('surviving');
      await expect(stats).toContainText('survival rate');
    });
  });

  // ═══════════════════════════════════════════
  // 11. SESSIONS TABLE
  // ═══════════════════════════════════════════
  test.describe('Sessions Table', () => {
    test('renders sessions section with count in heading', async ({ page }) => {
      const section = page.locator('.sessions-section');
      await expect(section).toHaveCount(1);
      const heading = section.locator('h2');
      await expect(heading).toContainText('Sessions');
      // Should show count in parens, e.g. "Sessions (5)"
      const text = await heading.textContent();
      expect(text).toMatch(/Sessions \(\d+\)/);
    });

    test('table has 8 column headers', async ({ page }) => {
      const headers = page.locator('.sessions-table-wrap thead th');
      await expect(headers).toHaveCount(8);
      await expect(headers.nth(0)).toContainText('Date');
      await expect(headers.nth(1)).toContainText('Project');
      await expect(headers.nth(2)).toContainText('Model');
      await expect(headers.nth(3)).toContainText('Msgs');
      await expect(headers.nth(4)).toContainText('Cost');
      await expect(headers.nth(5)).toContainText('Commits');
      await expect(headers.nth(6)).toContainText('Lines');
      await expect(headers.nth(7)).toContainText('Grade');
    });

    test('table has at least one data row', async ({ page }) => {
      const rows = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)');
      expect(await rows.count()).toBeGreaterThan(0);
    });

    test('each session row displays grade badge', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const badge = firstRow.locator('.grade-badge');
      await expect(badge).toHaveCount(1);
      const grade = await badge.textContent();
      expect(['A', 'B', 'C', 'D', 'F']).toContain(grade.trim());
    });

    test('session row shows cost with dollar sign', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const costCell = firstRow.locator('td').nth(4);
      await expect(costCell).toContainText('$');
    });

    test('session row shows lines added/deleted with +/- format', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const linesCell = firstRow.locator('td').nth(6);
      const text = await linesCell.textContent();
      expect(text).toMatch(/\+[\d,]+/); // +N format
      expect(text).toMatch(/-[\d,]+/);  // -N format
    });

    test('clicking a row toggles expand section', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const expandRow = page.locator('#expand-0');
      // Initially hidden
      await expect(expandRow).not.toHaveClass(/open/);
      // Click to expand
      await firstRow.click();
      await expect(expandRow).toHaveClass(/open/);
      // Click again to collapse
      await firstRow.click();
      await expect(expandRow).not.toHaveClass(/open/);
    });

    test('sortable columns have click handlers', async ({ page }) => {
      const dateHeader = page.locator('th').filter({ hasText: 'Date' });
      // Default sort is by startTime descending
      await expect(dateHeader).toHaveClass(/sorted/);
      // Click Cost header to sort by cost
      const costHeader = page.locator('th').filter({ hasText: 'Cost' });
      await costHeader.click();
      await expect(costHeader).toHaveClass(/sorted/);
      // Date header should no longer be sorted
      await expect(dateHeader).not.toHaveClass(/sorted/);
    });

    test('pagination controls are present', async ({ page }) => {
      const pagination = page.locator('.pagination');
      await expect(pagination).toHaveCount(1);
      await expect(pagination.locator('button')).toHaveCount(2);
      await expect(pagination).toContainText('Page');
      await expect(pagination).toContainText('of');
    });
  });

  // ═══════════════════════════════════════════
  // 12. FOOTER
  // ═══════════════════════════════════════════
  test.describe('Footer', () => {
    test('renders footer with credits and links', async ({ page }) => {
      const footer = page.locator('footer');
      await expect(footer).toBeVisible();
      await expect(footer).toContainText('Made by');
      await expect(footer).toContainText('Akshat');
      await expect(footer).toContainText('Claude Code');
      await expect(footer).toContainText('GitHub');
    });

    test('footer links are valid', async ({ page }) => {
      const footer = page.locator('footer');
      const links = footer.locator('a');
      expect(await links.count()).toBeGreaterThanOrEqual(3);

      // Akshat LinkedIn
      await expect(links.first()).toHaveAttribute('href', /linkedin/);
      // GitHub
      await expect(footer.locator('a[href*="github.com"]').first()).toBeVisible();
    });

    test('footer has cost disclaimer', async ({ page }) => {
      const footer = page.locator('footer');
      await expect(footer).toContainText('Cost estimates are approximate');
    });
  });

  // ═══════════════════════════════════════════
  // 13. INFO TOOLTIPS (across all sections)
  // ═══════════════════════════════════════════
  test.describe('Info Tooltips', () => {
    test('info-tip elements exist throughout the page', async ({ page }) => {
      const tips = page.locator('.info-tip');
      expect(await tips.count()).toBeGreaterThan(10);
    });

    test('info-tip elements have data-tip attribute', async ({ page }) => {
      const firstTip = page.locator('.info-tip').first();
      const dataTip = await firstTip.getAttribute('data-tip');
      expect(dataTip).toBeTruthy();
      expect(dataTip.length).toBeGreaterThan(10);
    });
  });

  // ═══════════════════════════════════════════
  // 14. SECTION ORDER (integration)
  // ═══════════════════════════════════════════
  test.describe('Section Order', () => {
    test('all 3 stats sections render in correct order', async ({ page }) => {
      const sections = page.locator('.stats-section');
      await expect(sections).toHaveCount(3);
      await expect(sections.nth(0).locator('h2')).toContainText('Performance Overview');
      await expect(sections.nth(1).locator('h2')).toContainText('Cost Breakdown');
      await expect(sections.nth(2).locator('h2')).toContainText('Token Usage');
    });

    test('full page order: hero → cost → tokens → funnel → insights → charts → cache → survival → sessions', async ({ page }) => {
      const app = page.locator('#app');

      // These sections appear in order within #app
      const heroY = await page.locator('.hero-stats').evaluate(el => el.getBoundingClientRect().top);
      const costY = await page.locator('.period-stats').evaluate(el => el.getBoundingClientRect().top);
      const tokenY = await page.locator('.token-stats').evaluate(el => el.getBoundingClientRect().top);
      const funnelY = await page.locator('.token-funnel').evaluate(el => el.getBoundingClientRect().top);
      const chartsY = await page.locator('.charts-grid').evaluate(el => el.getBoundingClientRect().top);
      const sessionsY = await page.locator('.sessions-section').evaluate(el => el.getBoundingClientRect().top);

      expect(heroY).toBeLessThan(costY);
      expect(costY).toBeLessThan(tokenY);
      expect(tokenY).toBeLessThan(funnelY);
      expect(funnelY).toBeLessThan(chartsY);
      expect(chartsY).toBeLessThan(sessionsY);
    });
  });

  // ═══════════════════════════════════════════
  // 15. DARK THEME & VISUAL CONSISTENCY
  // ═══════════════════════════════════════════
  test.describe('Visual', () => {
    test('page uses dark background', async ({ page }) => {
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // Should be dark: #0d1117 → rgb(13, 17, 23)
      expect(bg).toBe('rgb(13, 17, 23)');
    });

    test('hero stat cards have visible colored top bars via ::before', async ({ page }) => {
      const costCard = page.locator('.stat-card.cost-card');
      const beforeBg = await costCard.evaluate(el => getComputedStyle(el, '::before').background);
      // Should contain the accent-orange color
      expect(beforeBg).toBeTruthy();
    });
  });
});
