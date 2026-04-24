import { defineConfig } from '@playwright/test';

const CI_PORT = 3500;
const LOCAL_PORT = 3457;
const isCI = !!process.env.CI;

export default defineConfig({
  // CI runs only the smoke suite against fixtures (tests/e2e).
  // Local runs (npm run test:e2e:local) can exercise the full dashboard suite
  // in tests/local/ against a server the developer already has running.
  testDir: isCI ? './tests/e2e' : (process.env.E2E_DIR || './tests/e2e'),
  timeout: 30_000,
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${isCI ? CI_PORT : LOCAL_PORT}`,
    trace: isCI ? 'retain-on-failure' : 'off',
  },
  // Boot the CLI against fixture sessions so CI has something to render.
  webServer: isCI
    ? {
        command: `node src/index.js --no-open --port ${CI_PORT} --claude-dir tests/fixtures/claude-projects --days 30 --refresh`,
        url: `http://localhost:${CI_PORT}/api/all`,
        reuseExistingServer: false,
        timeout: 30_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
