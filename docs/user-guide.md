# wow user guide

wow puts your working day in one window: the week from Outlook plus your own cards, agent chats
with Claude Code and Codex, workflows that chain skills with stops for your answer, and a backlog
of ideas. Everything runs on your machine. Nothing is sent to Outlook, Jira or GitHub unless you
press a button that says so.

This guide covers the first run, providers, the calendar, chat, workflows, the backlog, settings
and troubleshooting. Technical details are in `docs/architecture.md`.

## First run

### What you need

- Windows 11 with the Outlook desktop client (classic Outlook; the new Outlook has no COM
  interface). On Linux and macOS everything works except Outlook, which shows invented sample
  items instead.
- The `claude` CLI, the `codex` CLI, or both, installed and logged in. wow uses your existing
  logins; it never asks for your Anthropic or OpenAI password.

### Install

Run the installer (`wow-setup-<version>.exe`, from the latest release on GitHub or the
`wow-installer-windows` artifact of a CI run). It is not code-signed, so Windows SmartScreen asks
once: choose "More info", then "Run anyway". After that wow updates itself (see "Updates"). Your
data stays in `%USERPROFILE%\.wow`.

From a checkout instead:

```sh
pnpm install --frozen-lockfile
pnpm --filter @wow/desktop build
pnpm --filter @wow/desktop exec install-electron
pnpm --filter @wow/desktop start
```

### The first window

On first start the app starts its local server, then opens on the calendar. With no provider set
up yet, the **Set up providers** dialog lists the `claude` and `codex` CLIs it found on your
`PATH`, with the config folder each one uses. Create an instance for each one you want; the dialog
tests each instance and shows the logged-in account or the error. You can skip it and add
instances later in Settings → Providers.

A project is a name and a folder; threads, cards and workflow runs work in that folder. Add your
projects in Settings → Projects (see "Projects" below). A thread can also use any folder you type
instead of a project; cards with a trigger and workflow runs need a project.

### Finding your way

The left sidebar has Calendar, Chat, Workflows, Backlog and Settings. Everything you can do is in
the command palette: press **Ctrl+K** and type. The palette searches threads, cards, backlog items,
workflows, runs, settings pages and actions together; arrow keys and Enter pick.

Default keys (all changeable in Settings → Keybindings):

| Key          | Does                                     |
| ------------ | ---------------------------------------- |
| Ctrl+K       | Command palette                          |
| Ctrl+1 … 4   | Calendar, Chat, Workflows, Backlog       |
| Ctrl+,       | Settings                                 |
| Ctrl+B       | Show or hide the sidebar                 |
| Ctrl+J       | Show or hide the right panel             |
| Ctrl+Shift+L | Dark or light theme                      |
| Ctrl+Alt+N   | New thread                               |
| Ctrl+.       | Stop the running turn                    |
| T, N, P      | Calendar: today, next, previous          |
| D, W         | Calendar: day view, week view            |
| C            | Calendar: new card on the day you are on |
| Ctrl+= / -   | Calendar: zoom in, zoom out              |
| Ctrl+0       | Calendar: reset zoom                     |

The single-letter calendar keys only work while the calendar is open and no text field has focus.
The zoom keys also only work while the calendar is open; there they zoom the calendar instead of
the whole window.

### Tray and autostart

Closing the window keeps wow running in the tray (`desktop.closeToTray`), so card triggers still
fire. Click the tray icon to bring the window back; its menu has Open, New thread, Pause or Resume
scheduler, and Quit. Turn on `desktop.autostart` to start wow at login; it then starts in the
tray. Starting wow a second time shows the window that is already running.

### Updates

The installed app looks for a newer stable release on GitHub (`sockulags/wow`) when it starts and
every `updates.checkIntervalMinutes` (four hours by default), and downloads it in the background.
When the download is done you get a notification, a bar above every view, a "Restart to update"
entry in the tray menu and in the palette. Restarting stops the server cleanly, installs the new
version without questions and starts it again; your data in `~/.wow` stays as it is. If a turn is
running or a workflow run is working, wow tells you first: restarting ends those turns as failed,
so choose "Later" to let them finish. Nothing installs until you choose to restart.

"Check for updates" in the palette checks now; Settings → Updates shows the current version, the
progress, and the last error. A failed check (no network, say) shows the error and the app keeps
working; the next check tries again. Turn `updates.enabled` off to stop checking altogether.
Prereleases are never offered. A build run from a checkout never updates itself.

## Providers

A provider instance is one CLI with one config folder and its own environment. You can have
several of the same kind, for example a work and a personal Claude account.

Settings → Providers lists the instances with the result of their last test (status, account,
version). For each instance you set:

- **Claude**: binary path, config folder (`CLAUDE_CONFIG_DIR`, defaults to `~/.claude`),
  environment variables, launch arguments, default model and effort.
