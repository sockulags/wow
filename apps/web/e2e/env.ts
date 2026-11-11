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
// The same server holds a third repository as project `tea-garden` for the host tests
// (e2e/hosts.spec.ts): it is on a branch with an invented pull request, its `intents` folder
// holds a plan whose units have pull requests on the mock GitHub under /github on the tracker
// port, and only this project has a GitHub token. The workflow waits before its only step, so a
// run of it is live without the mock agent. On the tracker port, PUT /github-host/failure?status=…
// makes the mock host fail, DELETE brings it back, GET /github-host/requests lists what it was
// asked.
// The same server holds a fourth repository as project `tea-cup` and a workflow whose "Own
// working copy" switch the working copy tests (e2e/working-copy.spec.ts) turn on themselves: a
// run of it works in a Git worktree under the server home's `workspaces` folder, where the mock
// agent then makes its edits, and the project folder stays as seeded.
// The same server holds a fifth repository as project `tea-pot` for the plan run tests
// (e2e/plan-run.spec.ts): its `intents` folder holds a plan with three units and no pull request
// yet, on a second mock GitHub repository (`acme/tea-pot`, also under /github on the tracker
// port). Its workflow is marked "For units" and has one step without a gate; the mock agent
// answers that step by opening the unit's pull request on the mock host. On the tracker port,
// PUT /github-pot/merged?unit=U1 merges a unit's pull request.
// The same server holds a sixth repository as project `tea-leaf` for the event trigger tests
// (e2e/event-triggers.spec.ts): its plan has one unit with an open pull request on a third mock
// GitHub repository (`acme/tea-leaf`), whose branch the repository has. Its workflow has one
// step without a gate. On the tracker port, PUT /github-leaf/merged merges that pull request.
// The same server holds two workflows for the gate condition tests (e2e/gate-condition.spec.ts),
// run in the Demo project: `condition-e2e` (a check whose mock agent ends its message with
// APPROVED, or with CHANGES_REQUESTED when the step's extra prompt says "strictly", then a wrap
// up step) and `planning-e2e` (plan-work with a gate after it, whose answer also ends with
// APPROVED).
export const e2eConditionWorkflowId = 'condition-e2e';
export const e2ePlanningWorkflowId = 'planning-e2e';
// The same server holds a workflow for the rules tests (e2e/workflow-rules.spec.ts) whose second
// step is called something a diagram could read as syntax, a style or markup. The paths diagram
// of the builder must show that name as text.
export const e2eRulesWorkflowId = 'rules-e2e';
export const e2eHostileSkillName = 'say "hi" [now]\n(url(x)) <b>{end}';
// The same server holds a workflow for the limit test (e2e/run-path.spec.ts), run in the Demo
// project: a build step and a review whose mock agent always ends with CHANGES_REQUESTED and
// whose rule sends the work back to the build step, so a run reaches `workflows.maxStepVisits`.
// The mock agent answers a step with the extra prompt "Check the kettle until it holds." with
// CHANGES_REQUESTED the first time and with APPROVED when it is asked again in the same thread.
export const e2eLimitWorkflowId = 'limit-e2e';
export const e2eEventProjectId = 'tea-leaf';
export const e2eEventWorkflowId = 'event-e2e';
export const e2eEventIntentId = '2026-08-tea-leaf';
export const e2eEventBranch = 'agent/U1-pick-the-leaves';
export const e2ePlanRunProjectId = 'tea-pot';
export const e2ePlanRunWorkflowId = 'plan-run-e2e';
export const e2ePlanRunIntentId = '2026-07-tea-pot';
export const e2eCopyProjectId = 'tea-cup';
export const e2eCopyWorkflowId = 'copy-e2e';
// The same server holds a seventh repository as project `tea-field` for the GitLab tests
// (e2e/gitlab.spec.ts): its git remote is on the mock GitLab under /gitlab on the tracker port
// (project `tea/fields/tea-field`, nested groups), it is on the branch of an open merge request,
// and its plan's units have merge requests there. On the tracker port, PUT
// /gitlab-host/failure?status=… makes the mock GitLab fail, DELETE brings it back, GET
// /gitlab-host/requests lists what it was asked.
export const e2eGitLabProjectId = 'tea-field';
export const e2eGitLabIntentId = '2026-09-tea-field';
export const e2eGitLabBranch = 'agent/U2-weed-the-rows';
export const e2eGitLabProjectPath = 'tea/fields/tea-field';
export const e2eHostProjectId = 'tea-garden';
export const e2eHostWorkflowId = 'host-e2e';
export const e2eHostIntentId = '2026-06-tea-garden';
export const e2eHostBranch = 'agent/U2-water-the-beds';
// The ticket tests' backlog item in the Changes copy, published to the mock Jira as this key.
export const e2eTicketBacklogItemId = 'ticket-e2e-item';
export const e2eTicketKey = 'DEMO-41';
// The page tests' backlog item, published as this key, whose Jira description links to a page.
export const e2ePagesBacklogItemId = 'pages-e2e-item';
export const e2ePagesTicketKey = 'DEMO-42';

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

// A seventh server for the assistant tests (e2e/assistant.spec.ts). The assistant changes global
// settings (work hours, the GitLab address and token) that other tests read, and has one
// conversation per install. Its Claude instance is tested at start, so the assistant can run.
export const e2eAssistantHome = path.join(tmpdir(), 'wow-e2e-assistant-home');
export const e2eAssistantPort = 4571;
export const e2eAssistantOutlookControlPort = 4572;
export const e2eAssistantTrackerPort = 4573;
// A workflow only the assistant's server has, whose step names a skill that is not installed,
// so the diagnosis has something to say (app assistant U4).
export const e2eAssistantBrokenWorkflowId = 'assistant-e2e-broken';
// Two Codex instances only the assistant's server has, one with a default model and one
// without, and a workflow stored before wow refused a Codex step without a model (questions and
// models U2, e2e/models.spec.ts).
export const e2eCodexWithDefaultId = 'assistant-e2e-codex';
export const e2eCodexBareId = 'assistant-e2e-codex-bare';
export const e2eOldWorkflowId = 'assistant-e2e-old-review';
// A workflow whose run waits before its only step: the gate the assistant may not answer.
export const e2eAssistantGateWorkflowId = 'assistant-e2e-gate';
// The token the mock GitLab accepts, typed into the assistant's secret field.
export const e2eGitLabToken = 'gitlab-host-e2e-token';

// An eighth server for the first-start tests (e2e/first-start.spec.ts): no provider instance,
// no project, no workflow and no tracker, the way wow starts on a new machine. Its mock Codex
// fails its test with a sign-in error; its mock Claude is the assistant's mock agent.
export const e2eFirstStartHome = path.join(tmpdir(), 'wow-e2e-first-start-home');
export const e2eFirstStartPort = 4581;
export const e2eFirstStartOutlookControlPort = 4582;
export const e2eFirstStartTrackerPort = 4583;
export const e2eFirstStartCodexError =
  'Codex is not signed in. Run "codex login" in a terminal, then test again.';
