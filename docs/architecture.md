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
  skills/        SKILL.md discovery, the built-in wow skills (builtin/) and own skill files.
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
  `provider.update` (`{providerInstanceId}`), `provider.detect`, `projects.discover`,
  `calendar.occurrences` (`{from, to}`, the occurrences of the local cards in a range, see
  "Repeating cards"), `threads.search` (`{query}`, the threads whose title, project name or
  message text hold every word, see "Chat view"), `skills.refresh`,
  `threads.restorePreview` (`{threadId, turnId} | {threadId, undoItemId}`, what a restore would
  do now, see "Restore files when going back"),
  `files.read` (`{threadId | projectId, path}`, one file for the viewer, see "Files"),
  `files.list` (`{threadId | projectId}`, the folder's file names for "Open file…" and
  `@`, see "Files"), `attachments.put` and `attachments.read` (an image for a thread's message,
  see "Images in the composer"), `outlook.open`
  (`{entryId}`), `outlook.refresh`, `projects.git` (every project folder's git
  status and remotes), `trackers.project` (`{projectId}`, one project's tracker settings with their
  sources and suggestions), `trackers.test` (`{service, projectId?}`, signs in with the tracker
  settings as they apply and answers `{ok, account, message, missing}`), and `trackers.preview`
  (`{backlogItemId, service, projectId?}`) and `trackers.publish` (`{backlogItemId, service,
projectId?, title?, labels?}`), `setup.save` and `setup.preview` (`{text}`; see "Setup file").
  Error codes are `RpcErrorCode`.
  The same port answers plain HTTP on one path, `/assistant/mcp`, for the assistant's tools
  (see "Assistant"); every other HTTP request gets 426. That path has a token of its own.
- **Subscriptions.** One topic per projection (`subscriptionTopics` in contracts); thread-scoped
  topics (`turns`, `threadItems`, `approvals`, `questions`, `hostItemReads`, `threadTools`) need a
  `threadId`. After a commit that touched a topic, every subscriber of it gets the topic's full
  current rows. Subscriptions end with their connection.
- **Client runtime.** `packages/client-runtime` queues requests until the socket opens, fails
  in-flight requests when it drops, reconnects with capped exponential backoff and subscribes again
  after every reconnect. It reads the port and token from `server.json` (`ServerInfo`). It
  subscribes with `subscribe {topic, threadId?}`, keeps the returned `subscriptionId` per socket to
  route pushes and to `unsubscribe {subscriptionId}`, and shares one server subscription between
  listeners of the same topic and thread (a late listener gets the last rows at once). The server
  sends a subscribe answer after its own microtasks, so a commit's push can arrive first; while an
  answer is awaited the client keeps the newest push of each id it does not know yet and delivers
  it right after that answer's rows.
- **Commands → events → projections.** A request becomes a command. The orchestrator (pure
  function, no I/O) turns the command plus current projection into events. One SQLite transaction
  appends the events, updates projections and records the command receipt (idempotent retries).
  Effects (start a provider turn, poll Outlook, fire a trigger) run after commit in the effect
  worker and feed results back as commands. Subscribers get projection changes after commit.
  A command carries a client-chosen `commandId`; `command_receipts` records it with a fingerprint
  of the command and the event sequence numbers, so a retry returns the first receipt
  (`duplicate: true`) without new events, and reusing an id for a different command is a
  `conflict`. A rejected command stores nothing, so its id can be retried. Commands only the
  server issues (`provider.events`, `providerInstance.recordTest`, `skills.sync`, the working
  copy outcomes) are `InternalCommand`s: they go
  through the same engine but `dispatch` over RPC does not accept them.
  A command also has an origin, `user` or `assistant`. It is an argument of `Engine.dispatch`
  that defaults to `user`, not a field of the command, so nothing a client sends can claim one:
  everything over the WebSocket is the user's, and only the assistant's tools dispatch as the
  assistant. `decideInSteps` (`core/assistant.ts`) decides a command in steps inside the one
  transaction; each step's events are stored and projected before the next step decides. A
  user's command is one step, as before. See "Assistant" for what the steps are for.
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
  `apps/server/src/db/schema.ts` and applied at startup. When drizzle-kit rebuilds a table
  (a column that stops being required), check the generated copy statement: it names the new
  columns as if the old table had them, which `0011_event_triggers` fixes by hand and tests. Columns are snake_case. `WOW_HOME`
  overrides `~/.wow`; it is an environment variable rather than a setting because the settings
  live inside it.
- **Scheduler.** A tick every `scheduler.tickSeconds` (default 30) selects due triggers, fires
  them as commands, and applies `scheduler.missedPolicy` (`run` | `mark` | `skip`) once at startup
  for triggers whose time passed while the server was down. Times are stored as UTC ISO strings
  plus the IANA zone they were entered in; `Temporal` polyfill (`@js-temporal/polyfill`) does zone
  math. Default zone is the system zone. Details in "Scheduler and triggers".