- **Codex**: binary path, `CODEX_HOME` (defaults to `~/.codex`), environment variables, default
  model and effort.

Mark an environment variable as secret to store it encrypted (Windows DPAPI, for your user only).
**Test** runs a trivial turn (Claude) or starts the app-server and lists models (Codex), and shows
the account or the error. Changing the binary, folder, environment or arguments clears the last
test result. An instance cannot be edited or removed while a turn runs on it, and cannot be
removed while threads use it.

## Calendar

The calendar shows a day or a week (`D` and `W`), starting on `calendar.firstDayOfWeek` in
`calendar.zone`, with your work hours shaded and a red line at the current time. When today is in
view and now is outside your work hours, the grid opens on now; otherwise on the start of your
work hours. The URL keeps the view and the date.

### Zoom

Zoom changes how tall an hour is, so you see more of the day or more detail. Hold Ctrl and turn
the mouse wheel over the grid, or pinch on a touchpad; the time under the pointer stays where it
is. **Ctrl+=** and **Ctrl+-**, the − and + buttons in the toolbar, and "Zoom in calendar" and "Zoom
out calendar" in the palette zoom around the middle of the view. **Ctrl+0**, a click on the
percentage, or "Reset calendar zoom" go back to 100 %. Each step is `calendar.zoomStep` percent.
The zoom is the `calendar.hourHeight` setting, so it stays after a restart.

### Meetings and cards at the same time

Items that overlap in time sit side by side: each group of overlapping items splits the day's
width into columns, and an item takes the full width of the columns next to it that stay free. A
narrow block cuts its title short; hover it to see the full title, time and place, or Tab to it
and it widens over the day until it loses focus. Tab moves through the items in time order.

### Outlook

Outlook meetings in the next `calendar.lookaheadDays` appear in their time slot with title, time,
location or Teams link, and a lock marker: they are read-only, and wow never writes to Outlook.
Each occurrence of a recurring meeting appears on its own. A cancelled meeting that is still in
your calendar is struck through. All-day items sit in a row above the grid.

wow reads Outlook every `outlook.pollSeconds` (60 by default), so a moved or cancelled meeting
shows up within one interval. "Refresh Outlook" in the palette or the banner reads at once.

If Outlook is not running or does not answer (a modal dialog open in Outlook blocks it), the last
items stay on screen with a banner "Outlook unavailable since <time>". The rest of the app keeps
working, and the banner goes away on the next good read.

### Unread mail

The mail rail lists unread mail from `outlook.folders` (Inbox by default), newest first, with the
count. Click a message to open it in Outlook. Turn the rail off with `outlook.mailRail`.

### Cards

Cards are your own blocks of time. They never leave the app.

- **Create**: click a slot for a card of `calendar.cardMinutes`, or drag across a range, then name
  it. `C` or "New card" in the palette opens the same form.
- **Move and resize**: drag the card, also to another day; drag its lower edge to resize. Both snap
  to `calendar.snapMinutes`.
- **Edit**: click the card, or press Enter on it, or use "Edit card: <title>" in the palette. The
  dialog edits title, date, times, project, workflow and backlog item, and deletes.

A card with a workflow and a project is a **trigger**: at the card's start time the workflow's
first step starts (see "Triggers" below). Moving the card moves the trigger with it. The badge on
the card shows its state: scheduled, running, waiting, done, failed, stopped or missed.

## Chat

### Starting a thread

**Ctrl+Alt+N** or "New thread" opens a draft. Pick the provider instance, a project (or type a
folder), model, effort and permission mode, write the first message and press Enter. The first
line becomes the thread's title.

The reply streams as it is written. Reasoning is folded; click it to read. Every tool call is a
row you can open to see its input and output. A turn ends with its usage: input, output and cached
tokens, and the cost when the provider reports one. With `chat.contextMeter` on, the composer shows
how much of the context window the thread uses, with a Compact action for Claude.

### When the agent needs you

- **Approvals**: when the agent wants to run a command, change files or use a tool, the thread
  shows the request with **Allow once**, **Allow for this session** and **Deny**.
- **Questions**: when the agent asks (Claude's `AskUserQuestion`, Codex's user input request), the
  options show as buttons, and you can type your own answer instead. The answer continues the same
  turn.

Either way, the thread moves to "Needs you" in the sidebar until you answer.

### Skills

Type `$` in the composer to list installed skills with their descriptions; keep typing to filter,
and press Enter or click to insert one. wow inserts the form the thread's provider understands:
`/name` for Claude and `$name` for Codex.

### Managing threads

The sidebar groups threads under **Needs you**, **Working**, **Idle** and **Done**, with pinned
threads first (pin from the thread header). A thread whose turn failed sits under Idle with a
marker. A thread started by a workflow shows the workflow and step name.

