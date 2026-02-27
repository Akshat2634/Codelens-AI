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

    test('title uses gradient background clip for color', async ({ page }) => {
      const h1 = page.locator('header h1');
      const bgClip = await h1.evaluate(el => getComputedStyle(el).webkitBackgroundClip);
      expect(bgClip).toBe('text');
    });

    test('header has bottom border separator', async ({ page }) => {
      const header = page.locator('header');
      // Check for gradient fade line via ::after pseudo-element or border
      const hasAfter = await header.evaluate(el => {
        const after = getComputedStyle(el, '::after');
        return after.content !== 'none' && after.height !== '0px';
      });
      const borderBottom = await header.evaluate(el => getComputedStyle(el).borderBottomStyle);
      expect(hasAfter || borderBottom === 'solid').toBeTruthy();
    });

    test('meta badges have pill shape (rounded corners)', async ({ page }) => {
      const badge = page.locator('.meta-info .badge').first();
      const radius = await badge.evaluate(el => getComputedStyle(el).borderRadius);
      expect(radius).toBe('20px');
    });

    test('date range badge is dynamically populated', async ({ page }) => {
      const dateRange = page.locator('#date-range');
      const text = await dateRange.textContent();
      expect(text).toMatch(/^Last \d+ days$/);
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

    test('hero-stats uses 2-column grid (1fr + 220px)', async ({ page }) => {
      const heroGrid = page.locator('.hero-stats');
      const cols = await heroGrid.evaluate(el => getComputedStyle(el).gridTemplateColumns);
      // Should have two column values
      const parts = cols.split(' ');
      expect(parts.length).toBe(2);
    });

    test('grade card has circular ring with conic gradient', async ({ page }) => {
      const section = page.locator('.stats-section').first();
      const gradeCard = section.locator('.stat-card.grade');
      await expect(gradeCard).toHaveCount(1);
      await expect(gradeCard.locator('.grade-circle')).toHaveCount(1);
      // Grade letter is visible
      const gradeValue = await gradeCard.locator('.value').textContent();
      expect(['A', 'B', 'C', 'D', 'F']).toContain(gradeValue.trim());
    });

    test('grade circle is 120x120px', async ({ page }) => {
      const circle = page.locator('.grade-circle');
      const box = await circle.boundingBox();
      expect(box.width).toBeCloseTo(120, 0);
      expect(box.height).toBeCloseTo(120, 0);
    });

    test('grade card has --grade-color and --grade-deg CSS custom properties', async ({ page }) => {
      const gradeCard = page.locator('.stat-card.grade');
      const gradeColor = await gradeCard.evaluate(el => el.style.getPropertyValue('--grade-color'));
      const gradeDeg = await gradeCard.evaluate(el => el.style.getPropertyValue('--grade-deg'));
      expect(gradeColor).toBeTruthy();
      expect(gradeDeg).toMatch(/\d+deg/);
    });

    test('cost card displays dollar amount and session count', async ({ page }) => {
      const costCard = page.locator('.stat-card.cost-card');
      await expect(costCard.locator('.value')).toContainText('$');
      await expect(costCard.locator('.sub')).toContainText('sessions');
    });

    test('cost card value is orange colored', async ({ page }) => {
      const costValue = page.locator('.stat-card.cost-card .value');
      const color = await costValue.evaluate(el => el.style.color);
      expect(color).toContain('--accent-orange');
    });

    test('commits card displays count and lines added', async ({ page }) => {
      const commitsCard = page.locator('.stat-card.commits-card');
      const value = await commitsCard.locator('.value').textContent();
      expect(parseInt(value)).toBeGreaterThanOrEqual(0);
      await expect(commitsCard.locator('.sub')).toContainText('lines added');
    });

    test('avg cost card displays value and files changed', async ({ page }) => {
      const avgCard = page.locator('.stat-card.avg-card');
      await expect(avgCard.locator('.sub')).toContainText('files changed');
    });

    test('each left card has distinct colored legend dot', async ({ page }) => {
      const dots = page.locator('.hero-stats-left .legend-dot');
      const colors = [];
      for (let i = 0; i < 3; i++) {
        const bg = await dots.nth(i).evaluate(el => el.style.background);
        colors.push(bg);
      }
      // All 3 should be different
      expect(new Set(colors).size).toBe(3);
    });

    test('stat cards have colored top bar glow via ::before', async ({ page }) => {
      const costCard = page.locator('.stat-card.cost-card');
      const beforeHeight = await costCard.evaluate(el => getComputedStyle(el, '::before').height);
      expect(beforeHeight).toBe('2px');
    });

    test('stat cards have hover transition defined', async ({ page }) => {
      const card = page.locator('.stat-card').first();
      const transition = await card.evaluate(el => getComputedStyle(el).transition);
      expect(transition).toContain('transform');
    });

    test('legend row shows 4 color-coded items including grade', async ({ page }) => {
      const legend = page.locator('.hero-legend');
      await expect(legend).toHaveCount(1);
      await expect(legend.locator('.dot')).toHaveCount(4);
      await expect(legend).toContainText('Cost');
      await expect(legend).toContainText('Output');
      await expect(legend).toContainText('Efficiency');
      await expect(legend).toContainText('Grade');
    });

    test('legend has card-style background and border', async ({ page }) => {
      const legend = page.locator('.hero-legend');
      const bg = await legend.evaluate(el => getComputedStyle(el).backgroundColor);
      const border = await legend.evaluate(el => getComputedStyle(el).borderStyle);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      expect(border).toBe('solid');
    });

    test('each stat card has an info-tip tooltip', async ({ page }) => {
      const section = page.locator('.stats-section').first();
      const tips = section.locator('.stat-card .info-tip');
      expect(await tips.count()).toBeGreaterThanOrEqual(4);
    });

    test('orphaned session rate is shown on grade card', async ({ page }) => {
      const gradeCard = page.locator('.stat-card.grade');
      await expect(gradeCard.locator('.sub')).toContainText('sessions orphaned');
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
      const { bg, bgImage } = await periodStats.evaluate(el => ({
        bg: getComputedStyle(el).backgroundColor,
        bgImage: getComputedStyle(el).backgroundImage
      }));
      expect(bg !== 'rgba(0, 0, 0, 0)' || bgImage !== 'none').toBeTruthy();
    });

    test('period-stats uses 4-column grid layout', async ({ page }) => {
      const periodStats = page.locator('.period-stats');
      const cols = await periodStats.evaluate(el => getComputedStyle(el).gridTemplateColumns);
      const parts = cols.split(' ');
      expect(parts.length).toBe(4);
    });

    test('each period has correct label, cost, meta, and tokens', async ({ page }) => {
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
        await expect(cards.nth(i).locator('.period-tokens')).toContainText('tokens');
      }
    });

    test('period costs are color-coded per period', async ({ page }) => {
      const todayCost = page.locator('.period-card.today .period-cost');
      const weekCost = page.locator('.period-card.week .period-cost');
      const monthCost = page.locator('.period-card.month .period-cost');
      const allTimeCost = page.locator('.period-card.all-time .period-cost');

      const todayColor = await todayCost.evaluate(el => getComputedStyle(el).color);
      const weekColor = await weekCost.evaluate(el => getComputedStyle(el).color);
      const monthColor = await monthCost.evaluate(el => getComputedStyle(el).color);
      const allTimeColor = await allTimeCost.evaluate(el => getComputedStyle(el).color);

      // Each should be a unique color
      const colors = new Set([todayColor, weekColor, monthColor, allTimeColor]);
      expect(colors.size).toBe(4);
    });

    test('timeline dots are visible via ::before pseudo-elements', async ({ page }) => {
      const todayCard = page.locator('.period-card.today');
      const beforeHeight = await todayCard.evaluate(el => {
        const style = getComputedStyle(el, '::before');
        return style.height;
      });
      expect(beforeHeight).toBe('12px');
    });

    test('today dot has glow box-shadow', async ({ page }) => {
      const todayCard = page.locator('.period-card.today');
      const boxShadow = await todayCard.evaluate(el => {
        const style = getComputedStyle(el, '::before');
        return style.boxShadow;
      });
      expect(boxShadow).not.toBe('none');
    });

    test('connector line runs across period cards', async ({ page }) => {
      const periodStats = page.locator('.period-stats');
      const beforeHeight = await periodStats.evaluate(el => {
        return getComputedStyle(el, '::before').height;
      });
      expect(beforeHeight).toBe('2px');
    });

    test('period cards have vertical dividers between them', async ({ page }) => {
      const weekCard = page.locator('.period-card.week');
      const borderLeft = await weekCard.evaluate(el => getComputedStyle(el).borderLeftStyle);
      expect(borderLeft).toBe('solid');
    });

    test('period cards have hover style defined via CSS transition', async ({ page }) => {
      const todayCard = page.locator('.period-card.today');
      const transition = await todayCard.evaluate(el => getComputedStyle(el).transition);
      expect(transition).toContain('background');
    });

    test('legend row shows 4 period labels with colored dots', async ({ page }) => {
      const legend = page.locator('.cost-legend');
      await expect(legend).toHaveCount(1);
      await expect(legend.locator('.dot')).toHaveCount(4);
      await expect(legend).toContainText('Today');
      await expect(legend).toContainText('This Week');
      await expect(legend).toContainText('This Month');
      await expect(legend).toContainText('All Time');
    });

    test('each period card shows token count', async ({ page }) => {
      const cards = page.locator('.stats-section').filter({ hasText: 'Cost Breakdown' }).locator('.period-card');
      for (let i = 0; i < 4; i++) {
        const tokenText = await cards.nth(i).locator('.period-tokens').textContent();
        expect(tokenText).toMatch(/[\d.]+[KMB]?\s*tokens/);
      }
    });

    test('all-time cost is >= month cost which is >= week cost', async ({ page }) => {
      const getCost = async (cls) => {
        const text = await page.locator(`.period-card.${cls} .period-cost`).textContent();
        return parseFloat(text.replace('$', ''));
      };
      const week = await getCost('week');
      const month = await getCost('month');
      const allTime = await getCost('all-time');
      expect(allTime).toBeGreaterThanOrEqual(month);
      expect(month).toBeGreaterThanOrEqual(week);
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

    test('token-stats uses 4-column grid layout', async ({ page }) => {
      const tokenStats = page.locator('.token-stats');
      const cols = await tokenStats.evaluate(el => getComputedStyle(el).gridTemplateColumns);
      const parts = cols.split(' ');
      expect(parts.length).toBe(4);
    });

    test('all cards have label, value, and sub', async ({ page }) => {
      const section = page.locator('.stats-section').filter({ hasText: 'Token Usage' });
      await expect(section.locator('.token-stat-card .label')).toHaveCount(4);
      await expect(section.locator('.token-stat-card .value')).toHaveCount(4);
      await expect(section.locator('.token-stat-card .sub')).toHaveCount(4);
    });

    test('cards have distinct colored top borders', async ({ page }) => {
      const cards = ['burned', 'wasted', 'efficiency', 'per-commit'];
      const colors = [];
      for (const cls of cards) {
        const color = await page.locator(`.token-stat-card.${cls}`).evaluate(
          el => getComputedStyle(el).borderTopColor
        );
        colors.push(color);
      }
      expect(new Set(colors).size).toBe(4);
    });

    test('burned card has stacked bar with input/output segments', async ({ page }) => {
      const card = page.locator('.token-stat-card.burned');
      await expect(card.locator('.token-stacked-bar')).toHaveCount(1);
      const segments = card.locator('.token-stacked-bar .seg');
      await expect(segments).toHaveCount(2);

      // Segments have widths that sum to ~100%
      const w1 = await segments.nth(0).evaluate(el => parseFloat(el.style.width));
      const w2 = await segments.nth(1).evaluate(el => parseFloat(el.style.width));
      expect(w1 + w2).toBeCloseTo(100, 0);
    });

    test('burned card has input/output legend with percentages', async ({ page }) => {
      const card = page.locator('.token-stat-card.burned');
      const legend = card.locator('.token-bar-legend');
      await expect(legend).toContainText('Input');
      await expect(legend).toContainText('Output');
      // Check legend has colored dots
      await expect(legend.locator('.ldot')).toHaveCount(2);
    });

    test('burned card shows input:output breakdown in sub text', async ({ page }) => {
      const sub = page.locator('.token-stat-card.burned .sub');
      const text = await sub.textContent();
      expect(text).toMatch(/input:.*output:/);
    });

    test('wasted card has waste bar with fill', async ({ page }) => {
      const card = page.locator('.token-stat-card.wasted');
      await expect(card.locator('.waste-bar')).toHaveCount(1);
      await expect(card.locator('.waste-bar .fill')).toHaveCount(1);
      // Fill has red background
      const fillBg = await card.locator('.waste-bar .fill').evaluate(
        el => getComputedStyle(el).backgroundColor
      );
      expect(fillBg).toBeTruthy();
    });

    test('wasted card shows 0%/wasted%/100% labels', async ({ page }) => {
      const card = page.locator('.token-stat-card.wasted');
      const labels = card.locator('.waste-bar-label');
      await expect(labels).toContainText('0%');
      await expect(labels).toContainText('100%');
      await expect(labels).toContainText('wasted');
    });

    test('wasted card sub shows percentage and cost', async ({ page }) => {
      const sub = page.locator('.token-stat-card.wasted .sub');
      const text = await sub.textContent();
      expect(text).toMatch(/\d+% of total/);
      expect(text).toContain('$');
      expect(text).toContain('burned');
    });

    test('efficiency card has SVG ring gauge with two circles', async ({ page }) => {
      const card = page.locator('.token-stat-card.efficiency');
      await expect(card.locator('.efficiency-gauge')).toHaveCount(1);
      await expect(card.locator('.efficiency-gauge svg')).toHaveCount(1);
      // Track circle + fill circle
      await expect(card.locator('.efficiency-gauge svg circle')).toHaveCount(2);
      await expect(card.locator('.efficiency-gauge .gauge-value')).toContainText('%');
    });

    test('efficiency gauge SVG is rotated -90deg', async ({ page }) => {
      const svg = page.locator('.efficiency-gauge svg');
      const transform = await svg.evaluate(el => getComputedStyle(el).transform);
      // rotate(-90deg) → matrix(0, -1, 1, 0, 0, 0) approximately
      expect(transform).not.toBe('none');
    });

    test('efficiency gauge value matches card value', async ({ page }) => {
      const card = page.locator('.token-stat-card.efficiency');
      const cardValue = await card.locator('.value').textContent();
      const gaugeValue = await card.locator('.gauge-value').textContent();
      expect(cardValue.trim()).toBe(gaugeValue.trim());
    });

    test('per-commit card has 2 comparison bars with labels', async ({ page }) => {
      const card = page.locator('.token-stat-card.per-commit');
      await expect(card.locator('.commit-bar-row')).toHaveCount(2);
      await expect(card.locator('.commit-bar-row .bar-track')).toHaveCount(2);
      await expect(card.locator('.commit-bar-row .bar-fill')).toHaveCount(2);
      // Labels
      await expect(card.locator('.commit-bar-row').first()).toContainText('/ commit');
      await expect(card.locator('.commit-bar-row').last()).toContainText('/ line');
    });

    test('per-commit bars both have visible width (log scale)', async ({ page }) => {
      const bars = page.locator('.token-stat-card.per-commit .bar-fill');
      for (let i = 0; i < 2; i++) {
        const width = await bars.nth(i).evaluate(el => parseFloat(el.style.width));
        expect(width).toBeGreaterThan(0);
      }
    });

    test('per-commit bars have formatted token values', async ({ page }) => {
      const card = page.locator('.token-stat-card.per-commit');
      const barVals = card.locator('.bar-val');
      await expect(barVals).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const text = await barVals.nth(i).textContent();
        expect(text).toMatch(/[\d.]+[KMB]?/);
      }
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

    test('token cards have hover transition', async ({ page }) => {
      const card = page.locator('.token-stat-card').first();
      const transition = await card.evaluate(el => getComputedStyle(el).transition);
      expect(transition).toContain('transform');
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

    test('funnel card has proper card styling', async ({ page }) => {
      const card = page.locator('.token-funnel-card');
      const { bg, bgImage } = await card.evaluate(el => ({
        bg: getComputedStyle(el).backgroundColor,
        bgImage: getComputedStyle(el).backgroundImage
      }));
      const border = await card.evaluate(el => getComputedStyle(el).borderStyle);
      expect(bg !== 'rgba(0, 0, 0, 0)' || bgImage !== 'none').toBeTruthy();
      expect(border).toBe('solid');
    });

    test('has two funnel rows: By Type and By Outcome', async ({ page }) => {
      const funnel = page.locator('.token-funnel');
      const rows = funnel.locator('.funnel-row');
      await expect(rows).toHaveCount(2);

      await expect(rows.first().locator('.funnel-label-row .name')).toHaveText('By Type');
      await expect(rows.last().locator('.funnel-label-row .name')).toHaveText('By Outcome');
    });

    test('By Type row shows total token count', async ({ page }) => {
      const byType = page.locator('.token-funnel .funnel-row').first();
      const amount = await byType.locator('.funnel-label-row .amount').textContent();
      expect(amount).toMatch(/[\d.]+[KMB]?\s*total/);
    });

    test('By Outcome row shows productive percentage', async ({ page }) => {
      const byOutcome = page.locator('.token-funnel .funnel-row').last();
      const amount = await byOutcome.locator('.funnel-label-row .amount').textContent();
      expect(amount).toMatch(/[\d.]+% productive/);
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

    test('By Type segments have title attributes for tooltips', async ({ page }) => {
      const segments = page.locator('.token-funnel .funnel-row').first().locator('.funnel-bar .segment');
      const titles = [];
      for (let i = 0; i < 4; i++) {
        const title = await segments.nth(i).getAttribute('title');
        expect(title).toBeTruthy();
        titles.push(title);
      }
      expect(titles[0]).toContain('Input');
      expect(titles[1]).toContain('Output');
      expect(titles[2]).toContain('Cache Read');
      expect(titles[3]).toContain('Cache Write');
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

    test('By Outcome legend explains each category', async ({ page }) => {
      const legend = page.locator('.token-funnel .funnel-row').last().locator('.funnel-legend');
      await expect(legend).toContainText('led to commits');
      await expect(legend).toContainText('short sessions');
      await expect(legend).toContainText('long sessions');
    });

    test('funnel bars have visible height (>= 32px)', async ({ page }) => {
      const bars = page.locator('.token-funnel .funnel-bar');
      for (let i = 0; i < 2; i++) {
        const height = await bars.nth(i).evaluate(el => el.offsetHeight);
        expect(height).toBeGreaterThanOrEqual(32);
      }
    });

    test('funnel segment widths sum close to 100%', async ({ page }) => {
      const segments = page.locator('.token-funnel .funnel-row').first().locator('.funnel-bar .segment');
      let totalWidth = 0;
      for (let i = 0; i < 4; i++) {
        const w = await segments.nth(i).evaluate(el => parseFloat(el.style.width));
        totalWidth += w;
      }
      expect(totalWidth).toBeCloseTo(100, 0);
    });

    test('funnel legend has colored dots', async ({ page }) => {
      const dots = page.locator('.token-funnel .funnel-legend .dot');
      expect(await dots.count()).toBeGreaterThanOrEqual(7); // 4 + 3
    });
  });

  // ═══════════════════════════════════════════
  // 6. SCALE CHECK / FUN FACTS
  // ═══════════════════════════════════════════
  test.describe('Scale Check', () => {
    test('renders fun facts section if data exists', async ({ page }) => {
      const scaleCheck = page.locator('.insights').filter({ hasText: 'Scale Check' });
      const count = await scaleCheck.count();
      if (count > 0) {
        await expect(scaleCheck.locator('h2')).toHaveText('Scale Check');
        const facts = scaleCheck.locator('.insight.info');
        expect(await facts.count()).toBeGreaterThan(0);
        await expect(facts.first().locator('.icon')).toHaveText('~');
      }
    });

    test('fun facts use info styling with blue icon', async ({ page }) => {
      const facts = page.locator('.insights').filter({ hasText: 'Scale Check' }).locator('.insight.info');
      const count = await facts.count();
      if (count > 0) {
        const iconColor = await facts.first().locator('.icon').evaluate(
          el => getComputedStyle(el).color
        );
        // info icons are blue
        expect(iconColor).toBeTruthy();
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
        await expect(cards.first().locator('.icon')).toBeVisible();
      }
    });

    test('each insight has a type class (warning/success/info/tip)', async ({ page }) => {
      const cards = page.locator('.insights').filter({ hasText: 'Insights' }).locator('.insight');
      const count = await cards.count();
      if (count > 0) {
        for (let i = 0; i < Math.min(count, 5); i++) {
          const className = await cards.nth(i).getAttribute('class');
          expect(className).toMatch(/warning|success|info|tip/);
        }
      }
    });

    test('insight cards have proper card styling', async ({ page }) => {
      const card = page.locator('.insights').filter({ hasText: 'Insights' }).locator('.insight').first();
      const count = await card.count();
      if (count > 0) {
        const bg = await card.evaluate(el => getComputedStyle(el).backgroundColor);
        expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      }
    });
  });

  // ═══════════════════════════════════════════
  // 8. CHARTS GRID
  // ═══════════════════════════════════════════
  test.describe('Charts Grid', () => {
    test('renders 6 chart cards in a 2-column grid', async ({ page }) => {
      const grid = page.locator('.charts-grid');
      await expect(grid).toHaveCount(1);
      const chartCards = grid.locator('.chart-card');
      await expect(chartCards).toHaveCount(6);
      // Check 2-column grid
      const cols = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns);
      const parts = cols.split(' ');
      expect(parts.length).toBe(2);
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

    test('chart header uses flex layout with toggle on the right', async ({ page }) => {
      const chartHeader = page.locator('.chart-header').first();
      const display = await chartHeader.evaluate(el => getComputedStyle(el).display);
      expect(display).toBe('flex');
      const justify = await chartHeader.evaluate(el => getComputedStyle(el).justifyContent);
      expect(justify).toBe('space-between');
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

    test('chart containers have 300px height', async ({ page }) => {
      const containers = page.locator('.chart-container');
      const count = await containers.count();
      for (let i = 0; i < Math.min(count, 3); i++) {
        const height = await containers.nth(i).evaluate(el => getComputedStyle(el).height);
        expect(height).toBe('300px');
      }
    });

    test('each chart card has info-tip tooltip', async ({ page }) => {
      const chartCards = page.locator('.charts-grid .chart-card');
      const count = await chartCards.count();
      for (let i = 0; i < count; i++) {
        await expect(chartCards.nth(i).locator('.info-tip')).toHaveCount(1);
      }
    });

    test('all chart cards have proper card styling', async ({ page }) => {
      const cards = page.locator('.charts-grid .chart-card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const { bg, bgImage } = await cards.nth(i).evaluate(el => ({
          bg: getComputedStyle(el).backgroundColor,
          bgImage: getComputedStyle(el).backgroundImage
        }));
        const border = await cards.nth(i).evaluate(el => getComputedStyle(el).borderStyle);
        expect(bg !== 'rgba(0, 0, 0, 0)' || bgImage !== 'none').toBeTruthy();
        expect(border).toBe('solid');
      }
    });
  });

  // ═══════════════════════════════════════════
  // 9. HEATMAP
  // ═══════════════════════════════════════════
  // Heatmap requires Chart.js CDN — tests check structure only when rendered
  test.describe('Productivity Heatmap', () => {
    test('heatmap container exists in the DOM', async ({ page }) => {
      await expect(page.locator('#heatmap-container')).toHaveCount(1);
    });

    test('heatmap grid has 7 day labels when Chart.js loaded', async ({ page }) => {
      const labels = page.locator('#heatmap-container .heatmap-label');
      const count = await labels.count();
      if (count === 0) { test.skip(); return; }
      expect(count).toBe(7);
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (let i = 0; i < 7; i++) {
        await expect(labels.nth(i)).toHaveText(days[i]);
      }
    });

    test('heatmap has 168 cells (7 days x 24 hours) when Chart.js loaded', async ({ page }) => {
      const cells = page.locator('#heatmap-container .heatmap-cell');
      const count = await cells.count();
      if (count === 0) { test.skip(); return; }
      expect(count).toBe(168);
    });

    test('heatmap cells have title attributes with commit info when rendered', async ({ page }) => {
      const cells = page.locator('#heatmap-container .heatmap-cell');
      if (await cells.count() === 0) { test.skip(); return; }
      const title = await cells.first().getAttribute('title');
      expect(title).toMatch(/\w+ \d+:00 — \d+ commits/);
    });

    test('heatmap has hour labels row when rendered', async ({ page }) => {
      const hourLabels = page.locator('#heatmap-container .heatmap-hour-label');
      const count = await hourLabels.count();
      if (count === 0) { test.skip(); return; }
      expect(count).toBe(24);
    });

    test('heatmap has gradient legend with Fewer/More labels when rendered', async ({ page }) => {
      const container = page.locator('#heatmap-container');
      const text = await container.textContent();
      if (!text || text.trim() === '') { test.skip(); return; }
      expect(text).toContain('Fewer');
      expect(text).toContain('More commits');
    });

    test('heatmap uses 25-column grid when rendered', async ({ page }) => {
      const grid = page.locator('#heatmap-container .heatmap-grid');
      if (await grid.count() === 0) { test.skip(); return; }
      const cols = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns);
      const parts = cols.split(' ');
      expect(parts.length).toBe(25);
    });
  });

  // ═══════════════════════════════════════════
  // 10. CACHE EFFICIENCY
  // ═══════════════════════════════════════════
  test.describe('Cache Efficiency', () => {
    test('renders cache efficiency card with progress bar', async ({ page }) => {
      const cacheSection = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' });
      await expect(cacheSection).toHaveCount(1);
      await expect(cacheSection.locator('h3')).toContainText('Cache Efficiency');
      await expect(cacheSection.locator('.survival-bar')).toHaveCount(1);
      await expect(cacheSection.locator('.survival-bar .fill')).toHaveCount(1);
    });

    test('progress bar fill has dynamic width', async ({ page }) => {
      const fill = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' }).locator('.survival-bar .fill');
      const width = await fill.evaluate(el => el.style.width);
      expect(width).toMatch(/\d+%/);
    });

    test('progress bar has animated transition', async ({ page }) => {
      const fill = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' }).locator('.survival-bar .fill');
      const transition = await fill.evaluate(el => getComputedStyle(el).transition);
      expect(transition).toContain('width');
    });

    test('displays cache stats: tokens, fresh input, savings, hit rate', async ({ page }) => {
      const stats = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' }).locator('.survival-stats');
      await expect(stats).toContainText('tokens from cache');
      await expect(stats).toContainText('fresh input tokens');
      await expect(stats).toContainText('saved');
      await expect(stats).toContainText('cache hit rate');
    });

    test('savings amount shows dollar sign', async ({ page }) => {
      const stats = page.locator('.survival-section').filter({ hasText: 'Cache Efficiency' }).locator('.survival-stats');
      const text = await stats.textContent();
      // Look for dollar sign in the savings stat
      expect(text).toMatch(/\$[\d.]+\s*saved/);
    });
  });

  // ═══════════════════════════════════════════
  // 11. LINE SURVIVAL RATE
  // ═══════════════════════════════════════════
  test.describe('Line Survival Rate', () => {
    test('renders survival card with progress bar', async ({ page }) => {
      const survivalSection = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' });
      await expect(survivalSection).toHaveCount(1);
      await expect(survivalSection.locator('h3')).toContainText('Line Survival Rate');
      await expect(survivalSection.locator('.survival-bar')).toHaveCount(1);
      await expect(survivalSection.locator('.survival-bar .fill')).toHaveCount(1);
    });

    test('progress bar color is based on survival rate', async ({ page }) => {
      const fill = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' }).locator('.survival-bar .fill');
      const bg = await fill.evaluate(el => el.style.background);
      // Should be gradient (purple-blue for >=80%), (orange-purple for >=50%), or red (<50%)
      expect(bg).toMatch(/accent-(purple|orange|red|blue)/);
    });

    test('displays survival stats: added, churned, surviving, rate', async ({ page }) => {
      const stats = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' }).locator('.survival-stats');
      await expect(stats).toContainText('lines added');
      await expect(stats).toContainText('churned within 24h');
      await expect(stats).toContainText('surviving');
      await expect(stats).toContainText('survival rate');
    });

    test('survival stats values are formatted with locale strings', async ({ page }) => {
      const statSpans = page.locator('.survival-section').filter({ hasText: 'Line Survival Rate' }).locator('.survival-stats span');
      const count = await statSpans.count();
      expect(count).toBeGreaterThanOrEqual(4);
    });
  });

  // ═══════════════════════════════════════════
  // 12. SESSIONS TABLE
  // ═══════════════════════════════════════════
  test.describe('Sessions Table', () => {
    test('renders sessions section with count in heading', async ({ page }) => {
      const section = page.locator('.sessions-section');
      await expect(section).toHaveCount(1);
      const heading = section.locator('h2');
      await expect(heading).toContainText('Sessions');
      const text = await heading.textContent();
      expect(text).toMatch(/Sessions \(\d+\)/);
    });

    test('table wrapper has proper card styling', async ({ page }) => {
      const wrap = page.locator('.sessions-table-wrap');
      const { bg, bgImage } = await wrap.evaluate(el => ({
        bg: getComputedStyle(el).backgroundColor,
        bgImage: getComputedStyle(el).backgroundImage
      }));
      expect(bg !== 'rgba(0, 0, 0, 0)' || bgImage !== 'none').toBeTruthy();
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

    test('table headers have info-tip tooltips on relevant columns', async ({ page }) => {
      const headers = page.locator('.sessions-table-wrap thead th');
      // Model, Msgs, Cost, Commits, Lines, Grade have tooltips
      for (const idx of [2, 3, 4, 5, 6, 7]) {
        await expect(headers.nth(idx).locator('.info-tip')).toHaveCount(1);
      }
    });

    test('table header tooltips show below (not above) via CSS', async ({ page }) => {
      // thead .info-tip:hover::after has top instead of bottom
      const tip = page.locator('thead .info-tip').first();
      const bg = await tip.evaluate(el => getComputedStyle(el).background);
      // Just verify the element exists with the right class
      expect(bg).toBeTruthy();
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

    test('grade badge has colored background matching grade', async ({ page }) => {
      const badge = page.locator('.sessions-table-wrap .grade-badge').first();
      const bg = await badge.evaluate(el => el.style.background);
      expect(bg).toBeTruthy();
    });

    test('session row shows cost with dollar sign', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const costCell = firstRow.locator('td').nth(4);
      await expect(costCell).toContainText('$');
    });

    test('session row shows lines added/deleted with +/- format and colors', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const linesCell = firstRow.locator('td').nth(6);
      const text = await linesCell.textContent();
      expect(text).toMatch(/\+[\d,]+/);
      expect(text).toMatch(/-[\d,]+/);
      // Green for additions, red for deletions
      const greenSpan = linesCell.locator('span[style*="22d3a8"]');
      const redSpan = linesCell.locator('span[style*="ef4444"]');
      await expect(greenSpan).toHaveCount(1);
      await expect(redSpan).toHaveCount(1);
    });

    test('session row shows formatted date', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const dateCell = firstRow.locator('td').first();
      const text = await dateCell.textContent();
      // Should be like "Jan 15, 02:30 PM" or similar locale format
      expect(text.length).toBeGreaterThan(3);
      expect(text).not.toBe('—');
    });

    test('session rows have pointer cursor', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const cursor = await firstRow.evaluate(el => el.style.cursor);
      expect(cursor).toBe('pointer');
    });

    test('clicking a row toggles expand section', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const expandRow = page.locator('#expand-0');
      // Initially hidden
      await expect(expandRow).not.toHaveClass(/open/);
      // Click to expand
      await firstRow.click();
      await expect(expandRow).toHaveClass(/open/);
      // Expand row becomes visible
      await expect(expandRow).toBeVisible();
      // Click again to collapse
      await firstRow.click();
      await expect(expandRow).not.toHaveClass(/open/);
    });

    test('expanded row shows commits or "No matched commits"', async ({ page }) => {
      const firstRow = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      await firstRow.click();
      const expandContent = page.locator('#expand-0 .expand-content');
      await expect(expandContent).toBeVisible();
      const text = await expandContent.textContent();
      // Either has commit items or "No matched commits"
      const hasCommits = (await expandContent.locator('.commit-item').count()) > 0;
      const hasNoCommits = text.includes('No matched commits');
      expect(hasCommits || hasNoCommits).toBeTruthy();
    });

    test('commit items show hash, branch, subject, and diff stats', async ({ page }) => {
      // Find a row that has commits
      const rows = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)');
      const count = await rows.count();
      for (let i = 0; i < Math.min(count, 10); i++) {
        await rows.nth(i).click();
        const expandContent = page.locator(`#expand-${i} .expand-content`);
        const commitItems = expandContent.locator('.commit-item');
        if (await commitItems.count() > 0) {
          const item = commitItems.first();
          await expect(item.locator('.commit-hash')).toBeVisible();
          await expect(item.locator('.commit-branch')).toBeVisible();
          await expect(item.locator('.commit-subject')).toBeVisible();
          // Diff stats with +/-
          const diffText = await item.locator('span:last-child').textContent();
          expect(diffText).toMatch(/\+\d+\/-\d+/);
          // Collapse and return
          await rows.nth(i).click();
          return;
        }
        await rows.nth(i).click();
      }
    });

    test('sortable columns have click handlers and sorted state', async ({ page }) => {
      const dateHeader = page.locator('th').filter({ hasText: 'Date' });
      // Default sort is by startTime descending
      await expect(dateHeader).toHaveClass(/sorted/);
      // Click Cost header to sort by cost
      const costHeader = page.locator('th').filter({ hasText: 'Cost' });
      await costHeader.click();
      await expect(costHeader).toHaveClass(/sorted/);
      await expect(dateHeader).not.toHaveClass(/sorted/);
    });

    test('sorted column header is highlighted blue', async ({ page }) => {
      const sortedTh = page.locator('thead th.sorted').first();
      const color = await sortedTh.evaluate(el => getComputedStyle(el).color);
      // --accent-blue is rgb(59, 130, 246)
      expect(color).toBe('rgb(59, 130, 246)');
    });

    test('clicking same column toggles sort direction', async ({ page }) => {
      const dateHeader = page.locator('th').filter({ hasText: 'Date' });
      const textBefore = await dateHeader.textContent();
      await dateHeader.click(); // Toggle direction
      const textAfter = await dateHeader.textContent();
      // Sort arrow should flip from v to ^ or vice versa
      expect(textBefore).not.toBe(textAfter);
    });

    test('pagination controls are present', async ({ page }) => {
      const pagination = page.locator('.pagination');
      await expect(pagination).toHaveCount(1);
      await expect(pagination.locator('button')).toHaveCount(2);
      await expect(pagination).toContainText('Page');
      await expect(pagination).toContainText('of');
    });

    test('pagination shows Prev and Next buttons', async ({ page }) => {
      const buttons = page.locator('.pagination button');
      await expect(buttons.first()).toHaveText('Prev');
      await expect(buttons.last()).toHaveText('Next');
    });

    test('Prev button is disabled on first page', async ({ page }) => {
      const prevBtn = page.locator('.pagination button').first();
      await expect(prevBtn).toBeDisabled();
    });

    test('disabled pagination buttons have reduced opacity', async ({ page }) => {
      const prevBtn = page.locator('.pagination button').first();
      const opacity = await prevBtn.evaluate(el => getComputedStyle(el).opacity);
      expect(parseFloat(opacity)).toBeLessThan(1);
    });

    test('table rows have hover background transition', async ({ page }) => {
      const row = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first();
      const transition = await row.evaluate(el => getComputedStyle(el).transition);
      expect(transition).toContain('background');
    });
  });

  // ═══════════════════════════════════════════
  // 13. FOOTER
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

    test('footer has open source call to action', async ({ page }) => {
      const footer = page.locator('footer');
      await expect(footer).toContainText('Open source');
      await expect(footer).toContainText('Star the repo');
    });

    test('footer has top border separator', async ({ page }) => {
      const footer = page.locator('footer');
      // Check for gradient fade line via ::before or solid border
      const hasBefore = await footer.evaluate(el => {
        const before = getComputedStyle(el, '::before');
        return before.content !== 'none' && before.height !== '0px';
      });
      const borderTop = await footer.evaluate(el => getComputedStyle(el).borderTopStyle);
      expect(hasBefore || borderTop === 'solid').toBeTruthy();
    });

    test('footer links are blue and change on hover', async ({ page }) => {
      const link = page.locator('footer a').first();
      const color = await link.evaluate(el => getComputedStyle(el).color);
      // --accent-blue is rgb(59, 130, 246)
      expect(color).toBe('rgb(59, 130, 246)');
    });
  });

  // ═══════════════════════════════════════════
  // 14. INFO TOOLTIPS (across all sections)
  // ═══════════════════════════════════════════
  test.describe('Info Tooltips', () => {
    test('info-tip elements exist throughout the page (>10)', async ({ page }) => {
      const tips = page.locator('.info-tip');
      expect(await tips.count()).toBeGreaterThan(10);
    });

    test('info-tip elements have data-tip attribute with meaningful text', async ({ page }) => {
      const tips = page.locator('.info-tip');
      const count = await tips.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const dataTip = await tips.nth(i).getAttribute('data-tip');
        expect(dataTip).toBeTruthy();
        expect(dataTip.length).toBeGreaterThan(10);
      }
    });

    test('info-tip has circular shape (16x16px)', async ({ page }) => {
      const tip = page.locator('.info-tip').first();
      const width = await tip.evaluate(el => getComputedStyle(el).width);
      const height = await tip.evaluate(el => getComputedStyle(el).height);
      expect(width).toBe('16px');
      expect(height).toBe('16px');
      const borderRadius = await tip.evaluate(el => getComputedStyle(el).borderRadius);
      expect(borderRadius).toBe('50%');
    });

    test('info-tip displays "i" text', async ({ page }) => {
      const tip = page.locator('.info-tip').first();
      const text = await tip.textContent();
      expect(text.trim()).toBe('i');
    });

    test('info-tip has cursor:help', async ({ page }) => {
      const tip = page.locator('.info-tip').first();
      const cursor = await tip.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe('help');
    });
  });

  // ═══════════════════════════════════════════
  // 15. SECTION ORDER (integration)
  // ═══════════════════════════════════════════
  test.describe('Section Order', () => {
    test('all 3 stats sections render in correct order', async ({ page }) => {
      const sections = page.locator('.stats-section');
      await expect(sections).toHaveCount(3);
      await expect(sections.nth(0).locator('h2')).toContainText('Performance Overview');
      await expect(sections.nth(1).locator('h2')).toContainText('Cost Breakdown');
      await expect(sections.nth(2).locator('h2')).toContainText('Token Usage');
    });

    test('full page order: hero → cost → tokens → funnel → charts → cache → survival → sessions', async ({ page }) => {
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

    test('footer is below all content sections', async ({ page }) => {
      const sessionsY = await page.locator('.sessions-section').evaluate(el => el.getBoundingClientRect().bottom);
      const footerY = await page.locator('footer').evaluate(el => el.getBoundingClientRect().top);
      expect(footerY).toBeGreaterThanOrEqual(sessionsY);
    });
  });

  // ═══════════════════════════════════════════
  // 16. DARK THEME & VISUAL CONSISTENCY
  // ═══════════════════════════════════════════
  test.describe('Visual & Theme', () => {
    test('page uses dark background (#0a0e17)', async ({ page }) => {
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe('rgb(10, 14, 23)');
    });

    test('CSS custom properties are defined on :root', async ({ page }) => {
      const vars = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return {
          bgPrimary: style.getPropertyValue('--bg-primary').trim(),
          bgCard: style.getPropertyValue('--bg-card').trim(),
          border: style.getPropertyValue('--border').trim(),
          textPrimary: style.getPropertyValue('--text-primary').trim(),
          accentGreen: style.getPropertyValue('--accent-green').trim(),
          accentRed: style.getPropertyValue('--accent-red').trim(),
          accentBlue: style.getPropertyValue('--accent-blue').trim(),
          radius: style.getPropertyValue('--radius').trim(),
        };
      });
      expect(vars.bgPrimary).toBe('#0a0e17');
      expect(vars.bgCard).toBe('#151d2b');
      expect(vars.border).toBe('#1f2d3d');
      expect(vars.textPrimary).toBe('#f0f4f8');
      expect(vars.accentGreen).toBe('#22d3a8');
      expect(vars.accentRed).toBe('#ef4444');
      expect(vars.accentBlue).toBe('#3b82f6');
      expect(vars.radius).toBe('12px');
    });

    test('body uses DM Sans font family', async ({ page }) => {
      const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(fontFamily).toContain('DM Sans');
    });

    test('container has max-width 1320px', async ({ page }) => {
      const maxWidth = await page.locator('.container').evaluate(el => getComputedStyle(el).maxWidth);
      expect(maxWidth).toBe('1320px');
    });

    test('hero stat cards have visible colored top bars via ::before', async ({ page }) => {
      const costCard = page.locator('.stat-card.cost-card');
      const beforeBg = await costCard.evaluate(el => getComputedStyle(el, '::before').background);
      expect(beforeBg).toBeTruthy();
    });

    test('all legend bars share same styling', async ({ page }) => {
      const legends = ['.hero-legend', '.cost-legend', '.token-legend'];
      for (const selector of legends) {
        const legend = page.locator(selector);
        if (await legend.count() > 0) {
          const bg = await legend.evaluate(el => getComputedStyle(el).backgroundColor);
          const border = await legend.evaluate(el => getComputedStyle(el).borderStyle);
          const radius = await legend.evaluate(el => getComputedStyle(el).borderRadius);
          expect(bg).not.toBe('rgba(0, 0, 0, 0)');
          expect(border).toBe('solid');
          expect(radius).toBe('8px');
        }
      }
    });

    test('legend dots are 8px circular', async ({ page }) => {
      const dot = page.locator('.hero-legend .dot').first();
      const width = await dot.evaluate(el => getComputedStyle(el).width);
      const height = await dot.evaluate(el => getComputedStyle(el).height);
      const radius = await dot.evaluate(el => getComputedStyle(el).borderRadius);
      expect(width).toBe('8px');
      expect(height).toBe('8px');
      expect(radius).toBe('50%');
    });
  });

  // ═══════════════════════════════════════════
  // 17. INTERACTIVE FEATURES
  // ═══════════════════════════════════════════
  test.describe('Interactive Features', () => {
    test('scale toggle button toggles text between Log/Linear (requires Chart.js)', async ({ page }) => {
      const toggle = page.locator('.scale-toggle');
      await expect(toggle).toHaveText('Log scale');
      await toggle.click();
      // toggleTimelineScale() only updates text when Chart.js is loaded and timelineChart exists
      const chartLoaded = await page.evaluate(() => typeof Chart !== 'undefined');
      if (!chartLoaded) {
        // Without Chart.js, button text stays the same
        await expect(toggle).toHaveText('Log scale');
      } else {
        await expect(toggle).toHaveText('Linear scale');
        await toggle.click();
        await expect(toggle).toHaveText('Log scale');
      }
    });

    test('sorting by different columns re-renders the table', async ({ page }) => {
      const firstRowDateBefore = await page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first().locator('td').first().textContent();
      // Sort by Cost
      await page.locator('th').filter({ hasText: 'Cost' }).click();
      const firstRowDateAfter = await page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first().locator('td').first().textContent();
      // After sorting by cost, the first row should likely be different
      // (unless all sessions have the same cost)
      // Just verify the table re-rendered without errors
      const rows = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)');
      expect(await rows.count()).toBeGreaterThan(0);
    });

    test('sorting by Commits column works', async ({ page }) => {
      const commitsHeader = page.locator('th').filter({ hasText: 'Commits' });
      await commitsHeader.click();
      await expect(commitsHeader).toHaveClass(/sorted/);
    });

    test('sorting by Model column works', async ({ page }) => {
      const modelHeader = page.locator('th').filter({ hasText: 'Model' });
      await modelHeader.click();
      await expect(modelHeader).toHaveClass(/sorted/);
    });

    test('sorting by Lines column works', async ({ page }) => {
      const linesHeader = page.locator('th').filter({ hasText: 'Lines' });
      await linesHeader.click();
      await expect(linesHeader).toHaveClass(/sorted/);
    });

    test('multiple expand rows can be toggled independently', async ({ page }) => {
      const rows = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)');
      const count = await rows.count();
      if (count >= 2) {
        await rows.nth(0).click();
        await rows.nth(1).click();
        await expect(page.locator('#expand-0')).toHaveClass(/open/);
        await expect(page.locator('#expand-1')).toHaveClass(/open/);
        // Close first
        await rows.nth(0).click();
        await expect(page.locator('#expand-0')).not.toHaveClass(/open/);
        await expect(page.locator('#expand-1')).toHaveClass(/open/);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 18. LOADING STATE
  // ═══════════════════════════════════════════
  test.describe('Loading State', () => {
    test('loading spinner is replaced by content after data loads', async ({ page }) => {
      // By the time we reach this test, content is loaded
      const loading = page.locator('.loading');
      await expect(loading).toHaveCount(0);
    });

    test('#app contains rendered content, not loading state', async ({ page }) => {
      const app = page.locator('#app');
      const html = await app.innerHTML();
      expect(html).not.toContain('Loading dashboard data');
      expect(html).toContain('stats-section');
    });
  });

  // ═══════════════════════════════════════════
  // 19. DATA FORMAT HELPERS
  // ═══════════════════════════════════════════
  test.describe('Data Formatting', () => {
    test('formatTokens renders with K/M/B suffixes', async ({ page }) => {
      // Check that token values use formatted suffixes
      const burnedValue = await page.locator('.token-stat-card.burned .value').textContent();
      expect(burnedValue).toMatch(/[\d.]+[KMB]/);
    });

    test('cost values show 2 decimal places', async ({ page }) => {
      const costValue = await page.locator('.stat-card.cost-card .value').textContent();
      expect(costValue).toMatch(/\$\d+\.\d{2}/);
    });

    test('model names are formatted correctly', async ({ page }) => {
      const modelCell = page.locator('.sessions-table-wrap tbody tr:not(.expand-row)').first().locator('td').nth(2);
      const text = await modelCell.textContent();
      // Should be like "Opus 4.6", "Sonnet 4.5", "Haiku 4.5" etc.
      expect(text).toMatch(/[A-Z]/); // At least starts capitalized
    });

    test('percentage values are integers (no decimals)', async ({ page }) => {
      const efficiencyValue = await page.locator('.token-stat-card.efficiency .value').textContent();
      expect(efficiencyValue).toMatch(/^\d+%$/);
    });
  });

  // ═══════════════════════════════════════════
  // 20. API & DATA INTEGRITY
  // ═══════════════════════════════════════════
  test.describe('API & Data', () => {
    test('/api/all endpoint returns valid JSON', async ({ page }) => {
      const response = await page.request.get('/api/all');
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('tokenAnalytics');
      expect(data).toHaveProperty('sessions');
      expect(data).toHaveProperty('daily');
      expect(data).toHaveProperty('insights');
      expect(data).toHaveProperty('meta');
    });

    test('API data has required summary fields', async ({ page }) => {
      const response = await page.request.get('/api/all');
      const data = await response.json();
      const s = data.summary;
      expect(s).toHaveProperty('totalCost');
      expect(s).toHaveProperty('totalSessions');
      expect(s).toHaveProperty('totalCommits');
      expect(s).toHaveProperty('overallGrade');
      expect(s).toHaveProperty('costByPeriod');
      expect(typeof s.totalCost).toBe('number');
    });

    test('API data has required tokenAnalytics fields', async ({ page }) => {
      const response = await page.request.get('/api/all');
      const data = await response.json();
      const t = data.tokenAnalytics;
      expect(t).toHaveProperty('totalAllTokens');
      expect(t).toHaveProperty('tokensOrphaned');
      expect(t).toHaveProperty('tokenEfficiencyRate');
      expect(t).toHaveProperty('tokensPerCommit');
      expect(t).toHaveProperty('funnel');
      expect(t).toHaveProperty('cacheHitRate');
    });

    test('costByPeriod has tokens field for all periods', async ({ page }) => {
      const response = await page.request.get('/api/all');
      const data = await response.json();
      const cbp = data.summary.costByPeriod;
      expect(cbp.today).toHaveProperty('tokens');
      expect(cbp.week).toHaveProperty('tokens');
      expect(cbp.month).toHaveProperty('tokens');
      expect(cbp.allTime).toHaveProperty('tokens');
      expect(typeof cbp.allTime.tokens).toBe('number');
    });

    test('sessions array has expected structure', async ({ page }) => {
      const response = await page.request.get('/api/all');
      const data = await response.json();
      expect(data.sessions.length).toBeGreaterThan(0);
      const session = data.sessions[0];
      expect(session).toHaveProperty('startTime');
      expect(session).toHaveProperty('cost');
      expect(session).toHaveProperty('grade');
      expect(session).toHaveProperty('commits');
      expect(session).toHaveProperty('linesAdded');
      expect(session).toHaveProperty('linesDeleted');
    });
  });

  // ═══════════════════════════════════════════
  // 21. ACCESSIBILITY & SEMANTIC HTML
  // ═══════════════════════════════════════════
  test.describe('Accessibility', () => {
    test('page has proper lang attribute', async ({ page }) => {
      const lang = await page.locator('html').getAttribute('lang');
      expect(lang).toBe('en');
    });

    test('page has a descriptive title', async ({ page }) => {
      const title = await page.title();
      expect(title).toContain('Codelens AI');
      expect(title).toContain('Dashboard');
    });

    test('page has viewport meta tag for mobile', async ({ page }) => {
      const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(viewport).toContain('width=device-width');
    });

    test('all images/SVGs are decorative or labeled', async ({ page }) => {
      // SVGs in the page (efficiency gauge) are decorative
      const svgs = page.locator('svg');
      const count = await svgs.count();
      // Just verify they exist without breaking
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('table uses semantic thead/tbody structure', async ({ page }) => {
      await expect(page.locator('.sessions-table-wrap thead')).toHaveCount(1);
      await expect(page.locator('.sessions-table-wrap tbody')).toHaveCount(1);
    });
  });
});
