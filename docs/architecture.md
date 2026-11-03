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
  `secrets.set`, `secrets.delete`, `secrets.status`, `provider.test`, `provider.listModels` and
  `provider.update` (`{providerInstanceId}`), `provider.detect`, `projects.discover`, `skills.refresh`,
  `workflowRuns.detectArtifacts` (`{runId}`), `workflows.matchArtifacts` (`{projectId, globs}`),
  `outlook.open` (`{entryId}`), `outlook.refresh`, `projects.git` (every project folder's git
  status and remotes), `trackers.project` (`{projectId}`, one project's tracker settings with their
  sources and suggestions), `trackers.test` (`{service, projectId?}`, signs in with the tracker
  settings as they apply and answers `{ok, account, message, missing}`), and `trackers.preview`
  (`{backlogItemId, service, projectId?}`) and `trackers.publish` (`{backlogItemId, service,
projectId?, title?, labels?}`). Error codes are `RpcErrorCode`.
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
                 version?, statusMessage?, update(json)?   -- from the last "Test"
                 updateRun(json)?   -- the last "Update Codex": state, command, output, times
threads          id, projectId?, cwd, branch?, providerInstanceId, providerSessionId?, title, model,
                 effort, permissionMode, state ('idle'|'working'|'needs_you'|'done'|'failed'),
                 pinned, runId?, stepId?, createdAt, updatedAt
turns            id, threadId, index, state, startedAt, endedAt, usage(json)
thread_items     id, threadId, turnId, index, kind ('user'|'assistant_text'|'reasoning'|'tool_call'|
                 'approval'|'question'|'task_list'|'usage'|'error'), payload(json), streaming
approvals        id, threadId, itemId, kind, request(json), decision?, decidedAt?
questions        id, threadId, itemId, request(json), answer?, answeredAt?
calendar_items   id, source ('outlook'|'local'), externalId?, title, start, end, zone, allDay,
                 location?, joinUrl?, body?, organizer?, projectId?, backlogItemId?, workflowId?,
                 runId?, state, updatedAt   -- state: CardState for cards, 'scheduled'|'cancelled'
                 for Outlook; body: a card's notes or an Outlook item's snippet
mail_items       id, externalId, folder, from, subject, receivedAt, unread, snippet
outlook_status   singleton: lastSyncAt, lastError?, unavailableSince?, unreadCount, bridgeVersion,
                 profile(json: OutlookProfile)?
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
  keeps the methods the adapter uses (currently codex 0.166.0). It also writes a protocol
  fingerprint (`src/protocol/generated/fingerprint.ts`): for each method, the fields the adapter
  sends and reads (`FIELDS` in the script) with their types, read from
  `codex app-server generate-json-schema`. `initialize` reports the codex version only inside
  `userAgent`. When it is not the generated version, "Test" runs `generate-json-schema` of the
  installed codex into a temporary folder (no network or login; bounded by
  `providers.testTimeoutMs`) and compares it with the fingerprint (`src/compat/schema.ts`): a
  compatible version passes with a notice in `statusMessage` ("codex 0.164.0 differs from the
  tested 0.166.0; compatible"), an incompatible one fails listing each missing or changed method
  and field, and a codex without the generator fails saying so. Read fields may go missing when the
  adapter copes (marked in `FIELDS`) or the tested release already allowed null; sent fields only
  when the adapter copes; new fields, values, variants and methods never matter, and the adapter
  drops notifications it does not know. The answer is cached per binary path and version by the
  adapter factory, for the life of the server process. An incompatible or older version also
  answers `update` (`ProviderUpdate`): `npm` when the binary is an npm global install (detected
  from the path and `npm prefix -g`), else `manual` with the Homebrew or download instruction.
  Permission modes (`read-only`, `auto`, `untrusted`,
  `full-access`) are an approval policy plus a sandbox; model, effort and permission mode travel
  with every `turn/start`. Every request waits at most `providers.requestTimeoutMs` (read per
  request); a timeout fails the request and restarts the app-server. Details in
  `packages/provider-codex/README.md`.
- **Provider service** (`apps/server/src/providers/service.ts`). Thread commands (`thread.create`,
  `thread.sendMessage`, `thread.interrupt`, `thread.configure`, `thread.setPinned`,
  `thread.setDone`, `approval.answer`, `question.answer`) become events; after commit the service
  sends the matching `ProviderCommand` to the instance's adapter (one adapter per instance, created
  on first use). `thread.sendMessage` starts turn `<threadId>:turn:<n>` with the thread's model,
  effort, permission mode and stored provider session id as `resumeId`. Adapter events are queued
  and stored one batch per thread per tick as a `provider.events` command, which the orchestrator
  (`core/threads.ts`) turns into rows: text and reasoning deltas append to one
  `assistant_text`/`reasoning` item per provider item id (`{text}`), tool calls are `tool_call`
  items (`{name, input, output, status}`), `approval` and `question` items point at their
  `approvals`/`questions` rows (the payload of each item kind is a schema in `packages/contracts`,
  `*ItemPayload`), the task list is one `task_list` item per turn (`{tasks}`), and usage plus
  context usage merge into one `usage` item per turn and the turn's `usage`. Provider ids are only
  unique per session, so row ids are prefixed with the turn or thread id. Thread state: `working`
  while a turn runs, `needs_you` while an approval or question is open, `idle` after a completed or
  interrupted turn, `failed` after a failed one. An effect that cannot start or interrupt a turn
  fails the turn with the reason; a turn still `running` at startup failed with the previous server
  process and is marked so. Events after a turn ended are dropped.
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
  per kind is `providerSetup` in contracts. With no instance at all, and while
  `providers.offerSetup` is on, the web app opens a first-run wizard: it creates and tests one
  instance per detected CLI, then offers `projects.discover`'s folders as projects; "Not now"
  turns the setting off. The instance editor runs `provider.detect` when it opens to fill an empty
  binary path and config folder, lists `provider.listModels` for a saved instance, and tests after
  every save; instances still `unknown` are tested when the app starts. The default instance for
  new threads is the one the newest thread uses (`lastUsedInstanceId` in
  `apps/web/src/providers/model.ts`), so nothing extra is stored. Secret environment values go to
  `secrets.set` as `provider:<instanceId>:env:<NAME>` and the instance stores the reference.
  `providerInstance.update` clears the last test when the binary, config directory, environment or
  launch arguments change, and both it and `providerInstance.delete` are refused while a turn runs
  on the instance; delete is also refused while threads use it. After commit the provider service
  drops the instance's adapter (the next use builds one from the new row) and deletes secrets the
  instance no longer references. Delete also removes provider-scoped settings and clears project
  defaults that pointed at it.
