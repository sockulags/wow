import { tmpdir } from 'node:os';
import path from 'node:path';

// The wow server the chat tests talk to: its own home (wiped at every start) and a fixed port, so
// Playwright can wait for it before the tests run.
export const e2eHome = path.join(tmpdir(), 'wow-e2e-home');
export const e2ePort = 4517;
export const e2eProviderInstanceId = 'mock-claude';
// A Codex instance on the chat server only, for the `$name` invocation form (behavior 18).
export const e2eCodexInstanceId = 'mock-codex';
export const e2eProjectId = 'demo';

// The first server's mock Outlook answers here: PUT /unavailable?message=… makes every Outlook
// request fail, DELETE /unavailable brings it back, GET /opened lists the items Outlook was asked
// to open. The settings copy listens on its own port.
export const e2eOutlookControlPort = 4519;
export const e2eSettingsOutlookControlPort = 4520;

// A second server for the settings tests. They add and remove provider instances and change
// global settings, which must not leak into the chat tests running next to them.
export const e2eSettingsHome = path.join(tmpdir(), 'wow-e2e-settings-home');
export const e2eSettingsPort = 4518;

// A third server for the trigger tests, which stop and start it themselves to exercise the
// missed-trigger policy (e2e/triggers.spec.ts).
export const e2eTriggersHome = path.join(tmpdir(), 'wow-e2e-triggers-home');
export const e2eTriggersPort = 4531;
export const e2eTriggersOutlookControlPort = 4532;
export const e2eTriggersTrackerPort = 4533;

// A fourth server for the projects tests (e2e/projects.spec.ts): they add and remove projects,
// and import folders from invented Claude and Codex session files seeded in its home.
export const e2eProjectsHome = path.join(tmpdir(), 'wow-e2e-projects-home');
export const e2eProjectsPort = 4541;
export const e2eProjectsOutlookControlPort = 4542;
export const e2eProjectsTrackerPort = 4543;
// The folders those session files point at: two exist, one is gone.
export const e2eWorkspace = (home: string, name: string) => path.join(home, 'workspaces', name);

// What provider detection finds: stand-in CLIs on the server's PATH and their config directories,
// all inside the server's home.
export const e2eBinDir = (home: string) => path.join(home, 'bin');
export const e2eClaudeConfigDir = (home: string) => path.join(home, 'claude-config');
export const e2eCodexHome = (home: string) => path.join(home, 'codex-home');
export const e2eBinary = (home: string, name: string) =>
  path.join(e2eBinDir(home), process.platform === 'win32' ? `${name}.cmd` : name);

// The mock Jira and GitHub the backlog tests publish to (e2e/server.ts): POST
// /jira/rest/api/2/issue and POST /github/repos/<owner>/<repo>/issues create invented issues, GET
// /requests lists what was received. The same port answers POST /fire?backlogItemId=…, which starts
// the workflow run of the item's card the way a trigger does. The settings copy listens on
// its own port.
export const e2eTrackerPort = 4521;
export const e2eSettingsTrackerPort = 4522;
export const e2eWorkflowId = 'backlog-e2e';
