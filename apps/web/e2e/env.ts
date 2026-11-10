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
// A fifth server for the context panel tests (e2e/panel.spec.ts). They open the panel and change
// its width, which are global settings that would change how the calendar tests' clicks behave.
// Its home seeds a workflow that waits after its step and a card tomorrow that runs it.
export const e2ePanelHome = path.join(tmpdir(), 'wow-e2e-panel-home');
export const e2ePanelPort = 4551;
export const e2ePanelOutlookControlPort = 4552;
export const e2ePanelTrackerPort = 4553;
export const e2ePanelWorkflowId = 'panel-e2e';
export const e2ePanelCardId = 'panel-e2e-card';
// The same server seeds a workflow whose one step expects `review/*` and waits after it, and
// invented files of every kind the viewer shows in the project's `review` folder. POST
// /run?workflowId=…&runId=… on its tracker port starts a run of it.
export const e2eViewerWorkflowId = 'viewer-e2e';

// A sixth server for the Changes tab tests (e2e/changes.spec.ts): opening a changed file opens
// the context panel, a global setting the panel tests need to themselves. Its home holds an
// invented Git repository as a second project and a two-step workflow whose mock agent edits it;
// POST /run?workflowId=…&runId=…&projectId=… on its tracker port starts a run.
export const e2eChangesHome = path.join(tmpdir(), 'wow-e2e-changes-home');
export const e2eChangesPort = 4561;
export const e2eChangesOutlookControlPort = 4562;
export const e2eChangesTrackerPort = 4563;
export const e2eChangesWorkflowId = 'changes-e2e';
export const e2eChangesProjectId = 'tea-timer';
// The same server holds a second copy of that repository as project `tea-kettle` and a
// three-step workflow that waits after every step, for the gate tests (e2e/gate.spec.ts): a run
// of theirs reseeds only their own copy.
export const e2eGateWorkflowId = 'gate-e2e';
export const e2eGateProjectId = 'tea-kettle';

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