**Mark thread done** in the thread header (or in the palette) moves a thread you have finished
with to **Done**. It is available while the agent neither works nor waits for you. **Reopen
thread** puts it back under Idle (a thread whose last turn failed keeps its marker), and sending a
new message to a done thread reopens it as well. A workflow step's thread moves to Done by itself
when its step completes; with a gate after the step, that happens once you press Continue.

Change model, effort or permission mode in the thread header; the next turn uses them. **Ctrl+.**
or the stop button interrupts a running turn and keeps what it produced. After a restart, a thread
continues its provider session; **Resume** sends `chat.resumePrompt` to pick up where it stopped.

## Workflows

A workflow is an ordered list of skills. Each step runs as its own agent thread, and a gate is a
stop where nothing continues until you say so.

### Building one

Workflows → New workflow (or "New workflow from template" in the palette). Give it a name, then
add steps. Each step has:

- a skill from the installed list (Refresh skills re-reads the skill folders),
- a provider instance, model, effort and permission mode,
- **gate before** and **gate after**,
- an optional extra prompt,
- optional expected artifacts: globs, one per line, such as `intents/*/spec.md`.

Reorder steps by dragging the handle or with the move buttons. The templates (editable in
`workflows.templates`):

- **Bug**: deliver-work → check-work
- **Feature**: capture-intent (gate after) → plan-work (gate after) → deliver-work → check-work
- **Initiative**: capture-intent (gate after) → plan-work (gate after) → shape-work (gate after) →
  deliver-work → check-work

