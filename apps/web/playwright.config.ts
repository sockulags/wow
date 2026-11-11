import { defineConfig, devices } from '@playwright/test';
import {
  e2eAssistantHome,
  e2eAssistantOutlookControlPort,
  e2eAssistantPort,
  e2eAssistantTrackerPort,
  e2eChangesHome,
  e2eChangesOutlookControlPort,
  e2eChangesPort,
  e2eChangesTrackerPort,
  e2eFirstStartHome,
  e2eFirstStartOutlookControlPort,
  e2eFirstStartPort,
  e2eFirstStartTrackerPort,
  e2eHome,
  e2ePanelHome,
  e2ePanelOutlookControlPort,
  e2ePanelPort,
  e2ePanelTrackerPort,
  e2ePort,
  e2eProjectsHome,
  e2eProjectsOutlookControlPort,
  e2eProjectsPort,
  e2eProjectsTrackerPort,
  e2eSettingsHome,
  e2eSettingsOutlookControlPort,
  e2eSettingsPort,
  e2eSettingsTrackerPort,
} from './e2e/env';

const port = 5173;
// Lets a machine without Playwright's own Chromium download use an installed Chrome instead.
const executablePath = process.env['WOW_E2E_CHROMIUM'];

const browser = {
  ...devices['Desktop Chrome'],
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};
const sharedHosts = /[\\/](?:hosts|gitlab|tickets|pages)\.spec\.ts$/;
// They all talk to the one assistant conversation of the assistant's server copy.
const sharedAssistant = /[\\/](?:assistant|questions|models)\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  // Most cases wait for a run to start, a git worktree to be made or a host to be read. On the
  // Windows runner those take longer than the five seconds an assertion waits by default.
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [sharedHosts, sharedAssistant],
      use: browser,
    },
    {
      // These files share the mock GitHub, GitLab, Jira and Confluence of one server and change
      // what they answer (a failure, a refused token). Run side by side, one file's failure
      // reached another file's run. One worker keeps them after each other; the rest of the
      // suite still runs beside them.
      name: 'hosts',
      testMatch: sharedHosts,
      workers: 1,
      use: browser,
    },
    {
      // Each file waits for its own message's answer as the last row of the conversation, so
      // the two files must not write to it at the same time.
      name: 'assistant',
      testMatch: sharedAssistant,
      workers: 1,
      use: browser,
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
        WOW_E2E_TRACKER_PORT: String(e2eSettingsTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
    {
      // A copy for the projects tests, with invented Claude and Codex sessions to import.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2eProjectsPort,
      env: {
        WOW_E2E_HOME: e2eProjectsHome,
        WOW_E2E_PORT: String(e2eProjectsPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eProjectsOutlookControlPort),
        WOW_E2E_TRACKER_PORT: String(e2eProjectsTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
    {
      // A copy for the context panel tests, which open the panel and resize it (global settings).
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2ePanelPort,
      env: {
        WOW_E2E_HOME: e2ePanelHome,
        WOW_E2E_PORT: String(e2ePanelPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2ePanelOutlookControlPort),
        WOW_E2E_TRACKER_PORT: String(e2ePanelTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
    {
      // A copy for the Changes tab tests, with an invented Git repository as a project.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2eChangesPort,
      env: {
        WOW_E2E_HOME: e2eChangesHome,
        WOW_E2E_PORT: String(e2eChangesPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eChangesOutlookControlPort),
        WOW_E2E_TRACKER_PORT: String(e2eChangesTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
    {
      // A copy for the assistant tests, whose mock agent calls wow's tools.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2eAssistantPort,
      env: {
        WOW_E2E_HOME: e2eAssistantHome,
        WOW_E2E_PORT: String(e2eAssistantPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eAssistantOutlookControlPort),
        WOW_E2E_TRACKER_PORT: String(e2eAssistantTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
    {
      // A copy with no provider, project or workflow, for the first-start tests.
      command: 'pnpm exec tsx e2e/server.ts',
      port: e2eFirstStartPort,
      env: {
        WOW_E2E_HOME: e2eFirstStartHome,
        WOW_E2E_PORT: String(e2eFirstStartPort),
        WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eFirstStartOutlookControlPort),
        WOW_E2E_TRACKER_PORT: String(e2eFirstStartTrackerPort),
        WOW_OUTLOOK: 'mock',
      },
      reuseExistingServer: false,
    },
  ],
});
