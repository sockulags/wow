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
docs/            architecture (this file), user guide, windows-smoke checklist.
intents/         agent-os intent, spec and plan.
.claude/workflows/build-wow.js   delivers the plan with at most three agents at a time.
```

Tooling: pnpm workspaces, TypeScript project references, Vitest, Playwright, oxlint + Prettier,
electron-vite for `apps/desktop`, electron-builder (NSIS) for the installer, GitHub Actions on
`ubuntu-latest` and `windows-latest`.

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
  (`{providerInstanceId}`). Error codes are `RpcErrorCode`.
- **Subscriptions.** One topic per projection (`subscriptionTopics` in contracts); thread-scoped
  topics (`turns`, `threadItems`, `approvals`, `questions`) need a `threadId`. After a commit that
  touched a topic, every subscriber of it gets the topic's full current rows. Subscriptions end
  with their connection.
- **Client runtime.** `packages/client-runtime` queues requests until the socket opens, fails
  in-flight requests when it drops, reconnects with capped exponential backoff and subscribes again
  after every reconnect. It reads the port and token from `server.json` (`ServerInfo`). Its
  subscribe message is still `subscribe {name, params}` / `unsubscribe {name}`, which does not
  match the server's `subscribe {topic, threadId?}` / `unsubscribe {subscriptionId}` yet; the unit
  that first connects the web app to the server aligns them.
- **Commands → events → projections.** A request becomes a command. The orchestrator (pure
  function, no I/O) turns the command plus current projection into events. One SQLite transaction
  appends the events, updates projections and records the command receipt (idempotent retries).
  Effects (start a provider turn, poll Outlook, fire a trigger) run after commit in the effect
  worker and feed results back as commands. Subscribers get projection changes after commit.
  A command carries a client-chosen `commandId`; `command_receipts` records it with a fingerprint
  of the command and the event sequence numbers, so a retry returns the first receipt
  (`duplicate: true`) without new events, and reusing an id for a different command is a
  `conflict`. A rejected command stores nothing, so its id can be retried. Commands only the
  server issues (`provider.events`, `providerInstance.recordTest`) are `InternalCommand`s: they go
  through the same engine but `dispatch` over RPC does not accept them.
- **Hooks.** `startServer({hooks})` takes provider adapter factories per kind (`ProviderAdapter`
  in contracts, created with the instance and a `ProviderAdapterContext` that resolves the
  instance env with its secrets and reads `providers.testTimeoutMs`; `main.ts` registers the
  Claude adapter), an Outlook service factory that receives `mock` or `bridge` (mock off Windows or
  with `WOW_OUTLOOK=mock`), and further background services. Services read settings and change
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
  math. Default zone is the system zone.
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
calendar_items   id, source ('outlook'|'local'), externalId?, title, start, end, zone, location?,
                 joinUrl?, body?, projectId?, backlogItemId?, workflowId?, runId?, state, updatedAt
mail_items       id, externalId, folder, from, subject, receivedAt, unread, snippet
outlook_status   singleton: lastSyncAt, lastError?, bridgeVersion
backlog_items    id, title, body, tags(json), state, runId?, remote(json: service,key,url)?, createdAt
workflows        id, name, templateKind?, steps(json: WorkflowStep[]), createdAt, updatedAt
workflow_runs    id, workflowId, projectId, calendarItemId?, backlogItemId?, state, currentStep,
                 steps(json: StepRun[]), startedAt, endedAt
triggers         id, calendarItemId, workflowId, runAt, zone, state ('scheduled'|'fired'|'missed'|
                 'cancelled'), runId?
skills           id, name, description, dir, source ('user-claude'|'user-codex'|'project-claude'|
                 'project-agents'|'custom'), manualOnly, invocations(json: {claude, codex})
settings         key, value(json), scope ('global'|'project:<id>'|'provider:<id>')
events           seq, at, kind, aggregate, payload(json)   -- the history
command_receipts commandId, commandType, fingerprint, seqs(json), at   -- idempotent retries
```

`WorkflowStep = {id, skillName, providerInstanceId, model?, effort?, permissionMode?, gateBefore,
gateAfter, extraPrompt?, expectedArtifacts: string[]}`. `StepRun = {stepId, state, threadId?,
startedAt?, endedAt?, artifactsFound: string[]}`.

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
  with every `turn/start`. Details in `packages/provider-codex/README.md`.