- **Provider updates** (`apps/server/src/providers/update.ts`). The last test's `update` is stored
  on the instance. `provider.update` runs its npm update (`npm install -g <package>@<version>`,
  `npm.cmd` through the shell on Windows, `--prefix` when the test named one) as a server
  subprocess: it is refused without an npm offer, while one runs, or while a turn runs on an
  instance with the same kind and binary; it stops those instances' adapters first (Windows keeps a
  running binary locked), answers with the command, and records `providerInstance.recordUpdate`
  progress (started, output batched per tick, finished) into the instance's `updateRun`. A good
  install tests every instance on that binary again. `providers.updateTimeoutMs` stops npm; a run
  still `running` at startup failed with the previous server process. The UI only renders
  `update` and `updateRun` and sends the RPC after a confirm dialog that names the command.

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
     "joinUrl":"https://teams...","busyStatus":2,"body":"..."}]}}
→ {"id":3,"op":"unreadMail","folders":["Inbox"],"limit":50}
← {"id":3,"result":{"items":[{"entryId":"...","folder":"Inbox","from":"...","subject":"...",
     "receivedAt":"...","snippet":"..."}],"unreadCount":7}}
→ {"id":4,"op":"open","entryId":"..."}     (Outlook shows the item)
← {"id":4,"result":{"opened":true}}
→ {"id":5,"op":"profile"}
← {"id":5,"result":{"timeZoneId":"W. Europe Standard Time","workHoursXml":"<Root ...>",
     "firstDayOfWeek":1,"address":"you@example.com"}}
← {"id":6,"error":{"code":"unavailable","message":"Outlook is not running"}}
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
`teams.microsoft.com/l/meetup-join` URL. The body goes out cut at 2000 characters;
`bodySnippet` keeps the text before the Teams invitation block (the line of underscores), without
links, on one line of at most 240 characters, and the server stores that as the row's `body`. The
organizer goes out as Outlook names them.

### Outlook profile

`profile` (owner decision F-8) reads what Outlook knows about the user's calendar, still without
changing anything: `Application.TimeZones.CurrentTimeZone.ID` (a Windows zone id), the calendar
folder's `IPM.Configuration.WorkHours` message read with `GetStorage(..., olIdentifyByMessageClass)`
and its `PR_ROAMING_XMLSTREAM` property (WorkingHours.xsd XML; `GetStorage` hands back an unsaved
empty item when there is none, and nothing is saved), the first day of the week of the user's
Windows region (`Get-Culture`), which Outlook starts from, and the user's SMTP address
(`CurrentUser.AddressEntry`, via `GetExchangeUser()` on Exchange). Each part is read on its own
and is null when it cannot be read.

`profile.ts` turns the answer into the `OutlookProfile` in `packages/contracts`: the Windows id
becomes an IANA zone through the CLDR world mapping in `windows-zones.ts` (Windows PowerShell 5.1
runs on .NET Framework, which cannot convert ids), and when the system zone keeps the same clock
all year it is preferred as the more precise name ("W. Europe Standard Time" maps to Berlin; a
machine in Stockholm keeps Stockholm). The XML's time slot and work days become `WorkHours`; the
XML's own zone name is the fallback zone. An address without `@` (an X.500 path) is left out.

`OutlookSync` reads the profile at every good poll and keeps the last one for polls where reading
it fails; a profile that cannot be read never fails the poll. The snapshot carries it, the
`outlook.sync` command and `outlook.synced` event carry it on (the event field is optional, so
events stored before it replay), and the projector stores it in `outlook_status.profile`, keeping
the stored one when a poll brings none. `resolveCalendarPrefs` (contracts) resolves the settings'
`outlook` value against it the same way on both sides: Outlook's value, else the system zone,
08:00–17:00 Monday to Friday and the region's first day (`Intl.Locale` week info), and an explicit
setting always wins. The server uses it for the polled window, the web app for the grid. The mock
answers `profile` from `fixtures/profile.json`; a null `timeZoneId` there means the zone the
fixtures are written in, which the mock turns back into a Windows id (`windowsIdOf`).

`OutlookSource` is the interface (`ping`, `calendar`, `unreadMail`, `open`, `profile`, `close`).
`PowershellOutlookSource` starts the bridge on first use, numbers requests, and times each one out
after `outlook.requestTimeoutMs`; a timeout (Outlook blocked by a modal dialog) or an exit rejects
every pending request, kills the process, and the next request starts a fresh one.
`MockOutlookSource` answers from `packages/outlook-bridge/fixtures` (invented items placed relative
to today: a weekday standup with a Teams link, a weekly 1:1, an all-day offsite, a cancelled
meeting, unread mail in two folders) and is selected off Windows and with `WOW_OUTLOOK=mock`
(`prefersMock`, `createOutlookSource`).

