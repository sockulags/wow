# Architecture

Technical decisions for wow. Behavior lives in `intents/2026-11-wow-app/spec.md`; this file says how
it is built and why. Agents delivering a unit read this before touching the layout.

## Shape

```text
apps/
  server/        Node 22, TypeScript. WebSocket RPC, SQLite, scheduler, providers, Outlook, skills.
  web/           React 19 + Vite. Renders server state. No Node APIs.
  desktop/       Electron. Spawns the server, wraps the web app, tray, autostart, notifications.
packages/
  contracts/     zod schemas for everything on the wire: RPC methods, events, projections, settings.
  shared/        small runtime helpers used by more than one package (ids, time, result type).
  client-runtime/ connection, subscriptions and stores shared by web (and a later mobile client).
  provider-claude/   Claude Agent SDK adapter → ProviderEvent / ProviderCommand.
  provider-codex/    codex app-server JSON-RPC adapter → the same types.
  outlook-bridge/    PowerShell COM bridge + mock adapter + fixtures.
  skills/        SKILL.md discovery.
  workflow-engine/   workflow definitions, runs, gates, step handover. Pure; the server wires it.
  secrets/       DPAPI (Windows) or 0600 file (elsewhere) secret store.
docs/            architecture (this file), user guide, windows-smoke checklist, releases/ notes.
intents/         agent-os intent, spec and plan.
.claude/workflows/build-wow.js   delivers the plan with at most three agents at a time.
```

Tooling: pnpm workspaces, TypeScript project references, Vitest, Playwright, oxlint + Prettier,
esbuild for `apps/desktop` (main, preload and the server bundle), electron-builder (NSIS) for the
installer, GitHub Actions on `ubuntu-latest` and `windows-latest`.

## Server

- **Transport.** `ws` WebSocket on `127.0.0.1:<port>` with a per-launch token in `~/.wow/server.json`
  (`{port, token, pid, startedAt}`, mode `0600`, removed on clean shutdown). Clients connect to
  `ws://127.0.0.1:<port>/?token=<token>`; a missing or wrong token gets HTTP 401. The port is the
  `advanced.port` setting (0 = any free port). Messages are `{id, method, params}` requests,
  `{id, result|error}` responses and `{subscription, data}` pushes, all validated with
  `packages/contracts` schemas: `rpcMethods` maps each method to its params and result schema.
  Methods: `server.info`, `dispatch` (`{commandId, command}`), `subscribe` (`{topic, threadId?}`,
  answers with a `subscriptionId` and the current rows), `unsubscribe`, `settings.resolve`,
  `secrets.set`, `secrets.delete`, `secrets.status`, `provider.test` and `provider.listModels`
  (`{providerInstanceId}`), `provider.detect`, `skills.refresh`, `workflowRuns.detectArtifacts`
  (`{runId}`), `outlook.open` (`{entryId}`), `outlook.refresh`, and `trackers.preview` and
  `trackers.publish` (`{backlogItemId, service}`). Error codes are `RpcErrorCode`.
- **Subscriptions.** One topic per projection (`subscriptionTopics` in contracts); thread-scoped
  topics (`turns`, `threadItems`, `approvals`, `questions`) need a `threadId`. After a commit that
  touched a topic, every subscriber of it gets the topic's full current rows. Subscriptions end
  with their connection.
- **Client runtime.** `packages/client-runtime` queues requests until the socket opens, fails
  in-flight requests when it drops, reconnects with capped exponential backoff and subscribes again
  after every reconnect. It reads the port and token from `server.json` (`ServerInfo`). It
  subscribes with `subscribe {topic, threadId?}`, keeps the returned `subscriptionId` per socket to
  route pushes and to `unsubscribe {subscriptionId}`, and shares one server subscription between
  listeners of the same topic and thread (a late listener gets the last rows at once).
