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
  workflow-engine/   workflow definitions, runs, gates, step handover. Pure; the server wires it.
  agent-os/      reads agent-os intent, spec and plan files from their text, and unit status
                 from pull requests. Pure; no I/O.
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
  message text hold every word, see "Chat view"), `skills.refresh`, `plans.refresh` (reads every project's
  intents folder now, see "Plans"), `hosts.refresh` (`{planId?, runId?}`, asks the host once
  about one followed plan, one run or everything wow follows, see "Hosts"),
  `workflowRuns.detectArtifacts` (`{runId}`), `workflowRuns.diff` (`{runId, path?}`, what the run
  changed since its base, see "Run base and changes"), `workflowRuns.removeWorkingCopy` (`{runId}`,
  deletes a kept working copy of an ended run, see "Working copies"), `workflows.matchArtifacts` (`{projectId, globs}`),
  `files.read` (`{runId | threadId | projectId, path}`, one file for the viewer, see "Files"),
  `files.list` (`{runId | threadId | projectId}`, the folder's file names for "Open file…" and
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
  topics (`turns`, `threadItems`, `approvals`, `questions`) need a `threadId`. After a commit that
  touched a topic, every subscriber of it gets the topic's full current rows. Subscriptions end
  with their connection.
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
  server issues (`provider.events`, `providerInstance.recordTest`, `skills.sync`, the workflow
  runner's step outcomes) are `InternalCommand`s: they go
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
  (`workflowRuns.diff` sends the changed lines of files git lists as changed inside the run's
  folder, see "Run base and changes".) `files.read` takes a scope (`FileScope` in
  `packages/contracts/src/files.ts`, agent workbench Interface): a run (the project folder; a run
  with its own working copy adds that folder in front), a thread (its folder, then its project's
  folder; a thread without a project only its own) or a project (its folder). The handler
  (`fileScope` in `rpc/handlers.ts`) turns the scope into those folders and the words a refusal
  names them with (`place`), and passes `viewer.maxFileBytes`. The assistant's thread has no
  files (its folder is wow's own; `rejected`). `files.list` (`files/list.ts`, `listFolderFiles`)
  names the files of the scope's first folder for "Open file…" and `@` (agent workbench spec 18,
  56), never their content: inside Git `git ls-files --cached --others --exclude-standard -z`
  (tracked plus untracked files Git does not ignore, read as the output streams and stopped at
  `viewer.fileListLimit`; a name that is no file on disk, a tracked file deleted or a submodule's
  folder, is left out; when git runs out of time the names read so far are the answer, marked
  `truncated`, since a walk would list what Git ignores), else a breadth-first walk that skips hidden folders and
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
  only an unknown run is `not_found`. `isInside` and `candidatePaths` take the path module, so
  the Windows rules (case, both separators, drives, UNC) are tested on every platform, and one
  test reads real files on `windows-latest`.
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
                 pinned, runId?, stepId?, backgroundTasks(json: BackgroundTask[]), archived, seen,
                 queued(json: QueuedMessage)?, baseSha?, baseFiles(json: FileHash[])?,
                 createdAt, updatedAt   -- backgroundTasks: the
                 agent's work still running in the background, [] when none (migration
                 0026_background_tasks); archived and seen (false while unread) for the thread
                 list, false and true for older rows (migration 0027_thread_list); queued: the
                 message waiting for the running turn to end (migration 0028_queued_messages);
                 baseSha, baseFiles: where a chat thread's Changes are measured from, set at its
                 first turn (migration 0029_thread_changes); stateSince (0031); goBack(json:
                 GoBack)?, forkedFrom(json: {threadId, turnId})? for Edit and Fork (migration
                 0032_fork_and_edit)
turns            id, threadId, index, state, startedAt, endedAt, usage(json),
                 fileMark(json: FileHash[])?   -- the changed files' hashes as a chat thread's
                 turn began, for "This turn only" (migration 0029_thread_changes);
                 resumePoint(json: {sessionId, at})?, replacedBy? -- the provider's point after
                 the turn and the turn Edit put in its place (migration 0032_fork_and_edit)
thread_items     id, threadId, turnId, index, kind ('user'|'assistant_text'|'reasoning'|'tool_call'|
                 'approval'|'question'|'task_list'|'usage'|'error'|'settings_change'|
                 'compaction'), payload(json), streaming   -- a subagent's tool_call and
                 assistant_text carry its call's row id as payload.parentItemId
approvals        id, threadId, itemId, kind ('command'|'fileChange'|'tool'|'plan'), request(json),
                 decision? ('allowOnce'|'allowSession'|'allowAlways'|'deny'), decidedAt?   -- what
                 the card shows (facts, rule, plan, byRule, note) is in the approval item's payload
questions        id, threadId, itemId, request(json), answer?, answeredAt?   (answer: the reply
                 as one line; the item's payload holds the reply's picks and text)
calendar_items   id, source ('outlook'|'local'), externalId?, title, start, end, zone, allDay,
                 location?, joinUrl?, body?, organizer?, projectId?, backlogItemId?, workflowId?,
                 runId?, state, updatedAt, repeat(json: RepeatRule)?, skippedDates(json: string[]),
                 nextAt?, pastSeries(json: PastSeries[])   -- state: CardState for cards,
                 'scheduled'|'cancelled' for Outlook; body: a card's notes or an Outlook item's
                 snippet; repeat, the days skipped by hand and the trigger's next time for a
                 repeating card (migration 0022_repeating_cards); pastSeries the series it
                 followed before a change, for the days before it (migration 0023_past_series)
card_occurrences cardId, date, start, end, outcome ('fired'|'failed'|'skipped'|'missed'), runId?,
                 reason?, offerRunNow, at   -- what happened at each occurrence of a repeating
                 card the scheduler reached; kept when the card is deleted, as its runs are
outlook_status   singleton: lastSyncAt, lastError?, unavailableSince?, bridgeVersion,
                 profile(json: OutlookProfile)?
backlog_items    id, title, body, tags(json), state, runId?, remote(json: service,key,url)?, createdAt
workflows        id, name, templateKind?, steps(json: WorkflowStep[]), ownWorkingCopy, forUnits,
                 maxStepVisits?,   -- the workflow's own limit on step starts
                 createdAt, updatedAt
workflow_runs    id, workflowId, projectId, calendarItemId?, backlogItemId?, state ('running'|
                 'waiting'|'done'|'failed'|'stopped'), currentStep, steps(json: StepRun[]),
                 startedAt, endedAt, baseSha?, baseFiles(json: FileHash[])?,
                 workingCopy(json: WorkingCopy)?,   -- null for a run in the project folder
                 unit(json: RunUnit)?,   -- the unit a plan run started the run for
                 event(json: RunEvent)?,   -- what started the run, when an event trigger did
                 occurrence(json: {date, start})?,   -- the occurrence of a repeating card
                 path(json: PathVisit[])?   -- every step visit and why the run went on as it did;
                                            -- null for a run from before paths were kept
plan_runs        id, planId ('<projectId>:<intentId>'), projectId, intentId, workflowId, state
                 ('running'|'waiting'|'done'|'failed'|'stopped'), units(json: PlanRunUnit[]),
                 waitingFor(json: string[]), message?, startedAt, endedAt?
triggers         id, kind ('card'|'event'), workflowId, runId?, offerRunNow;
                 card: calendarItemId, runAt, zone, state ('scheduled'|'fired'|'missed'|
                 'cancelled'); event: projectId, event ('merged'|'checksFailed'|
                 'commentAdded'), enabled, createdAt (the other kind's columns are null)
trigger_events   triggerId, eventId, runId?, at (the events an event trigger has seen; no topic)
notifications    id, at, kind ('started'|'waiting'|'failed'|'skipped'|'finished'), title, body,
                 path, runId?, calendarItemId?, threadId?, approvalId?   -- threadId and
                 approvalId for a chat thread's notification (migration 0027_thread_list)
skills           id, name, description, dir, source ('user-claude'|'user-codex'|'project-claude'|
                 'project-agents'|'custom'|'wow'|'yours'), manualOnly, invocations(json: {claude,
                 codex}), text? (a wow skill's text; null for folder skills)
plan_intents     id ('<projectId>:<intentId>'), projectId, intentId, title, hasIntent, status?, rev?,
                 spec(json: PlanFile)?, plan(json: PlanFile)?, source ('files'|'issues')?,
                 units(json: PlanUnit[]), problems(json: PlanProblem[]), followed
                 -- what the files say; unit status also from the host while followed
host_reads       id ('plan:<planIntentId>'|'run:<runId>'), projectId, scope ('plan'|'run'), host
                 ('github'|'gitlab'), hostName, branch?, changeRequestIds(json), fetchedAt?,
                 error(json: HostError)?   -- what was last read for a followed plan or a run
change_requests  id ('<projectId>:<number>'), projectId, host, number, title, url, state ('open'|
                 'merged'|'closed'), draft, mergedAt?, headBranch, headSha, units(json: UnitRef[]),
                 checkState ('none'|'pending'|'success'|'failure'), checks(json: HostCheck[]),
                 comments(json: ReviewComment[]), newestCommentId?, links(json: string[])
                 -- pull requests as last read; `links` are the web addresses of the body
ticket_reads     id ('run:<runId>'), projectId, runId, host ('jira'), hostName, key?, source
                 ('backlog'|'pullRequest'|'branch')?, ticket(json: Ticket)?, fetchedAt?,
                 error(json: HostError)?   -- a run's Jira ticket as last read
page_reads       id ('run:<runId>'), projectId, runId, host ('confluence'), hostName,
                 pages(json: PageLink[]), fetchedAt?, error(json: HostError)?
                 -- the Confluence pages a run's texts link to, with the pages as last read
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
expectedArtifacts: string[]}` (the skill fields: see "wow skills"). `StepRun = {stepId, state, threadId?, startedAt?, endedAt?,
artifactsFound: string[], finalMessage?, error?, fileHashes?, attempt?, gate?}`. `gate` is
`StepGate = {state: 'waitingForChecks'|'waitingForUser'|'passedByItself'|'passedByUser', parts:
{part, state: 'held'|'failed'|'pending', detail}[], since, at}` and only a gate with a condition
has one (see "Gates that pass by themselves"). Both live in JSON columns, so they need no
migration.

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
                 commandRefused {command stopTask|toBackground, error} (made by the server)
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
  user item it becomes) and gets a new `id` (the old one plus `+`), so whatever acts on the queue acts on one version of it. For a chat or
  step thread the event carries `handOver {providerInstanceId, prompt}` (the prompt with the
  skills in front, as `thread.sendMessage` would send it); the provider service then sends the
  adapter `handOver {threadId, prompt}`, which answers `HandOverResult {taken}`. Taken, the
  service dispatches `thread.handedOver {threadId, queuedId, offered {text, skills?, files?}}`: the queue
  empties and a `user` item with `queued: 'duringTurn'` joins the running turn (or the turn that
  just ended), so the conversation shows it sent. Not taken, it stays queued. The service offers a
  thread one version at a time: a join while the adapter has not answered is not offered. When the
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
{providerInstanceId, cwd, threadId?}` returns the list (`ProviderSlashCommand[]`).
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
  on the instance; delete is also refused while chat or step threads use it (the assistant thread
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
skills settings or the project list change, and on `skills.refresh`; scans run one at a time and a
burst of changes shares one queued scan. It sends the result as a `skills.sync` command, which
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

## Workflow engine

`packages/workflow-engine` is pure: given a workflow, a run and an event (step completed, gate
answered, trigger fired) it returns the next run state and the effects to perform (start thread
with prompt, notify, finish). The server performs them. The step prompt is:

```text
<the step's skills: the one it runs, its alsoFollow skills, then the built-in skills attached
 by themselves, each as text or invocation (see "wow skills")>  <extraPrompt>

<unit text: workflows.unitPromptTemplate rendered with the run's unit; only in a run that a
 plan run started for a unit, see "Plan runs">

<handover: workflows.handoverTemplate rendered with previous step's final assistant message,
 the backlog item body if any, and the expected artifact paths>
```

Skills of a step (wow skills spec 10 to 15). `stepPromptFor` makes the prompt and answers
`{prompt, shown?, skills?, missing?}`; `renderStepPrompt` is its `prompt`. A run started since wow
skills has `WorkflowRun.wowSkills: true` (column `wow_skills`). For it the engine asks
`EngineContext.skillFor(step, ref, values)` for the skill the step runs (`skillName` with
`skillSource`) and each `alsoFollow` entry, in that order. Then, while
`workflows.attachBuiltInSkills` is on, it adds the built-in skills of `automaticSkills(step,
run.unit)` that the step does not name and does not `leaveOut`, with the reason:
`wow-verdict` when the gate after the step has the verdict part or a rule reads the verdict,
`wow-artifacts` when the step expects artifacts, `wow-pull-request` when the run is for a unit.
A built-in skill switched off is not found, so it is not attached. Each of wow's own sentences
for these purposes is sent once: with `wow-artifacts` in the prompt the handover gets an empty
`expectedArtifacts`, and with `wow-pull-request` the unit text gets an empty `intentUnitLine`.
A skill the step names that `skillFor` does not find fails the step before it starts (no
thread, no turn, no rule followed) with "The skill <name> no longer exists, so the step cannot
start. …". The `startStep` and `sendBack` effects carry `shown` and `skills`; the runner and the
orchestrator then send `thread.sendPrepared {threadId, text: shown, prompt, skills}` (internal)
instead of `thread.sendMessage`, so the thread shows the prompt without the skills' texts and
names the skills. A run stored before (no `wowSkills`), or an engine context without
`skillFor`, keeps the old prompt: `invocationFor(step)`, the expected artifacts in the handover
and the Intent-Unit line in the unit text. A step held while the user's own turn runs keeps its
prompt (`heldPrompt`) with `heldShown` and `heldSkills`, and goes as `thread.sendPrepared` like
any step's turn. Retry in a step's thread (a thread with a `stepId`) sends `thread.retry
{threadId}`: the orchestrator reads the thread's last `turn.started` whose user item has text or
skills from the event store (the prompt is not projected) and starts a turn with the same text,
prompt and skills, so a step's skills are not resolved again as chat skills; it is refused for
any other thread, whose Retry sends `thread.sendMessage`. A sent chip of a Claude plugin skill
(stored as `plugin:name`) shows `name` with the plugins mark, as the composer's chip does. A
`workflows.unitPromptTemplate` stored before wow skills that spells out
`Intent-Unit: {{intentId}}/{{unitKey}}` itself keeps the line; `wow-pull-request` then gets an
empty `intentUnitLine`, so the line is still sent once.

`workflows.handoverTemplate` is a setting (project scope). `{{name}}` is replaced and
`{{#name}}…{{/name}}` is dropped when the value is empty; the values are `previousStep`,
`previousMessage`, `backlogBody`, `previousArtifacts` (found by earlier steps),
`expectedArtifacts` (this step's globs) and `previousError` (the error of the step the run came
from, when that step failed and a rule sent the run on; then `previousMessage` is empty). "The
previous step" is the step the run came from: the one before in the list unless a rule sent
the run here. Artifact detection runs `fast-glob` with the step's
`expectedArtifacts` in the run's folder (`runFolder`: its own working copy when it has one, else
the project `cwd`) when the step completes and on run view open
(`workflowRuns.detectArtifacts`).

Gates. A gate sits between two steps. After a step with `gateAfter` its turn is over and the step
itself shows `waiting` (its thread shows "needs you"). Before a step with `gateBefore` that step
shows `waiting` without a thread, and the previous step's thread shows "needs you". The run is
`waiting` in both cases and `pendingGate(run)` tells them apart. One Continue (shown as Approve)
passes the gate between two steps even when both flags are set. Stop ends the run as `stopped`,
interrupts a running turn and keeps every thread. A step's prompt is sent only after the runner
has made the working copy and read the base, and only when the run and the step are still
`running` then, so a run stopped meanwhile starts no turn.

Send back (review loop spec 16 to 18) is the other answer at a gate. `workflowRun.sendBack {runId,
note}` runs the reviewed step again (`reviewedStepIndex`: the step that just ended for a gate
after it, the one before for a gate before a step): that step becomes `running` again in its own
thread, `StepRun.attempt` counts up (absent for the first run, 2 after one send back) and a step
that waited before its gate goes back to `not_started`. The step keeps its last final message,
artifacts and file hashes until the new turn ends and replaces them, and the run then waits at the
same gate again, because the step ends through the same `stepCompleted` path as the first time.
The message is `workflows.sendBackTemplate` (project scope) rendered with `note`, `skill` and
`attempt`; an emptied template sends the note alone, and a template that does not name
`{{note}}` gets the note after its own text, so a reviewer's note is never dropped. Templates
collapse runs of blank lines in their own text only: a value (the note, a step's final message)
is put in afterwards and keeps its blank lines as written. The engine refuses an empty note, a run that
is not waiting (with its state in the reason) and a gate before the first step, where nothing has
run. The engine's `sendBack` effect is not performed by the runner: the orchestrator turns it into
the thread's `turn.started` in the same commit as the run change (the `thread.sendMessage`
decision), so the thread is never created again and a step is `running` exactly while its own
turn is. That is how the runner tells a send-back turn from a message the user typed at the gate
(spec 20): an ordinary message finds the step `waiting` and is ignored as before, and a send back
while such a message is still being answered is refused instead of queued.

Gates that pass by themselves (review loop spec 54 to 58; `gate.ts` in the engine). A step's
`gateAfterCondition` names the parts the gate after it needs: `verdict`, `checks`, `artifacts`.
When the step ends the engine judges them; no model does.

- `verdict` holds when the last non-empty line of the step's final message, trimmed, equals
  `workflows.verdictApprovedLine` (default `APPROVED`). Backticks or bold around the line are
  taken off and nothing else is, so `- APPROVED`, `APPROVED.` or `approved` do not count.
- `artifacts` holds when every one of the step's `expectedArtifacts` globs found a file. The
  runner looks for each glob on its own and reports the ones that found nothing
  (`workflowRun.stepCompleted.artifactsMissing`); with no folder to look in (the project row is
  gone) every glob found nothing. A step that names no expected artifacts fails the part.
- `checks` holds when the run's pull request has every check successful, read from the host
  after the step ended (see below).

Every part holds: the step is `done`, its `gate` says `passedByItself` with what each part found,
and the run goes on exactly as after a step without a gate: the next step starts, the run ends,
or the run waits at the next step's own `gateBefore`, which has no condition. A part fails: the
run waits for the user as at any gate (thread "needs you", the waiting notification) and `gate`
says `waitingForUser` with the failed part; the checks are then not waited for. Only the checks
are undecided: the run is `waiting` with `gate.state` `waitingForChecks`, nobody is notified and
the step's thread is left alone. Approve, Send back and Stop work in both waiting states;
Approve records `passedByUser`, Send back and Stop drop the record, and the step is judged from
nothing when it ends again. A gate without a condition records nothing and behaves as before.
wow never merges: passing a gate only starts the next step.

Waiting for checks (spec 56). The engine's `gateChecks {stepId, reading}` input looks at such a
gate again. The reading is what the stored host read of the run (`run:<runId>`) shows, and only
a read fetched at or after `gate.since` (when the step ended) counts, because an older one says
nothing about what the step pushed. The gate also keeps the commit the run's folder was on when
the step ended (`gate.headSha`, read by the runner), and a read whose pull request is on another
commit counts as no read: the host has not seen the push yet, or the step did not push. Success
passes the gate; a failing check waits for the user
and names it; checks still running, a pull request without checks, no pull request for the
branch yet, or a host that did not answer keep it waiting and update the part's sentence; a
host that is not set up waits for the user at once. Once `workflows.gateChecksTimeoutMinutes`
have passed since the step ended and the part is still undecided, the run waits for the user
with what was last seen. The orchestrator feeds the input from two places: `hosts.sync` does it
for every run its reads name, in the same commit as the read, and `workflowRun.checkGate {runId,
stepId}` (internal, sent by the host poller when the wait is over) does it from the stored rows.
A look at a gate that does not wait for checks changes nothing, so both are safe to repeat.

Skills that always stop (spec 57). `alwaysStops(skillName, listed)` in `packages/contracts` is
true for `capture-intent`, `plan-work`, `design-work`, `shape-work` and every skill in
`workflows.alwaysStopSkills`; names are compared without a `plugin:` prefix. The setting can
add skills and cannot take one of the four away. `workflow.create`, `workflow.update` and
`workflow.restore` refuse a condition on such a step (with the list as set for all projects,
since a workflow belongs to no project) and a condition on a step without `gateAfter`. The
engine applies the list of the run's project again when the step ends and ignores the
condition of such a step, so its gate waits for the user whatever was stored.

Rules (workflow branches spec 1 to 13; `rules.ts` in the engine). A step's `rules` is an ordered
list of `StepRule {when, goTo}`: `when` is a `RuleCondition` on one of four facts (`verdict` is
`approved`, `changesRequested`, `blocked` or `none`; `checks` is `successful` or `failed`;
`artifacts` is `found` or `missing`; `stepFailed`) and `goTo` is a step of the workflow or the
end of the run. A step without rules behaves as it always did. wow reads the facts itself and no
model is asked:

- The facts are read when the step ends and kept on the step (`StepRun.facts`), because the
  rules are followed only after the gate after the step has passed, by itself or by Approve,
  which can be much later. `verdict` is the last non-empty line of the final message compared
  with `workflows.verdictApprovedLine`, `workflows.verdictChangesRequestedLine` and
  `workflows.verdictBlockedLine`, read exactly as the gate's verdict part reads it; anything
  else is `none`. `artifacts` is `found` when every expected glob found a file. The runner
  reports `artifactsMissing` and `headSha` when a condition or a rule asks for them
  (`ruleAsksAbout`).
- Once the gate has passed (or at once without a gate) `route` takes the first rule that holds.
  None holds: the next step in the list, or the end after the last step. While a gate after the
  step waits for the user no rule is followed, and Send back by hand works as before.
- A rule on `checks` that is reached before any rule that holds needs a read of the pull
  request's checks. A gate whose condition has the checks part has made it already
  (`facts.checks`). Otherwise the step waits for checks exactly as such a gate does: `gate.state`
  `waitingForChecks` with `gate.forRules`, the same host read, the same commit rule and the same
  `workflowRun.checkGate` timer. A read that shows success or a failing check decides the fact
  and the rules are followed; the record is then dropped. After
  `workflows.gateChecksTimeoutMinutes` (or with a host that is not set up) the run waits for the
  user and says so; Approve then, or while the checks are still waited for, leaves the fact
  `undecided`, so no rule on checks holds and the checks are not waited for again.
- `stepFailed`: when the step's turn fails and the step has such a rule, the step is `failed`
  with its error, the run stays live and goes where the rule says, with no failure
  notification. Without the rule the run fails as before. A step the user stopped never follows
  it: Stop ends the run, and an interrupted turn arrives as `workflowRun.stepFailed {stopped}`.
  A failed step has no gate; its rule is followed at once.

Where a rule or the list goes (`moveTo`):

- A later step: the steps a rule jumps over get the step state `skipped` for this pass; a later
  pass can still run them.
- A step that has not run in this run starts as always, in a new thread with the step prompt.
- A step that has run before runs again in its own thread as its next attempt
  (`StepRun.attempt`), through the same `sendBack` effect a send back by hand uses, so the
  thread is never created twice and the turn starts in the commit of the run change. When a
  rule sent the run back to it (the target is the step itself or an earlier one) the message is
  `workflows.goBackTemplate` (project scope) rendered with `fromStep`, `reason` (the condition
  in words, `ruleConditionText`), `message` (the sending step's final message, or its error),
  `skill` and `attempt`. Reached again by the list, or with the template emptied, it gets the
  step prompt with the handover of the step the run came from.
- The limit (spec 9). A step that has started `workflows.maxStepVisits` times in the run (project
  scope, default 3; `Workflow.maxStepVisits` wins when set) does not start again by a rule or
  the list: the run waits at it with `gate.state` `waitingAtLimit` and `gate.detail` "<skill>
  has run 3 times: the limit", the step it came from shows "needs you" and the waiting
  notification is sent. Approve starts it once more (and the next time it waits again); Stop
  ends the run and the step goes back to how its last pass left it. A send back by hand is the
  user's own decision and is not held back by the limit, though it counts as a start.
- A gate before the target waits as on its first visit (spec 10). Only a list move right after
  the user approved the gate after the previous step passes it, as before.
- When the thread of the step to run again is gone or still answering a message the user typed
  there, an Approve or Send back is refused with the reason. When a rule or the list got there
  with nobody asking and the thread is answering the user, the step is `running` with its turn
  held in `StepRun.heldPrompt`; when the user's turn in that thread ends the runner sends
  `workflowRun.sendHeldTurn`, which starts the held turn and drops the field (a thread that is
  answering again keeps it held). Stop ends such a step without interrupting the user's turn.
  When the thread is gone, that step fails with the reason and so does the run, instead of
  staying "running" without a turn.

The path (spec 18). `WorkflowRun.path` is a list of `PathVisit {stepId, attempt, startedAt,
endedAt, ended, next, reason, limit?}`: one entry per start of a step, in the order it happened.
`ended` is `done`, `failed` or `stopped`; `next` is where the run went and who decided (`by`
`rule` with its `when`, `list`, or `user` for a send back by hand); `reason` is that in words
("verdict changes requested → deliver-work", "no rule held → next step", "you sent it back");
`limit` holds the limit sentence when the run waited there. `StepRun` stays one row per step
with its attempt count, so everything that reads steps by position still works. A step that
ran in an earlier pass keeps its last result while the run waits before it, so the engine
stores which side the run waits on: the step it waits at has `StepRun.waits` `before` (its
gate before, or the limit) or `after` (its gate after, or checks), and no other step has it.
`pendingGate(run)` and the web app's `gateOf` read that field and never decide from the end
time. A run stored before the field has none until its next wait; for it `pendingGate` falls
back to the path (the run waits after a step when that step's visit is the last one and nothing
has decided where the run goes next) and, without a path, to the step's end time, where a wait
at the limit is always before the step. Runs from before paths were kept never get one; their
workflow can still gain rules, since only its steps cannot change under a live run.

Templates (spec 20). A template's steps have no ids, so a rule in a template (`TemplateRule`,
`WorkflowTemplateStep.rules?`) names the step it goes to by its skill: `{type: 'skill',
skillName}` or `{type: 'end'}`. `rulesFromTemplate(templateSteps, stepIds, index)` turns them
into the rules of a workflow made from the template: the skill becomes the nearest step before
the rule's step that runs it, else the first one in the list, and a rule whose skill no step
runs is left out. `rulesForTemplate(steps, index)` is the other way for "Save as template": a
rule is kept when its step can be found again by its skill. The default Bug, Feature and
Initiative templates give check-work the rule "when the verdict is changes requested, go to
deliver-work". Only the default of `workflows.templates` changed: `rules` is optional in the
schema, so templates a user stored before are read as they were stored and get no rule.

`workflow.create`, `workflow.update` and `workflow.restore` refuse rules that cannot be followed
(spec 16), from `ruleProblems(steps)` in `packages/contracts`, which the builder can use for
the same marks: a rule that goes to a step the workflow does not have, a rule on artifacts for
a step without expected artifacts, and a second rule with a condition the step already has. The
reason names the step and the rule ("Step check-work, rule 2: …"). `workflow.create` and
`workflow.update` take `maxStepVisits` (null in an update takes the workflow's own number away).

Commands: `workflow.create|update|delete`, `workflowRun.start|continue|sendBack|stop` and
`planRun.start|stop` (see "Plan runs") from clients, and
`skills.sync` and
`workflowRun.stepCompleted|stepFailed|artifactsFound|baseRecorded|checkGate|sendHeldTurn` and
`workflowRun.workingCopyReady|workingCopyFailed|workingCopySettled` as `InternalCommand`s from
the server. The orchestrator calls `startRun`/`advance` and stores one `workflowRun.changed` event
(the run plus the effects to perform), an idle `thread.created` with `runId` and `stepId` for each
step started for the first time (model, effort and permission mode from the step, then the provider instance
defaults) and `thread.stateChanged` for gates. Step changes and deletes are refused while a run of
the workflow is live, because a run follows its steps by position. Thread ids are
`<runId>.<stepId>`. A folder skill's invocation comes from the skills projection, matched by name
(`plugin:name` picks a Claude plugin's skill); `invocationsFor` in `packages/skills` formats both
the scanned skills and unknown ones, so an unknown folder skill is still invoked by name.

`WorkflowRunner` performs the effects after commit through the thread commands: `startStep`
dispatches `thread.sendMessage` with the rendered prompt (`thread.sendPrepared` for a prompt made
with skills, see "Skills of a step"), so the provider service starts the turn
like any other, and `interrupt` dispatches `thread.interrupt`. A step ends when the persisted
`turn.ended` of its thread does: completed becomes `workflowRun.stepCompleted` with the turn's
last assistant text as the final message (a completed turn that leaves a background agent in the thread's
`backgroundTasks` does not end the step: the step ends with the turn Claude Code starts
once that work ends, and its final message, gate, verdict and artifacts are read then; a step
waits only for background agents, never for a background shell command such as a dev server or a
watcher, which may never end, though the chat shows both; when the list loses its last agent and no
turn runs, because the agent ended without Claude Code going on or the session was closed or
released, the runner ends the step with its last completed turn on `thread.backgroundChanged`;
background work that ends before the turn's result leaves no signal, so a turn Claude Code starts
after such a result is shown in the thread but is not the step's outcome), the artifacts found and the step's file hashes (see
"Run base and changes"), failed (with the turn's error
item) or interrupted becomes `workflowRun.stepFailed`. Command ids derive from the turn, so a
repeated report is a duplicate. A step with no model, effort or permission mode fails instead of
starting. At startup the runner subscribes before `ProviderService.recover()`, so a step whose turn
was running fails with the recovered turn; `recover()` on the runner then settles steps whose turn
ended unseen or never started. `notify` effects go to `onNotify` listeners; the orchestrator also
stores them as notifications (see "Scheduler and triggers"). `missedTriggerOutcome(policy)` is the
engine's table for the scheduler's missed policy.

### Run base and changes

`apps/server/src/workflows/changes.ts` (review loop spec 10 to 13). A run remembers where it
began: before the runner sends the first step's prompt it reads the commit the run's folder is
on (for a run with its own working copy that is the commit the copy was made at) and reports `workflowRun.baseRecorded {runId, baseSha, files}`; the engine keeps the first one
as `WorkflowRun.baseSha` and `baseFiles`. With a gate before the first step that happens when the
gate is passed. A folder that is not a repository, has no commit yet or cannot be read by git
leaves `baseSha` null and the run goes on; runs from before this have it null too.

What changed is always the folder as it is now against the base commit, so committed and
uncommitted work both show. wow makes no commit per step, so "what did this step change" comes
from content hashes: `baseFiles` and each ended step's `StepRun.fileHashes` are lists of
`FileHash {path, hash}` for the files that differed from the base at that moment (SHA-256 of the
file in the folder, null when it is gone or a folder on its path is a link, as when a tracked
folder was replaced by one; a link is hashed as its target path and never followed; a file over
`diff.maxHashBytes` is not read and is hashed as its size and modification time). The size a
file shows is read the same way, so a link never gives the size of what it points at. A step changed a file when the file's hash at the step's end differs from the one in
the list before it (`stepsThatChanged`); a path missing from a list was the same as in the base.
`baseFiles` holds what was already edited when the run began, so the first step is not credited
with it. Changes made after the last step ended belong to no step.

`workflowRuns.diff {runId, path?}` answers `RunDiff {status, message, baseSha, files, omitted,
patch}`. `status` is `ok`, or why there is nothing to compare: `folderMissing`, `noRepository`,
`gitUnavailable` (asked from the folder first, so they win), `noBase`, `baseMissing` (the commit
is gone) or `failed` with git's message. Each `RunDiffFile` has `path`, `oldPath` (renames),
`status` (`added`, `modified`, `renamed`, `deleted`), `added` and `removed` line counts, `size`
(in the folder, or in the base for a deleted file), `content` (`text`, or `binary` / `tooLarge`
for a file that shows status and size only: binary by git's own test, too large when over
`diff.maxFileBytes`) and `changedBy` (step ids). The list is sorted by path and cut at
`diff.maxFiles`, with `omitted` saying how many were left out; the hash lists are cut the same
way. Without `path` no content is sent. With `path` the answer holds that one file and its
unified diff from the first hunk on; the path is only looked up among the files git listed, so it
cannot name anything else. A new file git does not track yet has no diff of its own: its lines
are read and sent as added lines. A rename shows only when git sees it (committed or staged); a
file moved without telling git lists as one deleted and one added file.

### Working copies

`apps/server/src/workspaces` (review loop spec 36 to 39). A workflow with `ownWorkingCopy` (the
builder's "Own working copy" switch) runs each run in a Git worktree of the project's repository
instead of the project folder. A worktree, not a clone, because it needs no credentials and no
second download; on no branch, because the agent's delivery skill names and creates its own
branch and wow does not guess a project's branch names. Without the switch nothing here runs and
the run works in the project folder as before.

`WorkflowRun.workingCopy` is `WorkingCopy {path, state, startSha, defaultBranch, note, unpushed,
error}` and is the only state; `runFolder(run, projectFolder)` in contracts is the folder a run
works in, and everything that reads a run's files uses it (the step threads' `cwd`, the run
base, the step hashes, artifact detection, `workflowRuns.diff`, and `files.read`, which allows
the working copy first and still the project folder).

- **Named at the start.** `startRunEvents` stores the copy as `pending` with its path:
  `workspaces.root` (a full path, or a folder inside `WOW_HOME`, default `workspaces`) and a
  folder `<project name as a slug, 16 characters at most>-<8 hex of the run id's SHA-256>`. The
  name is short so Windows paths stay short. The path is decided without touching the disk
  because the orchestrator does no I/O and each step's thread is created with it as `cwd`, so
  no step of such a run can ever start in the project folder.
- **Made before the first prompt.** `Workspaces` (`service.ts`) hears the `pending` run and
  makes the worktree; the runner awaits `prepare(runId)` before it records the base and sends a
  step's prompt. `createWorkingCopy` (`working-copy.ts`) checks that the project folder is a
  repository with a commit, fetches the primary remote when `workspaces.fetchBeforeCreate` is
  on (`git fetch --no-tags --no-recurse-submodules <remote>`, which only moves the
  remote-tracking branches of the project's repository), finds the default branch
  (`refs/remotes/<remote>/HEAD`, else what the remote answers to `ls-remote --symref` after a
  fetch that worked, else `main` or `master` if the remote has one) and runs `git worktree add
--detach <path> <commit>`. The commit is the remote branch's tip after a fetch that worked.
  Otherwise it is the local branch of that name, then the tip as last fetched, then the commit
  the project folder is on, and `note` says which and why ("Fetching origin failed (…), so the
  working copy starts at the local tip of main."). `workflowRun.workingCopyReady` stores
  `ready`, `startSha`, `defaultBranch` and the note. The project folder's files, index and
  branch are never touched.
- **Failing.** Anything that stops this (no folder, no git, not a repository, no commit, the
  target taken, no disk space, a path too long: git's own message is kept) is
  `workflowRun.workingCopyFailed`: the copy becomes `failed` and the engine's `setupFailed`
  input fails the run at the step it is on, whether that step was about to get its prompt or
  waits at a gate before it. No turn starts, and nothing falls back to the project folder (spec
  38).
- **After the run.** When a run with a `ready` copy has ended and no turn of its threads is
  still running (a stopped run's turn is interrupted after the run ended, so `turn.ended` is
  heard too), `settleWorkingCopy` counts what would be lost: files `git status` lists
  (changed, staged or new), ignored files and folders (`ignoredFiles`, each ignored folder once:
  git keeps nothing of them, and an agent's local file may be the only copy) and commits that
  `HEAD` reaches and neither a
  remote-tracking branch nor the start commit does (`readUnpushed`). With none, `git worktree
remove` without `--force` removes the folder (git itself refuses if something is there after
  all) and the copy is `removed`. Otherwise it is `kept` with `unpushed {uncommittedFiles, ignoredFiles,
unpushedCommits, newestSubject, branch}`. Unpushed commits are counted from every commit `HEAD` has been on in
  the copy (its reflog), so a commit made on no branch and then left still keeps the copy. A removal that fails, for example a file locked on
  Windows, is not retried: the copy is `kept` with the reason in `error`. Both arrive as
  `workflowRun.workingCopySettled`, which is refused for a live run.
- **Remove working copy.** `workflowRuns.removeWorkingCopy {runId}` is the user's answer for a
  kept copy: `git worktree remove --force`, then `removed`. It is refused while the run is
  live, and a failure leaves the copy `kept` with what it held and the reason.
- **Restart.** `Workspaces.recover()` runs before the runner's: a copy still `pending` fails
  its run ("The server stopped while the working copy was being made") and what git had made
  of it is removed with `git worktree remove --force` (the folder is named after the run, so
  nothing else is in it), and a `ready` copy
  whose run ended while the server was down is settled.

- **On a pull request's head.** A run that an event trigger started (see "Scheduler and
  triggers") is the one case of a copy at a pull request: `RunEvent.headSha` is the head commit
  when the event was seen and `RunEvent.headRef` the base repository's ref for it
  (`refs/pull/<n>/head` on GitHub, `refs/merge-requests/<n>/head` on GitLab). After the usual
  fetch, `createWorkingCopy` fetches that ref (when `workspaces.fetchBeforeCreate` is on) and
  checks out the head commit by sha, never by branch name alone: a fork's branch may be called
  like a branch here. The copy is on the branch `WorkingCopy.branch` names only when this
  repository's branch (the local one when there is one, else the remote's, followed with
  `git worktree add --track -b`) is at the head commit, so the agent adds to the pull request.
  Otherwise, or when git refuses because another folder is on the branch, the copy is on the
  head commit and on no branch. When the head commit is not here even after the fetch, the
  copy starts at the default branch as usual. A merged pull request's code is on the default
  branch, so a run of a "pull request merged" event is never left at the pre-merge head commit
  off its branch: when its branch is gone or is not at the head commit here, the copy starts at
  the default branch's tip (after the usual fetch); only events on an open pull request (checks
  failed, review comment) start detached at the head commit. `note` says which. A branch name
  git would read as an option, or a head that is not a commit name, is not used. A run from
  before heads were kept has no `headSha` and starts at the default branch.
- **Shared.** When the pull request already has a working copy, the event's run gets the same
  `path` with state `ready` and a note naming the run that made it; nothing is made. The
  folder is therefore judged per folder, not per run: it is settled once no run that names it
  is live or has a turn running, the outcome is stored on every one of those runs, and
  "Remove working copy" is refused while another run still works in it.

The git commands are in `projects/git.ts` beside the reading ones and run the same way: hooks
and the file system monitor off, no prompt, and `core.longpaths` on for the worktree commands.
Their time limit is `workspaces.gitTimeoutMs`, since a fetch takes longer than a read. wow
installs nothing in a working copy and runs no command the repository declares; that is the
agent's work. Known limits: a project folder that is a subfolder of its repository gets the
whole repository as its working copy, with the copy's root as `cwd`; a kept copy is not looked
at again after someone pushes from it by hand; a step thread of an ended run keeps the removed
folder as its `cwd`.

### Plan runs

A plan run works through a plan's ready units by itself (review loop spec 40 to 47). It starts
ordinary runs, one per unit and one at a time, so gates, review, notifications and working
copies work for a unit's run as for any other. Nothing is merged: a unit counts as delivered
only when the host shows its pull request merged.

- **Rows.** `Workflow.forUnits` is the builder's "For units" switch. `PlanRun` (topic
  `planRuns`, table `plan_runs`) is `{id, planId, projectId, intentId, workflowId, state, units,
waitingFor, message, startedAt, endedAt}`. `state` is `running` while a unit's run is live
  (also while that run waits at a gate), `waiting` while units remain and none is ready, `done`
  when every unit is delivered, `failed` when a unit's run failed or was stopped and the failure
  setting says stop, and `stopped` by the user. `units` lists the units it started a run for,
  in order, as `PlanRunUnit {unitKey, title, runId, outcome}` (`running`, `done`, `failed`,
  `stopped`); `waitingFor` holds one sentence per unit that is not delivered while it waits;
  `message` says why it failed. A unit's run carries `WorkflowRun.unit` (`RunUnit {planRunId,
planId, intentId, unitKey, title}`) and has the id `<planRunId>.<unitKey>`.
- **Decisions** (`packages/workflow-engine/src/plan-run.ts`, pure). `planRunRefusal` says why a
  plan run cannot start: the workflow is not for units, a plan run is already live on the plan
  (one unit at a time), the intent has no plan, the plan has `source: issues`, the plan or its
  spec is stale (the reason names the file and both revisions), the plan is not followed (only
  a followed plan has ready units), or it has no units or every unit is delivered.
  `advancePlanRun` takes the plan run, the plan's units as the host last showed them and the
  state of the unit's run that is going, and answers the next plan run and the unit to start.
  While that run is live nothing changes. When it has ended its outcome is recorded; a failed
  or stopped run ends the plan run as `failed` when `workflows.planRunOnFailure` is `stop`, and
  with `skip` the unit is left. Then the first unit in plan order that is `ready` and that this
  plan run has not started yet is started. A unit is never started twice in one plan run: one
  whose run ended without a pull request stays `ready` on the host and is named as "No pull
  request found for U1". A unit someone else's pull request claims is not `ready`, so it is
  skipped, and a unit that depends on one that was left is not `ready` either. With nothing to
  start, the plan run is `done` when every unit is delivered and `waiting` otherwise, with
  `waitingSentences`: "U2 waits for U1 to merge", "U1 waits for its pull request to merge", "U5
  is blocked: …", "The run for U1 failed", or the unit's status reason. `stopPlanRun` ends it
  as `stopped`.
- **Server** (`core/plan-runs.ts`). `planRun.start {planRunId, planId, workflowId}` refuses with
  the reason or stores the plan run and, in the same commit, starts the first unit's run
  through `startRunEvents` with the unit; a first unit whose run cannot start refuses the
  start. A unit's run always gets its own working copy, whatever the workflow's "Own working
  copy" switch says (spec 40). `planRun.stop {planRunId}` stops the live unit run with the
  engine's `stop` input in the same commit, so its turn is interrupted and its threads and
  working copy stay as for any stopped run (spec 45). `planRun.advance {planRunId}` is an
  `InternalCommand` that decides again; a decision that changes nothing stores nothing, and a
  later unit whose run cannot start ends the plan run as `failed` with the reason. Each change
  is one `planRun.changed` event with the whole row.
- **What moves it** (`plans/plan-runs.ts`, `PlanRuns`). The service listens to commits and
  sends `planRun.advance` when a run with a `unit` has ended and when `plans.synced` touches
  the plan of a live plan run. After a unit's run ends it first has the poller read the plan
  once (`HostPoller.readPlan`) and sends the command when that read is stored or has failed,
  so the next unit is picked from what the host shows now and a unit someone else claimed
  while the run was going is skipped (spec 42). Until that read is done, a `plans.synced` for
  the plan (a plan file edited, say) does not advance the plan run: its statuses are from
  before the read. Only the end of a unit's run asks; later changes to the ended run (its
  working copy settled) do not. That read is a consequence of the plan run the
  user started, so it happens whatever the polling settings say; a host whose request limit
  is used up is still left alone. `plans.synced` is how a host poll reaches a plan run: the
  poller's `hosts.sync` changes unit statuses, the orchestrator stores them as `plans.synced`,
  and the waiting plan run starts the unit that became ready (spec 41). A plan whose folder is
  gone fails its plan run. At startup `recover()` sends it for every live plan run, after the
  plans were read and the runs recovered.
- **Open plans.** A plan is read from the host while it is followed or a plan run is live on
  it (`planIsOpen` in `core/hosts.ts`, and the poller's `#openPlans`). Unfollowing during a
  plan run keeps the read and the unit statuses; when the plan run ends on a plan that is not
  followed, the read is forgotten and the units show what the files say, in the same commit
  (`closePlanEvents`).
- **Prompt.** `renderStepPrompt` adds the unit text to every step of a unit's run:
  `workflows.unitPromptTemplate` (project scope) rendered with `intentId`, `unitKey`,
  `unitTitle` and `intentUnitLine`. The `Intent-Unit: <intent-id>/<unit-key>` line in the pull
  request body is how wow finds the pull request afterwards; a step that gets the built-in skill
  `wow-pull-request` is asked for it there, so `intentUnitLine` is empty and the default leaves
  its sentence out. A run from before wow skills, or one with automatic attaching off, gets the
  sentence as before. A send back message
  does not repeat it; the thread already has it.

## Scheduler and triggers

A local card with a workflow and a project has one trigger, id `<cardId>:trigger`, at its start
(`core/triggers.ts`); a repeating card's trigger waits at its next occurrence instead (see
"Repeating cards" below). `card.create` and a `card.update` that changes the start, zone, project or
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
  occurrence a `card_occurrences` row (`CardOccurrence`): `fired` with its run, `failed` (the
  run could not start), `skipped` (the card's earlier run was still going) or `missed`, with a
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
  without it, so only the newest missed occurrence offers it. A latest occurrence whose card still has a live run (the newest
  run the card follows, or any run its records name) starts nothing: it is recorded `skipped`
  with the reason and a `skipped` notification "Occurrence skipped" (spec 7; older rows of it
  keep the kind `failed` they were stored with). Then the trigger
  waits for the next occurrence; after the last one it is `fired` (or `cancelled` when nothing
  ever ran, and the card, still `scheduled`, becomes `done`: every remaining occurrence was
  skipped). The run has `WorkflowRun.occurrence {date, start}`, which names it by its day, and
  its "Workflow run started" notification ends with the day. The card follows its newest run as
  a single card does. `card.runNow` on a repeating card answers the occurrence that offers
  "Run now" and leaves the trigger waiting. A card that ran and is made single again (or
  undone back to single) puts its trigger back to `fired` with that run.
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
  day on. `card.delete` of a series with a live run needs `stopRun` as for a single card. The
  inverse commands (`assistant/changes.ts`) carry `repeat` and `skippedDates`, so one Undo
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

**Event triggers** (review loop spec 48 to 53) are rows of the same table with `kind: 'event'`:
a project, an event (`merged`, `checksFailed`, `commentAdded`), a workflow and `enabled`.
`trigger.create`, `trigger.setEnabled` and `trigger.delete` are the commands; a card's trigger
keeps `kind: 'card'` and goes with its card. `isCardTrigger` and `isEventTrigger` in contracts
narrow a row to the fields its kind has, and the scheduler's tick only looks at card triggers.
There are no webhooks: an event is something a read from the host shows.

- **Seeing an event.** `hosts.sync` (see "Hosts") compares every pull request it has just read
  with the stored row (`seenEvents` in `core/triggers.ts`): merged now and not before; checks
  failed now and either not before or on another head commit; a newest review comment the
  stored row did not have. A pull request read for the first time has no stored row, so what
  is already true when a plan is followed starts nothing, and a trigger made later only ever
  sees later changes (spec 50). Only pull requests a followed plan or a run still names count,
  which are the only ones the poller reads.
- **One run per event and trigger.** Each event has an id from the host: `<changeRequestId>:merged`,
  `<changeRequestId>:checksFailed:<head commit>` and `<changeRequestId>:comment:<comment id>`.
  A trigger that fires stores `trigger.eventSeen` (the `trigger_events` table), and an event
  it has seen is skipped, so checks that fail again on the same commit, or a force push back
  to a commit that already failed, start nothing (spec 49). The run's id is derived from the
  trigger and the event (`eventRunId`). Several new comments in one read are one event, for
  the newest, so a review with ten comments starts one run.
- **A run's answer starts nothing.** A review comment that arrives while the trigger's own run
  for that pull request is still going, or one by an account in
  `triggers.ignoredCommentAuthors`, is recorded as seen and starts no run. Otherwise a run that
  answers the review with a comment would start the next run, without end. wow cannot tell
  which account an agent writes as, so a person's comment made during that run is passed over
  too.
- **A fork starts nothing.** A run on a fork's pull request would check out the fork's head
  commit, and the fork's files (agent instruction files, skills, hook settings, scripts a
  workflow runs) would steer an agent on this computer. So an event on a change request with
  `fromFork` is recorded as seen without a run and a `failed` notification "Trigger started
  nothing" says why and names the setting, unless `triggers.forkPullRequests` (off by default,
  global or per project) allows it. Turning the setting on later starts nothing for events
  already seen. `RunEvent.fromFork` keeps what the read said.
- **Off means never.** While `triggers.eventsEnabled` is off, the scheduler is paused or the
  trigger itself is off, nothing starts. The stored pull request moves on all the same, so
  the event is not seen again and nothing starts for it later (spec 52).
- **The run.** It is an ordinary run with `WorkflowRun.event` (`RunEvent`: trigger, event,
  pull request id, number, link, branch, head commit and head ref, whether it is from a fork,
  and for a comment its link
  and author). The handover template's `event`, `pullRequestNumber`, `pullRequestName`, `pullRequestUrl`,
  `pullRequestBranch`, `commentUrl` and `commentAuthor` placeholders carry it into every step's
  prompt (`eventValues` in the workflow engine). The comment's text is never copied: it is someone
  else's text and must not become an instruction in a prompt wow writes, so the agent reads it
  at the link (spec 51). The author is cut down to the characters account names use. A
  project that stored its own handover template gets these lines only after adding the
  placeholders.
- **Its folder.** An event's run always works in a working copy. When a run whose last read
  from the host names the pull request has one on disk (the run is still going, or its copy
  was kept), the event's run works in that same folder; otherwise it gets a new one on the
  pull request's head commit (see "Working copies").
- **Failing.** A run that cannot start (the workflow is gone, say) stores the event as seen
  without a run and a `failed` notification "Trigger failed" that opens the Triggers tab
  (spec 53); it is not tried again. A started run stores "Workflow run started". The trigger
  row's `runId` is the last run it started.
- A project's event triggers are removed with the project.

Notifications are the server's channel to the user. While `scheduler.notifications` is on, the
orchestrator stores a `notification.sent` row when a trigger starts a run, when a run waits at a
gate and when a run or a trigger fails; ids derive from the run, step and gate, so a repeated
transition notifies once. A wait after a send back adds the reviewed step's attempt to the id
(`<runId>:waiting:<stepId>:<position>:attempt-<n>`), so each attempt is told once (review loop
spec 19). Clients read the `notifications` topic (newest first): the web app shows
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
  `providers.offerSetup`
- chat: `chat.contextMeter`, `chat.resumePrompt`, `chat.groupToolCalls`, `chat.toolOutputLines`,
  `chat.starterCount`, `chat.skillTrigger`, `chat.notifications`, `chat.finishedAfterSeconds`,
  `chat.threadTitleMaxLength`, `chat.threadSearchMaxLength`, `chat.editDiffMaxLines` (see "Chat
  view"), `chat.contextWarnPercent`, `chat.reasoningOpen` (see "Conversation reading"), `chat.fileTrigger` (see "Panel tabs and files in chat"), `chat.imageMaxBytes` (see
  "Images in the composer")
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
- workflows: `workflows.templates`, `workflows.handoverTemplate`, `workflows.sendBackTemplate`,
  `workflows.unitPromptTemplate`, `workflows.planRunOnFailure` (the last two are project-scoped,
  see "Plan runs"), `workflows.verdictApprovedLine`, `workflows.alwaysStopSkills`,
  `workflows.gateChecksTimeoutMinutes` (project-scoped, see "Gates that pass by themselves"),
  `workflows.verdictChangesRequestedLine`, `workflows.verdictBlockedLine`,
  `workflows.goBackTemplate`, `workflows.maxStepVisits` (project-scoped, see "Rules" under
  "Workflow engine"), `workflows.attachBuiltInSkills` (project-scoped, see "Skills of a step")
- skills: `skills.directories`, `skills.includeClaudePlugins`, `skills.builtInOff` (see "wow
  skills")
- plans: `plans.intentsDirectory` (project-scoped), `plans.writeSettleMs` (see "Plans")
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
- hosts: `hosts.polling`, `hosts.pollSeconds`, `hosts.listFallbackCount`,
  `hosts.longestWaitMinutes`, `hosts.pageMaxBytes` (see "Hosts")
- triggers: `triggers.eventsEnabled`, `triggers.forkPullRequests`, `triggers.ignoredCommentAuthors` (the "Event triggers" page, see "Scheduler and triggers")
- viewer: `viewer.maxFileBytes`, `viewer.htmlScripts`, `viewer.highlightMaxBytes`,
  `viewer.fileListLimit`, `viewer.fileMatchesShown` (see "Files" and "Panel tabs and files in
  chat")
- diff: `diff.maxFileBytes`, `diff.maxFiles`, `diff.maxHashBytes` (the "Changes" page, see "Run base and changes")
- workspaces: `workspaces.root`, `workspaces.fetchBeforeCreate` (project-scoped),
  `workspaces.gitTimeoutMs` (the "Working copies" page, see "Working copies")
- assistant: `assistant.providerInstanceId`, `assistant.allowCodex`, `assistant.model`,
  `assistant.effort`, `assistant.instructions`, `assistant.greeting`,
  `assistant.startSoonMinutes`, `assistant.diagnosisLimit`, `assistant.valueLength`,
  `assistant.secretPatterns`, `assistant.askRefusedWords`, `assistant.modelGuidance` (see
  "Assistant", "Question card" and "Models for steps")
- appearance: `appearance.theme`, `appearance.uiFont`, `appearance.codeFont`, `appearance.density`,
  `appearance.paletteRecent`, `appearance.contextPanel`, `appearance.contextPanelWidth`
- keybindings: `keybindings.*`, one per command that has a shortcut
- desktop: `desktop.autostart`, `desktop.closeToTray`, `desktop.startMinimized`
- updates: `updates.enabled`, `updates.checkIntervalMinutes`
- advanced: `advanced.port`, `advanced.logLevel`, `advanced.secretsTimeoutMs`,
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
`settings` topic. Notifications use Electron's `Notification`, gated by `scheduler.notifications`,
and are derived from changes on the `workflowRuns` topic: a new run, a run entering `waiting`, a
run entering `failed`. Chat threads' notifications come from the `notifications` topic instead
(rows with a `threadId` stored after the first snapshot, `chatNotices`), are not shown while the
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
and `symbolic-ref --short HEAD`, with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `GIT_OPTIONAL_LOCKS=0`
(`gitEnvironment`), so nothing waits for credentials (no terminal prompt, no Git Credential
Manager window on Windows) or takes a lock, and `trackers.gitTimeoutMs` as the limit. Without git on the
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
the primary remote is on the stored GitLab site, the rule the host poller picks its adapter by,
else `github`); it is read on demand, not projected,
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

## Plans

wow reads agent-os plans; it never writes an intent, spec or plan file and never runs an agent-os
script (review loop spec 21 to 25).

**Parser** (`packages/agent-os`). `readIntent({id, intent?, spec?, plan?})` takes the text of one
intent folder's files and answers title (the first `# ` heading), status and revision from the
frontmatter, whether the spec and the plan are stale, the plan's units and the problems found. It
follows agent-os's own parser (`quality-ratchet/scripts/intent-files.mjs`) rule for rule, because
calling that script would mean running repository code and it is not always installed:
frontmatter is a flat `key: value` block between `---` lines; `built_on` is `<kind>@<n>` and a
file is stale when that number is lower than its source file's `rev` (the intent for a spec, the
spec for a plan); a unit is a `- [KEY] title` line under `## Units`, with notes split on an em
dash or `--` with spaces around, `depends on A, B` and `blocked: reason` read without regard to
case; a unit's contract is its `### KEY` section, read into the nine agent-os fields. With
`source: issues` the tracker holds dependencies and contracts, so units carry key and title only
(spec 22); a `blocked:` note on such a line is still kept, because it decides the unit's status
(spec 23 and 24) and a blocked unit must not read as unknown. A `rev` or `built_on` number too
long to be held exactly is a bad one.
The package has no dependencies and does no I/O. Nothing throws: a file without frontmatter, a
bad `rev`, `built_on` or `source`, a plan without `## Units` lines, a key that appears twice, an
unknown dependency, a unit without its section and a folder name that is not an intent id each
become a problem `{file, line, message}`, and everything that can be read is still returned. A
contract field a section does not have is absent, not a problem, because older plans predate
some fields.

**Service** (`apps/server/src/plans/service.ts`). For every project it resolves
`plans.intentsDirectory` (default `intents`, project-scoped, a relative path that may not leave
the project folder and may not be the project folder itself) against the project folder, lists the folders in it and reads each one's
`intent.md`, `spec.md` and `plan.md`. Links are not followed: an intent folder or file that is a
link is skipped, and the intents folder is only read when its real location (`fs.realpath`, so
links and Windows junctions anywhere on the path are resolved) is inside the project's real
folder; one that leads out is refused with a warning in the server log. A folder with none of the
three files is not an intent. Every intent is checked against the `PlanIntent` contract before it
is stored; one that does not fit becomes a row with the single problem "Cannot be shown: …",
because a row the contract rejects would fail the topic's snapshot for every project. The result
goes through the engine as the internal `plans.sync` command; the orchestrator compares it with
the stored rows, so `plans.synced` carries only what changed and an unchanged read stores nothing.
It reads at start, when the project list or a plans setting changes, when the watcher reports a
change, and on `plans.refresh`. Reads that arrive while one is waiting share it.

**Watcher** (`apps/server/src/plans/watch.ts`, chokidar, the plans service's own). The intents
folders are watched one level deep, which covers `<id>/{intent,spec,plan}.md`. A save in place
empties a file before writing it, and a read in between would store an empty plan with no later
event to correct it, so a change is reported only once the file has kept its size for
`plans.writeSettleMs` (default 200 ms, chokidar's `awaitWriteFinish`; 0 turns the wait off). An
intents folder that does not exist yet is waited for: the nearest existing folder above it, never
above the project folder, is watched for the next part of the path only, and each time that
appears or goes the read works out again what to watch, so a folder created or removed later is
followed without a restart. The watcher is ready before the files are read, so a change made
during a read is reported after it. Not followed: a project folder that does not exist when the
plans are read, and an intents folder refused as a link; both are looked at again on the next read
("Refresh now", a project or setting change, a restart).

**Rows.** `PlanIntent` (topic `planIntents`) is one intent folder: `hasIntent`, `status` and
`rev` of the intent, `spec` and `plan` as `PlanFile` (`{rev, status, stale: {builtOn, current}?}`,
null when the file is missing), `source`, `units` and `problems`. A `PlanUnit` is `{key, title,
line, dependsOn, blocked, contract, status, statusReason, changeRequestId}`; `contract` lists all nine fields with
null for one the section lacks, and is null for `source: issues`. The server decides `status`, `statusReason` and
`changeRequestId` (the pull request that delivered or claims the unit) in the orchestrator
(`core/hosts.ts`, `withUnitStatus`), so the plans service only says what the files say. A plan
that is not followed, or whose host has never been read, shows what the files alone say:
`blocked` when the unit's line has a `blocked:` note (the note is the reason), otherwise
`unknown` with the reason (not followed, not read yet, GitHub not set up, or what the host
answered). A plan with a live plan run counts as followed here until that plan run ends (see
"Plan runs"). A followed plan with a read shows `delivered`, `claimed`, `blocked`, `ready` or
`waiting` from its pull requests, see "Hosts". `followed` is the plan's Follow switch; it is kept
when the files are read again and goes with the row when the intent folder does.

**View** (`apps/web/src/plans`, section "Plans" after Workflows, `keybindings.goPlans`). `/plans`
lists every project with its intents: title, status and revision, spec and plan presence, "stale"
and the number of problems. `/plans/$projectId/$intentId` shows the three files with a stale
badge that names both revisions, the problems as `plan.md line 11: …`, and the units with key,
title, dependencies, blocked note and status; the reason units share shows once above the list.
`?unit=<key>` opens that unit's contract, rendered with the shared markdown renderer. The header
has the Follow switch (`plan.follow`); a followed plan shows "Last fetched <time> from <host>",
the host's error when the last read failed (with a link to the setting it names) and its own
"Refresh now" (`hosts.refresh {planId}`). A unit with a pull request links to it on the host and
shows its state (Open, Draft, Merged, Closed) and checks; a waiting unit shows what it waits for,
which names the stale file when that is the reason. "Refresh now" in the list reads the files and
then asks the hosts about everything followed. Palette: "Plans: Refresh now", every intent (when
searching), and for the open plan "Plan: follow" / "Plan: stop following", "Plan: refresh pull
requests now", each unit and each unit's pull request.

**Plan run in the view** (`plan-run-section.tsx`, `plan-run.ts`; review loop spec 40, 41, 45).
Above the units a plan with a `plan.md` has "Run ready units" and, when more than one workflow
is marked "For units", a select for the workflow (`unitWorkflows`, by name). The button is off
with the reason beside it while a plan run is live on the plan, the plan is not followed or no
workflow is for units (`runReadyUnitsBlocked`); whether a plan run really starts is the
server's decision, and its refusal shows as an alert under the button. Below it is the plan's
plan run (`shownPlanRun`: the live one, else the one started last) as a region "Plan run": its
state, the workflow and times, why it failed, the sentences it waits for, the units it started
with a link to each run and that run's state ("Waiting for you" while it is at a gate), and
Stop while it is live. Stop asks first (`planRunStore`, a `ConfirmDialog`), like stopping a
run. Palette, for the open plan: "Plan: run ready units with <workflow>" for each workflow for
units, "Plan: stop the plan run" (opens the same question) and "Open the run for <unit>". The
run view of a unit's run names its unit with a link back to the plan.

## Hosts

wow reads pull requests from a project's code host to show unit status and a run's pull request
(review loop spec 23 and 26 to 32). It only reads: every request is a GET, and nothing is merged,
approved or commented on. GitHub and GitHub Enterprise Server are the first host; GitLab
(merge requests, spec 34) and the others join behind the same interface.

**Types** (`packages/contracts/src/hosts.ts`). `ChangeRequest` is a pull request as last read:
number, title, link, `state`, `draft`, `mergedAt`, head branch and commit, `fromFork` (the head
is in another repository: GitHub's `head.repo.full_name` is not the base repository's, or
`head.repo` is null for a deleted fork; GitLab's `source_project_id` is not `target_project_id`;
an answer that leaves them out counts as a fork; rows read before migration 0021 hold false
until read again), the `Intent-Unit`
lines of its body as `units`, `checkState` with every check (`HostCheck`: name, state, link),
the review comments (`ReviewComment`: author, text, file, link) and `newestCommentId`. Event
triggers and plan runs compare the next read with this row, which is why it keeps the state,
head commit, check result and newest comment. `HostRead` is what was last read for one scope, a
followed plan (`plan:<planIntentId>`) or a run (`run:<runId>`): the host, the change requests
that are the scope's own, `fetchedAt` and `error` (`HostError`: `notSetUp`, `refused` or
`failed`, a sentence, the setting to look at, and when it was first seen). Topics `changeRequests`
and `hostReads`. Orchestration and the UI see only these; what a host calls things stays in its
adapter.

**Adapter** (`apps/server/src/hosts/adapter.ts`, `github.ts`). `HostAdapter` has three reads:
`findForIntent(intentId)`, `findForBranch(branch)` and `read(found)`. The GitHub adapter uses
the tracker client's HTTP helper (`trackers/http.ts`) and the project's GitHub tracker settings
as `trackers/resolve.ts` resolves them, so Enterprise Server is the same code under
`https://<host>/api/v3`. A plan's pull requests are found with one search
(`GET /search/issues?q="<intent-id>" in:body is:pr repo:<owner>/<repo>`; not the whole phrase
`Intent-Unit: <intent-id>/`, which a line in bold, underscores or quote marks does not hold), and only
a body that really has an `Intent-Unit: <intent-id>/<unit-key>` line counts (every such line is
taken, also as a list item, quoted with `>`, in bold, backticks or quote marks, or with
punctuation or words after the key; `intentUnitLines`
in `packages/agent-os`). A host whose search is missing or refuses the
query (404, 405, 410, 422, 501) gets its newest pull requests read instead, as many as the
fallback count setting says; the whole repository is never listed. A run's pull request is the
newest one whose head is the branch the run's folder is on
(`GET …/pulls?head=<owner>:<branch>&state=all`). For each pull request it then reads the pull
request itself when the search did not say where its head is, check runs and commit statuses of
the head commit (both, because Enterprise Server versions differ; an endpoint that answers 404,
410 or 501 means no checks from it), and the review comments. Failed, timed out, cancelled and
action-required check runs and failed or errored statuses are failing; anything not completed
is pending. 401 and 403 are `refused` and name the GitHub token setting, as does 404 on the
repository (a token without rights gets that); a used-up request limit, any other status and a
timeout are `failed`. The token goes into the `Authorization` header and nowhere else: not into
an error, a row or a log line. What the host answers is not trusted: a link is kept only when
it is an http or https address (a pull request without one is left out, as is a comment; a
check keeps its name and loses the link), a pull request number must be a positive integer and
a comment must have an id. A `Retry-After` or reset that gives no valid date is ignored.

**GitLab** (review loop spec 34; `hosts/gitlab.ts`, `trackers/gitlab.ts`). A project is on
GitLab when its primary git remote is on the host of the stored `trackers.gitlab.baseUrl`
(`gitLabProjectOf` in `projects/git.ts`; any host can run GitLab, so the remote alone never
decides, and a site under a sub-path has that prefix cut from its https remotes; an https remote
on the same host outside that sub-path is not the site's). The project
path keeps every nested group (`git@gitlab.example.test:group/sub/app.git` is `group/sub/app`)
and goes to the API URL-encoded as one project id (`group%2Fsub%2Fapp`). Such a remote names no
GitHub repository, and the poller reads that project from GitLab instead of GitHub
(`TrackerService.gitlabHost`, the poller's `resolveGitLab`). API v4 under `<site>/api/v4`, with
the token in the `PRIVATE-TOKEN` header and nowhere else: GitLab requests do not follow redirects
(fetch would carry that header to another origin), and a 3xx answer is `failed` and asks to check
the URL. Merge requests fill the role of pull
requests: a plan's are found with one
`GET /projects/<id>/merge_requests?state=all&search=<intent-id>/&in=description` (the id, not the
whole phrase, for the same reason as on GitHub),
filtered to descriptions that really carry the line, falling back to the newest
`hosts.listFallbackCount` when the search is turned down (400, 405, 422, 501); a run's is the
newest with `source_branch=<branch>`. `iid` is the number, shown as `!12` (`changeRequestRef`,
`changeRequestName` in contracts); `opened` is open, `merged` merged, `closed` and `locked`
closed; `draft` (or `work_in_progress` before version 14). Checks are the jobs of the newest
merge request pipeline on the head commit (`…/merge_requests/<iid>/pipelines`, then
`/pipelines/<id>/jobs`); a merged-results or merge-train pipeline runs on a merge commit, so when
no listed pipeline has the head's sha the merge request's own `head_pipeline` is taken, while the
merge request is still at that head (`GET …/merge_requests/<iid>`): failed and canceled jobs fail, a failure the job is allowed passes,
skipped and manual jobs are left out, anything still to run is pending, and a pipeline without
jobs counts as one check. A failed, canceled or running pipeline whose listed jobs show no failure
or nothing pending (a child pipeline, a job past the first page) adds a `pipeline <id>` check with
its own state, so it never reads as passing. 403, 404, 410 and 501 there mean no checks (CI off). Notes are the
review comments, without GitLab's system notes, linked as `<merge request>#note_<id>`. 401 and
403 are `refused` and name `trackers.gitlab.token`, as does 404 on the project; a 429 with
`Retry-After`, or `RateLimit-Remaining`/`RateLimit-Reset`, leaves the site alone like GitHub's
limit; anything else and a timeout are `failed`. Unit status reasons say "Merge request !12 is
merged", and so do the gate's checks part (`ChecksReading.host`), an event run's line,
notification and handover (`runEventHost`, `triggerEventLabel`), and the Pull request tab's name
and empty text, which read "Merge request" on a run whose host read is GitLab
(`pullRequestTabLabel`). The Triggers tab's rows, its palette commands and New trigger's event
choices say "Merge request merged" for a project whose newest host read is GitLab, or, before
any read, whose `ProjectGit.codeHost` is (`projectCodeHost(reads, projectId, unread)` in
`packages/contracts/src/hosts.ts`, used from `apps/web/src/workflows/triggers.ts`; the web's
`useProjectsGit` asks `projects.git` again when a stored `trackers.gitlab.baseUrl` changes). The
server words the same way before any read: `TrackerService` caches each project's
`ProjectGit.codeHost` (`codeHost(projectId)`, read at start, when a project is made or moved and
when a GitLab site is stored), the engine hands it to `DecideContext.codeHost`, and `codeHostOf`
(`core/orchestrator.ts`) is used by the duplicate-trigger refusal and the assistant's change rows
and proposals; the assistant's diagnosis reads the cache directly. The default handover names
the event's request with `pullRequestName` ("Merge request !12" or "Pull request #14"). GitLab issues are not read. `hosts/mock-gitlab.ts` (`MockGitLab`) is the invented
GitLab the server tests and the e2e server share.

**Poller** (`apps/server/src/hosts/poller.ts`, started with the scheduler and stopped right
after it). A round asks only about open plans (followed, or with a live plan run, see "Plan
runs") and live runs (running or waiting), grouped by project; a project with neither is not
asked about and its git is not read. It runs at every poll interval while polling is on and the
scheduler is not paused, once when a plan is followed or a run starts under the same
conditions, and once for `hosts.refresh` whatever those settings and the host's request limit
say (spec 30). `readPlan` asks about one open plan when a plan run's unit run has ended,
whatever those settings say but not past a used-up request limit (see "Plan runs"). A run whose
gate starts waiting for its pull request's checks is asked about once in the same way, because
its step has most likely just pushed; later rounds ask about it like any live run, and the
`hosts.sync` of each read decides the gate. The poller also keeps one timer for the earliest end
of such a wait (`workflows.gateChecksTimeoutMinutes` after the step ended, for the run's
project) and then sends `workflowRun.checkGate` (`checkGates()`; see "Gates that pass by
themselves" under "Workflow engine"). At start it calls `checkGates()` once after the first
reads, so a wait that ran out while the server was stopped ends even when no read is stored. Per project it resolves the GitHub settings and the
folder's branch (`TrackerService.githubHost`; without a token nothing is asked and the reads
say which setting is missing; the shared token goes only to a host the user chose, so when the
API URL comes from the folder's git remote and is neither the stored `trackers.github.baseUrl`'s
host nor paired with the project's own token, nothing is asked and the read names that setting; a run with its own working copy is asked about the branch that
copy is on, read with `readCurrentBranch`, and about nothing while the copy is on no branch or
gone), finds the plan's and the run's pull requests, and reads each pull
request once a round; a pull request already stored as merged is not read again. The first
failure ends the project's round, since a refused token or a host that is down fails the rest
the same way. Each pull request read is parsed with the `ChangeRequest` schema before it is
stored; one the schema turns down is not stored, and only the plan or run that names it gets a
`failed` read saying which pull request and field, so a bad answer can never break the
`changeRequests` topic. GitHub's `x-ratelimit-remaining`, `x-ratelimit-reset` and `retry-after` headers
stretch the interval: a host with fewer requests left than the round took, or that refused for
the limit, is left alone until the limit starts again, but never longer than
`hosts.longestWaitMinutes` (a host may ask for a wait of years; `waitBound` in
`hosts/adapter.ts` cuts it for every host adapter). The pause belongs to the host and the
token (kept in memory as a digest), so a project with its own token on the same host is still
asked. Rounds run one after another.
`startServer({hostTimers, clock, fetch})` lets tests fire the timer, move the clock and answer
for the host; `hosts/mock-github.ts` is the invented host the server tests and the e2e server
share.

**Storing** (`core/hosts.ts`). A round ends in one internal `hosts.sync` command per project
with each scope's outcome and the change requests read. The orchestrator turns it into
`hosts.synced` (rows that changed, and rows that went) and, when unit statuses change,
`plans.synced`. A failed scope keeps its change requests and `fetchedAt` and gets the error
(spec 31); an error that repeats keeps the time it was first seen, so a host that stays down
stores nothing new. A change request no read names any more is removed, as is everything read
for a plan when it is unfollowed or its folder goes, and a project's rows with the project. A
finished run keeps its last read; it is just not asked about again. In the same decision the
project's event triggers see what the pull requests just read show that the stored rows did
not, and their runs start in the same commit (see "Scheduler and triggers").

**Tickets** (review loop spec 33; `hosts/jira.ts`, `hosts/jira-wiki.ts`, `core/tickets.ts`).
Jira (Cloud, Server and Data Center) is the ticket host. After a round has read a project's pull
requests, the poller works out the ticket of each live run it asked about, in this order: the
Jira issue the run's backlog item was published as; else the first `<KEY>-<number>` with the
project's `trackers.jira.projectKey` (any case, not inside a longer word or number) in the title
of the run's pull request; else in the name of its branch (the pull request's head, or the
branch the run's folder is on). Followed plans have no ticket of their own: a unit's ticket is
the ticket of its unit run. Each key is asked for once a round with
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
`trackers.jira.token`, as is 404 ("shows no issue <key> to the Jira token"), which fails only that
ticket, as does a published key that is not a Jira key; a 429 with `Retry-After` leaves the
site alone for that token until then; anything else and a timeout are `failed`, and after such a
failure the site is not asked again that round. A project without a Jira site, token or (for
`cloud-basic`) email, or without a project key when the run has no backlog issue, gets a `notSetUp` read naming the setting; so does a run whose backlog item was
published to another Jira site than the project's (its browse link is not under
`trackers.jira.baseUrl`), and that site is not asked. The round ends in one internal
`tickets.sync` command per project; `core/tickets.ts` stores `ticket_reads` rows through
`tickets.synced` (topic `ticketReads`), keeping the last ticket and its time beside an error while
the key stays the same, and the time an error was first seen while it repeats. A run with no
key gets a row with `key: null` and no error, which the Ticket tab shows as "no ticket found".
The rows go with their project.

**Pages** (review loop spec 35; `hosts/confluence.ts`, `hosts/intent-texts.ts`, `core/pages.ts`).
Confluence (Cloud, Server and Data Center) is the page host, and only pages something links to
are read: no search, no spaces, no attachments, and pages are never given to agents. After a
round has read a project's tickets, the poller collects each live run's texts as last stored:
the description of its ticket (`ticket_reads`), the web addresses of its pull request's body
(`change_requests.links`, which the GitHub and GitLab adapters fill from the body with
`webLinksIn`), and the `intent.md`, `spec.md` and `plan.md` of its intent (the plan unit it
delivers, `run.unit.intentId`, and every intent its pull request's `Intent-Unit` lines name),
read from the project's `plans.intentsDirectory` with links left out (`readIntentTexts`).
`confluenceLinksIn(text, baseUrl)` keeps an address only when it has the stored
`trackers.confluence.baseUrl`'s scheme, host, port and path, and names a page:
`/pages/viewpage.action?pageId=<id>` and `/spaces/<space>/pages/<id>/…` by id (`ref`
`id:<id>`), `/display/<space>/<title>` by title (`title:<space>/<title>`, `+` read as a
space). `webLinksIn` keeps brackets an address opens and closes itself (`Plan+(draft)`), ends
an address at one it did not open (a markdown link's own `)` or `]`), and leaves out one it opens
and never closes; it reads each character of the text once, so a long text without spaces costs
no more than its length. Links to another site are dropped before anything is asked, so the Confluence token never
goes anywhere but the stored site. A run with no links gets a row with no pages and no error,
and costs no request. Each linked page is asked for once a round,
`GET <base>/rest/api/content/<id>?expand=body.view,version,space` or
`GET <base>/rest/api/content?spaceKey=<space>&title=<title>&expand=body.view,version,space`
(the first result; none is a missing page), signed in with a bearer token (`pat`) or email and
API token (`cloud-basic`, `jiraAuthorization`), with redirects turned down. The adapter
(`PageAdapter`, `createConfluenceHost`) answers a `Page`: content id, title, space key, version
and the body as Confluence renders it (`body.view`, HTML), and the page's address made from the
stored site and the answer's `webui` path. The HTML is never rendered in the app: only the
viewer's sandboxed frame shows it. 401 and 403 are `refused` and name
`trackers.confluence.token`. 404, or no result for a title, is `refused` for that page only and
names no setting ("shows no page <id> to the Confluence token … may have been deleted or moved"):
the token works, so the link is what to check; a 429 with `Retry-After` leaves the site alone until then; anything else and a
timeout are `failed`, and after such a failure the site is not asked again that round. A project
without the site gets a `notSetUp` read naming `trackers.confluence.baseUrl` for every live run;
one without the token (or the email on Cloud) names that setting only for runs that link to a
page. A body larger than `hosts.pageMaxBytes` (UTF-8 bytes) is not kept: that page fails
(`failed`, naming the setting) and keeps its last body. The round ends in one internal
`pages.sync` command per project; `core/pages.ts` stores `page_reads` rows through
`pages.synced` (topic `pageReads`). A read whose host answered exactly what it answered before
is not written again: the event names it in `fetched {at, ids}` and the projection moves only its
times (`touchPageRead` in contracts), so unchanged bodies do not go into the history every round;
events from before have no `fetched`. Each `PageLink` keeps its last page
and time beside its own error; the row's `error` is what kept wow from asking or the round's
first refusal or failure (a missing page is only the page's), and its `fetchedAt` the last round
without one. The rows go with their project.

**Unit status** (`unitStatuses` in `packages/agent-os`, pure). The rule is agent-os's
`dispatch-next`, in this order: `delivered` when a merged pull request carries the unit's line,
`claimed` when an open one does, `blocked` when the unit's line has a `blocked:` note, `ready`
when every dependency is delivered, and `waiting` otherwise (wow's own word, with what it waits
for as the reason). A unit of a stale plan, or of a plan whose spec is stale, is never ready: it
waits, and the reason names the file and both revisions. A closed pull request that was not
merged counts for nothing. With `source: issues` the dependencies are in the tracker, so a unit
without a pull request and without a `blocked:` note stays `unknown` and says why.

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

**The assistant thread** (`assistant/thread.ts`). It is a row of `threads` with `kind`
`assistant` (migration `0018_thread_kind`; every other thread is `chat`) and the fixed id
`assistant`, so there is one per install and it is found again after a restart. Its turns,
items and provider session are stored like any thread's. The `threads` topic leaves it out, so
no list of the chat view has it; the `assistantThread` topic has that one row, or none before
it was first opened.

- `assistant.open` (RPC) asks for it and answers `{thread, problem}`. It sends the command
  `thread.openAssistant`, which makes the thread or brings it in line with the settings. When
  nothing names a model or an effort, the handler first asks the provider for its models and
  passes the first one as a fallback, because a decision cannot ask a provider.
- Who runs it is decided by `chooseAssistantProvider` in `packages/contracts`: the instance
  `assistant.providerInstanceId` names; left empty, the instance the thread already runs on
  while it is connected, otherwise the first connected one in the order they were made.
  A Codex instance counts only while `assistant.allowCodex` is on (default off): wow switches
  off the Codex tools that have a switch, but nobody has yet seen the tool list a real,
  signed-in Codex then offers, and the tools without a switch stay (see below). While it is
  off, a Codex instance named in `assistant.providerInstanceId` is refused, the first connected Claude Code instance is taken
  even if a Codex one was connected earlier, and when only Codex could run it the answer is the
  sentence `assistantCodexOff`, which says why and names both ways out.
  "Connected" means the instance's last test passed (`status: ready`). The model is
  `assistant.model`, then the instance's default model, then what the thread already uses on
  that instance; the effort likewise with `assistant.effort`. The permission mode is
  `providerChatOptions[kind].assistantPermissionMode` (`dontAsk` on Claude, `read-only` on
  Codex) and cannot be changed: `thread.configure` is refused for this thread.
- When no instance can run it (none connected, the chosen one removed, its test failed),
  `assistant.open` answers the sentence in `problem` with the thread as it was, and
  `thread.sendMessage` is rejected with the same sentence, so no turn starts (spec 27). The
  check runs again with every message: a message sent after the settings changed already goes
  to the instance named now. Moving to another instance is the event `thread.providerChanged`;
  the provider's session id is kept only when the new instance is of the same kind on the same
  config folder. The event names the instance it left (`previousProviderInstanceId`), and the
  provider service sends that instance's adapter `closeThread`, so the adapter drops its live
  session for the thread; coming back later starts a new session from what the thread row
  says, instead of going on with the old one and its old options. The assistant thread does not keep an instance from being deleted.
- The turn. `turn.started` carries `start.kind: 'assistant'` and nothing else about the
  tools. After commit the provider service (`#assistantTurn`) builds the `startTurn` command
  with `toolset {name: 'wow', url, token}` (the endpoint above), `instructions` from the
  setting `assistant.instructions`, and `cwd` set to `<wow home>/assistant` whatever the row
  says. A changed instruction text reaches Claude Code with the next message: the adapter
  closes the live session and opens a new one that resumes the same conversation with the new
  text. On Codex it applies from the next start of the assistant's codex thread (after wow or
  the instance restarts, or the thread moves), because the app-server takes the text only when
  a thread starts or resumes. The token is read from memory at that moment; it is in no event, row or log line. The
  folder's name is not a setting, so it cannot be pointed at a project. It is made before the
  turn and must be empty: if it holds anything the turn fails with a sentence that names what
  was found, since a provider would read an instruction file left there.
- What "these tools and no others" means is each adapter's business (see below). An ordinary
  thread and a workflow step carry no toolset and their options are unchanged.

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
  without asking the user. Because nobody has seen the resulting tool list, the assistant runs
  on Codex only when the user turns `assistant.allowCodex` on. An ordinary thread gets none of
  this. The compat check reads `config` as one map of JSON values, so the keys inside it are
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
  `read_providers`, `read_workflows`, `read_templates`, `read_skills`, `read_skill`,
  `read_calendar`, `read_backlog`, `read_runs`, `read_triggers`, `read_notifications`,
  `read_connections` and `test_connection` (the same sign-in test as `trackers.test`).
  `read_skills` lists every skill in list order with its description and `group` (wow skills
  spec 21), and `skillSource` for a wow skill, which is what a step's `skillSource` and an
  `alsoFollow` entry's `source` take. `read_skill {name, group?}` answers the text of an own or
  a built-in skill (a built-in one as its template, unfilled) and whether it can be changed; a
  folder skill's text is not read. Each reader builds its answer
  field by field. None returns a thread's items, a step's final message, a file's content, a
  card's notes or more of a meeting than its time and title. A secret setting and a secret
  environment variable say `set` or `not set`, decided from the names in the secret store; no
  reader ever asks the store for a value. A plain environment variable says `not shown`.
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
  project's GitHub guide follows the poller's host rule for a project's own token
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
  (sign-in requests only, nothing is written); failed host, ticket and page reads with the
  setting they name (a read of a run only while the run is live, since an ended run is not read
  again); workflow steps whose skill is not installed; event triggers whose event was recorded
  without a run (`trigger_events`) and whose "Trigger failed" notification
  (`<trigger>:<event>:failed`, matched by that exact id) has no run of the trigger after it;
  failed runs (until a later run of the same workflow and project ends `done`, and only while
  the workflow and project exist) and failed plan runs (until a later plan run of the same plan
  ends `done`, and only while the project exists) with their stored error; and cards
  with a workflow that are `missed`, or `failed` without a run, with the notification's reason
  (until a run of the card's workflow and project that started after the card's start ends
  `done`). Each part is one query that asks SQLite only for the rows that still count (by
  state, error and the later runs above), with runs, plan runs, triggers and cards limited to
  `assistant.diagnosisLimit` each in the query, newest first. Times are told in
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
  and update), cards, backlog items, workflows without the parts below, following a plan,
  turning an event trigger off or deleting it.
- `proposal`: nothing is applied; the command is stored and waits for the user. Starting a
  run (`workflowRun.start`, `card.runNow`, `planRun.start`), `trigger.create`, turning a
  trigger on, a workflow whose steps gain or change a permission mode, a gate condition or
  rules, lose a gate, or that turns "for units" or "own working copy" on or off, and a setting
  that then lets the app do more: `scheduler.paused` off, `scheduler.missedPolicy` to `run`,
  `hosts.polling`, `triggers.eventsEnabled` or `viewer.htmlScripts` on. A change to
  `assistant.secretPatterns` is a proposal too, since that is the assistant's own net, and so
  is any change to `assistant.allowCodex` or `triggers.forkPullRequests`, either way. Four
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
  occurrence) is in the past or within `assistant.startSoonMinutes` of now, because the scheduler would start its run almost at
  once, which is "start a run now" by another name. A card further ahead is scheduling and stays
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
- `refused`: never applied, with a sentence for the assistant. The answers at a gate
  (`workflowRun.continue`, `sendBack`, `stop`; the sentence carries the run's path),
  `planRun.stop`, a card delete that would stop a run, every thread, approval and question
  command, provider instances, `project.delete` (it cannot be undone), secret settings, the
  two restore commands, the assistant's own answer commands and every internal command.

An entry is a word, a refusal, or a function of the command and the projections where the
class depends on what the command says. No tool exists for a type that is always refused, and
`AssistantTools` refuses to start with one.

**Deciding as the assistant** (`core/assistant.ts`, `decideInSteps`). For the origin
`assistant` the class comes first. A refused command is rejected with its sentence. An
ordinary command is decided by the same `decide` the user's command goes through; its events
are stored, then the thing it changed is read again and an `assistant.changed` event is added
in the same transaction. A proposal is decided once and the result thrown away, so that a
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

**The view** (`apps/web/src/assistant`, section "Assistant" above Settings, `/assistant`,
`keybindings.goAssistant`, Mod+6). It calls `assistant.open` when it opens and again when an
instance's status or `assistant.providerInstanceId` or `assistant.allowCodex` changes, and
shows the `problem` sentence in a banner with links to Settings → Providers and Settings →
Assistant (the composer is blocked with the same sentence); with no thread yet it shows only
the sentence. The conversation is the chat view's `ThreadConversation` with
`ConversationExtras` (`chat/thread-view.tsx`): rows after an item, rows at the end, the
composer's ref, placeholder, blocked reason, a check before send, a notice line and its own
composer bar (`modelBar`; `null` for none, left out for the thread's own bar). Nothing of
the chat view is copied. The skill list and chips are off there (no `providerKind`). With `chat.groupToolCalls` on (the
default), `groupToolCalls` (`chat/view-model.ts`) draws consecutive tool calls of one turn as one
row (`ToolCallGroup`, `chat/tools/group.tsx`): while open to more calls, the latest call, the
count and how many failed; closed, a summary of what was done (see "Tool rows, the task pin and
copy"); any other item, a new turn, or a call that has rows after it (change rows, proposals,
cards) ends the run. Its open state is the window's own.

- Rows (`assistant/model.ts`, `placeRows`). A change row or proposal card goes right after the
  tool call whose answer names its id (`change.id`, `proposal.id` in the call's output); one
  whose call cannot be found goes at the end, in the order made. `assistantToolOf` in
  `packages/contracts` reads wow's tool name from the name a provider reports
  (`mcp__wow__<tool>` from Claude Code, `wow/<tool>` from Codex), so the view never looks at a
  provider's naming itself.
- Change row (`ChangeRow`): "what: from → to · place" with Undo (`assistant.undo`); greyed with
  "Undone" when the topic says so; a refused Undo shows the server's reason under it.
- Proposal card (`ProposalCard`): the title, one line per change (a value past
  `assistant.valueLength` (160) characters is cut there, and the line carries the whole of it in `fromFull`/`toFull`, shown under "Was:
  show all of it" / "Becomes: show all of it"; the secret net runs on the whole value before it
  is cut), the place, Yes
  (`assistant.proposal.accept`) and No, which opens an optional reason field and sends
  `assistant.proposal.decline`. A reason that looks like a secret is not sent and the card
  says why. A refused Yes (stale, or the app refuses it now) shows the reason and still offers
  No.
- Secret field card (`SecretFieldCard`), drawn after a `show_secret_field` call the server
  answered (`status` ok and `outcome` `shown`; a refused or running call draws nothing, and the
  project work card likewise needs `offered`): the setting's
  label, where the value goes, the settings page's own `SecretField` (password field and Save,
  through `storeSecretSetting`: `secrets.set` and then `setting.set` with the reference) and,
  for a tracker token, `TestConnection`. Above the field it shows the token guide's steps
  (`TokenGuideSteps`) from the tool's stored answer (`askOf` reads `guide`), with links out to
  the host and, while the address is missing, a link to where it is filled in. It says "Set" from the `settings` topic once a
  reference is stored at that scope.
- Secret variable card (`SecretVariableCard`), after a `show_secret_variable` call the server
  answered: "<VARIABLE> (<instance>)", where the value goes, a password field and Save
  (`storeSecretVariable`: `secrets.set` as `provider:<id>:env:<name>` (`providerSecretName`),
  then `providerInstance.update` with the instance's env and the reference, then
  `provider.test`, as the instance editor does), "Set" once the instance holds a reference for
  it, and the instance's last test. A held message whose field is unknown goes to the field or
  variable the assistant asked for last.
- Project work card (`ProjectWorkCard`), after `offer_project_work`: "Open in Chat" puts the
  text in the draft store (`DraftState.text`) and opens `/chat/new`, whose composer takes it.
- Held message. Before a message is sent or queued, `holdMessage` runs `findSecret` from
  `packages/contracts` with `assistant.secretPatterns`, the same patterns the server hides.
  A match keeps the text in the composer and shows a line above it: what it looks like ("a
  GitHub token"), "Put it in <field>" and "Send anyway". The field is the one the token's kind
  names (a GitHub, GitLab or Atlassian prefix), taking the project of a field the assistant
  asked for, or else the field the assistant asked for last; without one only "Send anyway"
  is offered. "Put it in" stores the matched text through `storeSecretSetting` and leaves the
  rest of the message, as the box holds it now, in the composer; when the field already holds a
  reference at that scope the line says it will be replaced, and the note after says it was. A
  held message is sent nowhere until "Send anyway", which calls the composer's
  `sendUnchecked()`: the box's current text goes through the composer's own send path (queued by
  the server while a turn runs, as the answer to a waiting question), skipping only the check.
- Palette (`assistant/commands.ts`): Yes and No for every waiting proposal (Yes under "Needs
  you"), Undo for every applied change (the newest before typing). A refusal from the palette
  is a toast with the reason. The sidebar counts waiting proposals as "need you".

**First start** (app assistant spec 24 to 27; `apps/web/src/app/first-start.tsx`,
`apps/web/src/providers/connect-step.tsx`). The spec decided to reuse the provider onboarding and
to gate the app only while no provider is connected, so the gate is a client view over state the
server already has: the `providerInstances` topic and the global setting `providers.offerSetup`
(`personal: machine`, so a setup file never carries it). `useFirstStart` puts the gate up while
the setting is on and there is no provider instance at all. An install with any instance,
whatever its status, is never gated, so an existing install whose instance fails its test after
an upgrade is not locked out; the Assistant view's own connect step covers it. Once up the gate
stays up until an instance has `status: ready`, through the instances its Test buttons create
and that fail. The Shell then draws only `ConnectAgentStep` (no
sidebar, no route), and the palette offers only `connect.claude`, `connect.codex`, `setup.start`,
the palette itself and the theme. The step shows Claude Code and Codex side by side with the
binary `provider.detect` found, Test (which dispatches `providerInstance.create` from the detected
binary and folder when that kind has no instance, then `provider.test`) and the test's message,
and "Start from a setup file", which reads, previews and applies a file through the same
`readSetupFile`, `SetupPreviewDialog` and `setup.apply` as Settings → Advanced. When an instance
passes, the client writes `providers.offerSetup` false, so a provider removed later never brings
the gate back (spec 27), and goes to `/assistant`.

**The greeting** (spec 24, 26). The server owns it, so a reload or a restart between the
passing test and the greeting does not lose it. When the gate goes up the client sends
`thread.greetAssistant`. The server greets at once when the assistant thread exists, no turn
runs and a connected instance can run it; otherwise it stores `assistant.greetingOwed` (table
`assistant_greeting`, `ReadModel.greetingOwed`), and the next `thread.openAssistant` that can run
the thread starts the greeting turn in the same commit. Each greeting stores
`assistant.greetingSent`, which ends the debt, so it is sent once. The command is refused from
the assistant (classes.ts). Its turn shows `assistant.greeting`
as the user's line; the prompt gets wow's note before it (`firstStartNote` in
`assistant/thread.ts`, the same "[From wow, not typed by the user]" form as the answers note):
the providers that are ready, the projects, workflows and trackers (address and whether the token
is set, from stored global values only, so a default is not counted), what a first run still
needs (a project, a workflow), and, when a setup file is applied and not undone
(`ReadModel.lastSetupApplication`), "To fill in": each secret of its `toFillIn` still not set,
work hours while `calendar.workHours` is not stored, and project folders, which a file never
holds. The note goes through `hideSecrets`. What to do with it is in `assistant.instructions`: one
thing per answer, a secret through `show_secret_field`. Nothing on the server walks the list;
the agent does, and the facts are re-read on every greeting. A setup file applied later (from
Settings) is told at the assistant's next `thread.sendMessage` instead (`setupAppliedNote`):
when the newest applied file is newer than the start of the assistant's last turn, the note
names it with the same "To fill in" lines, after the answers note and before the user's text.

**When it cannot start.** With no thread or a `problem` from `assistant.open`, the Assistant view
shows the problem and the same `ConnectAgentStep` in place of the conversation (spec 27); the
rest of the app is not gated. Its `onConnected` is not used: `assistant.open` is asked again when
an instance's status changes, and the conversation comes back.

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
Confluence email, the GitHub owner and `triggers.ignoredCommentAuthors`, `machine` for folders and ids that fit one computer (`skills.directories`,
`workspaces.root`, `assistant.providerInstanceId`, `advanced.port`, `desktop.autostart`,
`appearance.paletteRecent`, `providers.offerSetup`), `person` for what only that person can say (`calendar.zone`,
`calendar.firstDayOfWeek`, `calendar.workHours`). Projects, cards, backlog items, threads and runs
are not read at all, so no project folder is in it. Own skills are written by name with their
text; built-in skills come with the app and folder skills stay in their folders. A value,
workflow or own skill that the secret net (`assistant.secretPatterns`) matches is left out and
named in `leftOut`; so is a workflow whose
step names an instance that no longer exists. A step applied from a file where no instance of its
kind was here holds the kind as its instance id (`awaitedProviderKind`) and is written back with
that kind; a run of its workflow is refused with "Step <skill> has no <kind> instance here yet:
choose one for it in the workflow <name>."

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

The draft's defaults come from server rows, not browser storage (owner decision F-5): the newest
thread that no run started gives the instance, and on that instance its model, effort and
permission mode, and its project or folder; then the instance defaults. Folders used without a
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
`thread.create`, the Assistant view writes `assistant.providerInstanceId`, `assistant.model` and
`assistant.effort` through the settings store (`assistantBar` in `assistant/assistant-view.tsx`;
a new instance empties the other two first and is written last, and a refused write shows in the
view's notice line) and asks `assistant.open` again so the thread follows;
its mode shows `modeLocked` ("Read only") and has no list. `threadDefaults` starts a new thread
on the provider's default model and that model's default effort when neither the last thread nor
the instance names one. Keys while the composer has the focus (`useModelBarKeys`, `barKeyOf`):
`keybindings.composerModel` (Mod+Shift+M) and `keybindings.composerEffort` (Mod+Shift+E) open the
lists, `keybindings.composerModeCycle` (Shift+Tab) moves to `nextPermissionMode` (from the mode it last
sent while the thread has not shown it yet, so a quick second press goes one further), and
`keybindings.composerLeave` (Escape, after the skill list's own Escape) focuses what comes before
the composer, since Shift+Tab no longer leaves it. They are matched in the composer's key handler,
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
- **Sending.** `dispatch` asks `ImageStore.refusal` before deciding a `thread.sendMessage` with
  attachments: every image must be stored for that thread, so a message never starts a turn with a
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
(`CodeBlock copy`); tool output has Copy output. `copyText` does the write; when the browser has
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
background: …"), so the refusal is not only in the log.

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

### Edit and Fork

Agent workbench spec 62, 63, 71, 74, U12. Both go back in the provider's conversation and never
rewind files.

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
  before Claude Code wrote anything goes back again.
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
  The header says "Forked from <title>".
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
  `updatedAt`; a step thread waiting for its run's gate counts as the gate), runs `waiting` at a
  gate for the user (at the reviewed step's `endedAt`; a gate waiting for checks, `runNeedsYou`,
  is left out, and its gate bar does not take the focus) and pending assistant proposals, oldest
  first.
  Ctrl+Shift+J (`keybindings.nextNeedsYou`, palette "Next that needs you") navigates to the next
  after the one it went to last and sets a focus request; the approval card, question card, gate
  bar's Approve and the proposal card call `useNeedsYouFocus(key, ref)` and take the focus once
  they render, and `takeLanded` keeps the composer's autofocus from taking it back.

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
folder (the path stays absolute), nor on a running edit row or a pending approval card, whose
file has not changed yet, nor in the Assistant view, which opens no files. An `edit` row without
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
`pnpm dlx`, `npm exec`, `yarn dlx`, `uv run`, …), an interpreter followed by an option
(`node -e`, `python -c`, `python -m`; `node scripts/build.mjs` keeps its rule) or a `find`/`fd`
that runs a program for what it finds (`-exec`, `-execdir`, `-ok`, `-x`), a thread without a
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
(`runId` null, kind `chat`) it reads the folder through git with the run's code
(`RunChanges`): the first turn records the base (`readRunBase`: the commit and what already
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

## Workflow builder and run view

`apps/web/src/workflows`. The list's header is a tablist "Workflows view" with Workflows and
Triggers. `/workflows/triggers` is the Triggers tab (`triggers-tab.tsx`, review loop spec 48):
the event triggers of every project, grouped by project, each with its switch, the workflow it
starts, a link to the last run it started and Delete (at once, with Undo, which makes the
trigger again); "New trigger" is a dialog that asks for project, event and workflow, and a
line says so while `triggers.eventsEnabled` is off or the scheduler is paused. `triggers.ts`
holds the dialog's draft and the server's refusals (`triggersStore`), so the buttons and the
palette commands (`workflows.triggers`, `trigger.new`, `trigger.toggle.<id>`,
`trigger.delete.<id>`) act on the same thing; the rows come from the `triggers` topic alone. A
run that an event started says so under its title (`run-event`).

`/workflows` lists the workflows and their runs (live runs first) next
to `/workflows/new` (`?template=<kind>` starts from that entry of `workflows.templates`),
`/workflows/$workflowId` (the builder for a saved workflow, Run now in a chosen project next to
Save, and its runs) or `/workflows/runs/$runId`. The builder edits a local draft: name, template
kind, and ordered steps reordered by dragging a step's handle or with its move buttons. Steps are
one line each and open to edit. Gates are drawn at the positions between steps (`waitsAt`,
`setGate`: on stores a gate after the step before, or a gate before the first step; off clears
both), so the engine's `gateBefore` and `gateAfter` stay as they are. A step picks a skill
from the `skills` topic (stored as its name, or `plugin:name` for a Claude plugin's skill), a
provider instance, and model, effort and permission mode with the chat's pickers; empty ones are
filled with the instance defaults, else the first listed model (not for a provider that needs a
model; see "Models for steps"). Expected artifact globs are typed
one per line. Validation needs a name, a step, and per step a skill, an instance, a model, an
effort and a permission mode; a skill missing from the scan is only a warning, because the server
invokes unknown skills by name. The skill pickers (`step-skills.ts`, `skillChoices`) list every
skill once in list order with its group as the muted detail; a wow skill's value carries its
source (`yours/<name>`, `wow/<name>`) so an own skill and a folder skill of the same name are
two choices, and picking one sets `skillName` and `skillSource` (wow skills spec 9). "Also
follow" (spec 11) under the skill holds the step's `alsoFollow` as chips in their order, each
with its group and a button to stop following it, and a picker that adds any other skill from
every group. "Attached automatically" (spec 12, `attachedSkills`) lists the built-in skills
`automaticSkills` gives the step, as long as `workflows.attachBuiltInSkills` is on (its global
value: the builder has no project), the built-in skill is in the list (not switched off) and the
step does not already name it. Each says why ("Because a rule of this step reads the
verdict."); `wow-pull-request` shows for a workflow marked "for units", since a unit is only
known when a run starts. "Leave out" adds the name to `leaveOut` and the row then says it is
left out, with "Attach again". The rules store's `builder` also carries `changeStep`,
`forUnits` and `attachBuiltIn`, so the palette acts on the step being edited: "Also follow
<skill> in step N" (search only), "Stop following <skill> in step N", and "Leave <name> out of
step N" or "Attach <name> to step N again". `applyStepChanges` takes a field set to undefined
away, so a step that follows nothing more is saved without `alsoFollow`. "Start from" (Blank or a template) is offered for a new workflow;
an existing one shows "Based on <template>" and replaces its steps only through "Replace steps
with template…", which still needs Save. "Save as template…" writes the draft's skills, gates and artifact globs into
`workflows.templates` (`saveAsTemplate`: replaced by name, else a new kind from the name), with
the rules whose step can be named by its skill (see "Templates" under "Rules"); the
settings page's editor stays for everything else. Refresh skills calls `skills.refresh`. Run now is offered
only for the saved steps. With a project to run in, each step's expected globs are checked with
`workflows.matchArtifacts {projectId, globs}` (read only, the same `fast-glob` match the run uses)
for a "Matches N files" line. Delete dispatches `workflow.delete` at once and offers Undo, which
sends `workflow.restore {workflow}` with the row the client held (refused if the id exists again). The run view asks
`workflowRuns.detectArtifacts` when it opens and renders the run row: each step's state, its
thread link, how long it took, the expected globs and the found files, each a button that opens
the file in the context panel's viewer (`artifact-link.tsx`, see "Context panel") with a
copy-path button; nothing links to `file://`. A step that ended and waits at its gate reads Done with a
"Waiting for you" marker after it. The header links to the run's card and backlog item. The gate
bar (`gate-bar.tsx`, also in the step's thread) reads the gate the way `pendingGate` does (the
current step has ended: after it; not started: before it), shows the reviewed step's
`finalMessage` and found artifacts, and offers Approve (`keybindings.gateApprove`, which sends
`workflowRun.continue`), Send back (`keybindings.gateSendBack`) and Stop; Stop alone while a step
runs. Stop asks first, since a stopped run cannot go on. Palette commands: New workflow, New workflow from each template, Refresh skills, every
workflow and run, and Run: approve, Run: send back and Stop run for the open run.

**Own working copy** (`working-copy.ts`, `working-copy-line.tsx`; review loop spec 36 to 39).
The builder has an "Own working copy" switch beside the name; it is part of the draft and is
stored with Save as `Workflow.ownWorkingCopy`. The palette switches it on the stored workflow
("<workflow>: run in an own working copy" / "…: run in the project folder") and an open builder
follows. A run that has a working copy shows a "Working copy" group in the run view's header,
rendered from `WorkflowRun.workingCopy` alone: "Making the working copy…", "Works in its own
working copy" with the folder (copy button) and the note when it did not start at the fetched
tip, "No working copy was made" (the reason is on the failed step), "Working copy removed", or
"Working copy kept: 2 files not committed, 1 commit not pushed (on agent/u2-bell)" with the
newest unpushed commit's subject and the reason when it could not be removed. Kept copies are
listed in three places: that line, "· working copy kept" on the run's row in the runs list, and
a palette command "Remove working copy: <workflow>" for every kept copy. The command and the
line's button open the same question (`workingCopyStore`, a `ConfirmDialog` in the run view,
which the command navigates to); Remove calls `workflowRuns.removeWorkingCopy` and a refusal
stays on the line. A live run's copy has no button. Artifact links, the Changes tab's "Open
file" and the viewer's paths use `runFolder`, so they name files in the working copy.

**For units.** The builder has a "For units" switch beside "Own working copy", stored with
Save as `Workflow.forUnits`; the palette switches it on the stored workflow ("<workflow>: use
for plan units" / "…: no longer for plan units"). Only such a workflow is offered for a plan
run (see "Plan runs").

**Gate conditions** (review loop spec 54 to 58). Under a gate that is stored as a step's
`gateAfter` the builder shows "Pass by itself when" with three checkboxes (`GateConditionEditor`
in `builder.tsx`; `toggleGatePart`, `conditionOffered`, `gatePartChoices` in `model.ts`). They
are part of the draft and stored with Save as the step's `gateAfterCondition`; turning the gate
off takes the condition with it, and `stepsOf` saves a condition only where one is offered. For
a skill that always stops (`workflows.alwaysStopSkills`, read as set for all projects) there
are no checkboxes, only the sentence that this gate always waits for you. The palette switches
each part on the stored workflow (`workflow.gateCondition.<workflowId>.<stepId>.<part>`, found
by search). At a gate that did not pass, the gate bar says "Did not pass by itself: <parts>" or
"Waiting for checks" and lists every part with what it found (`gateStanding`); while a run
waits for checks its run view says "Waiting for checks" instead of "Waiting for you"; while a
running run's current step thread is `needs_you` (a question or an approval) the run view, the
Workflows list of runs, the builder's "Runs of this workflow" and the run and workflow panels say
"Waiting for an answer" (`runStateLabel(run, threads)`; the run stays `running`,
questions-and-models spec 7). Other lists keep the run state's own words. A step
whose gate passed by itself shows "Passed by itself: <parts>" with each part's sentence in its
row (`passedByItself`).

**Rules on a step** (`rules.ts`, `step-rules.tsx`; workflow branches spec 14, 16, 17). An open
step ends with "After this step": its rules in the order they are tried, each a row of three
selects, "When <fact> <value>, go to <step or End>", with move up, move down and remove
buttons, then the fixed line "Otherwise: the next step" (on the last step it adds that the run
ends) and "Add rule". The facts are the verdict, the checks, the expected artifacts and "the
step failed" (which has no value select); artifacts are offered only for a step that names
expected artifacts. A new rule starts on the first condition the step has no rule for yet and
goes back to the step before. Rules are part of the draft and stored with Save as the step's
`rules`; `stepsOf` leaves `rules` out for a step that has none, so a workflow without rules is
saved exactly as before. A closed step says "2 rules" on its line. The builder marks a rule
with what `ruleProblems` says about the draft, which is the reason the server refuses with: a
deleted step stays as the rule's target, shown as "A step that no longer exists", until the
user picks another. These marks do not stop Save; the server refuses the workflow and its
sentence shows above the steps. The buttons, the keys and the palette all go through
`rulesStore` (the open builder's steps and how to change them, the step being edited and the
rule that has, or last had, the keyboard), so they act on the same draft: "Rule: add to step
N" (`keybindings.ruleAdd`; for the step being edited, and for every other step by search),
"Rule: move up" and "Rule: move down" (`keybindings.ruleMoveUp`, `keybindings.ruleMoveDown`)
and "Rule: remove". A rule row takes its two move keys itself before its selects see them,
because a select would open its list on an arrow key; a moved or added rule keeps the keyboard.

**Paths diagram** (`paths-diagram.ts`; workflow branches spec 15). Beside the steps (below them
in a narrow window) the builder draws the paths a run can take with `MermaidDiagram`, from the
draft, so it follows every edit. It is read only. `pathsDiagram(steps)` is pure: Start, one box
per step in list order ("2. check-work"), End; a solid arrow from each step to the next (marked
"otherwise" where the step has rules); a dotted arrow per rule with its condition
(`ruleConditionText`); and "gate" on every arrow that passes a gate, which is the gate after
the step it leaves (a failed step passes none) or the gate before the step it reaches. A rule
whose step is gone has no arrow. The source holds generated ids (`s1`, `s2`, …) and labels
only. The diagram language cannot carry a double quote in a label and reads other punctuation
as markup, entities or line breaks, so `diagramLabel` keeps letters, digits, spaces and the
`-`, `_` and `.` inside words, and writes every other ASCII character as a stand-in from the
private use range (U+E000 plus its code). `MermaidDiagram` takes `shown`, a function applied
to each piece of drawn text after `scrubSvg` cleaned the drawing; the builder passes
`diagramText`, which turns the stand-ins back. The result is set as text, so a step called
`say "hi" <b>` shows exactly that and can never become syntax, markup, a style or a link.
While a changed source is drawn, `MermaidDiagram` keeps the drawing before it (`aria-busy`)
instead of going back to code.

**Review at a gate** (`gate.ts`, `gate-bar.tsx`, `review-tabs.tsx`; review loop spec 14 to 18).
The run view's tabs are Steps, Changes, Artifacts, Pull request, Ticket and Pages (`runTabs`;
`?tab=artifacts|pullRequest|ticket|pages` beside `changes`). Artifacts lists the found files of
every step, each opening in the panel's viewer; Artifacts says "Nothing to show yet" for a run
without found files. Pages (`pages-tab.tsx`, review loop spec 35) shows the run's `pageReads`
row under the same "Last fetched" line, error and "Refresh now": each linked page with its
title (a button that opens it in the panel's page viewer), space, where it was linked from, its
own "Last fetched" time and error, and "Open on host". Without pages it says why: not asked yet,
nothing links to a page (and nothing was read), or Confluence could not be read. Ticket (`ticket-tab.tsx`, review loop
spec 33) shows the run's `ticketReads` row: key and summary linked to Jira, type, status,
assignee, where the key was found, and the description through the shared `Markdown` renderer,
under the same "Last fetched" line, error, "Refresh now" and "Open on host" as Pull request
(`HostReadLine` takes either read). Without a ticket it says why: not asked yet, no ticket found,
or Jira could not be read. Palette: "Run: refresh pull request and ticket now"
(`hosts.refresh {runId}` reads both) and "Run: open ticket <key> on the host" when the link is a
web address. Pull request
(`pull-request-tab.tsx`, review loop spec 28) shows the run's `hostReads` row and the pull
request it names: number and title linked to the host, state, checks, head branch and commit,
the failing checks by name and the review comments (author, file, the text as plain text), each
with its own link, above them "Last fetched <time> from <host>", the host's error when the last
read failed, "Refresh now" (`hosts.refresh {runId}`) and "Open on host". Without a pull request
it says why: not asked yet, the folder is on no branch, or no pull request has that branch as its
head. See "Hosts". While the run on
screen waits at a gate, a wide window shows the context panel with the step's conversation and
the gate bar without changing `appearance.contextPanel` (the layout store's `contextPanelPeek`,
see "Context panel"); it stays for that run until the user closes it or leaves the view. The run
view's own gate bar shows only while the panel does not show the conversation (closed, or showing
a file), so there is one gate bar on screen. Send back opens a note field in the gate bar. The
note being written is view state in `gateStore` (`{runId, gate, note, busy, error}`), so the
button, the palette and the key act on the same field; nothing about the run is kept there.
`gate` names the wait it was written at (where the run waits, its path length, and the attempt
and end of the reviewed step), so a note left unsent is not offered at the run's next gate. Confirming
(the field's "Send it back", or the Send back key again) dispatches `workflowRun.sendBack`; an
empty note is refused in place with the server's sentence and sends nothing, a server refusal
shows its reason and keeps the note, Escape or Cancel puts the field away. While a note is open
the Approve command is not offered, so its key cannot approve by accident. Send back is not
offered before the first step. A step that was sent back shows "Attempt N" in its row, in the
Artifacts tab and in the panel's step header. Palette commands: Run: show artifacts / pull
request / ticket / pages / steps, Run: send back (Run: send back with this note and Run: cancel
send back while the field is open), Run: refresh pull request now and Run: open pull request #<n> on the host.

**Changes tab** (`changes.ts`, `changes-tab.tsx`; review loop spec 11 to 13). The run view has two
tabs under its header, Steps and Changes; the address carries the choice
(`/workflows/runs/<id>?tab=changes&file=<path>&stepOnly=true`, read by `validateRunSearch`), so
links and palette commands open the same state. The tab asks `workflowRuns.diff {runId}` when it
opens, again whenever the run row moves on (a step ended, a gate was passed) and on Refresh, and
asks `{runId, path}` for the chosen file's diff; nothing is cached beyond what is on screen. The
list is on the left (status letter, path, `+added −removed`, or "Binary file" / "Too large to
show" with the size), the chosen file's unified diff on the right with line numbers of both
sides (`parsePatch`), not highlighted and not side by side. The step under review
(`stepUnderReview`) is the one the gate asks about, else the last step that stored its hashes;
its files carry a "This step" badge and "This step only" narrows the list to them. The switch is
off for a run whose steps stored no hashes. "Open file" shows the file in the context panel's
viewer through `openFile`; a deleted file has none. A status other than `ok` shows its reason in
place of the list ("Not a Git repository", "Git was not found", "No base recorded", ...) and the
Steps tab and gate bar work as before. `changesStore` holds the files the tab last read so the
palette can offer them. Palette commands: Run: show changes / Run: show steps
(`keybindings.runChanges`), Changes: this step only / every step (`keybindings.changesStepOnly`),
Refresh changes, Changed file: <path> for each listed file, and Open changed file: <path> for
the chosen one.

After a loop (workflow branches spec 19) a step keeps the hashes of its latest attempt only, so
the server compares steps in the order they last ended (`run.path`), not in list order, and
each attempt also keeps `fileHashesBefore`: the hashes the step that ended before it left (the
base's for the first), stored by the engine as the attempt ends. A step is compared with those,
so every step, not only the one that ended last, is marked with what its latest attempt changed;
a step stored without them is compared with the step that ended before it. `stepUnderReview`
follows the same order when no gate asks (the step whose visit ended last, not the last step of
the list), and "This step only" names the attempt ("deliver-work, attempt 2, 1"). A run without
a path goes by the list as before.

**Path tab and loops in the run view** (`path.ts`, `path-tab.tsx`; workflow branches spec 9, 18,
19). Path is the tab after Steps (`?tab=path`): one row per entry of `run.path` in the order it
happened, with the step, "attempt N", how the visit ended (Running, Done, Failed, Stopped), the
engine's `reason` for the next move, the start time, the duration and a link to the step's one
thread. `pathRows(run, workflow)` is pure and decides nothing. It adds three things to the
reason: what was found when the list decided for a step with rules ("verdict approved: no rule
held → next step", from the step's `facts`, which exist for its latest attempt only); "waiting
for you" or "waiting for checks" for a last visit that ended while the run waits at its gate;
and "limit reached, waiting for you" (later "waited for you") with the limit sentence when the
visit has `limit`. A run from before paths says "No path kept".

The web's `gateOf(run)` reads the gate as the engine's `pendingGate` does: with a path, the run
waits after its current step only when that step's visit is the last one and nothing was
decided after it; otherwise it waits before the step, even though the step has an end time from
an earlier pass. `reviewedStepIndex(run)` for a gate before a step is the step the run came from
(the last visit's `next`), else the step before in the list; the panel's `activeStep` uses it
too. A step the run waits before reads Waiting, with the "Waiting for you" marker above it.
When the step's gate is `waitingAtLimit`, `Gate.limit` holds the sentence: the gate bar says
"deliver-work has run 3 times: the limit. Run once more starts it again; Stop ends the run.",
its Approve button reads "Run once more" (still `workflowRun.continue` and
`keybindings.gateApprove`; the palette says "Run: run once more"), Send back is not offered,
and the step row repeats the sentence. After a step with rules the gate bar does not name the
next step ("Approve lets its rules choose the next step"). Palette commands: Run: show path /
Run: show steps (`keybindings.runPath`, Mod+Shift+Y, the same key both ways).

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

Repeating cards (recurring cards spec 11 to 17, `occurrences.ts`). The view reads
`calendar.occurrences` for the days it shows (`viewRange`: local midnight of the first day to
local midnight after the last, in the calendar's zone) through `useCalendarRange`, and reads
again whenever the `calendarItems`, `triggers` or `workflowRuns` rows change; an answer for
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
  conversation, `GateBar` and composer, `compact` and without taking the focus), so Approve, Send
  back, Stop,
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
- File viewer (`file-viewer.tsx`, `viewer.ts`; review loop spec 6 to 9): a file opens in a tab
  of the panel (see "Panel tabs" below), not a second panel. `openFile` stores
  `{scope, path, fullPath, from, fullSize, read}` (`ViewerFile`; callers that open a run's
  artifact may pass `runId` for the scope) as a file tab of the route it was opened on and opens
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
  outside or Tab brings the app's shortcuts back. Palette commands (`viewerCommands`): "Open
  artifact: <path>" for every found file of the open run, and Back to conversation, Copy file
  path while a file shows, and the picture's size switch once it is read as a picture.
- Page viewer (`page-viewer.tsx`; review loop spec 35): the same place for a linked Confluence
  page. `openPage` stores `{runId, ref, from}` as a page tab of the route it was opened on, and
  `shownPage` is it while that tab is selected. The
  body is the server's last read from `pageReads`; nothing is asked of the host here. The header
  has Back to conversation (also Escape), "Open on host", the title and space, version, where it
  was linked from and when it was fetched. The body is shown in an `iframe` with `sandbox=""`
  from `pageDocument(body)`, which wraps the fragment in a page with a light reading style and
  goes through `frameDocument`, so no script runs and nothing is fetched. Pictures and
  attachments need the user's Confluence session and therefore do not load; a line above the
  frame says so and points to "Open on host". Palette commands: "Open page: <title>" for every
  read page of the open run, and Back to conversation and "Open page on host: <title>" while a
  page shows.

Panel tabs (`tabs.tsx`, `viewer.ts`; agent workbench spec 11 to 14, 87). The layout store's
`panelTabs` keeps, per panel selection (`panelRoute` in `panel/model.ts`: a thread's
`/chat/<id>`, a run's `/workflows/runs/<id>`, a calendar card's `/calendar?item=<id>`, so each
card's step thread has its own), the open
tabs (`PanelTab`: a file or a page, its id from the scope and the file's full path, with forward
slashes, no `.` parts and in lower case for a Windows path, so `src/a.ts`, `./src/a.ts`,
`src\a.ts` and the full path are one tab, or from the run and ref), the
selected one (`DETAILS_TAB` for the panel's own body) and the tabs shown before (`history`). So a
thread keeps its tabs while another thread is open, and each is read again when shown. While a
route has tabs, `PanelTabStrip` shows the panel's own body first ("Details"; in a run view
"Conversation", the step's thread, so a file or page opened there sits beside it instead of
replacing it), then a tab per item with an icon by kind and its short name; opening an open item
selects its tab (`openTab`). Opening keeps the focus where it was and remembers it for that tab
(`tabOpener(route, id)`): Escape there, outside a text field, closes the tab again while it is the
one shown, as Escape does in the panel. A route whose last tab closes drops its `panelTabs` entry. Keys while
the focus is in the panel, matched in the panel's own key handler: `keybindings.panelCloseTab`
(Alt+W, since Ctrl+W closes a browser tab), `keybindings.panelNextTab` (Ctrl+Tab),
`keybindings.panelPreviousTab` (Ctrl+Shift+Tab) and `keybindings.panelBackTab` (Alt+ArrowLeft;
`backTab`, the tab shown before); the Keybindings page lists them "In the side panel". Closing
the selected tab shows the one shown before it. Palette commands while tabs are open: "Close panel
tab", "Next panel tab", "Previous panel tab", "Back to the panel tab shown before" (no key of
their own, so their keys stay the panel's). The run view's gate bar shows while the panel shows
the conversation tab.

State (`panel-state.ts`). `appearance.contextPanel` stores whether it is open and
`appearance.contextPanelWidth` its width (pixels, bounds `contextPanelWidthBounds` in
`@wow/contracts`). The left edge is a `separator`: dragging previews the width and writes the
setting once on release; the arrow keys (Shift for four steps), Home and End write it at once.
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
never a `#n` that reads as a colour (six digits, three of one digit, or three digits after `:` or
before `;`).
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
the same rule as the poller for a remote's host). `HostLookup` (`apps/server/src/hosts/lookup.ts`)
answers RPC `hosts.lookup {threadId, ref?, read?}` with `{rules, item, read}`: without `ref` the
rules; with it the item it names (null for a plain link) and the stored read; `read: 'open'`
reads the item only when the thread has no successful read of it (a stored failed first read,
without `fetchedAt`, is asked again), `read: 'refresh'` always. One read per
item at a time. Each read builds the adapter of the item's site with that site's token, so a
token never goes anywhere else, and goes through the internal command `hosts.itemRead`
(`decideHostItemRead` in `core/hosts.ts`) to the event `hosts.itemRead` and the
`host_item_reads` table (migration 0030), topic `hostItemReads` (thread-scoped). `HostItemRead`
has scope `thread` (`HostReadScope` gained it; the poller's rows use `PolledHostScope`), the
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
`planned`, so a refused card leaves the item as it was. Delete and plan are refused while a run of
the item is live; delete unlinks the item's cards. Every `workflowRun.changed` of a run with a
backlog item also emits `backlog.updated` when the item's state or `runId` differs from what the run
means: running or waiting is `running`, done is `done`, failed or stopped is `planned`. The item
keeps the `runId`, so the backlog shows the failed step's error from the run (behavior 29).

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
  tracker port. The same copy holds the file viewer's fixtures: invented files of every kind in the
  project's `review` folder (the picture is drawn by the script, the HTML page tries to reach
  the app, its storage and the tracker port, over HTTP and over WebRTC) and a workflow whose step finds them, started with
  `POST /run?workflowId=…&runId=…`; requests to `/leak…` on the tracker port and datagrams to the same port are recorded, so a
  page that got out fails the test. The trigger tests start a third copy themselves
  (`e2eTriggersHome`, `e2eTriggersPort`) because they restart it: `WOW_E2E_KEEP_HOME=1` keeps the
  home across a restart and `WOW_E2E_CLOCK_OFFSET_SECONDS` runs the server's clock ahead, so a
  trigger's time passes while the server is down without the test waiting. The server prints
  `wow e2e server ready` once it is seeded. The backlog tests publish to a mock Jira and GitHub on
  `e2eTrackerPort`, which the server's tracker settings point at (GitHub without its token, which
  the test enters on the settings page); the same port lists what the trackers received and starts
  a backlog item's card run the way the scheduler will (`POST /fire`). The plans tests read invented intent
  folders that `e2e/plans-seed.ts` writes to the seeded project's `plan-files` folder, which the
  project's `plans.intentsDirectory` points at so the workflow tests' `intents/*` artifacts stay
  as they are; one test rewrites a plan file and waits for the view to follow. The assistant
  tests (`e2e/assistant.spec.ts`) use a seventh copy (`e2eAssistantHome`, `e2eAssistantPort`),
  because the assistant changes global settings and has one conversation per install; its
  Claude instance is tested at start so the assistant can run, and its adapter is
  `AssistantMockAgent` (`e2e/assistant-agent.ts`), which hands ordinary threads to the chat
  script and answers a turn with wow's toolset by calling `server.assistant.tools` in process,
  reported as `mcp__wow__<tool>`, with the scenario picked by the user's words. The first-start
  tests (`e2e/first-start.spec.ts`) use an eighth copy (`e2eFirstStartHome`,
  `e2eFirstStartPort`) seeded with no provider instance, project, workflow or tracker, whose mock
  Codex fails its test with `e2eFirstStartCodexError` and whose mock Claude is the same
  `AssistantMockAgent`; on wow's first-start note it answers with the note's lists and then asks
  for each "To fill in" line in turn, one per user message. `e2e/app-assistant.spec.ts` (no
  browser) checks that every behavior the spec's ground truth names has a case tagged
  `@app-assistant-<n>`, that every sketch the spec names exists, and that the user guide and
  `docs/windows-smoke.md` have the assistant's parts. The Changes tab
  tests use a sixth copy (`e2eChangesHome`, `e2eChangesPort`), because opening a changed file
  opens the context panel, a global setting. The script creates an invented tea timer
  repository in its home with `git` (which the e2e machines therefore need on the PATH) and
  registers it as a second project; a two-step workflow's prompts make the mock agent commit one
  change and leave others uncommitted, then add review notes. `POST /run?…&projectId=…` puts the
  repository back to its first commit before each run. The host tests (`e2e/hosts.spec.ts`) use
  the same copy: a third repository, project `tea-garden`, is on a branch with an invented pull
  request and holds a plan; `MockGitHub` (`apps/server/src/hosts/mock-github.ts`, the host the
  server tests use too) answers under `/github` on the tracker port, only this project has a
  GitHub token, and its workflow waits before its only step, so a run is live without the mock
  agent. `PUT` and `DELETE /github-host/failure` make the host fail and answer again, and
  `GET /github-host/requests` lists what it was asked. The ticket tests (`e2e/tickets.spec.ts`)
  run that project's workflow for a backlog item the copy seeds as already published to Jira;
  `MockJira` (`apps/server/src/hosts/mock-jira.ts`) answers `GET /jira/rest/api/2/issue/<key>` on
  the tracker port with the seeded global Jira sign-in, `PUT` and `DELETE /jira-host/failure` make
  it refuse and answer again, `GET /jira-host/requests` lists what it was asked, and
  `POST /run?…&backlogItemId=…` starts a run for an item. The page tests (`e2e/pages.spec.ts`)
  run the same way for a second published item whose Jira description links to a page by id,
  in project `tea-garden`, whose seeded intent links to a page by space and title; `MockConfluence`
  (`apps/server/src/hosts/mock-confluence.ts`) answers under `/confluence` on the tracker port
  with the seeded global Confluence sign-in, `PUT` and `DELETE /confluence-host/failure` make it
  refuse and answer again, and `GET /confluence-host/requests` lists what it was asked. The
  working copy tests
  (`e2e/working-copy.spec.ts`) use the same copy too: a fourth repository, project `tea-cup`,
  and a workflow whose "Own working copy" switch the test turns on in the builder. The mock
  agent edits whatever folder its turn starts in when that is a tea repository or a folder
  under the home's `workspaces`, so the test sees the edits in the working copy and the project
  folder unchanged, then the kept copy and "Remove working copy". The plan run test
  (`e2e/plan-run.spec.ts`) uses the same copy as well: a fifth repository, project `tea-pot`,
  holds a plan with three units and no pull request, on a second `MockGitHub` repository
  (`acme/tea-pot`) under the same `/github` path, and its workflow is marked "For units". The
  mock agent answers that workflow's step by opening the unit's pull request on the mock host,
  `PUT /github-pot/merged?unit=…` merges one, and the test asks with "Refresh now". The event
  trigger test (`e2e/event-triggers.spec.ts`) uses a sixth repository, project `tea-leaf`, whose
  plan has one unit with an open pull request on a third `MockGitHub` repository
  (`acme/tea-leaf`) and whose repository has that pull request's branch; it makes triggers in
  the Triggers tab, merges with `PUT /github-leaf/merged` and asks with "Refresh now". The gate
  condition tests (`e2e/gate-condition.spec.ts`) use two workflows of that copy in the Demo
  project, without a repository: a check whose mock agent ends with `APPROVED`, or with
  `CHANGES_REQUESTED` when the step's extra prompt says "strictly", and a `plan-work` step whose
  answer also ends with `APPROVED`. The test ticks the verdict part in the builder, sees the
  gate pass by itself and then wait with the part named, and sees the planning gate offer no
  condition and wait. The rules test (`e2e/workflow-rules.spec.ts`, "build a workflow with a
  loop") makes a workflow from the Initiative template on that copy, adds two rules to its last
  step, moves one by key, and reads the drawn diagram's boxes and arrow labels before and after
  saving, after an edit, and after the rule's step is deleted (marked, and refused by the
  server); a seeded workflow whose step name has quotes, brackets, markup and a line break must
  be drawn with that name as text. The path test (`e2e/run-path.spec.ts`) makes a workflow from
  the Bug template there, whose check-work step brings the rule back to deliver-work, runs it
  with a mock review that asks for changes the first time and approves when asked again in the
  same thread, and reads the four visits and their reasons in the Path tab ("a review sends the
  work back and the run shows its path"); a seeded workflow whose review never approves
  (`limit-e2e`) runs into the limit, where the gate bar offers "Run once more" and Stop. That
  copy polls once a day, so the tests
  see only the reads that following a plan, starting a run and "Refresh now" start. CI runs `pnpm e2e` on
  `ubuntu-latest` and `windows-latest` (the `e2e` job) and keeps the traces of a failed run.
  A case that covers a behavior the review loop's ground truth names carries the tag
  `@review-loop-<n>` in its title, so `pnpm e2e --grep @review-loop` runs those and the report
  lists them; `e2e/review-loop.spec.ts` (files only, no browser) fails when a named behavior has
  no tagged case, when a sketch the spec's Interface names is missing, when the user guide leaves
  out a setting of the groups the review loop added, or when `docs/windows-smoke.md` lacks its
  three manual steps.
  Tests wait for what the page shows, never for time: no sleeps, polls or retries.
