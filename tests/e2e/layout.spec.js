import { expect, test } from '@playwright/test';

// Exercise content that changes intrinsic widths, not just short fixture labels.
async function loadLayoutData(page, request) {
  const payload = await (await request.get('/api/all')).json();
  const repository = payload.sessions.find(s => s.contextType === 'repository');
  const task = payload.sessions.find(s => s.contextType === 'task');
  payload.sessions = [
    { ...repository, sessionId: 'layout-repo', projectName: 'a-very-long-repository-name-that-must-stay-inside-its-column',
      model: 'a-very-long-model-name-that-must-stay-inside-its-column',
      linesAdded: 2482, linesDeleted: 1555, commitCount: 7, attributionConfidence: 'high',
      userMessageCount: 110, assistantMessageCount: 138, autopilotRatio: 27.25,
      cost: { ...repository.cost, totalCost: 1234.56 },
      commits: [{ hash: 'abc1234', subject: 'A long commit subject '.repeat(12), branch: 'feature/a-long-branch-name'.repeat(10), onMain: false, totalAdded: 2482, totalDeleted: 1555 }],
    },
    { ...task, sessionId: 'layout-task', taskName: 'a-very-long-task-name-that-must-stay-inside-its-column' },
    ...payload.sessions,
  ];
  await page.route('**/api/all*', route => route.fulfill({ json: payload }));
  await page.goto('/');
  await expect(page.locator('.session-row').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function columnOffsets(page) {
  return page.evaluate(() => {
    const headers = [...document.querySelector('.session-header').children];
    return [...document.querySelectorAll('.session-row')].flatMap(row => [...row.children].map((cell, i) => {
      const h = headers[i].getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      return Math.max(Math.abs(h.left - c.left), Math.abs(h.right - c.right));
    }));
  });
}

test('session columns stay aligned through sorting, filtering, expansion and paging', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loadLayoutData(page, request);
  expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
  const row = page.locator('.session-row[data-arg="layout-repo"]');
  const metrics = await row.evaluate(el => {
    const cells = [...el.children];
    const textRight = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().right;
    };
    return {
      // Numeric content must reach the same right edge as its heading.
      rightOffsets: [3, 4, 5].map(i => Math.abs(textRight(cells[i]) - cells[i].getBoundingClientRect().right)),
      commitOffset: Math.abs(textRight(cells[6].querySelector('span')) - cells[6].getBoundingClientRect().right),
      linesHeight: cells[7].getBoundingClientRect().height,
      overflows: cells.map(c => c.scrollWidth > c.clientWidth + 1),
    };
  });
  expect(Math.max(...metrics.rightOffsets, metrics.commitOffset)).toBeLessThan(1);
  expect(metrics.linesHeight).toBeLessThan(25);
  expect(metrics.overflows).not.toContain(true);
  await row.click();
  await expect(page.locator('.expand-row')).toContainText('abc1234');
  expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
  for (const column of ['cost', 'commitCount', 'msgs']) {
    await page.locator(`[data-act="sort"][data-arg="${column}"]`).click();
    expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
  }
  await page.getByRole('button', { name: 'Other tasks', exact: true }).click();
  expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.locator('[data-act="nextPage"]').click();
  expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
});

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`dashboard fits ${width}px in both themes with reachable filters and dialogs`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await loadLayoutData(page, request);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.locator('[data-act="toggleTheme"]').click();
      const layout = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const containers = [...document.querySelectorAll('.main-inner section, .session-filters, .session-filters button')];
        return {
          pageWidth: document.documentElement.scrollWidth,
          outside: containers.filter(el => {
            const r = el.getBoundingClientRect();
            return r.left < 0 || r.right > viewport + 1 || el.scrollWidth > el.clientWidth + 1;
          }).map(el => el.id || el.textContent.trim()),
        };
      });
      expect(layout.pageWidth).toBeLessThanOrEqual(width);
      expect(layout.outside).toEqual([]);
      expect(Math.max(...await columnOffsets(page))).toBeLessThan(1);
    }
    for (const [action, selector] of [['openCmd', '.command-palette'], ['openCli', '.cli-modal'], ['openShare', '.share-modal']]) {
      await page.locator(`[data-act="${action}"]`).click();
      await expect(page.locator(selector)).toBeVisible();
      const overflow = await page.locator(selector).evaluate(el => [...el.querySelectorAll('input, button, [data-act$="Stop"]')].filter(node => {
        const r = node.getBoundingClientRect();
        return r.left < 0 || r.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1;
      }).map(node => node.id || node.textContent.trim()));
      expect(overflow).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
}
