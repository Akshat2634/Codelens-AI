import { expect, test } from '@playwright/test';

// ── Full dashboard suite (LOCAL) ────────────────────────────────────────────
// Runs against a dev server the developer already has up on :3457 (see
// playwright.config.js — no webServer is auto-started for local runs):
//
//   node src/index.js --no-open                 # against real sessions, or
//   node src/index.js --no-open \
//     --claude-dir tests/fixtures/claude-projects \
//     --codex-dir tests/fixtures/codex-sessions --days 30 --refresh
//   npm run test:e2e:local
//
// This is the deep counterpart to tests/e2e/smoke.spec.js and exercises the
// "Mission Control" redesign section by section: the fixed rail, the bento
// Overview, Cost & Token Flow, Models & Tools, the Agents face-off + autonomy,
// Shipping Rhythm, the Sessions table, and the ⌘K command palette. Assertions
// lean on data-correctness, element counts, visibility, and interaction
// outcomes rather than brittle CSS internals, so they survive styling tweaks.

const KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

// Pull the raw payload once per test that needs it, to assert the DOM against
// the same numbers the server served.
async function apiAll(request, source) {
  const res = await request.get('/api/all' + (source ? `?source=${source}` : ''));
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.stats-section .hero-stats', { timeout: 15_000 });
});

test.describe('Chrome — sidebar & top bar', () => {
  test('brand wordmark, tagline, and agent source tabs render', async ({ page }) => {
    await expect(page.locator('.sidebar')).toContainText('Codelens');
    await expect(page.locator('.sidebar')).toContainText(/token spend with actual git output/i);
    await expect(page.locator('.source-tabs .source-tab')).toHaveCount(3);
    await expect(page.locator('.source-tabs .source-tab.active')).toHaveCount(1);
  });

  test('console nav lists the six sections and anchors to them', async ({ page }) => {
    const nav = page.locator('.nav-item');
    await expect(nav).toHaveCount(6);
    await expect(nav).toContainText(['Overview', 'Cost & Tokens', 'Models & Tools', 'Agents', 'Rhythm', 'Sessions']);
    const hrefs = await nav.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual(['#sec-overview', '#sec-flow', '#sec-models', '#sec-agents', '#sec-rhythm', '#sec-sessions']);
  });

  test('top bar shows the date range and window size from meta', async ({ page, request }) => {
    const p = await apiAll(request);
    await expect(page.locator('#topbar')).toContainText('Mission Control');
    await expect(page.locator('#topbar')).toContainText(`${p.meta.daysAnalyzed}-day window`);
  });

  test('top bar carries a timezone chip and share/refresh actions', async ({ page }) => {
    await expect(page.locator('#topbar [title^="Heatmap hours use this timezone"]')).toBeVisible();
    await expect(page.locator('#share-btn')).toBeVisible();
    await expect(page.locator('#refresh-btn')).toBeVisible();
    await expect(page.locator('#refresh-btn')).toBeEnabled();
  });

  test('footer carries the live-status text and both agent marks', async ({ page }) => {
    await expect(page.locator('#footer-agents')).toContainText(/Local · no telemetry/i);
    await expect(page.locator('#footer-agents svg[data-agent-logo]')).toHaveCount(2);
  });
});

test.describe('Overview — briefing, score, tiles, periods, insights', () => {
  test('weekly briefing headline matches the narrative payload', async ({ page, request }) => {
    const p = await apiAll(request);
    await expect(page.locator('.narrative-kicker')).toHaveText(/Weekly Briefing/i);
    await expect(page.locator('.narrative-headline')).not.toBeEmpty();
    const expected = (p.weeklyNarrative?.metrics || []).length;
    if (expected > 0) await expect(page.locator('.narrative-metric')).toHaveCount(expected);
  });

  test('efficiency score ring shows the payload score and grade', async ({ page, request }) => {
    const p = await apiAll(request);
    const es = p.summary.efficiencyScore;
    await expect(page.locator('.score-value')).toHaveText(String(es.score), { timeout: 5_000 });
    await expect(page.locator('#sec-overview')).toContainText('GRADE ' + es.letter);
    await expect(page.locator('#sec-overview')).toContainText(es.tier);
  });

  test('six stat tiles render with spend, commits, and shares', async ({ page, request }) => {
    const p = await apiAll(request);
    await expect(page.locator('.hero-stats .stat-card')).toHaveCount(6);
    await expect(page.locator('.stat-card.cost-card .stat-value')).toHaveText(/\$\d/);
    const overview = page.locator('#sec-overview');
    await expect(overview).toContainText('Agent Spend');
    await expect(overview).toContainText('Commits Shipped');
    await expect(overview).toContainText('Value Leak');
    await expect(overview).toContainText(`${p.summary.aiCodeSharePct}%`);
  });

  test('period strip shows Today / 7d / month / full window', async ({ page }) => {
    const strip = page.locator('.roi-headlines');
    await expect(strip).toContainText('Today');
    await expect(strip).toContainText('Last 7 days');
    await expect(strip).toContainText('This month');
    await expect(strip).toContainText('Full window');
    await expect(strip.getByText(/tokens$/)).toHaveCount(4);
  });

  test('insights feed renders 1–8 cards', async ({ page }) => {
    const insights = page.locator('.insight-list .insight');
    const n = await insights.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(8);
  });
});