- **Commands → events → projections.** A request becomes a command. The orchestrator (pure
  function, no I/O) turns the command plus current projection into events. One SQLite transaction
  appends the events, updates projections and records the command receipt (idempotent retries).
  Effects (start a provider turn, poll Outlook, fire a trigger) run after commit in the effect
  worker and feed results back as commands. Subscribers get projection changes after commit.
  A command carries a client-chosen `commandId`; `command_receipts` records it with a fingerprint
  of the command and the event sequence numbers, so a retry returns the first receipt
  (`duplicate: true`) without new events, and reusing an id for a different command is a
  `conflict`. A rejected command stores nothing, so its id can be retried. Commands only the
  server issues (`provider.events`, `providerInstance.recordTest`, `skills.sync`, the workflow
  runner's step outcomes) are `InternalCommand`s: they go
  through the same engine but `dispatch` over RPC does not accept them.
- **Hooks.** `startServer({hooks})` takes provider adapter factories per kind (`ProviderAdapter`
  in contracts, created with the instance and a `ProviderAdapterContext` that resolves the
  instance env with its secrets and reads `providers.testTimeoutMs` and
  `providers.requestTimeoutMs`; `main.ts` registers `installedProviders` from
  `apps/server/src/providers/installed.ts`, the Claude and Codex adapters), an Outlook service
  factory that receives `mock` or `bridge` (mock off Windows or with `WOW_OUTLOOK=mock`), and further background services. Services read settings and change
  state only through `dispatch`. `WOW_PROVIDERS=mock` gives every provider instance the mock
  adapter.
- **SQLite** via `better-sqlite3` + `drizzle-orm`, file `~/.wow/wow.sqlite`. better-sqlite3 loads
  the N-API prebuild it ships for the platform, so its node-gyp build is skipped in
  `pnpm-workspace.yaml` and no C++ toolchain is needed. Migrations in
  `apps/server/migrations` generated by `pnpm --filter @wow/server db:generate` from
  `apps/server/src/db/schema.ts` and applied at startup. Columns are snake_case. `WOW_HOME`
  overrides `~/.wow`; it is an environment variable rather than a setting because the settings
  live inside it.
- **Scheduler.** A tick every `scheduler.tickSeconds` (default 30) selects due triggers, fires
  them as commands, and applies `scheduler.missedPolicy` (`run` | `mark` | `skip`) once at startup
  for triggers whose time passed while the server was down. Times are stored as UTC ISO strings
  plus the IANA zone they were entered in; `Temporal` polyfill (`@js-temporal/polyfill`) does zone
  math. Default zone is the system zone. Details in "Scheduler and triggers".
- **Services, thin transports.** Each feature is a service with an `Effect`-free plain TypeScript
  API; RPC handlers only validate and call services.

## Data model (projections)

```text
projects         id, name, cwd, defaultProviderInstanceId, defaultModel, createdAt
provider_instances id, kind ('claude'|'codex'), name, binaryPath, configDir, env(json, secret keys by ref),
                 launchArgs, defaultModel, defaultEffort, defaultPermissionMode, status, account,
                 version?, statusMessage?   -- from the last "Test"
threads          id, projectId?, cwd, branch?, providerInstanceId, providerSessionId?, title, model,
                 effort, permissionMode, state ('idle'|'working'|'needs_you'|'done'|'failed'),
                 pinned, runId?, stepId?, createdAt, updatedAt
turns            id, threadId, index, state, startedAt, endedAt, usage(json)
thread_items     id, threadId, turnId, index, kind ('user'|'assistant_text'|'reasoning'|'tool_call'|
                 'approval'|'question'|'task_list'|'usage'|'error'), payload(json), streaming
approvals        id, threadId, itemId, kind, request(json), decision?, decidedAt?
questions        id, threadId, itemId, request(json), answer?, answeredAt?
calendar_items   id, source ('outlook'|'local'), externalId?, title, start, end, zone, allDay,
                 location?, joinUrl?, body?, projectId?, backlogItemId?, workflowId?, runId?, state,
                 updatedAt   -- state: CardState for cards, 'scheduled'|'cancelled' for Outlook
mail_items       id, externalId, folder, from, subject, receivedAt, unread, snippet
outlook_status   singleton: lastSyncAt, lastError?, unavailableSince?, unreadCount, bridgeVersion
backlog_items    id, title, body, tags(json), state, runId?, remote(json: service,key,url)?, createdAt
workflows        id, name, templateKind?, steps(json: WorkflowStep[]), createdAt, updatedAt
workflow_runs    id, workflowId, projectId, calendarItemId?, backlogItemId?, state ('running'|
                 'waiting'|'done'|'failed'|'stopped'), currentStep, steps(json: StepRun[]),
                 startedAt, endedAt
triggers         id, calendarItemId, workflowId, runAt, zone, state ('scheduled'|'fired'|'missed'|
                 'cancelled'), runId?, offerRunNow
notifications    id, at, kind ('started'|'waiting'|'failed'), title, body, path, runId?,
                 calendarItemId?
skills           id, name, description, dir, source ('user-claude'|'user-codex'|'project-claude'|
                 'project-agents'|'custom'), manualOnly, invocations(json: {claude, codex})
settings         key, value(json), scope ('global'|'project:<id>'|'provider:<id>')
events           seq, at, kind, aggregate, payload(json)   -- the history
command_receipts commandId, commandType, fingerprint, seqs(json), at   -- idempotent retries
```

`WorkflowStep = {id, skillName, providerInstanceId, model?, effort?, permissionMode?, gateBefore,
gateAfter, extraPrompt?, expectedArtifacts: string[]}`. `StepRun = {stepId, state, threadId?,
startedAt?, endedAt?, artifactsFound: string[], finalMessage?, error?}`.

## Providers

Both adapters implement one interface from `packages/contracts`:

```text
ProviderCommand: startTurn {threadId, cwd, prompt, model, effort, permissionMode, resumeId?}
                 interrupt {threadId} | answerApproval {approvalId, decision} |
                 answerQuestion {questionId, answer} | setModel | setPermissionMode | listModels | test
ProviderEvent:   session {providerSessionId} | textDelta | reasoningDelta | toolCallStarted |
                 toolCallOutput | toolCallCompleted | approvalRequested | questionAsked |
                 taskListUpdated | usage | contextUsage | turnCompleted | turnFailed | turnInterrupted
```

- **Claude** (`packages/provider-claude`): `@anthropic-ai/claude-agent-sdk` `query()` in streaming
  input mode (an `AsyncIterable<SDKUserMessage>` prompt) so `interrupt()`, `setModel()` and
  `setPermissionMode()` work mid-session. `pathToClaudeCodeExecutable` from the instance's binary
  path, `env: {...process.env, CLAUDE_CONFIG_DIR, ...instance.env}`, `settingSources:
['user','project','local']` so skills and plugins load, `includePartialMessages: true` for
  deltas, `resume` with the stored session id, `canUseTool` turns a prompt into `approvalRequested`
  and an `AskUserQuestion` call into `questionAsked`. `effort` passes through. Usage comes from
  the result message and `getContextUsage()`.
- **Codex** (`packages/provider-codex`): spawn `<binaryPath> app-server <launchArgs>` with
  `CODEX_HOME` and the instance env, newline-delimited JSON-RPC on stdio (codex leaves out the
  `jsonrpc` member). `initialize` + `initialized` → `thread/start` or `thread/resume` →
  `turn/start`; `turn/interrupt`; notifications for items (`item/started`, `item/completed`, agent
  message, reasoning, command and file change output deltas), `turn/plan/updated`,
  `thread/tokenUsage/updated` and `turn/completed`; server-initiated requests
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and
  `item/permissions/requestApproval` map to `approvalRequested`, `item/tool/requestUserInput` to
  one `questionAsked` per question; `model/list` feeds the picker and `account/read` the "Test"
  action. Method names and types are generated, not written from memory:
  `scripts/generate-protocol.mjs` runs `codex app-server generate-ts` for the installed codex and
  keeps the methods the adapter uses (currently codex 0.166.0). `initialize` reports the codex
  version only inside `userAgent`; the adapter reads it there and "Test" fails with a clear message
  when it is not the generated version. Permission modes (`read-only`, `auto`, `untrusted`,
  `full-access`) are an approval policy plus a sandbox; model, effort and permission mode travel
  with every `turn/start`. Every request waits at most `providers.requestTimeoutMs` (read per
  request); a timeout fails the request and restarts the app-server. Details in
  `packages/provider-codex/README.md`.
- **Provider service** (`apps/server/src/providers/service.ts`). Thread commands
  (`thread.create`, `thread.sendMessage`, `thread.interrupt`, `thread.configure`,
  `thread.setPinned`, `approval.answer`, `question.answer`) become events; after commit the service sends the
  matching `ProviderCommand` to the instance's adapter (one adapter per instance, created on first
  use). `thread.sendMessage` starts turn `<threadId>:turn:<n>` with the thread's model, effort,
  permission mode and stored provider session id as `resumeId`. Adapter events are queued and
  stored one batch per thread per tick as a `provider.events` command, which the orchestrator
  (`core/threads.ts`) turns into rows: text and reasoning deltas append to one
  `assistant_text`/`reasoning` item per provider item id (`{text}`), tool calls are `tool_call`
  items (`{name, input, output, status}`), `approval` and `question` items point at their
  `approvals`/`questions` rows (the payload of each item kind is a schema in
  `packages/contracts`, `*ItemPayload`), the task list is one `task_list` item per turn (`{tasks}`), and
  usage plus context usage merge into one `usage` item per turn and the turn's `usage`. Provider
  ids are only unique per session, so row ids are prefixed with the turn or thread id. Thread
  state: `working` while a turn runs, `needs_you` while an approval or question is open, `idle`
  after a completed or interrupted turn, `failed` after a failed one. An effect that cannot start
  or interrupt a turn fails the turn with the reason; a turn still `running` at startup failed
  with the previous server process and is marked so. Events after a turn ended are dropped.
