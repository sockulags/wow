---
intent: 2026-11-wow-app
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: One desktop app that holds my working day

Execution: `.claude/workflows/build-wow.js` delivers units in dependency order with at most three
agents at a time (worker, reviewer and integrator share the three slots). Every unit reads
`CLAUDE.md`, `docs/architecture.md`, `spec.md` and its own section before starting.

## Units

- [U1] Monorepo scaffold, contracts skeleton, CI
- [U2] Server core: RPC, SQLite, events and projections, settings registry, secrets — depends on U1
- [U3] Web shell: tokens, layout, routing, sidebar, palette, generated settings page — depends on U1
- [U4] Outlook bridge and mock — depends on U1
- [U5] Claude provider adapter — depends on U2
- [U6] Codex provider adapter — depends on U2
- [U7] Skills discovery and workflow engine — depends on U2
- [U8] Chat view — depends on U3, U5, U6
- [U9] Calendar views and Outlook sync — depends on U2, U3, U4
- [U10] Workflow builder and run view — depends on U3, U7
- [U11] Scheduler and triggers — depends on U7, U9
- [U12] Backlog and tracker publishing — depends on U9, U10
- [U13] Provider onboarding and settings coverage — depends on U8
- [U14] Electron desktop: server lifecycle, tray, autostart, installer — depends on U2, U3
- [U15] End-to-end tests and user guide — depends on U8, U11, U12, U13, U14
- [U16] Windows smoke and release candidate — depends on U15, U17
- [U17] Auto-update from GitHub Releases — depends on U14

### U1 Monorepo scaffold, contracts skeleton, CI