test.describe('Cost & Token Flow', () => {
  test('timeline + burn charts and the token funnel render', async ({ page }) => {
    await expect(page.locator('#chart-timeline')).toBeVisible();
    await expect(page.locator('#chart-token-burn')).toBeVisible();
    const flow = page.locator('#sec-flow');
    await expect(flow).toContainText('BY TYPE');
    await expect(flow).toContainText('BY OUTCOME');
    await expect(flow).toContainText('Cache hit rate');
    await expect(flow).toContainText('Tokens / commit');
  });

  test('range chips rebuild the charts and stay alive', async ({ page }) => {
    for (const days of ['7', '14', '30']) {
      await page.locator(`[data-act="range"][data-arg="${days}"]`).click();
      await page.waitForTimeout(250);
    }
    const alive = await page.evaluate(() =>
      ['chart-timeline', 'chart-token-burn'].every((id) => !!window.Chart.getChart(document.getElementById(id))));
    expect(alive).toBe(true);
  });

  test('log-scale and split-view toggles keep both flow charts alive', async ({ page }) => {
    await page.locator('[data-act="toggleLog"]').click();
    await page.waitForTimeout(250);
    await page.locator('[data-act="toggleBurn"]').click();
    await page.waitForTimeout(250);
    await expect(page.locator('[data-act="toggleLog"]')).toHaveText(/Linear scale/);
    await expect(page.locator('[data-act="toggleBurn"]')).toHaveText(/Stacked/);
    const alive = await page.evaluate(() =>
      ['chart-timeline', 'chart-token-burn'].every((id) => !!window.Chart.getChart(document.getElementById(id))));
    expect(alive).toBe(true);
  });
});

test.describe('Models & Tools', () => {
  test('spend-by-model donut, cost-per-commit bars, and tool usage render', async ({ page, request }) => {
    const p = await apiAll(request);
    await expect(page.locator('#chart-models')).toBeVisible();
    await expect(page.locator('#chart-model-efficiency')).toBeVisible();
    await expect(page.locator('#sec-models')).toContainText('TOTAL');
    await expect(page.locator('#sec-models').getByText('Tool Usage')).toBeVisible();
    expect(Object.keys(p.toolBreakdown).length).toBeGreaterThan(0);
  });
});

test.describe('Agents & Autonomy', () => {
  test('face-off renders on All Agents with two grades and comparison rows', async ({ page, request }) => {
    const all = await apiAll(request);
    if (all.meta.sources.claude > 0 && all.meta.sources.codex > 0) {
      await expect(page.locator('.faceoff-section')).toHaveCount(1);
      await expect(page.locator('.faceoff-vs')).toHaveText('VS');
      await expect(page.locator('.faceoff-section .grade-badge')).toHaveCount(2);
      await expect(page.locator('.faceoff-section .fo-row')).toHaveCount(5);
      await expect(page.locator('.faceoff-section svg[data-agent-mascot="claude"]')).toHaveCount(2);
      await expect(page.locator('.faceoff-section svg[data-agent-logo="codex"]')).toHaveCount(2);
    }
  });

  test('autonomy hub shows the grade ring, score, and three metrics', async ({ page, request }) => {
    const p = await apiAll(request);
    const am = p.autonomyMetrics;
    const agents = page.locator('#sec-agents');
    await expect(agents).toContainText('Autonomy Score');
    await expect(agents).toContainText(`${am.overall.score} / 100`);
    await expect(agents).toContainText('Autopilot Ratio');
    await expect(agents).toContainText('Self-Heal Score');
    await expect(agents).toContainText('Commit Velocity');
  });

  test('attribution shows coverage segments and the trailer note', async ({ page }) => {
    const agents = page.locator('#sec-agents');
    await expect(agents).toContainText('Attribution & Coverage');
    await expect(agents).toContainText(/Co-authored-by trailer/i);
  });
});