- **Claude details.** The SDK version is pinned exactly in `packages/provider-claude/package.json`.
  `launchArgs` (`--flag value`, `--flag=value`, `--flag`) become the SDK's `extraArgs`. Effort
  `default` leaves the effort to Claude Code; other values must be an SDK `EffortLevel`. A thread
  keeps one `query()` while the server runs; model, permission mode and effort changes are applied
  to it before the next prompt. `canUseTool` waits for the answer: allow once, allow for this
  session (the SDK's suggested rules with destination `session`) or deny; an interrupt denies with
  `interrupt: true`. `AskUserQuestion` may hold several questions; each is asked separately and the
  tool runs with `answers` once all are answered. The task list comes from `TodoWrite` (whole list)
  or `TaskCreate`/`TaskUpdate` (one task at a time). `total_cost_usd` is cumulative per query, so a
  turn's cost is the difference to the previous result. `test` runs a tool-less one-turn query in
  the temp directory and reports `claude_code_version` from the init message and the account from
  `accountInfo()`; the server stores them on the instance. `listModels` uses `supportedModels()` of
  a live session or a short-lived query.
- **Chat options.** What the thread header offers per provider kind (permission modes, the
  effort that leaves the choice to the provider, the compact message) is `providerChatOptions`
  in `packages/contracts`, because the web app cannot import the adapters. The keys are the ones
  the adapters accept. Models and their efforts come from `provider.listModels`. Compact is
  Claude's `/compact` sent as a message; codex has none in the adapter yet.
- **Instances.** A provider instance is one binary + one config directory + env. Several instances
  of the same kind are allowed (work and personal accounts). A thread remembers its instance and
  can only resume on an instance with the same config directory.
- **Onboarding** (`apps/web/src/providers`). Settings → Providers lists the instances with the
  status, account and version of their last "Test" and adds, edits, tests and removes them; palette
  commands do the same from anywhere. `provider.detect` looks for `claude` and `codex` on the
  server's PATH (PATHEXT on Windows) and reports the config directory each would use
  (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else `~/.claude` / `~/.codex`); what the onboarding needs
  per kind is `providerSetup` in contracts. With no instance at all the web app opens a first-run
  wizard that creates and tests one instance per detected CLI. Secret environment values go to
  `secrets.set` as `provider:<instanceId>:env:<NAME>` and the instance stores the reference.
  `providerInstance.update` clears the last test when the binary, config directory, environment or
  launch arguments change, and both it and `providerInstance.delete` are refused while a turn runs
  on the instance; delete is also refused while threads use it. After commit the provider service
  drops the instance's adapter (the next use builds one from the new row) and deletes secrets the
  instance no longer references. Delete also removes provider-scoped settings and clears project
  defaults that pointed at it.

## Outlook bridge

`packages/outlook-bridge/bridge.ps1` is started once with `powershell.exe -NoProfile
-NonInteractive -ExecutionPolicy Bypass -File bridge.ps1` and speaks JSON lines. Every answer
carries the request `id` and either a `result` or an `error` with code `unavailable` (Outlook is
not running or stopped answering), `bad_request` or `failed`:

```text
→ {"id":1,"op":"ping"}
← {"id":1,"result":{"version":"1","outlook":"available","message":null}}
→ {"id":2,"op":"calendar","from":"2026-11-02T00:00:00+01:00","to":"2026-11-16T00:00:00+01:00"}
← {"id":2,"result":{"items":[{"entryId":"...","subject":"...","start":"...","end":"...",
     "location":"...","isAllDay":false,"isRecurring":true,"isCancelled":false,"organizer":"...",
     "joinUrl":"https://teams...","busyStatus":2}]}}
→ {"id":3,"op":"unreadMail","folders":["Inbox"],"limit":50}
← {"id":3,"result":{"items":[{"entryId":"...","folder":"Inbox","from":"...","subject":"...",
     "receivedAt":"...","snippet":"..."}],"unreadCount":7}}
→ {"id":4,"op":"open","entryId":"..."}     (Outlook shows the item)
← {"id":4,"result":{"opened":true}}
← {"id":5,"error":{"code":"unavailable","message":"Outlook is not running"}}
```

The schemas for these lines live in `packages/outlook-bridge/src/protocol.ts`, not in
`packages/contracts`, because they never leave the server.

Implementation notes: the bridge attaches to a running Outlook with
`[Marshal]::GetActiveObject('Outlook.Application')` instead of `New-Object -ComObject`, so it never
starts Outlook itself (behavior 3: Outlook not running means "unavailable"). `GetNamespace("MAPI")`,
`GetDefaultFolder(9)` for the calendar with `Sort("[Start]")`, then `Items.IncludeRecurrences =
$true`, and a `Restrict` on `[Start]`/`[End]`; iteration stops at the window end because a series
without an end date never runs out of occurrences. `GetDefaultFolder(6)` and
`Restrict("[UnRead] = True")` for mail; folder names other than `Inbox` are looked up under the
inbox, then at the top of the mailbox. Times go out as `DateTimeOffset` strings with the local
offset. A cancelled meeting that is still in the calendar has `isCancelled` (MeetingStatus 5 or 7).
The Teams join link is read from the item body or the `Location` when it looks like a
`teams.microsoft.com/l/meetup-join` URL.

`OutlookSource` is the interface (`ping`, `calendar`, `unreadMail`, `open`, `close`).
`PowershellOutlookSource` starts the bridge on first use, numbers requests, and times each one out
after `outlook.requestTimeoutMs`; a timeout (Outlook blocked by a modal dialog) or an exit rejects
every pending request, kills the process, and the next request starts a fresh one.
`MockOutlookSource` answers from `packages/outlook-bridge/fixtures` (invented items placed relative
to today: a weekday standup with a Teams link, a weekly 1:1, an all-day offsite, a cancelled
meeting, unread mail in two folders) and is selected off Windows and with `WOW_OUTLOOK=mock`
(`prefersMock`, `createOutlookSource`).

`OutlookSync` polls every `outlook.pollSeconds` (re-read before each poll; one poll at a time). The
window runs from the start of the current week (`calendar.firstDayOfWeek` in `calendar.zone`) to
the end of the day `calendar.lookaheadDays` after today. Unread mail is read only while
`outlook.mailRail` is on, at most `outlook.mailLimit` messages from `outlook.folders`. A poll
hands the server's `OutlookSink` either a snapshot or a failure:

- **Snapshot.** Calendar rows with id `outlook:<externalId>`, where `externalId` is the EntryID, or
  `EntryID@<occurrence start>` for a recurring series because occurrences share the EntryID, state
  `scheduled` or `cancelled`, plus mail rows with id `outlook-mail:<EntryID>`, the unread count and
  the bridge version. `diffCalendar` and `diffMail` turn a snapshot and the stored rows into
  upserts and removals: Outlook rows overlapping the window that Outlook no longer returns are
  removed (deleted or moved meetings), rows outside the window stay; mail rows not returned are
  removed. The server applies them and sets `outlook_status.lastSyncAt`, clears `lastError` and
  stores `bridgeVersion`.
- **Failure.** Code, message and `unavailableSince` (the first failed poll since the last good
  one, for the "Outlook unavailable since <time>" banner). The server sets
  `outlook_status.lastError` and keeps the cached rows.

The server side is `apps/server/src/outlook/service.ts` (`startOutlookService`, registered as the
`outlook` hook in `main.ts`). It runs `OutlookSync` and turns each snapshot into an internal
`outlook.sync` command and each failure into `outlook.fail`. The orchestrator
(`core/calendar.ts`) compares the snapshot with the stored rows and emits one `outlook.synced` event
with only the changed and removed rows plus the new status, so the history holds what changed, not
every poll's full contents. A failure that repeats the stored error adds no event. `outlook.open`
asks the source to show an item and `outlook.refresh` polls at once (the palette's "Refresh
Outlook"). An Outlook row never changes through a card command, and a card id may not start with
`outlook`.

## Skills discovery

`packages/skills` scans the directories in `skills.directories` (defaults: `~/.claude/skills`,
`~/.codex/skills`, `<project>/.claude/skills`, `<project>/.agents/skills`) for `*/SKILL.md`, parses
frontmatter (`name`, `description`, `disable-model-invocation`) and `agents/openai.yaml`
(`policy.allow_implicit_invocation`) and produces `invocations: {claude: "/name", codex: "$name"}`.
Plugin-installed Claude skills are found under the Claude plugin cache when `skills.includeClaudePlugins`
is on and get `/plugin:name`. A `chokidar` watcher refreshes the projection.

`skills.directories` entries use `~` for the home folder and `<project>` for every project folder;
the four defaults keep their source and anything else is `custom`. A skill's id is its folder.
`manualOnly` is set by `disable-model-invocation: true` or `allow_implicit_invocation: false`; such
skills are still offered because the app invokes them explicitly. Plugin skills are read from
`~/.claude/plugins/installed_plugins.json` (the last install of each plugin), or, without that file,
from the newest version folder in `~/.claude/plugins/cache/<marketplace>/<plugin>/`; the plugin
name comes from `.claude-plugin/plugin.json`. A `SKILL.md` that does not parse is logged and
skipped. The server's `SkillsService` scans at startup, when a watched folder changes, when the
skills settings or the project list change, and on `skills.refresh`; scans run one at a time and a
burst of changes shares one queued scan. It sends the result as a `skills.sync` command, which
stores only the differences.

## Workflow engine

`packages/workflow-engine` is pure: given a workflow, a run and an event (step completed, gate
answered, trigger fired) it returns the next run state and the effects to perform (start thread
with prompt, notify, finish). The server performs them. The step prompt is:

```text
<skill invocation for the step's provider>  <extraPrompt>

<handover: workflows.handoverTemplate rendered with previous step's final assistant message,
 the backlog item body if any, and the expected artifact paths>
```

`workflows.handoverTemplate` is a setting (project scope). `{{name}}` is replaced and
`{{#name}}…{{/name}}` is dropped when the value is empty; the values are `previousStep`,
`previousMessage`, `backlogBody`, `previousArtifacts` (found by earlier steps) and
`expectedArtifacts` (this step's globs). Artifact detection runs `fast-glob` with the step's
`expectedArtifacts` in the project `cwd` when the step completes and on run view open
(`workflowRuns.detectArtifacts`).

Gates. A gate sits between two steps. After a step with `gateAfter` its turn is over and the step
itself shows `waiting` (its thread shows "needs you"). Before a step with `gateBefore` that step
shows `waiting` without a thread, and the previous step's thread shows "needs you". The run is
`waiting` in both cases and `pendingGate(run)` tells them apart. One Continue passes the gate
between two steps even when both flags are set. Stop ends the run as `stopped`, interrupts a
running turn and keeps every thread.

Commands: `workflow.create|update|delete`, `workflowRun.start|continue|stop` from clients, and
`skills.sync` and `workflowRun.stepCompleted|stepFailed|artifactsFound` as `InternalCommand`s from
the server. The orchestrator calls `startRun`/`advance` and stores one `workflowRun.changed` event
(the run plus the effects to perform), an idle `thread.created` with `runId` and `stepId` for each
started step (model, effort and permission mode from the step, then the provider instance
defaults) and `thread.stateChanged` for gates. Step changes and deletes are refused while a run of
the workflow is live, because a run follows its steps by position. Thread ids are
`<runId>.<stepId>`. The step's invocation comes from the skills projection, matched by name
(`plugin:name` picks a Claude plugin's skill); `invocationsFor` in `packages/skills` formats both
the scanned skills and unknown ones.

`WorkflowRunner` performs the effects after commit through the thread commands: `startStep`
dispatches `thread.sendMessage` with the rendered prompt, so the provider service starts the turn
like any other, and `interrupt` dispatches `thread.interrupt`. A step ends when the persisted
`turn.ended` of its thread does: completed becomes `workflowRun.stepCompleted` with the turn's
last assistant text as the final message and the artifacts found, failed (with the turn's error
item) or interrupted becomes `workflowRun.stepFailed`. Command ids derive from the turn, so a
repeated report is a duplicate. A step with no model, effort or permission mode fails instead of
starting. At startup the runner subscribes before `ProviderService.recover()`, so a step whose turn
was running fails with the recovered turn; `recover()` on the runner then settles steps whose turn
ended unseen or never started. `notify` effects go to `onNotify` listeners; the orchestrator also
stores them as notifications (see "Scheduler and triggers"). `missedTriggerOutcome(policy)` is the
engine's table for the scheduler's missed policy.

## Scheduler and triggers

A local card with a workflow and a project has one trigger, id `<cardId>:trigger`, at its start
(`core/triggers.ts`). `card.create` and a `card.update` that changes the start, zone, project or
workflow bring it in line: a start in the future makes it `scheduled`, a start already past makes
it `missed` with `offerRunNow` (the user placed the card in the past, so it is not run on its own),
and a card without a workflow or project cancels it. A card that has started a run keeps its fired
trigger. Every change is one `trigger.set` event with the whole row.

`Scheduler` (`apps/server/src/scheduler/service.ts`) is started last by `startServer` and stopped
first. Every `scheduler.tickSeconds` it dispatches `trigger.fire {triggerId, runAt, runId}` for each
`scheduled` trigger whose `runAt` has passed; the orchestrator ignores a trigger that is no longer
scheduled at that time, so a moved card or a repeated tick fires nothing. At start, and when
`scheduler.paused` turns off, it dispatches `trigger.applyMissed {policy}` for the due ones instead:
`run` fires them, `mark` sets the trigger `missed` with `offerRunNow`, `skip` sets it `missed`
without; the card shows `missed` in both. While paused nothing fires. Firing starts the run with
the card's project and backlog item through the same code as `workflowRun.start`; a run that cannot
start (its workflow is gone, say) fires the trigger without a run and fails the card instead of
retrying every tick. `startServer({clock, schedulerTimers})` lets tests move time and call
`scheduler.tick()` themselves.

The card follows its run: every run transition with a `calendarItemId` sets the card's `state`
(`running`, `waiting`, `done`, `failed`, `stopped`) and `runId` with `card.stateChanged`; a card run
again follows the newer run. `card.runNow {cardId, runId}` starts a run for a card with a workflow
and project and no live run, and fires its trigger. `card.delete` of a card whose run is running or
waiting is refused with `conflict` unless it says `stopRun`: `true` stops the run in the same
command, `false` leaves it going; the threads stay either way.

Notifications are the server's channel to the user. While `scheduler.notifications` is on, the
orchestrator stores a `notification.sent` row when a trigger starts a run, when a run waits at a
gate and when a run or a trigger fails; ids derive from the run, step and gate, so a repeated
transition notifies once. Clients read the `notifications` topic (newest first): the web app shows
the rows that arrive after its first snapshot as toasts for `scheduler.toastSeconds`, and clicking
one opens its `path`.

## Settings registry

`packages/contracts/src/settings.ts` exports `settingsRegistry`: a map of key → `{schema: zod,
group, label, description, default, scope: 'global'|'project'|'provider', restartRequired?,
secret?}`. The server validates writes against it; the settings UI renders groups and fields from
it (text, number, boolean, enum, list, key-value with secret flag, keybinding). Adding a setting is
one entry. A definition's `scope` is the narrowest place it may be stored: `global` settings only
globally, `project` settings also per project, `provider` settings also per project and per
provider instance. Reads resolve provider over project over global over the default, skipping a
stored value that no longer passes the schema. Writes are `setting.set` / `setting.reset`
commands, so they are events like everything else; the server reads SQLite on every `get`, so a
change applies at once, and services holding derived state listen with `onChange`. The page picks the editor from the zod schema type; schemas that need a special editor
carry `.meta({ widget: 'keybinding' | 'keyValue' | 'secret' })` (see `Keybinding`, `KeyValueList`
and `SecretSetting`, a password field for a secret setting's reference). Objects
render their fields; anything else falls back to a JSON editor. Connected to a server, the web app
reads the `settings` topic and writes global values with `setting.set` / `setting.reset`
(`apps/web/src/settings/server-source.ts`); without one it uses the in-memory `SettingsSource`
from `packages/client-runtime`.

The settings below are the registry. `apps/server/src/settings/coverage.test.ts` reads this list:
a key named here and missing from the registry, or registered and missing here, fails the tests.
A group marked with a unit (`(U12)`) belongs to a unit not delivered yet; its keys must not exist
until that unit removes the mark. `group.*` covers every key of the group.

- providers: `providers.testTimeoutMs`, `providers.requestTimeoutMs`
- chat: `chat.contextMeter`, `chat.resumePrompt`
- calendar: `calendar.zone`, `calendar.firstDayOfWeek`, `calendar.workHours`,
  `calendar.lookaheadDays`, `calendar.snapMinutes`, `calendar.cardMinutes`,
  `calendar.hourHeight`
- outlook: `outlook.pollSeconds`, `outlook.folders`, `outlook.requestTimeoutMs`,
  `outlook.mailRail`, `outlook.mailLimit`
- scheduler: `scheduler.tickSeconds`, `scheduler.missedPolicy`, `scheduler.notifications`,
  `scheduler.paused`, `scheduler.toastSeconds`
- workflows: `workflows.templates`, `workflows.handoverTemplate`
- skills: `skills.directories`, `skills.includeClaudePlugins`
- trackers: `trackers.jira.baseUrl`, `trackers.jira.authMode` (`cloud-basic` or `pat`),
  `trackers.jira.email`, `trackers.jira.token` (secret), `trackers.jira.projectKey`,
  `trackers.jira.issueType`, `trackers.github.baseUrl`, `trackers.github.token` (secret),
  `trackers.github.owner`, `trackers.github.repo`, `trackers.github.labels`,
  `trackers.requestTimeoutMs`
- appearance: `appearance.theme`, `appearance.uiFont`, `appearance.codeFont`, `appearance.density`
- keybindings: `keybindings.*`, one per command that has a shortcut
- desktop: `desktop.autostart`, `desktop.closeToTray`, `desktop.startMinimized`
- updates: `updates.enabled`, `updates.checkIntervalMinutes`
- advanced: `advanced.port`, `advanced.logLevel`, `advanced.secretsTimeoutMs` (`WOW_HOME` is an
  environment variable, see "Server")

The same test fails when `apps/server/src` or `apps/web/src` declares a tunable-looking constant
(a `const`, `readonly` field or object property named like `*Ms`, `*Seconds`, `*Timeout`,
`*Interval`, `*Limit`, `*Port` with a literal number other than 0 or 1, or a literal delay passed
to `setTimeout` / `setInterval`) that has no registry entry. A value that is truly not a setting
goes into the test's exemptions with the reason.

## Secrets

`packages/secrets` stores `~/.wow/secrets.json`. On Windows values are protected with DPAPI
(`[System.Security.Cryptography.ProtectedData]::Protect`, current user scope) through a short
PowerShell call (`-EncodedCommand` script, value on stdin, so the secret never appears on a
command line); elsewhere the file is plain with mode `0600` and the UI shows a warning
(`secrets.status` reports the protection). Writes go to a `0600` temporary file that is renamed
over the store. Settings marked `secret` store a reference `{secretRef}`, never the value; the
orchestrator rejects anything else.

## Desktop

Electron main spawns the bundled server (`out/server/server.mjs`, `resources/server` when
packaged) with the Electron binary and `ELECTRON_RUN_AS_NODE=1`, waits for `~/.wow/server.json`
naming the child's pid (a file left by another process is ignored), connects its own WebSocket
client, and serves the built web app from the privileged `wow://app/` scheme so the router sees
normal paths. The sandboxed preload exposes `server.json` as `window.wowServerInfo`, which the web
bootstrap reads. On quit the desktop sends `{type: 'wow:shutdown'}` over the child's IPC channel
(Windows has no signals between processes); a shim in the server bundle turns it, or a closed
channel when the desktop dies, into the SIGTERM the server entry handles. A server that does not
stop in time is killed; one that dies unexpectedly leads to a Restart / Quit dialog.

Tray icon with Open, New thread (`/chat?new=1`), Pause/Resume scheduler and Quit; clicking it
opens the window. Pause toggles the `scheduler.paused` setting, which the scheduler honours; the
web app's palette has the same Pause/Resume scheduler command.
`desktop.closeToTray`, `desktop.autostart` (`app.setLoginItemSettings` with `--hidden`, so a login
start stays in the tray) and `desktop.startMinimized` are settings the desktop follows through the
`settings` topic. Notifications use Electron's `Notification`, gated by `scheduler.notifications`,
and are derived from changes on the `workflowRuns` topic: a new run, a run entering `waiting`, a
run entering `failed`. A single-instance lock makes a second launch show the running window.

The server bundle is one esbuild ESM file. Server modules find files next to their sources with
`new URL('<relative>', import.meta.url)`; the build rewrites each module's `import.meta.url` to
its repository path under `out/server/` and copies every file so named there (server
`package.json`, migrations, Outlook fixtures, `bridge.ps1`). better-sqlite3 stays outside the
bundle in `out/server/native/better-sqlite3` with its N-API prebuilds. N-API binaries load in
Electron's Node unchanged, so nothing is rebuilt: `@electron/rebuild` would need the C++
toolchain the install deliberately avoids, and electron-builder's rebuild is off. `pnpm --filter
@wow/desktop smoke` proves the bundle under Electron's Node (SQLite opens, RPC answers, clean
stop), and CI runs it before building the NSIS installer on `windows-latest`. No code signing.

**Auto-update** (behavior 35). `electron-updater` reads GitHub Releases of `sockulags/wow`: the
`publish` block in `electron-builder.yml` (provider `github`, `releaseType: release`) makes `dist`
write `latest.yml` and the installer's `.blockmap` next to the installer and `app-update.yml` into
the packaged resources. `dist` still runs with `--publish never`; the release workflow uploads the
installer, its `.blockmap` and `latest.yml` to a release that is neither a draft nor a prerelease,
because electron-updater only looks at the newest stable one. The repository is public, so no
token is needed. The installer is per-user, so an update needs no admin rights; it is unsigned,
and with no publisher name in `app-update.yml` electron-updater skips the signature check.

`UpdateManager` (`apps/desktop/src/main/updates.ts`) owns the update state (`UpdateState` in
contracts: `idle`, `checking`, `available`, `downloading` with a percent, `ready`, `error`, plus
the current and the new version and the last error). It follows `updates.enabled` and
`updates.checkIntervalMinutes` through the `settings` topic: it checks when updates are on at
start or are turned on, and on an interval; it never checks while a check or download runs or an
update is ready. electron-updater sits behind the `Updater` seam (`electron-updater.ts`:
`autoDownload` on, `autoInstallOnAppQuit` off, no prereleases or downgrades), so the tests drive a
fake. The main process creates it only when `app.isPackaged`; in development there is no update
state and nothing runs. Every change goes to the web app through the preload
(`window.wowDesktop.updates`: `getState`, `onState`, `check`, `install` over IPC that only
`wow://app` pages may call) and to the tray; the web app keeps the last state it received
(`apps/web/src/app/updates.ts`) and shows it in a bar above every view (ready or failed), on
Settings → Updates, and as the palette commands "Check for updates" and "Restart to update". The
update state stays in the main process rather than the server because the desktop is the only
place that can act on it and it means nothing to a server without the desktop. A ready update also
raises one system notification.

"Restart to update" (web app or tray) is `DesktopController.installUpdate`: if a thread is working
or waiting on the user, or a workflow run is running (from the `threads` and `workflowRuns`
topics), a dialog says so and the user decides, because the restart ends those turns as failed.
Then the server stops through the normal lifecycle (`wow:shutdown`, `server.json` removed) and
`quitAndInstall(silent, run after)` hands over; `before-quit` lets this quit through. If the
installer cannot start, the server starts again, the window opens on Settings → Updates and the
error is shown.

Releases: the version is `apps/desktop/package.json` (the installer name) and
`apps/server/package.json` (what the server reports), kept equal. The owner runs
`docs/windows-smoke.md` against the installer from the release candidate's CI run and fills in the
checklist in `docs/releases/v<version>.md`. Pushing tag `v<version>` runs
`.github/workflows/release.yml`: it refuses a tag that differs from the desktop version or whose
notes still say "Smoke result: pending", then builds and smoke-tests the installer from the tagged
commit and attaches it to the GitHub release for the tag, creating the release from the notes file
if it does not exist.

## Chat view

`apps/web/src/chat`. `/chat` shows the thread list (grouped Needs you, Working, Idle, Done; failed
threads sit under Idle with a marker; pinned first, then by `updatedAt`) next to `/chat/new` (the
draft: provider instance, project or folder, model, effort, permission mode; the thread is created
with the first message, titled by its first line) or `/chat/$threadId`. A thread subscribes to
`threads`, `turns`, `threadItems`, `approvals` and `questions`; whether a turn runs comes from
`turns`, never from a local timer. Rows skip layout off screen (`content-visibility: auto`) and
tool input and output only render while a row is open, which keeps long conversations cheap
without a virtual list. Palette commands: every thread, New thread, Switch provider (a thread
keeps its instance, so this opens a draft on the other instance in the same project or folder) and
Stop turn while a turn runs.

## Workflow builder and run view

`apps/web/src/workflows`. `/workflows` lists the workflows and their runs (live runs first) next
to `/workflows/new` (`?template=<kind>` starts from that entry of `workflows.templates`),
`/workflows/$workflowId` (the builder for a saved workflow plus Run now in a chosen project and
its runs) or `/workflows/runs/$runId`. The builder edits a local draft: name, template kind, and
ordered steps reordered by dragging a step's handle or with its move buttons. A step picks a skill
from the `skills` topic (stored as its name, or `plugin:name` for a Claude plugin's skill), a
provider instance, and model, effort and permission mode with the chat's pickers; empty ones are
filled with the instance defaults, else the first listed model. Expected artifact globs are typed
one per line. Validation needs a name, a step, and per step a skill, an instance, a model, an
effort and a permission mode; a skill missing from the scan is only a warning, because the server
invokes unknown skills by name. "Start from" a template replaces the steps; Refresh skills calls
`skills.refresh`. Run now is offered only for the saved steps. The run view asks
`workflowRuns.detectArtifacts` when it opens and renders the run row: each step's state, its
thread link, the expected globs and the found files as `file://` links into the project folder
with a copy-path button. The gate bar reads the gate the way `pendingGate` does (the current step
has ended: after it; not started: before it) and offers Continue and Stop; Stop alone while a step
runs. Palette commands: New workflow, New workflow from each template, Refresh skills, every
workflow and run, and Continue run and Stop run for the open run.

## Calendar view

`apps/web/src/calendar`. `/calendar?view=day|week&date=YYYY-MM-DD` shows a time grid for one day or
one week starting on `calendar.firstDayOfWeek`, in `calendar.zone`, with `calendar.workHours`
shaded; the URL holds the view, so a reload shows the same range. Days are counted in local dates
and an instant's place in a day is its wall-clock time in the zone, so a week that crosses a DST
change still has seven columns and a 09:15 meeting sits at 09:15 on both sides of it
(`time.ts`, `layout.ts`). All-day Outlook items sit in a row above the grid; overlapping items share
the column side by side. Outlook items are read-only (a lock marker, the Teams join link when there
is one, struck through when cancelled). Local cards are created by clicking (a
`calendar.cardMinutes` card) or dragging a range, then named in the card dialog; dragging a card
moves it (also to another day), dragging its lower edge resizes it, both snapped to
`calendar.snapMinutes`; the dialog edits title, times, project, workflow and backlog item and
deletes. While a drag is in progress the card is drawn where the pointer is; when the pointer is
released the card is drawn at its new place until the server's row arrives, and the server row
wins. Cards show their `state` as a badge; the calendar only creates them `scheduled`, the
scheduler and the card's run change it. A missed card whose trigger offers it has a one-click
"Run now" on the card and a "Run now: <card>" palette command; the dialog shows the card's run with
a link to it, offers Run now for a missed or failed card, and asks "Stop run and delete" or "Keep
run and delete" before deleting a card whose run is live. While `scheduler.paused` is on the
toolbar shows "Scheduler paused", which resumes it. The mail rail lists `mailItems` newest first with the `unreadCount` from
`outlook_status`; clicking an entry calls `outlook.open`. A banner shows "Outlook unavailable since
<time>" while `outlook_status.lastError` is set. Palette commands: today, next, previous, day view,
week view (on the calendar only, with the `keybindings.calendar*` keys), New card, Refresh
Outlook, and one "Edit card" entry per card.

## Backlog and trackers

`apps/server/src/core/backlog.ts` decides `backlog.create|update|delete|plan` and the internal
`backlog.published`. Tags are stored trimmed and unique. `backlog.plan` ("Plan on calendar") is one
command for the card and the item: it builds the `card.create` the calendar would accept (title from
the item, the chosen workflow, project and time, linked to the item) and moves the item to
`planned`, so a refused card leaves the item as it was. Delete and plan are refused while a run of
the item is live; delete unlinks the item's cards. Every `workflowRun.changed` of a run with a
backlog item also emits `backlog.updated` when the item's state or `runId` differs from what the run
means: running or waiting is `running`, done is `done`, failed or stopped is `planned`. The item
keeps the `runId`, so the backlog shows the failed step's error from the run (behavior 29).

`apps/server/src/trackers` publishes (behavior 30). `TrackerService.preview` returns the issue it
would create (the item's title and markdown body as written), the target, the settings still empty
(`missing`, as keys) and the issue the item already has (`existing`). `publish` refuses an item that
has one and a tracker that is not set up, creates the issue, and dispatches `backlog.published`
with `{service, key, url}`; one publish per item runs at a time, so a double click creates one
issue. Nothing is read back from the tracker afterwards. The payload is deliberately minimal:

- **Jira**: `POST <baseUrl>/rest/api/2/issue` with `{fields: {project: {key}, issuetype: {name},
summary, description}}`. v2 because Cloud, Server and Data Center accept the same field names
  there and take the description as a plain string (v3 is Cloud only and wants an Atlassian
  Document). `cloud-basic` sends `Basic base64(email:token)`, `pat` sends `Bearer <token>`. The key
  comes from the answer and the URL is `<baseUrl>/browse/<key>`.
- **GitHub**: `POST <baseUrl>/repos/<owner>/<repo>/issues` with `{title, body, labels?}`,
  `Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`; Enterprise Server is the same under
  `https://<host>/api/v3`. The key is `owner/repo#<number>` and the URL the answer's `html_url`.

A refusal or a timeout (`trackers.requestTimeoutMs`) is a `rejected` RPC error carrying what the
tracker said (Jira's `errorMessages` and `errors`, GitHub's `message` and `errors`). Tokens are
secret settings: the settings page stores the value with `secrets.set` as `setting:<key>` and saves
the reference; clearing the field resets the setting and deletes the secret.

`apps/web/src/backlog`. `/backlog` lists the items (filter by text, state and tag) next to
`/backlog/$itemId` (title, markdown body, tags, state; the body is edited as text and shown as
written) or `/backlog/new`. "Plan on calendar" opens a dialog for workflow, project, date and time
(`calendar.cardMinutes` long, in `calendar.zone`) and dispatches `backlog.plan`. "Publish to Jira"
and "Publish to GitHub" ask `trackers.preview`: an item that already has an issue gets "Open
<key>", a tracker that is not set up names the settings and links to Settings → Trackers, otherwise
the preview shows the issue and "Create issue" calls `trackers.publish`. Palette commands: New
backlog item, every item, and for the open item Plan on calendar, Publish to Jira and Publish to
GitHub.

## Look

T3 Code is the reference: dark neutral surface, one left sidebar, main area, optional right panel,
dense lists, small type, muted borders, accent only on state. Fonts Inter and JetBrains Mono.
Tokens live in `apps/web/src/styles/tokens.css` and are the only place colors are defined. Code
copied from T3 Code keeps its MIT notice in `THIRD_PARTY_NOTICES.md`.

## Testing strategy

- Contracts and engine: Vitest unit tests, including engine state tables for gates and missed
  policies.
- Providers: Vitest with recorded protocol fixtures (JSON lines) replayed through a fake
  subprocess; a scheduled CI job runs a real `codex app-server` and `claude` smoke when secrets
  exist.
- Outlook: bridge script tested on `windows-latest` with Outlook absent (expects the "unavailable"
  path) and the mock everywhere.
- Web: Playwright against the server with `WOW_OUTLOOK=mock` and `WOW_PROVIDERS=mock` (a mock
  adapter that replays fixtures and asks for an approval and a question). The chat tests start
  `apps/web/e2e/server.ts`: the server with a scripted `MockProviderAdapter` registered as the
  claude and codex factories (the prompt picks the scenario), a seeded Claude instance and
  project (plus a Codex instance on this first server only, for the `$name` form), and fixture
  `SKILL.md` files in the server's own user home that skills discovery finds.
  Its PATH holds empty stand-in `claude` and `codex` files for `provider.detect`. The workflow
  tests use the same server: its fixture skills cover the Feature template's first steps, and an
  invented `intents/demo/intent.md` in the project folder is the artifact step 1 finds. The settings
  tests start a second copy in its own home and port (`WOW_E2E_HOME`, `WOW_E2E_PORT`), because
  they add and remove instances and change global settings. Both run with `WOW_OUTLOOK=mock` and
  the fixture-backed `MockOutlookSource`; the first answers on a small HTTP control port
  (`e2eOutlookControlPort`) so the calendar tests can make the mock fail, bring it back and read
  which items Outlook was asked to open. The trigger tests start a third copy themselves
  (`e2eTriggersHome`, `e2eTriggersPort`) because they restart it: `WOW_E2E_KEEP_HOME=1` keeps the
  home across a restart and `WOW_E2E_CLOCK_OFFSET_SECONDS` runs the server's clock ahead, so a
  trigger's time passes while the server is down without the test waiting. The server prints
  `wow e2e server ready` once it is seeded. The backlog tests publish to a mock Jira and GitHub on
  `e2eTrackerPort`, which the server's tracker settings point at (GitHub without its token, which
  the test enters on the settings page); the same port lists what the trackers received and starts
  a backlog item's card run the way the scheduler will (`POST /fire`). CI runs `pnpm e2e` on
  `ubuntu-latest` and `windows-latest` (the `e2e` job) and keeps the traces of a failed run.
  Tests wait for what the page shows, never for time: no sleeps, polls or retries.