- **Files.** `apps/server/src/files/read.ts` (`readViewerFile`) is the only way a whole file
  of the user's leaves the server, and `files.read` is its only caller; there is no HTTP file
  server. (`attachments.read` sends back an image wow itself stored for a thread, see "Images in
  the composer".)
  (`threads.diff` sends the changed lines of files git lists as changed inside a thread's
  folder, see "A folder's changes".) `files.read` takes a scope (`FileScope` in
  `packages/contracts/src/files.ts`, agent workbench Interface): a thread (its folder, then its
  project's folder; a thread without a project only its own) or a project (its folder). The handler
  (`fileScope` in `rpc/handlers.ts`) turns the scope into those folders and the words a refusal
  names them with (`place`), and passes `viewer.maxFileBytes`. The assistant's thread has no
  files (its folder is wow's own; `rejected`). `files.list` (`files/list.ts`, `listFolderFiles`)
  names the files of the scope's first folder for "Open file…" and `@` (agent workbench spec 18,
  56), never their content: inside Git `git ls-files --cached --others --exclude-standard -z`
  (tracked plus untracked files Git does not ignore, read as the output streams and stopped at
  `viewer.fileListLimit`; a name that is no file on disk, a tracked file deleted or a submodule's
  folder, is left out; when git runs out of time the names read so far are the answer, marked
  `truncated`, since a walk would list what Git ignores; at the limit and out of time the
  stopped git is waited for, up to `advanced.gitStopWaitMs`, as every stopped git is, see "Git"
  under "Projects"), else a breadth-first walk that skips hidden folders and
  `node_modules` and stops at the same limit; the answer says which (`source`) and whether it
  stopped (`truncated`). A
  relative path is looked for in each folder in order, a full path must lie in one of them. The
  order of checks: the path as written must stay inside a folder, as registered or at its
  `realpath` (`path.resolve` and `path.relative`, so `..` and other drives are refused without
  touching the file; a folder registered through a link or junction is also reached by the
  resolved full path that Copy path hands out); `realpath` of the file must still be inside the
  `realpath` of a folder (a symbolic link that leaves is refused); it must be a regular file no
  larger than the limit; then it is read once. Binary is decided after that read, and a binary
  file's bytes are dropped on the server. Content decides what it is: PNG, JPEG, GIF and WebP by their first bytes, SVG by its extension;
  anything else must decode as UTF-8 (or UTF-16 with a byte order mark, which Windows tools
  write) without a NUL, or it is binary. The answer (`FileReadResult` in
  `packages/contracts/src/files.ts`) is `markdown`, `html` or `text` with the text, `image` with
  a media type and base64, or `refused` with a reason (`outside`, `missing`, `not_a_file`,
  `unreadable`, `binary`, `too_large`) and a sentence for the panel. A refusal is an answer, not an RPC error;
  only an unknown thread or project is `not_found`. `isInside` and `candidatePaths` take the path module, so
  the Windows rules (case, both separators, drives, UNC) are tested on every platform, and one
  test reads real files on `windows-latest`.
- **Services, thin transports.** Each feature is a service with an `Effect`-free plain TypeScript
  API; RPC handlers only validate and call services.

## Data model (projections)

```text
projects         id, name, cwd, defaultProviderInstanceId, defaultModel, defaultEffort,
                 defaultPermissionMode, createdAt
provider_instances id, kind ('claude'|'codex'), name, binaryPath, configDir, env(json, secret keys by ref),
                 launchArgs, defaultModel, defaultEffort, defaultPermissionMode, status, account,
                 version?, statusMessage?, update(json)?   -- from the last "Test"
                 updateRun(json)?   -- the last "Update Codex": state, command, output, times
threads          id, projectId?, cwd, branch?, providerInstanceId, providerSessionId?, title, model,
                 effort, permissionMode, state ('idle'|'working'|'needs_you'|'done'|'failed'),
                 pinned, backgroundTasks(json: BackgroundTask[]), archived, seen,
                 queued(json: QueuedMessage)?, baseSha?, baseFiles(json: FileHash[])?,
                 createdAt, updatedAt   -- backgroundTasks: the
                 agent's work still running in the background, [] when none (migration
                 0026_background_tasks); archived and seen (false while unread) for the thread
                 list, false and true for older rows (migration 0027_thread_list); queued: the
                 message waiting for the running turn to end (migration 0028_queued_messages);
                 baseSha, baseFiles: where a chat thread's Changes are measured from, set at its
                 first turn (migration 0029_thread_changes); parentThreadId: the thread that started
                 a helper, with startedBy 'helper' (migration 0042_helper_threads; depth derived); stateSince (0031); goBack(json:
                 GoBack)?, forkedFrom(json: {threadId, turnId})? for Edit and Fork (migration
                 0032_fork_and_edit); workingCopy(json: WorkingCopy)? a chat thread's own
                 working copy, null for older rows (migration 0035_thread_working_copy; repository? for a helper's copy of another repository);
                 changeCount(json: ChangeCount)? what the thread changed as of its last turn's
                 end (migration 0043_thread_change_count); tasks(json: {done, total})? how far
                 its latest task list is, set by the projector as a `task_list` item is added
                 (migration 0044_thread_tasks)
turns            id, threadId, index, state, startedAt, endedAt, usage(json),
                 fileMark(json: FileHash[])?   -- the changed files' hashes as a chat thread's
                 turn began, for "This turn only" (migration 0029_thread_changes);
                 resumePoint(json: {sessionId, at})?, replacedBy? -- the provider's point after
                 the turn and the turn Edit put in its place (migration 0032_fork_and_edit);
                 startSnapshot, endSnapshot(json: TurnSnapshot | {missing})? -- wow's snapshots
                 of a chat thread's folder as the turn started and ended, or why there is none
                 (migration 0036_turn_snapshots)
restore_points   itemId, threadId, before(json: TurnSnapshot)?, after(json: TurnSnapshot)?, at
                 -- the folder just before and just after a restore, by its line's item id
                 (migration 0036_turn_snapshots)
thread_items     id, threadId, turnId, index, kind ('user'|'assistant_text'|'reasoning'|'tool_call'|
                 'approval'|'question'|'task_list'|'usage'|'error'|'settings_change'|
                 'compaction'|'files_restored'), payload(json), streaming   -- a subagent's tool_call and
                 assistant_text carry its call's row id as payload.parentItemId
approvals        id, threadId, itemId, kind ('command'|'fileChange'|'tool'|'plan'), request(json),
                 decision? ('allowOnce'|'allowSession'|'allowAlways'|'deny'), decidedAt?   -- what
                 the card shows (facts, rule, plan, byRule, note) is in the approval item's payload
questions        id, threadId, itemId, request(json), answer?, answeredAt?   (answer: the reply
                 as one line; the item's payload holds the reply's picks and text)
calendar_items   id, source ('outlook'|'local'), externalId?, title, start, end, zone, allDay,
                 location?, joinUrl?, body?, organizer?, projectId?, backlogItemId?, workflowId?,
                 threadId?, state, updatedAt, repeat(json: RepeatRule)?, skippedDates(json: string[]),
                 nextAt?, pastSeries(json: PastSeries[])   -- state: CardState for cards,
                 'scheduled'|'cancelled' for Outlook; body: a card's notes or an Outlook item's
                 snippet; repeat, the days skipped by hand and the trigger's next time for a
                 repeating card (migration 0022_repeating_cards); pastSeries the series it
                 followed before a change, for the days before it (migration 0023_past_series)
card_occurrences cardId, date, start, end, outcome ('fired'|'failed'|'skipped'|'missed'),
                 threadId?, reason?, offerRunNow, at   -- what happened at each occurrence of a
                 repeating card the scheduler reached; kept when the card is deleted, as its
                 threads are
outlook_status   singleton: lastSyncAt, lastError?, unavailableSince?, bridgeVersion,
                 profile(json: OutlookProfile)?
backlog_items    id, title, body, tags(json), state, remote(json: service,key,url)?, createdAt
workflows        id, name, templateKind?, steps(json: WorkflowStep[]), ownWorkingCopy, forUnits,
                 maxStepVisits?, createdAt, updatedAt   -- stored workflows, kept as data since
                 nothing runs them (see "Stored workflows")
triggers         id, workflowId, calendarItemId, runAt, zone, state ('scheduled'|'fired'|
                 'missed'|'cancelled'), offerRunNow   -- a card's trigger; event triggers went in
                 migration 0051
notifications    id, at, kind ('started'|'waiting'|'failed'|'skipped'|'finished'), title, body,
                 path, calendarItemId?, threadId?, approvalId?   -- threadId and
                 approvalId for a chat thread's notification (migration 0027_thread_list)
skills           id, name, description, dir, source ('user-claude'|'user-codex'|'project-claude'|
                 'project-agents'|'custom'|'wow'|'yours'), manualOnly, invocations(json: {claude,
                 codex}), text? (a wow skill's text; null for folder skills)
host_item_reads  id ('thread:<threadId>:<hostItemKey>'), scope ('thread'), threadId,
                 item(json: HostItemRef), hostName, data(json: HostItemData)?, fetchedAt?,
                 error(json: HostError)?   -- an item a chat thread links to, as last read when
                 its tab opened or on Refresh now (migration 0030)
thread_tools     threadId, tools(json: SessionTools), source ('turn'|'refresh'), live,
                 reportedAt   -- what a chat thread's session last reported it can use; live
                 while the session that reported it is open in its adapter (migration
                 0034_thread_tools)
assistant_changes id (the command's id), at, commandType, what, from?, to?, place(json: {label,
                 path}), target(json: {kind, id}), expect(json)?, inverse(json: Command[]), state
                 ('applied'|'undone'), undoneAt?   -- what the assistant changed, with the record
                 Undo needs
assistant_proposals id (the command's id), at, commandType, title, lines(json: {what, from, to}[]),
                 place(json), command(json: Command), basis(json)?, state
                 ('pending'|'accepted'|'declined'), answeredAt?, reason?   -- commands of the
                 assistant that wait for the user's yes, with the state they were proposed for
setup_applications id (the command's id), at, name, added(json), replaced(json), marked(json),
                 toFillIn(json), parts(json: AssistantChangeRecord[]), state
                 ('applied'|'undone'), undoneAt?   -- setup files applied here, with what Undo
                 puts back (migration 0019_setup_applications)
assistant_greeting id (always 1), owedAt   -- one row while the greeting after the first-start
                 step waits for the assistant to run it (migration 0020_assistant_greeting)
settings         key, value(json), scope ('global'|'project:<id>'|'provider:<id>')
events           seq, at, kind, aggregate, payload(json)   -- the history
command_receipts commandId, commandType, fingerprint, seqs(json), at   -- idempotent retries
```

`WorkflowStep = {id, skillName, skillSource?: 'wow'|'yours', alsoFollow?: SkillRef[], leaveOut?:
BuiltInSkillName[], providerInstanceId, model?, effort?, permissionMode?, gateBefore,
gateAfter, gateAfterCondition?: ('verdict'|'checks'|'artifacts')[], extraPrompt?,
expectedArtifacts: string[]}` (the skill fields: see "wow skills"), kept in a JSON column of a
stored workflow (see "Stored workflows").

## Providers

Both adapters implement one interface from `packages/contracts`:

```text
ProviderCommand: startTurn {threadId, cwd, prompt, model, effort, permissionMode, resumeId?,
                            toolset? {name, url, token}, instructions?,
                            goBack? {at|null, fork}}
                 interrupt {threadId} | closeThread {threadId} |
                 answerApproval {approvalId, decision, note?, permissionMode?} |
                 answerQuestion {questionId, answer {picked, text}} | setModel | setPermissionMode |
                 listModels | handOver {threadId, prompt} -> {taken} |
                 listCommands {cwd, threadId?} -> [{name, description, argumentHint?}] |
                 describeSession {threadId} -> SessionTools | null |
                 stopTask {threadId, taskId} | toBackground {threadId, itemId?} | test
ProviderEvent:   session {providerSessionId} | textDelta {itemId, delta, parentItemId?} |
                 reasoningDelta |
                 toolCallStarted {itemId, name, input, ...ToolFacts?, parentItemId?} |
                 toolCallOutput |
                 toolCallCompleted {itemId, status, exitCode?, durationMs?, diff?, toolCount?,
                                    answer?, agentState?} |
                 approvalRequested {approvalId, kind, summary, request, facts?} | questionAsked |
                 taskListUpdated | usage {..., model?} | contextUsage |
                 compacted {trigger manual|auto, preTokens?, postTokens?} |
                 turnCompleted {resumePoint?} | turnFailed {error, resumePoint?} |
                 turnInterrupted {resumePoint?} | turnStartedByProvider |
                 backgroundTasks {tasks [{id, description, agent?, kind?, lastOutput?}]} |
                 commandRefused {command stopTask|toBackground, error} (made by the server) |
                 sessionTools {tools: SessionTools}
```

**Tool facts.** Each adapter normalizes a tool call into `ToolFacts` (`provider.ts`): `kind`
(`command`, `read`, `search`, `web`, `mcp`, `edit`, `other`) and, where the input gives them,
`command`, `cwd`, `path`, `lines {from, to?}`, `pattern`, `url`, `query`, `server`, `tool`, and
for an edit `diff` (see "Edits and approvals" below).
Claude Code (`provider-claude/src/tools.ts`): Bash is a command (its result has no exit code or
duration, so a failed one is only `error`), Read and NotebookRead reads (offset and limit become
`lines`), Grep and Glob searches, WebFetch and WebSearch web, `mcp__<server>__<tool>` MCP, Edit,
MultiEdit, Write and NotebookEdit edits, anything else `other`. Codex: a `commandExecution` is a
command with its `cwd`, and its completion carries `exitCode` and `durationMs`; `mcpToolCall` is
MCP (with `durationMs`), `fileChange` an edit (with `path` when it changes one file), `webSearch`
web, `imageView` a read, `dynamicToolCall` other, a `collabAgentToolCall` that spawns an agent a
subagent (below). The server stamps `startedAt` on
`toolCallStarted` and `endedAt` on `toolCallCompleted` with its own clock and keeps the facts,
exit code and provider duration in the item's payload, so a reload shows the same times. A call
stored before has none of these fields and is drawn as it was.

**Subagents** (agent workbench spec 44). A call that hands work to another agent has kind
`subagent`, with `description`, `prompt`, `agentType` and `agentState` (`starting`, `running`,
`done`, `failed`, `stopped`, `missing`) where the provider gives them. What the subagent itself
does arrives as ordinary `toolCallStarted` and `textDelta` events with `parentItemId`, the
provider id of the subagent call; the server stores it as `parentItemId` (the call's row id) on
the `tool_call` or `assistant_text` payload, so no migration was needed. When the call ends,
`toolCallCompleted` may carry `toolCount`, `answer` and `agentState`, kept on the call's payload.
A call can outlive its turn (a subagent sent to the background, a Codex `wait` in a later turn):
the parent, and the row a later `toolCallOutput` or `toolCallCompleted` goes to, is the call's row
in the current turn, else the newest of the thread (`ReadModel.toolCallRow`); nested work whose
call the thread has no row for is dropped, so it never reads as the agent's own.
A turn's last text (a step's final message, the plan fallback) is the thread's own agent's: items
with a `parentItemId` are left out (`ownText` in `db/schema.ts`). Claude Code: `Agent` (`Task` in
older versions) is the subagent call; its messages marked with `parent_tool_use_id` become the
nested events (only their complete assistant messages: their stream deltas and thinking are
dropped, and a subagent's task list stays its own), and the Agent result's `totalToolUseCount`,
`totalDurationMs` and text content give the count, the time and the answer; a subagent launched
into the background answers without them. Its messages while no turn runs (a background
subagent after the turn) are dropped and start no turn. Codex: a `collabAgentToolCall` with tool
`spawnAgent` is the call, with its prompt; the other collab calls (wait, send input, close) add
no row but report the agents they name in `agentsStates`, and each change of a spawned agent's
state is sent as another `toolCallCompleted` of the spawn call, with the agent's last message as
the answer once it is done or failed (a closed agent that had finished stays finished). Whether
the spawned agent's own codex thread reaches wow's connection is not verified; when it does,
its items and messages (ids prefixed with that thread's id) are nested the same way, and when
it does not, the row shows prompt, state and final message only. The protocol fingerprint has
the collab fields the adapter reads, all marked as coped with (hand-added).

**Turns the provider starts.** Claude Code goes on with a thread by itself when background work
it started (a background subagent or shell command) ends: the open `query()` stream carries more
output and a second `result` without a prompt from wow. The adapter reports that turn with
`turnStartedByProvider` at its first top-level `stream_event`, `assistant` or `result` message
while no turn runs, and ends it with the usual `turnCompleted`, `turnFailed` or `turnInterrupted`;
`interrupt` stops it like any turn. A `system/task_notification` for a background agent
(`task_type` `local_agent`) while no turn runs starts that turn at once, because Claude Code
answers it and the agent leaves the background list before the turn's first output. The
orchestrator makes it turn `<threadId>:turn:<n>` with no
user item (`turn.startedByProvider`): the thread goes to `working`, its items, usage and end are
stored as for any turn, and the thread ends `idle`, `needs_you` or `failed` the same way. While a
turn wow started runs, `turnStartedByProvider` is ignored and the output stays in that turn. A
message sent while Claude Code's own turn runs goes into its input queue; Claude Code answers it
after (or within) that turn. `backgroundTasks` is the SDK's level signal
(`system/background_tasks_changed`, Claude Code's own `ambient` tasks left out; `agent: true`
marks a `local_agent` task; `kind` is `agent`, `command` for `local_bash`, else `other`), stored
as the thread's `backgroundTasks` (`thread.backgroundChanged`). A task's `lastOutput` is the
latest `system/task_progress` of it: its `summary`, else "<last tool> · n tool calls"; the next
list keeps it. Reading a task's own output is not a query method of the SDK, so that is all wow
has. The server stamps each task's `startedAt` with its clock when it is first listed and keeps
it in later lists. The chat shows the tasks as chips (see "Subagents and background work" under
"Chat view"). When Claude Code exits with background work and no
turn running, the adapter reports a started and failed turn. At startup `recover()` fails such a
turn only for a thread of a running workflow step that still lists a background agent; every other
thread only gets its list cleared and keeps its state. When `ProviderService` releases an adapter
(its instance edited or deleted), it clears the list of the instance's threads, since the disposed
adapter reports nothing more; `closeThread` clears it in the adapter. Codex: the generated app-server schema
does not say whether codex starts turns by itself; the adapter treats a `turn/started` it did not
ask for (no `turn/start` on its way, no running turn) as `turnStartedByProvider`, and reports no
background work.

`closeThread` ends the adapter's live session for a thread without a turn event (the provider's
stored conversation stays): Claude closes that thread's `query()`, Codex forgets which codex
thread it maps to, since the app-server has no request that unloads one.

- **Claude** (`packages/provider-claude`): `@anthropic-ai/claude-agent-sdk` `query()` in streaming
  input mode (an `AsyncIterable<SDKUserMessage>` prompt) so `interrupt()`, `setModel()` and
  `setPermissionMode()` work mid-session. `pathToClaudeCodeExecutable` from the instance's binary
  path, `env: {...process.env, CLAUDE_CONFIG_DIR, ...instance.env}`, `settingSources:
['user','project','local']` so skills and plugins load, `includePartialMessages: true` for
  deltas, `resume` with the stored session id, `canUseTool` turns a prompt into `approvalRequested`
  (with its facts; `ExitPlanMode` as a `plan` approval), answers a denial with its note as the
  message, and an `AskUserQuestion` call into `questionAsked`. `effort` passes through. Usage comes from
  the result message and `getContextUsage()`.
- **Codex** (`packages/provider-codex`): spawn `<binaryPath> app-server <launchArgs>` with
  `CODEX_HOME` and the instance env, newline-delimited JSON-RPC on stdio (codex leaves out the
  `jsonrpc` member). `initialize` + `initialized` → `thread/start` or `thread/resume` →
  `turn/start`; `turn/interrupt`; notifications for items (`item/started`, `item/completed`, agent
  message, reasoning, command and file change output deltas), `turn/plan/updated`,
  `thread/tokenUsage/updated` and `turn/completed`; server-initiated requests
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and
  `item/permissions/requestApproval` map to `approvalRequested`, `item/tool/requestUserInput` to
  one `questionAsked` per question (its `header`, and the request's `itemId` as `askId`; the
  answers go back together, each question's list holding the picked labels and then the typed
  text as an answer of its own); `model/list` feeds the picker and `account/read` the "Test"
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
  items (`{name, input, output, status}` plus the tool facts and times below), `approval` and
  `question` items point at their `approvals`/`questions` rows (the payload of each item kind is a
  schema in `packages/contracts`, `*ItemPayload`), each change of the task list is a `task_list`
  item of its own (`{tasks, at}`: the first keeps the id `<turn>:tasks`, later ones
  `<turn>:tasks:<n>`, where `n` is the number of lists the turn already has, read with one count;
  a list equal to the turn's last one adds nothing, since Codex sends its plan again unchanged and
  Claude Code's adapter sends the list on every task tool call; a turn's single list stored before
  has no `at`), and usage plus
  context usage merge into one `usage` item per turn and the turn's `usage`. Provider ids are only
  unique per session, so row ids are prefixed with the turn or thread id. Thread state: `working`
  while a turn runs, `needs_you` while an approval or question is open, `idle` after a completed or
  interrupted turn, `failed` after a failed one. An effect that cannot start or interrupt a turn
  fails the turn with the reason; a turn still `running` at startup failed with the previous server
  process and is marked so. Events after a turn ended are dropped.
- **Queued messages** (agent workbench spec 50 to 52). `thread.sendMessage` while a turn runs does
  not start a turn: it sets the thread's `queued`
  (`QueuedMessage {id, text, skills?, images?, files?, queuedAt}`, a JSON column of `threads`,
  migration `0028_queued_messages`) through `thread.queueChanged`. A second message joins it
  (texts separated by a blank line, skills, images and `@` files once each; the files go on the
  user item it becomes) and gets a new `id` (the old one plus `+`), so whatever acts on the queue acts on one version of it. For a chat
  thread the event carries `handOver {providerInstanceId, prompt}` (the prompt with the
  skills in front, as `thread.sendMessage` would send it); the provider service then sends the
  adapter `handOver {threadId, prompt}`, which answers `HandOverResult {taken}`. While the turn
  it joins is still being prepared (`#starting`: the folder read for its changes, the thread's
  own working copy), the offer waits for that start, as a stop does. Taken, the
  service dispatches `thread.handedOver {threadId, queuedId, offered {text, skills?, files?}}`: the queue
  empties and a `user` item with `queued: 'duringTurn'` joins the running turn (or the turn that
  just ended), so the conversation shows it sent. Not taken, it stays queued. The service offers a
  thread one version at a time: a join while the adapter has not answered is not offered then; if
  that answer is "not taken", the join (the whole queue as it is now) is offered once more. The
  thread's `turn.ended` (and the service's `stop`) lets go of an offer that is never answered, so
  the next turn is offered its messages. A known limit: a "taken" answer that arrives after the
  offered turn ended is still recorded, and if `thread.sendQueued` already sent the message, the
  provider then has its text twice (ClaudeAdapter answers at once and Codex never takes one, so
  neither answers late). When the
  answer names an older `queuedId` (joined or cancelled since), the orchestrator still shows
  `offered` in the running turn it was offered to (the turn id starts the queued id), keeps only
  the rest of a joined message (text after the offered one, skills and files it did not carry,
  its images) and offers that rest again. A message with images is never offered (a hand-over
  carries text only); it waits for the turn's end. On every `turn.ended` whose thread holds
  a queue, the service dispatches `thread.sendQueued {threadId, queuedId}` in a microtask (after
  every listener heard of the end, so none sees the next turn start first) with command id
  `send-queued:<queuedId>`; the orchestrator empties the queue and starts the turn as
  `thread.sendMessage` would, the user item marked `queued: 'afterTurn'`. `recover()` sends a
  queue left with no running turn; the command id makes a second dispatch a duplicate. When a
  turn runs again by then (a listener of the same end started one, as the workflow runner does
  with a step's held turn), `thread.sendQueued` is refused with `conflict`, so no receipt is kept
  and the message goes at that turn's end. Any end counts, a failed or stopped turn included. The
  assistant thread's message always waits (its prompt carries notes made when its turn starts).
  `thread.cancelQueued` empties the queue and is refused when nothing waits, so Edit (cancel, then
  the text back in the composer) never puts back a message the server already sent. A queued
  message the server cannot send when the turn ends (a skill gone, the assistant unable to run)
  stays queued with Edit and Cancel; the next turn end tries again.
- **Background work** (agent workbench spec 90). `thread.stopTask {threadId, taskId}` (a task the
  thread lists) and `thread.toBackground {threadId, itemId?}` (a running `command` or `subagent`
  call of the running turn, or every one when absent) are refused where the provider cannot:
  `providerChatOptions[kind].stopsTasks` and `.sendsToBackground`, true for Claude Code and false
  for Codex, which has no such request. They become `thread.taskStopRequested` and
  `thread.backgroundRequested` (no projection), and the provider service sends `stopTask` and
  `toBackground` (with the provider's call id). Claude Code runs them as the query's
  `stopTask(taskId)` and `backgroundTasks(toolUseId)`; a `false` answer (nothing of that id runs
  in the foreground any more) fails the command. A provider that refuses changes nothing; the
  refusal is logged and the turn goes on. What follows (the call's result, a new task list) comes
  as the provider's own events.
- **Claude details.** The SDK version is pinned exactly in `packages/provider-claude/package.json`.
  `launchArgs` (`--flag value`, `--flag=value`, `--flag`) become the SDK's `extraArgs`. Effort
  `default` leaves the effort to Claude Code; other values must be an SDK `EffortLevel`. A thread
  keeps one `query()` while the server runs; model, permission mode and effort changes are applied
  to it before the next prompt. `canUseTool` waits for the answer: allow once, allow for this
  session (the SDK's suggested rules with destination `session`) or deny; an interrupt denies with
  `interrupt: true`. `AskUserQuestion` may hold several questions; each is asked separately (with
  its `header` and the tool call id as `askId`) and the tool runs with `answers` once all are
  answered. Claude Code takes one text per question: the picked labels separated by ", " and then
  the typed text, which is how its own "Other" answers. The task list comes from `TodoWrite` (whole list)
  or `TaskCreate`/`TaskUpdate` (one task at a time). `total_cost_usd` is cumulative per query, so a
  turn's cost is the difference to the previous result. `test` runs a tool-less one-turn query in
  the temp directory and reports `claude_code_version` from the init message and the account from
  `accountInfo()`; the server stores them on the instance. `listModels` uses `supportedModels()` of
  a live session or a short-lived query. `handOver` pushes the prompt into the live session's
  input with `priority: 'next'`, which joins the running turn at its next step as Claude Code's own
  queue does; without a running turn, or in the assistant's tools-only session, it answers
  `{taken: false}`. Should Claude Code answer the message in a turn of its own after the result
  instead (not verified for a turn wow started), that turn arrives as one it started by itself.
  `listCommands {cwd, threadId?}` answers `supportedCommands()` (name, description, argument hint)
  of the thread's live session, or of a short-lived query opened in `cwd`. Codex answers
  `handOver` with `{taken: false}` and `listCommands` with `[]`; RPC `provider.listCommands
{providerInstanceId, cwd, threadId?}` returns the list (`ProviderSlashCommand[]`). The provider
  service keeps an answer per instance and folder for `providers.commandListSeconds` (30 s; 0 keeps
  none), since a probe starts Claude Code in the folder and the list asks each time it opens.
  Calls that overlap share one probe, stale answers go on the next miss, and releasing an
  instance (or its row changing) drops its answers.
- **Chat options.** What the composer bar offers per provider kind (permission modes with their
  short label and tone, the Shift+Tab cycle `modeCycle`, the effort that leaves the choice to the
  provider, the compact message) is `providerChatOptions` in `packages/contracts`, because the
  web app cannot import the adapters. The keys are the ones the adapters accept. A mode's `tone`
  (`plan`, `edits`, `danger`) colours it; a `danger` mode (Bypass permissions, Full access) is
  never in `modeCycle`, and `nextPermissionMode(kind, current)` starts the cycle again from a mode
  outside it, so the bar, the palette and the key read one list (a contracts test holds this).
  Models and their efforts come from `provider.listModels`:
  `ProviderModel {id, label, description, efforts, defaultEffort?, isDefault?, imageInput?}`. The
  three optional fields are set only when the provider reports them: Codex's `model/list` gives `defaultReasoningEffort`,
  `isDefault` and `inputModalities` (`imageInput` is whether it holds `image`; an older codex
  without the field leaves it out, marked as coped with in the protocol fingerprint), and hidden
  models are left out; Claude Code's `supportedModels()` gives none of them, so they stay absent.
  Compact is Claude's `/compact` sent as a message; Codex's generated protocol has no compact
  method or notice, so a Codex thread shows no Compact (see "Conversation reading").
- **Instances.** A provider instance is one binary + one config directory + env. Several instances
  of the same kind are allowed (work and personal accounts). A thread remembers its instance and
  can only resume on an instance with the same config directory.
- **Onboarding** (`apps/web/src/providers`). Settings → Providers lists the instances with the
  status, account and version of their last "Test" and adds, edits, tests and removes them; palette
  commands do the same from anywhere. `provider.detect` looks for `claude` and `codex` on the
  server's PATH (PATHEXT on Windows) and reports the config directory each would use
  (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else `~/.claude` / `~/.codex`); what the onboarding needs
  per kind is `providerSetup` in contracts. The first-run wizard (palette "Detect installed
  providers") creates and tests one instance per detected CLI, then offers `projects.discover`'s
  folders as projects; "Not now" turns `providers.offerSetup` off. It no longer opens by itself:
  first start is the gate described under "Assistant" ("First start"). The instance editor runs `provider.detect` when it opens to fill an empty
  binary path and config folder, lists `provider.listModels` for a saved instance, and tests after
  every save; instances still `unknown` are tested when the app starts. The default instance for
  new threads is the one the newest thread uses (`lastUsedInstanceId` in
  `apps/web/src/providers/model.ts`), so nothing extra is stored. Secret environment values go to
  `secrets.set` as `provider:<instanceId>:env:<NAME>` and the instance stores the reference.
  `providerInstance.update` clears the last test when the binary, config directory, environment or
  launch arguments change, and both it and `providerInstance.delete` are refused while a turn runs
  on the instance; delete is also refused while chat threads use it (the assistant thread
  moves instead). After commit the provider service
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
→ {"id":3,"op":"open","entryId":"..."}     (Outlook shows the meeting)
← {"id":3,"result":{"opened":true}}
→ {"id":4,"op":"profile"}
← {"id":4,"result":{"timeZoneId":"W. Europe Standard Time","workHoursXml":"<Root ...>",
     "firstDayOfWeek":1,"address":"you@example.com"}}
← {"id":5,"error":{"code":"unavailable","message":"Outlook is not running"}}
```

These four operations are the whole protocol: Outlook is read for meetings only (spec 4). The
bridge answers any other op with `bad_request`, and `protocol.test.ts` reads the script's request
switch to check that it handles exactly the operations `resultSchemas` lists.

The schemas for these lines live in `packages/outlook-bridge/src/protocol.ts`, not in
`packages/contracts`, because they never leave the server.

Implementation notes: the bridge attaches to a running Outlook with
`[Marshal]::GetActiveObject('Outlook.Application')` instead of `New-Object -ComObject`, so it never
starts Outlook itself (behavior 3: Outlook not running means "unavailable"). `GetNamespace("MAPI")`,
`GetDefaultFolder(9)` for the calendar with `Sort("[Start]")`, then `Items.IncludeRecurrences =
$true`, and a `Restrict` on `[Start]`/`[End]`; iteration stops at the window end because a series
without an end date never runs out of occurrences. No other folder is opened. Times go out as `DateTimeOffset` strings with the local
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

`OutlookSource` is the interface (`ping`, `calendar`, `open`, `profile`, `close`).
`PowershellOutlookSource` starts the bridge on first use, numbers requests, and times each one out
after `outlook.requestTimeoutMs`; a timeout (Outlook blocked by a modal dialog) or an exit rejects
every pending request, kills the process, and the next request starts a fresh one.
`MockOutlookSource` answers from `packages/outlook-bridge/fixtures` (invented items placed relative
to today: a weekday standup with a Teams link, a weekly 1:1, an all-day offsite, a cancelled
meeting) and is selected off Windows and with `WOW_OUTLOOK=mock` (`prefersMock`,
`createOutlookSource`). It records every operation it is asked in `asked`, so tests can check that
a poll reads `ping`, `profile` and `calendar` and nothing else.

`OutlookSync` polls every `outlook.pollSeconds` (re-read before each poll; one poll at a time). The
window runs from the start of the current week (`calendar.firstDayOfWeek` in `calendar.zone`, both
resolved against the profile read in the same poll) to
the end of the day `calendar.lookaheadDays` after today. A poll hands the server's `OutlookSink` either a snapshot or a failure:

- **Snapshot.** Calendar rows with id `outlook:<externalId>`, where `externalId` is the EntryID, or
  `EntryID@<occurrence start>` for a recurring series because occurrences share the EntryID, state
  `scheduled` or `cancelled`, plus the bridge version and the profile. `diffCalendar` turns a
  snapshot and the stored rows into upserts and removals: Outlook rows overlapping the window that
  Outlook no longer returns are removed (deleted or moved meetings), rows outside the window stay.
  The server applies them and sets `outlook_status.lastSyncAt`, clears `lastError` and
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
skills settings or the project list change, and on `skills.refresh`, and while a skill folder
inside a project is missing also after every `turn.ended`. A missing skill folder inside a
project is not watched: waiting for a missing `<project>/.claude/skills` would watch the project folder and hold it on Windows. A
missing user-level folder (`~/.codex/skills` for someone without Codex) is watched as before,
which watches the folder above it in the user's home, and costs no scan per turn. An existing
`<project>/.claude/skills` or `.agents/skills` is still watched, and on Windows a handle open
below a folder may still refuse renaming or removing that project folder while wow runs. Scans
run one at a time and a burst of changes shares one queued scan. It sends the result as a `skills.sync` command, which
stores only the differences.

### wow skills

Two more sources sit beside the folders (wow skills spec 1 to 15). Both are read by the same scan,
from `wowSkillRoots(wowHome)` in `packages/skills`, and carry their text in `Skill.text`:

- `wow` (group "wow"): the built-in skills `wow-verdict`, `wow-artifacts`, `wow-pull-request` and
  `wow-handover`, shipped as `packages/skills/builtin/<name>/SKILL.md` and found with
  `new URL('../builtin', import.meta.url)`, so the desktop build copies the folder next to the
  server bundle. They come with the app version and cannot be changed: `skill.update` and
  `skill.delete` refuse them. `skills.builtInOff` lists the ones switched off; `SkillsService`
  leaves those out of `skills.sync`, so they are in no list and attached nowhere. Their text is a
  template filled by `fillBuiltInSkill` (`fillTemplate` in `packages/contracts`, the same
  `{{name}}`/`{{#name}}…{{/name}}` rules as the workflow texts) with `BuiltInSkillValues`:
  `approvedLine`, `changesRequestedLine`, `blockedLine` (the verdict line settings of the project),
  `expectedArtifacts` (the step's globs as a list), `intentId`, `unitKey`, `unitTitle` and
  `intentUnitLine` (`Intent-Unit: <intent>/<unit>`). A value not known for the send is empty and
  drops its section.
- `yours` (group "Yours"): own skills, one folder per skill under `<WOW_HOME>/skills`, in the
  same `SKILL.md` format (`ownSkillFile`: YAML frontmatter with `name` and `description`, then the
  text). A file put there by hand is read like any skill folder; one whose name starts with `wow-`
  is reported and skipped. Commands `skill.create {skill: {name, description, text}}`,
  `skill.update {skill}` and `skill.delete {name}` (`core/skills.ts`) check the name with
  `ownSkillNameProblem` (lower case letters, digits and single hyphens, at most 64 characters,
  not starting with `wow-`, not taken by another wow skill) and store `skill.saved {skill,
previous}` or `skill.deleted {skill}` in the skills projection at once; `SkillsService` writes
  or removes the file synchronously in its commit listener and rescans. The orchestrator does no
  I/O, so the RPC `dispatch` handler asks `SkillsService.refusal` first: a `skill.create` whose
  folder already holds a `SKILL.md` the list does not show (skipped by the scan, or a folder
  whose name differs only in case, which is the same folder on Windows) is refused with its path.
  The handler asks the same for the `skill.create` commands a `setup.apply` (its plan) or an
  `assistant.proposal.accept` (the proposal's command) would decide. `decideSkill` itself refuses
  a `skill.create` whose folder holds an own skill the list shows under another name (a
  hand-written file, compared without case), so the setup preview and the assistant's proposal
  are refused at once, with the same sentence.
  A file that cannot be written or removed is answered to the command as refused with the path
  and the reason (`writeFailure(commandId)`); the command has committed, and the rescan puts the
  list back to what is on disk. Scans run one after another, and a scan that began before an
  own-skill commit sends no `skills.sync` (the one that commit queued does), so it cannot undo
  the save, and `refresh()` called during it answers with that newer scan's list.
  The projection keeps an own skill's whole file as `Skill.file` (column `skills.file`, migration
  0025_skill_files; absent in events stored before it). `skill.update` changes only `name`,
  `description` and the text (`changedOwnSkillFile`): other frontmatter keys keep their place and
  value, and `manualOnly` stays. Undo of a create is the delete; Undo of an update or a delete is
  `skill.restore {folder, file}` with the folder name and the file the client holds, which writes
  the file back byte for byte. It is not checked against the name rule or for a text, since the
  file was listed before; it refuses a folder that is not one plain name, a frontmatter that is
  not YAML, a name starting with `wow-`, and (`SkillsService.refusal`) a `SKILL.md` in that
  folder the list does not show. The assistant's and the setup file's change records keep the
  folder and the file (`skillFolder`, `skillFile`, not shown) so their undo sends the same
  restore; the record's `expect` holds the file the change left, so a hand edit of any line since
  refuses the undo ("its SKILL.md is not the file this change left"). From the assistant create, update and delete are proposals and restore is refused
  (see "Assistant"); a setup file carries own skills (see "Setup file").

**Settings → Skills** (`apps/web/src/settings/skills.ts`, `skills-section.tsx`; wow skills spec
3, 5). Above the folder settings: "Your skills" (the `skills` topic's group `yours`) with New
skill, and Edit and Delete on each row, and "Built in" (group `wow`), read-only, each with its
text under "Show the text". The editor is a dialog (`skillsStore.editor`) with Name (fixed
while editing; a new name is a new skill), "When to use it" and Text. Save checks the draft
with `ownSkillNameProblem` against the other wow skills first and shows the reason without
sending anything; a refusal of the server is shown in the same place and the dialog stays
open. After a save or a delete a toast offers Undo, which sends the opposite command with the
skill as the client held it. Palette: "New skill" (`skills.new`, opens the page and the
editor), "Edit skill: <name>" and "Delete skill: <name>" for every own skill (search only). No
keybinding: these are rare. `apps/web/e2e/wow-skills.spec.ts` (Changes copy) writes a skill and
adds it to a step, and sees `wow-verdict` attached by itself to the Bug template's check-work;
with `WOW_E2E_SKETCHES` set it writes `intents/2026-11-wow-skills/sketches/your-skills.png`.

`skillGroupOf(skill)` in `packages/contracts` gives a skill's `SkillGroup` (`yours`, `wow`,
`project`, `user`, `plugins`, `other`) and `inListOrder` sorts by that group and then by name;
the `skills` topic is sent in that order, so Yours comes first in every list.

A step or a message names a skill with `SkillRef {name, source?}`. Without `source` it is a
folder skill, invoked as before (`plugin:name` for a Claude plugin's), or a built-in one by its
reserved name; `source: 'yours'` keeps an own skill apart from a folder skill of the same name,
and each is listed with its own group. `skillToSend(skills, ref, providerKind, values)` answers a
wow skill's text (a built-in one filled) or a folder skill's invocation, or nothing for a wow
skill that is not in the list. Two hand-written folders can give own skills the same name, and a
`SkillRef` names a skill by name only, so for such a name it answers `refused` with
`ambiguousOwnSkill` (contracts `skills.ts`), the sentence that names every folder: the message is
refused with it, a step fails before it starts with it, and `skill.update` and `skill.delete` of
that name are refused. Every skill list shows the folder beside such a skill
(`sharedOwnSkillFolders`; the builder's one choice names both folders, and `read_skills` gives
`folder` and `cannotUse`). `promptWithSkills(parts, tail)` puts each wow skill's text as its
own block marked with its name:

```text
<skill name="tidy">
Tidy the imports.
</skill>
```

and keeps invocations and the tail that follow each other on one line, as a step's invocation and
extra prompt always were. The name is written with `&`, `"`, `<` and `>` as entities, and a
`<skill` or `</skill` in the text gets its `<` as `&lt;`, so a hand-written skill cannot end the
block early or open another one. `promptShown` is the same without the texts: what the thread shows.

Chat: `thread.sendMessage {threadId, text, skills?: SkillRef[]}` sends the skills in their order
before the text (`text` may be empty when there are skills), built-in ones filled with the project's verdict lines (no artifacts, no unit).
A skill that is gone refuses the message with its name; the assistant thread takes no skills.

Every user message item stores `TextItemPayload.skills?: SentSkill[]` (`{name, source, text?,
invocation?, reason?}`): the text that was sent for a wow skill, the invocation for a folder
skill, and why wow attached a built-in one. `text` is what the user typed, or for a step the
prompt without the wow skills' texts. Older items have no `skills`.

### Skills in the composer

The composer (`apps/web/src/chat/composer.tsx`, wow skills spec 16 to 20) stays a plain text box
with the picked skills held beside the text, not a rich editor: chips are a list in front of the
text box (`ComposerSkillChip` in `chat/skill-chip.tsx`), so caret handling stays the browser's.
The list opens only where an input event of type `insertText` typed `chat.skillTrigger` (global,
default `/`) at the start of the text or after whitespace (`typedTrigger` in `chat/model.ts`);
it stays open while the caret is in the word after it (`skillQuery`) and closes for good once the
caret leaves. A paste, a path (`src/app`) or a date never opens it, and only a pick makes a chip:
text is never parsed into chips. A pick takes the trigger and query out of the text
(`withoutQuery`) and adds the `Skill`; `skillRefOf` names it on the wire as `SkillRef` (`source`
for wow and own skills, `plugin:name` for a Claude plugin's skill). Backspace at caret 0 removes
the last chip; ArrowLeft at caret 0 focuses the last chip, and on a chip the arrows move between
chips and back to caret 0, Backspace or Delete remove it. `onSend(text, skills?)` gets the
skills only when chips were picked, so `thread.sendMessage` carries `skills` and may have empty
`text` (the server refuses a message with neither). A queued message keeps its chips. Retry
sends the last user item's text and skills again (`lastUserSent`). A composer without
`providerKind` (the Assistant view) takes no skills. The composer on screen that takes skills
registers in `skillComposerStore` (`chat/composer-store.ts`), which feeds the palette's "Pick a
skill for the message" (inserts the trigger at the caret) and "Remove skill <name> from the
message" (`chat/skill-commands.ts`). A user item with `skills` draws them as `SentSkillChip`s
above its text; each opens a popover with the text sent (or the invocation) and the reason for
an attached built-in skill. Items without `skills` (older messages, `$name` in their text) are
drawn as before. New-thread starters add their skill as a chip (`ComposerHandle.addSkill`).

## Stored workflows

Before orchestrator threads, `packages/workflow-engine` ran a workflow as a run of steps with
gates, rules and a path, plan runs worked through a plan's units, and event triggers started runs
from pull request events. U8 removed all of it (orchestrator threads spec 34, 35): the engine
package, `packages/agent-os`, the runner, runs and their working copies, plan runs, the Plans
projection and its watcher, the host poller and its reads, and event triggers. A workflow is now
a file that a main thread follows (see "Workflows as text"), and a card starts a thread (see
"Scheduler and triggers").

What stays is data:

- **Stored workflows.** The `workflows` table and topic and `workflow.create|update|delete|
restore` stay, so a card made before workflows were files still names its stored workflow, and
  a setup file and the assistant still read and write them. `core/workflows.ts` checks a stored
  workflow as before (its steps, rules and gate conditions, and `workflows.alwaysStopSkills` for
  a step whose gate must wait for the user); nothing runs one. `ownWorkingCopy`, `forUnits` and
  `maxStepVisits` are kept on the row for the same reason.
- **Migration 0051** (`0051_runs_plans_and_event_triggers_removed`, tested in
  `db/runs-removed-migration.test.ts`). Events are never replayed, so what a removed kind wrote
  stays only where the migration leaves it. A step thread becomes an ordinary thread marked
  `done`. A card that followed a live run and has no thread becomes `stopped`, and a backlog item
  whose run was going goes back to `planned`. The run notifications, the events of the removed
  kinds (`workflowRun.changed`, `planRun.changed`, `plans.synced`, `hosts.synced`,
  `tickets.synced`, `pages.synced`, `trigger.eventSeen`, and `trigger.set` and `trigger.deleted`
  of event triggers), the assistant's changes and proposals of removed commands, the decision
  briefs and dismissals of failed runs, gates and limits, and the removed settings' rows are
  deleted. A `card.runNow` proposal names `threadId` instead of `runId`. The tables
  `workflow_runs`, `plan_runs`, `plan_intents`, `host_reads`, `change_requests`, `ticket_reads`,
  `page_reads` and `trigger_events` are dropped, `triggers` is rebuilt with card rows only, and
  `run_id` leaves `threads`, `calendar_items`, `card_occurrences`, `backlog_items` and
  `notifications`, with `step_id` from `threads`.

### A folder's changes

`apps/server/src/workflows/changes.ts` (agent workbench spec 34, 35) compares a chat thread's
folder with the commit it was on at its first turn (`readRunBase`, kept as the thread's `baseSha`
and `baseFiles`). What changed is always the folder as it is now against that commit, so
committed and uncommitted work both show. wow makes no commits of its own, so "what changed in
this turn" comes from content hashes: `FileHash {path, hash}` for each file that differed from
the base when the turn began (SHA-256 of the file in the folder, null when it is gone or a folder
on its path is a link; a link is hashed as its target path and never followed; a file over
`diff.maxHashBytes` is hashed as its size and modification time). The size a file shows is read
the same way, so a link never gives the size of what it points at.

`threads.diff` answers `RunDiff {status, message, baseSha, files, omitted, patch}` (the types keep
their names from runs). `status` is `ok`, or why there is nothing to compare: `folderMissing`,
`noRepository`, `gitUnavailable` (asked from the folder first, so they win), `noBase`,
`baseMissing` (the commit is gone) or `failed` with git's message. Each `RunDiffFile` has `path`,
`oldPath` (renames), `status` (`added`, `modified`, `renamed`, `deleted`), `added` and `removed`
line counts, `size` (in the folder, or in the base for a deleted file) and `content` (`text`, or
`binary` / `tooLarge` for a file that shows status and size only: binary by git's own test, too
large when over `diff.maxFileBytes`). The list is sorted by path and cut at `diff.maxFiles`, with
`omitted` saying how many were left out. Without `path` no content is sent. With `path` the
answer holds that one file and its unified diff from the first hunk on; the path is only looked
up among the files git listed, so it cannot name anything else. A new file git does not track yet
has no diff of its own: its lines are read and sent as added lines. A rename shows only when git
sees it (committed or staged); a file moved without telling git lists as one deleted and one
added file. See "Edits, approvals and a thread's Changes" for the tab.

### Working copies

`apps/server/src/workspaces` (thread work spec 10 to 18). A chat thread can work in a Git
worktree of its project's repository instead of the project folder, on a branch of its own (see
the next section). A worktree, not a clone, because it needs no credentials and no second
download. `WorkingCopy {path, state, startSha, defaultBranch, note, unpushed, error, branch,
branchStart}` on the thread is the only state.

The git commands are in `projects/git.ts` beside the reading ones and run the same way: hooks
and the file system monitor off, no prompt, and `core.longpaths` on for the worktree commands.
Their time limit is `workspaces.gitTimeoutMs`, since a fetch takes longer than a read. A copy's
start commit comes from `defaultBranch`: with `workspaces.fetchBeforeCreate` on it fetches the
primary remote first (`git fetch --no-tags --no-recurse-submodules <remote>`, which only moves
the remote-tracking branches of the project's repository), finds the default branch
(`refs/remotes/<remote>/HEAD`, else what the remote answers to `ls-remote --symref` after a fetch
that worked, else `main` or `master` if the remote has one) and takes the remote branch's tip
after a fetch that worked. Otherwise it is the local branch of that name, then the tip as last
fetched, then the commit the project folder is on, and `note` says which and why ("Fetching
origin failed (…), so the working copy starts at the local tip of main."). The project folder's
files, index and branch are never touched. `settleWorkingCopy` counts what would be lost before a
copy goes: files `git status` lists (changed, staged or new), ignored files (every file inside an
ignored folder counted, read with `--ignored=traditional --untracked-files=all`: git keeps
nothing of them, and an agent's local file may be the only copy) and commits no branch reaches.
With none, `git worktree remove` without `--force` removes the folder (git itself refuses if
something is there after all); otherwise the copy is `kept` with what it holds. A removal that
fails, for example a file locked on Windows, is not retried: the copy is `kept` with the reason
in `error`. wow installs nothing in a working copy and runs no command the repository declares;
that is the agent's work. A project folder that is a subfolder of its repository gets the whole
repository as its working copy, with the copy's root as `cwd`.

### A chat thread's own working copy

Thread work spec 10 to 18. A chat thread in a project whose folder is in a Git repository can
work in a worktree of its own, on a new branch, with the project folder untouched
(`workspaces/working-copy.ts`, `projects/git.ts`, see "Working copies"). The copy is on a
branch because a pull request (thread work U4) needs one, so its commits are kept by the branch,
and settling and removal ask only about files.

- **The draft.** `/chat/new` asks `threads.workingCopyPlan {projectId}` when the project
  changes: `ok` with the project's `chat.ownWorkingCopy` (the switch's start),
  `chat.workingCopyBranch`, `chat.workingCopyStart`, the branch and commit the copy would start
  from as this computer knows them now and whether a fetch comes first; else `unavailable` and
  no switch (a folder without a project, not in Git, no commit). It reads only. The line under
  the switch names the branch with `branchName(template, title, threadId)` from contracts, filled
  as the user types from `firstMessageTitle` (the first line, else the skill chips' names, else
  "Image"), the same title `thread.create` gets; the draft's thread id is chosen up front, so the
  name shown is the name made. `branchName` slugs the title (32 characters at most, accents off), takes 6 hex of the
  thread id's SHA-256 (`sha256Hex`, in contracts because the browser's digest is asynchronous),
  and cleans each part of the name to what `git check-ref-format --branch` takes. Two threads'
  names differ in their lower-case id, so they differ without case too, as Windows refs stored
  as files need; when 6 characters of two ids agree the server lengthens the id.
  `DraftState.ownWorkingCopy` holds the user's pick; palette `chat.draft.ownWorkingCopy`.
- **Named at create.** `thread.create {ownWorkingCopy: true}` (refused without a project and with
  `resumeSessionId`: a provider session belongs to its folder) makes the thread with
  `cwd` = `<workspaces.root>/<project slug, 16 characters>-t<8 hex of the thread id's SHA-256>`,
  `branch` and `workingCopy {state: 'pending', branch}` (`core/thread-copy.ts`). Since `cwd` is
  the copy, the thread's Changes, files, `@`, Open in editor and the agent's turns work there
  with no change of theirs.
- **Made before the first turn.** The provider service awaits `Workspaces.prepareThread` before
  a chat turn goes out, before the Changes base is read, inside the same prepared start, so a
  stop or other command sent for the thread meanwhile still reaches the provider after the
  start. A copy never made gets
  `createThreadWorkingCopy`: the project folder must be a repository with a commit, git must
  take the branch name (`checkBranchName`), the commit is the project folder's (`head`) or the
  default branch's tip (`defaultBranch`, with `workspaces.fetchBeforeCreate` and the
  same `note` when it is not the fetched tip), and `git worktree add -b <branch> <path> <commit>`
  (`addNewBranchWorktree`) makes it. `thread.workingCopyReady` stores `ready`, `startSha` and,
  in `defaultBranch`, the branch the start commit was read from. When it cannot be made, the
  reason (git's own: "fatal: a branch named … already exists"; runGit now prefers git's
  `fatal:`/`error:` line over what it said before it) goes in `thread.workingCopyFailed`, the
  turn fails with it and the provider gets nothing. Right before git is asked to make the branch
  (only when no branch of that name exists), `thread.workingCopyBranching {threadId, startSha}`
  stores the start commit as `WorkingCopy.branchStart`: from then on the branch is wow's own.
  `worktree add -b` makes the branch before the folder and leaves it when the folder then fails
  (a folder already there, a path too long, a locked file, a server stop). The branch is never
  deleted: the next try finds it, and when it is at `branchStart` and never moved (one entry in
  its reflog) it takes it up with `git worktree add <path> <branch>` (the copy then starts at
  that commit, with a note when the start commit has moved since). With the reflog switched off
  (`core.logAllRefUpdates=false`) or expired, git's left branch has no entry, is not known as
  wow's and is not taken up: Retry fails with git's reason until the user deletes the branch. Any
  other branch of that
  name, one that was there before the thread above all, is the user's: git refuses it and that
  is the reason. When git fails without making the branch, `thread.workingCopyBranching` with
  `startSha: null` clears `branchStart`, so a branch of that name the user makes later at the
  same commit (a fresh branch also has one reflog entry) is not taken for wow's. Nothing falls
  back to the project folder.
- **Again on its branch.** A message to a thread whose copy is `removed` (or whose folder went)
  makes it again with `git worktree add <path> <branch>` (`reopenThreadWorkingCopy`); a folder
  that is already there on the branch (a fork made it first) is taken as it is. A deleted branch,
  or one another folder is on, fails the turn with git's reason. A `kept` copy simply becomes
  `ready` again.
- **Settled at done.** On `thread.stateChanged` to `done`, once every thread whose
  `workingCopy.path` is that folder is done and none has a running turn, `settleWorkingCopy`
  with the thread's `branch` removes it when no uncommitted, untracked or ignored file is in it
  and no commit was made on no branch, else keeps it with what it holds. Commits on a branch are
  counted for the chip but do not keep it. `readThreadHolds` adds `commitsOnNoBranch` to
  `readUnpushed`: commits HEAD of the copy has been on (HEAD and its reflog) that no branch, tag
  or remote reaches and that are not in the reflog of the thread's branch or the one the copy is
  on (`countCommitsOnNoBranch`), so a commit made with HEAD detached keeps the copy, and one
  amended or reset away on the branch does not. The outcome goes to every thread that shares the
  folder as `thread.workingCopySettled`. While a settle or a removal runs, `prepareThread` for
  the folder waits for it and reads the row again, so a turn never starts in a folder that is
  going.
- **Remove working copy.** `threads.workingCopyStatus {threadId}` answers what it holds now
  (`readThreadHolds`); the dialog shows that, commits on no branch among what is lost, and
  confirms with "Remove and lose them", or a plain "Remove" when nothing would be lost.
  `threads.removeWorkingCopy {threadId, expect}` reads again and is refused with `conflict` and
  the new counts as the error's `data` when more files or commits on no branch are there than
  `expect`, or when the server read a `digest` and `expect` carries none, and with `rejected`
  while a turn runs (checked again right before the removal) or
  another thread that is not done works in the folder. `readThreadHolds` also answers `digest`,
  a SHA-256 of git's status listing (every changed, new and ignored file with its state, each
  file inside an ignored folder named on its own) and of
  the commits on no branch; when `expect` carries one and it differs, the removal is refused with
  `conflict` too, so one file swapped for another after the dialog opened is noticed. A file
  edited again with the same state is not (the listing names paths, not contents). Then `git worktree remove
--force`; the branch stays. wow never deletes a branch and never pushes here.
- **Forks.** A fork takes its origin's `cwd`, `branch` and `workingCopy`.
- **Restart.** `recover()` takes a `pending` copy whose folder git finished on its branch as
  ready. A `pending` copy with `branchStart` (git was asked to make it) fails ("The server
  stopped while the working copy was being made"), its folder goes with `git worktree remove
--force`, its branch stays, and the next message takes the branch up; when the stop came before
  git made the branch, `branchStart` is cleared too. A `pending` copy without
  `branchStart` was never started (no message went out yet) and stays `pending`. Nothing here
  deletes a branch. A `ready` copy of a done thread is settled.
- **Web.** `chat/working-copy.tsx`: `DraftWorkingCopy` (switch and line), `WorkingCopyChip` in
  the thread header (branch and "own working copy", or what a kept copy holds),
  `WorkingCopyDetails` in Details (branch, folder with Copy path and Open in editor, where it
  started, the note, the state and Remove), `RemoveThreadCopyDialog` and `threadCopyStore`, and
  `workingCopyCommands` (palette `chat.removeWorkingCopy`, `chat.copyWorkingCopyPath`). Threads
  stored before have `workingCopy` null and work as they did.

## Scheduler and triggers

A local card with a workflow has one trigger, id `<cardId>:trigger`, at its start
(`core/triggers.ts`); a repeating card's trigger waits at its next occurrence instead (see
"Repeating cards" below). The workflow is a workflow file by its name (`CalendarItem.workflowName`,
see "Workflows as text"); a card made before workflows were files names its stored workflow in
`workflowId`, and that workflow's name is the file the one-time export wrote. A project is not
needed. `card.create` and a `card.update` that changes the start, zone, project or workflow bring
the trigger in line: a start in the future makes it `scheduled`, a start already past makes it
`missed` with `offerRunNow` (the user placed the card in the past, so it is not run on its own),
and a card without a workflow cancels it. A card that has started a thread keeps its fired
trigger. Every change is one `trigger.set` event with the whole row; the card's `threadId` holds
the thread its trigger started last.

`Scheduler` (`apps/server/src/scheduler/service.ts`) is started last by `startServer` and stopped
first. Every `scheduler.tickSeconds` it dispatches `trigger.fire {triggerId, runAt, threadId}` for each
`scheduled` trigger whose `runAt` has passed; the orchestrator ignores a trigger that is no longer
scheduled at that time, so a moved card or a repeated tick fires nothing. At start, and when
`scheduler.paused` turns off, it dispatches `trigger.applyMissed {policy}` for the due ones instead:
`run` fires them, `mark` sets the trigger `missed` with `offerRunNow`, `skip` sets it `missed`
without; the card shows `missed` in both. While paused nothing fires. `startServer({clock,
schedulerTimers})` lets tests move time and call `scheduler.tick()` themselves.

**Scheduled jobs as main threads** (orchestrator threads spec 27, 28). Firing starts a main
thread. `trigger.fire`, `trigger.applyMissed` and `card.runNow` are decided in
steps (`decideTriggerInSteps`, like the helper commands): first the trigger, occurrence and card
events, then `thread.create` and `thread.sendMessage` as the user would send them, each on what the
step before left. `core/card-threads.ts` decides what to start:

- `CalendarItem.threadMode` `new` (the default, and what the migration gives every card) makes a
  new main thread per occurrence, titled with the card and the occurrence's day
  (`Morning review · 2026-11-04`; a single card's thread has the card's title). Its id is the
  command's `threadId`. Its instance, model, effort and permission mode come from
  `chat.defaultInstance` and `chat.defaultModel`, then the project's defaults, then the instance's.
  It works in the project's folder, or in a folder of its own in wow's home without a project.
- `same` sends the next occurrence as the next message in the card's one thread
  (`CalendarItem.threadId`). An occurrence that finds that thread still working is recorded
  `skipped` with the reason and a `skipped` notification "Occurrence skipped".
- The message is the card's notes, or its title without notes, with the workflow as the picked
  skill (`{name, source: 'workflow' | 'project-workflow'}`), so the server sends it inside
  `workflows.followTemplate` with the project's file of that name first.
- A thread that cannot start (no workflow file of that name, no provider instance, no model)
  fires the trigger without a thread and fails the card or the occurrence with the reason,
  instead of retrying every tick.

The card follows its thread: `CardFollower` (`scheduler/card-follow.ts`) watches commits with a
turn starting or ending, an approval, a question or a thread item, and asks every card that
follows a thread to look again with `card.followThread`. `cardStateOfThread` gives `waiting` while
the thread waits for the user or a gate card in it is open (spec 14), `running` while a turn runs,
and `done`, `failed` or `stopped` by how the last turn ended. A card whose state is the same
commits nothing, so the follower never feeds itself. Deleting a card leaves its threads.
`card.runNow {cardId, threadId}` starts the thread at once for a card that is not still working.

**Repeating cards** (recurring cards spec 1 to 21). A card can carry a repeat rule
(`RepeatRule` in `packages/contracts/src/repeat.ts`): `frequency` (`daily`, `weekly`,
`monthly`), `interval` (1 to 1000), `weekdays` (weekly only; empty means the start's weekday)
and `end` (`never`, `on` a day inclusive, or `after` a count of at most 10 000 that includes the
first occurrence). The bounds keep every occurrence a date `Date` can hold, and a series also
stops after 31 December 9999, so no rule can walk for ever; the card decisions check the rule
again for commands that did not come over the wire. Every card's zone must be one `Intl`
knows; a stored card whose zone it does not know is read on its UTC day rather than failing
the range read. It is wow's own structure, not an RRULE, so it can be said in words
(`repeatRuleWords`: "Every weekday at 08:30, until 19 December 2026") by the server and the app
alike. The card stays one row.

- **Occurrences are computed** (`apps/server/src/scheduler/occurrences.ts`, pure). The card's
  start and end are the first occurrence, on whatever weekday it falls. Every later one is on a
  day the rule names, at the same local start time and local length in the card's zone. Wall
  clock readings come from the platform's zone data through `Intl` (there is no Temporal on
  Node 22 and the server has no date library): `instantOf` turns a local reading into an
  instant, taking the first of a reading that happens twice and, for a reading in the hour the
  clocks skip, the instant they jumped (02:30 becomes 03:00). Monthly falls on the start's day;
  a month without it has none. `occurrences(series, from?)` is a generator in start order and never
  ends for `never` before year 9999, so every caller stops it by time or count. Given `from`
  (an instant or a day) it jumps to that day by day number before it asks Intl for anything,
  so a read far from the card's first day costs what a read near it does; an end after a count
  counts the days it passes without working out their times, and a day past the series' last
  one answers nothing at once.
- **What is stored**: the rule, the days skipped by hand (`skippedDates`), and per reached
  occurrence a `card_occurrences` row (`CardOccurrence`): `fired` with its thread, `failed`
  (the thread could not start), `skipped` (the card's `same` thread was still working) or
  `missed`, with a
  reason and whether it offers "Run now". Rows are keyed by card and day and outlive the card,
  so Undo of a delete brings the history back. The `calendarItems` topic carries each local
  card's records as `occurrences`; the stored row does not.
- **One trigger per card, re-armed.** `<cardId>:trigger` waits at the first occurrence after now
  that is neither skipped by hand nor reached (`nextOccurrence` in `core/series.ts`).
  Occurrences already past when a card is made or changed are not run. When it comes due,
  `trigger.fire` (and `trigger.applyMissed`) takes every occurrence from the trigger's time to
  now that is not taken: the older ones are recorded `missed`, and only the latest is handled —
  started by a tick or the `run` policy, recorded `missed` with "Run now" by `mark`, or
  `missed` by `skip` (spec 8); an older record that still offered "Run now" is re-recorded
  without it, so only the newest missed occurrence offers it. A latest occurrence that finds the
  card's `same` thread still working is `skipped` (see above). Then the trigger
  waits for the next occurrence; after the last one it is `fired` (or `cancelled` when nothing
  ever ran, and the card, still `scheduled`, becomes `done`: every remaining occurrence was
  skipped). The thread's title names the occurrence's day. The card follows its newest thread as
  a single card does. `card.runNow` on a repeating card answers the occurrence that offers
  "Run now" and leaves the trigger waiting. A card that ran and is made single again (or
  undone back to single) puts its trigger back to `fired`.
- **The next time** is `CalendarItem.nextAt`, set by the projector from every `trigger.set` of a
  card trigger (the trigger's `runAt` while `scheduled`, else null), so the card and the trigger
  list say the same. The migration fills it for cards stored before.
- **Changing.** `card.create` and `card.update` take `repeat` (null in an update makes the card
  single again) and `skippedDates` (the whole list; Undo of a skip and of a delete send it).
  Any change of time, zone, rule, project or workflow re-arms the trigger, so every occurrence
  not yet started follows it; records keep where the reached ones were and what they ran, and
  a range read shows a reached occurrence from its record even when the rule has moved on.
  Days without a record keep their place too (spec 10, 11): a change of start, end, zone or
  rule stores the series as it was in `CalendarItem.pastSeries` (`PastSeries`: the series and
  `until`, the first day it no longer sets), for the days before the first occurrence that has
  not started, or for a moved occurrence the days before its date. Entries are oldest first;
  each sets the days from the entry before's `until` to its own, and the card's series the days
  from the last `until` on. Days are in each entry's own zone, so after a change of zone a part
  also takes over only from the instant the `until` day began in the zone before: no day and no
  instant is set twice. A later change from an earlier day cuts the entries back to it. A card
  that stops repeating keeps only the entries for days that have started, and one that repeats
  again drops entries whose `until` is after its first day.
  `scheduleOf(card)` in `core/series.ts` is that schedule, and the trigger, the range read,
  skip and move all read it, so after a move the days before the moved one, past or still to
  come, keep their time. Cards stored before have none (`[]`). A
  single card that already ran and gets a rule records its run as the first occurrence.
  `card.skipOccurrence {cardId, date}` adds the day to `skippedDates` and is refused for a day
  the rule does not fall on and for one already started. `card.moveOccurrence {cardId, date,
start, end}` is a drag in the calendar (spec 11): the occurrence must stay on its day, and the
  series keeps its first day and takes the moved occurrence's local time and length from that
  day on. Deleting a series leaves its threads, as for a single card. The inverse commands (`assistant/changes.ts`) carry `repeat` and `skippedDates`, so one Undo
  restores a series with its rule, skipped days and trigger.
- **Reading a range.** `calendar.occurrences {from, to}` (`readCalendarRange`) answers
  `CalendarRange`: every occurrence of each local card overlapping the range (a card without a
  rule is its one occurrence), without the days skipped by hand, each with `repeating`,
  whether the trigger fires there `next`, and its `record`. At most `calendar.maxOccurrences`
  of one card are returned; a card that had more is listed in `more` (spec 17). The web app
  draws from this read and never works occurrences out itself.
- **The assistant** (spec 18 to 21). `create_card` and `update_card` take `repeat`;
  `skip_card_occurrence` sends `card.skipOccurrence`; `card.moveOccurrence` is refused for the
  assistant (it changes the time with `update_card`). A card's change row and proposal say the
  rule in words with its time (`Repeats` line). Whether a card waits for a yes looks at the
  next occurrence that is not taken, worked out by the scheduler's `nextOccurrence` over the
  card as the change leaves it, its past series included (`pastSeriesAfter` in
  `core/calendar.ts`), so a series moved from a later day is judged by when it fires next: a
  proposal when it starts within
  `assistant.startSoonMinutes` (or is past), ordinary otherwise, and ordinary for a series with
  nothing left to run. `read_calendar` lists for a repeating card its rule, the rule in words,
  `nextAt`, the skipped days and its occurrences in the range with what happened at them, and
  `read_triggers` shows the trigger's next time. The default instruction text says to make one
  repeating card for anything recurring and never a card per day.

**Event triggers** are gone (orchestrator threads spec 29): nothing starts from what a read from
the host shows. Migration `0048_cards_start_threads` deleted the stored event triggers and the
`triggers.*` settings; migration 0051 removed `trigger.create`, `trigger.setEnabled` and
`trigger.delete` with their events, dropped `trigger_events` and rebuilt `triggers` with card
rows only (see "Stored workflows").

Notifications are the server's channel to the user. While `scheduler.notifications` is on, the
orchestrator stores a `notification.sent` row when a trigger starts a thread ("Scheduled thread
started"), when an occurrence is skipped and when a trigger fails; ids derive from the card and
the occurrence, so a repeated transition notifies once. Clients read the `notifications` topic (newest first): the web app shows
the rows that arrive after its first snapshot as toasts for `scheduler.toastSeconds`, whose "Open"
action opens its `path`. The toasts are sonner's (`AppToaster` in `app/notifications.tsx`); the
same toaster carries the app's own feedback (see "Look"). Chat threads notify too, by
`chat.notifications` rather than `scheduler.notifications` (see "Chat view").

## Settings registry

`packages/contracts/src/settings.ts` exports `settingsRegistry`: a map of key → `{schema: zod,
group, label, description, default, scope: 'global'|'project'|'provider', restartRequired?,
secret?, unit?, options?, radio?}`. `unit` (`ms`, `seconds`, `minutes`, `days`, `pixels`,
`percent`, `bytes`) is shown as a suffix after a number field, so labels carry no unit;
`personal` (`account`, `machine` or `person`) keeps a value out of a setup file (see "Setup
file");
milliseconds are shown and typed as seconds, bytes as kilobytes. `options` names each enum value (`{label, description?}`), so the page
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
`WorkHours`, two time fields and a Mon–Sun toggle group, and the handover, send back and unit templates,
a text area whose `placeholders` meta lists the `{{name}}` chips it can insert). Objects
render their fields; anything else falls back to a JSON editor. Connected to a server, the web app
reads the `settings` topic and writes global values with `setting.set` / `setting.reset`
(`apps/web/src/settings/server-source.ts`); without one it uses the in-memory `SettingsSource`
from `packages/client-runtime`.

The settings below are the registry. `apps/server/src/settings/coverage.test.ts` reads this list:
a key named here and missing from the registry, or registered and missing here, fails the tests.
A group marked with a unit (`(U12)`) belongs to a unit not delivered yet; its keys must not exist
until that unit removes the mark. `group.*` covers every key of the group.

- providers: `providers.testTimeoutMs`, `providers.requestTimeoutMs`, `providers.updateTimeoutMs`,
  `providers.commandListSeconds`, `providers.offerSetup`, `providers.sessionListLimit`,
  `providers.sessionPromptChars` (see "Sessions started in a terminal" under "Projects")
- chat: `chat.contextMeter`, `chat.resumePrompt`, `chat.groupToolCalls`, `chat.toolOutputLines`,
  `chat.starterCount`, `chat.skillTrigger`, `chat.notifications`, `chat.finishedAfterSeconds`,
  `chat.threadTitleMaxLength`, `chat.threadSearchMaxLength`, `chat.editDiffMaxLines` (see "Chat
  view"), `chat.contextWarnPercent`, `chat.reasoningOpen` (see "Conversation reading"), `chat.fileTrigger` (see "Panel tabs and files in chat"), `chat.imageMaxBytes` (see
  "Images in the composer"), `chat.sendKey` (see "Chat view"), `chat.findMaxMatches`,
  `chat.exportReasoning` (see "Find in the conversation and copy it"), `chat.ownWorkingCopy`,
  `chat.workingCopyBranch`, `chat.workingCopyStart` (project-scoped, see "A chat thread's own
  working copy"), `chat.snapshots` (project-scoped), `chat.snapshotMaxFiles`,
  `chat.snapshotMaxFileBytes`, `chat.snapshotTimeoutMs`, `chat.snapshotReadsAtOnce`, `chat.snapshotKeepDays`,
  `chat.editRestoresFiles` (see "Restore files when going back"), `chat.defaultInstance`, `chat.defaultModel` (see "Main threads with the app tools"), `chat.instructions` (see "Assistant"), `chat.helperDepth`, `chat.helpersPerThread`, `chat.helpersLive`,
  `chat.helpersPerTree`, `chat.helperBranch`, `chat.mergeBrief`, `chat.helperAnswerMaxLength` (see "Helper tools in a chat session"),
  `chat.activityTextMaxLength` (see
  "Threads at work and a thread in the panel"), `chat.doneArchiveDays` (see "Thread list, unread and chat
  notifications"), `chat.toolImagesShown` (see "Tool rows, the task pin and copy"), `chat.limitWarnPercent` (see
  "Plan limits"), `chat.attachTextMaxBytes`, `chat.mentionMaxChars`, `chat.mentionHostItems`
  (project-scoped) (see "Images in the composer"), `chat.commitTimeoutMs`,
  `chat.pushTimeoutMs`, `chat.commitOutputMaxBytes`, `chat.proposalTimeoutMs`,
  `chat.proposalPatchMaxBytes`, `chat.commitMessageTemplate` and `chat.pullRequestTemplate`
  (project-scoped), `chat.pullRequestDraft` (project-scoped) (see "Commit and pull request from
  a thread's Changes")
- approvals: `approvals.alwaysAllow` (project-scoped; the "Approvals" page, see "Edits, approvals
  and a thread's Changes")
- calendar: `calendar.zone`, `calendar.firstDayOfWeek`, `calendar.workHours` (these three default
  to `outlook`, see "Outlook profile"), `calendar.showWeekends`, `calendar.weekMaxColumns`,
  `calendar.lookaheadDays`, `calendar.maxOccurrences` (see "Repeating cards"),
  `calendar.snapMinutes`, `calendar.cardMinutes`,
  `calendar.hourHeight`, `calendar.zoomStep`
- outlook: `outlook.pollSeconds`, `outlook.requestTimeoutMs`
- scheduler: `scheduler.tickSeconds`, `scheduler.missedPolicy`, `scheduler.notifications`,
  `scheduler.paused`, `scheduler.toastSeconds`
- workflows: `workflows.followTemplate`, `workflows.newTemplate` (see "Workflows as text"),
  `workflows.verdictApprovedLine`, `workflows.verdictChangesRequestedLine`,
  `workflows.verdictBlockedLine` (the lines the `wow-verdict` skill asks for, see "wow skills"),
  `workflows.alwaysStopSkills` (see "Stored workflows")
- skills: `skills.directories`, `skills.includeClaudePlugins`, `skills.builtInOff` (see "wow
  skills")
- trackers: `trackers.jira.baseUrl`, `trackers.jira.authMode` (`cloud-basic` or `pat`),
  `trackers.jira.email`, `trackers.jira.token` (secret), `trackers.jira.projectKey`,
  `trackers.jira.issueType`, `trackers.github.baseUrl`, `trackers.github.token` (secret),
  `trackers.github.owner`, `trackers.github.repo`, `trackers.github.labels`,
  `trackers.gitlab.baseUrl`, `trackers.gitlab.token` (secret; see "Hosts", GitLab),
  `trackers.confluence.baseUrl`, `trackers.confluence.authMode` (`cloud-basic` or `pat`),
  `trackers.confluence.email`, `trackers.confluence.token` (secret; see "Hosts", Pages),
  `trackers.requestTimeoutMs`, `trackers.gitTimeoutMs`, `trackers.jira.keyScanCommits` (the
  `trackers.jira.*`, `trackers.github.*`, `trackers.gitlab.*` and `trackers.confluence.*` ones
  are project-scoped, see "Backlog and trackers")
- hosts: `hosts.longestWaitMinutes`, `hosts.pageMaxBytes` (see "Hosts")
- viewer: `viewer.maxFileBytes`, `viewer.htmlScripts`, `viewer.highlightMaxBytes`,
  `viewer.fileListLimit`, `viewer.fileMatchesShown` (see "Files" and "Panel tabs and files in
  chat"), `viewer.editorCommand`, `viewer.editorShell` (see "Open in editor" there)
- diff: `diff.maxFileBytes`, `diff.maxFiles`, `diff.maxHashBytes` (the "Changes" page, see "A folder's changes")
- workspaces: `workspaces.root`, `workspaces.fetchBeforeCreate` (project-scoped),
  `workspaces.gitTimeoutMs` (the "Working copies" page, see "Working copies")
- assistant: `assistant.greeting`,
  `assistant.startSoonMinutes`, `assistant.diagnosisLimit`, `assistant.valueLength`,
  `assistant.secretPatterns`, `assistant.askRefusedWords`, `assistant.modelGuidance`,
  `assistant.notes`, `assistant.excludedProjects`, `assistant.readMaxBytes`,
  `assistant.readMaxMessages`, `assistant.delegation`,
  `assistant.permissions`, `assistant.followTurns`, `assistant.maxDelegatedLive`,
  `assistant.briefsPerDay`, `assistant.briefings`, `assistant.briefingsPerDay`,
  `assistant.briefAfterMeetingMinutes`, `assistant.briefAfterIdleMinutes`,
  `assistant.remindAfterMinutes` (see
  "Assistant", "Question card" and "Models for steps")
- appearance: `appearance.theme`, `appearance.uiFont`, `appearance.codeFont`, `appearance.density`,
  `appearance.paletteRecent`, `appearance.contextPanel`, `appearance.contextPanelWidth`
- keybindings: `keybindings.*`, one per command that has a shortcut
- desktop: `desktop.autostart`, `desktop.closeToTray`, `desktop.startMinimized`
- updates: `updates.enabled`, `updates.checkIntervalMinutes`
- advanced: `advanced.port`, `advanced.logLevel`, `advanced.secretsTimeoutMs`,
  `advanced.gitStopWaitMs` (see "Git" under "Projects"),
  `advanced.setupFileMaxBytes` (see "Setup file"), `advanced.showSettingKeys` (`WOW_HOME` is an
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
over the store. On Windows the rename is refused while another program has the store open (a
virus scanner, or a wow server that is still closing during a restart), so the write tries again
with growing pauses for up to `advanced.secretsTimeoutMs` before it fails. Settings marked `secret` store a reference `{secretRef}`, never the value; the
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
`settings` topic. Notifications use Electron's `Notification`. They come from the
`notifications` topic (rows with a `threadId` stored after the first snapshot, `chatNotices`;
`chat.notifications` decides on the server which are stored), are not shown while the
focused window shows that thread (`DesktopShell.focusedRoute`), and a "Needs you" for an approval
carries Allow once and Deny buttons that dispatch `approval.answer`. Electron draws those buttons
on macOS; Windows shows them only with a toast template, which wow does not build yet, so there
the click, which opens the thread with the approval focused, is the way to answer. A single-instance lock makes a second launch show the running window.

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
or waiting on the user (from the `threads` topic), a dialog says so and the user decides, because the restart ends those turns as failed.
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
and `symbolic-ref --short HEAD`, with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `GIT_OPTIONAL_LOCKS=0`
(`gitEnvironment`), so nothing waits for credentials (no terminal prompt, no Git Credential
Manager window on Windows) or takes a lock, and `trackers.gitTimeoutMs` as the limit. A git
that runs out of time, or writes more than 4 MB, is stopped with its whole process tree on Windows
(`taskkill /T /F`, `projects/stop-process.ts`): Git for Windows' `cmd\git.exe` starts the real
`git.exe` and waits for it, and killing only the wrapper would leave the real git running with the
folder as its working directory, which holds the folder. The answer then waits for the stopped git
to be gone, but no longer than `advanced.gitStopWaitMs`; the same goes for `files.list`. Without git on the
PATH it reads `<folder>/.git/config` and `HEAD` itself (`gitUnavailable` when that fails too). A
folder that is gone is `folderMissing`. `parseRemoteUrl` reads https, ssh://, git:// and scp-like
`user@host:path` remotes and local paths, drops user names and passwords from https URLs, and
names a GitHub repository for `owner/repo` paths: github.com (also `ssh.github.com`) gives
`https://api.github.com`, `<name>.ghe.com` (GitHub Enterprise Cloud with data residency) gives
`https://api.<name>.ghe.com`, any other host is taken as GitHub Enterprise Server with
`https://<host>/api/v3`; deeper paths (GitLab subgroups), local paths and known other hosts
(GitLab, Bitbucket, Azure DevOps, Codeberg) give none. The primary remote is `origin`, else the
first GitHub one, else the first. `projects.git` answers `ProjectGit` for every project
(`{projectId, status, remotes, primary, branch, message, codeHost}`; `codeHost` is `gitlab` when
the primary remote is on the stored GitLab site, the rule wow picks a host adapter by, else
`github`); it is read on demand, not projected,
because it is live I/O on the user's files. `guessJiraKeys` counts distinct `KEY-123` references
in the branch names and the last `trackers.jira.keyScanCommits` commit messages (`git log
--format=%s%n%b`), skipping look-alikes such as `UTF-8` and `SHA-256`.

Every git command also runs with `-c core.hooksPath=<null device>` and `-c core.fsmonitor=false`,
so no hook or file system monitor a repository's config names is started, with
`core.quotePath=false` and `GIT_LITERAL_PATHSPECS=1`, so a file name is read and passed as it is.
The commands for a run's changes are read-only too: `readHeadCommit` (`rev-parse --verify
HEAD^{commit}`), `listChangedPaths` (`cat-file -e` for the base, then `diff --name-status -z` and
`diff --numstat -z` against the base with `-M`, or `--no-renames` for the hash lists, plus
`ls-files --others --exclude-standard -z` for new files git does not ignore), `readPatch` (`diff`
for one file) and `readBaseSizes` (`ls-tree -l`, at most 100 paths per command). The diffs run
with `--no-ext-diff --no-textconv`, so no program from the repository's config runs, and with
`--relative`, so a project that is a subfolder of its repository sees its own files. No option
turns off line-ending conversion: git converts the working file the way a commit would before
it compares, so a file saved with CRLF under `* text=auto` differs only where its text does.
With optional locks off the index is not refreshed on disk, and nothing is added to the object
store.

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

**Sessions started in a terminal** ("Open session from Claude Code / Codex…", agent workbench spec
72). The adapter packages read their CLI's session files the way discovery does, one
`ProviderSession {id, cwd, firstPrompt, lastUsedAt}` per file: `listClaudeSessions(configDir,
{limit, promptChars})` in `packages/provider-claude/src/sessions.ts` takes
`<configDir>/projects/*/<id>.jsonl` (the file name is the id `resume` takes; `agent-*` subagent
transcripts are left out), the first `cwd` of the file, and as first prompt the first `user` line
that is the user's own text (not `isMeta`, not a subagent's, not a tool result; a slash command
reads as its name and arguments from Claude Code's `<command-name>` markup, and a line or text
block that starts with one of Claude Code's own tags, such as an IDE's `<ide_opened_file>` or
`<ide_selection>`, is skipped, while other text starting with `<` is the user's; each text block
of a line is judged on its own);
`listCodexSessions(codexHome, …)` in `packages/provider-codex/src/sessions.ts` takes every
`<codexHome>/sessions/**/*.jsonl`, the `session_meta` id and `cwd` (older rollouts: the top-level
fields, else the id in the file name) and as first prompt the first `user_message` event, else the
first user message that is not one of Codex's own notes (`<environment_context>`,
`<user_instructions>`, `# AGENTS.md instructions`, `<INSTRUCTIONS>`; a user message after such a
note replaces an earlier one, which was an unknown note), taken once a response item other than a
message, or an assistant message (an answer, reasoning, a tool call or its output), follows it;
developer and system messages among the notes do not end the read. Only the
newest `providers.sessionListLimit` files by modification time are opened (more when wow's own
threads hold some of them, see below), each read line by line and closed once the first prompt is
known; a file without a prompt is read to its end. The prompt is cut to
`providers.sessionPromptChars` (`cutSessionPrompt` in contracts).
`apps/server/src/providers/sessions.ts` (`listTerminalSessions`) asks every instance (or the one
`provider.listSessions {providerInstanceId?}` names) with its config directory or the default one,
reads a config directory once when two instances share it, drops relative folders, and answers
`TerminalSession` rows newest first. wow's own threads write to the same files, so it asks for
`providers.sessionListLimit` plus the number of threads of that provider kind that hold a session,
and keeps up to the limit of sessions no wow thread holds and those wow sessions that are among the
newest limit. A folder gets one spelling (the project's, else the first seen), so the dialog groups
`C:\Work\Kettle` and `c:\work\kettle` together. Each row is the session plus its instance, the
`projectId` whose folder it is (compared as discovery compares folders), the `threadId` of a wow
thread whose `providerSessionId` it already is on an instance reading the same config folder, and `unavailable: "Its folder is gone"` when the
folder no longer exists. Nothing is written and nothing is cached: the CLIs write these files while
wow is not looking, so the list is read each time the dialog opens. The web app's
`chat/terminal-sessions.tsx` (`TerminalSessionsDialog`, palette `chat.openSession`, layout
`sessionDialog`) lists them per folder (`sessionsByFolder`, project name first), each with its first
prompt ("No prompt" when there is none), provider, instance and time; a gone folder's session is
greyed and cannot be picked. A pick opens the thread that already resumes it, or dispatches
`thread.create` with `resumeSessionId`, the session's folder and project, the title from its first
prompt and the start a new thread there would get (`threadDefaults`), then opens it. The server
stores `resumeSessionId` as the thread's `providerSessionId`, so the first message goes out with it
as `resumeId` like any later turn; `forkFrom` and `resumeSessionId` together are refused, and so
is a `resumeSessionId` another thread already goes on with on an instance of the same kind reading
the same config folder (an instance on the default folder counts as reading any), since two threads
would write to one session file. Folders are compared with the same key as the session listing
(`files/folder-key.ts`: resolved, and case-folded on Windows and macOS).

**New thread defaults** (agent workbench spec 97). A project holds `defaultProviderInstanceId`,
`defaultModel`, `defaultEffort` and `defaultPermissionMode` (the last two since migration
`0033_project_thread_defaults`; absent or null in older rows), set in Settings → Projects with
"Thread defaults" or the palette's "New thread defaults for project …" (`project.update`). A new
thread in the project picks that instance unless the draft picked another, and on it starts with
the project's model, effort and mode over the last thread's and the instance's (`threadDefaults`
in `chat/new-thread.tsx`); a model the instance does not list is not used.

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

## Hosts

wow reads pull and merge requests, Jira issues and Confluence pages through host adapters
(review loop spec 26 to 35). Since orchestrator threads U8 nothing polls them: an item a chat
thread links to is read when its tab opens and on Refresh now (see "Host links in chat"), and a
thread's own pull request is read and opened from its Changes (see "Commit and pull request from
a thread's Changes"). The plan reads, the run reads, the host poller and the `host_reads`,
`change_requests`, `ticket_reads` and `page_reads` tables went with runs and plans (see "Stored
workflows"). Reading is all the adapters do apart from opening a thread's pull request: nothing
is merged, approved or commented on.

**Types** (`packages/contracts/src/hosts.ts`). `ChangeRequest` is a pull request as read:
number, title, link, `state`, `draft`, `mergedAt`, head branch and commit, `fromFork` (the head
is in another repository: GitHub's `head.repo.full_name` is not the base repository's, or
`head.repo` is null for a deleted fork; GitLab's `source_project_id` is not `target_project_id`;
an answer that leaves them out counts as a fork), `checkState` with every check (`HostCheck`:
name, state, link), the review comments (`ReviewComment`: author, text, file, link),
`newestCommentId` and the web addresses of its body (`links`). `HostError` is `notSetUp`,
`refused` or `failed`, a sentence, the setting to look at, and when it was first seen.
Orchestration and the UI see only these; what a host calls things stays in its adapter.

**Adapter** (`apps/server/src/hosts/adapter.ts`, `github.ts`). `HostAdapter` reads with
`findForBranch(branch)` (the newest pull request whose head is the branch,
`GET …/pulls?head=<owner>:<branch>&state=all`), `read(found)` and `readIssue`, and opens one for
a thread with `openChangeRequest`.
The GitHub adapter uses the tracker client's HTTP helper (`trackers/http.ts`) and the project's
GitHub tracker settings as `trackers/resolve.ts` resolves them, so Enterprise Server is the same
code under `https://<host>/api/v3`. For a pull request it reads the pull request itself when the
search did not say where its head is, check runs and commit statuses of the head commit (both,
because Enterprise Server versions differ; an endpoint that answers 404, 410 or 501 means no
checks from it), and the review comments. Failed, timed out, cancelled and action-required check
runs and failed or errored statuses are failing; anything not completed is pending. 401 and 403
are `refused` and name the GitHub token setting, as does 404 on the repository (a token without
rights gets that); a used-up request limit, any other status and a timeout are `failed`. The
token goes into the `Authorization` header and nowhere else: not into an error, a row or a log
line. What the host answers is not trusted: a link is kept only when it is an http or https
address (a pull request without one is left out, as is a comment; a check keeps its name and
loses the link), a pull request number must be a positive integer and a comment must have an
id. A `Retry-After` or reset that gives no valid date is ignored. GitHub's
`x-ratelimit-remaining`, `x-ratelimit-reset` and `retry-after` headers leave a host that refused
for the limit alone until the limit starts again, but never longer than
`hosts.longestWaitMinutes` (a host may ask for a wait of years; `waitBound` in
`hosts/adapter.ts` cuts it for every host adapter). `hosts/mock-github.ts` is the invented host
the server tests and the e2e server share.

**GitLab** (review loop spec 34; `hosts/gitlab.ts`, `trackers/gitlab.ts`). A project is on
GitLab when its primary git remote is on the host of the stored `trackers.gitlab.baseUrl`
(`gitLabProjectOf` in `projects/git.ts`; any host can run GitLab, so the remote alone never
decides, and a site under a sub-path has that prefix cut from its https remotes; an https remote
on the same host outside that sub-path is not the site's). The project path keeps every nested
group (`git@gitlab.example.test:group/sub/app.git` is `group/sub/app`) and goes to the API
URL-encoded as one project id (`group%2Fsub%2Fapp`). API v4 under `<site>/api/v4`, with the
token in the `PRIVATE-TOKEN` header and nowhere else: GitLab requests do not follow redirects
(fetch would carry that header to another origin), and a 3xx answer is `failed` and asks to check
the URL. Merge requests fill the role of pull requests: a branch's is the newest with
`source_branch=<branch>`. `iid` is the number, shown as `!12` (`changeRequestRef`,
`changeRequestName` in contracts); `opened` is open, `merged` merged, `closed` and `locked`
closed; `draft` (or `work_in_progress` before version 14). Checks are the jobs of the newest
merge request pipeline on the head commit (`…/merge_requests/<iid>/pipelines`, then
`/pipelines/<id>/jobs`); a merged-results or merge-train pipeline runs on a merge commit, so when
no listed pipeline has the head's sha the merge request's own `head_pipeline` is taken, while the
merge request is still at that head (`GET …/merge_requests/<iid>`): failed and canceled jobs
fail, a failure the job is allowed passes, skipped and manual jobs are left out, anything still
to run is pending, and a pipeline without jobs counts as one check. A failed, canceled or running
pipeline whose listed jobs show no failure or nothing pending (a child pipeline, a job past the
first page) adds a `pipeline <id>` check with its own state, so it never reads as passing. 403,
404, 410 and 501 there mean no checks (CI off). Notes are the review comments, without GitLab's
system notes, linked as `<merge request>#note_<id>`. 401 and 403 are `refused` and name
`trackers.gitlab.token`, as does 404 on the project; a 429 with `Retry-After`, or
`RateLimit-Remaining`/`RateLimit-Reset`, leaves the site alone like GitHub's limit; anything
else and a timeout are `failed`. `TrackerService` caches each project's `ProjectGit.codeHost`
(`codeHost(projectId)`, read at start, when a project is made or moved and when a GitLab site is
stored) for the assistant's wording. GitLab issues are not read. `hosts/mock-gitlab.ts`
(`MockGitLab`) is the invented GitLab the server tests and the e2e server share.

**Tickets** (review loop spec 33; `hosts/jira.ts`, `hosts/jira-wiki.ts`). Jira (Cloud, Server and
Data Center) is the ticket host. A key is asked for with
`GET <base>/rest/api/2/issue/<key>?fields=summary,status,assignee,issuetype,description` (v2
because Server and Data Center accept it), signed in the way a publish is (`pat` or
`cloud-basic`, `jiraAuthorization` in `trackers/jira.ts`, settings from
`TrackerService.jiraHost`). The Jira site is always a stored setting, never a git remote, so the
token goes only there. The adapter (`TicketAdapter`, `createJiraHost`) answers a `Ticket`: key,
summary, status, assignee, type, the description turned from wiki markup into markdown
(`jiraToMarkdown`: headings, emphasis, monospace, lists, tables, quotes and code blocks; colours
and panels lose their frame, pictures become `[picture: <name>]` and are never loaded, a link
stays a link only for an http, https or mailto address, HTML stays text) and the
`<base>/browse/<key>` link when that is a web address. 401 and 403 are `refused` and name
`trackers.jira.token`, as is 404 ("shows no issue <key> to the Jira token"); a 429 with
`Retry-After` leaves the site alone for that token until then; anything else and a timeout are
`failed`.

**Pages** (review loop spec 35; `hosts/confluence.ts`). Confluence (Cloud, Server and Data
Center) is the page host, and only pages something links to are read: no search, no spaces, no
attachments, and pages are never given to agents. `confluenceLinksIn(text, baseUrl)` keeps an
address only when it has the stored `trackers.confluence.baseUrl`'s scheme, host, port and path,
and names a page: `/pages/viewpage.action?pageId=<id>` and `/spaces/<space>/pages/<id>/…` by id
(`ref` `id:<id>`), `/display/<space>/<title>` by title (`title:<space>/<title>`, `+` read as a
space). `webLinksIn` keeps brackets an address opens and closes itself (`Plan+(draft)`), ends an
address at one it did not open (a markdown link's own `)` or `]`), and leaves out one it opens
and never closes; it reads each character of the text once, so a long text without spaces costs
no more than its length. Links to another site are dropped before anything is asked, so the
Confluence token never goes anywhere but the stored site. A page is asked for with
`GET <base>/rest/api/content/<id>?expand=body.view,version,space` or
`GET <base>/rest/api/content?spaceKey=<space>&title=<title>&expand=body.view,version,space`
(the first result; none is a missing page), signed in with a bearer token (`pat`) or email and
API token (`cloud-basic`, `jiraAuthorization`), with redirects turned down. The adapter
(`PageAdapter`, `createConfluenceHost`) answers a `Page`: content id, title, space key, version
and the body as Confluence renders it (`body.view`, HTML), and the page's address made from the
stored site and the answer's `webui` path. The HTML is never rendered in the app: only the
viewer's sandboxed frame shows it. 401 and 403 are `refused` and name
`trackers.confluence.token`. 404, or no result for a title, is `refused` for that page only and
names no setting ("shows no page <id> to the Confluence token … may have been deleted or
moved"): the token works, so the link is what to check; a 429 with `Retry-After` leaves the site
alone until then; anything else and a timeout are `failed`. A body larger than
`hosts.pageMaxBytes` (UTF-8 bytes) is not kept: that page fails (`failed`, naming the setting).

## Assistant

Behavior lives in `intents/2026-11-app-assistant/spec.md`. The assistant is a chat whose agent
can only use wow's own tools. This section covers the server side of those tools, the
assistant thread and the Assistant view.

**One MCP server on the wow port.** `apps/server/src/assistant/mcp.ts` answers
`POST http://127.0.0.1:<port>/assistant/mcp` with MCP's Streamable HTTP transport, without
sessions and in plain JSON, through the official `@modelcontextprotocol/sdk` (its `Server` and
`StreamableHTTPServerTransport`; a new pair per request, which is what the SDK asks of a server
without sessions). The package is 4.9 MB unpacked and was already installed, because the
Claude Agent SDK depends on it; the desktop app's server bundle grows by about 0.7 MB, from
3.8 MB to 4.5 MB. A request must carry `Authorization: Bearer <token>`. The token is made at
every server start, is not the WebSocket token, is never written to `server.json` and is checked
before anything of the request is read; without it every method gets 401. The assistant's
token does not open the WebSocket either. `RunningServer.assistant` (`{url, token, tools}`) is
what a provider adapter is handed for the assistant's turn.

**The Assistant thread** (`assistant/thread.ts`, orchestrator threads spec 25). An ordinary main
thread (`kind` `chat`, no project) with the fixed id `assistantThreadId` and the title
"Assistant", listed in the thread list. `assistantThreadEvents` makes it when it is missing, on
the instance, model, effort and permission mode a new thread gets (`newThreadSettings` in
`core/card-threads.ts`: `chat.defaultInstance` and `chat.defaultModel`, then the instance's
own), in `<wow home>/threads/assistant` (the thread migrated from before keeps
`<wow home>/assistant`). Its instance does not hold it (`instanceUsage` leaves it out): when the
instance is removed, its next message moves it to where a new thread would start, with a new
provider session. `thread.greetAssistant`
makes it and greets it (see "The greeting"); `thread.create` refuses its id. Its turns are chat
turns like any main thread's, with the helper tools and the app tools on `/threads/mcp`. Only
the notes differ: a message or an answer to it starts with what the user answered to proposals
and undid since its last turn, and a setup file applied since (`assistantNotes` in
`core/threads.ts`). Migration `0050_assistant_is_a_main_thread` turned the stored assistant
thread into this one, keeping its items and provider session (and setting Claude Code's
`dontAsk` of the tools-only turns to `default`), and the projector reads an old
`thread.created` of kind `assistant` as `chat`, so a replay cannot bring the old kind back.

**Instructions for every main thread** (`chat.instructions`, `defaultChatInstructions` in
`packages/contracts/src/assistant.ts`). `ProviderService` puts the text in a main thread's
`startTurn` as `appendInstructions`; a helper gets none. Claude Code gets it as
`systemPrompt: { type: 'preset', preset: 'claude_code', append }`, after its own instructions,
and a changed text opens a new session on the same conversation (it is part of the session key
with the helper tools); Codex gets it as `developerInstructions` on `thread/start` and
`thread/resume`, read when the thread loads.

**What wow no longer asks of it.** Briefs of decisions, briefing summaries and follow-up turns on
threads the assistant started needed the assistant's own tools (`write_brief`,
`write_briefing_summary`, `read_thread`), which a main thread does not have. `assistantAsked` in
`assistant/briefs.ts` is false, so `decideBriefRequest`, `decideBriefing` and `decideFollow` send
it nothing; a briefing keeps wow's own lines. They go with the rest of the assistant's own
machinery in U8's second part. Migration 0050 moved the stored value
of the assistant's old instructions setting here.

**Tools-only turns in the adapters.** A `startTurn` with a `toolset` is handled inside each
adapter, and a session started with one never becomes an ordinary session or the other way
round (the adapter refuses the turn).

- Claude (`ClaudeAdapter#toolsOnly`): `mcpServers: {wow: {type: 'http', url, headers:
{Authorization}}}` with `strictMcpConfig`, `tools: []` (no built-in tool, so nothing that
  reads or writes files, runs commands or fetches), `allowedTools: ['mcp__wow__*']`,
  `settingSources: []` (no user or project settings, so none of their permission rules, hooks,
  plugins, skills, MCP servers or CLAUDE.md), no launch arguments of the instance,
  `permissionMode: 'dontAsk'`, `systemPrompt` set to the instruction text, and a `canUseTool`
  that allows only `mcp__wow__` tools and never asks the user. The instance's environment
  (config folder, API key) is kept, since the agent signs in with it.
- Codex (`packages/provider-codex/src/toolset.ts`): `thread/start` and `thread/resume` get
  a `config` of `mcp_servers: {wow: {url, http_headers: {Authorization}}}`,
  `web_search: 'disabled'`,
  `features` with `false` for `shell_tool`, `unified_exec`, `view_image`, `multi_agent`, `goals`,
  `apps`, `image_generation`, `computer_use`, `browser_use`, `browser_use_external`,
  `in_app_browser`, `plugins`, `remote_plugin`, `skill_search`, `tool_suggest`, `sleep_tool`,
  `code_mode_host` and `hooks`,
  `tools: {experimental_request_user_input: {enabled: false}}` and
  `shell_environment_policy: {inherit: 'none'}`, and `developerInstructions`, with
  `approvalPolicy: 'never'` and `sandbox: 'read-only'`; every `turn/start` sends
  `sandboxPolicy: {type: 'readOnly', networkAccess: false}`. The `features` and `tools` keys
  switch off Codex's command tools (reported: `exec_command` and `write_stdin`), image viewing,
  subagents, goals, apps, image generation, computer use, the browser tools, plugins, skill
  search, tool suggestions, the sleep tool, code mode and the question-to-the-user tool, and
  the user's own Codex hooks, which run the user's commands. Checked against codex 0.166.0
  without a sign-in: `codex features list` knows every one of these features, on by default,
  and shows each off with these overrides except `unified_exec`, which it still lists as on
  (sent all the same; `shell_tool` off is what removes the command tools); the app-server
  accepts this `config` on `thread/start` and refuses a non-boolean for each of them (it does
  so for an unknown feature name too, so that alone does not show the key is known), and with `mcp_servers` in `config` a server from the user's own `config.toml` is not
  started (only `wow` is). Not known: the tool list a signed-in Codex then offers (no turn
  could run), `apply_patch` (no documented switch) and the three MCP resource tools (reportedly
  cannot be switched off). The rest of the user's `config.toml` (model provider, profiles,
  instruction files) still loads. So the sandbox stays as the second line: a command, if one
  is still offered, cannot write or reach a host and sees no environment variable of wow or
  the instance (so no API key), and every approval request of such a thread is declined
  without asking the user. An ordinary thread gets none of this. The compat check reads `config` as one map of JSON values, so the keys inside it are
  not part of the fingerprint. `config` and
  `developerInstructions` are in the generated protocol types of the tested codex. For any
  other version the adapter asks that codex for its schema once (`installedCodexLacks`) and
  fails the turn with one sentence naming the missing fields and the version to update to. An
  ordinary thread never sends them, so such a codex stays usable for everything else.
- The mock adapter records the command it was sent (`sent`), toolset included, and a script
  can read it; it enforces nothing.

**Tools** (`assistant/tools.ts`, `AssistantTools`: `list()` and `call(name, args)`). There are
three kinds and nothing else.

- Read tools are the readers in `assistant/readers.ts`: `read_settings`, `read_projects`,
  `read_providers`, `read_workflows`, `read_skills`, `read_skill`,
  `read_calendar`, `read_backlog`, `read_triggers`, `read_notifications`,
  `read_connections` and `test_connection` (the same sign-in test as `trackers.test`).
  `read_skills` lists every skill in list order with its description and `group` (wow skills
  spec 21), and `skillSource` for a wow skill, which is what a step's `skillSource` and an
  `alsoFollow` entry's `source` take. `read_skill {name, group?}` answers the text of an own or
  a built-in skill (a built-in one as its template, unfilled) and whether it can be changed; a
  folder skill's text is not read. Each reader builds its answer
  field by field. None of these returns a thread's items, a step's final message, a file's
  content, a card's notes or more of a meeting than its time and title; only the readers of
  agents' output below do, and only those parts. A secret setting and a secret
  environment variable say `set` or `not set`, decided from the names in the secret store; no
  reader ever asks the store for a value. A plain environment variable says `not shown`.
- Reader of agents' output (`assistant/outputs.ts`, chief of staff spec 1 to 3).
  `read_thread {threadId}` answers a chat thread's title, state, model and
  project, its last `assistant.readMaxMessages` agent messages (a subagent's are left out), the
  approval or question it waits for with the request, and the sum of its turns' usage; the
  assistant's own thread is refused. Text longer than `assistant.readMaxBytes` is cut with
  `cut: true`. It takes no path. A thread in a project of `assistant.excludedProjects`
  is refused with the reason; taking a project off that list is a proposal (`guardSettings`).
  The answer goes through `assistant.secretPatterns` with every other tool result.
  `read_free_slots {minutes, from?, days?, limit?}` answers the gaps of `freeSlots`
  (`packages/contracts/src/free-slots.ts`, shared with the plan dialog's `nextFreeSlot`) inside
  the calendar's work hours, around Outlook meetings and the occurrences of cards.
- Notes (`assistant/memory.ts`, spec 29, 30). The notes are the global setting `assistant.notes`
  (`AssistantNote[]`: id, text, addedAt, until, by). `remember {text, until?}` and `forget
{noteId}` are built tools that write the whole list with `setting.set`, so a note is an
  ordinary change with its row ("Memory: … → …") and Undo, and `read_notes` lists them.
  The notes were appended to the assistant's tools-only turns, which no thread runs since the
  Assistant thread became a main thread; they go with the assistant's own tools. Settings → Assistant shows them as a list (`settings/memory-section.tsx`).
- Change tools (`changeTools`) each name one command type of `Command`. The tool's input is
  that command's own schema without `type`, without the id of the thing it makes (the tool
  makes one up, as a view does) and without fields the assistant never fills in (`stopRun`).
  The tool builds the command, runs the same folder check as `dispatch` over RPC, and
  dispatches it with the origin `assistant`. It has no other way into the store.
- Asks (`assistant/asks.ts`) put a card in front of the user and change nothing; the view draws
  the card from the tool call's own input. `show_secret_field {key, projectId?}`
  (`assistantSecretFieldTool`) accepts only a setting marked `secret` and a project that
  exists, and answers the setting's label, where the value goes and `set` or `not set`.
  `show_secret_variable {providerInstanceId, variable}` (`assistantSecretVariableTool`,
  `SecretVariableRequest`) does the same for a provider instance's secret environment variable
  (spec 14): an instance that exists and a variable name, answering where it goes
  (Settings → Providers → <instance>) and `set` or `not set`.
  `offer_project_work {text}` (`assistantProjectWorkTool`) is for a request that is not about
  operating wow (spec 3) and answers that the button is shown. `ask_questions {questions}`
  (`assistantAskTool`, `AskQuestionsRequest`: one to four `AskedQuestion {question, header,
options, multiSelect}`) puts the question card under the call (see "Question card"); it refuses
  a question whose text, header or choices hold a word of `assistant.askRefusedWords`
  (`askedSecretWord`, whole words, any case) with a sentence that points to the secret field, two
  choices with one label, and a choice "Other" (the card has one). It answers `asked` and tells
  the agent to end its turn. No tool name has "thread",
  "message", "file", "content" or "chat" in it, so the U1 test that no tool reads a thread or a
  file still holds by name.

- Guides (`assistant/guides.ts`, `read_token_guide {service, projectId?}`,
  `assistantTokenGuideTool`) answer a `TokenGuide` from data that ships with wow (spec 15): one
  entry per host kind and sign-in (github.com, GitHub Enterprise Cloud with data residency,
  GitHub Enterprise Server, GitLab, Jira and Confluence with a personal access token or as
  Cloud), each naming the host versions it was written for, the steps, the rights reading needs
  and what to copy. Links are built from the address stored for the scope asked
  (`trackers.<x>.baseUrl` resolved for the project, so a project's own address wins). A
  project's GitHub guide follows the host rule for a project's own token
  (`TrackerService.githubAddress`): the project's stored API URL, else its git remote's host,
  else the shared one; without a project it is the shared address. A GitHub API URL
  `https://<host>/api/v3` becomes `https://<host>`, `https://api.github.com` becomes github.com,
  `https://api.<name>.ghe.com` becomes `https://<name>.ghe.com`, and Atlassian Cloud API tokens
  link to the Atlassian account page. Links and `address` are
  built from the parsed address with its user name, password, query and fragment dropped, so an
  address like `https://reader:pass@host` never puts the password in a link. Without an address
  the guide has one step, fill in the address first, and `addressNeeded` names the setting and
  its place; an address `new URL` cannot read gives one step that says to correct that setting.
  `show_secret_field` adds the same guide to its answer for a `trackers.<x>.token` key, and the
  card reads it from the stored tool result. The model is told to use the guide, not memory.
- Diagnosis (`assistant/diagnosis.ts`, `diagnose_setup`, `assistantDiagnosisTool`) answers a
  `Diagnosis`: `problems` (kind, what, reason, place), a summary, and what was `checked` (spec
  19, 20). It reads provider instances whose status is not `ready`; runs `trackers.test` for
  each host whose token or address is stored, globally and for each project that stores its own
  (sign-in requests only, nothing is written); workflow steps whose skill is not installed; and
  cards with a workflow that are `missed`, or `failed` without a thread, with the notification's
  reason ("Its thread could not start…", "Its start time passed without starting its thread…").
  Each part is one query that asks SQLite only for the rows that still count, with cards limited
  to `assistant.diagnosisLimit` in the query, newest first. Times are told in
  the calendar's zone (`calendar.zone`, as the calendar resolves it), e.g. "Tue, 10 Nov 2026,
  09:00 (Europe/Stockholm)". A failed trigger's reason exists only as a notification, so with
  `scheduler.notifications` off it is not found.

- Models (`assistant/models.ts`, `read_models`, `read_model_guidance`) answer what each
  instance offers and wow's guidance on choosing; see "Models for steps".

Every result passes `hideSecretsDeep` with the patterns of `assistant.secretPatterns` before it
leaves `call`, so text that looks like a secret arrives as `[hidden]` (spec 18). The net
(`hideSecrets` in contracts) also always takes a user name and password out of any
`scheme://user:pass@host` address (`withoutAddressAccount`), whatever the patterns, so a stored
address with an account in it reaches the agent without it: in `read_settings`, diagnosis, the
first-start note and change rows alike. A setup file refuses such an address and "Save setup"
leaves it out, as for a value that looks like a secret. The log line
for a call names the tool and how it ended, never what went in or came out; a name that is not
a tool's is logged as `unknown`.

**The class table** (`assistant/classes.ts`, `commandClasses`). The server, not the model,
decides what a command of the assistant does. The table names every type of `ServerCommand`
(the type system and a test both fail when a new command has no entry):

- `ordinary`: applied at once, with a record that can be undone. Settings, projects (create
  and update), cards (deleting one too), backlog items and workflows without the parts below.
- `proposal`: nothing is applied; the command is stored and waits for the user. Starting a
  card's thread now (`card.runNow`), a workflow whose steps gain or change a permission mode, a
  gate condition or rules, lose a gate, or that turns "for units" or "own working copy" on or
  off, and a setting that then lets the app do more: `scheduler.paused` off,
  `scheduler.missedPolicy` to `run` or `viewer.htmlScripts` on. A change to
  `assistant.secretPatterns` is a proposal too, since that is the assistant's own net, and so
  is any change to `viewer.editorCommand`
  or `viewer.editorShell`, either way (the last two name a program the server runs). Four
  more are proposals though spec 9 does not list them, because they do the same kind of thing:
  another skill, extra prompt, provider or model on a step that has a permission mode or a
  gate that passes by itself (the yes once given for that step was for that work); taking a
  skill off `workflows.alwaysStopSkills`; a project's `approvals.alwaysAllow` with a rule it
  does not already have (removing rules is ordinary); and a tracker's `baseUrl` or `authMode` while that
  tracker's token is stored at any scope, since the token would then be sent to the new address
  (a project's own token is sent to the address the project resolves, which can be the global
  one, so a global change counts for a project's token too). Two more close ways around a yes:
  `project.update` with another folder, because the folder is where agents work and its git
  remote names the host a project's own token goes to; and a card with a workflow and a project
  (`card.create`, `card.update`, `backlog.plan`) whose start (for a repeating card, its next
  occurrence) is in the past or within `assistant.startSoonMinutes` of now, because the scheduler would start its thread almost
  at once, which is "start it now" by another name. A card further ahead is scheduling and stays
  ordinary.
  Every own skill the assistant writes, changes or removes (`skill.create`, `skill.update`,
  `skill.delete`; tools `create_skill`, `update_skill`, `delete_skill`) is a proposal too (wow
  skills spec 22): a skill steers every agent that follows it. Its card shows "When to use it"
  and the text (the whole text kept as `toFull`/`fromFull` and shown on request, as a long value
  always is), or for a change only what differs, or for a removal the text that goes; its basis
  is the own skill as it is, so an accept after the skill was changed by hand is refused as
  stale. `skill.update` and `skill.delete` of a built-in skill or a folder skill are refused
  with a sentence that says so. Setting a step's `alsoFollow`, `skillSource` or `leaveOut`
  (spec 23) is part of `update_workflow` and follows the workflow rules above.
- `refused`: never applied, with a sentence for the assistant. Every thread, approval and
  question command, provider instances, `project.delete` (it cannot be undone), secret settings, the
  two restore commands, the assistant's own answer commands and every internal command.

An entry is a word, a refusal, or a function of the command and the projections where the
class depends on what the command says. No tool exists for a type that is always refused, and
`AssistantTools` refuses to start with one.

**Standing permissions** (`assistant/permissions.ts`, chief of staff spec 4 to 8). The settings
`assistant.delegation` (off by default) and `assistant.permissions` (`AssistantPermission[]`:
kind, projects, workflows, widest permission mode, end date, daily limit, paused) are both in
`guardSettings`, so the assistant can only propose them. `coverage(command, read, context)`
answers for a command the class table holds as a proposal: `covered` with the permission, `held`
with the reason a permission that would cover it may not now (paused, ended, its daily limit of
uses since midnight in the calendar's zone reached, a card outside work hours), or nothing. It
looks only at four commands and only at what makes them proposals: `card.create`, `card.update`
and `backlog.plan` for Plan runs (a card with a workflow that starts soon, inside work hours) and
`card.runNow` for Start runs, each for a workflow and project the permission names. Every
other command, every refused one and every proposal of another kind (autonomy in a workflow,
guarded settings, skills) is untouched; a test walks every
command type. The kinds for threads, retries and moving cards are stored here and acted on by
later units. Focus cards (`focus` on a card, migration `0038_card_focus`) carry no workflow:
`card.create` and `card.update` refuse one, and as cards they are busy for `read_free_slots`.

**Delegated work** (`assistant/delegation.ts`, `assistant/delegation-tools.ts`, chief of staff
spec 9 to 15). `assistant.startThread`, `assistant.sendToThread` and `assistant.answerQuestion`
are commands only the assistant sends (anyone else is refused), settled by the standing
permissions before the class table is read; the table lists them as refused, so no change tool
offers them. The tools `start_thread`, `write_to_thread` and `answer_agent_question` build them.
`start_thread` asks the trackers whether the project folder is a Git repository and then sets
`ownWorkingCopy`; the thread is created with the project's provider, model and effort (or the
tool's) and the permission's widest mode, `thread.delegated` marks it `startedBy: 'assistant'`
(migration `0039_delegated_threads`), and the brief goes out as its first message, all as the
user's commands, so it is an ordinary chat thread from then on. More than
`assistant.maxDelegatedLive` working threads of the assistant refuse a new one with "plan it for
a free slot". Writing and answering need Drive threads and a thread the assistant started; an
answer goes through `question.answer` and `question.answeredByAssistant` keeps the user's words it
came from (`answeredBecause`), which the question card shows. Approvals are never answered.
`DelegationFollower` (`assistant/follow.ts`) listens for `turn.ended`, `question.asked` and
`approval.requested` of such a thread and dispatches `assistant.follow` (an internal command),
which sends the assistant a "From wow: …" message (queued if its turn runs) and counts
`followTurns`, until `assistant.followTurns`. Every delegated act is an
`assistant.permissionUsed` row.

**The decision queue** (`assistant/decisions.ts`, chief of staff spec 16 to 19). The topic
`decisions` is built on the server from the stored rows each time it is read: approvals and
questions that hold a thread's running turn (`approval:<id>`, `question:<id>`), pending
assistant proposals and missed cards until `decision.dismiss` (table `decision_dismissals`;
runs, with their gates, limits and failures, went in U8 part 2). `decisionOrder` puts what holds
a turn first, then proposals and missed cards; inside each the one blocking the soonest card,
then the oldest. `Subscriptions` pushes `decisions` with any of the topics it is read from. Each
row carries `fixed` lines wow writes itself and the assistant's `brief` (table `decision_briefs`,
migration `0040_decision_briefs`). `BriefRequester` (`assistant/briefs.ts`) dispatches the
internal `assistant.requestBrief` for each new decision;
within `assistant.briefsPerDay` since midnight in the calendar's zone it marks the brief asked
and sends the assistant a "From wow: …" message naming the decision. The assistant writes it with
`write_brief` (`assistant.writeBrief`), which is refused for a decision wow did not ask about and
for one already written. No page shows the queue any more (orchestrator threads spec 34); the
tray lists its first three rows and opens the Assistant thread.

**The assistant's rhythm** (`assistant/chief.ts`, chief of staff spec 20 to 27). `Chief.tick`
runs on every scheduler tick (`Scheduler.onTick`, also while the scheduler is paused) once the
assistant's conversation exists. Briefings (`assistant.briefings`): `morning:<date>` when work
hours start, `evening:<date>` when they end, `afterMeeting:<meetingId>` when an Outlook meeting
of at least `assistant.briefAfterMeetingMinutes` ended since the last tick and something
happened while it ran, and `back:<id>` when the web app's `presence.back` (sent on
`visibilitychange` with since when it was hidden, `app/presence.ts`) reports at least
`assistant.briefAfterIdleMinutes` away. The internal `assistant.brief` stores wow's lines (runs
started, finished and failed since the previous briefing, what the assistant did under its
permissions, the queue's count and first rows, the rest of today's cards and free minutes) in
`briefings` (topic `briefings`, migration `0041_briefings`) and, within
`assistant.briefingsPerDay`, asks the assistant for a summary that it writes with
`write_briefing_summary`. The summary is written on the assistant's own model; the spec's
separate briefing model is not built. A briefing's notification (kind `briefing`) and a
reminder (kind `reminder`, one per decision after `assistant.remindAfterMinutes`, table
`decision_reminders`) go out only when `Chief.quiet` is false: inside work hours, not in a
non-all-day Outlook meeting and not inside a focus card; a held briefing is released on a later
tick. Both follow `scheduler.notifications`. Cards with a workflow and a scheduled trigger that an
Outlook meeting now overlaps get `assistant.moveCard` with the next free slot of the same length
after the meeting: under Move cards it is applied as the user's `card.update` with a permission
use, else it is a proposal. The Retry kind is stored but nothing acts on it yet: a step's failed
turn carries no sign of whether the provider or the agent failed.

**Deciding as the assistant** (`core/assistant.ts`, `decideInSteps`). For the origin
`assistant` the class comes first. A refused command is rejected with its sentence. An
ordinary command is decided by the same `decide` the user's command goes through; its events
are stored, then the thing it changed is read again and an `assistant.changed` event is added
in the same transaction. A proposal that a standing permission covers is decided as an ordinary command instead, with
its change row when it has a target, and an `assistant.permissionUsed` event in the same commit
(`assistant_permission_uses`, topic `assistantPermissionUses`, migration
`0037_assistant_permission_uses`), worded as its proposal would have been; the tool answers
`underPermission` and `useId`, and the view marks the change "under <permission>" or, for a
started run, shows the use as a row of its own. A proposal a permission holds back gets a last
line "Why this asks". A proposal is decided once and the result thrown away, so that a
command the app would refuse fails now with the app's reason and a command that would change
nothing asks no question; then only `assistant.proposed` is stored. A command the app refuses
is a `CommandRejected` either way, and the tool hands its message to the assistant (spec 12).

**Changes and undo** (`assistant/changes.ts`). A change row (`AssistantChange`, topic
`assistantChanges`, in the order made) holds what the conversation shows (`what`, `from`,
`to`, `place` with the path the web app opens) and the server's own record: `target` (the
setting, project, card, backlog item, workflow, plan or trigger), `inverse` (the commands that
take the change back, built from the target as it was before and checked against `Command`
when the change is made) and `expect` (the fields the change left behind, or null when it
removed the thing). `assistant.undo {changeId}` compares the target as it is now with
`expect`; if a field differs the undo is refused and says which (spec 8). Otherwise each
inverse command is decided as the user's, one step each, and `assistant.changeUndone` marks
the row. Undo is recorded when the change is made and is never a snapshot of anything else.
The shown texts go through the secret net; `inverse` and `expect` keep the real values,
because undo needs them. They are in `AssistantChangeRecord` (the event and the table) and not
in `AssistantChange`, the row of the topic, so neither a tool nor a client gets them.

**Values in the settings page's words** (agent workbench spec 95). A setting's value in a change
row, a proposal line or an Undo refusal is `settingValueWords` (`packages/contracts/src/
setting-words.ts`), which the settings page reads too (`formatWorkHours`, `formatDays`,
`settingUnitDisplay`): "From Outlook", "08:00–16:00, Mon–Fri", "On", an option's label, "10 min",
an "always allow" list as its rules' words. A shape it has no words for is said as before. A
model is named by its label: `DecideContext.modelLabel` reads `ProviderService.modelLabel`, the
labels of the last `listModels` answer of each instance (the bar, the builder and the
assistant's step checks ask for them); a model no list has named yet shows its id, nothing is
asked for it while deciding. `chat.defaultModel`, a step's model and a project's `defaultModel`
are named so, `chat.defaultInstance` and `defaultProviderInstanceId` by the instance's name. A default that reads "From Outlook" carries no "(default)", since it says where it comes
from.

**The rule proposal** (agent workbench spec 41; `builtTools` in `assistant/tools.ts`). The tool
`propose_always_allow_rule {projectId, rule}` (`AlwaysAllowRuleRequest`, `assistantRuleTool`)
writes the project's `approvals.alwaysAllow` list with the rule added (`addedAt` the tool's
clock) as a `setting.set`, which the class table always holds as a proposal (`moreOnItsOwn`), so
the rule is stored only on Yes and the assistant has no way to store one itself. A built tool
writes its command from a smaller input than the command's own and goes through the same
dispatch as the change tools. It refuses an unknown project and a command prefix that
`prefixRuleable` rejects (a shell, a wrapper such as `sudo` or `npx`, an interpreter given
code, anything that chains, pipes or quotes: `ruleCovers` would never match it), and answers
"unchanged" for a rule the project has, comparing with the project's own row (`projectRules`,
the list rules are answered from, never the resolved value). The class table (`rulesRefusal` in
`classes.ts`) holds every `approvals.alwaysAllow` change from the assistant to the same terms,
`set_setting` included: a scope that is not `project:<existing id>` is refused with a pointer to
the rule tool, and an added command rule `prefixRuleable` rejects is refused in the tool's
words. The card (`rulesCard` in `changes.ts`) reads "Always
allow `pnpm test` in Tea" with a line per rule added or removed in `ruleText`'s words, and its
place, like every change of that setting, is Settings → Approvals.

**Proposals.** A proposal row (`AssistantProposal`, topic `assistantProposals`) holds a title
("Start Delivery in Tea"), one line per thing that would change, and the place. The server's
record (`AssistantProposalRecord`, the event and the table) also holds the command as the
assistant sent it and `basis`: the state the title and lines were written from (`basisOf`: the
stored setting value; the whole workflow for a workflow change or a start; the card's title,
workflow, project and backlog item; the trigger's row; the names a title shows). The topic's
row leaves both out. `assistant.proposal.accept {proposalId}` first compares `basis` with the
state now. If it differs the accept is rejected and says what changed, and the proposal stays
pending for the user's No: a yes is for what the card says, so the assistant cannot point a
pending yes somewhere else with an ordinary change, and a held step list never overwrites
what the user changed by hand since. Otherwise the command is decided as the user's and the
row is marked accepted in the same transaction; if the app refuses it now, the accept is
rejected with the reason and the proposal stays open. `assistant.proposal.decline
{proposalId, reason?}` marks it declined and keeps the reason; a reason in which `findSecret`
finds something is refused with the held message's sentence (`heldSecretSentence`), so the
typed text is not kept in the command receipt either, and the view checks the same before it
sends. The three answer commands (`accept`, `decline`, `undo`) are in the table as refused, so
they only work with the user's origin.

**What the agent reports is netted too** (`assistant/redact.ts`, `AssistantRedactor`, one per
provider service). The provider service passes every provider event of the assistant thread
through `hideSecrets` before it dispatches `provider.events`: a tool call's name, input and
output, text and reasoning deltas, task list contents, a failure's words, and an approval or
question. So a stored tool result shows `[hidden]` where the value was (spec 18), whatever tool
or text it came from. Streamed text and tool output are checked on the whole text of their item,
across batches: the redactor keeps each item's text, passes on the hidden text up to its last
whitespace (a token has none, so the held end may still become one) and the rest when the item
ends (tool output at its `toolCallCompleted`; text and reasoning when a tool call, approval or
question starts or the turn ends). A value split across two pieces is therefore hidden in the
event history too. A custom pattern that matches across whitespace can grow back over text
already passed on; the rest of that item is then stored as `[hidden]`. Ordinary threads are
stored as reported and the patterns are not compiled for them.

**The user's answers in the next turn** (spec 10). `thread.sendMessage` to the assistant
thread asks `ReadModel.assistantAnswers(since)` for the proposals answered and the changes
undone after the last turn began (all of them before the first turn) and puts a note before
the user's text in `start.prompt` (`assistantAnswersNote` in `assistant/thread.ts`): Yes or No
with the title and a No's reason, and Undid with the change's text and place. The note passes
the secret net, starts with `[From wow, not typed by the user]`, and the instruction text
tells the agent so. The user item keeps only what the user typed, and the next turn's note has
only what was answered since, so each answer reaches the agent once. An answer given in the
same millisecond a turn started, after it started, is missed; a person cannot click that fast.

`assistant/guides.test.ts` has a case per host kind and sign-in, the missing address and the
versions; `assistant/diagnosis.test.ts` one per failing thing and one where nothing fails.

Tests: `apps/server/src/assistant/assistant.test.ts` starts a whole server and has a case per
line of the unit's contract. It stores a marked value in the secret store, calls every read
tool, and searches every result, stored event, command receipt and log line for it; it does
the same for a marked thread message and a marked file. One case speaks MCP to the endpoint
with the SDK's own client. `assistant/view.test.ts` covers what the view relies on: the two
asks, a value saved in a secret field (searched for in every event, receipt, thread item, log
line and prompt), the net over the agent's own reports, and the note in the next prompt, with
the server's clock moved between turns. `assistant/skills.test.ts` covers wow skills spec 21 to
23: the list in its groups, a wow skill's text, a new, changed and removed own skill as a
proposal with its text and written only at Yes, the refusals for built-in and folder skills,
a stale accept, and "Also follow" under the workflow rules.

**Rows in the conversation** (`apps/web/src/assistant`). The Assistant page is gone
(orchestrator threads spec 34); what wow's tools show is drawn in the thread where the tool ran by
`useAppToolRows` and `PlacedRows` (`assistant/app-tool-rows.tsx`): change rows with Undo, proposal cards with Yes and
No, secret field cards and question cards, placed after their call by `placeRows`

**First start** (app assistant spec 24 to 27; `apps/web/src/app/first-start.tsx`,
`apps/web/src/providers/connect-step.tsx`). The spec decided to reuse the provider onboarding and
to gate the app only while no provider is connected, so the gate is a client view over state the
server already has: the `providerInstances` topic and the global setting `providers.offerSetup`
(`personal: machine`, so a setup file never carries it). `useFirstStart` puts the gate up while
the setting is on and there is no provider instance at all. An install with any instance,
whatever its status, is never gated, so an existing install whose instance fails its test after
an upgrade is not locked out; Settings › Providers covers it. Once up the gate
stays up until an instance has `status: ready`, through the instances its Test buttons create
and that fail. The Shell then draws only `ConnectAgentStep` (no
sidebar, no route), and the palette offers only `connect.claude`, `connect.codex`, `setup.start`,
the palette itself and the theme. The step shows Claude Code and Codex side by side with the
binary `provider.detect` found, Test (which dispatches `providerInstance.create` from the detected
binary and folder when that kind has no instance, then `provider.test`) and the test's message,
and "Start from a setup file", which reads, previews and applies a file through the same
`readSetupFile`, `SetupPreviewDialog` and `setup.apply` as Settings → Advanced. When an instance
passes, the client writes `providers.offerSetup` false, so a provider removed later never brings
the gate back (spec 27), sends `thread.greetAssistant` again so an owed greeting goes out, and
opens the Assistant thread at `/chat/assistant`.

**The greeting** (spec 24, 26). The server owns it, so a reload or a restart between the
passing test and the greeting does not lose it. When the gate goes up the client sends
`thread.greetAssistant`, and again when the step passes. The server makes the Assistant thread when
it is missing and greets at once when no turn runs there and an instance can run it; otherwise it
stores `assistant.greetingOwed` (table `assistant_greeting`, `ReadModel.greetingOwed`) and the
next `thread.greetAssistant` greets. Each greeting stores
`assistant.greetingSent`, which ends the debt, so it is sent once. The command is refused from
the assistant (classes.ts). Its turn shows `assistant.greeting`
as the user's line; the prompt gets wow's note before it (`firstStartNote` in
`assistant/thread.ts`, the same "[From wow, not typed by the user]" form as the answers note):
the providers that are ready, the projects, workflows and trackers (address and whether the token
is set, from stored global values only, so a default is not counted), what a first run still
needs (a project, a workflow), and, when a setup file is applied and not undone
(`ReadModel.lastSetupApplication`), "To fill in": each secret of its `toFillIn` still not set,
work hours while `calendar.workHours` is not stored, and project folders, which a file never
holds. The note goes through `hideSecrets`. The agent walks it one thing per answer, a secret
through `show_secret_field`. Nothing on the server walks the list;
the agent does, and the facts are re-read on every greeting. A setup file applied later (from
Settings) is told at the assistant's next `thread.sendMessage` instead (`setupAppliedNote`):
when the newest applied file is newer than the start of the assistant's last turn, the note
names it with the same "To fill in" lines, after the answers note and before the user's text.

## Setup file

Behavior lives in `intents/2026-11-app-assistant/spec.md` (21 to 23). A setup file is what one
person sends another so their wow starts from the same settings and workflows. It is sent once;
nothing keeps two installs in step. `apps/server/src/setup` reads and writes it; the server never
writes it to disk, the app hands the text to the user as a download and reads a picked file's
text back.

**The file** (`SetupFile` in `packages/contracts/src/setup.ts`) is YAML, read and written with
the `yaml` package, with a version key: `version` (`setupFileVersion`, 1), `wow` (the version
that wrote it), `settings` (key → value), `toFillIn` (secret setting keys), `workflows` and
`skills` (own skills as `{name, description, text}`, wow skills spec 8). A
workflow is the stored one without dates, and each step names its provider by kind (`provider:
claude`) instead of an instance id, which is this install's own. No path, project or line ending
form is in it, so a file made on Windows reads the same on Linux; a byte order mark and CRLF are
read as plain text (tested).

**Save** (`setup/write.ts`, `writeSetup`, RPC `setup.save` → `SetupSaved {text, fileName,
toFillIn, leftOut}`). It takes every global setting that is stored, passes its schema and differs
from its default: this includes the trackers, hosts and `workflows.templates` settings. A secret
setting is never read, and a stored reference only puts its key under `toFillIn`; the secret store
is not asked. A setting whose registry entry has `personal` stays out: `account` for the Jira and
Confluence email and the GitHub owner, `machine` for folders and ids that fit one computer (`skills.directories`,
`workspaces.root`, `advanced.port`, `desktop.autostart`,
`appearance.paletteRecent`, `providers.offerSetup`), `person` for what only that person can say (`calendar.zone`,
`calendar.firstDayOfWeek`, `calendar.workHours`). Projects, cards, backlog items, threads and runs
are not read at all, so no project folder is in it. Own skills are written by name with their
text; built-in skills come with the app and folder skills stay in their folders. A value,
workflow or own skill that the secret net (`assistant.secretPatterns`) matches is left out and
named in `leftOut`; so is a workflow whose
step names an instance that no longer exists. A step applied from a file where no instance of its
kind was here holds the kind as its instance id (`awaitedProviderKind`) and is written back with
that kind; a run of its workflow is refused with "Step <skill> has no <kind> instance here yet:
choose one for it in the workflow <name>." The first instance of that kind created afterwards
takes those steps over (`providerInstance.create` also stores `workflow.updated` for them).

**Read and preview** (`setup/file.ts`, `setup/plan.ts`, `planSetup`, RPC `setup.preview {text}` →
`SetupRead`). `parseSetup` keeps a line counter, so every problem has the line of its key. The
order: a text longer than `advanced.setupFileMaxBytes` (UTF-8 bytes; default 1 MB), refused
without a line before the YAML is read, for the preview and again at Apply; YAML errors; a `__proto__` key anywhere ("Unknown setting **proto**" under `settings`),
which would not become a key of the value read; aliases of aliases past the YAML library's
count, refused with the first alias's line instead of failing; an empty file or one that is not
a mapping; the version (a missing version
refuses; a newer one refuses with "needs wow <wow> or newer" before any other check, since a
newer file may hold keys this wow does not know); the strict schema (an unknown key or a wrong
type, with where it is: "Workflow "Delivery", step 2: …"); then each setting against its
registry schema, a secret setting with any value, a `personal` setting, a `toFillIn` key that is
not secret, and any string the secret net matches. Then the commands are built: `setting.set`
at global scope for each value that differs from what is stored (or the default), and for each
workflow `workflow.update` of the one with its id, else of the only one with its name, or
`workflow.create` with the file's id. Each own skill in the file is `skill.update` of the own
skill with its name when the description or text differ (a `replaced` line; "(the text
differs)" when only the text does), else `skill.create` (an `added` line), either way with
the whole text as the line's `full`; a name the rule refuses or one in the file twice refuses
the file with its line. Skills are planned before workflows, so a step that runs or follows a
skill the same file brings is not marked. A step's skill counts with its source, as a run finds
it: `yours` only among own skills (or the file's), `wow` (or a built-in name without a source)
only among wow skills, anything else only among folder skills. A step keeps the instance it already uses when that is of
the file's kind, else takes the first instance of that kind, so a file read where it was written
changes nothing. Each command is decided once on the projections without storing anything, so a
command the app would refuse (rules that point nowhere, a workflow with a live run) refuses the
file with its line. The preview (`SetupPreview`) has `added` (nothing stored or a new workflow)
and `replaced` (a stored value or an existing workflow), each a `{what, from, to}` line with
`full`, the whole new value as YAML or text, whenever `to` does not say all of it (a text past
the `assistant.valueLength` characters a line shows, a list, a workflow's steps with their prompts and rules), so
the view can show it on request and nothing is applied unseen; `marked`
for a workflow whose skill is not installed ("skill not installed: brew-report") or whose
provider kind has no instance here; and `toFillIn` with label and place, without the secrets
this install already has; and `warnings`, shown above Apply: a `trackers.<x>.baseUrl` whose
host differs from the current global address while a token is stored globally ("the token
stored here will be sent to <host>"), or for a project that stores its own token and takes the
global address, and `viewer.htmlScripts` turned on. `warnings` are not kept in the
`setupApplications` row. A file saved and read back on the same install previews nothing.

**Apply and Undo** (`setup/apply.ts`, `decideSetup`, commands `setup.apply {applicationId,
name, text}` and `setup.undo {applicationId}`). `decideInSteps` decides them in steps in one
transaction, like the assistant's answer commands. Apply reads the text again with
`planSetup` (the preview is never trusted), decides each command as the user's, and records
each one's change with `changeOf` from `assistant/changes.ts`: the values it left (`expect`) and
the commands that take it back (`inverse`). An own skill's record has the target `{kind:
'skill', id: <name>}` and holds its name, description and text; its inverse is the delete, the
update with the old text, or the create. The event `setup.applied` stores them as `parts` of
the `SetupApplicationRecord`; the `setupApplications` topic row (`SetupApplication`) leaves them
out. Undo checks every part with `undoRefusal` first and is refused, changing nothing, with what
changed when any thing the file set changed again; otherwise it decides every inverse, newest
part first, and `setup.undone` marks the row. A step that refuses rolls back the whole
transaction. Both commands are refused from the assistant in the class table: the user reads the
preview and presses Apply.

**The view** (`apps/web/src/settings/setup.ts`, `setup-section.tsx`). Settings → Advanced has a
"Setup file" section: "Save setup to a file" (download through a blob link, a toast that says
how many secrets are listed to fill in and what was left out), "Start from a setup file" (a file
input; its text goes to `setup.preview`), the preview dialog with "Read before you apply" (the
warnings) first, the lists Added, Replaced (a line with `full` opens "Show all of it"), Marked
and To fill in afterwards and Apply, or the problems with their lines, and a row per
applied file with Undo or "Undone". Under an applied file's row stay its marks and "Still to fill
in": its `toFillIn` entries that have no stored reference at global scope yet, each with its
place. The palette has "Save setup to a file", "Start from a setup
file" (through `setupStore.pickWanted`: while a "Connect an agent" step is on screen, at first
start or in the Assistant view, that step owns the picker and the palette stays where it is,
counted in `setupStore.stepPickers`; otherwise it opens Settings → Advanced and its picker) and
"Undo
setup from <name>" for every applied file (the newest before typing). No keybinding: these are
rare.

Tests: `apps/server/src/setup/setup.test.ts` (two whole servers: save on one with marked
secret, folder, email, card, backlog item and thread, which the file must not contain; preview
and apply on the other, Undo, refused Undo, CRLF and byte order mark, each refusal with its
line, a newer version, a missing skill, the round trip, the assistant's refusal, and the RPC
methods); `apps/server/src/setup/setup-skills.test.ts` (own skills saved, previewed as added
or replaced with their text, applied as files under wow's home and removed by Undo, the name
rule with its line); `apps/web/src/settings/setup.test.tsx`; `apps/web/e2e/setup-file.spec.ts`.

## Question card

One card draws every question in wow (intent 2026-11-questions-and-models): an agent's in a chat
thread or a workflow step, and the assistant's own. `packages/contracts/src/questions.ts` holds
the shapes: `QuestionOption {label, description?, recommended?}`, `QuestionReply {picked, text}`
(the picked labels in the asker's order and the typed text), `replyText` (one line: labels, then
text), `replyProblem` (empty, a label that is not offered, two picks on a single choice question),
`markRecommended` (both providers mark a recommended choice by ending its label with
"(Recommended)"; the label stays, since the answer must name it exactly), `shownLabel` and
`cardOrder` (recommended first).

- **Provider questions.** `questionAsked` carries `header?` and `askId?` (the questions of one
  provider request). The question row's `request` and the `question` item's payload keep both;
  `question.answer {answers: [{questionId, reply}]}` answers the questions of one ask together
  and is refused when a reply has a problem, a question was answered, or the turn that asked is
  no longer the running one ("… was not answered before its turn ended, so it can no longer be
  answered."). `question.answered` carries `answer` (the line) and `reply`; the projector writes
  the line to the row and the reply into the item's payload (`QuestionItemPayload.reply`), which
  the card reads. Events and items from before the card have no `reply`, `header` or `askId`:
  the card shows the row's `answer` text and one card per question, as before. A waiting
  question still makes the thread `needs_you`, so runs list a waiting step as before. Only a
  question of the running turn counts as open (`ReadModel.openRequests`, and the composer's
  `pendingQuestion` in the web): one left when its turn ended keeps its row unanswered, shows
  "Not answered", and holds up nothing.
- **The assistant's questions.** `ask_questions` (see "Assistant") changes nothing; the view reads
  the call (`askedQuestionsOf` in `packages/contracts/src/asked.ts`: a call of
  `ask_questions` whose output says `asked`). The answer is the user's next message:
  `thread.answerQuestions {threadId, itemId, replies}` (only the assistant's thread; refused while
  its turn runs, when a reply is missing or has a problem, when a turn started after the
  call's: "These questions were not answered before the next message, so they can no longer be
  answered.", and when the call's turn was stopped). The tool refuses a second ask while a turn
  that already asked runs, so a turn has one card. That the turn ends at the ask rests on the
  tool's note and the instruction text; the server does not stop the turn, and a card stays
  "Answer when the assistant has finished its turn" until it ends. It starts a turn like `thread.sendMessage`, with `askAnswerText` as the user item's
  text, `TextItemPayload.answers {askItemId, replies}` on the item, and `askAnswerPrompt` ("[From
  wow] The user answered your questions (ask_questions) on the card: …") after wow's other notes
  in the prompt. The conversation shows such a user item as a short note, since the card shows
  the answer. The assistant's own command for it is refused (classes.ts).
- **The card** (`apps/web/src/chat/question-card.tsx`, `QuestionCard`). Per question: the header
  as a chip, the question, the choices with digit hints (recommended first, marked), and a last
  row "Other" with a text field; a single choice question keeps one pick, a several question any
  number. Each question is `open`, `answered` (picks and text, or an old line) or `closed`. Send
  is enabled when every open question has a pick or text. Keys while the card has focus: the
  arrows move through the choices and "Other" fields of all questions, a digit picks that choice
  of the question the keyboard is on (the last digit goes to "Other"), Space picks, Enter sends,
  and a printable key goes to that question's "Other". `ChatQuestions` (chat/items.tsx) feeds it
  from question items and rows; consecutive question items with one `askId` are one entry
  (`groupQuestions` in view-model.ts), and a question whose item's turn ended unanswered is
  closed. `AssistantQuestions` (assistant/questions.tsx) feeds it from the tool call; `askState`
  reads the conversation: answered by the user item that names the call, closed by any other
  user item after it, open otherwise (waiting while the call's turn runs). Before it sends, the
  Assistant view runs each typed text through `holdMessage`, the composer's check, and shows the
  same `HeldLine` (Put it in <field>, Send anyway, Keep editing) inside the card.
- **Palette and keys.** A card with an open question adds itself to `questionStore`
  (chat/question-store.ts) and leaves when nothing on it can be answered; `questionCommands` offers
  for the newest one "Question: go to the card" (`keybindings.questionFocus`, Alt+Q), "pick
  <choice>" for each choice, "type your own answer" for each question, and "send the answer(s)".

Tests: `packages/provider-claude/src/index.test.ts` and `packages/provider-codex/src/adapter.test.ts`
("answers … by a choice, typed text, both"), `packages/contracts/src/questions.test.ts`,
`apps/server/src/assistant/questions.test.ts`, `apps/web/src/chat/question-card.test.tsx`,
`apps/web/src/assistant/questions.test.tsx`, `apps/web/e2e/questions.spec.ts`.

## Models for steps

Behavior lives in `intents/2026-11-questions-and-models/spec.md` (13 to 20). wow learns which
models an instance offers only from the installed provider (`listModels`), and how to choose
between them only from a guidance text it ships; nothing about models comes from the internet.
`packages/contracts/src/models.ts` holds the shapes and the sentences both sides show.

- **Which providers need a model.** It is a fact of the adapter: `ProviderAdapter.requiresModel`
  is false for Claude Code (it picks a model itself) and true for Codex (every `turn/start`
  carries the thread's model). A decision and the web app cannot ask an adapter, so
  `providerChatOptions[kind].requiresModel` holds the same fact, and each adapter package has a
  test that the two agree (`providerRequiresModel(kind)` reads it).
- **The rule on the server** (`withRequiredModels` in `core/workflows.ts`, spec 17).
  `workflow.create` and a `workflow.update` that changes the steps give a step on such a provider
  that names no model the instance's `defaultModel`; without one the command is refused with
  `missingModelSentence` ("Step check-work runs on Codex (Codex bare), which needs a model on
  every step, and Codex bare has no default model: choose a model for the step."). A step whose
  instance is not here yet (a setup file's kind as its id) is judged by that kind. A Claude Code
  step without a model is stored as before. Old data keeps working (spec 19): `workflow.restore`
  stores the row as it was, an update that leaves the steps alone does not look at them, a run
  starts as it did (the step's thread falls back to the instance's and the project's default
  model, and the runner fails a step whose model is still empty). `DecideContext.keepStepsWithoutModel`
  lets a setup file's apply and preview store such a step without a default as it is, marked (a
  step whose instance has a default takes it), and `DecideContext.putBackSteps` makes every undo
  (`setup.undo`, `assistant.undo`) store the steps exactly as they were stored, no default
  written in, since it puts back what was there.
- **Marks** (`modelMark`, spec 19, 20). A setup file's preview and its `setupApplications` row
  mark a step left without a model and without a default to take ("step check-work has no
  model, which Codex needs; choose one in the workflow, or the step fails when it starts"), as
  for a missing skill. `diagnose_setup` names every stored step without a model its provider
  needs as a problem of kind `model`, with the workflow as its place; with a default the reason
  says it runs on that default until one is chosen.
- **`read_models`** (`assistant/models.ts`, `assistantModelsTool`, `ReadModelsRequest
{providerInstanceId?}` → `ModelsRead {instances: InstanceModels[], note}`). Per instance: kind,
  `connected`, `reason`, `requiresModel`, the default model and effort, and `models` (`OfferedModel
{id, label, description, efforts, isDefault}`). An instance is connected when its last test
  passed (`status: ready`) and its provider listed its models; otherwise it is listed with no
  models and the reason, and its provider is not asked. A model's `efforts` are
  `offeredEfforts(kind, model)`: its own levels plus the effort that leaves the choice to the
  provider (`default` on Claude Code). `ReaderDeps.listModels` is the provider service's.
- **`read_model_guidance`** (`assistantGuidanceTool` → `ModelGuidance {text, edited, note}`)
  returns `assistant.modelGuidance` as it is resolved at that call, so an edited text is what the
  next call reads. The default (`defaultModelGuidance`) covers planning and specification,
  building, reviewing and mechanical steps for Claude Code and Codex, and names kinds of model
  (the largest, a balanced one, the smallest), never versions.
- **What the assistant writes** (`checkStepModels`, spec 15, 16). `create_workflow` and an
  `update_workflow` with steps check every step before the command is dispatched: the instance
  exists, it is connected (its last test passed; otherwise the refusal gives the reason
  `read_models` gives), its models can be read now, the step names one of them, and an effort
  that model takes (when it takes any). Each refusal says what is offered ("Codex at work does not offer the
  model codex-ultra (Step 1 (plan-work)). It offers: codex-max, codex-mini."). The user's own
  commands are not checked against the list, since the builder offers only the list. A change
  row says each step with its instance, model and effort ("2 steps: plan-work (Codex at work,
  codex-max, high), deliver-work (Claude at work, small-claude, default)") and is not cut at
  `assistant.valueLength`; a proposal already has one line per step field. The instruction text
  names both tools, says to recommend from them with the reason in a sentence, and to ask with
  `ask_questions` when two choices differ in a way the person would care about.

- **The builder** (spec 18, 19). `ThreadSettings` takes the instance's `defaults` and marks that
  model and effort "(default)" in its lists (the composer bar's lists, see "Chat view"). `stepDefaults` fills an empty model with the
  instance's default, and only for a provider that does not need one with the first listed
  model, so a Codex step without a default stays empty. `validateDraft` then gives that step
  `missingModelSentence`, the server's own words, as a problem marked `always`, shown beside the
  step before the first Save as well, and Save sends nothing. Given the stored workflow, it also
  warns on a step that was saved without a model its provider needs ("Step 2 was saved without a
  model, which Codex needs; Save stores mock-model-large.").

Tests: `apps/server/src/assistant/models.test.ts` (a case per acceptance line of the unit),
`apps/web/src/workflows/step-models.test.tsx`, `apps/web/e2e/models.spec.ts` (the assistant's
server copy seeds two Codex instances and a workflow restored without models),
`packages/provider-claude/src/index.test.ts` and `packages/provider-codex/src/adapter.test.ts`
("requires a model").

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

The draft's defaults come from server rows, not browser storage (owner decision F-5): the
project's new thread defaults (see "Projects"), then the newest thread that no run started gives
the instance, and on that instance its model, effort and permission mode, and its project or
folder; then the instance defaults. `chat.sendKey` picks the key that sends: Enter (Shift+Enter
makes a new line) or Ctrl+Enter, with which a plain Enter makes a new line (spec 97). Folders used without a
project (`recentFolders` over `threads`) and "Another folder…" (`Runtime.pickFolder`, a typed path
in the browser build) replace a separate working-directory field. Starters under the composer come
from `skills`, open `backlogItems` and the last active thread (`chat.starterCount`). The composer
focuses on `/chat/new` and on opening a thread; its skill list is a cmdk `Command` with
`shouldFilter={false}` whose selection the text box moves (focus stays in the text box), grouped by
`skillGroupOf` (see "Skills in the composer"), in chat in the order of "Conversation reading". A message written while a turn runs goes to the
server, which queues it (see "Providers", Queued messages); the conversation ends with the queued
row (`QueuedMessageItem` in `items.tsx`: "Queued · sent when the turn ends", its text and skills,
Edit and Cancel; palette "Edit queued message" and "Cancel queued message"; the palette's Edit
puts the text back through the open thread's own registered composer, `threadSkillComposer` by
`draftKey`, and is not offered while there is none), and a user item
sent from the queue says "Sent during the turn" or "Sent when the turn ended". While a question
waits, the composer sends
`question.answer` with its text as the answer's typed text. Questions are drawn by the question
card (see "Question card"). The working clock reads the running turn's `startedAt` and redraws each second;
it is display only, the state still comes from `turns`. A pending approval takes the focus, and
the palette's approval commands (`keybindings.approvalAllowOnce|approvalAllowSession|approvalAllowAlways|approvalDeny`,
plain keys, so they do nothing in text fields) answer it (see "Edits, approvals and a thread's
Changes"). A thread whose step a waiting run asks
to review (`gateRunForThread`: the gate after this step, or before the next) shows the run view's
`GateBar` above the composer, and the palette's Continue run and Stop run apply to that run.

**Drafts** (`chat/drafts.ts`, agent workbench spec 49). The composer of a chat or step thread
takes `draftKey` (the thread id) and keeps its text and chips in the browser's `localStorage`
(`wow.composerDraft.<threadId>`, chips as `Skill` rows), written on every change and removed when
empty, so switching threads and a restart bring it back and Send clears it. A send that finishes
after the user moved to another thread clears only the stored draft of the thread it was sent
from. The Assistant view keeps no draft, since its text may hold a secret, and `/chat/new` none.

**Commands in the `/` list** (`chat/slash-commands.ts`, spec 58 to 61). The composer of the open
chat thread (`commandSource`: instance, folder, thread; not in the context panel or the Assistant
view) lists a "Commands" group above the skills. `slashCommandTable` names each `/name` and the
palette command it runs (`/model` `modelBar.chooseModel`, `/effort`, `/mode`, `/plan`
`modelBar.mode.plan`, `/compact` `chat.compact`, `/clear` `chat.clear`, `/fork`, `/rename`
`chat.renameThread`, `/done` `chat.markDone`, `/stop` `chat.stop`, `/open`); an entry shows only
while that command is in the palette, which the shell publishes to `paletteCommandsStore`. A pick
takes the typed `/word` out of the text and runs the command with the palette's context. Below
them, "Claude Code commands" lists the provider's own (`provider.listCommands`, asked each time
the list opens, one request in flight per connection, instance and folder) without names wow lists or skills the list shows; a pick puts
`/name ` in the text, sent as typed. `chat.clear` opens `/chat/new` with the thread's instance,
project, folder and `DraftState.settings` (model, effort, mode), which the new thread starts
from instead of the usual defaults; the old thread stays. `chat.compact` sends the provider's
compact message while no turn runs.

**Composer bar** (`chat/model-bar.tsx`, agent workbench spec 1 to 8, 10). `ModelBar` sits in the
composer's bottom row, left of Stop and Send (the composer takes it as `bar` and its keys as
`onBarKey`), and reads "model · effort · mode". It replaced the header's selects on an open
thread, the row under the provider picker on `/chat/new` and, through `ThreadConversation`, the
step thread in the side panel; the builder keeps its selects (`ThreadSettings`) with the same
lists. Each part is a Popover with a cmdk list. `modelChoices` and `effortChoices`
(`chat/thread-settings.tsx`) build the lists: a model's label and, under it, its description;
"(default)" on the instance's default model and effort; "(provider's default)" on the model the
provider flags while the instance names no default; an image icon where `imageInput` is true;
"(model's default)" on the model's `defaultEffort`. Nothing absent is filled in. A pick calls the
caller's `onChange`: a thread sends `thread.configure` (unchanged), the draft keeps it until
`thread.create`. `threadDefaults` starts a new thread
on the provider's default model and that model's default effort when neither the last thread nor
the instance names one. Keys while the composer has the focus (`useModelBarKeys`, `barKeyOf`):
`keybindings.composerModel` (Mod+Shift+M) and `keybindings.composerEffort` (Mod+Shift+E) open the
lists, `keybindings.composerModeCycle` (Shift+Tab) moves to `nextPermissionMode` (from the mode it last
sent while the thread has not shown it yet, so a quick second press goes one further;
`ModelBarProps.onChange` may return the `thread.configure` dispatch, and its rejection clears that
pending mode, so the next press cycles from the mode the thread shows), and
`keybindings.composerLeave` (Escape, after the skill list's own Escape) focuses what comes before
the composer, since Shift+Tab no longer leaves it. Inside `#context-panel[data-overlay]` an
Escape is not taken by the composer, so the panel's own Escape closes it; a leave key rebound to
anything else still leaves there. They are matched in the composer's key handler,
not by the global keybinding listener, so they do nothing elsewhere. A list that closes returns
the focus to the composer unless the user already moved on. The palette reaches the bar on screen
through `modelBarStore` (`chat/model-commands.ts`; the bar whose conversation had the focus last
is in front, and only the focus or a newly shown bar changes that: a re-render updates a bar in
place, and the bar writes the store only when its model, effort, mode or defaults change): "Model: <label>", "Effort: <level>" and "Permission mode: <label>", the current one
with detail "Current", and "Choose model…" / "Choose effort…", which open the lists. The
assistant's bar has no mode commands. Tests: `apps/web/src/chat/model-bar.test.tsx` (keys, cycle,
colours, lists, palette, new thread, step thread, the assistant's bar),
`packages/contracts/src/model-bar.test.ts` (cycle and danger facts), the adapters' model cases,
`apps/server/src/hooks/mock-models.test.ts` (`mockCodexModels`, which the chat copy of the e2e
server's Codex lists), and the e2e cases "picks model, effort and mode from the composer bar" and
"sets the model from the palette" in `chat.spec.ts` and "the assistant's bar writes its settings"
in `app-assistant.spec.ts` (run in the `assistant` project, since it uses that copy).

### Images in the composer

A dropped or pasted file that is no image (chat overview spec 35) does not go to the server:
`textFileBlock` (`chat/text-files.ts`) reads it in the browser and puts its text into the
composer as a fenced block headed by its name, fenced past any backticks inside, up to
`chat.attachTextMaxBytes`. A PDF, a file over the limit and one with NUL or undecodable bytes
are refused in the composer's error line.

The `@` list also offers other chat threads and backlog items not done or dropped (chat overview spec 36,
`chat/mention-blocks.ts`: `threadMatches`, `backlogMatches`), five of each. A pick puts a fenced
block into the text: a thread's title, project and last answer of its own agent (its
`threadItems` read once with a subscription that closes after the first rows), or a backlog
item's title, state, tags and body, cut at `chat.mentionMaxChars`. Nothing goes to the named
thread.

With the project setting `chat.mentionHostItems` on, the list also offers the thread's
`hostItemReads` that hold data (chat overview spec 37, `hostMatches`). This is the one place host
text reaches an agent, so a pick asks with `window.confirm` every time, and `hostBlock` quotes the
item as last read, page HTML reduced to its text, in a block that says it was written by others
and is information, not instructions. wow fetches nothing for it.

Agent workbench spec 53 to 55 and 61. Contracts in `packages/contracts/src/attachments.ts`.

- **Once to the server, then by id.** Ctrl+V of an image file, a dropped file, or the palette's
  "Add an image to the message…" (a hidden file input) sends the bytes with `attachments.put
{threadId, base64, type, name?, providerInstanceId?, model?}` when the image is added, not when
  the message is sent. The answer is a `SentImage {id, mediaType, name?}` plus its size; from then
  on the chip, the draft (`ComposerDraft.images`), the message (`thread.sendMessage.attachments`
  `[{id, name?}]`), the queue (`QueuedMessage.images`) and the user item
  (`TextItemPayload.images`) carry only that. The id is the server's: a UUID and the extension of
  the type found in the bytes (`AttachmentId`), so it names the file and its type and nothing the
  client sends becomes part of a path. `/chat/new` picks its thread id when it opens, so its images
  are stored where the thread will be, and passes the instance and model it will create the
  thread with.
- **Storage** (`apps/server/src/files/images.ts`, `ImageStore`). Files live at
  `<wow home>/images/<thread folder>/<id>`, where the folder is `t-` and the thread id with every
  character other than a lowercase letter, digit, `-` or `_` written as `~` and its code in six hex
  digits (`threadImageFolderName`), so no id climbs out, none holds a character Windows refuses,
  two ids (also two that differ only in case) never share a folder, and no folder is a name
  Windows keeps for a device (CON, NUL).
  Written once (`wx`, mode 0600). Nothing deletes them yet: a chip taken off leaves its file, and
  a thread's folder stays with the thread.
- **Refusals** (spec 54), answered as `rejected` with the sentence the composer shows; nothing is
  stored. The browser checks the type it was told and the size first (`localImageRefusal` in
  `chat/image-chip.tsx`), so a large file is not sent at all; the server decides again by the
  first bytes (`sniffImage` from `files/read.ts`: PNG, JPEG, GIF, WebP; SVG and BMP are refused),
  by `chat.imageMaxBytes` (5 MB), and by the model: `listModels` of the thread's instance (or the
  given one for a thread not made yet) and the thread's model (or the provider's default for an
  empty model). Only `imageInput: false` refuses, so Codex models that report no image input are
  refused and Claude models, which report nothing, are sent; a provider that cannot list its
  models refuses nothing. The assistant's thread and a workflow step's thread (one with a
  `stepId`) are refused (`attachments.put` for its id, and `thread.sendMessage` with attachments
  in the decider): a step's thread takes no images wherever it is shown.
- **Sending.** `dispatch` asks `ImageStore.refusal` before deciding a `thread.sendMessage` or a
  `thread.editLast` with attachments: every image must be stored for that thread, so a message never starts a turn with a
  missing image, and the thread's model is checked again as at `attachments.put`, since the model
  may have been changed after the images were added (a new thread is created before its first
  message, so this checks the model it was made with). A message queued with images is not
  checked again when it leaves the queue: a model changed while it waits gets them, and that
  provider's refusal shows as the turn's error. The decider (`core/threads.ts`) keeps them on the user item and the turn's
  `start.images` (ids); a message may be images only. The provider service turns the ids into
  `startTurn.images` `[{path, mediaType}]` under wow's home. Claude Code gets the files read and
  base64-encoded as image blocks before the text (`userMessage` in `provider-claude/src/sdk.ts`);
  Codex gets `localImage` inputs after the text and reads the files itself (the text is left out
  when it is empty). The fingerprint lists `input[]<localImage>.path` as hand-added and coped
  with: a Codex without it fails the turn, and that refusal shows as the turn's error. A message
  with images written while a turn runs is queued with them and is not handed to the running
  Claude Code turn (a hand-over carries text only); it goes when the turn ends. Retry of a chat
  sends the last message's images again; an answer to a waiting question takes none.
- **Display.** `attachments.read {threadId, id}` answers the media type and base64, which the
  app reads once per connection and image (`useImage`) as a data URL. `ComposerImageChip` is a
  thumbnail button with a cross; uploads run side by side but each chip takes its place in the
  order the image was added (`arrivals` in the composer chains the answers), so Backspace takes
  off the last one added; `SentImages` draws a user item's images above its text; a click,
  Enter or the palette's "Show <image> full size" opens `ImageViewer` (a Dialog). In the composer
  the images stand right above the text: Backspace at the start of the text takes the last one
  off, the left arrow steps onto it, Backspace or Delete on a chip takes it off, and "Remove
  <image> from the message" does it from the palette (`chat/image-commands.ts`,
  `imageComposerStore`). Send waits while an image is still on its way. Once a message is sent
  only its own images leave the composer; one added while it was on its way stays for the next.
  A pasted screenshot has no name and shows as "Image n". A paste whose clipboard also holds text (`text/plain`, as Excel,
  Word and Outlook put a picture of the copied cells or passage beside it) is left to the text
  box and adds no image. The Assistant view, and a workflow step's thread in any view, pass no
  `imageTarget`, so their composer takes no paste, drop or palette image.
- **Tests.** `apps/server/src/files/images.test.ts` (storage under the home, the exact input the
  mock adapter is handed, the refusals, the assistant), `providers/queue.test.ts` (images wait
  for the turn's end), the adapters' "image blocks" and "localImage" cases,
  `packages/contracts/src/attachments.test.ts`, `apps/web/src/chat/image-chip.test.tsx` (chips,
  Backspace, full size, refusals, send, the Assistant view), and the e2e case "sends a pasted
  image" in `chat.spec.ts` (the mock answers "Received n images." with their types); sketch
  `image-chip`.

The palette (`app/palette.tsx`, `app/palette-model.ts`) lists, before anything is typed, the
commands marked `needsYou`, the newest by `recentAt` (`appearance.paletteRecent`) and the open
view's actions; typing searches every command with `paletteScore`, which ranks title matches above
group, detail and keyword matches and needs every typed word. A title's group prefix ("Calendar:
today") is dropped where the group heading says it, and `detail` says what a row is. cmdk claims Ctrl+J/K/N/P for list movement and stops the event, so the palette
runs the app's shortcuts with a modifier itself; otherwise Ctrl+K pressed while the palette fades
out after Escape was lost.

### Tool rows, the task pin and copy

`chat/tools/` draws a `tool_call` item by its `kind` (agent workbench spec 27 to 30): `command.tsx`
reads `$ <command>` in mono, `in <folder>` when the command's `cwd` is not the thread's, and on
the right "exit 1 · 4.2 s" or, without an exit code, "failed" / "done" with the time; `read.tsx`,
`search.tsx` and `web.tsx` are one line ("Read README.md lines 1-80", "Search kettle in src",
"Fetch example.org", paths shown relative to the thread's folder, compared with either
separator, any drive-letter case and without a verbatim `\\?\` or `\\?\UNC\` prefix); `mcp.tsx` reads
`server › tool` with the arguments as `key: value` and the JSON behind Show JSON; `generic.tsx`
is today's row (name, first input text, status words, input and output) for `other`, an `edit`
without a diff and every call stored before kinds; `edit.tsx` draws an edit with a diff. Times (`time.tsx`, `facts.ts`): the
provider's `durationMs` if it gave one, else `endedAt − startedAt`; a running call counts up from
`startedAt` once a second (display only); a call its turn left running reads "not finished".
Opened, output sits in `output.tsx`'s box with its last `chat.toolOutputLines` lines, "Show all N
lines" and Copy (which copies all of it). A group (`group.tsx`) is closed once something follows
it or its turn ended with no call running, and then reads what it did ("Read 2 files, ran 1
command · 1 failed", `groupSummary`); before that it draws its latest call with its time.

Pictures (chat overview spec 31 to 34): the Claude adapter takes the image blocks of a
`tool_result` and the Codex adapter the image content of an MCP result and the file of an
`imageView` item, as `toolCallCompleted.images` (`{base64, mediaType}` or `{path}`). Before the
event is batched, the provider service has `ImageStore.keepToolImages` store each one in the
thread's image folder, sniffed by its bytes and within `chat.imageMaxBytes`, and puts
`storedImages` and `imagesOmitted` in its place, so no picture's bytes reach the event log. The
tool row (`tools/row.tsx`) shows `ToolImages` (`image-chip.tsx`) under its line while closed, the
first `chat.toolImagesShown` with "+N more", and all of them when open; the group line counts
them. Find and the export use `picturesText` ("2 pictures").

`chat/task-pin.tsx`: the latest `task_list` of the running turn, or else the last turn, is pinned
above the composer as "3/7 · <task in progress>" (`TaskPin`), opening to the list; Ctrl+T
(`keybindings.toggleTasks`, palette "Show task list" / "Hide task list", acting on the newest pin
shown, via `taskPinStore`) toggles it, and the open state is the window's, per thread. Each change
of the list (the server stores no item for a list equal to the turn's last one) is a marker in the
conversation, "Updated tasks (3/7)" that opens to that list; a list stored
before (no `at`) is drawn in full as before. The panel's thread Details has a Tasks section
(`TaskDetails`).

Copy (`components/copy-button.tsx`): an assistant message has Copy (its markdown) and Copy text
(what it reads on screen) on hover or focus; fenced code in markdown has Copy code
(`CodeBlock copy`), and a fence labelled with a path (`fenceLabel` in `markdown-body.tsx`: a word
after the language, `title="…"`, `ts:src/a.ts`, or the language itself, each read by
`filePathOf`; a bare word needs a slash or an extension that does not read as a host, and the
language itself a slash, so `vb.net` and `text and/or` stay languages, and `C:\work\a.ts` is a
drive, not `C` joined to a path) shows the path above the block with Open file (also the row action "Open file
<path>"), through the conversation's `FileLinkContext`, so not in the Assistant view; tool output
has Copy output. `copyText` does the write; when the browser has
no clipboard or refuses the write, the error toast "Nothing was copied" says so and the button
does not turn to Copied. The same actions are palette commands for the row or message that last
had the focus (`lib/row-actions.ts`, `chat/row-commands.ts`): each copyable element registers its
actions with `useRowActions` and they become the offered ones when the focus enters it, inner
first (a code block's Copy code before its message's Copy message and Copy message text; a tool
row's Copy output, and once open "Show all N lines" / "Show the last N lines"). Opening the
palette takes the focus, so the last row's actions stay until another row takes it, the focus
lands on something else in the conversation (`rowActionScope`), or the row unmounts. A stopped turn ends with "Stopped by you · 20:41"
(`StoppedLine`, from the turn's `endedAt`), which carries Resume on the last turn. The line reads
the turn's stored state, so a turn stopped before this change gets it too: it was stopped, and no
item, divider or marker is added to it (spec 48 is about new items, not about reading old ones).

### A turn's summary (chat overview U1)

A turn's usage row starts with what the turn did (chat overview spec 1 to 5). The change part is
measured on the server: after a chat thread's end snapshot is kept, `FolderSnapshots.#measure`
diffs the turn's start and end trees in wow's store (`diffSnapshotTrees`, `git diff-tree -r
--numstat --no-renames`, binary files counted with no lines) and reads the thread's Changes
(`readThreadDiff` with no mark, the header chip's measure), then dispatches the server-only
`thread.turnChangesMeasured {threadId, turnId, changes, threadChanges}`. The engine patches
`changes` onto the turn's usage row (`UsageItemPayload.changes`, null when the turn has no two
snapshots, which the row then leaves out) and emits `thread.changeCounted`, which sets `Thread.changeCount`. A turn without a
usage row gets no row: one added then would sit after a later turn's items. What the turn ran is
not stored: `chat/turn-summary.ts` (`turnSummaries`) reads it from the turn's top-level tool rows
in `groupSummary`'s words, with "N failed". The change part opens Changes narrowed to the turn
(`openThreadChanges(…, turn)`): the last turn as "This turn only", an earlier one as "Turn N
only", for which `threads.diff {turnId}` answers the files of its two snapshots as `turnPaths`
(`FolderSnapshots.turnPaths`). Find reads the summary from `FindSource.summaries`; the Markdown
export writes "Turn: …" at the turn's end.

### Plan limits (chat overview U7)

The Claude adapter turns Claude Code's `rate_limit_event` (`rate_limit_info`: `rateLimitType`,
`utilization` as a fraction or a percent, `resetsAt` in seconds, `status`) into a `limits`
provider event of `ProviderLimit {window: fiveHour | week | weekModel | other, label,
usedPercent, resetsAt, state: ok | warning | reached}`. Codex sends none: the generated protocol
has no rate-limit fields. The provider service does not batch it as a thread item; it dispatches
the server-only `providerInstance.limitsReported` for the thread's instance. `core/
provider-limits.ts` keeps the latest of each window with its `reportedAt` (event
`providerInstance.limitsReported`, table `provider_limits`, migration 0046_provider_limits,
topic `providerLimits`) and emits a `notification.sent` of kind `limit` when a window crosses
`chat.limitWarnPercent` or is reached, once per window and reset, unless `chat.notifications` is
off. The web shows `LimitChip` (`chat/limits.tsx`) in the composer bar from the warning on, and
`LimitList` in Settings → Providers; a window whose reset time has passed reads "reset at …, not
reported since". No account detail is kept with the limits.

### Subagents and background work

Agent workbench U11 (spec 44, 48, 90). `chat/tools/agent.tsx` draws a `subagent` call:
"Agent: explore the auth code" (`agentTask`: the description, else the prompt's first line), the
tool calls (`toolCount`, else the calls nested under it) and the time (`formatDuration`, the
provider's duration where it gave one), and Codex's state in words. While the agent works (its
call runs, or Codex says `starting` or `running`) the row is open: the prompt and the nested
items, drawn as the thread's own rows by `ConversationItem` with their own context. Once done the
answer shows as markdown under the row (or, without an answer, the call's output) and the nested
list folds behind the row's line. `nestSubagentWork` (view-model.ts) takes items with a
`parentItemId` whose call is in the thread out of the conversation and hands them to the call
through `ItemContext.children` and `childContext`; an item whose call is missing stays in the
conversation. A subagent call is never folded into a group of tool calls. Calls stored before
kinds have no `subagent` kind and are drawn as the generic row they were.

`chat/background.tsx`: the thread's `backgroundTasks` are chips under the conversation
(`BackgroundTasks`), each with its kind's icon, its description and the time since the server's
`startedAt` (display only, once a second); a task stored before has no time. A chip opens
(Radix popover) to `lastOutput` ("Nothing reported yet." without one) and, where the provider
`stopsTasks`, Stop (`thread.stopTask`). The line reads "Waiting for background work" between
turns and "In the background" during one. The open conversation (not a step's thread in the
panel, not the Assistant) registers its tasks and its `backgroundTarget` (the newest running
`command` or `subagent` call of the running turn that is the thread's own and has no undecided
approval; `thread.toBackground` refuses such a call too) in `backgroundStore`;
`backgroundCommands` offers "Send to the background" (`keybindings.toBackground`, Ctrl+B, only
where the provider `sendsToBackground`), "Show background task: …" and "Stop background task: …".
Ctrl+B is Toggle sidebar's key too on Windows and Linux (Mod+B): the palette's command list puts
the chat's commands first, so the key sends work to the background while there is some and
toggles the sidebar otherwise; the keybindings table shows the two as sharing the key.
When the adapter refuses `stopTask` or `toBackground` (Claude Code no longer running, the call
not sent), the provider service hands the thread a `commandRefused` event, stored as an `error`
item on the running or the last turn ("Could not stop the task: …", "Could not send it to the
background: …") with `notice: 'refused'` on its payload, so the refusal is not only in the log.
Retry and Resume stay on the thread's last error that is not such a notice.

### Conversation reading

Agent workbench U10 (spec 9, 45 to 47, 57, 73 to 76, 88). What a long thread says about itself is
stored by the server; the web app only draws it.

- **Settings divider.** `turn.started` may carry `settingsItem`, a `settings_change` item
  (`SettingsChangeItemPayload {model?, effort?, permissionMode?}`, each `{from, to}` as ids) with
  the index just before the user item. The decider compares the thread's model, effort and mode
  with the `start` of the thread's newest stored `turn.started` (`ReadModel.lastStart`, one read
  of the event log), so a change taken back before the next message adds nothing, and a thread's
  first turn has none. The row reads "Model: Opus → Sonnet · Effort: high → low · Mode: Accept
  edits" with the provider's labels (`settingsChangeText` in `items.tsx`).
- **Usage model.** `UsageItemPayload.model` is the provider's word for the model (Claude Code's
  init message, which the adapter keeps per session and puts on `usage`, and forgets when wow
  changes the model of the live session until the next init names one), else the model of the
  newest turn start, else the thread's. Rows stored before have none and show none.
- **Compaction.** Claude Code's `system` message `compact_boundary` becomes ProviderEvent
  `compacted {trigger, preTokens, postTokens?}`, stored as a `compaction` item
  (`CompactionItemPayload`, plus `at`) and drawn as "Conversation compacted (auto) · 152k → 18k"
  (`compactionText`; `shortTokens` in `chat/model.ts`). Codex has no compact method, so no
  Compact button and no compaction there.
- **Context meter.** From `chat.contextWarnPercent` (70) the meter is amber, reads "Context n %
  full" and its button "Compact now", only where `providerChatOptions` has a compact message.
- **Working line.** `WorkingIndicator` reads `workingFacts(items, turnId, cwd)` (view-model.ts):
  the running tool call's command (or MCP `server › tool`, or the row's one-line summary), the
  turn's tool call count, and the tokens of the turn's `usage` item, which only Codex sends during
  a turn (its adapter now emits `usage` on each `thread/tokenUsage/updated` of a running turn);
  then the `keybindings.stopTurn` key. Claude Code reports tokens at the turn's end, when the line
  is gone.
- **Reasoning.** The decider stamps a reasoning item's `startedAt` at its first part and
  `endedAt` on each later part (`threadItem.appended.at`; `ReasoningItemPayload`). A reasoning row
  is done once anything follows it in its turn or it stops streaming (`finishedReasoning`); then it
  reads "Thought for n s", before that "Thinking…" with its last line muted. Reasoning stored
  before reads "Reasoning". `chat.reasoningOpen` opens it by default; Ctrl+O
  (`keybindings.toggleReasoning`, palette "Open all reasoning"/"Close all reasoning") flips it for
  the open thread, kept in `conversationStore` (`chat/conversation-nav.ts`) with a count that
  remounts every row so one opened by hand follows too.
- **Times.** A user row shows its turn's start, the turn's last `assistant_text` its `endedAt`
  (`turnEndRows`), always visible (`message-time`).
- **New since you looked** (chat overview spec 17 to 20). `thread.markSeen` stores
  `Thread.seenThrough`, the newest item's index then (`thread.seenChanged` `through`, migration
  0045_thread_seen_through). `useNewSince` in thread-view.tsx captures it as a chat thread opens
  in the main view while `seen` is false, and the conversation draws the line before the first
  entry after it, opens there once (`useStickToBottom`'s `hold` keeps the stream from pulling it
  down) and keeps it until a turn starts or the thread is left. It is no item, so Find and the
  export do not see it. Shift+End (`keybindings.jumpToNew`, palette "Go to what is new", offered
  while `conversationStore.hasNew`) goes to it.
- **Outline and marks** (chat overview spec 21 to 23). `thread.markItem {threadId, itemId,
marked}` patches `marked` onto a user or assistant message's payload (`threadItem.patched`),
  so the mark lives with the message: a fork copies it and an earlier version keeps it. The
  conversation shows a bookmark sign and Mark / Unmark on hover; the handle it registers adds
  `isMarked`, `markFocused` (B, `keybindings.markMessage`), `previousMark` / `nextMark`
  (Alt+PageUp / Alt+PageDown) and `focusItem`. The panel tab `outline` (`chat/outline.tsx`,
  Details → Show outline, `keybindings.threadOutline`) lists `outlineRows`: each user message of
  a turn Edit did not replace, with its turn's summary, and the marked answers; a row calls
  `focusItem` on the conversation on screen.
- **Scroll and keys.** `useStickToBottom` in thread-view.tsx follows the stream; once the user
  scrolled up, new items show the "New output" pill, which or End (`keybindings.conversationEnd`,
  palette "Go to the newest output" while it shows) goes back down and follows again. End is a
  plain key, which the key listener leaves to text fields; the command sets `AppCommand.atTextEnd`,
  so it also runs from the composer once the caret is at the end of the text with nothing
  selected, where End would do nothing. User and
  assistant rows are focusable (`li[data-message]`); Alt+Up/Alt+Down
  (`keybindings.previousMessage`/`nextMessage`) move between them and C
  (`keybindings.copyMessage`) copies the focused one's text. The conversation on screen (not a
  step thread in the side panel) registers its handle with `showConversation`; the commands are
  `conversationCommands`. These keys are settings in the Chat scope, since Alt+Up/Down may clash
  with screen readers; the builder's rule keys get their own "Workflows" scope in the keybindings
  table so the shared keys are not reported as conflicts. E and F on a focused message are Edit
  and Fork (see "Edit and Fork").

### Find in the conversation and copy it

Thread work U1 (spec 1 to 9). No server contract: find and the export are built in the web app
from the rows the thread view already subscribes to, with the rows' own words, so what is found
and exported is what the conversation shows. Searching the page alone would miss closed rows.

- **Text.** `chat/find.ts` `conversationText(source)` walks the view's entries (after
  `groupToolCalls` and `nestSubagentWork`, with an edited message's earlier versions already left
  out) and gives each shown item's text pieces in reading order, each with its row's item id and
  the open-state keys of what holds it. A message is its markdown parsed with GFM and turned into
  text (`markdownText`, mdast from `mdast-util-from-markdown` with the GFM extensions, the parse
  react-markdown uses), so `**kettle**` is found as "kettle"; a line break inside a paragraph
  reads as the space it shows as, a hard break as a new line, and a picture as the link it is
  drawn as (its alt text, else its address). Tool rows give their line
  (`toolLine` in `conversation-markdown.ts`, without times), an MCP call's arguments as key: value,
  an edit's diff lines, and their whole output, the earlier lines (before the last
  `chat.toolOutputLines`) as a piece of their own that also opens "Show all N lines". Reasoning,
  a subagent's prompt, nested rows and answer, approval and plan cards (summary, command, diff,
  address, tool, plan text, note), question cards, error, divider and compaction lines and task
  lists are text too. The questions of one ask card count in the card's single row (the
  entry's id). Never matched: the JSON behind Show JSON or Details, tool input otherwise,
  usage rows, the composer, earlier versions. The streaming message is parsed again as it grows;
  the others are kept per item while the bar is open.
- **Matching.** `findMatches(pieces, query, limit)` folds case for every letter (`foldCase` keeps
  each character's place) and stops at `chat.findMaxMatches` (1000); the bar then reads "1000+",
  else "3 of 12" or "No matches" (`findCountText`). The current match is kept as (item id, nth
  match of that row) and found again after every change (`keepCurrent`), so a streaming turn
  grows the count without moving it (spec 5); only a move by the user scrolls.
- **Opening.** Rows keep their open state in the conversation's store (`chat/open-state.ts`,
  `createOpenStore` per thread on screen, `OpenStoreContext`, `useOpenState(key)`): a tool row
  (`row:`), a group (`group:` with its first call's id), reasoning (`reasoning:`), a subagent's
  list (`agent:`), a subagent's whole prompt (`prompt:`, four lines until opened), an output's earlier lines (`output:`, through `OutputKeyContext` from the row)
  and a task list update (`tasks:`). A click sets it, and so does find, once per match it lands
  on, so what find opened stays open as if opened by hand. Reasoning remounts when find opens it
  and Ctrl+O still opens or closes all of it. A row outside a conversation keeps its own state.
- **Marking.** `chat/find-bar.tsx` (loaded on first use, with the parser) marks matches with the
  CSS Custom Highlight API (`wow-find`, `wow-find-current`, colours `--find-match` and
  `--find-current` in `tokens.css`) over the text nodes of the rows that hold matches (not a
  nested row's, not button words), never by rewriting the markup. It paints after every commit
  and, through a `MutationObserver`, when lazily rendered text arrives. Where the API is missing
  (jsdom) the current match's row is outlined (`data-find-outline`); the row always carries
  `data-find-current`. The marks search the row's text on screen again (line breaks in rendered
  Markdown outside `<pre>` read as spaces), which can hold words find does not count (a time, a
  heading button's words); when a row's marks and its counted matches differ in number, the
  current match's row is outlined instead of marking an occurrence that may not be the counted
  one.
- **Bar and keys.** Ctrl+F (`keybindings.findInConversation`, Mod+F) opens the bar above the
  conversation with its field focused from anywhere in the view, composer included (a Mod key
  works in text fields); pressed again it selects the field. Enter and Shift+Enter are the field's
  own; F3 and Shift+F3 (`keybindings.findNext`, `keybindings.findPrevious`) work from anywhere and
  open the bar on the last search when it is closed. Escape closes it and gives the focus back to
  where it was, else the composer. Palette ids `chat.find`, `chat.findNext`, `chat.findPrevious`.
  The keys are in the keybindings table's Chat scope.
- **Where.** The conversation registers `ConversationHandle.find` only for a chat thread in the
  chat view (a step's thread opened there included): not the Assistant view, whose rows are its
  own and which holds secret-field and change cards, and not a step's thread in the side panel.
- **Export.** `chat/conversation-markdown.ts` `conversationMarkdown(input)`: the title as a
  heading, one facts line (instance name, model label, project, folder, branch), "Exported
  <time>", then "You · 20:41" and "<instance name> · 20:42" headings (the turn's start, and its
  end for the agent) with each message as written (the `@path` line kept, images as
  `[image: <name>]`, skills as "Skills: a, b") and one list line per tool call, approval, plan,
  question, error, divider, compaction, task list update, commit, opened request (with its
  address) and stopped turn, worded as the rows
  (`toolLine`, `approvalLine`, `questionLine`, `taskLine`, `settingsChangeText`,
  `compactionText`): "$ pnpm test · exit 1 · 4.2 s", "Allowed once: $ pnpm test", "Denied: $ rm
  -rf build · note: keep the build". A row's words (and the title) go on one line: a line break
  and the space around it become one space, so a heredoc or a long error cannot spread out and
  read as headings of its own. A subagent call is its line and its answer as a quote. No
  tool output or input, no usage, no queued message, no earlier version; reasoning only with
  `chat.exportReasoning`. Palette `chat.copyMarkdown` and `chat.saveMarkdown`, and the thread
  header's "More thread actions" menu (a shadcn `dropdown-menu`).
- **Saving.** The shell that shows the dialog writes the file; the server gets no RPC that writes
  to a path a client names. `Runtime.saveTextFile` (bootstrap, from the preload's
  `wowDesktop.saveTextFile`) sends `SaveTextFileRequest {suggestedName, text}` (contracts
  `desktop-files.ts`) on `wow:save-text-file` (`fileChannels` in `apps/desktop/src/app.ts`). The
  main process answers only `wow://app` pages, as for `wow:pick-folder`
  (`apps/desktop/src/main/save-text-file.ts`): it cuts the suggested name to a bare file name
  (cleaned again by the same rules as the page's, at most 200 characters before `.md`), shows
  `dialog.showSaveDialog` in the documents folder with a Markdown filter, writes UTF-8 without
  a byte order mark and answers the path, or null when cancelled; a request it cannot read
  throws, so the page says the conversation was not saved. The browser build has no
  `saveTextFile`, so `saveTextFile(runtime, file)` in `app/runtime.tsx` downloads a Blob
  instead. `exportFileName(title)` takes out what Windows refuses (`<>:"/\|?*` and control
  characters) and direction marks, cuts the title to 120 characters, drops trailing dots and
  spaces, and renames a device name, also one followed by a dot ("CON.backup").

### Restore files when going back

Thread work spec 19 to 26, U3. wow keeps the files of a chat thread's folder (not a step's thread,
not the Assistant) at each turn's start and end, so the user can put them back.

- **What is kept.** The store holds the contents of every tracked and untracked file Git does not
  ignore, as plain Git objects, unencrypted, for `chat.snapshotKeepDays` days. A file with a secret
  that is not in `.gitignore` is therefore copied into `<wow home>/snapshots`; `.gitignore`d files
  such as `.env` are not. `chat.snapshots` (project-scoped) turns snapshots off. The assistant has
  no tool that reads wow's home or any path (`assistant.test.ts`, "offer no tool that reads wow's
  home").
- **Store.** One bare repository of wow's per folder, `<wow home>/snapshots/<key>.git`, the key a
  hash of `folderKey` (so `C:\Code\Tea` and `c:/code/tea` share one). `files/snapshots.ts`
  (`FolderSnapshots`) runs everything for one folder one after the other (`#serial`), so a restore
  never meets a snapshot half taken and a preview waits for the end snapshot of a turn that just
  ended. The snapshot is recorded inside that task, before it resolves, so whatever is queued
  after it reads the recorded state; only the expiry follows outside it. `stop()` waits for every
  snapshot, its record and the expiry after it that is in flight and starts none after; `ProviderService.stop()` calls it (after waiting for the turns being
  prepared) and so does the server's stop, before the database closes. The plumbing is in
  `projects/git.ts` (`runStoreGit`, `readSnapshotRepository`,
  `listSnapshotFiles`, `hashSnapshotFiles`, `writeSnapshotTree`, `updateSnapshotRefs`,
  `readSnapshotTree`, `readSnapshotBlobs`, `pruneSnapshotStore`): with `GIT_DIR` (and for a tree a
  temporary `GIT_INDEX_FILE`) set to wow's store and every other variable that could point git
  elsewhere removed, with hooks and the file system monitor off and `gc.auto=0`, each limited by
  `chat.snapshotTimeoutMs` and stopped with `advanced.gitStopWaitMs` like `runGit`. Only
  `rev-parse --is-inside-work-tree` and `ls-files --cached --others --exclude-standard -z` run in
  the user's repository, and both only read: no object, ref, index entry, stash or HEAD change is
  ever written there.
- **Taking one.** `take(threadId, turnId, 'start' | 'end')`: the listed files (over
  `chat.snapshotMaxFiles` gives none), `lstat` each, `chat.snapshotReadsAtOnce` side by side: a link is kept as its own text (mode
  120000, never followed), a file over `chat.snapshotMaxFileBytes` is left out and named with its
  size in `omitted`, a name with a line break or one this system cannot write back is left out
  too. Files whose size, time and mode match the store's `wow-manifest.json` and whose time is
  before the last read began (Git's "racily clean" rule, measured with a scratch file's time) keep
  their blob; the rest go through `hash-object --no-filters -w --stdin-paths` (exact bytes, CRLF
  kept, no filter). `update-index --index-info` and `write-tree` make the tree, which the
  manifest names as `tree`; each snapshot logs its file count, how many were hashed and its time.
  A ref
  `refs/turns/<sha of turn id>-<start|end>` keeps it. The executable bit is read where the system
  has one; on Windows a file keeps the mode it had in the last snapshot. The result is recorded
  with the internal `thread.snapshotTaken {threadId, turnId, at, snapshot}` (event
  `turn.snapshotTaken`) as `TurnSnapshot {tree, files, omitted, at}` or `{missing}` with the
  reason in words (snapshots off by the project's `chat.snapshots`, not in Git, too many files,
  out of time). The turns topic says only `Turn.restorable` (the start is a snapshot); the trees
  stay on the server.
- **When.** The provider service takes the start in `#chatTurn` after the thread's working copy
  is ready and before `#marked`, awaited, so it is part of the start later commands for the thread
  wait for; it never fails the turn. The end is taken on `turn.ended` (joined to the folder's queue
  in the same commit, added to `#preparing` so `idle()` covers it).
- **Preview and restore.** `threads.restorePreview` answers `RestorePreview {status, message,
write, remove, outside, outsideUnknown, notRestorable, leftAlone}`; a refusal is a `status` (`noRepository`,
  `gitUnavailable`, `noSnapshot`, `turnRunning`, `outside`, `notChat`) with its reason. It takes
  a snapshot of the folder now and compares trees: `write` the target's files that differ or are
  missing, `remove` the files now that the target did not have and that the thread left (they
  are in the reference snapshot below; except ones left out of the target for size),
  `leftAlone` `{path, reason}` the files the restore would otherwise have touched and does not: a
  file listed then and ignored now (`ignoredNow`: ignored files are never touched) and a file now
  that is in neither the target nor the thread's reference, such as one Git lists only since
  `.gitignore` changed (`notFromThread`: it is not wow's to delete), and a file over
  `chat.snapshotMaxFileBytes` now (`tooLarge`: no snapshot holds its bytes, so it is never
  deleted or overwritten, since Undo could not bring it back), `notRestorable` the target's `omitted`, and `outside` the touched files that differ
  from the thread's own last state: its last restore's `after` when that came after the last
  turn's end, else the last turn's end snapshot. When there is none (the last turn has no end
  snapshot, or a restore recorded no `after`), wow cannot tell: every touched file is in `outside`
  (so the confirm reads "Restore anyway") and `outsideUnknown` is true, which the confirm says.
  Any write or remove path with `..`, a full
  path, `.git` (on Windows also its 8.3 short name `git~<digits>`), a name Windows does not take (on Windows), or a folder on the way that is a link
  or junction refuses the whole restore (`outside`). `thread.restoreFiles {threadId, turnId,
confirmed}` and `thread.undoRestore {threadId, itemId, confirmed}` are taken by the RPC
  `dispatch` handler before the engine (the engine alone refuses them, so the assistant and a
  setup file cannot restore): `FolderSnapshots.restore` prepares again and answers `conflict` with
  the new preview as `data` when `confirmed.outside` or `confirmed.notRestorable` differ. It keeps
  the folder as it is now under `refs/trees/<tree>`, reads blobs with `cat-file --batch` (in parts
  of about `chat.snapshotMaxFileBytes`), deletes, removes folders a delete leaves empty, writes
  with `node:fs` (a link is replaced, never written through; the executable bit set where the
  system has one; a link's target is written as the stored bytes, not as text), lists what the
  system refused (a file held open on Windows) and goes on, then snapshots the result and prunes
  the store of the trees only previews made. The internal `thread.filesRestored {threadId, restore, before, after}`
  stores the line, item kind `files_restored` with `FilesRestoredItemPayload {toTurnId, written,
removed, failed, undoOf?, undoneBy?, edit?, at}` on the thread's last turn, and a
  `restore_points` row. Undo targets `before` and compares with `after`; it marks the original
  `undoneBy`. `undoableRestore` (contracts) offers Undo on the newest restore line that is not an
  undo, not undone, not Edit's, on the last turn, which is not running: a turn starting makes a
  new last turn, so Undo goes.
- **Edit.** `thread.editLast.restoreFiles {confirmed}` (refused when the replaced turn has no
  snapshot) puts `start.restoreFiles {toTurnId, confirmed}` on `turn.started`; the RPC handler
  checks the lists first and answers `conflict` before anything is decided. `#chatTurn` calls
  `restoreForEdit` before the start snapshot; a refusal, a change in the lists or a file that
  could not be written fails the turn with the reason and nothing is sent. Its line has
  `edit: true` and no Undo.
- **Expiry.** `expire()` (at start and after each end snapshot) drops each snapshot older than
  `chat.snapshotKeepDays` by the server's clock: its ref and old restore trees go,
  `git prune --expire=now` runs in the store, the manifest is removed only when its `tree` is no
  longer in the store (a manifest without one is removed; a kept tree keeps all its blobs), and `thread.snapshotsDropped {threadId,
turnIds, before}` sets those snapshots to `{missing}`, so the turns stop offering Restore.
  Turns stored before have none and offer none (spec 44).
- **Web.** `chat/restore.tsx`: `restoreStore` with `askRestore` (reads the preview),
  `confirmRestore` (sends the command; on `conflict` shows the server's new lists with "The files
  changed since"), `RestoreDialog` (outside first as "Changed outside this thread since its last
  turn", then "Too large to put back", "Written back", "Deleted"; "Restore anyway" when anything
  changed outside; the action button has the focus, so Enter confirms and Escape cancels),
  `FilesRestoredLine` and `restoreLineText` ("Files restored to before "…" · 2 written · 1
  deleted", Undo), `EditFilesChoice`. A restore bumps the Changes view's refresh. Thread view: the
  "Restore files to here" button on messages whose turn is restorable while no turn runs (Claude
  Code and Codex alike), `showRestore` in `chat/conversation-nav.ts` with palette
  `chat.restoreFiles` (R, `keybindings.restoreMessage`, on the focused message),
  `chat.undoRestore`, and `chat.edit.withFiles` while the composer holds an edit whose turn is
  restorable; Edit's notice then shows "Conversation only" / "Conversation and files" (default
  `chat.editRestoresFiles`), and sending with files opens the confirm before the edit goes.
- **Not taken.** Claude Code's `enableFileCheckpointing` / `rewindFiles` (Claude only, its file
  tools only). The restore line is not in find or the Markdown export.

Tests: `apps/server/src/files/snapshots.test.ts` (real repositories: tracked, untracked, ignored,
CRLF, executable bit, links, the size limit, outside changes, commits after the turn, Undo, Edit
before the mock gets the message and a failing restore sending nothing, expiry by an injected
clock, the path rules for Windows), `apps/web/src/chat/restore.test.tsx`, and the e2e case
"restores files to before a message and undoes it" in `changes.spec.ts` (project `tea-chat`,
seeded with `docs/old.md`; the mock agent's "add the notes" adds `docs/notes.md` and deletes it).

### Commit and pull request from a thread's Changes

Thread work spec 27 to 36. A chat thread's Changes view (never a step's, never the assistant's)
has "Commit…" (`keybindings.commitChanges`, Mod+Shift+K, palette `chat.commit`) and "Open pull
request…" ("Open merge request…" when the thread's link rules name a GitLab repository; palette
`chat.openPullRequest`, `chat.pushBranch`, `chat.propose`). The dialogs live in
`apps/web/src/chat/commit-dialog.tsx` and `pull-request-dialog.tsx`, mounted in the Changes view;
`keybindings.commitConfirm` (Mod+Enter) commits or opens there. The server side is
`apps/server/src/workspaces/thread-git.ts` (`ThreadGit`), reached only through the RPCs below.

- `threads.commitPlan {threadId}` answers `CommitPlan`: `git status --porcelain=v2 -z
--untracked-files=all --no-renames` (`readStatusFiles`) against HEAD, with line counts from
  `diff HEAD --numstat` (a new file's lines are counted when it is text and under
  `diff.maxFileBytes`), the branch, the hooks (`readCommitHooks`: the commit hooks found in the
  folder `rev-parse --git-path hooks` names, which follows `core.hooksPath`; executable ones only,
  except on Windows) and `operationInProgress` (`readOperationInProgress`: MERGE_HEAD,
  rebase-merge, rebase-apply, CHERRY_PICK_HEAD, REVERT_HEAD). A file is `inThread` when it is in
  the thread's own Changes (`readThreadDiff`) and its content equals the last turn's end snapshot
  (U3's store, `hash-object` compared with the snapshot tree), so a file the user changed after
  the turn is not ticked. The plan waits for snapshot work in flight first.
- `threads.commit {threadId, files, message, newBranch?}` answers `{sha, subject}` or `rejected`
  with `CommitRefusal {reason, output}`. `commitPaths` adds new files (`add
--pathspec-from-file`), then runs `commit -F <file> --pathspec-from-file=<file>
--pathspec-file-nul` with each path as `:(literal)…`, which commits only those paths and leaves
  anything else staged. On a refusal the new files are taken out of the index again. A folder on
  no branch gets `switch -c <newBranch>` first (checked with `check-ref-format`). Then the
  internal `thread.committed` adds a `committed` item (`CommittedItemPayload`) on the last turn.
- `threads.pullRequestPlan {threadId, target?}` answers `PullRequestPlan`: remote = the branch's
  upstream remote, else the folder's primary remote; host = the project's GitLab site when its
  remote is on it (`TrackerService.gitlabHost`), else its GitHub settings (`githubHost`); target =
  the given one, else `refs/remotes/<remote>/HEAD`, else main, master or the first remote branch;
  commits = `log <remote>/<target>..HEAD`. Refusals come before anything is pushed: no
  repository, no branch, no remote, `notSetUp` (with `missing`, the setting), no target, the
  branch is the target, `existing` (an open request for the branch: `findForBranch`, with how many
  commits the remote branch lacks), no commit ahead, `protected` (`branchProtected`), a running
  turn.
- `threads.openPullRequest {threadId, target, title, body, draft}` checks the plan again, pushes
  (`pushBranch`: `push --porcelain --set-upstream <remote> refs/heads/<b>:refs/heads/<b>`, never
  forced), then calls `HostAdapter.openChangeRequest`: GitHub `POST /repos/<o>/<r>/pulls`, GitLab
  `POST /projects/<id>/merge_requests` with a "Draft: " title for a draft. A host refusal is
  `rejected` with `PullRequestRefusal {reason, output, pushed: true}`. The internal
  `thread.changeRequestOpened` adds a `change_request_opened` item
  (`ChangeRequestOpenedItemPayload`) whose `HostItemRef` is what a chat link to the request would
  be, so its `HostChip` opens the same tab. `threads.pushBranch {threadId}` pushes new commits to
  an open request.
- `threads.propose {threadId, requestId, purpose, files?, target?}` fills
  `chat.commitMessageTemplate` (title, files, patch) or `chat.pullRequestTemplate` (title,
  commits, files, patch), the diff cut at `chat.proposalPatchMaxBytes`, and calls
  `ProviderService.propose`, which sends the ProviderCommand `propose {proposalId, cwd, prompt,
model, effort}` to the thread's instance with the thread's model and effort, bounded by
  `chat.proposalTimeoutMs`; `threads.cancelProposal {requestId}` sends `cancelProposal`. `cwd` is
  `<wow home>/proposals`, which must be empty. Claude Code: one turn, `tools: []`, no allowed
  tools, `settingSources: []`, no launch arguments, `mcpServers: {}` with `strictMcpConfig`,
  `persistSession: false`, every tool use denied. Codex: an ephemeral `thread/start` with the
  tools-only switches and no MCP server, read-only sandbox without network, approvals declined;
  its events stay in the adapter. The thread's turns, items and session do not change.

Hooks and credentials. `commitPaths` and `pushBranch` are the only git commands that run without
wow's `core.hooksPath` override (they keep `core.fsmonitor=false`) and never pass `--no-verify`;
they run in `hookGitEnvironment`: the user's environment with `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, no `GIT_ASKPASS`/`SSH_ASKPASS`, and
`GIT_SSH_COMMAND=ssh -o BatchMode=yes` when neither `GIT_SSH_COMMAND` nor `GIT_SSH` is set, and
with `-c core.askPass=` and `-c credential.interactive=never` so a helper named in the user's
config is never started either. They
keep the last `chat.commitOutputMaxBytes` of their output and are stopped after
`chat.commitTimeoutMs` / `chat.pushTimeoutMs`. A push that would ask for a password, passphrase or
host key fails and says to push once in a terminal; "could not read from remote repository" alone
is not taken for that. A commit that git reports as failed after HEAD moved (a post-commit hook
that did not finish) is reported as made, with a note, and the index is left as it is; the note
is kept on the `committed` item (`CommittedItemPayload.note`) and shown under its line. The new
files it staged are taken out again only when HEAD did not move. Each `CommitFile` carries a
`version` (`hashOf`, the digest the run Changes use, bounded by `diff.maxHashBytes`); Commit sends
the ticked files' versions back and refuses a file whose content changed since. A refused commit
from no branch switches the folder back to no branch (`leaveNewBranch`) and deletes the branch it
made, which holds nothing. wow never pushes the branch the
remote treats as its default, whatever the target. The host token is sent only in the host
request's header; it is in no git argument or environment. Only one commit or push per thread
runs at a time. The assistant has no tool for any of it (`thread.committed` and
`thread.changeRequestOpened` are server-only), and wow never amends, merges, rebases, pulls,
forces or deletes a branch, except the empty one it made for a commit that was then refused.

### Apply a thread's changes to the project folder

Parallel threads spec 1 to 10. A chat thread with its own working copy (`workingCopy.startSha`)
has "Apply to project folder…" in its Changes view (`keybindings.applyToProject`, Mod+Shift+A,
palette `chat.applyToProject`). The confirm and the line live in `apps/web/src/chat/apply.tsx`;
the line's words in `chat/git-lines.ts` (`appliedLineText`, `appliedText`), shared with Ctrl+F
and the Markdown export. The server side is `apps/server/src/workspaces/apply.ts` (`ThreadApply`),
reached only through the RPCs below; the engine refuses `thread.applyToProject` and
`thread.undoApply` sent to it alone, so the assistant and a setup file cannot apply.

- `threads.applyPreview {threadId}` answers `ApplyPreview`. It refuses (as `status`) a thread
  that is not a chat thread or has no copy, a running turn in the thread, a running turn in any
  thread whose `cwd` is the project folder (`projectBusy`, compared by `folderKey`), a missing
  folder, a project folder outside Git and a missing git. Otherwise it lists the copy's changes
  (`listChangedSince`: `git diff --name-only -z --no-renames <startSha>` and `ls-files --others
--exclude-standard`, over `chat.snapshotMaxFiles` refused), reads the start commit's tree and
  blobs from the copy's repository (`readFolderTree`, `readFolderBlobs`) and compares base,
  theirs (the copy) and ours (the project folder) as bytes: ours = theirs `same`, ours = base
  `write` or `delete`, both changed: `deletedThere`, `deletedHere`, `binary`, or a
  `git merge-file -p` of the three on scratch files under `<home>/apply-scratch`
  (`mergeFileBytes`) that is `merge` when Git reports no conflict and `conflict` otherwise. A
  link, a side over `chat.snapshotMaxFileBytes`, or a path `unsafeSnapshotPath` refuses or that
  leads through a link in either folder is left. `nothing` when no file would be written.
- `dispatch` takes `thread.applyToProject {threadId, confirmed}` before the engine and runs it in
  the project folder's snapshot queue (`FolderSnapshots.exclusive`), so it never meets a snapshot
  or restore of that folder half done. It plans again and answers `conflict` with the new
  preview as `data` when `applyConfirmedOf(preview)` differs from `confirmed`. Then it keeps the
  touched files as they are now as a tree in the project folder's snapshot store
  (`refs/applies/<ms>-<sha1 of the command id>/before`), writes and deletes with `node:fs`
  (empty folders a delete leaves go; the executable bit follows the copy where the system has
  one), keeps the result under `/after`, and records `thread.changesApplied {threadId,
applied}` (event `thread.changesApplied`, item `changes_applied` on the last turn, with
  `savedAs` naming the refs). Refs older than `chat.snapshotKeepDays` are dropped at the next
  apply into that folder.
- `thread.undoApply {threadId, itemId}`: only the thread's newest apply line, not undone
  (`undoableApply`). Each touched file whose content still matches `/after` (or is still absent)
  gets `/before` back, or is deleted when it had none; one changed since is listed in `left` as
  "changed since Apply". The undo line has `undoOf`, and the projector sets `undoneBy` on the
  apply line.

Apply writes no object, ref, index entry or HEAD in either repository, and runs `diff`,
`ls-files`, `ls-tree`, `cat-file` and `merge-file` only, with hooks and the file system monitor
off like every store command.

### What the session can use

Thread work U5 (spec 37 to 44). A chat thread's panel has a Tools tab with what the provider
reported for the thread's session: MCP servers with state, error, source, version, address and
tools, built-in tools, skills, slash commands, subagents, plugins and instruction files. wow only
shows reports; it never starts a session, a probe or an MCP server to fill the tab, since starting
Claude Code in a folder starts the servers a repository's `.mcp.json` names.

- **Contract.** `packages/contracts/src/session-tools.ts`: `SessionTools {reportedAt, complete,
mcpServers, builtInTools, skills, commands, agents, plugins, instructionFiles}` and
  `McpServerInfo {name, state, stateWord, error, source, version, address, tools [{name,
description, readOnly, destructive}]}`, `state` one of `connected`, `failed`, `needsAuth`,
  `pending`, `disabled`, `other`. Only named fields, every text and list bounded
  (`sessionToolsLimits`); `boundedSessionTools` cuts what an adapter read to fit. No field can
  hold a server's config, environment, headers or arguments (spec 41). ProviderEvent
  `sessionTools {threadId, tools}` (`tools` null: the session ended by itself), ProviderCommand `describeSession {threadId}` answering
  `SessionTools` or null without a live session. Topic `threadTools` (thread-scoped) with rows
  `ThreadTools {threadId, tools, source, live}`; RPC `threads.refreshTools {threadId}` answering
  `{outcome: changed | unchanged | noSession}`.
- **Claude Code** (`provider-claude/src/session-tools.ts`). At each `system/init` of a thread's
  session (not the assistant's tools-only one) the adapter reads the init message's tools, MCP
  servers (name, status, source), slash commands, skills, agents, plugins and `plugin_errors`,
  then completes it from the live query's `mcpServerStatus()`, `supportedCommands()` and
  `supportedAgents()` (the `ClaudeQuery` seam in `sdk.ts` declares both new calls) and emits
  `sessionTools`. A server's `config` gives only `address` (`mcpAddress`: an http or sse URL's
  scheme, host and port; the file name of a stdio command's program). `commandParts` decides the
  program before a command line is split, since a Windows path often has a space. Leading
  `NAME=value` words (a shell's way of setting the program's environment) are skipped and their
  values hidden like `env`'s; then a leading quoted part; for text that starts as a path, a path up to the first word ending in `.exe`,
  `.cmd`, `.bat`, `.com` or `.ps1`, or the whole text when only the part before the last
  separator has a space; else the first word. A plugin error reads as its `type` and `message`,
  leaving out the one Claude Code did not give. A failure's words and plugin errors pass
  `cleanReportedText`: the server's command and its program's path read as the program's file
  name, each argument written after the program in `command` is hidden, the configured URL reads
  as its origin and, written without its scheme, as its host, its path, query values, user,
  password and fragment are hidden (as written and percent-decoded; a malformed percent sequence
  is kept as written), its argument, environment and header values are hidden, every web address
  is cut to its origin, and a credential after Bearer, Basic or Token is hidden. Known limit:
  a value shorter than 4 characters is never hidden (it would hide parts of ordinary words). When a live call fails or does not
  answer within `providers.requestTimeoutMs`, the init message's names and states go out with
  `complete: false`. `system/commands_changed` replaces the commands, also when it arrives while
  the first list is being asked for. `describeSession` asks the same calls of the thread's live
  query, answers null when there is none or it has sent no init yet, and fails when the live
  calls fail (the init list alone would replace a complete one). The init message and the live
  answers come from the user's own Claude Code binary, so every list is read as unknown data: a
  missing list or one of another shape reads as empty and an entry without a string name is
  left out (`boundedSessionTools`'s `named` drops one too). Reading the Tools tab's list never
  fails the turn (an init it cannot read reports nothing), and a live answer it cannot read
  leaves the init list with `complete: false`; `#reportTools` catches what reads and completes
  the live answers, since its promise is not awaited and an unhandled rejection would end the
  server. Its final `#emit` is outside those tries, as every other emit of the adapter is.
- **Codex** (`provider-codex/src/adapter.ts`). `thread/start` and `thread/resume` answer
  `instructionSources` (added to the generator's `FIELDS` as `instructionSources?` and to
  `fingerprint.ts`); the adapter emits them as `instructionFiles` with `complete: false`.
  `describeSession` answers the loaded thread's list, else null. The generated protocol has no
  method that lists servers, tools or skills; none is added until a codex that defines one is
  generated and checked. The web app adds the servers and tools the thread's own `mcp` tool rows
  name, marked "Seen in this thread's tool calls", with a line that Codex reports no list.
- **Server.** `ProviderService` takes a `sessionTools` event out of the batch and dispatches the
  internal `thread.toolsReported {threadId, tools, source}` (`core/thread-tools.ts`), after the
  `assistant.secretPatterns` net has run over every free text of the report: each server's
  error, address, state word, source and version, every tool, skill, command and agent
  description, argument hints, agents' models, plugin versions and errors, and instruction file
  paths. Names are not netted: they identify the entry. It is stored
  only when the list (everything but `reportedAt`, compared by `sameSessionTools`) or its
  liveness changed, with the server's time; the assistant is refused. `tools: null` marks the
  stored list not live: at `recover()` (no session survives a restart), when the adapter emits
  `sessionTools` with `tools: null` (the Claude adapter does when Claude Code's stream of a
  session that reported a list ends without wow closing it), when an instance's adapter is
  released, when a thread moves to another instance, and when Refresh finds the
  session gone. `refreshTools(threadId)` asks the adapter only while the stored row is live and
  the instance's adapter exists; otherwise it answers `noSession` and sends nothing.
- **Web** (`panel/tools-tab.tsx`). Tab kind `tools` (`openTools`, `toolsTabId` in
  `panel/viewer.ts`), `ToolsTab` with the reported line ("Reported as the turn of 20:41 started"
  or "Reported on Refresh at …"), Refresh only while `live`, a filter over every section
  (`filterSessionTools`), counts per section, "Sign in from Claude Code: /mcp in a terminal" for a
  server that needs sign-in. `ToolsChip` in the thread header shows while a server failed or
  needs sign-in ("1 MCP server failed") and opens the tab. Details has a "Session tools" section
  with a summary and "Show session tools". Palette `chat.sessionTools` (Show or Hide session
  tools) and, with a live session, `chat.refreshTools`; no key and no setting. A thread stored
  before this change has no row and shows "No list yet" until its next turn. An assistant thread
  gets no tab, chip, Details link or command, even when opened at `/chat/<id>`.
- **Mocks.** `MockProviderAdapter` reports `mockClaudeSessionTools()` (tea-docs connected with two
  tools, tea-tracker failed with "spawn tea-tracker ENOENT", tea-cloud needing sign-in) at every
  turn of a Claude instance and `mockCodexSessionTools(cwd)` (the folder's `AGENTS.md`) for Codex;
  `describeSession` answers while the thread had a turn and no `closeThread`; a test sets
  `sessionTools` to change the report or to null for a session that is gone.

### Edit and Fork

Agent workbench spec 62, 63, 71, 74, U12. Both go back in the provider's conversation. Fork never
rewinds files; Edit does only when the user picks "Conversation and files" (thread work spec 21,
see "Restore files when going back").

- **Points.** The Claude adapter keeps the uuid of the running turn's newest message of the
  conversation itself (assistant or user messages with `parent_tool_use_id` null; a subagent's
  are not) and sends it as `resumePoint` on the turn's end. A turn that wrote nothing sends none,
  so a refused resume is not taken for a point. The decider stores it on the turn as
  `{sessionId, at}` with the session the thread had then (`turn.ended.resumePoint`); the turns
  topic only says `resumable`. Turns from before have none, so Edit and Fork are offered only
  after them.
- **Going back.** `Thread.goBack {resumeId, at, fork}` is set while the next turn goes back;
  `turnStarted` then sends `resumeId` and `goBack {at, fork}` (`startFrom` in core/threads.ts). The
  adapter closes the live session and opens one with `resume`, `resumeSessionAt: at` and, for a
  fork, `forkSession: true`; `at` null opens a new conversation with nothing resumed. `goBack`
  is cleared (`thread.goBackChanged`) only when a turn ends with a point, so a turn that failed
  before Claude Code wrote anything goes back again. A go-back Claude Code keeps refusing (its
  session file cleaned up, a point it no longer takes) would hold the thread there, so while the
  last turn failed and `goBack` is set the error row and the palette (`chat.dropGoBack`,
  `stopGoingBack` in chat/go-back.ts) offer `thread.dropGoBack {threadId}`, which clears it
  (refused while a turn runs or when nothing goes back): "Go on without going back" goes on in
  the thread's own session, the replaced exchange included for the agent; a fork, which has no
  session of its own yet, is offered "Start a new conversation". The mock gives no point to the
  failure it answers for a point it does not know, as Claude Code gives none.
- **Edit.** `thread.editLast {threadId, turnId, text, skills?, files?, attachments?}`
  (core/go-back.ts `editGoBack`): only for a chat thread, only for the last shown message, with
  no turn running. It goes back to the point of the shown turn before (a new conversation when
  there is none; forked when that point is in another session, a fork's copied turns) and starts
  the turn as `thread.sendMessage` would, then `turn.replaced {turnId, by}` marks the old turn.
  The web app hides a replaced turn's items and shows them as "Earlier version" on the message
  that replaced it (`goBackView` in chat/go-back.ts, `EarlierVersions` in items.tsx).
- **Fork.** `thread.create` with `forkFrom {threadId, turnId}` (`forkEvents`): a new chat thread
  on the origin's provider, project, folder, model, effort and mode, titled "<title> (fork)",
  with `forkedFrom` and a `goBack` to the turn's point with `fork: true`. `thread.historyCopied`
  copies the shown turns up to that one and their items with the new thread's ids (a subagent's
  `parentItemId` follows); approval and question cards stay in the origin, whose rows they need.
  Images are stored per thread, so once the fork has committed `ImageStore.copyForkImages` copies
  the copied messages' images into the fork's folder (synchronously, before the answer): the fork
  shows them and an edit there sends them. The header says "Forked from <title>".
- **Where not.** `providerChatOptions[kind].cannotGoBack` is null for Claude Code and a sentence
  for Codex, whose generated protocol has no fork or rollback; its adapter refuses `goBack`. The
  decider refuses both commands with that sentence; the web app offers no Edit or Fork button on
  Codex and lists the palette commands "Edit last message" and "Fork from here" with the sentence
  as their detail.
- **Keys.** Up in an empty composer (`keybindings.composerEditLast`, the composer's `onRecall`)
  and E on the focused last message (`keybindings.editMessage`, palette "Edit this message"; on
  any other message E does nothing) put the message back in the composer with its skills,
  files and images; the composer shows what sending does, that files stay as they are when that
  turn changed files (an `edit` tool row that ended ok), and Cancel. F on a focused message
  (`keybindings.forkMessage`, palette "Fork from this message", else "Fork from the last
  message") and "Fork from here" on a user message fork. The conversation registers what it can do
  with `showGoBack` (chat/conversation-nav.ts).
- **Mock.** The mock Claude Code (`MockProviderAdapter`) keeps each session's turns with a point
  each (`<session>:<n>`), answers a go-back by keeping the turns up to the point, starting a new
  session id for a fork or a new conversation, and says first what it still remembers
  (`keptMessagesText`); an unknown point fails the turn.
- **Skill list in chat.** `chatSkillSections` orders Yours, Project, Recently used (the skills
  this thread's messages carried, newest first, `recentSkillNames`), User, Plugins, Other and wow
  last; wow's four built-in skills carry "for workflow steps" (`isStepSkill`). On `/chat/new` the
  composer gets `listsBelow`, so the skill and file lists open under the box and leave the
  provider and project pickers in view.
- **Next that needs you.** `chat/needs-you.ts` `needsYouTargets` lists, from the subscribed rows,
  threads in `needs_you` (approval, question, plan card; at `Thread.stateSince`, which the
  projector sets when the thread's state changes and keeps through a rename, a change of model or
  mode, background work or a second approval; rows from before migration 0031 take their
  `updatedAt`) and pending assistant proposals, oldest first.
  Ctrl+Shift+J (`keybindings.nextNeedsYou`, palette "Next that needs you") navigates to the next
  after the one it went to last and sets a focus request; the approval card, question card, gate
  bar's Approve and the proposal card call `useNeedsYouFocus(key, ref)` and take the focus once
  they render, and `takeLanded` keeps the composer's autofocus from taking it back. Of a run's
  two gate bars (the run view's and the panel's copy) only the one that holds the note takes it:
  the run view's while it is on screen.

### Edits, approvals and a thread's Changes

Agent workbench spec 33 to 43, U6.

**Edits.** An edit carries a unified diff in wow's own field (`ToolFacts.diff`, hunks from the
first `@@`; several files each after a `--- a/<path>` / `+++ b/<path>` pair), made in the adapter.
Claude Code (`provider-claude/src/diff.ts`): when an Edit, MultiEdit or Write starts, its input
gives the diff as the old text's lines removed and the new text's added, without the file around
them (`replacedHunk`; a Write is all added lines, whether or not the file exists, so its facts
carry `diffWithoutFile: true` and the approval card and the row say "The new content only; the
file's current content is not shown."); when the result comes, its `structuredPatch`
gives the real hunks with line numbers and `toolCallCompleted.diff` replaces the first one (the
orchestrator then sets `diffWithoutFile: false`). wow does not read the file itself to draw a
pending Write. That
is the spec's fallback for an old text that cannot be placed in the file: the row then still shows
what was replaced. Codex (`fileChangeDiff` in `provider-codex/src/adapter.ts`): an update's `diff`
is unified already (anything before its first `@@` is cut); an added or deleted file's `diff` is
taken, as far as the schema says, as its content and drawn as all added or removed lines. The
server keeps at most `chat.editDiffMaxLines` lines of a diff in a row or approval and marks it
`diffCut`; a tool row also stores `diffCounts {added, removed}` of the whole diff, counted before
the cut. `chat/tools/edit.tsx` reads "Edit src/timer.ts +4 −1" (from `diffCounts` on the row, or
for a row stored before it `diffCounts` in `contracts/src/diff.ts` over the stored diff, which
counts by the hunk headers, so a removed line reading `--- x` is not a header) and opens to the
diff drawn with the run Changes tab's `DiffLines`, and Open file. Open file is
`ItemContext.openFile`, the conversation's `FileLinkContext` `open`: the file in a panel tab of
the view on screen, in the thread's scope, for a chat thread and a step's thread alike, Git or
not (see "Panel tabs and files in chat"). It is not offered for a file outside the thread's
folder (the path stays absolute), nor on an edit row that is not `ok` (running, failed or
denied) or an approval card that is pending or denied, whose file has not changed, nor in the Assistant view, which opens no files. An `edit` row without
a diff (stored before) is drawn as the generic row it was.

**Approvals in wow's words** (spec 36). `approvalRequested` carries `facts: ApprovalFacts` (the
tool facts of the call it would allow, an MCP tool's `arguments`, a plan's `plan`, and the
command prefix the provider proposed, `ruleHint`): Claude Code's from `claudeToolFacts` on the
request's tool and input (`tool` named for a tool that is not a command, an edit or MCP),
Codex's command request from its `command`, `cwd` and `proposedExecpolicyAmendment`, its file
change request from the item's changes. The orchestrator stores them on the approval item
(`ApprovalItemPayload.facts`), with `rule` (what "always allow" would store), `plan`, `byRule`,
`note`, `permissionMode` and `diffCut`; the approval row keeps its columns and takes the new
decision `allowAlways`. `chat/approval-card.tsx` draws a command as `$ <command>` with its folder,
an edit as its diff, a web address, a tool as `server › tool` with its arguments as `key: value`,
and the provider's JSON behind Details. An approval stored before has no facts and is drawn as it
was.

**Deny with a note** (spec 37). Deny (D) opens a one-line note ("No, and tell it what to do
instead"); Enter sends `approval.answer {decision: 'deny', note}`, an empty note denies without
one, Escape closes it. `approval.answered` carries the note and the provider service passes it in
`answerApproval {note}`: Claude Code's adapter answers `{behavior: 'deny', message: note}`. Codex
takes no message with a decline, so for a Codex thread the same decision also queues the note
(`thread.queueChanged`, see Queued messages) and asks for the turn to stop
(`turn.interruptRequested`); when the turn ends the note goes as the next message. A workflow
step's turn is not stopped, since that would stop the step: there the note waits for the turn's
end. The adapter declines as before.

**Always allow in this project** (spec 38 to 40). `proposeRule(kind, facts)` in
`contracts/src/approvals.ts` gives the rule: a command rule (`{kind: 'command', prefix}`) from the
provider's own prefix when it is one of the command's (Claude Code's `Bash(<prefix>:*)`
suggestion, Codex's exec policy amendment), else the first word and the second when it is not an
option (`pnpm test --watch` gives `pnpm test`); a tool rule (`{kind: 'tool', server, tool}`) for a
named tool. Edits, plans, a Codex permissions request and a command with `;`, `&`, `|`, `<`, `>`,
`` ` ``, `$`, brackets, a backslash, a quote or a line break get none, and neither does one whose
first word is a shell or a program that runs what it is handed (`bash`, `cmd`, `powershell`,
`env`, `sudo`, `xargs`, `busybox`, `npx`, …; such a rule would allow every later script), whose
first word sets a variable (`FOO=1 bash x.sh`), whose first two words are a runner (`pnpm exec`,
`pnpm dlx`, `npm exec`, `yarn dlx`, `uv run`, `deno eval`, …; for a package manager every word
counts, not only the first two, since options take values and some sub-commands forward
(`pnpm --filter web --silent exec`, `yarn workspace web exec`), and yarn, pnpm and bun naming a
shell or interpreter anywhere, `yarn bash`, get none; words after a `--` that follows a named
sub-command are not looked at, nor anything after `add`, `install`, `remove` and the like as the
first word, which takes package names), an interpreter followed by an option
(`node -e`, `python3.12 -c`, `python -m`, `tsx -e`; `node scripts/build.mjs` keeps its rule) or a
`find`/`fd` that runs a program for what it finds (`-exec`, `-exec=…`, `-execdir`, `-ok`, `-x`).
A program is named without its folder and without `.exe`, `.cmd`, `.bat`, `.com` or `.ps1`, so
`npx.cmd` is `npx`. None either for a thread without a
project or the assistant. The same test runs when a stored rule is matched, so an older rule
never answers such a command. Codex reports a command as the shell line it runs
(`/bin/zsh -lc '…'`, on Windows `cmd.exe /d /s /c "…"`, `powershell.exe -Command "…"` or a
quoted program path such as `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "…"`);
its adapter puts the command inside (`shellInner`) in `facts.command` and keeps the line in
`request`, so a rule made on Claude Code matches the same command on Codex. The card shows the rule ("Run commands starting with `pnpm test`",
`ruleText`) under its fourth choice, Y (`keybindings.approvalAllowAlways`). `allowAlways` appends
the rule with `addedAt` to the project's `approvals.alwaysAllow` (a `setting.changed` in the same
commit) and the provider hears `allowOnce`: wow keeps its rules itself and writes nothing to a
provider's settings. When a request arrives, the orchestrator compares it with the project's rules
(`ruleCovers`: a command matches the prefix by whole words and never when it has shell control
characters; a tool by server and name; case counts on every system, Windows too, although
Windows finds `Pnpm` as `pnpm`: a different case only asks again, and a rule never covers more
than its words say) and, when one covers it, stores the approval answered at once (`approval.answered {byRule: true}`, decision `allowOnce`) with `byRule` on its item: no
`needs_you`, no notification, and the provider service answers the adapter as for any answer. The
row reads "Allowed by rule: …". Settings → Approvals (`settings/always-allow-section.tsx`) lists
each project's rules with when they were added; Remove writes the list without it, so the next
request asks again. The assistant's proposal of a rule is U13's.

**Plan card** (spec 42, 43). Claude Code's `ExitPlanMode` reaches `canUseTool`; the adapter
reports it as an approval of kind `plan` with `facts.plan` when the input carries a `plan`
string. The SDK's input type declares none, so without it the orchestrator takes the turn's last
assistant text (`ReadModel.lastAssistantText`, or the text this batch streamed) and stores
`plan {text, from: 'conversation'}`, which the card labels "The plan as written in the
conversation". `chat/plan-card.tsx` renders the plan as markdown with "Start, accept edits"
(focused, so Enter takes it; `keybindings.planAcceptEdits`, 1), "Start, ask each time"
(`keybindings.planAskEachTime`, 2) and "Keep planning" (`keybindings.planKeepPlanning`, 3), which
opens the note. A start is `approval.answer {decision: 'allowOnce',
permissionMode: 'acceptEdits' | 'default'}` (any other mode, or a mode on another kind, is
refused); the orchestrator adds `thread.configured` with that mode so the bar shows it, and the
adapter allows with `updatedPermissions: [{type: 'setMode', mode, destination: 'session'}]` and
keeps the session's mode, so the configure that follows sends nothing. Keep planning denies with
the note. The card's choices are palette commands from `approvalCommands` (`chat.plan.*`).
Codex has no plan mode, so it never shows one.

**Palette.** The card of a thread's first pending approval (`ItemContext.keyedApproval`, from
`pendingApproval(approvals)` in `ThreadConversation`) writes its offer (approval id, kind, rule)
to `approvalCardStore`, whichever card mounted last; when the open thread and a step thread in
the context panel (`side`) both wait, the open thread's offer wins. `approvalCommands(offer)` (wired in `app/use-commands.ts`) gives Allow once,
Allow for this session, Always allow in this project (only with a rule) and Deny…, or the plan's
three choices. They replace the approval commands `chatCommands` had.

**A thread's Changes** (spec 34, 35). Before the provider service sends a chat thread's turn
(kind `chat`) it reads the folder through git (`FolderChanges`, see "A folder's changes"): the first turn records the base (`readRunBase`: the commit and what already
differed), every turn the changed files' hashes as it begins (`snapshotChanges`), and reports
them as `thread.changesMarked {threadId, turnId, base, mark}` (stored as `threads.base_sha`,
`base_files` and `turns.file_mark`, migration `0029_thread_changes`); then it sends the turn.
The `turn.started` before it is already published, so the projection of `thread.changesMarked`
publishes the `turns` topic, whose `Turn.marked` says the turn has a mark (the mark itself is
not sent); `useThreadDiff` reads `threads.diff` again when a turn starts, is marked or ends, so
the first turn's Changes and "This turn only" do not wait for the turn's end.
Git that cannot say leaves them null and the turn goes as usual. A thread stored before has turns
and no base and gets none later, so its Changes say so. `threads.diff {threadId, path?}` answers
`ThreadDiff` (`RunDiff` plus `turnPaths`) from `readThreadDiff` in `workflows/changes.ts`: the
folder against the base commit, without a file that already differed then and is unchanged
since, and `turnPaths` the listed files whose content differs from the last turn's mark (null
without a mark). A file that differed before the thread and changed again shows its whole diff
against the commit, and "This turn only" narrows the list, not a file's diff, since no content is
kept at a mark. `chat/thread-changes.tsx` is the view (`ThreadChanges`, opened with
`openThreadChanges(context, threadId, from, path?)` as a panel tab of kind `changes`, id
`changes:<threadId>`, of the route `from`; Back to details or the panel's close key closes it,
and Show changes while it is the selected tab closes it too), the header chip
(`ThreadChangesChip`: "+42 −7 in 5 files", hidden when nothing changed or nothing can be
compared) and the palette's Show changes (`keybindings.threadChanges`, Mod+Shift+D) and "This
turn only" (`keybindings.changesStepOnly`, O, while open). Both read again when a turn of the
thread starts or ends and on Refresh. A step's thread has no chip: its run has the Changes tab.

Tests: `packages/provider-claude/src/index.test.ts` ("draws an Edit as a diff…", "sends the note
of a denial…", "asks to leave plan mode…", "shows an MCP request…"), `tools.test.ts`,
`packages/provider-codex/src/adapter.test.ts` (`fileChangeDiff`, "shows a command request with
its folder…"), `packages/contracts/src/approvals.test.ts`, `apps/server/src/providers/approvals.test.ts`
(facts and cut diffs, notes on both providers, rules across threads and providers and after
removal, no rule without a project, plans, base and marks, outside Git, old threads),
`apps/web/src/chat/approvals.test.tsx`, and the e2e cases "approves an edit seen as a diff",
"denies with a note", "always allows a command in this project", "starts from a plan" in
`chat.spec.ts` and "lists a thread's changes" in `changes.spec.ts` (project `tea-chat`, a
repository of its own in the Changes copy). The mock agent answers "edit the timer", "edit the
bell", "watch the tests", "run the tests once" and "plan the work"; its Codex declines a denial
with a note without a message and goes on until stopped.

### Thread list, unread and chat notifications

The thread list is the app's left side (`chat/thread-list.tsx`, rendered by `app/sidebar.tsx`;
orchestrator threads spec 30 to 33). It lists main threads only: a helper (`parentThreadId` set)
is no row. A row has the title, the project's name or "No project" under it
(`chat/thread-row.ts`), and a status mark. The status is `Thread.listStatus`
(`ThreadListStatus`), which the server adds to each main thread when it sends the `threads`
topic (`core/thread-list.ts`, read in `core/subscriptions.ts`): `waits_for_you` when the
thread needs the user itself or holds a gate card whose approval or question is still open
(unanswered, and the turn that asked it still running, as in the decision queue; every request
for the user from any depth is drawn there), `working` when it or any helper under it works,
`unread` when `seen` is false, else `done`. A change to approvals or questions sends
the `threads` topic again, since answering a gate card changes no thread row by itself. The
mark for "Waits for you" is an exclamation mark in a ring of `--state-needs-you`; Working is a
pulsing dot of `--state-working`, Unread a dot of `--primary`, Done a hollow dot. Below 1280 px
(`useBelow('list')`) the list is a 3rem rail (`data-rail`): each row shows only its mark, with
its title, project, Failed and Archived as its hover title and for screen readers, and the
filter, the chips and the row buttons are hidden, so a narrow window keeps the room
`panel/model.ts` `overlayCap` counts on. While the filter has text, a project is picked, rows are
picked, or "Filter threads" asked for the field, the list is whole again, so nothing that narrows
it is out of sight.
`chat/thread-sections.ts` orders the rows by status, Waits for you, Working, Unread, Done, and
within a status pinned threads first, then the newest `updatedAt`. "Next unread thread" walks
the same order. There are no groups; migration `0049_retire_thread_list_groups` deletes the stored
values of the settings the groups and the second line had. On every scheduler tick
`core/archive-by-age.ts` archives, with the ordinary `thread.setArchived`, each chat thread that
is done, not pinned, not a step's and not active for `chat.doneArchiveDays` days (0: never).

The app opens on `/chat`. At the bottom of the list one Settings button opens a shadcn
`DropdownMenu` with Calendar, Backlog, Workflows and Settings; each opens its page in the main
area, and their palette commands and keybindings stay. On those pages Escape that nothing else
handled (no dialog or menu open, not in a field) goes back to the thread that was open last, or
to `/chat` (`useEscapeToThread`).

Each row is the trigger of a shadcn `ContextMenu` (`chat/row-menu.tsx`, chat overview spec 13 to 16) with Open, Open in panel, the row's actions from `chat/row-actions.ts` (`rowMenuActions`:
pin, unpin, mark done, reopen, archive, unarchive, each where `refusal` finds no reason against
it), Rename and Mark unread; Pin and Archive also sit at the row's right on hover or focus, out of
the tab order. Ctrl+click and Space pick or unpick a row, Shift+click and Shift+arrows pick from
the anchor (`threadListStore.picked`, `anchor`), Escape clears. While rows are picked, the
`PickedBar` over the list offers the actions at least one of them takes; `runBulk` sends one
ordinary command per thread that takes it, says what it skipped and why ("Skipped 1 is
working."), and an archive offers Undo, which unarchives the same threads. There is no bulk
command on the server.

The list has a filter field on top (`keybindings.threadFilter`, Ctrl+Shift+F anywhere, and
`keybindings.threadFilterInList`, `/` while the list has the keyboard) and, when threads sit in
more than one project, a chip per project. The filter matches titles and project names in the
app at once and asks the server `threads.search` (`core/thread-search.ts`) for the rest: every
typed word must be in the title, the project's name or the text of a user or assistant message,
which SQLite searches with `LIKE` over `wow_lower(text)`, a function `openDatabase` registers
so case is ignored for every letter, not only ASCII ones. SQLite refuses a `LIKE` pattern over
50,000 bytes, so a text longer than `chat.threadSearchMaxLength` characters (at most 10,000) is
answered with no threads rather than searched; the list still matches titles and projects. The question is asked again when the
threads topic changes or the connection opens again, and a failed search says so under the
field (`chat/thread-search.ts`). Archived threads
show only for a filter, marked "Archived". Arrow keys move between rows, Enter opens one, and
Enter in the filter opens the first. The list's state (filter, chip, which title is being
edited, a focus request) is a zustand store in `chat/thread-commands.ts`, beside the palette
commands Filter threads, Rename thread (`keybindings.renameThread`, F2, which like every
function key also works in a text field), Archive thread or Unarchive thread, Mark unread and
Next unread thread (`keybindings.nextBoldThread`, Alt+Shift+Down), "Show threads of <project>"
while there are chips, and "Show threads of all projects" while one is picked. A picked project
that is no longer among the chips (`pickedProject`: its last thread left, or only one project has
threads, so there are no chips) narrows nothing, since nothing on screen could undo it. The palette's thread entries
carry the project name as a keyword and say "Archived" for an archived thread, which is
`searchOnly` (no `recentAt`), so the palette lists it only once something is typed. The palette asks
`threads.search` for its text as well (`usePaletteThreadSearch`, into the `paletteThreadHits`
store): a thread found there gets `foundBy` (the text), which `paletteScore` matches below any
match in the command's own words; such an item gets a new React key, since cmdk scores an item
only when it mounts or the text changes. The header's
title (`chat/thread-title.tsx`) is a button that edits it.

`thread.rename {threadId, title}` stores `thread.renamed` (an empty title is refused, and so is
one longer than `chat.threadTitleMaxLength` characters, with a sentence that says both lengths);
`thread.setArchived {threadId, archived}` stores `thread.archived` and refuses a workflow step's
thread, which belongs to its run; there is no delete. `thread.markSeen` and
`thread.markUnread` store `thread.seenChanged`. None of them changes `updatedAt`, so the list
keeps its order. The server sets `seen` false itself when a turn ends or a thread starts to need
the user (an approval or a question), for every thread but the assistant's. A turn starting
(`thread.sendMessage`, or `turnStartedByProvider` after background work) or an approval or a
question arriving in an archived thread stores `thread.archived {archived: false}` with it, once
per batch, so the thread, its unread mark and its notification are back in the list (coordinator
decision; a thread archived while its turn runs stays archived when that turn ends). The web app sends
`thread.markSeen` when the open thread is on screen in a focused window and is unread, once per
`updatedAt` while it stays open, and again each time it turns from read to unread on screen (a
second approval or question in a thread that already needs the user is stored unread without
moving `updatedAt`): so a turn ending or a request arriving while the user watches leaves it read, and
"Mark unread" (which then leaves for `/chat`) keeps it bold until the thread is opened again;
leaving the thread forgets the handled `updatedAt`, so opening it again reads it. Unread rows are bold
with a dot.

Chat notifications are stored by the server in the same `decideProviderEvents` pass, for
threads that are neither a step's nor the assistant's, following `chat.notifications` (`off`,
`needsYou`, `needsYouAndFinished`, the default): "Needs you: <thread>" with the request's summary
as the body, when an approval or a question arrives (one per approval, one per ask; id
`<threadId>:needs-you:<approval or question:<ask>>`, `kind` `waiting`, `approvalId` set for an
approval), and "Finished: <thread>" (`kind` `finished`, id `<turnId>:finished`) when a turn that
ran longer than `chat.finishedAfterSeconds` completes or fails; a turn the user stopped tells
nothing. `path` is `/chat/<threadId>`. The web toaster and the desktop skip a row whose
`threadId` is the thread on screen in a focused window.

### Labels, keys and wording (agent workbench U14)

- **Models by label** (spec 86). `chat/model-label.tsx` has `modelLabel(models, id)` (the
  provider's label, else the id) and `ModelName {providerInstanceId, model, plain?}`, which reads
  `provider.listModels` through `useModels` and shows the id in a tooltip (`plain`: the
  browser's own `title`, for a place that is itself a button). The builder's step summary, the
  run view's step rows and the Assistant header use it; the conversation's settings dividers use
  `modelLabel`.
- **Keys** (spec 92). The section keys follow the order of `sections`; Ctrl+5 is Backlog
  (`keybindings.goBacklog`).
- **Palette** (spec 93). The palette (and the sessions dialog) sit at 12 % of the window's
  height instead of its middle, so the input stays put as the results change.
- **Wording** (spec 98). A run or card waiting at a gate reads "Waiting for you" (the Path tab's
  last row, the calendar's card state); the Ticket tab says where the key came from as "From the
  backlog item's Jira issue", "From the pull request's title" or "From the branch name"
  (`ticketSourceLabels`); the run view's own panel offers no "Open run" (`RunStepThread`
  `runOnScreen`); Claude Code's `dontAsk` mode is "Deny unless allowed"; a step under a second
  "Took under 1 s" (`tookText` in `lib/format.ts`).
- **Diagrams** (spec 99). `drawDiagram` sets the theme variable `edgeLabelBackground` to
  `transparent`, so an edge label has no box in either theme.

### A thread in the panel

Parallel threads spec 11 to 17. The topic `threadActivity` (`core/thread-activity.ts`,
`threadActivityRows`) is built from the stored rows each time it is read, like `decisions`: one
`ThreadActivity` per thread that is not the assistant's, not archived, and is `working`,
`needs_you` or has `seen` false. It carries the thread's last turn that Edit did not replace (its
state and times), how many tool calls that turn made, the payload of its newest running call
(`runningTool`) and the last non-empty line of its newest answer, cut at
`chat.activityTextMaxLength` (read from the settings table's global row). `Subscriptions` pushes
it whenever `threads`, `turns`, `threadItems` or `settings` change (`activitySources`).

The Threads at work page that read it is gone (orchestrator threads spec 34); the thread list's
status marks say the same per main thread.

A panel tab of kind `thread` (`ViewerThread {threadId, title, from}`, `openThreadTab`,
`threadTabId`) shows `panel/thread-tab.tsx`: the thread's `ThreadConversation` with `compact`,
as a step's thread is shown in the panel, and "Open thread". The tab strip names it by the
thread's current title. "Open thread in panel…" (`keybindings.openThreadInPanel`, Mod+Alt+O,
palette `chat.openThreadInPanel`) opens the palette with `paletteSearch` set to "In panel: ",
which lists the search-only commands `panel-thread.<id>` of every thread but the one on screen.

### Helper tools in a chat session

Agent orchestration U1 (spec 1, Interface, Security). A second MCP path on the wow port,
`/threads/mcp` (`helpers/endpoint.ts`, `HelperEndpoint`), answers wow's helper tools for ordinary
chat sessions through the same `answerMcp` as `/assistant/mcp` (`assistant/mcp.ts`). The provider
service asks `HelperEndpoint.grant(threadId)` in `#chatTurn`, after the start snapshot, and puts
the answer on the `startTurn` as `helperTools {name: 'wow', url, token}`. It answers for every
chat thread (`kind` chat), with or without a project, whose depth is below
`chat.helperDepth` (see "Helpers in depth" below), and only once the server listens. The token is made the first time a thread asks and is the
same for every turn of it for the server's life, because a provider's session keeps the server it
was opened with across turns; it is kept in memory only. A request is answered only with a token
`grant` made, compared in constant time, for the thread it was made for, and only while that
thread may still have the tools (asked again on every request), so lowering `chat.helperDepth`
refuses a helper's token at once. The assistant's token and the app's token open nothing here,
and a thread's token does not open `/assistant/mcp`. The project switch `chat.helpers` is gone
(orchestrator threads spec 3); migration `0047_retire_chat_helpers` deletes its stored values.

**Helpers in depth** (orchestrator threads U1, spec 4 to 10, 36). A thread's depth is derived
from its parent links (`helperDepth` in contracts `helpers.ts`; 0 for a main thread, a helper
stored before is 1) and never stored. A helper below `chat.helperDepth` (default 2) has the helper
tools and starts helpers as a main thread does; `decideHelper` refuses `helper.start` from a
thread at the limit, and every `helper.*` from a step's thread. A helper's end, failure or
question goes to the thread that started it (`parentThreadId`), not to the top of the chain.
`helperTree` lists every helper under a thread at any depth: `thread.interrupt` stops all that
run, and `refuseWhileHelpersWork` names every one that works, deepest first. Removing a thread's
working copy is refused while a helper under it works too (`Workspaces.removeThread`), since a
helper in the folder has no copy of its own and is not among the threads sharing it.
`chat.helpersPerTree` (8) counts the working helpers under one main thread at every level,
beside `chat.helpersPerThread` and `chat.helpersLive`. `start_helper` takes `folder` (absolute,
or relative to the starting thread's folder): `HelperTools` resolves it with `realpath`, refuses a
folder that is not there, and refuses one in wow's home unless the starting thread's own folder
is in wow's home (a working copy or thread folder) and holds it; it passes the folder on
`helper.start`. With `isolation: 'copy'` the copy is a worktree of the repository that holds the
folder (the starting thread's own when none is named), made from that repository's main worktree
(`readMainWorktree`: the parent of `git rev-parse --git-common-dir`). That is never a subfolder,
whose paths would not match the worktree's, and never another thread's working copy, which goes
when that thread is done. `thread.create` carries it as `copyFrom` with a branch from
`chat.helperBranch` (`wow/helper/{{id}}`); `ownCopyOf` makes the copy without a project if need be,
and `WorkingCopy.repository` records the repository. The workspaces service (`#copySource`)
makes, recovers and settles the worktree from it, and Apply brings its changes home to it.

**Bringing helpers' work together** (orchestrator threads U2, spec 6, 11 to 13). `read_helper`
also answers where a helper's work is (`HelperTools#whereWork`): its folder, the repository's main
worktree (`#repositoryOf`: `WorkingCopy.repository`, else `readMainWorktree` of the project's
folder for an older copy or of its folder, through `realpath`, so two names of one repository
compare equal), the branch it is on (`readCurrentBranch`, else the thread's branch), whether it
has a live copy (not removed or failed), and for a copy `ahead`, the commits since the copy's
`startSha` (`readCommitsAhead`, `git rev-list --count`). Only committed work is on a branch, so
the tool texts tell the agent to brief a copy helper to commit and to check `ahead`.
`merge_helpers {ids, title?, instance?, model?, effort?}` starts a merge helper through the same
path as `start_helper`: a copy helper of the caller, in a new copy of the repository the named
helpers' copies belong to. It merges the branch each helper is on now, which its agent may have
made itself, and its brief is `chat.mergeBrief` filled by `fillTemplate` with `{{branches}}` (one
`- <branch>` line each, in the order given) and `{{helpers}}`; a brief edited without
`{{branches}}` gets the list after it. The answer gives the commits on each branch, so a helper
that committed nothing shows a 0. It refuses, with the reason, fewer than two different helpers,
a helper that is not the caller's, one without a live copy, one on no branch, one that works, and
copies of more than one repository. wow runs no merge: the merge helper's agent merges with Git in
its own copy, so its Changes show the result and Apply brings it home to the repository. A merge helper, rather than
a worktree for the main thread, because a provider session stays in the folder it started in and
a Codex session writes only there (spec Decisions).

**Gates in the main thread** (orchestrator threads U3, spec 14 to 18). `HelperFollower` also
follows `approval.requested` of a helper and sends `helper.followed` with the reason `approval`
and its `approvalId`; `question.asked` keeps the reason `question`. `decideHelperFollow` decides
in steps: first, for an approval or a question that is not yet answered, a `gate_card` item
(`GateCardItemPayload`: the asking helper, the request's id and item, its title, instance,
provider, depth and the title of the thread that started it when that is not the main thread) on
the main thread's last turn, once per request; then, for a question only, the "From wow" message
to the thread that started the helper. An approval is never passed to an agent (spec 17). The
request stays in the helper's thread. The web app's `chat/gate-card.tsx` reads it from that
thread's own topics (`approvals`, `questions`, `threadItems`, all thread-scoped) and draws it with
the ordinary `ApprovalCard` or `ChatQuestions`, so Allow or a reply sends the same
`approval.answer` or `question.answer` as the helper's own card. `GateDock`, after the
conversation's items in `ThreadConversation`, draws every card still waiting: a request waits
while the helper's turn that asked runs, so one left by a stopped helper leaves the end. The
item's own place shows `GateCardLine`: who asks (title, provider, `depth N`, and "Helper of
<parent>" below the first level) and that the card waits at the end, "Answered in <helper>:
<decision or reply>" once it is answered anywhere, or that its turn ended without an answer.
Ctrl+F and the Markdown export use `gateRowText`. The card shows the request in the helper's own
folder and permission mode, has no Open file, and its `ItemContext.gate` keeps it from taking the
focus or the approval keys (`PlanCard` gets `quiet`), so typing in the main composer never
answers it (spec 15). A request is drawn once, matched by its id among the main thread's
`gate_card` items. Only the asking thread waits: the main thread's composer and its other helpers
go on.

**Main threads with the app tools** (orchestrator threads U4, spec 1, 2, 24, 26). `thread.create`
may leave out `cwd`: with a project the thread takes the project's folder, and with neither it
gets `<wow home>/threads/<threadId>` (`core/thread-folder.ts`, `threadFolderOf`). The provider
service makes that folder and, until a turn has reached the provider (the thread has a provider
session), fails the turn, naming what it found, when it is not empty (`prepareThreadFolder`), as
the assistant's own folder is kept empty; sending again does not get past it. A new thread
starts on `chat.defaultInstance` and, on that instance, `chat.defaultModel` (both global, empty
by default), before the project's, the last thread's and the instance's own; the pickers change
them before the first message. A new thread does not carry over the folder wow gave the last
thread, nor one its helpers or forks work in (`givenFolder`). The helper endpoint's provider in `server.ts` adds
`AssistantTools.forThread(threadId)` to the helper tools of a thread with no parent: every
assistant tool but the delegation, brief and memory tools (`mainThreadLeavesOut`), with the
readers' `threadId` set so `ask_questions` looks at that thread's running turn. The commands go to
the engine with the `assistant` origin, so the class table decides them exactly as for the
assistant: ordinary changes apply and record a change, changes that let the app do more on its
own become proposals. `thread.answerQuestions` takes a main thread's ask card as well as the
assistant's: the answer starts the next turn in that main thread, without the assistant's notes.
Standing permissions the user gave the assistant also cover a main thread's agent, and the
assistant's note about answered proposals and undone changes reads every record until U8 moves
the assistant thread. In the web app, `ThreadConversation` of a main thread uses `useAppToolRows`
(`assistant/app-tool-rows.tsx`, shared with the Assistant view): `placeRows` reads the record
ids out of the thread's own tool calls, and the change rows with Undo, proposals with Yes and No,
question cards and secret fields are drawn right after the call that made them.
**Helper threads** (agent orchestration U2, spec 2 to 8). `helpers/helper-tools.ts`
(`HelperTools`, the endpoint's `provider`) offers `start_helper`, `list_helpers`, `read_helper`,
`write_to_helper` and `stop_helper` to the thread whose token called. The reads come straight
from the stored rows: each helper's state, what its running call runs, a question it waits on, a
waiting approval named as the person's, and its last answer; `list_helpers` also names every
provider instance with whether it is connected. `start_helper` resolves an instance by id or
name, checks with `readSnapshotRepository` that the project is in Git for `isolation: 'copy'`,
and dispatches `helper.start`; `write_to_helper` and `stop_helper` dispatch `helper.write` and
`helper.stop`. They go to the engine with the origin `helper` (`CommandOrigin`), and
`decideInSteps` refuses `helper.*` from any other origin. `helpers/decide.ts` (`decideHelper`)
decides them in steps, as the assistant's delegation does: the starting thread must be a chat
thread (a helper below `chat.helperDepth` counts, see above); `chat.helpersPerThread` and `chat.helpersLive` count
helpers that work (state `working` or a running turn). `helper.start` decides the user's
`thread.create` on the named instance (refused unless its last test passed), with the main
thread's model and effort on the same instance or the instance's defaults, the mode
`helperPermissionMode` gives (contracts `helpers.ts`: the main thread's own mode on the same
provider, else the widest of the other provider's modes whose reach, 0 read to 4 no sandbox, is
not above the main thread's), and the main thread's `cwd`, or the project's with `ownWorkingCopy`
for `copy`; then `thread.helperStarted` (sets `parentThreadId` and `startedBy: 'helper'`), a
`helper_started` item (`HelperStartedItemPayload`) on the main thread's last turn, and the brief
through `thread.sendMessage`. `helper.write` is `thread.sendMessage` and `helper.stop`
`thread.interrupt`, for a helper of that main thread only. The read model's `helperThreads`
lists a main thread's helpers, or all.

**Workflows as text** (orchestrator threads U5, spec 19 to 23). A workflow is a `*.md` file in
`<wow home>/workflows` or a project's `.wow/workflows`. `@wow/skills` reads them
(`workflowRoots`, `scanWorkflows`) as skills of the sources `workflow` and `project-workflow`:
the front matter's name, else the file's, its description, and the whole file as `text`; they
are `manualOnly`. `SkillsService` scans and watches those folders with the skill folders, so the
`skills` topic carries them and the composer's `/` list offers them; `skillsForProject` shows a
project's workflows only in that project's threads and hides your own workflow of the same name
there. A picked workflow is a `SkillRef` with its source; `messageWithSkills` sends it through
`workflowToSend`: the thread's project's file of that name, else your own, filled into
`workflows.followTemplate` (`{{workflow}}`) as the skill's text before the user's words. The main
agent does the rest with its helper tools and `ask_questions`; there is no engine. At start,
before the skills scan, `exportStoredWorkflows` (`workflows/files.ts`) writes every stored
workflow once to `<wow home>/workflows` (`<name>.md`, else `<name>-1.md` and on, never over a
file), with each step's skill, instance, model, effort, `gate: after` and its rules as sentences;
the file `<wow home>/workflows-exported` marks it done. Settings › Workflows
(`settings/workflow-files-section.tsx`) lists the workflow skills with their place, opens one in
the editor (`workflowFiles.open`, only a file the list has) and makes a new one from
`workflows.newTemplate` (`workflowFiles.create`, refused when the file is there). The builder,
runs and triggers stay until U8.
**Following helpers** (U3, spec 3, 7). `helpers/follow.ts` (`HelperFollower`) listens for
`turn.ended` and `question.asked` of a thread with `startedBy: 'helper'` and, after the commit,
dispatches the internal `helper.followed {threadId, reason, questionId?}` (refused from the
assistant and the helper tools). `decideHelperFollow` turns it into the user's
`thread.sendMessage` to the main thread, so it waits in the queue while the main turn runs or is
handed to it where the provider takes that: "From wow: your helper "<title>" (id <id>, on
<instance>) ended its turn. Its answer: …" with the turn's answers, cut at
`chat.helperAnswerMaxLength`; "… failed: <the error item's message>"; or "… asks a question (id
<question id>): <request>" with a pointer to `answer_helper_question`. A turn that was stopped,
a question already answered and an approval tell nothing, so stopping a main thread never starts
it again. `answer_helper_question` dispatches `helper.answer`, decided as the user's
`question.answer` for a question of that main thread's helper only. `thread.interrupt` of a main
thread also interrupts the running turn of each of its helpers in the same commit;
`thread.setDone` and `thread.setArchived` of a main thread are refused while a helper works
(`refuseWhileHelpersWork`), and removing its working copy already is, since a helper in its
folder shares the copy.

**Seeing helpers** (U4, spec 10 to 12). The `helper_started` item draws as `chat/tools/helper.tsx`
(`HelperRow`): `helperRowText` ("Helper · Codex at work · Review the timer change", with "own
working copy" for `copy`), then the helper's state from `threads` and `threadActivity`: the
working line while it works, "Waits for you", "Failed", or its last line and when. The title and
"Open in panel" open it with `openThreadTab` in the view's panel, "Open thread" goes to it, and
Stop sends `thread.interrupt` while it works. `chat/helpers.ts` holds `helperRowText`, which
Ctrl+F and the Markdown export use too, and `nestHelpers`, which puts a helper right after its
main thread, one step in, when both are in the same list (a thread list group, a Threads at work
group), and names the main thread ("Helper of …") of a helper listed alone.

- Claude (`ClaudeAdapter#withHelperTools`): the session's own options stay (settings sources, the
  user's tools, servers and launch arguments, the permission mode) and `mcpServers` gets `wow`
  as an HTTP server with the token in its `Authorization` header; no `strictMcpConfig`, no
  `allowedTools`, so its tools are asked about by the session's mode like any tool. The session
  records `helperTools` (`url token`); a turn with another value or none closes it and opens a
  new one resuming the same conversation, as the assistant's session does for its instructions.
- Codex (`helperToolSettings`): `thread/start` and `thread/resume` get `config` with the dotted
  key `mcp_servers.wow`, as `codex -c` takes it, so the user's own `mcp_servers` from
  `config.toml` stay; nothing else of the thread changes. It is read when the codex thread starts
  or resumes, so a change applies from its next start. That a dotted key adds rather than
  replaces is read from codex's `-c` behaviour, not seen against the app-server
  (`docs/windows-smoke.md`, section 11).

## Workflow pages

The workflow builder, the run view with its review tabs, and the Runs and Triggers tabs are gone
(orchestrator threads spec 34): a workflow is a file (see "Workflows as text" and Settings ›
Workflows), started in a main thread or by a card. `/workflows` opens
Settings › Workflows. The server's workflow engine, runs and plans go in the second part of U8.

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
case (Scheduled, Running, Waiting for you, Done, Failed, Stopped, Missed); the calendar only
creates them `scheduled`, the scheduler and the card's run change it. Local cards are created by clicking (a
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
gives focus back to whatever had it when it opened. Its fields scroll inside the dialog and the
footer (Delete on the left, Cancel and Create card or Save card on the right) sits outside them,
so it stays in view in a 900 px window with a workflow and a repeat (agent workbench spec 83).
`keybindings.calendarSaveCard` (Mod+Enter) saves from any field; the form takes the key before
the app's own bindings (Approve shares it) can. From 1200 px the dialog is wider and "Run a
workflow" and Repeat sit side by side.

Repeating cards (recurring cards spec 11 to 17, `occurrences.ts`). The view reads
`calendar.occurrences` for the days it shows (`viewRange`: local midnight of the first day to
local midnight after the last, in the calendar's zone) through `useCalendarRange`, and reads
again whenever the `calendarItems` or `triggers` rows change; an answer for
another range is dropped. A read that is refused, or whose answer does not parse, is kept as an
error for that range: an error banner "Repeating cards could not be read" with Try again, which
reads once more. Single cards are still drawn from their topic rows, so nothing about
them changed; each occurrence of a repeating card becomes a block of its own
(`occurrenceBlocks`), a copy of the card with the occurrence's start and end and the id
`<cardId>@<date>`, so layout, roving focus and drag work on it unchanged. `TimeGrid` takes the
`occurrences` map (`ShownOccurrence`: card, day, `next`, `record`, state, run) beside the items.
An occurrence block carries a repeat icon (`data-repeating`) and "repeats" in its accessible name.
Its state comes from the server's record: a fired occurrence shows its run's state, otherwise
Failed, Missed or Skipped (`occurrenceStateLabels`); an occurrence without a record shows
Scheduled only when it is the trigger's next one or after the card's `nextAt` (both the server's
times), and nothing for a day that went by before the card existed. An occurrence is `fixed`
(`ShownOccurrence.fixed`) when it has a record, or lies before the card's `nextAt` and is not the
next one: it has started, so it cannot be moved or resized and Delete offers only the whole
series. A reached occurrence opens its run; any other opens the card form, with
`cardDialog.date` set when it is not fixed.
A drag or Alt+Up/Down sends `card.moveOccurrence` and stays within the occurrence's day (a move
to another day, by pointer or Alt+Left/Right, is not offered); the day is the one in the card's
zone, so with another calendar zone a drag or key stops at the card zone's midnight even inside
one calendar column. A drag that ends where it started sends nothing. The series takes the new
time.
A record that offers "Run now" puts the button on that block. When the answer's `more` names a
card, a banner (`occurrences-more`) says its first `calendar.maxOccurrences` are shown.

The card form has a **Repeat** fieldset (`repeat-section.tsx`, rules in `card-form.ts`:
`RepeatDraft`, `repeatRule`, `repeatDraft`). Interval and count are bounded by `repeatMaxInterval`
and `repeatMaxCount`, a last day before the card's date is refused, and a weekly rule starts with
the date's weekday chosen. The rule is said with contracts' `repeatRuleWords`, the same words the
assistant's change rows use, and a stored repeating trigger says "Fires next <day>, <time>" from
its `nextAt` (", as saved" while the form differs from the stored card). `card.update` sends
`repeat` only when the rule changed. For a repeating card, Delete asks "This occurrence"
(`card.skipOccurrence`, offered only when the form was opened from an occurrence; Undo sends
`card.update` with the skipped days as they were) or "The whole series" (`card.delete`, asking
about a live run as before; Undo sends `card.create` with `repeat` and `skippedDates`).
`keybindings.calendarDeleteCard` (Delete) on a focused card in the grid opens the form at that
question (`cardDialog.deleting`); for a single card it asks "Delete this card?". The context
panel lists a repeating card's rule in words.

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

No mail. The calendar shows meetings and cards only: the time grid takes the full width of the
view, and no topic, setting, command or key is about mail (spec 4, plan U18). Stores from before
that are cleaned by migration `0015_no_mail`: it drops `mail_items` and
`outlook_status.unread_count`, deletes stored values of the removed settings (`outlook.folders`,
the three mail rail settings and the rail's key), removes the mail fields from stored
`outlook.synced` events and deletes the receipts of `outlook.sync` commands, whose fingerprints
held the polled mail.

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

Palette commands: today, next, previous, day view, week view, zoom in, zoom out and reset zoom
(on the calendar only, with their keys), hide or show weekends,
New card, Refresh Outlook, one "Edit card" entry per card, and for a repeating card "Skip next
occurrence: <title>" (the day of its `nextAt` in the card's zone, with Undo) and "Delete series:
<title>", for any other card "Delete card: <title>"; both open the form at the delete question,
as the Delete key does.

## Context panel

`apps/web/src/panel` (owner decisions F-1, F-2). The right-hand panel shows the selected thing's
details next to the main view. What is selected comes from the route only
(`panelSelection(pathname, search)` in `model.ts`): `/calendar?item=`, `/chat/$threadId` and
`/backlog/$itemId`;
nothing is derived from the clock or kept in the browser. Every row it shows comes from the same
topics the views read.

- Calendar (`calendar-panel.tsx`): a card's time, state, project, workflow, trigger (`triggers`),
  thread (the card row's `threadId`, a link to it) and backlog item, with Edit card (the card
  dialog) and Run now when the trigger offers it. A meeting reuses `OutlookDetails`; the bridge
  reads no attendees, so none are shown.
- Backlog (`backlog-panel.tsx`): state, tags, the published issue (`remote`, a plain link; the
  publish flow stays in the item view) and the cards that plan it (links to `/calendar?item=`).
- Chat (`thread-panel.tsx`): provider instance, model (the instance's label from
  `provider.listModels`), effort, permission mode, project, folder (`PathText`), branch, usage
  summed over `turns` (`threadUsage`) with the last context report, and the card and backlog
  item it belongs to.
- No selection: a compact `EmptyState` that says what the view would show.
- File viewer (`file-viewer.tsx`, `viewer.ts`; review loop spec 6 to 9): a file opens in a tab
  of the panel (see "Panel tabs" below), not a second panel. `openFile` stores
  `{scope, path, fullPath, from, fullSize, read}` (`ViewerFile`) as a file tab of the route it was opened on and opens
  the panel; `read` is the kind and resolved path the server answered (`noteFileRead`), so the
  palette acts on the same file the header does. While its tab is selected (`shownFile`),
  `FileViewer` takes the place of the panel's body, so the main view stays put. It is UI state
  like an open dialog; the content is asked from the server with `files.read` each time the tab
  is shown and never kept. The header has Back to conversation (Back to details on a chat
  thread; both close the tab, so does Escape), Copy path (the path the server resolved, or the path
  as named until it has answered) and the path; markdown goes through `Markdown`, a picture is a `data:` URL fitted to the panel with a
  Full size switch, other text is a `CodeBlock` colored by its extension up to
  `viewer.highlightMaxBytes`, and a refusal shows the server's sentence. HTML is shown in an
  `iframe` from a string (`frameDocument`): `sandbox` without `allow-same-origin` gives the
  page no origin, so it cannot read the app, its storage or the disk, open windows or leave the
  frame, and `allow-scripts` is added only while `viewer.htmlScripts` is on. A policy placed
  before the file's own markup (`default-src 'none'`, pictures, fonts and media from `data:`
  only, inline styles, no scripts, no form targets, no `base`) stops every fetch from inside
  the page, so files beside it do not load. With the setting on the page is built by
  `scriptedFrameDocument` instead. The content policy does not govern WebRTC, which could send
  what the page holds to any address, so each inline script of the file gets a first line that
  deletes every `RTC…` global, and the policy allows exactly those scripts by their SHA-256
  hash, never `'unsafe-inline'`. A script in an attribute, behind a `javascript:` address, made
  by another script or in a nested frame therefore does not run unless it is one of the
  guarded ones, and a nested frame's window cannot be borrowed because it has another origin.
  `script` elements of a non-script type (JSON data) are left alone. The page could still
  navigate its own frame to another address; `frame-src 'none'` in `apps/web/index.html` stops
  that (a `srcdoc` frame still loads), and the e2e test checks that the mock port the page
  names gets no request and no datagram. While the focus is inside the frame its keys stay there; a click
  outside or Tab brings the app's shortcuts back. Palette commands (`viewerCommands`): Back
  to conversation, Copy file path while a file shows, and the picture's size switch once it is
  read as a picture.
  Panel tabs (`tabs.tsx`, `viewer.ts`; agent workbench spec 11 to 14, 87). The layout store's
  `panelTabs` keeps, per panel selection (`panelRoute` in `panel/model.ts`: a thread's
  `/chat/<id>`, a calendar card's `/calendar?item=<id>`, so each card has its own), the open
  tabs (`PanelTab`: a file, a linked item, Changes, tools, an outline or another thread; a file's
  id from the scope and the file's full path, with forward slashes, no `.` parts and in lower
  case for a Windows path, so `src/a.ts`, `./src/a.ts`, `src\a.ts` and the full path are one
  tab), the
  selected one (`DETAILS_TAB` for the panel's own body) and the tabs shown before (`history`). So a
  thread keeps its tabs while another thread is open, and each is read again when shown. While a
  route has tabs, `PanelTabStrip` shows the panel's own body first ("Details"), then a tab per
  item with an icon by kind and its short name; opening an open item
  selects its tab (`openTab`). Opening keeps the focus where it was and remembers it for that tab
  (`tabOpener(route, id)`): Escape there, outside a text field, closes the tab again while it is the
  one shown, as Escape does in the panel. A route whose last tab closes drops its `panelTabs` entry. Keys while
  the focus is in the panel, matched in the panel's own key handler: `keybindings.panelCloseTab`
  (Alt+W, since Ctrl+W closes a browser tab), `keybindings.panelNextTab` (Ctrl+Tab),
  `keybindings.panelPreviousTab` (Ctrl+Shift+Tab) and `keybindings.panelBackTab` (Alt+ArrowLeft;
  `backTab`, the tab shown before); the Keybindings page lists them "In the side panel". Closing
  the selected tab shows the one shown before it. Palette commands while tabs are open: "Close panel
  tab", "Next panel tab", "Previous panel tab", "Back to the panel tab shown before" (no key of
  their own, so their keys stay the panel's).

State (`panel-state.ts`). `appearance.contextPanel` stores whether it is open and
`appearance.contextPanelWidth` its width (pixels, bounds `contextPanelWidthBounds` in
`@wow/contracts`). The left edge is a `separator`: dragging previews the width and writes the
setting once on release (a click without a move writes nothing, so it does not store a capped width); the arrow keys (Shift for four steps), Home and End write it at once.
`lib/use-breakpoint.ts` holds the layout breakpoints (`breakpoints.narrow`, 1200 px) with
`useBelow` and `isBelow`; below `narrow` the panel never takes room: opening it sets the layout
store's `contextPanelPeek`, which lays it over the view (`data-overlay`, Escape closes it) and
leaves the setting alone. A run view whose run waits at a gate sets the same `contextPanelPeek`
in a wide window, where the panel then takes room as usual (shown when the setting or the peek is
on); closing the panel clears it, and so does leaving that run. Commands: "Toggle context panel" (`keybindings.toggleRightPanel`), "Focus
context panel" (`keybindings.focusContextPanel`, F6), which moves the focus into the panel
(opening it first) and back to the element it came from or the main view, and per view "Show in
panel" while the view has a selection. A focus request made from the palette waits in the layout
store (`contextPanelFocus`) and is taken in the palette's `onCloseAutoFocus`, because the dialog
would otherwise put the focus back where it was.

### Panel tabs and files in chat

Agent workbench spec 15 to 18, 56. A chat or step thread's conversation (`ThreadConversation`)
provides `FileLinkContext` (`components/file-links.tsx`), whose `open(path)` opens the file in a
panel tab of the route on screen with the thread's scope (`{threadId}`); the Assistant view
provides none, so it has no file links, Open buttons or `@`. The markdown renderer makes inline
code and relative link targets that pass `isFilePath` into `FileLink` buttons (click or Enter):
no spaces, no colon except a drive's, and a file extension or a slash; letters of any script and
`$` are allowed. A trailing `:line[:column]` or `#fragment` is cut off first (`filePathOf`), and
the bare path is what opens. The rule is narrow on
purpose; a miss opens a tab with the server's refusal ("There is no file …", "… is outside the
thread's folder and the project folder …"), never a read outside. The `urlTransform` keeps such
a relative target instead of dropping it; a picture's target still only shows as text.

A read row whose tool facts name a file (`ToolFacts.path`, which the adapters fill) has Open
(`OpenFileButton` in `panel/open-file-button.tsx`, spec 17, from `chat/tools/read.tsx`), with
the path shown relative to the thread's folder when it is inside; a path outside opens a tab
with the refusal. An edit row and an approval card have Open file instead (see "Edits,
approvals and a thread's Changes").

"Open file…" (`panel.openFile`, `keybindings.openFile`, Mod+P) is listed while a chat or step
thread is open (its folder) or a run view (the run's folder). It sets the layout store's
`openFileDialog`; `OpenFileDialog` (`panel/file-list.tsx`) asks `files.list` each time it opens
(`useFileList`), ranks the names with `filterFiles` (the typed letters in order, a match inside
the file's own name first, fewer breaks first, shorter paths first) and shows at most
`viewer.fileMatchesShown`, with a line when the list is cut or the folder had more files than
`viewer.fileListLimit`.

**Open in editor** (agent workbench spec 81, Interface). The server runs the editor, since it
owns subprocesses; this also works in the browser build. RPC `files.openInEditor` takes a
`FileScope`, a path and an optional line (`FileOpenInEditorParams`) and answers the full path it
opened. `apps/server/src/files/editor.ts`: `findEditorPath` applies the `files.read` rules (inside
a folder as written and after `realpath`; a folder is allowed, so `/open` opens the thread's
folder), `planEditor` splits `viewer.editorCommand` into words (`commandWords`: spaces split,
quotes keep a word together, a backslash is ordinary), fills `{path}` and `{line}` in one pass, so a `$` or `{line}` in a file's name stays as it is
(the path goes last when the command names no `{path}`) and starts it as a program with arguments, no shell. On
Windows a bare program name is looked up through PATHEXT (`findOnPath`), and a `.cmd` or `.bat`
such as `code` runs through cmd.exe with its words quoted (`quoteForCmd`), since Node starts
those only through a shell. cmd.exe expands `%NAME%` even inside quotes and `cmd /c` has no
sure escape for it, so a path with a `%` is answered `rejected` whenever cmd.exe would read the
line (`EditorRefused`). With `viewer.editorShell` on, the command goes to the shell as one
line with only the path quoted, so it can use shell syntax. A line with `{path}` inside quotes,
or right after or before a quote or the shell's escape character (`\` for sh, `^` for cmd.exe),
is refused (`pathQuoted`): the user's quotes would cancel wow's and leave a name's `$(…)` or `&`
to the shell. `startEditor` starts it detached,
without a window, and lets it go once it has started; a program that does not start is answered
`rejected` with the reason, which the app shows as a toast. Through a shell (the setting, or a
`.cmd`) "started" means the shell started: a program the shell then does not find fails unseen.
The assistant changes `viewer.editorCommand` and `viewer.editorShell` only as a proposal. The app (`panel/editor.tsx`:
`openInEditor`, `useOpenInEditor`, `OpenInEditorButton`, `isBinding`) offers it with
`keybindings.openInEditor` (Shift+Enter) on the element that has the focus, matched in that
element's own key handler, so Shift+Enter stays a line break in text fields: a changed file and a
diff line in a run's or thread's Changes (at the line, or at the file's first changed line), an
artifact, a chat file link, Open on a read row, a sent file chip (`FileLinks.openInEditor`,
`editorKeyOf`) and the file viewer; the viewer, the Changes header and artifacts also have an
"Open in editor" button. Palette: "Open file in editor" (`viewer.openInEditor`) for the file in
the panel, "Open in editor: <path>" for the run's chosen changed file, and "Open the thread's
folder in your editor" (`chat.openInEditor`, which `/open` runs).

`@` in the composer (`fileSource`, the thread's scope): typed at the start of a word
(`chat.fileTrigger`, default `@`, by the same `typedTrigger` and `skillQuery` as the skill list;
when both characters are the same the skill list wins) it opens a list of the folder's files
filtered as typed; a paste opens nothing. A pick takes the `@word` out and adds a file chip
(`Mentioned files`, kept in the thread's draft as `files`); Backspace at caret 0 removes the last
one. On send the composer puts `@path` for each file on the message's first line (`withMentions`
in `chat/mentions.ts`, the form Claude Code and Codex read) and `thread.sendMessage` carries
`files`; the server stores them on the user item (`TextItemPayload.files`) and refuses them for
the assistant. The thread draws them as chips that open the file, with the text after the
mention line (`withoutMentions`). A message queued during a turn keeps its text, so the paths,
but not the chips.

Tests: `apps/server/src/files/list.test.ts` (Git, ignore rules, the limit, the walk),
`server.test.ts` ("reads a file of a thread or a project only inside their folders", "lists a
thread folder outside Git through files.list"), `core/file-mentions.test.ts`,
`apps/web/src/panel/tabs.test.tsx` (strip, keys, palette, thread switch, refusal, Open, chips,
Escape, Ctrl+P), `components/file-links.test.tsx`, `panel/file-list.test.ts`,
`chat/file-mentions.test.tsx`, and the e2e cases "opens a file from a chat message in a panel
tab" and "mentions a file with @" in `panel.spec.ts` (the panel copy's project holds invented
`src/timer.ts` and `docs/spec.md`, and the mock answers "show the file" with those paths).

### Host links in chat

Agent workbench spec 19 to 26. A link in a chat message to a pull or merge request, an issue, a
Jira issue or a Confluence page on one of the user's hosts is a chip that opens the item in a
panel tab. Nothing new is polled: an item is read when its tab opens and on Refresh now, and the
read is stored for the thread (decided in the spec's Interface: chat links are many and mostly
looked at once).

Every thread view asks `hosts.lookup` for its rules. That answer reads no token: a site counts
when a token is stored for it (`TrackerService.linkHosts(projectId, 'stored')`). Only the
token of the host being asked is read, and only then, because on Windows each read of the secret
store starts PowerShell. The rules read the project's folder with Git (three commands, slow to
start on Windows), so the server shares one in-flight rules answer per project, and the web app
asks once per thread and per state of the settings and projects topics, whichever views show the
thread.

**Recognition** (`packages/contracts/src/host-links.ts`, shared by the server and the web app so
a chip is exactly what the server will read). `HostLinkRules` are the thread's sites
(`HostLinkSite`: host kind, web base, name), the project's repository (GitHub or GitLab, with
its path) and the project's Jira key. `recogniseHostLink(url, rules)` reads
`<base>/<owner>/<repo>/pull|issues/<n>` (GitHub; the web base comes from the API URL with
`gitHubWebBase`: `api.` hosts lose it, Enterprise Server loses `/api/v3`),
`<base>/<path>/-/merge_requests|issues/<n>` (GitLab), `<base>/browse/<KEY-n>` (Jira) and the
three Confluence page forms; anything else, an address with a user name or password, and any
other scheme stay plain links. `bareHostRefs(text, rules)` finds `KEY-n` for the project's Jira
key and `#n` (and `!n` on GitLab) for its repository, never inside a word, path or address, and
never a `#n` that reads as a colour (six digits, three of one digit, or three digits after a
colour property such as `color:` or `background:`; `Fixes: #123` stays an issue).
`recogniseHostRef` takes one address or one key (the palette and `hosts.lookup`). A thread
without a project has no repository or key, so its bare references stay text; its links still
resolve against Settings → Trackers. `HostItemRef` names one item (host, kind, site, path, id,
url); `hostItemKey` lower-cases the repository path, a site's path prefix is compared without
case, and a code host's path parts are decoded once, so `Acme/Tea`, `acme/tea` and `acme/te%61`
are one item (a read stored under an older, mixed-case key is read again on open). GitHub
numbers issues and pull requests together, so a bare `#14` there is an `issue`
until the read says it is a pull request.

**Server.** `TrackerService.linkHosts(projectId | null)` answers the rules and, for the server
only, each site's token: a site is in the rules only with its settings and a token (GitHub with
the host rule of "Projects" for a remote's host). `HostLookup` (`apps/server/src/hosts/lookup.ts`)
answers RPC `hosts.lookup {threadId, ref?, read?}` with `{rules, item, read}`: without `ref` the
rules; with it the item it names (null for a plain link) and the stored read; `read: 'open'`
reads the item only when the thread has no successful read of it (a stored failed first read,
without `fetchedAt`, is asked again), `read: 'refresh'` always. One read per
item at a time. Each read builds the adapter of the item's site with that site's token, so a
token never goes anywhere else, and goes through the internal command `hosts.itemRead`
(`decideHostItemRead` in `core/hosts.ts`) to the event `hosts.itemRead` and the
`host_item_reads` table (migration 0030), topic `hostItemReads` (thread-scoped). `HostItemRead`
has scope `thread`, the
item, `data` (`HostItemData`: a change request, an `Issue`, a `Ticket` or a `Page`), `fetchedAt`
and `error`; a failed read keeps the last data and its time beside the error. GitHub and GitLab
adapters gained `readIssue(number)` (GitHub answers `changeRequest` when the number is a pull
request); the mocks gained `issues`. The assistant's thread is refused, and nothing read is ever
put into a prompt.

**Web.** `chat/host-links.tsx`: `useHostLinkRules(threadId)` (one question per thread shared by
the conversation and the panel, once both topics have loaded; asked again when the settings or
projects topics change in content, or when the thread is shown again after no view showed it),
`HostLinkContext` (provided by `ThreadConversation` next to `FileLinkContext`, not for the
Assistant), `HostChip` (icon, key, and once read the state: "PR
#14 · Draft · 2 checks failed", "DEMO-42 · To Do", a page's title; Enter or click opens the tab,
Shift+Enter or Shift+click the browser), `hostItemLabel`, `hostItemState`, `hostItemsIn`. The
markdown body turns recognised links and inline code into chips (inline code only for an address
or a Jira key: `#n` and `!n` in code stay code), and a remark step marks bare
references in text (`wow-host-ref:` links the anchor turns into chips). Panel tab kind `host`
(`ViewerHostItem {threadId, item, from}`, `openHostItem` in `panel/viewer.ts`) renders
`panel/host-tab.tsx`: it asks `hosts.lookup` with `open` when shown, shows the stored read with
`HostReadLine` (Last fetched, Refresh now, Open on host) and the body the run's tabs share
(`ChangeRequestBody`, `TicketBody`, `PageBody` and the new `IssueBody`). Palette:
`panel.openHostItem` ("Open issue, PR or ticket…", a dialog taking an address or key) while a
chat thread is open, and `panel.host.refresh`, `panel.host.openOnHost` while a host tab is
shown. `chat/pasted-links.tsx` shows chips with "Open in panel" above the composer for links in
the draft; it listens to `drafts.ts` (`onDraftChange`, `draftText`), so the composer is not
involved. Details lists "Mentioned" (`threadMentions` in `panel/thread-panel.tsx`): the
thread's file paths and host items, each opening a tab.

Tests: `apps/server/src/hosts/links.test.ts` (lookup per host, read once and on Refresh now, no
poll, token host check, refused read, bare references, nothing in a prompt),
`apps/web/src/chat/host-links.test.tsx` (link and key recognition, chips, Shift+Enter,
Mentioned), the e2e case "opens a pull request and a Jira issue from a chat link" in
`hosts.spec.ts` (the mock answers "link the work" with those links) and its sketch
`host-chip.png`.

## Backlog and trackers

`apps/server/src/core/backlog.ts` decides `backlog.create|update|delete|restore|plan` and the
internal `backlog.published`. `backlog.restore {item}` is Undo for a delete: it stores the row the
client held as `backlog.created`, refused when the id exists; links the delete removed from cards
stay removed. Tags are stored trimmed and unique. `backlog.plan` ("Plan on calendar") is one
command for the card and the item: it builds the `card.create` the calendar would accept (title from
the item, the chosen workflow, project and time, linked to the item) and moves the item to
`planned`, so a refused card leaves the item as it was. Delete unlinks the item's cards. An item
planned on a card follows the main thread the card started (`backlogFollowsCard`, orchestrator
threads spec 28): working or waiting is `running`, done is `done`, anything else leaves it
`planned`.

**Per-project settings** (owner decision F-4). Every `trackers.jira.*`, `trackers.github.*` and
`trackers.gitlab.*` setting has `scope: 'project'`, so it can be stored globally (the defaults, Settings → Trackers) and
per project (`project:<id>`); `trackers.requestTimeoutMs`, `trackers.gitTimeoutMs` and
`trackers.jira.keyScanCommits` stay global. `trackers/resolve.ts` decides a project's values
without I/O, in this order: stored for the project, then the project's git remote (GitHub owner,
repository and API URL of the primary remote, unless that remote is on the stored GitLab site),
then the global default, then the Outlook profile's
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
answers `ProjectTrackers` (`{projectId, git, gitlab, settings, suggestions}`; `gitlab` is the
GitLab project the remote names on the stored GitLab site, or null). The GitLab site is never
taken from a remote, so its token goes only where the user said. "Test connection" takes
`TrackerConnection` (`jira`, `github`, `gitlab`, `confluence`; GitLab and Confluence are no
publish targets) and answers
`TrackerTestResult` with `version`: for GitLab it asks `/user`, `/version` and, for a project
whose remote is on the site, the project itself, and says "Signed in as <name> @<user> on GitLab
<version>"; for Confluence it asks `/rest/api/user/current` and says "Signed in as <name> ·
<user>" (an anonymous answer counts as a refused token); a refused token shows the host's
message.

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
issue. Publishing reads nothing back; a run of the item shows the Jira issue in its Ticket tab
(see "Hosts"). The payload is deliberately minimal:

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
body with Write and Preview through `markdown.tsx`, a thin wrapper over the shared `Markdown`
renderer (see "Shared pieces"), tags as chips, state; Ctrl+S saves) or `/backlog/new`. The user sets
only Idea and Dropped (owner decision F-12); Planned, Running and Done show read-only. Delete
dispatches at once and offers Undo with `backlog.restore`. "Plan on calendar" opens a dialog for
workflow, project, date, start and end in `calendar.zone`: it suggests `nextFreeSlot` (the first
`calendar.cardMinutes` gap on a `calendar.snapMinutes` boundary inside `calendar.workHours`, around
non-cancelled, timed `calendarItems`, up to `calendar.lookaheadDays` ahead), warns about overlaps,
preselects the workflow of the newest card made from a backlog item, and dispatches `backlog.plan`.
"Publish to Jira" and "Publish to GitHub" ask `trackers.preview`: an item that already has an issue
gets "Open <key>"; a Project select (whenever projects exist) shows whose trackers apply, marked
"From the item's card" or "From the item's run", and when `needsProject` it asks for one before
anything else ("No project" sends `projectId: null`); a tracker that is not set up asks for the
missing settings in the dialog (secret ones through `secrets.set`, like the settings page), storing
sign-in settings (site, auth mode, email, tokens, GitHub API URL) globally and the rest for the
chosen project, and asks again; otherwise the preview says "Publishes to <target> on <host> for
<project>", shows the target with its source marker, an editable title, the tags to add as labels
and the rendered body, and "Publish issue" calls `trackers.publish` with the same `projectId`.

Settings → Trackers has one section per host (Jira, GitHub, GitLab, Confluence), each with Test
connection, and "Every tracker" for the shared request settings.

Settings → Projects → Trackers (`projects/project-trackers.tsx`) renders `trackers.project` and
asks again on every `settings` push. GitHub owner, repository and API URL and Jira site, project
key and issue type are `FormField`s with the source as marker; a typed value is validated with the
registry schema and stored with `setting.set` at `project:<id>` on blur or Enter, emptying a
project value resets it, and "Use git remote" / "Use default" resets it. A suggestion shows below
its field with "Use <value>". Sign-in is one line ("Signs in with the shared GitHub token") with
"Use a different token", which opens a `SecretField` for the project's own token. Each tracker
has the same Test connection as Settings → Trackers, with the `projectId`. The GitLab section
has the site URL, a line naming the GitLab project the remote points at (or saying the remote is
not on that site, so GitHub applies) and the same sign-in line. The Confluence section has the
site URL and the sign-in line. Palette commands: New
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

Text in the "needs you" colour, such as "Waiting for you", uses `--state-needs-you-text`
(`text-state-needs-you-text`), a darker amber in the light theme that keeps at least 4.5:1 on the
page, cards, muted surfaces and popovers; dots, fills and borders keep the bright
`--state-needs-you` (agent workbench spec 85). `src/styles/tokens.test.ts` measures both themes
from the token values (OKLCH to sRGB luminance) and fails on any `text-state-needs-you` left in
a view.

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
- `markdown.tsx` (`Markdown`): the one markdown renderer, used by assistant messages
  (`chat/items.tsx`), backlog bodies and publish previews. `markdown-body.tsx` holds the
  `react-markdown` and `remark-gfm` part and loads on first use; until then the text shows as
  written. It builds React elements and has no raw HTML plugin, so HTML in a message shows as
  text. Links open in a new window only for http, https and mailto (`safeHref`); any other link
  shows as its text, and a picture shows as a link so nothing is fetched. Headings render two
  levels down (`#` is an `h3`). Fenced code goes to `CodeBlock`. With `streaming`, `splitUnfinished`
  holds back a fence without its closing line, or a table at the very end of the text, and shows
  it as plain text until it is complete, also inside a list item or a quote. It reads a fence
  where markdown does: at most three spaces in from its quote or list item, and ended by the end
  of that quote or item. Lines may end in CRLF.
- `mermaid-diagram.tsx` (`MermaidDiagram`) draws a `mermaid` fence in place with a "Source"
  switch. `mermaid.ts` loads the library on first use, runs it at its `strict` security level in
  the app's theme, and returns the SVG or a one-line reason; while drawing and on failure the
  source shows as code, with the reason below it on failure. The strict level stops scripts but
  not fetches, and a message must not make the app fetch anything. The library draws in the live
  document, so a picture named in a diagram's style would be fetched while it draws, before any
  check of the result. What makes that impossible is the content security policy in
  `apps/web/index.html`: pictures, fonts, media and stylesheets load only from the app itself (or
  `data:`), plugins never, and no frame may load an address (the file viewer's frame is filled from
  a string, see "Context panel"). It leaves scripts and connections alone, because the dev server
  and the socket to the wow server need them. `mermaid.ts` adds three things on top, so a
  diagram also draws nothing it should not: labels are drawn as text and a diagram's own
  directives cannot set CSS, theme variables or fonts (`htmlLabels: false` and the `secure`
  list); a diagram that names something to load is refused before drawing, with a reason (a
  flowchart image shape, read from the parsed diagram, and in any diagram type a source with
  `url(` to somewhere outside the drawing, `image-set(` or `@import`, after CSS escapes are read
  as CSS reads them (`u\72l(` is `url(`), which also refuses a label that spells `url(`); and `scrubSvg` removes pictures, scripts, event
  attributes and any CSS or reference that points outside the drawing, and gives links the rule
  of `safeHref` (a new window for http, https and mailto, no link otherwise). The desktop window
  hands the same three to the system (`opensOutside` in `apps/desktop/src/main/app-protocol.ts`),
  so a mailto link opens the mail program.
  The palette command "Toggle diagram source" switches every diagram at once
  (`diagramView`); it is view state and is not persisted.
- `lib/feedback.ts`: `notify.success|error|info|warning` and `offerUndo({message, undo})`.
  Destructive actions delete at once and offer Undo; only irreversible ones (stored secrets, a
  project whose cards and threads lose their link) confirm first.
- `lib/format.ts`: `formatWhen`, `formatRelative`, `formatDuration` and `useDateFormat()`, in the
  `calendar.zone` zone. The UI never prints ISO timestamps.
- `app/shell-toolbar.tsx`: `ShellToolbar` renders a view's toolbar into the shell header row.

Tokens add `--warning`, `--info`, `--destructive-foreground`, `--overlay` and `--border-strong`,
the calendar's `--event-outlook`, `--event-outlook-border`, `--event-card`, `--event-card-border`,
`--event-work-hours` and `--event-now`, and an 11px `text-2xs` step; type uses only `text-2xs`, `text-xs`, `text-sm` and `text-base`. The
left side is the thread list (see "Thread list, unread and chat notifications"); below 1280 px
it narrows to a 3rem rail of status marks while none of it is in use.

## Testing strategy

The e2e servers seed `assistant.briefings` off and `assistant.briefsPerDay` 0: their scheduler runs
on the real clock, and a briefing or a brief arriving in the middle of a case would be an
assistant turn the case did not expect. `e2e/chief-of-staff.spec.ts` turns briefings on itself
and moves the page's clock to come back "after a while away".

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
  The server's seeding helpers in `apps/web/e2e/*.vitest.ts` files run under Vitest in Node (the
  `e2e-helpers` project in `apps/web/vite.config.ts`); Playwright does not pick those files up.
  Its PATH holds empty stand-in `claude` and `codex` files for `provider.detect`. The projects
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
  that change what a click in the calendar does; its home seeds a card tomorrow with a workflow.
  The same copy holds the file viewer's fixtures: invented files of every kind in the project's
  `review` folder (the picture is drawn by the script, the HTML page tries to reach the app, its
  storage and the tracker port, over HTTP and over WebRTC); requests to `/leak…` on the tracker
  port and datagrams to the same port are recorded, so a page that got out fails the test. The
  trigger tests start a third copy themselves (`e2eTriggersHome`, `e2eTriggersPort`) because
  they restart it: `WOW_E2E_KEEP_HOME=1` keeps the home across a restart and
  `WOW_E2E_CLOCK_OFFSET_SECONDS` runs the server's clock ahead, so a trigger's time passes while
  the server is down without the test waiting. The server prints `wow e2e server ready` once it
  is seeded. The backlog tests publish to a mock Jira and GitHub on `e2eTrackerPort`, which the
  server's tracker settings point at (GitHub without its token, which the test enters on the
  settings page); the same port lists what the trackers received and starts a backlog item's
  card thread the way the scheduler does (`POST /fire`). The questions tests share a worker
  with the assistant's copy (`e2eAssistantHome`, `e2eAssistantPort`), whose adapter is
  `AssistantMockAgent` (`e2e/assistant-agent.ts`): it hands ordinary threads to the chat script
  and answers a turn with wow's toolset by calling `server.assistant.tools` in process, reported
  as `mcp__wow__<tool>`, with the scenario picked by the user's words. The first-start tests
  (`e2e/first-start.spec.ts`) use an eighth copy (`e2eFirstStartHome`, `e2eFirstStartPort`)
  seeded with no provider instance, project, workflow or tracker, whose mock Codex fails its test
  with `e2eFirstStartCodexError` and whose mock Claude is the same `AssistantMockAgent`; on wow's
  first-start note it answers with the note's lists and then asks for each "To fill in" line in
  turn, one per user message. The Changes tests (`e2e/changes.spec.ts`) use a sixth copy
  (`e2eChangesHome`, `e2eChangesPort`), because opening a changed file opens the context panel,
  a global setting. The script creates invented tea repositories in its home with `git` (which
  the e2e machines therefore need on the PATH) and registers them as projects. The host tests
  (`e2e/hosts.spec.ts`) use the same copy: project `tea-garden` is on a branch with an invented
  pull request; `MockGitHub` (`apps/server/src/hosts/mock-github.ts`, the host the server tests
  use too) answers under `/github` on the tracker port, and only this project has a GitHub
  token. `PUT` and `DELETE /github-host/failure` make the host fail and answer again, and
  `GET /github-host/requests` lists what it was asked. `MockJira` and `MockConfluence`
  (`apps/server/src/hosts/mock-jira.ts`, `mock-confluence.ts`) answer under `/jira` and
  `/confluence` with the seeded global sign-ins, with the same failure and request controls. The
  GitLab tests (`e2e/gitlab.spec.ts`) read project `tea-field`, whose remote is on the mock
  GitLab under `/gitlab`. The working copy tests (`e2e/working-copy.spec.ts`) start a chat thread
  in project `tea-mug`, cloned from a bare `origin` beside it; the mock agent edits whatever
  folder its turn starts in when that is a tea repository or a folder under the home's
  `workspaces`, so the test sees the edits in the working copy and the project folder unchanged.
  CI runs `pnpm e2e` on `ubuntu-latest` and `windows-latest` (the `e2e` job) and keeps the traces
  of a failed run. A case that covers a behavior a spec's ground truth names carries the tag
  `@<intent>-<n>` in its title (`@thread-work-10`, `@agent-workbench-34`), so `pnpm e2e --grep`
  runs those and the report lists them.
  Tests wait for what the page shows, never for time: no sleeps, polls or retries.
