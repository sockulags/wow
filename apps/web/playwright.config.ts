import { defineConfig, devices } from '@playwright/test';
import {
  e2eHome,
  e2ePort,
  e2eSettingsHome,
  e2eSettingsOutlookControlPort,
  e2eSettingsPort,
} from './e2e/env';

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
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env['CI'],
    },
    {
      // The wow server with a scripted mock provider and the mock Outlook (e2e/server.ts); the
      // chat and calendar tests use it.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2ePort,
      env: { WOW_HOME: e2eHome, WOW_OUTLOOK: 'mock' },
      reuseExistingServer: false,
    },
    {
      // The same server in its own home for the settings tests, which add and remove provider
      // instances and change global settings.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2eSettingsPort,
      env: {
        WOW_E2E_HOME: e2eSettingsHome,
        WOW_E2E_PORT: String(e2eSettingsPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eSettingsOutlookControlPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
  ],
});
