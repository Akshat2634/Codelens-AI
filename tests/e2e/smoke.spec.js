import { expect, test } from '@playwright/test';

// Smoke E2E — runs against the fixture-backed server (see playwright.config.js).
// The goal is to catch regressions that break rendering end-to-end; not to
// exhaustively verify every component. Full coverage lives in tests/local/.
//
// The dashboard is the "Mission Control" redesign: a fixed left rail with agent
// source tabs + section nav, a bento Overview (efficiency score ring + stat
// tiles), Cost & Token Flow, Models & Tools, Agents & Autonomy (with the
// Claude-vs-Codex face-off), Shipping Rhythm, and a searchable Sessions table.
// A ⌘K command palette replaces the old sticky command bar.

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
    await page.waitForSelector('.stats-section .hero-stats', { timeout: 15_000 });
    expect(errors, 'JS errors on first paint: ' + errors.join(' | ')).toEqual([]);
  });

  test('Overview renders the efficiency score and six stat tiles', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section .hero-stats');
    // Efficiency score ring value is populated (not the skeleton "0").
    const score = await page.locator('.score-value').textContent();
    expect(score).toMatch(/\d/);
    // Six stat tiles, and the Agent Spend tile shows a dollar value.
    await expect(page.locator('.hero-stats .stat-card')).toHaveCount(6);
    const spend = await page.locator('.stat-card.cost-card .stat-value').textContent();
    expect(spend).toMatch(/\$\d/);
  });

  test('Weekly Briefing renders with fixture data', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.narrative', { timeout: 15_000 });
    await expect(page.locator('.narrative-kicker')).toHaveText(/Weekly Briefing/i);
    await expect(page.locator('.narrative-headline')).not.toBeEmpty();
    const count = await page.locator('.narrative-metric').count();
    expect(count).toBeGreaterThan(0);
  });

  test('insights section shows at most 8 items', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.stats-section');
    const insightCount = await page.locator('.insight-list .insight').count();
    expect(insightCount).toBeGreaterThan(0);
    expect(insightCount).toBeLessThanOrEqual(8);
  });

  test('sessions table renders fixture sessions', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.sessions-section .session-row');
    const count = await page.locator('.sessions-section .session-row').count();
    expect(count).toBeGreaterThan(0);
  });

  test('all dashboard charts render without throwing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#chart-timeline');
    await page.waitForSelector('#chart-token-burn');
    await page.waitForSelector('#chart-models');
    await page.waitForSelector('#chart-model-efficiency');
    // Give Chart.js a beat to finish animating.
    await page.waitForTimeout(600);
    // Tool usage is rendered as HTML bars (not a canvas) in this design.
    const tools = await page.locator('#sec-models').getByText('Tool Usage').count();
    expect(tools).toBeGreaterThan(0);
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
    expect(codex.sessions.every((s) => s.source === 'codex')).toBe(true);

    const claude = await (await request.get('/api/all?source=claude')).json();
    expect(claude.meta.source).toBe('claude');
    expect(claude.sessions.every((s) => (s.source || 'claude') === 'claude')).toBe(true);
  });

  test('source tabs render and switching to Codex re-renders the dashboard', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Fixtures contain both Claude and Codex sessions, so all three tabs show.
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    await expect(page.locator('.source-tabs .source-tab')).toHaveCount(3);
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/All Agents/i);

    await page.locator('.source-tabs .source-tab', { hasText: 'OpenAI Codex' }).click();
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/OpenAI Codex/i, { timeout: 10_000 });
    // Sessions table now shows only Codex sessions (GPT / Codex / o-series models).
    await page.waitForSelector('.sessions-section .session-row');
    const rows = page.locator('.sessions-section .session-row');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const text = await rows.nth(i).textContent();
      expect(text).toMatch(/GPT|Codex|o\d/i);
    }
    expect(errors, 'JS errors during source switch: ' + errors.join(' | ')).toEqual([]);
  });
});

