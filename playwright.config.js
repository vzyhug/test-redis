const { defineConfig, devices } = require('@playwright/test');

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3100';
const redisUrl = process.env.REDIS_URL;

if (process.env.E2E_TEST !== 'true' || redisUrl !== 'redis://127.0.0.1:16380') {
  throw new Error('E2E is isolated to REDIS_URL=redis://127.0.0.1:16380 and E2E_TEST=true. Run npm run test:e2e.');
}

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `${process.execPath} server.js`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_TEST: 'true',
      REDIS_URL: redisUrl,
      PORT: new URL(baseURL).port || '3100',
    },
  },
});
