---
intent: 2026-11-wow-app
rev: 1
built_on: intent@1
status: accepted
---

# One desktop app that holds my working day: calendar, agent chat, workflows and backlog

## Summary

You open one window in the morning. On the left is the week, with your Outlook meetings, a strip
of unread mail, and the cards you put there yourself. Some cards carry a workflow: at the card's
time the app starts the first step as an agent thread, and the card turns yellow when the agent
needs your answer. On the right is the chat with that thread, where you answer, approve commands,
pick the model, and continue to the next step. A workflow is a list of skills you built in the
builder, with a stop after each planning step so nothing gets specified without you. Ideas that
are not tickets yet live in the backlog until you give one a workflow and a time. Nothing is sent
to Outlook, Jira or GitHub unless you press a button that says so.

## Behavior

### Calendar

1. Given Outlook is running and the app is open, when the week view is shown, then every Outlook
   calendar item in the configured lookahead window appears in its time slot with title, time,
   location or Teams link, and a read-only marker. Recurring meetings appear once per occurrence.
2. Given the Outlook poll interval has elapsed, when a meeting moved or was cancelled in Outlook,
   then the calendar reflects it within one poll interval without a restart.
3. Given Outlook is not running or the bridge fails, when the calendar is shown, then the last
   cached items are shown with a visible "Outlook unavailable since <time>" banner and the rest of
   the app keeps working.
4. Given the mail rail is enabled, when there is unread mail in the configured folders, then the
   rail shows sender, subject, received time and a count, newest first, and clicking an item opens
   it in Outlook.
5. Given the day or week view, when the user creates a card by clicking or dragging a time range,
   then a local card is stored with title, start, duration, optional project, optional backlog item,
   optional workflow, and it never appears in Outlook.
6. Given a local card, when it is dragged to another slot or resized, then its stored time changes,
   and if it carries a workflow the trigger time changes with it.
7. Given day view, when the user presses the configured next/previous keys or "today", then the
   view moves by one day; week view moves by one week and starts on the configured first day of
   the week in the configured time zone, with the configured work hours highlighted.

### Triggers and scheduling

8. Given a local card with a workflow and a time in the future, when that time arrives and the
   server is running, then a workflow run is created for the card, step 1 starts as a new thread in
   the card's project with the step's provider, model and effort, and the card shows "running".
9. Given a step with a gate after it, when the step's turn completes, then the run status is
   "waiting for you", the card and the thread's sidebar entry show it, a desktop notification is
   sent if enabled, and nothing further runs until the user presses "Continue" or "Stop" in the run
   view or the thread.
10. Given a step with a gate before it, when the previous step completed, then the run waits in the
    same way before starting the step.
11. Given a run is waiting, when the user presses "Continue", then the next step starts in a new
    thread whose prompt includes the step's skill invocation and the configured handover text
    (defaults to the previous step's final message and the expected artifact paths).
12. Given the server was not running when a trigger's time passed, when the server starts, then the
    configured missed-trigger policy applies: `run` starts it immediately, `mark` marks the card
    "missed" with a one-click "Run now", `skip` marks it missed and does nothing.
13. Given a run is running or waiting, when the user deletes its card, then the app asks whether to
    stop the run; the threads are kept either way.

### Chat

14. Given a provider instance is connected, when the user starts a new thread with a project,
    provider, model, effort and permission mode, and sends a message, then assistant text streams
    token by token, each tool call shows as an expandable row with input and output, and the turn
    ends with usage (input, output, cached tokens, cost where the provider reports it).
15. Given the provider asks for approval (command, file change, tool), when the request arrives,
    then the thread shows an approval row with allow once, allow for this session and deny, the
    sidebar marks the thread "needs you", and the answer is sent back to the provider.
16. Given the provider asks a question (Claude `AskUserQuestion`, Codex `requestUserInput`), when it
    arrives, then the thread shows the options as buttons plus free text, and the answer resumes the
    same turn.
17. Given a thread exists, when the user changes model, effort or permission mode in the thread
    header, then the next turn uses them, and a thread can be resumed after an app restart with its
    provider session id.
18. Given the composer, when the user types `$`, then installed skills are listed by name and
    description, filtered as they type; choosing one inserts the provider's invocation form (`/name`
    for Claude, `$name` for Codex).
19. Given the composer, when the context meter is enabled, then it shows the thread's context usage
    from the latest provider report and offers a compact action for providers that support it.
20. Given Claude's task list tools are enabled, when the agent updates its task list, then the
    thread shows the tasks as rows with status.
21. Given the sidebar, when threads change state, then they are grouped under "Needs you",
    "Working", "Idle" and "Done", with pinned threads above, and a thread that belongs to a workflow
    run shows the run and step name.
22. Given the command palette (Ctrl+K), when the user types, then threads, cards, backlog items,
    workflows, settings pages and actions are searched together and chosen with the keyboard.
23. Given a turn is running, when the user presses stop, then the provider is interrupted and the
    partial output is kept.

### Workflows

24. Given the builder, when the user creates a workflow, then they give it a name, optional
    template kind, and an ordered list of steps; each step has a skill from the installed list, a
    provider instance, model, effort, permission mode, gate before, gate after, an optional extra
    prompt, and optional expected artifact globs.
25. Given the templates setting, when the user starts from a template, then "Bug" is
    deliver-work → check-work, "Feature" is capture-intent (gate after) → plan-work (gate after) →
    deliver-work → check-work, and "Initiative" is capture-intent (gate after) → plan-work (gate
    after) → shape-work (gate after) → deliver-work → check-work. Templates are editable settings.
26. Given a run view, when a run exists, then each step shows not started, running, waiting,
    done or failed, its thread link, and any expected artifact that exists in the project (for
    example `intents/*/spec.md`) with a link to open it.