Skills come from the folders in `skills.directories` (`~/.claude/skills`, `~/.codex/skills` and
each project's `.claude/skills` and `.agents/skills` by default) and, with
`skills.includeClaudePlugins`, from installed Claude plugins. Skills marked
`disable-model-invocation: true` are offered too, because wow invokes them explicitly.

### Running one

Open a workflow, pick a project and press **Run now**, or put it on a card. The run view shows each
step as not started, running, waiting, done or failed, with a link to its thread and links to the
expected artifacts that exist in the project.

When a run reaches a gate it waits: the run, its card and the step's thread show "waiting for
you", and a desktop notification is sent (`scheduler.notifications`). Read the step's thread,
then press **Continue** in the run view to start the next step, or **Stop** to end the run. The
next step's prompt is its skill invocation, its extra prompt, and the handover from
`workflows.handoverTemplate` (by default the previous step's final message and the expected
artifact paths). Stopping a run keeps all its threads.

### Triggers

A card with a workflow and a project starts its run at the card's start time while wow is running,
also from the tray. The first step starts in the card's project, and the card follows the run.

If wow was not running at that time, `scheduler.missedPolicy` decides at the next start:

- `run` starts it right away,
- `mark` (default) marks the card "missed" with a one-click **Run now**,
- `skip` marks it missed and does nothing.

"Pause scheduler" in the palette or the tray holds every trigger; the calendar shows "Scheduler
paused" until you resume. Triggers that came due while paused get the missed policy on resume.

Deleting a card whose run is running or waiting asks whether to stop the run too. The threads stay
either way.

## Backlog

The backlog holds ideas that are not tickets yet. An item has a title, a markdown body, tags and a
state: idea, planned, running, done or dropped. Adding and editing items sends nothing anywhere.

- **Plan on calendar** picks a workflow, a project, a date and a time, creates a card for the item
  and makes the item "planned". The item follows the run: "running" while it runs, "done" when it
  finishes, back to "planned" with the failure shown if it fails or is stopped.
- **Publish to Jira** and **Publish to GitHub** show the issue they will create first. **Create
  issue** creates it and stores its key and link on the item. Pressing publish again offers to open
  the existing issue instead. If the tracker is not set up, the dialog names the missing settings
  and links to Settings → Trackers. wow does not read the issue back afterwards.

Tracker settings (Settings → Trackers):

- Jira: base URL, auth mode (`cloud-basic` with email and API token, or `pat` for a personal
  access token on Server or Data Center), project key, issue type.
- GitHub: base URL (`https://api.github.com`, or `https://<host>/api/v3` for Enterprise Server),
  token, owner, repository, labels.

Tokens are stored encrypted; clearing the field deletes the stored token.

## Projects

Settings → Projects lists your projects with their folders. **New project** (also "New project"
in the palette) asks for a name and a folder. In the desktop app **Choose folder…** opens the
system folder dialog; only the browser build of the app (development) takes a typed path, and the
server refuses a folder it cannot find. A name another project already has is refused too. Every
project picker (new thread, card dialog, Run now, Plan on calendar) offers the new project at once.

**Import from Claude and Codex** (also in the palette) looks through the session history of every
provider instance in Settings → Providers: Claude Code's `projects` folder in the instance's config
directory and Codex's `sessions` folder in its `CODEX_HOME`. It lists each folder they worked in
that still exists and is not a project yet, with the instances that used it and when, all checked.
Uncheck what you do not want and press **Import**; each folder becomes a project named after it
(with a number when the name is taken). Nothing is changed in Claude's or Codex's files.

**Rename** changes only the name; threads, cards and runs follow it. **Remove** asks first and
leaves the folder and its files alone. Threads that used the project keep working in its folder
without a project. Cards lose the project, so their triggers will not fire until you pick another
one. Finished workflow runs keep their history. A project with a workflow run in progress cannot be
removed: stop the run or let it finish first. The palette has "Rename project …" and "Remove
project …" for every project.

## Settings

Settings are grouped: Providers, Projects, Chat, Calendar, Outlook, Scheduler, Workflows, Skills, Trackers,
Appearance, Keybindings, Desktop, Updates and Advanced. Every setting shows its description, its default
and its current value. A change applies at once, except settings marked **Restart required**
(the server port), which apply after quitting and starting wow again. A value that does not pass
validation is refused and the old one stays.

Useful ones to know:

- `providers.testTimeoutMs`, `providers.requestTimeoutMs` (how long Codex may take to answer one
  request; can be set per provider instance)
- `calendar.zone`, `calendar.firstDayOfWeek`, `calendar.workHours`, `calendar.lookaheadDays`
- `outlook.pollSeconds`, `outlook.folders`, `outlook.requestTimeoutMs`
- `scheduler.missedPolicy`, `scheduler.notifications`, `scheduler.paused`
- `workflows.templates`, `workflows.handoverTemplate`
- `appearance.theme` (dark by default), `appearance.density`
- `desktop.closeToTray`, `desktop.autostart`, `desktop.startMinimized`
- `updates.enabled`, `updates.checkIntervalMinutes`

## Where wow keeps things

Everything is in `~/.wow` (`%USERPROFILE%\.wow` on Windows), or in the folder `WOW_HOME` names:

| File           | What                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `wow.sqlite`   | All data: threads, cards, workflows, runs, backlog, settings, history |
| `secrets.json` | Encrypted tokens and secret environment values                        |
| `server.json`  | Port and token of the running server; removed on a clean stop         |
| `desktop.log`  | The desktop app's log and the server's output                         |

Back up `wow.sqlite` and `secrets.json` together. Secrets are encrypted for your Windows user and
cannot be read on another machine or account.

## Known gaps in this version

None are known right now; the rest of this guide describes the intended behavior.

## Troubleshooting

**"Outlook unavailable since …"**

- Outlook is not running: start it. wow never starts Outlook itself.
- A dialog is open in Outlook (a reminder, a security prompt): close it. Requests time out after
  `outlook.requestTimeoutMs`.
- You use the new Outlook: it has no COM interface; switch back to classic Outlook.
- Press "Refresh Outlook" to try at once instead of waiting for the next poll.

**A provider test fails**

- Check the binary path; `where claude` or `where codex` in a terminal shows what is on `PATH`.
- Check the config folder: it must be the one the CLI is logged in with. Run the CLI once in a
  terminal with the same `CLAUDE_CONFIG_DIR` or `CODEX_HOME` and log in there.
- A slow first start can exceed `providers.testTimeoutMs`; raise it and test again. For Codex,
  "codex did not answer … within … ms" means one request exceeded `providers.requestTimeoutMs`.
- Codex: wow is generated against one app-server protocol version. A test that reports a version
  mismatch means the installed `codex` is newer or older than the one wow knows.

**A card did not start its run**

- The card needs both a workflow and a project.
- Check "Scheduler paused" in the calendar toolbar or the tray menu.
- If wow was closed at the card's time, the card shows "missed"; press **Run now**.
- The scheduler looks every `scheduler.tickSeconds` (30 by default), so a run can start up to that
  long after the card's time.

**A thread says "Needs you" but shows nothing to answer**

Scroll to the end of the thread; the approval or question row is the last one. If the server was
restarted mid-turn, the turn is marked failed; send a new message or press Resume.

**Skills are missing in the `$` list or the builder**

Check `skills.directories`, then press "Refresh skills" in the builder or the palette. A
`SKILL.md` whose frontmatter does not parse is skipped and logged in `desktop.log`.

**Publishing to Jira or GitHub fails**

The error shows what the tracker answered. Common causes: a wrong base URL, an expired token, a
project key or repository the token cannot reach, or an issue type that does not exist in the Jira
project.

**The window does not open**

wow may already run in the tray: click its icon. If the server stopped unexpectedly, wow asks
whether to restart it. `desktop.log` in the wow folder has the details.

**Starting over**

Quit wow from the tray and rename the wow folder. The next start creates a fresh one.