`OutlookSync` polls every `outlook.pollSeconds` (re-read before each poll; one poll at a time). The
window runs from the start of the current week (`calendar.firstDayOfWeek` in `calendar.zone`, both
resolved against the profile read in the same poll) to
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
asks the source to show an item (a calendar row passes its external id, and `entryIdOf` opens a
recurring occurrence's series) and `outlook.refresh` polls at once (the palette's "Refresh
Outlook" and the banner's "Try again"). An Outlook row never changes through a card command, and a card id may not start with
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
the rows that arrive after its first snapshot as toasts for `scheduler.toastSeconds`, whose "Open"
action opens its `path`. The toasts are sonner's (`AppToaster` in `app/notifications.tsx`); the
same toaster carries the app's own feedback (see "Look").

## Settings registry

`packages/contracts/src/settings.ts` exports `settingsRegistry`: a map of key → `{schema: zod,
group, label, description, default, scope: 'global'|'project'|'provider', restartRequired?,
secret?, unit?, options?, radio?}`. `unit` (`ms`, `seconds`, `minutes`, `days`, `pixels`,
`percent`) is shown as a suffix after a number field, so labels carry no unit; milliseconds are
shown and typed as seconds. `options` names each enum value (`{label, description?}`), so the page
never shows a raw id; `radio` shows the choices as a radio group with their descriptions. The server validates writes against it; the settings UI renders groups and fields from
it (text, number, boolean, enum, list, key-value with secret flag, keybinding). Adding a setting is
one entry. A definition's `scope` is the narrowest place it may be stored: `global` settings only
globally, `project` settings also per project, `provider` settings also per project and per
provider instance. Reads resolve provider over project over global over the default, skipping a
stored value that no longer passes the schema. Writes are `setting.set` / `setting.reset`
commands, so they are events like everything else; the server reads SQLite on every `get`, so a
change applies at once, and services holding derived state listen with `onChange`. The page picks the editor from the zod schema type; schemas that need a special editor
carry `.meta({ widget: 'keybinding' | 'keyValue' | 'secret' | 'workHours' | 'template' })` (see
`Keybinding`, `KeyValueList`, `SecretSetting`, a password field for a secret setting's reference,
`WorkHours`, two time fields and a Mon–Sun toggle group, and the handover template, a text area
whose `placeholders` meta lists the `{{name}}` chips it can insert). Objects
render their fields; anything else falls back to a JSON editor. Connected to a server, the web app
reads the `settings` topic and writes global values with `setting.set` / `setting.reset`
(`apps/web/src/settings/server-source.ts`); without one it uses the in-memory `SettingsSource`
from `packages/client-runtime`.

The settings below are the registry. `apps/server/src/settings/coverage.test.ts` reads this list:
a key named here and missing from the registry, or registered and missing here, fails the tests.
A group marked with a unit (`(U12)`) belongs to a unit not delivered yet; its keys must not exist
until that unit removes the mark. `group.*` covers every key of the group.

- providers: `providers.testTimeoutMs`, `providers.requestTimeoutMs`, `providers.updateTimeoutMs`,
  `providers.offerSetup`
- chat: `chat.contextMeter`, `chat.resumePrompt`, `chat.starterCount`
- calendar: `calendar.zone`, `calendar.firstDayOfWeek`, `calendar.workHours` (these three default
  to `outlook`, see "Outlook profile"), `calendar.showWeekends`, `calendar.weekMaxColumns`,
  `calendar.lookaheadDays`, `calendar.snapMinutes`, `calendar.cardMinutes`,
  `calendar.hourHeight`, `calendar.zoomStep`
- outlook: `outlook.pollSeconds`, `outlook.folders`, `outlook.requestTimeoutMs`,
  `outlook.mailRail`, `outlook.mailRailCollapsed`, `outlook.mailLimit`
- scheduler: `scheduler.tickSeconds`, `scheduler.missedPolicy`, `scheduler.notifications`,
  `scheduler.paused`, `scheduler.toastSeconds`
- workflows: `workflows.templates`, `workflows.handoverTemplate`
- skills: `skills.directories`, `skills.includeClaudePlugins`
- trackers: `trackers.jira.baseUrl`, `trackers.jira.authMode` (`cloud-basic` or `pat`),
  `trackers.jira.email`, `trackers.jira.token` (secret), `trackers.jira.projectKey`,
  `trackers.jira.issueType`, `trackers.github.baseUrl`, `trackers.github.token` (secret),
  `trackers.github.owner`, `trackers.github.repo`, `trackers.github.labels`,
  `trackers.requestTimeoutMs`, `trackers.gitTimeoutMs`, `trackers.jira.keyScanCommits` (the
  `trackers.jira.*` and `trackers.github.*` ones are project-scoped, see "Backlog and trackers")
- appearance: `appearance.theme`, `appearance.uiFont`, `appearance.codeFont`, `appearance.density`,
  `appearance.paletteRecent`, `appearance.contextPanel`, `appearance.contextPanelWidth`
- keybindings: `keybindings.*`, one per command that has a shortcut
- desktop: `desktop.autostart`, `desktop.closeToTray`, `desktop.startMinimized`
- updates: `updates.enabled`, `updates.checkIntervalMinutes`
- advanced: `advanced.port`, `advanced.logLevel`, `advanced.secretsTimeoutMs`,
  `advanced.showSettingKeys` (`WOW_HOME` is an
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
orchestrator rejects anything else. The settings page names the entry `setting:<key>` for a global
value and `setting:project:<projectId>:<key>` for a project's own; the tracker service deletes the
latter when `project.deleted` commits, since the project's settings rows go with the project.

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

Tray icon whose menu starts with the day: "3 need you" (threads in `needs_you` plus runs
`waiting`, opens `/chat`) and "Next: <card> at 16:30" (the earliest `scheduled` trigger, from the
`triggers` and `calendarItems` topics, opens `/calendar`), then Open, New thread (`/chat?new=1`),
Pause/Resume scheduler and Quit (`traySummary` and `trayMenu` in `tray-menu.ts`); the tooltip
carries the count. Clicking the icon opens the window. Pause toggles the `scheduler.paused` setting, which the scheduler honours; the
web app's palette has the same Pause/Resume scheduler command.
`desktop.closeToTray`, `desktop.autostart` (`app.setLoginItemSettings` with `--hidden`, so a login
start stays in the tray) and `desktop.startMinimized` are settings the desktop follows through the
`settings` topic. Notifications use Electron's `Notification`, gated by `scheduler.notifications`,
and are derived from changes on the `workflowRuns` topic: a new run, a run entering `waiting`, a
run entering `failed`. A single-instance lock makes a second launch show the running window.

A packaged build replaces Electron's default application menu (`app-menu.ts`): none on Windows
and Linux, the app and Edit menus on macOS. The default menu's accelerators zoomed the page
(Ctrl+=, Ctrl+-, Ctrl+0, which the calendar binds), reloaded it (Ctrl+R) and opened DevTools;
development keeps it. Page zoom is locked with `setVisualZoomLevelLimits(1, 1)`. The preload's
`window.wowDesktop.restart` (IPC `wow:app-restart`, `wow://app` pages only) relaunches the app for
settings marked `restartRequired`; the web app shows it as "Restart now".

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

New codex releases reach users the same way. `.github/workflows/codex-protocol.yml` runs daily and
by hand: when npm's newest stable `@openai/codex` is newer than `codexProtocolVersion`
(`packages/provider-codex/scripts/codex-release.mjs`, tested with the package), it installs that
codex into a temporary prefix, runs `generate:protocol`, names the version in the docs, runs the
repository checks on Linux and opens or updates a pull request on `agent/codex-protocol-<version>`
with the generated-file and method-map changes and the check results (a draft when generation or
a check fails, with the error). It never pushes to `main` and never touches a branch someone else
has pushed to. Pull requests opened with the workflow's `GITHUB_TOKEN` start no other workflow, so
`ci.yml` runs only after the owner closes and reopens the pull request; a GitHub App or
fine-grained token in place of `GITHUB_TOKEN` would remove that step. The owner re-records the
fixtures against the new codex on that branch, merges, and releases as above.

## Projects

A project is a name and a folder (`projects` row). `apps/server/src/core/projects.ts` decides
`project.create`, `project.update` and `project.delete`. Names and folders are trimmed, and a name
another project has (ignoring case) is a `conflict`, because pickers show projects by name. The
`dispatch` handler checks that a create or an update that sets `cwd` names an absolute path to an
existing folder and refuses it with `rejected` otherwise; the check sits in the RPC layer because
the orchestrator does no I/O, so commands dispatched inside the server (the e2e seed) skip it.

`project.delete` is refused with `conflict` while a run in the project is running or waiting,
because the runner would start the next step without the project's folder. Otherwise it removes the
project and its `project:<id>` settings and unlinks what pointed at it rather than deleting it:

- local cards get a `card.update` with `projectId: null` through the calendar's own decision, so a
  scheduled or missed trigger becomes `cancelled` (a card without a project has no trigger);
- threads keep their `cwd` and lose `projectId` in the projection of `project.deleted`, so they
  read and resume as folder threads;
- finished workflow runs keep `projectId` as history; the run view shows no project name and finds
  no artifacts for them.

**Git** (`apps/server/src/projects/git.ts`, owner decision F-4, audit E-12). The server reads a
project folder with `git -C <folder>`: `rev-parse --git-dir` (fails: `noRepository`), `remote -v`
and `symbolic-ref --short HEAD`, with `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`, so nothing
waits for credentials or takes a lock, and `trackers.gitTimeoutMs` as the limit. Without git on the
PATH it reads `<folder>/.git/config` and `HEAD` itself (`gitUnavailable` when that fails too). A
folder that is gone is `folderMissing`. `parseRemoteUrl` reads https, ssh://, git:// and scp-like
`user@host:path` remotes and local paths, drops user names and passwords from https URLs, and
names a GitHub repository for `owner/repo` paths: github.com (also `ssh.github.com`) gives
`https://api.github.com`, any other host is taken as GitHub Enterprise Server with
`https://<host>/api/v3`; deeper paths (GitLab subgroups), local paths and known other hosts
(GitLab, Bitbucket, Azure DevOps, Codeberg) give none. The primary remote is `origin`, else the
first GitHub one, else the first. `projects.git` answers `ProjectGit` for every project
(`{projectId, status, remotes, primary, branch, message}`); it is read on demand, not projected,
because it is live I/O on the user's files. `guessJiraKeys` counts distinct `KEY-123` references
in the branch names and the last `trackers.jira.keyScanCommits` commit messages (`git log
--format=%s%n%b`), skipping look-alikes such as `UTF-8` and `SHA-256`.

**Discovery** ("Import from Claude and Codex", `projects.discover`). Each adapter package reads
its own CLI's session files and answers `ProviderFolder[]` (`{cwd, lastUsedAt}`, in contracts):
`discoverClaudeFolders(configDir)` in `packages/provider-claude` reads
`<configDir>/projects/<encoded cwd>/*.jsonl`, taking the `cwd` of the newest session that has one
and decoding the folder name only when none does (the encoding replaces every character that is
not a letter or digit with `-`, so the name alone is ambiguous); `discoverCodexFolders(codexHome)`
in `packages/provider-codex` reads the `session_meta` line of every
`<codexHome>/sessions/**/rollout-*.jsonl` (older versions put `cwd` at the top level). Files are
read line by line and closed at the first `cwd`. `apps/server/src/projects/discover.ts` only
aggregates: every provider instance is asked with its config directory (or the one detection
reports for an empty one), folders are merged by resolved path (ignoring case on Windows and
macOS), relative paths, folders that no longer exist and folders that already are a project are
left out, and the rest come back newest first with the instances that used them. Discovery never
writes. The web app imports the checked rows as ordinary `project.create` commands, numbering a
name that is taken, so the folder check and name rule above apply.

**Folder picker.** The desktop preload exposes `window.wowDesktop.pickFolder`, which invokes
`wow:pick-folder`; the main process answers only `wow://app` pages and shows Electron's
`dialog.showOpenDialog` with `openDirectory`. The web bootstrap turns it into `Runtime.pickFolder`;
with it the folder field is read-only and filled from the dialog, without it (the browser build)
the folder is typed.

`apps/web/src/projects`. Settings → Projects (`/settings/projects`, a page of its own next to the
registry groups and listed after Providers) lists the projects with their folders and adds,
renames, removes and imports them in dialogs opened through the layout store's `projectDialog`,
so palette commands open the same dialogs: Settings: Projects, New project, Import projects from
Claude and Codex, and Rename project and Remove project for each one. A refused command keeps its dialog open with the server's message.
Each row shows the folder's primary remote and branch from `projects.git` (asked again when a
project's id or folder changes), or "No git repository", "No git remote", "Git not found" or a
"Folder missing" warning. **Trackers** expands `projects/project-trackers.tsx` in the row (the
palette's "Trackers for project …" opens it through `#trackers-<id>`), described under
"Backlog and trackers".

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
Stop turn while a turn runs, and Mark thread done or Reopen thread for the open thread (also in
the thread header). `thread.setDone {threadId, done}` stores `thread.stateChanged` with `done`, or
on reopen `failed` when the thread's last turn failed and `idle` otherwise; marking done is refused
while the thread is `working` or `needs_you`, and `turn.started` makes a done thread `working`
again, so a new message reopens it. A workflow step's thread becomes `done` through the engine's
`setThreadState` effect when the step completes (after Continue when the step has a gate after).

The draft's defaults come from server rows, not browser storage (owner decision F-5): the newest
thread that no run started gives the instance, and on that instance its model, effort and
permission mode, and its project or folder; then the instance defaults. Folders used without a
project (`recentFolders` over `threads`) and "Another folder…" (`Runtime.pickFolder`, a typed path
in the browser build) replace a separate working-directory field. Starters under the composer come
from `skills`, open `backlogItems` and the last active thread (`chat.starterCount`). The composer
focuses on `/chat/new` and on opening a thread; its `$` picker is a cmdk `Command` with
`shouldFilter={false}` whose selection the text box moves (focus stays in the text box), grouped by
`skillGroup` (Project, User, Plugins). A message written while a turn runs is held in the composer
and sent when `turns` says the turn ended; while a question waits, the composer sends
`question.answer`. The working clock reads the running turn's `startedAt` and redraws each second;
it is display only, the state still comes from `turns`. A pending approval takes the focus, and
the palette's approval commands (`keybindings.approvalAllowOnce|approvalAllowSession|approvalDeny`,
plain keys, so they do nothing in text fields) answer it. A thread whose step a waiting run asks
to review (`gateRunForThread`: the gate after this step, or before the next) shows the run view's
`GateBar` above the composer, and the palette's Continue run and Stop run apply to that run.

The palette (`app/palette.tsx`, `app/palette-model.ts`) lists, before anything is typed, the
commands marked `needsYou`, the newest by `recentAt` (`appearance.paletteRecent`) and the open
view's actions; typing searches every command with `paletteScore`, which ranks title matches above
group, detail and keyword matches and needs every typed word. A title's group prefix ("Calendar:
today") is dropped where the group heading says it, and `detail` says what a row is. cmdk claims Ctrl+J/K/N/P for list movement and stops the event, so the palette
runs the app's shortcuts with a modifier itself; otherwise Ctrl+K pressed while the palette fades
out after Escape was lost.

## Workflow builder and run view

`apps/web/src/workflows`. `/workflows` lists the workflows and their runs (live runs first) next
to `/workflows/new` (`?template=<kind>` starts from that entry of `workflows.templates`),
`/workflows/$workflowId` (the builder for a saved workflow, Run now in a chosen project next to
Save, and its runs) or `/workflows/runs/$runId`. The builder edits a local draft: name, template
kind, and ordered steps reordered by dragging a step's handle or with its move buttons. Steps are
one line each and open to edit. Gates are drawn at the positions between steps (`waitsAt`,
`setGate`: on stores a gate after the step before, or a gate before the first step; off clears
both), so the engine's `gateBefore` and `gateAfter` stay as they are. A step picks a skill
from the `skills` topic (stored as its name, or `plugin:name` for a Claude plugin's skill), a
provider instance, and model, effort and permission mode with the chat's pickers; empty ones are
filled with the instance defaults, else the first listed model. Expected artifact globs are typed
one per line. Validation needs a name, a step, and per step a skill, an instance, a model, an
effort and a permission mode; a skill missing from the scan is only a warning, because the server
invokes unknown skills by name. "Start from" (Blank or a template) is offered for a new workflow;
an existing one shows "Based on <template>" and replaces its steps only through "Replace steps
with template…", which still needs Save. "Save as template…" writes the draft's skills, gates and artifact globs into
`workflows.templates` (`saveAsTemplate`: replaced by name, else a new kind from the name); the
settings page's editor stays for everything else. Refresh skills calls `skills.refresh`. Run now is offered
only for the saved steps. With a project to run in, each step's expected globs are checked with
`workflows.matchArtifacts {projectId, globs}` (read only, the same `fast-glob` match the run uses)
for a "Matches N files" line. Delete dispatches `workflow.delete` at once and offers Undo, which
sends `workflow.restore {workflow}` with the row the client held (refused if the id exists again). The run view asks
`workflowRuns.detectArtifacts` when it opens and renders the run row: each step's state, its
thread link, how long it took, the expected globs and the found files as `file://` links into the
project folder with a copy-path button. A step that ended and waits at its gate reads Done with a
"Waiting for you" marker after it. The header links to the run's card and backlog item. The gate
bar (`gate-bar.tsx`, also in the step's thread) reads the gate the way `pendingGate` does (the
current step has ended: after it; not started: before it), shows the reviewed step's
`finalMessage` and found artifacts, and offers Continue (`keybindings.continueRun`) and Stop; Stop
alone while a step runs. Stop asks first, since a stopped run cannot go on. Palette commands: New workflow, New workflow from each template, Refresh skills, every
workflow and run, and Continue run and Stop run for the open run.

## Calendar view

`apps/web/src/calendar`. `/calendar?view=day|week&date=YYYY-MM-DD` shows a time grid for one day or
one week; the URL holds the view, so a reload shows the same range. The zone, the first day of the
week and the work hours come from `useCalendarPrefs` (`prefs.ts`), which resolves the settings'
`outlook` default against `outlook_status.profile` with `resolveCalendarPrefs` (see "Outlook
profile"); nothing in the calendar reads the raw settings. Week view has seven days, or five with
`calendar.showWeekends` off. Days are counted in local dates and an instant's place in a day is
its wall-clock time in the zone, so a week that crosses a DST change still has seven columns and a
09:15 meeting sits at 09:15 on both sides of it (`time.ts`, `layout.ts`). All-day items sit in a
row above the grid; today's date number is in a filled circle and weekend headers are muted.

Layout. Timed Outlook items and local cards that overlap are laid out side by side by
`layoutColumns` (`overlap.ts`, a pure function): items that overlap directly or through a chain
form a cluster, each takes the first column free at its start, every item of a cluster is
1/columns wide and stretches right over neighbouring columns that stay free for its whole length.
Items shorter than the drawn minimum block height (18 px) take that much time in the layout, so
zero-length and very short items get a column of their own; that minimum depends on the zoom. In
week view `capColumns` caps a cluster at `calendar.weekMaxColumns` columns: the first columns keep
their items and the rest of the cluster goes behind one "+N" button whose popover lists them (a
card opens its dialog, a meeting shows its details in place). Day view shows every column. Blocks
leave a strip on the right of each day free for clicking a new card. `blockLines` (`time-grid.tsx`)
spends a block's height: the title wraps on whole words into the lines left after the time and any
button row, keeps its row sticky while a tall block scrolls past, and a block too short for a
button row gets Join as an icon on the title line. Every block has a tooltip with its full title,
time and place on hover and on focus, and widens over the day while focused by keyboard. Event
colors are the `--event-*` tokens in `styles/tokens.css` (`bg-event-outlook`,
`border-event-card-border` and so on), set for both themes: Outlook items a blue tint, cards the
card surface, both with borders of at least 3:1, on a work-hours band lighter than both.

Cards. `cardKind` (`items.ts`) tells a trigger (a workflow and a project) from a card with a
workflow but no project (dashed, a warning icon and "No project, will not run") and a plain card.
Only triggers carry a workflow icon, a state color on the left border and the state in sentence
case (Scheduled, Running, Needs you, Done, Failed, Stopped, Missed); the calendar only creates them
`scheduled`, the scheduler and the card's run change it. Local cards are created by clicking (a
`calendar.cardMinutes` card) or dragging a range, then named in the card dialog; dragging a card
moves it (also to another day), dragging its lower edge resizes it, both snapped to
`calendar.snapMinutes`. While a drag is in progress the card is drawn where the pointer is; when
the pointer is released the card is drawn at its new place until the server's row arrives, and the
server row wins. A missed card whose trigger offers it has a "Run now" button and a "Run now:
<card>" palette command. While `scheduler.paused` is on the toolbar shows "Scheduler paused",
which resumes it.

The card dialog (`card-dialog.tsx`, rules in `card-form.ts`) uses the shared `FormField`. An end at
or before the start is an error ("Ends before it starts") that disables Create with the reason in
its tooltip; 00:00 means midnight at the end of the day, and the length shows under End. Workflow
and project sit together under "Run a workflow" with a line that says what will happen
(`triggerSummary`: "Starts at 16:30 in Demo · 4 steps, 2 gates", "Will not run: pick a project",
or the live run with "Open run"), Run now for a missed or failed card, and a Notes field (the
card's `body`). A new card starts with the project of the card changed last (`lastUsedProjectId`)
and the zone is named only when it is not the system's. "Delete card" deletes at once and offers
Undo (`offerUndo`, owner decision F-9), which creates the card again with the same id and fields;
a card whose run is live first asks "Stop run and delete" or "Keep run and delete". The dialog
gives focus back to whatever had it when it opened.

Outlook items are read-only: a lock marker, "Teams meeting" instead of a raw Teams link
(`meetingPlace`), Join, struck through when cancelled. A click or Enter opens their details popover
(`outlook-details.tsx`): time, place, organizer, the body snippet, Join, "Open in Outlook"
(`outlook.open` with the row's external id) and "Card before" / "Card after", which open the card
dialog for `calendar.cardMinutes` right before or after the meeting.

Keyboard (`grid-keys.ts`, pure). The grid is one Tab stop with roving focus over its "stops"
(blocks and "+N" buttons, keyed by day and id so an item spanning two days has one per column).
Up/Down move within a day, Left/Right to the nearest stop in time on the closest day that has one,
Home/End to the day's first and last, Ctrl+Home/End to the range's; Enter or Space opens. Alt+Up
/ Alt+Down move a card by the snap step and Alt+Left / Alt+Right by a day at the same wall-clock
time; Alt+Shift+Up / Down move its end, never below one snap step. A moved card keeps the focus,
also when it lands in another column. These are the standard grid keys, so they are not
keybindings settings. A "Skip to calendar" link at the start of the calendar focuses the grid.

The hour height is `calendar.hourHeight` and is the zoom. Ctrl+wheel and pinch on the grid (a
non-passive `wheel` listener that calls `preventDefault`, so neither the browser nor Electron
zooms the page), the `keybindings.calendarZoomIn` / `calendarZoomOut` / `calendarZoomReset` keys,
the matching palette commands (calendar only) and the toolbar's − / level menu / + controls all go
through `calendarZoom` (`zoom.ts`). A whole step multiplies the shown percent by
`calendar.zoomStep` and lands on tens of percent (120 %, 140 %…); pinch steps stay fractional. The
level menu offers 50, 75, 100, 150, 200 and 300 % and Reset. The grid reports the height at which
24 hours fill it (`setFloor`); zooming out stops there and a stored height below it is drawn at
it, so the lowest zoom never leaves space under 24:00. Heights are clamped to the setting's schema
bounds (24 to 144 px, 50 to 300 %), shown at once as a pending value and written with
`setting.set`, one write in flight and the last request winning, until the stored setting reaches
it. The grid keeps the minute under the pointer (wheel) or at the middle of the view at the same
place on screen. Zoom keys are `repeatable` commands. A range opens at the start of work hours, or
centred on now when today is in view and now is outside that window. The now-line follows the clock
minute by minute under the blocks (it never covers their text), with its dot in the time gutter
and a faint line across the other days of the week.

Toolbar. One 40 px row of `size=sm` controls that never wraps: Today, previous and next as icon
buttons with their keys in tooltips, the range ("2–8 Nov 2026", `formatDateRange`) with the ISO
week number, the zone ("Tokyo, UTC+9", `formatZone`) only when it differs from the system zone,
the zoom controls, Day/Week as a toggle group, Refresh Outlook and New card. Container queries drop
the year, the week number, the zoom controls and the New card label as the calendar narrows. While
`outlook_status.lastError` is set the shared `Banner` says "Outlook unavailable since <time>"
(`formatWhen`) with the error, **What to check** and **Try again** (`outlook.refresh`). An error
from Run now is a toast.

Mail rail (`mail-rail.tsx`). `mailItems` newest first with the `unreadCount` from `outlook_status`:
sender, `formatWhen` time, subject and one line of snippet, one Tab stop with the arrow keys
between messages. A click calls `outlook.open` and confirms with a toast. While Outlook is
unavailable the header says "Last read <time>" and the list is dimmed. The rail folds to a 40 px
strip with the count: its button, the `keybindings.toggleMailRail` key and the palette ("Collapse
mail rail" / "Show mail rail") write `outlook.mailRailCollapsed` (owner decision F-3); below a
1200 px window (`useBelow('narrow')`, see "Context panel"), and while the context panel is open,
it folds on its own, and opening it then lasts until it is folded again. Before the first snapshot
it shows the shared loading state, then the compact empty state.

Settings. `calendar.zone` uses the `timeZone` widget, a searchable `Combobox` of
`Intl.supportedValuesOf('timeZone')` labelled with their offsets, with "From Outlook (<zone>)" and
"System (<zone>)" first. `calendar.workHours` and `calendar.firstDayOfWeek` use the `fromOutlook`
widget (`settings-fields.tsx`): Outlook's value ("From Outlook: 08:30–17:00, Mon–Fri"), or the
fallback while Outlook has not been read, with an Override switch that reveals the editor (start
and end time fields and a Mon–Sun toggle group, or a weekday select) and switches back to
`outlook`.

Selection. `/calendar?item=<id>` names the card or meeting the context panel shows; the URL is
replaced, not pushed, when it changes. `TimeGrid` takes `selectedId`, `panelShown` and `onSelect`:
while the panel is shown a click or Enter selects instead of opening the card dialog or the
meeting popover, the arrow keys move the selection with the focus, Enter on the selected card
opens its dialog, and the selected block carries a ring and `aria-current`. With the panel closed
a click still records the selection and opens the dialog or popover as before.

Palette commands: today, next, previous, day view, week view, zoom in, zoom out, reset zoom and
collapse or show the mail rail (on the calendar only, with their keys), hide or show weekends,
New card, Refresh Outlook, and one "Edit card" entry per card.

## Context panel

`apps/web/src/panel` (owner decisions F-1, F-2). The right-hand panel shows the selected thing's
details and, for a card or run, its live step thread next to the main view. What is selected comes
from the route only (`panelSelection(pathname, search)` in `model.ts`): `/calendar?item=`,
`/chat/$threadId`, `/workflows/runs/$runId`, `/workflows/$workflowId` and `/backlog/$itemId`;
nothing is derived from the clock or kept in the browser. Every row it shows comes from the same
topics the views read.

- Calendar (`calendar-panel.tsx`): a card's time, state, project, workflow, trigger (`triggers`),
  run and backlog item, with Edit card (the card dialog) and Run now when the trigger offers it.
  The card's run is `cardRun` (the card row's `runId`, else its trigger's). A meeting reuses
  `OutlookDetails`; the bridge reads no attendees, so none are shown.
- Step thread (`step-thread.tsx`): `activeStep(run)` is the step to review at a gate (the one that
  just ended, or the one before a step that has not started), else the current step, else the last
  step with a thread. It renders `ThreadConversation` (`chat/thread-view.tsx`, the chat view's
  conversation, `GateBar` and composer, `compact` and without taking the focus), so Continue, Stop,
  approvals, questions and messages work exactly as in the thread. A step without a thread yet
  shows the gate bar alone when the run waits before it.
- Workflows (`workflow-panel.tsx`): a run shows its step thread; a workflow its steps, gates and
  runs (`sortRuns`).
- Backlog (`backlog-panel.tsx`): state, tags, the published issue (`remote`, a plain link; the
  publish flow stays in the item view), the cards that plan it (links to `/calendar?item=`) and
  its runs.
- Chat (`thread-panel.tsx`): provider instance, model (the instance's label from
  `provider.listModels`), effort, permission mode, project, folder (`PathText`), branch, usage
  summed over `turns` (`threadUsage`) with the last context report, and the run, card and backlog
  item it belongs to.
- No selection: a compact `EmptyState` that says what the view would show.

State (`panel-state.ts`). `appearance.contextPanel` stores whether it is open and
`appearance.contextPanelWidth` its width (pixels, bounds `contextPanelWidthBounds` in
`@wow/contracts`). The left edge is a `separator`: dragging previews the width and writes the
setting once on release; the arrow keys (Shift for four steps), Home and End write it at once.
`lib/use-breakpoint.ts` holds the layout breakpoints (`breakpoints.narrow`, 1200 px) with
`useBelow` and `isBelow`; below `narrow` the panel never takes room: opening it sets the layout
store's `contextPanelPeek`, which lays it over the view (`data-overlay`, Escape closes it) and
leaves the setting alone. Commands: "Toggle context panel" (`keybindings.toggleRightPanel`), "Focus
context panel" (`keybindings.focusContextPanel`, F6), which moves the focus into the panel
(opening it first) and back to the element it came from or the main view, and per view "Show in
panel" while the view has a selection. A focus request made from the palette waits in the layout
store (`contextPanelFocus`) and is taken in the palette's `onCloseAutoFocus`, because the dialog
would otherwise put the focus back where it was.

## Backlog and trackers

`apps/server/src/core/backlog.ts` decides `backlog.create|update|delete|restore|plan` and the
internal `backlog.published`. `backlog.restore {item}` is Undo for a delete: it stores the row the
client held as `backlog.created`, refused when the id exists; links the delete removed from cards
stay removed. Tags are stored trimmed and unique. `backlog.plan` ("Plan on calendar") is one
command for the card and the item: it builds the `card.create` the calendar would accept (title from
the item, the chosen workflow, project and time, linked to the item) and moves the item to
`planned`, so a refused card leaves the item as it was. Delete and plan are refused while a run of
the item is live; delete unlinks the item's cards. Every `workflowRun.changed` of a run with a
backlog item also emits `backlog.updated` when the item's state or `runId` differs from what the run
means: running or waiting is `running`, done is `done`, failed or stopped is `planned`. The item
keeps the `runId`, so the backlog shows the failed step's error from the run (behavior 29).

**Per-project settings** (owner decision F-4). Every `trackers.jira.*` and `trackers.github.*`
setting has `scope: 'project'`, so it can be stored globally (the defaults, Settings → Trackers) and
per project (`project:<id>`); `trackers.requestTimeoutMs`, `trackers.gitTimeoutMs` and
`trackers.jira.keyScanCommits` stay global. `trackers/resolve.ts` decides a project's values
without I/O, in this order: stored for the project, then the project's git remote (GitHub owner,
repository and API URL of the primary remote), then the global default, then the Outlook profile's
`address` (Jira email, only for Jira Cloud and only while nothing is stored), then the registry
default. Each value carries its source (`TrackerValueSource`: `project`, `gitRemote`, `global`,
`outlook`, `default`), which the UI shows as the field's marker. The remote wins over the global
default because the default usually names one repository and the remote names this project's.
Tokens follow the same order without the git and Outlook steps: decision, one token per tracker
account, stored globally and shared by every project, with an optional project override (its own
secret entry, see "Secrets"). Most people sign in to one Jira site and one GitHub host with one
account; a project on another site or host stores its own token. Guesses that are only likely are
suggestions (`TrackerSuggestion`) the user confirms: the Jira site another project stores (most
used first) while this one has none, and the Jira key `guessJiraKeys` finds most often when it
differs from the current value and the project has not set one. `trackers.project {projectId}`
answers `ProjectTrackers` (`{projectId, git, settings, suggestions}`).

**Publish target.** `publishTarget` picks whose settings a preview or publish uses: the
`projectId` the dialog sends (`null` means none: the defaults), else the project of the item's
newest card with one, else of its newest run; a project that no longer exists is skipped. Without
any, `needsProject` is true while projects exist and the defaults apply meanwhile. The preview says
`project` (`{id, name, source: 'chosen'|'card'|'run'}`), `targetSource` and `targetHost`
(github.com, the Enterprise host or the Jira site), and `publish` resolves the same way, so what
the preview names is where the issue goes. A not-set-up refusal names Settings → Projects → <name>
when a project applies.

`apps/server/src/trackers` publishes (behavior 30). `TrackerService.preview` returns the issue it
would create (the item's title and markdown body as written; the client renders the markdown), the
target, the settings still empty
(`missing`, as keys) and the issue the item already has (`existing`). `publish` refuses an item that
has one and a tracker that is not set up, creates the issue (with the title edited in the preview
and the item tags picked as labels, `trackers.publish {title?, labels?}`), and dispatches
`backlog.published`
with `{service, key, url}`; one publish per item runs at a time, so a double click creates one
issue. Nothing is read back from the tracker afterwards. The payload is deliberately minimal:

- **Jira**: `POST <baseUrl>/rest/api/2/issue` with `{fields: {project: {key}, issuetype: {name},
summary, description, labels?}}`. v2 because Cloud, Server and Data Center accept the same field
  names there and take the description as a wiki-markup string (v3 is Cloud only and wants an
  Atlassian Document). The markdown body is converted by `jira-markup.ts` (headings `h2.`, `*bold*`,
  `_italic_`, `{{code}}`, `{code}` blocks, `*`/`#` lists by depth, `bq.`, `[text|url]`, tables);
  labels lose their spaces (`needs review` → `needs-review`). `cloud-basic` sends `Basic base64(email:token)`, `pat` sends `Bearer <token>`. The key
  comes from the answer and the URL is `<baseUrl>/browse/<key>`.
- **GitHub**: `POST <baseUrl>/repos/<owner>/<repo>/issues` with `{title, body, labels?}` (the
  markdown as written; labels are `trackers.github.labels` plus the picked tags),
  `Bearer <token>`, `X-GitHub-Api-Version: 2022-11-28`; Enterprise Server is the same under
  `https://<host>/api/v3`. The key is `owner/repo#<number>` and the URL the answer's `html_url`.

A refusal or a timeout (`trackers.requestTimeoutMs`) is a `rejected` RPC error carrying what the
tracker said (Jira's `errorMessages` and `errors`, GitHub's `message` and `errors`). Tokens are
secret settings: the settings page stores the value with `secrets.set` as `setting:<key>` and saves
the reference; clearing the field resets the setting and deletes the secret.

`apps/web/src/backlog`. `/backlog` lists the items (filter by text, state and tag; "Open", the
default, hides done and dropped) next to `/backlog/$itemId` (title edited in the heading, markdown
body with Write and Preview through `markdown.tsx`, which builds React elements and links only
http(s) and mailto, tags as chips, state; Ctrl+S saves) or `/backlog/new`. The user sets only Idea
and Dropped (owner decision F-12); Planned, Running and Done show read-only. Delete dispatches at
once and offers Undo with `backlog.restore`. "Plan on calendar" opens a dialog for workflow,
project, date, start and end in `calendar.zone`: it suggests `nextFreeSlot` (the first
`calendar.cardMinutes` gap on a `calendar.snapMinutes` boundary inside `calendar.workHours`,
around non-cancelled, timed `calendarItems`, up to `calendar.lookaheadDays` ahead), warns about
overlaps, preselects the workflow of the newest card made from a backlog item, and dispatches
`backlog.plan`. "Publish to Jira" and "Publish to GitHub" ask `trackers.preview`: an item that
already has an issue gets "Open <key>"; a Project select (whenever projects exist) shows whose
trackers apply, marked "From the item's card" or "From the item's run", and when `needsProject`
it asks for one before anything else ("No project" sends `projectId: null`); a tracker that is
not set up asks for the missing settings in the dialog (secret ones through `secrets.set`, like
the settings page), storing sign-in settings (site, auth mode, email, tokens, GitHub API URL)
globally and the rest for the chosen project, and asks again; otherwise the preview says
"Publishes to <target> on <host> for <project>", shows the target with its source marker, an
editable title, the tags to add as labels and the rendered body, and "Publish issue" calls
`trackers.publish` with the same `projectId`.

Settings → Projects → Trackers (`projects/project-trackers.tsx`) renders `trackers.project` and
asks again on every `settings` push. GitHub owner, repository and API URL and Jira site, project
key and issue type are `FormField`s with the source as marker; a typed value is validated with the
registry schema and stored with `setting.set` at `project:<id>` on blur or Enter, emptying a
project value resets it, and "Use git remote" / "Use default" resets it. A suggestion shows below
its field with "Use <value>". Sign-in is one line ("Signs in with the shared GitHub token") with
"Use a different token", which opens a `SecretField` for the project's own token. Each tracker
has the same Test connection as Settings → Trackers, with the `projectId`. Palette commands: New
backlog item, every item, and for the open item Plan on calendar, Publish to Jira and Publish to
GitHub.

## Look

T3 Code is the reference: dark neutral surface, one left sidebar, main area, optional context panel,
dense lists, small type, muted borders, accent only on state. Fonts Inter and JetBrains Mono.
Tokens live in `apps/web/src/styles/tokens.css` and are the only place colors are defined. Code
copied from T3 Code keeps its MIT notice in `THIRD_PARTY_NOTICES.md`. Each theme sets
`color-scheme`, so what stays native (scrollbars, autofill) follows it. Views never use native
pickers, whose popups ignore the theme: they compose `ChoiceSelect` (shadcn Select), `Combobox` and
`SuggestInput` (Popover and Command) and `DateField` and `TimeField` (Popover with Calendar or a time
list, stepped by `calendar.snapMinutes`) from `apps/web/src/components`. A Vitest guard
(`src/test/native-controls.test.ts`) fails on `<select>`, `<option>`, `<datalist>`, `list=` and
date or time inputs outside `components/ui`.

Shared pieces in `apps/web/src/components` (views compose them; none restyles `components/ui`):

- `ui/*`: shadcn primitives, plus `tooltip`, `kbd`, `textarea`, `toggle-group`, `radio-group`,
  `alert-dialog`, `skeleton`, `separator` and `sonner`. Animations come from `tw-animate-css`;
  `prefers-reduced-motion` turns them off. Inputs, textareas and select triggers set their own
  `text-foreground`, so a value never takes a label's muted color. Dialog children are `min-w-0`,
  so a long path cannot widen a dialog.
- `hint.tsx`: `IconButton` (label as `aria-label` and tooltip, with the key from a
  `keybindings.*` setting), `WithTooltip`, `KeyHint` and `ShortcutHint`.
- `form-field.tsx`: `FormField`, the one field layout (label, control, help, error) that wires
  `id`, `aria-describedby` and `aria-invalid` onto its single child.
- `states.tsx`: `EmptyState` (icon, title, one sentence, actions; `compact` for side lists),
  `LoadingState` (skeletons that fade in after 150 ms), `DisconnectedState`, `TopicPlaceholder`
  and `Stale`. `app/topic-state.ts` adds `useTopicState(topic)`, which reports `loading`, `ready`,
  `disconnected` or `offline` next to the rows, so a view never shows an empty state before the
  first snapshot and keeps the last rows, dimmed, while the connection is down.
  `app/connection-banner.tsx` shows the not-connected bar with "Retry now"
  (`Connection.retry()`).
- `banner.tsx` (`Banner`, info, warning or error, for lasting conditions only),
  `confirm-dialog.tsx` (`ConfirmDialog`, only for actions that cannot be undone),
  `path-text.tsx` (`PathText`, one line, ellipsis in the middle, full path in a tooltip) and
  `code-block.tsx` (`CodeBlock`, Shiki loaded on first use with its JavaScript regex engine).
- `lib/feedback.ts`: `notify.success|error|info|warning` and `offerUndo({message, undo})`.
  Destructive actions delete at once and offer Undo; only irreversible ones (stored secrets, a
  project whose cards and threads lose their link) confirm first.
- `lib/format.ts`: `formatWhen`, `formatRelative`, `formatDuration` and `useDateFormat()`, in the
  `calendar.zone` zone. The UI never prints ISO timestamps.
- `app/shell-toolbar.tsx`: `ShellToolbar` renders a view's toolbar into the shell header row.

Tokens add `--warning`, `--info`, `--destructive-foreground`, `--overlay` and `--border-strong`,
the calendar's `--event-outlook`, `--event-outlook-border`, `--event-card`, `--event-card-border`,
`--event-work-hours` and `--event-now`, and an 11px `text-2xs` step; type uses only `text-2xs`, `text-xs`, `text-sm` and `text-base`. The
sidebar narrows to an icon rail below 1280 px (`max-xl`), with "needs you" counts read from the
`threads` and `workflowRuns` topics.

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
  invented `intents/demo/intent.md` in the project folder is the artifact step 1 finds. The projects
  tests use another copy from the Playwright config (`e2eProjectsHome`, `e2eProjectsPort`) whose
  home holds invented Claude and Codex session files and two instances that read them; they stand
  in for the desktop folder dialog by setting `window.wowDesktop.pickFolder` before the page loads.
  The settings
  tests start a second copy in its own home and port (`WOW_E2E_HOME`, `WOW_E2E_PORT`), because
  they add and remove instances and change global settings. Both run with `WOW_OUTLOOK=mock` and
  the fixture-backed `MockOutlookSource`; the first answers on a small HTTP control port
  (`e2eOutlookControlPort`) so the calendar tests can make the mock fail, bring it back and read
  which items Outlook was asked to open. The context panel tests use a fifth copy
  (`e2ePanelHome`, `e2ePanelPort`), because the panel's open state and width are global settings
  that change what a click in the calendar does; its home seeds a one-step workflow with a gate
  after the step and a card tomorrow that runs it, started with `POST /fire?cardId=…` on its
  tracker port. The trigger tests start a third copy themselves
  (`e2eTriggersHome`, `e2eTriggersPort`) because they restart it: `WOW_E2E_KEEP_HOME=1` keeps the
  home across a restart and `WOW_E2E_CLOCK_OFFSET_SECONDS` runs the server's clock ahead, so a
  trigger's time passes while the server is down without the test waiting. The server prints
  `wow e2e server ready` once it is seeded. The backlog tests publish to a mock Jira and GitHub on
  `e2eTrackerPort`, which the server's tracker settings point at (GitHub without its token, which
  the test enters on the settings page); the same port lists what the trackers received and starts
  a backlog item's card run the way the scheduler will (`POST /fire`). CI runs `pnpm e2e` on
  `ubuntu-latest` and `windows-latest` (the `e2e` job) and keeps the traces of a failed run.
  Tests wait for what the page shows, never for time: no sleeps, polls or retries.