27. Given a skill directory changed on disk, when the builder is opened or refresh is pressed, then
    the skill list reflects it; skills with `disable-model-invocation: true` are still offered,
    because the app invokes them explicitly.

### Backlog

28. Given the backlog view, when the user adds an item, then it has title, markdown body, tags and
    status (idea, planned, running, done, dropped) and nothing is sent anywhere.
29. Given a backlog item, when the user chooses "Plan on calendar", then a card is created with
    the item, a chosen workflow and a time, and the item becomes "planned"; when the run finishes
    the item becomes "done" or stays "planned" with the failure shown.
30. Given a backlog item and a configured tracker, when the user presses "Publish to Jira" or
    "Publish to GitHub", then the app shows the issue it will create, creates it on confirm, and
    stores key and URL on the item. A second press offers to open the existing issue instead.

### Settings and providers

31. Given Settings → Providers, when the user adds a Claude instance, then they set binary path,
    config directory (`CLAUDE_CONFIG_DIR`), environment variables (secret-marked ones stored
    encrypted), launch arguments, default model and effort; "Test" runs a trivial turn and shows
    the logged-in account or the error.
32. Given Settings → Providers, when the user adds a Codex instance, then they set binary path,
    `CODEX_HOME`, environment variables, default model and effort; "Test" starts the app-server,
    lists models and shows the account or the error.
33. Given any setting in the registry, when the settings page is opened, then it is rendered from
    the registry schema with its description, default and current value, and a change takes effect
    without restart unless the setting is marked "restart required".
34. Given the app is closed to the tray, when a trigger fires, then it still runs, and clicking the
    tray icon restores the window.
35. Given an installed wow and a newer stable GitHub release, when the app starts or the update
    interval passes, then it downloads the update in the background and offers "Restart to
    update"; restarting stops the server cleanly and installs it, and the next start runs the new
    version with the same `~/.wow` data. Updates are on by default and can be turned off in
    settings; "Check for updates" in the palette checks now.

## Boundaries and non-goals

- Outlook is read-only. Local cards never leave the app.
- No worktrees, diffs, terminal, checkpoints, side chats or browser panel in this version. The
  data model must not prevent them (a thread has a `cwd` and an optional `branch`).
- No tracker polling after publishing.
- One user, one machine, local only. No auth beyond the local WebSocket token.
- The server never runs a command declared by a repository on its own; agents do that inside
  their own permission model.

## Decisions

- **New app, T3-shaped.** A Node server owns processes and state, a React client renders it, and
  Electron wraps the client, bundles the server and provides tray, autostart and notifications.
  Rejected: forking T3 Code (too much to track), browser-only (no tray, COM and notifications are
  awkward).
- **Outlook COM via a PowerShell bridge.** A long-lived `powershell.exe` process reads
  `Outlook.Application` and answers JSON-lines requests. Rejected: native COM addons (build pain
  under Electron), Graph (needs tenant app registration; kept as a future adapter).
- **Codex through `codex app-server` JSON-RPC, Claude through the Agent SDK with the installed
  `claude` binary.** Both give streaming, approvals, questions, resume and model choice. Rejected:
  `claude -p` / `codex exec` streams (no mid-turn questions, weaker approvals).
- **Workflow = ordered chain of skills with gates.** No branches in version one; the data model is
  a list of steps so a graph editor can come later. Rejected: free DAG (much more UI), prompt
  lists without gates (no human in the loop).
- **Skills are discovered on disk.** The app reads `SKILL.md` frontmatter from configurable
  directories; agent-os is not hardcoded beyond the default templates.
- **Trigger fires start step one and stop at gates.** Rejected: reminder-only (does not save
  time), run-through (would plan or spec without the owner).
- **SQLite as the single store, command → events → projections.** Simplified from T3's
  orchestration: one `events` table is the history, projections are plain tables, clients subscribe
  to projections.
- **Settings are a schema-driven registry.** A zod schema per setting with group, description,
  default and scope; the settings UI is generated from it. This is how "everything configurable"
  stays cheap.
- **Auto-update from GitHub Releases with electron-updater, on from the first release.** The repo
  is public, so the app reads `latest.yml` from the newest stable release without a token. The
  installer is per-user, so updates need no admin rights. Unsigned for now: SmartScreen warns on
  first install, updates still work. Rejected: manual reinstall per version (0.1.0 users would be
  stranded), a custom update server (more to run).
- **Secrets encrypted with Windows DPAPI through PowerShell on Windows, plain `0600` file with a
  warning elsewhere.** Keeps the server standalone; the desktop app is not the only writer.

## Ground truth

- `pnpm typecheck && pnpm lint && pnpm test` green on Linux and Windows CI.
- `pnpm e2e` (Playwright, mocked providers and Outlook mock) covers behaviors 1, 3, 5, 6, 8, 9,
  11, 12, 14, 15, 16, 18, 21, 22, 24, 26, 29, 30, 33.
- Manual Windows check from `docs/windows-smoke.md`: real Outlook items appear, a real Claude and
  Codex turn stream, a card trigger starts a thread with the app in the tray.

## Open risks

- The Codex app-server protocol changes between releases. Evidence that settles it: the adapter
  pins the protocol version from `initialize` and the test suite runs against the installed
  `codex` binary in CI on a schedule.
- Outlook COM can block when a modal dialog is open in Outlook. Evidence: bridge timeout plus
  banner (behavior 3) is enough in daily use, measured during the Windows smoke check.
- Electron native module rebuilds (`better-sqlite3`) on Windows. Evidence: CI builds the installer
  on `windows-latest`.

## Decision log

- 2026-11-02: auto-update added (behavior 35, plan U17), before v0.1.0 so every install updates
  itself. Code signing stays out for now.
