import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  reporter: process.env.CI ? 'list' : [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'unit', testMatch: /.*\.unit\.spec\.mjs/ },
    {
      name: 'browser',
      testMatch: /.*\.browser\.spec\.mjs/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Set PLAYWRIGHT_CHROMIUM_PATH to use a Chromium that is already on the
          // machine instead of one downloaded by `npx playwright install`.
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
          args: process.env.PLAYWRIGHT_NO_SANDBOX ? ['--no-sandbox'] : [],
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite --port 5173 --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
