import { defineConfig, devices } from '@playwright/test';

const port = 5173;
// Lets a machine without Playwright's own Chromium download use an installed Chrome instead.
const executablePath = process.env['WOW_E2E_CHROMIUM'];

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env['CI'],
  },
});