test.describe('UI modernization (brand marks, face-off, command palette)', () => {
  test('agent brand marks render on tabs, session rows, and footer', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    // Tabs: Claude tab carries the starburst, Codex tab the knot, All both.
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'Claude Code' }).locator('svg[data-agent-logo="claude"]')).toHaveCount(1);
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'OpenAI Codex' }).locator('svg[data-agent-logo="codex"]')).toHaveCount(1);
    await expect(page.locator('.source-tabs .source-tab', { hasText: 'All Agents' }).locator('svg[data-agent-logo]')).toHaveCount(2);
    // Sessions table: every row is stamped with its agent's mark on the mixed view.
    await page.waitForSelector('.sessions-section .session-row');
    const rows = await page.locator('.sessions-section .session-row').count();
    const rowMarks = await page.locator('.sessions-section .session-row svg[data-agent-logo]').count();
    expect(rowMarks).toBe(rows);
    // Both agents are correctly identified (regression guard: real Claude
    // sessions omit the `source` field, so a `source === 'claude'` check would
    // silently render every Claude row with the Codex mark).
    const claudeMarks = await page.locator('.sessions-section .session-row svg[data-agent-logo="claude"]').count();
    const codexMarks = await page.locator('.sessions-section .session-row svg[data-agent-logo="codex"]').count();
    expect(claudeMarks).toBeGreaterThan(0);
    expect(codexMarks).toBeGreaterThan(0);
    expect(claudeMarks + codexMarks).toBe(rows);
    // Footer carries both marks.
    await expect(page.locator('#footer-agents svg[data-agent-logo]')).toHaveCount(2);
  });

  test('agent face-off renders on All Agents and hides on a per-agent tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.faceoff-section', { timeout: 15_000 });
    // One head-to-head card: two grade badges, one VS divider, the Claude mascot
    // (head + watermark) and the Codex knot (header + watermark).
    await expect(page.locator('.faceoff-section .grade-badge')).toHaveCount(2);
    await expect(page.locator('.faceoff-vs')).toHaveText('VS');
    await expect(page.locator('.faceoff-section svg[data-agent-mascot="claude"]')).toHaveCount(2);
    await expect(page.locator('.faceoff-section svg[data-agent-logo="codex"]')).toHaveCount(2);
    const spendRow = page.locator('.faceoff-section .fo-row', { hasText: 'Spend' });
    await expect(spendRow).toHaveCount(1);
    expect(await spendRow.textContent()).toMatch(/\$\d/);

    // Per-agent view: the head-to-head disappears (there is no opponent).
    await page.locator('.source-tabs .source-tab', { hasText: 'Claude Code' }).click();
    await expect(page.locator('.source-tabs .source-tab.active')).toContainText(/Claude Code/i, { timeout: 10_000 });
    await expect(page.locator('.faceoff-section')).toHaveCount(0);
  });

  test('command palette opens with the trigger and closes on Escape', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    // Not open on load.
    await expect(page.locator('.command-palette')).toHaveCount(0);
    // Sidebar "Command…" button opens it, with mirrored navigation entries.
    await page.locator('[data-act="openCmd"]').click();
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('#cmd-input')).toBeFocused();
    const items = await page.locator('.command-palette [data-act="cmdRun"]').count();
    expect(items).toBeGreaterThan(0);
    // Escape closes it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    expect(errors, 'command palette JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('command palette lists all three agent views (incl. OpenAI Codex)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.source-tabs .source-tab');
    await page.locator('[data-act="openCmd"]').click();
    await expect(page.locator('.command-palette')).toBeVisible();
    // All three agent Views must be reachable at rest — a prior 9-row cap hid Codex.
    for (const label of ['View: All Agents', 'View: Claude Code', 'View: OpenAI Codex']) {
      await expect(page.locator('.command-palette [data-act="cmdRun"]', { hasText: label })).toHaveCount(1);
    }
  });

  test('CLI commands modal opens, lists commands, and closes on Escape', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('.stats-section .hero-stats');
    await expect(page.locator('.cli-modal')).toHaveCount(0);
    await page.locator('[data-act="openCli"]').click();
    await expect(page.locator('.cli-modal')).toBeVisible();
    // Each command row carries a copy button that stashes the full command.
    const rows = await page.locator('.cli-modal .cli-row').count();
    expect(rows).toBeGreaterThan(0);
    const firstCmd = await page.locator('.cli-modal .cli-copy').first().getAttribute('data-cmd');
    expect(firstCmd).toMatch(/codelens-ai/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.cli-modal')).toHaveCount(0);
    expect(errors, 'CLI modal JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('searching the sessions table filters rows without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#session-search');
    const before = await page.locator('.sessions-section .session-row').count();
    expect(before).toBeGreaterThan(0);
    await page.fill('#session-search', 'zzz-no-such-project');
    // The table re-renders; the "N of M" counter is present and rows collapse.
    await page.waitForTimeout(200);
    const after = await page.locator('.sessions-section .session-row').count();
    expect(after).toBeLessThanOrEqual(before);
    expect(errors, 'search JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('theme toggle switches to light mode and back without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('[data-act="toggleTheme"]');
    const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.locator('[data-act="toggleTheme"]').click();
    await page.waitForTimeout(700); // allow the view-transition reveal to settle
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(initial);
    // Charts survive the theme switch.
    await expect(page.locator('#chart-timeline')).toBeVisible();
    expect(errors, 'theme toggle JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('share report card renders a canvas and closes on Escape', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#share-btn');
    await page.click('#share-btn');
    await page.waitForSelector('.share-modal', { state: 'visible' });
    await page.waitForTimeout(700); // fonts + canvas draw
    const size = await page.locator('#share-canvas').evaluate((c) => ({ w: c.width, h: c.height }));
    expect(size.w).toBeGreaterThan(0);
    expect(size.h).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.share-modal')).toHaveCount(0);
    expect(errors, 'share card JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('refresh button re-parses data and shows a completion toast', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForSelector('#refresh-btn');
    await page.click('#refresh-btn');
    // Disabled + spinning while the /api/refresh round trip is in flight.
    await expect(page.locator('#refresh-btn')).toBeDisabled();
    await expect(page.locator('#toast-root')).toContainText(/refresh/i, { timeout: 10_000 });
    await expect(page.locator('#refresh-btn')).toBeEnabled();
    expect(errors, 'refresh JS errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('footer shows both agent marks and links to the real project', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('footer');
    await expect(page.locator('footer svg[data-agent-logo]')).toHaveCount(2);
    await expect(page.locator('footer a[href="https://github.com/Akshat2634/Codelens-AI"]')).toHaveCount(2);
  });
});