- **Provider service** (`apps/server/src/providers/service.ts`). Thread commands
  (`thread.create`, `thread.sendMessage`, `thread.interrupt`, `thread.configure`,
  `approval.answer`, `question.answer`) become events; after commit the service sends the
  matching `ProviderCommand` to the instance's adapter (one adapter per instance, created on first
  use). `thread.sendMessage` starts turn `<threadId>:turn:<n>` with the thread's model, effort,
  permission mode and stored provider session id as `resumeId`. Adapter events are queued and
  stored one batch per thread per tick as a `provider.events` command, which the orchestrator
  (`core/threads.ts`) turns into rows: text and reasoning deltas append to one
  `assistant_text`/`reasoning` item per provider item id (`{text}`), tool calls are `tool_call`
  items (`{name, input, output, status}`), `approval` and `question` items point at their
  `approvals`/`questions` rows, the task list is one `task_list` item per turn (`{tasks}`), and
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
- **Instances.** A provider instance is one binary + one config directory + env. Several instances
  of the same kind are allowed (work and personal accounts). A thread remembers its instance and
  can only resume on an instance with the same config directory.

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

## Skills discovery

`packages/skills` scans the directories in `skills.directories` (defaults: `~/.claude/skills`,
`~/.codex/skills`, `<project>/.claude/skills`, `<project>/.agents/skills`) for `*/SKILL.md`, parses
frontmatter (`name`, `description`, `disable-model-invocation`) and `agents/openai.yaml`
(`policy.allow_implicit_invocation`) and produces `invocations: {claude: "/name", codex: "$name"}`.
Plugin-installed Claude skills are found under the Claude plugin cache when `skills.includeClaudePlugins`
is on and get `/plugin:name`. A `chokidar` watcher refreshes the projection.

## Workflow engine

`packages/workflow-engine` is pure: given a workflow, a run and an event (step completed, gate
answered, trigger fired) it returns the next run state and the effects to perform (start thread
with prompt, notify, finish). The server performs them. The step prompt is:

```text
<skill invocation for the step's provider>  <extraPrompt>

<handover: workflow.handoverTemplate rendered with previous step's final assistant message,
 the backlog item body if any, and the expected artifact paths>
```

`workflow.handoverTemplate` is a setting. Artifact detection runs `fast-glob` with the step's
`expectedArtifacts` in the project `cwd` when the step completes and on run view open.

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
carry `.meta({ widget: 'keybinding' | 'keyValue' })` (see `Keybinding` and `KeyValueList`). Objects
render their fields; anything else falls back to a JSON editor. Until the settings RPC exists the
web app uses the in-memory `SettingsSource` from `packages/client-runtime`. Initial groups: providers (testTimeoutMs), calendar (zone, firstDayOfWeek, workHours, lookaheadDays),
outlook (pollSeconds, folders, requestTimeoutMs, mailRail), scheduler (tickSeconds, missedPolicy,
notifications), workflows (templates, handoverTemplate), skills (directories, includeClaudePlugins),
trackers (jira: baseUrl, authMode `cloud-basic`|`pat`, projectKey, issueType, email; github:
baseUrl, owner, repo, labels), appearance (theme, fonts, density), keybindings, desktop (autostart,
closeToTray, startMinimized), advanced (WOW_HOME, port, log level, secret store timeout).

## Secrets

`packages/secrets` stores `~/.wow/secrets.json`. On Windows values are protected with DPAPI
(`[System.Security.Cryptography.ProtectedData]::Protect`, current user scope) through a short
PowerShell call (`-EncodedCommand` script, value on stdin, so the secret never appears on a
command line); elsewhere the file is plain with mode `0600` and the UI shows a warning
(`secrets.status` reports the protection). Writes go to a `0600` temporary file that is renamed
over the store. Settings marked `secret` store a reference `{secretRef}`, never the value; the
orchestrator rejects anything else.

## Desktop

Electron main spawns `apps/server` with `ELECTRON_RUN_AS_NODE=1` and the bundled server entry,
waits for `~/.wow/server.json`, and loads the web app with the token. Tray icon with Open, New
thread, Pause scheduler, Quit; close-to-tray and autostart (`app.setLoginItemSettings`) are
settings. Notifications use Electron's `Notification`. Native modules are rebuilt for Electron
with `@electron/rebuild` in `postinstall`.

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
  adapter that replays fixtures and asks for an approval and a question).