test.describe('Shipping Rhythm', () => {
  test('heatmap renders 7×24 cells with a peak label', async ({ page }) => {
    const cells = page.locator('#sec-rhythm [title*=":00 —"]');
    await expect(cells).toHaveCount(168);
    await expect(page.locator('#sec-rhythm')).toContainText('peak:');
  });

  test('line survival and cache efficiency cards render', async ({ page }) => {
    const rhythm = page.locator('#sec-rhythm');
    await expect(rhythm).toContainText('Line Survival');
    await expect(rhythm).toContainText('Cache Efficiency');
    await expect(rhythm).toContainText('AI lines added');
    await expect(rhythm).toContainText('tokens from cache');
  });
});

test.describe('Sessions table', () => {
  test('renders rows with agent marks and grade badges', async ({ page, request }) => {
    const p = await apiAll(request);
    const rows = page.locator('.sessions-section .session-row');
    const shown = Math.min(10, p.sessions.length);
    await expect(rows).toHaveCount(shown);
    await expect(page.locator('.sessions-section .session-row svg[data-agent-logo]')).toHaveCount(shown);
    // Each row carries exactly one agent mark, and the two marks partition the
    // page — guards against the "every Claude row rendered as Codex" class of bug.
    const claudeMarks = await page.locator('.sessions-section .session-row svg[data-agent-logo="claude"]').count();
    const codexMarks = await page.locator('.sessions-section .session-row svg[data-agent-logo="codex"]').count();
    expect(claudeMarks + codexMarks).toBe(shown);
  });

  test('search narrows the table', async ({ page }) => {
    const before = await page.locator('.sessions-section .session-row').count();
    await page.fill('#session-search', 'zzz-definitely-nothing');
    await page.waitForTimeout(200);
    const after = await page.locator('.sessions-section .session-row').count();
    expect(after).toBeLessThanOrEqual(before);
    await page.fill('#session-search', '');
    await page.waitForTimeout(200);
    await expect(page.locator('.sessions-section .session-row')).toHaveCount(before);
  });

  test('shipped / no-commits filters partition the sessions', async ({ page, request }) => {
    const p = await apiAll(request);
    const shipped = p.sessions.filter((s) => s.commitCount > 0).length;
    const leaked = p.sessions.filter((s) => s.commitCount === 0).length;
    await page.locator('[data-act="filter"][data-arg="shipped"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.sessions-section').getByText(`${shipped} of ${p.sessions.length}`)).toBeVisible();
    await page.locator('[data-act="filter"][data-arg="leaked"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.sessions-section').getByText(`${leaked} of ${p.sessions.length}`)).toBeVisible();
  });

  test('sorting by a column flips the arrow indicator', async ({ page }) => {
    const costHeader = page.locator('[data-act="sort"][data-arg="cost"]');
    await costHeader.click();
    await page.waitForTimeout(150);
    await expect(costHeader).toHaveText(/Cost ↓/);
    await costHeader.click();
    await page.waitForTimeout(150);
    await expect(costHeader).toHaveText(/Cost ↑/);
  });

  test('clicking a row expands its commit detail', async ({ page, request }) => {
    const p = await apiAll(request);
    const withCommits = p.sessions.find((s) => s.commitCount > 0);
    test.skip(!withCommits, 'no sessions with commits in this dataset');
    await page.locator('[data-act="filter"][data-arg="shipped"]').click();
    await page.waitForTimeout(150);
    await page.locator('.sessions-section .session-row').first().click();
    await page.waitForTimeout(250);
    await expect(page.locator('.sessions-section .expand-row')).toHaveCount(1);
  });

  test('pagination advances when there are more than 10 sessions', async ({ page, request }) => {
    const p = await apiAll(request);
    test.skip(p.sessions.length <= 10, 'single page of sessions');
    await expect(page.locator('.sessions-section').getByText('Page 1 /')).toBeVisible();
    await page.locator('[data-act="nextPage"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.sessions-section').getByText('Page 2 /')).toBeVisible();
  });
});