Outcome: `pnpm install && pnpm typecheck && pnpm lint && pnpm test` pass on an empty but
complete workspace with every package and app from `docs/architecture.md` present, each with a
`package.json`, `tsconfig.json`, one trivial test and a README line. `packages/contracts` holds
the RPC envelope, `ProviderCommand`, `ProviderEvent`, `WorkflowStep`, `StepRun` and the
`settingsRegistry` type with the calendar and scheduler groups filled in. `.github/workflows/ci.yml`
runs the checks on `ubuntu-latest` and `windows-latest`. `.gitattributes`, `.editorconfig`,
Prettier and oxlint configured. `THIRD_PARTY_NOTICES.md` present.
Boundaries: no feature code. No Electron build yet (U14). Do not add dependencies a later unit
does not need.
Acceptance: spec "Ground truth" first line, CI green on both runners.
Ground truth: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test`, CI run
link in the pull request.
Delivery target: pull request
Open risks: none

### U2 Server core: RPC, SQLite, events and projections, settings registry, secrets

Outcome: `apps/server` starts, writes `~/.wow/server.json` (port, token), accepts authenticated
WebSocket connections, validates every request against `packages/contracts`, and implements the
command → events → projections pipeline with `better-sqlite3` + drizzle migrations for every table
in `docs/architecture.md`. Settings read/write go through the registry with scope resolution
(provider > project > global). `packages/secrets` works on Windows (DPAPI) and elsewhere (0600).
Subscriptions push projection changes. A `mock` provider adapter and the `MockOutlookSource` hook
points exist so later units plug in.
Boundaries: no provider, Outlook, scheduler or workflow logic beyond the tables and the hook
interfaces. No UI.
Acceptance: behaviors 33 (server side), the "idempotent retries" and "subscribers after commit"
rules in `docs/architecture.md`.
Ground truth: `pnpm --filter @wow/server test` includes: a command applied twice yields one event
set; a subscriber sees a projection only after commit; a secret written on Linux is `0600`; the
DPAPI path is covered on `windows-latest` CI.
Delivery target: pull request
Open risks: `better-sqlite3` under Electron is U14's problem; here it runs under plain Node.

### U3 Web shell: tokens, layout, routing, sidebar, palette, generated settings page

Outcome: `apps/web` renders the T3-like shell: left sidebar with sections (Calendar, Chat,
Workflows, Backlog, Settings), main area, collapsible right panel, dark/light tokens in
`tokens.css`, TanStack Router routes for each view with empty states, Ctrl+K palette (cmdk) with
navigation commands, keybindings setting applied, and a settings page generated from
`settingsRegistry` with every field type rendered and validated. `packages/client-runtime`
connects to the server from `server.json` (desktop) or a URL (dev), reconnects, and exposes
subscription-backed Zustand stores.
Boundaries: no feature views beyond empty states. Settings page is wired to the server RPC from U2
if available at integration time; otherwise against the contracts with an in-memory store that
U9/U10/U13 replace.
Acceptance: behaviors 22 (navigation part), 33 (UI part).
Ground truth: `pnpm --filter @wow/web test` (component tests for the generated settings fields and
the palette), `pnpm e2e --grep shell` (opens every route, toggles theme, changes a setting).
Delivery target: pull request
Open risks: Tailwind v4 + shadcn generator versions; pin them.

### U4 Outlook bridge and mock

Outcome: `packages/outlook-bridge` with `bridge.ps1`, the `OutlookSource` interface,
`PowershellOutlookSource` (process supervision, request ids, timeouts, restart) and
`MockOutlookSource` with invented fixtures covering recurring meetings, all-day events, a Teams
link, cancelled items and unread mail. The server's Outlook service polls on
`outlook.pollSeconds`, upserts `calendar_items` (source `outlook`) and `mail_items`, and maintains
`outlook_status`.
Boundaries: read-only. No UI. No Graph.
Acceptance: behaviors 1, 2, 3, 4 (server side).
Ground truth: `pnpm --filter @wow/outlook-bridge test` (mock, parser, supervisor with a fake
process that hangs → timeout → restart); on `windows-latest` CI the real bridge starts without
Outlook and reports "unavailable" cleanly.
Delivery target: pull request
Open risks: COM behavior with Outlook modal dialogs; covered by the timeout path.

### U5 Claude provider adapter

Outcome: `packages/provider-claude` implements the provider interface with the Agent SDK as
described in `docs/architecture.md`: streaming input mode, deltas, tool calls, `canUseTool` →
approvals and questions, resume, model/effort/permission changes, usage and context usage,
interrupt, `test` (trivial turn that reports account and version), `listModels` via
`supportedModels()`. The server's provider service routes commands and persists events as
`thread_items`, `approvals`, `questions`, `turns`.
Boundaries: no UI. Do not special-case agent-os. No Codex.
Acceptance: behaviors 14 to 17, 20, 23 (server side).
Ground truth: Vitest with a fake SDK stream fixture covering text, tool call, approval, question,
result; a real smoke test behind `WOW_REAL_PROVIDERS=1` that runs one turn with the installed
`claude`.
Delivery target: pull request
Open risks: SDK version drift; pin the version and record the `claude_code_version` from the init
message in the instance status.

### U6 Codex provider adapter

Outcome: `packages/provider-codex` implements the provider interface over `codex app-server`
JSON-RPC: process supervision, `initialize`, thread start/resume, turn start/interrupt, item
notifications → deltas and tool calls, approval and user-input requests → approvals and questions,
model list, usage, `test`. Types are generated or transcribed from the protocol definitions of the
pinned `codex` version with the generator script committed.
Boundaries: no UI. No Claude.
Acceptance: behaviors 14 to 17, 23 (server side).
Ground truth: Vitest with recorded JSON-RPC fixtures through a fake stdio process; real smoke
behind `WOW_REAL_PROVIDERS=1`.
Delivery target: pull request
Open risks: protocol names differ between codex releases; the adapter must read them from the
protocol definitions, not from memory, and the pull request must name the codex version tested.

### U7 Skills discovery and workflow engine

Outcome: `packages/skills` scans and watches the configured directories and fills the `skills`
projection with invocation forms. `packages/workflow-engine` is the pure state machine for runs:
start, step completed, gate answered (continue/stop), step failed, missed policies, handover prompt
rendering with the `workflow.handoverTemplate` setting, artifact detection. Default templates
(Bug, Feature, Initiative) are seeded in `settingsRegistry`. The server wires engine effects to the
provider service (start a thread with the rendered prompt) and exposes RPC for workflows and runs.
Boundaries: no scheduler tick (U11), no UI (U10).
Acceptance: behaviors 9, 10, 11, 25, 27 (server side).
Ground truth: engine state tables in Vitest (every transition in the spec), skills scan test over
a fixture tree including `agents/openai.yaml` and `disable-model-invocation`.
Delivery target: pull request
Open risks: none

### U8 Chat view

Outcome: the chat view in `apps/web`: thread sidebar with "Needs you / Working / Idle / Done",
pinning, run and step labels; thread header with provider instance, model, effort, permission
mode; conversation with streamed text, reasoning (collapsed), expandable tool rows, approval rows,
question rows, task list rows, usage per turn, errors; composer with `$` skill picker, attachments
off, stop button, resume; context meter with compact action; palette commands for new thread,
switch provider, stop. Works against the mock provider in e2e and the real adapters in use.
Boundaries: no diff panel, worktrees, terminal, checkpoints, side chats, browser panel.
Acceptance: behaviors 14 to 23.
Ground truth: `pnpm e2e --grep chat` with the mock provider: stream, approve, answer a question,
pick a skill, stop, resume after reload.
Delivery target: pull request
Open risks: streaming performance with long tool outputs; virtualize the conversation list.

### U9 Calendar views and Outlook sync

Outcome: day and week views with time grid, configured zone, first day of week and work hours,
Outlook items (read-only, Teams join button), local cards (create by click or drag, edit, move,
resize, delete), mail rail with unread items that open in Outlook, "Outlook unavailable" banner,
"today" and next/previous keys, palette commands. Cards show state badges (scheduled, running,
waiting, done, failed, missed) from the `calendar_items.state` projection; the actual transitions
come in U11.
Boundaries: no trigger firing. No Outlook writes.
Acceptance: behaviors 1 to 7.
Ground truth: `pnpm e2e --grep calendar` with `WOW_OUTLOOK=mock`: items render, banner on mock
failure, card create/move/resize persists across reload.
Delivery target: pull request
Open risks: DST transitions in week view; test the fixture week that crosses the October change.

### U10 Workflow builder and run view

Outcome: workflow list, builder with ordered steps (drag to reorder), step editor (skill from the
`skills` projection with description, provider instance, model, effort, permission mode, gate
before/after, extra prompt, expected artifact globs), template picker from settings, validation;
run view with step states, thread links, Continue and Stop at gates, artifacts found with open
action; palette commands.
Boundaries: no graph editor. No scheduling (U11).
Acceptance: behaviors 24, 25, 26, 27.
Ground truth: `pnpm e2e --grep workflows`: build from the Feature template, run manually in a
project, mock provider completes step 1, gate shows, Continue starts step 2.
Delivery target: pull request
Open risks: none

### U11 Scheduler and triggers

Outcome: creating or moving a card with a workflow creates or updates a trigger; the scheduler tick
fires due triggers into workflow runs; gates set card and thread state "needs you" and send a
desktop notification through the server's notification channel (desktop app renders it in U14,
web shows a toast); missed policy applied at startup; "Run now" on missed cards; delete-card
confirmation when a run is live; "Pause scheduler" command.
Boundaries: no tracker, no Electron code.
Acceptance: behaviors 8 to 13.
Ground truth: Vitest for the tick with a controllable clock (no sleeps); `pnpm e2e --grep
triggers` with a trigger set a few seconds ahead against the mock provider and a server restart
that exercises each missed policy.
Delivery target: pull request
Open risks: none

### U12 Backlog and tracker publishing

Outcome: backlog view with items (title, markdown body, tags, state), filters, "Plan on calendar"
(creates a card with workflow and time), state follows the run; "Publish to Jira" and "Publish to
GitHub" with preview, confirm, stored key and URL, "open existing" on repeat; tracker settings in
the registry (Jira cloud basic auth or PAT, GitHub token and base URL for Enterprise).
Boundaries: no status sync from the tracker. No issue import.
Acceptance: behaviors 28, 29, 30.
Ground truth: Vitest for both tracker clients against recorded HTTP fixtures (`msw`); `pnpm e2e
--grep backlog` with mocked trackers.
Delivery target: pull request
Open risks: Jira Server vs Cloud field names; keep the issue payload minimal (project, type,
summary, description).

### U13 Provider onboarding and settings coverage

Outcome: Settings → Providers with add/edit/remove instance for Claude and Codex (binary path with
auto-detect on PATH, config directory, env with secret flag, launch args, defaults), "Test" with
account and version, status badges; a first-run wizard that detects installed CLIs and creates
instances; an audit that every tunable named in `docs/architecture.md` "Settings registry" exists
and renders, with a test that fails when a constant in `apps/server` or `apps/web` matches a known
tunable pattern without a registry entry.
Boundaries: no new features.
Acceptance: behaviors 31, 32, 33.
Ground truth: `pnpm e2e --grep settings`; registry coverage test.
Delivery target: pull request
Open risks: none

### U14 Electron desktop: server lifecycle, tray, autostart, installer

Outcome: `apps/desktop` spawns the bundled server, loads the web app with the token, tray with
Open / New thread / Pause scheduler / Quit, close-to-tray and autostart settings, native
notifications from the server channel, single-instance lock, `@electron/rebuild` for
`better-sqlite3`, electron-builder NSIS config, CI job that builds the Windows installer artifact.
Boundaries: no code signing. No auto-update.
Acceptance: behavior 34.
Ground truth: `pnpm --filter @wow/desktop test` (main-process unit tests with a fake server),
Windows CI artifact present, manual check in `docs/windows-smoke.md` left for U16.
Delivery target: pull request
Open risks: rebuild and packaging on Windows CI; budget a retry.

### U15 End-to-end tests and user guide

Outcome: the Playwright suite listed in spec "Ground truth" is complete and runs in CI on both
runners with mocks; `docs/user-guide.md` covers first run, providers, calendar, workflows,
backlog, settings and troubleshooting; `docs/windows-smoke.md` is the manual checklist.
Boundaries: no new features; fix defects found, each as its own commit.
Acceptance: spec "Ground truth" second line.
Ground truth: `pnpm e2e` green on both runners.
Delivery target: pull request
Open risks: flakiness; the rule against sleeps and polling in tests applies.

### U16 Windows smoke and release candidate

Outcome: the owner runs `docs/windows-smoke.md` on the work machine with real Outlook, Claude and
Codex; every defect found becomes a fix commit or a backlog item; version `0.1.0` tagged and the
installer attached to a GitHub release.
Boundaries: the owner performs the manual steps; the agent prepares, fixes and tags.
Acceptance: spec "Ground truth" third line.
Ground truth: completed checklist pasted into the release notes.
Delivery target: pull request plus tag
Open risks: none

### U17 Auto-update from GitHub Releases

Outcome: the installed app updates itself from GitHub Releases of `sockulags/wow` (spec behavior
35). `electron-updater` in `apps/desktop`; electron-builder `publish` set to the GitHub provider so
`dist` writes `latest.yml` and the `.blockmap` next to the installer (still `--publish never`; the
release workflow uploads them). The main process checks at startup and every
`updates.checkIntervalMinutes`, downloads in the background, and shows a notification and a
"Restart to update" action in the web app and the tray; installing stops the server through the
existing lifecycle before `quitAndInstall`. Settings-registry entries `updates.enabled` (default
true) and `updates.checkIntervalMinutes`; a palette command "Check for updates"; update state
(idle, checking, available, downloading with percent, ready, error) reaches the web app as
persisted state through the server or the desktop bridge, never derived in the UI. Nothing runs in
an unpackaged or dev build. Spec, `docs/architecture.md`, `docs/user-guide.md` and the desktop
README describe it.
Boundaries: no code signing. No prerelease channel. `.github/workflows/release.yml` belongs to
U16 and is not on main yet; write in the pull request exactly what it must upload (`latest.yml`,
the installer and its `.blockmap`, release not draft and not prerelease) instead of creating it.
Acceptance: behavior 35.
Ground truth: `pnpm --filter @wow/desktop test` with a fake updater covers: disabled setting means
no check; check at start and on interval; download progress and ready state reach the client;
"Restart to update" stops the server before install; errors leave the app running and show the
error. `electron-builder` config test or snapshot shows the GitHub publish provider and that
`latest.yml` is produced by `dist` on Windows CI. Repository checks green.
Delivery target: pull request
Open risks: an update installed while a turn or workflow step is running; the restart action must
say so and the user decides.

## Epic contract

Epic outcome: a morning with the app open covers the day without Outlook, two terminals and a
notes file side by side.
Acceptance: spec "Behavior" sections, all.
Children or delivery units: U1 to U17 as above; the split follows package boundaries (one adapter,
one view, one engine per unit) so three agents can work without touching the same files.
Aggregate verification: `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` on `main` after
every integration, Windows installer artifact, `docs/windows-smoke.md`.
Final verification owner: Lucas (manual smoke) and the integrator agent (automated checks).