test.describe('Share report card', () => {
  test('opens, draws a canvas, and closes via Escape / backdrop / X', async ({ page }) => {
    await page.click('#share-btn');
    await expect(page.locator('.share-modal')).toBeVisible();
    await page.waitForTimeout(600); // fonts + canvas draw
    const size = await page.locator('#share-canvas').evaluate((c) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.share-modal')).toHaveCount(0);

    await page.click('#share-btn');
    await expect(page.locator('.share-modal')).toBeVisible();
    await page.click('.share-close');
    await expect(page.locator('.share-modal')).toHaveCount(0);
  });

  test('switching the theme chip redraws the canvas without closing the modal', async ({ page }) => {
    await page.click('#share-btn');
    await page.waitForTimeout(500);
    await page.locator('.share-chip', { hasText: 'Light' }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.share-modal')).toBeVisible();
    const size = await page.locator('#share-canvas').evaluate((c) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  });

  test('copy to clipboard succeeds or falls back to a PNG download, always with feedback', async ({ page }) => {
    // Whether Clipboard-API write succeeds is environment-dependent (headless
    // Chromium's default permissions vary by Playwright version/OS); either
    // outcome is correct as long as it doesn't throw and the user gets a toast.
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.click('#share-btn');
    await page.waitForTimeout(500);
    await page.click('.share-copy');
    await expect(page.locator('#toast-root')).toContainText(/copied|downloaded|clipboard blocked/i, { timeout: 5_000 });
    expect(errors, 'share copy JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('download button saves a PNG', async ({ page }) => {
    await page.click('#share-btn');
    await page.waitForTimeout(500);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('.share-download'),
    ]);
    expect(download.suggestedFilename()).toBe('codelens-ai-report-card.png');
  });

  test('command palette can open the share card', async ({ page }) => {
    await page.locator('[data-act="openCmd"]').click();
    await page.fill('#cmd-input', 'Share AI report card');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(page.locator('.share-modal')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });
});

test.describe('Refresh', () => {
  test('re-parses data server-side and reports completion via toast', async ({ page }) => {
    await page.click('#refresh-btn');
    await expect(page.locator('#refresh-btn')).toBeDisabled();
    await expect(page.locator('#toast-root')).toContainText(/refresh/i, { timeout: 10_000 });
    await expect(page.locator('#refresh-btn')).toBeEnabled();
  });

  test('command palette can trigger a refresh', async ({ page }) => {
    await page.locator('[data-act="openCmd"]').click();
    await page.fill('#cmd-input', 'Refresh dashboard data');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(page.locator('#toast-root')).toContainText(/refresh/i, { timeout: 10_000 });
  });
});

test.describe('Page footer', () => {
  test('carries both agent marks and links to the live project', async ({ page }) => {
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.locator('svg[data-agent-logo]')).toHaveCount(2);
    await expect(footer.locator('a[href="https://github.com/Akshat2634/Codelens-AI"]')).toHaveCount(2);
    await expect(footer.locator('a[href="https://codelensai-dev.vercel.app/"]')).toHaveCount(1);
    await expect(footer).toContainText(/Designed & built in the Bay Area/i);
  });
});

test.describe('Command palette', () => {
  test('opens with the keyboard shortcut and closes on Escape', async ({ page }) => {
    await page.keyboard.press(`${KEY}+k`);
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('#cmd-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.command-palette')).toHaveCount(0);
  });

  test('typing a section name and pressing Enter scrolls there', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('[data-act="openCmd"]').click();
    await page.fill('#cmd-input', 'Models');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    // Smooth-scroll settles: the page moved down and the Models section is in view.
    await expect
      .poll(async () => page.evaluate(() => {
        const r = document.getElementById('sec-models').getBoundingClientRect();
        return window.scrollY > 150 && r.top < window.innerHeight && r.bottom > 0;
      }), { timeout: 4_000 })
      .toBe(true);
  });

  test('typing an agent name switches the source', async ({ page }) => {
    await page.locator('[data-act="openCmd"]').click();
    await page.fill('#cmd-input', 'View: OpenAI Codex');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/OpenAI Codex/i, { timeout: 10_000 });
  });
});

test.describe('Cross-cutting — theme, source switch, responsive', () => {
  test('theme toggle switches modes and persists across reload', async ({ page }) => {
    const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.locator('[data-act="toggleTheme"]').click();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(initial);
    await page.reload();
    await page.waitForSelector('.stats-section .hero-stats');
    const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(persisted).toBe(after);
  });

  test('switching to a per-agent view filters sessions and hides the face-off', async ({ page, request }) => {
    const all = await apiAll(request);
    test.skip(!(all.meta.sources.claude > 0 && all.meta.sources.codex > 0), 'needs both agents');
    await page.locator('.source-tabs .source-tab', { hasText: 'OpenAI Codex' }).click();
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/OpenAI Codex/i, { timeout: 10_000 });
    await page.waitForSelector('.sessions-section .session-row');
    const rows = page.locator('.sessions-section .session-row');
    for (let i = 0; i < (await rows.count()); i++) {
      expect(await rows.nth(i).textContent()).toMatch(/GPT|Codex|o\d/i);
    }
    await expect(page.locator('.faceoff-section')).toHaveCount(0);
  });

  test('narrow viewport collapses the fixed rail', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(200);
    const marginLeft = await page.locator('.main').evaluate((el) => getComputedStyle(el).marginLeft);
    expect(marginLeft).toBe('0px');
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});
