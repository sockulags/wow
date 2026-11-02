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
up yet, a short setup guide opens:

1. **Set up providers** lists the `claude` and `codex` CLIs it found on your `PATH`, with the
   config folder each one uses, already checked. **Set up** creates an instance for each and tests
   it, showing the logged-in account or the error.
2. **Add your projects** lists the folders those CLIs have already worked in, checked. **Import**
   turns each into a project; **Skip** moves on.
3. **You are set up** offers **Start a thread**.

**Not now** closes the guide and it does not open again (the `providers.offerSetup` setting; turn
it back on, or use "Detect installed providers" in the palette, to see it again).

A project is a name and a folder; threads, cards and workflow runs work in that folder. Add your
projects in Settings → Projects (see "Projects" below). A thread can also use any folder you type
instead of a project; cards with a trigger and workflow runs need a project.

### Finding your way

The left sidebar has Calendar, Chat, Workflows, Backlog and Settings. Chat and Workflows show a
yellow count when threads or runs wait for you; hovering an item or focusing it shows its key.
Below 1280 pixels wide the sidebar narrows to icons. When the window cannot reach the wow server, a
bar under the header says so and offers **Retry now**; lists keep what they last showed, dimmed,
until the connection is back. Everything you can do is in
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
| M            | Calendar: fold or unfold the mail rail   |

The single-letter calendar keys only work while the calendar is open and no text field has focus.
The zoom keys also only work while the calendar is open; there they zoom the calendar instead of
the whole window. The installed app has no window menu: Ctrl+R, Ctrl+Shift+I and the browser's
page zoom are off, so these keys always reach wow.

### Tray and autostart

Closing the window keeps wow running in the tray (`desktop.closeToTray`), so card triggers still
fire. Click the tray icon to bring the window back. Its menu starts with what needs you ("3 need
you" opens Chat) and the next trigger ("Next: Nightly triage at 16:30" opens the calendar), then
has Open, New thread, Pause or Resume scheduler, and Quit; the tray tooltip shows the same count. Turn on `desktop.autostart` to start wow at login; it then starts in the
tray. Starting wow a second time shows the window that is already running.

### Updates

The installed app looks for a newer stable release on GitHub (`sockulags/wow`) when it starts and
every `updates.checkIntervalMinutes` (four hours by default), and downloads it in the background.
When the download is done you get a notification, a bar above every view (with **What's new**,
which opens the release notes, and **Later**, which hides the bar until the next version), a
"Restart to update" entry in the tray menu and in the palette. Restarting stops the server cleanly, installs the new
version without questions and starts it again; your data in `~/.wow` stays as it is. If a turn is
running or a workflow run is working, wow tells you first: restarting ends those turns as failed,
so choose "Later" to let them finish. Nothing installs until you choose to restart.

"Check for updates" in the palette checks now; Settings → Updates shows the current version, the
progress, and the last error. A failed check shows what went wrong in words ("No internet connection.
wow will try again at 18:30.") and the app keeps working; the next check tries again. Settings →
Desktop and Settings → Updates only appear in the installed app. Turn `updates.enabled` off to stop checking altogether.
Prereleases are never offered. A build run from a checkout never updates itself.

## Providers

A provider instance is one CLI with one config folder and its own environment. You can have
several of the same kind, for example a work and a personal Claude account.

Settings → Providers lists the instances with the result of their last test (status, account,
version), the binary they run (with "from PATH" when the server found it there) and their config
folder. The instance your newest thread started on is marked **Default for new threads**. For each
instance you set:

- **Claude**: binary path, config folder (`CLAUDE_CONFIG_DIR`, defaults to `~/.claude`),
  environment variables, launch arguments, default model and effort.
- **Codex**: binary path, `CODEX_HOME` (defaults to `~/.codex`), environment variables, default
  model and effort.

When the editor opens it fills an empty binary path and config folder with what the server
detects, marked **Detected**; **Detect** looks again. Default model and effort start on "Claude's
default" (or Codex's): the provider picks. Once an instance is saved and tested, the editor lists
its models and the efforts each model offers.

Mark an environment variable as secret to store it encrypted (Windows DPAPI, for your user only).
**Test** runs a trivial turn (Claude) or starts the app-server and lists models (Codex), and shows
the account or the error. wow tests an instance by itself after you add or save it, and at start
for any instance that was never tested. Changing the binary, folder, environment or arguments
clears the last test result. An instance cannot be edited or removed while a turn runs on it, and
cannot be removed while threads use it. **Remove** removes at once and offers **Undo**; an instance
with secret variables asks first, because its stored secrets are deleted and cannot come back.

## Calendar

The calendar shows a day or a week (`D` and `W`, or the Day and Week buttons) with your work hours
shaded and a red line at the current time. In week view the line runs faintly across the other
days too, and today's date sits in a filled circle. The toolbar shows the range ("2–8 Nov 2026")
and the week number. When today is in view and now is outside your work hours, the grid opens on
now; otherwise on the start of your work hours. The URL keeps the view and the date.

Week view shows seven days. "Calendar: hide weekends" in the palette (or
`calendar.showWeekends`) shows the five work days instead.

### Zone, work hours and first day of the week

By default the calendar uses what Outlook says: the zone of Outlook's calendar, the work hours set
in Outlook and the first day of the week of your Windows region. Until Outlook has been read,
wow uses this computer's zone, 08:00–17:00 Monday to Friday, and the region's first day. In
Settings > Calendar each of the three shows "From Outlook: …" with an **Override Outlook** switch;
turn it on to set your own value. The time zone is a searchable list of zones with "From Outlook"
and "System" first.

The toolbar names the zone ("Tokyo, UTC+9") only when it is not this computer's own zone, and so
does the card form.

### Zoom

Zoom changes how tall an hour is, so you see more of the day or more detail. Hold Ctrl and turn
the mouse wheel over the grid, or pinch on a touchpad; the time under the pointer stays where it
is. **Ctrl+=** and **Ctrl+-**, the − and + buttons in the toolbar, and "Zoom in calendar" and "Zoom
out calendar" in the palette zoom around the middle of the view, in steps of
`calendar.zoomStep` percent that land on tens (100 %, 120 %, 140 %…). The percentage opens a menu
of levels and Reset; **Ctrl+0** and "Reset calendar zoom" go back to 100 %. At the lowest zoom the
whole day fills the view. The zoom is the `calendar.hourHeight` setting, so it stays after a
restart.

### Meetings and cards at the same time

Items that overlap in time sit side by side: each group of overlapping items splits the day's
width into columns, and an item takes the full width of the columns next to it that stay free. In
week view a group shows at most `calendar.weekMaxColumns` items side by side (two by default); the
rest are behind a "+N" button that lists them. A title wraps to the height of its block and stays
in view while you scroll a tall block. Hover or focus a block to see its full title, time and
place.

### The keyboard in the grid

The grid is one Tab stop; "Skip to calendar", the first thing Tab reaches in the calendar, jumps
straight to it.

- **Up** and **Down** move between the items of a day, **Left** and **Right** to the nearest item
  on the day before or after, **Home** and **End** to the first and last item of the day, and
  **Ctrl+Home** and **Ctrl+End** to the first and last of the range.
- **Enter** opens the item: a card's form, a meeting's details, or a "+N" list.
- **Alt+Up** and **Alt+Down** move a card by `calendar.snapMinutes`, **Alt+Left** and
  **Alt+Right** by a day. **Alt+Shift+Up** and **Alt+Shift+Down** move its end.

### Outlook

Outlook meetings in the next `calendar.lookaheadDays` appear in their time slot with title, time,
place and a lock marker: they are read-only, and wow never writes to Outlook. A Teams link reads
"Teams meeting", and Join sits on the block (an icon on the title line in short blocks). Each
occurrence of a recurring meeting appears on its own. A cancelled meeting that is still in your
calendar is struck through. All-day items sit in a row above the grid.

Click a meeting or press Enter on it for its details: time, place, organizer and the start of its
description, with **Join**, **Open in Outlook** and **Card before** or **Card after**, which open
the card form for the time right before or after the meeting.

wow reads Outlook every `outlook.pollSeconds` (60 by default), so a moved or cancelled meeting
shows up within one interval. The refresh button in the toolbar and "Refresh Outlook" in the
palette read at once.

If Outlook is not running or does not answer (a modal dialog open in Outlook blocks it), the last
items stay on screen with a banner "Outlook unavailable since <time>". **Try again** reads at once
and **What to check** lists the usual causes. The mail rail says when it was last read. The rest of
the app keeps working, and the banner goes away on the next good read.

### Unread mail

The mail rail lists unread mail from `outlook.folders` (Inbox by default), newest first, with the
count, the sender, the time, the subject and one line of the message. Click a message, or move to
it with the arrow keys and press Enter, to open it in Outlook. The fold button, `M` or "Collapse
mail rail" in the palette fold the rail to a strip with the count (`outlook.mailRailCollapsed`);
in a narrow window it folds on its own. Turn the rail off with `outlook.mailRail`.

### Cards

Cards are your own blocks of time. They never leave the app.

- **Create**: click a slot for a card of `calendar.cardMinutes`, or drag across a range, then name
  it. `C`, the New card button or "New card" in the palette opens the same form. The form starts
  with the project you used last. An end before the start is refused ("Ends before it starts"),
  and the form shows the length under End.
- **Move and resize**: drag the card, also to another day; drag its lower edge to resize. Both snap
  to `calendar.snapMinutes`. The keyboard does the same (see above).
- **Edit**: click the card, or press Enter on it, or use "Edit card: <title>" in the palette. The
  dialog edits title, date, times, the workflow and project to run, the backlog item and notes.
- **Delete**: "Delete card" in the form deletes it at once; **Undo** in the message that follows
  puts it back. A card whose workflow run is still going asks first whether to stop the run.

A card with a workflow and a project is a **trigger**: at the card's start time the workflow's
first step starts (see "Triggers" below). Moving the card moves the trigger with it. Triggers carry
a workflow icon and their state: Scheduled, Running, Needs you, Done, Failed, Stopped or Missed.
Plain cards show no state. A card with a workflow but no project is drawn dashed with "No project,
will not run". The form says what a trigger will do ("Starts at 16:30 in Demo · 4 steps, 2
gates"), warns when it will not run, and links to its run once it has one.

## Chat

### Starting a thread

**Ctrl+Alt+N** or "New thread" opens a draft with the cursor in the composer. It starts with what
your last thread used: the same provider instance, model, effort, permission mode and project. The
dot before the provider says whether its last test passed. The project picker also lists folders
you used without a project, and **Another folder…** (the folder dialog in the desktop app, a path
box in the browser). The chosen folder shows under the picker; hover it for the full path. Write
the first message and press Enter; the first line becomes the thread's title. Until a project or
folder is chosen, Send stays disabled and says why.

Below the composer, the new-thread view offers starters: a few skills (the project's own first),
open backlog items to start from, and the thread you worked in last. `chat.starterCount` sets how
many; 0 hides them.

The reply streams as it is written. Reasoning is folded; click it to read. Every tool call is a
row you can open to see its input and output. A turn ends with its usage: input, output and cached
tokens, and the cost when the provider reports one. With `chat.contextMeter` on, the composer shows
how much of the context window the thread uses, with a Compact action for Claude.

### When the agent needs you

- **Approvals**: when the agent wants to run a command, change files or use a tool, the thread
  shows the request with the folder it runs in, the permission mode, and **Allow once** (**A**),
  **Allow for this session** (**S**) and **Deny** (**D**). The request takes the focus, so the keys
  work at once; they are in Settings → Keybindings and in the palette. The tool row reads "waiting
  for approval" meanwhile.
- **Questions**: when the agent asks (Claude's `AskUserQuestion`, Codex's user input request), the
  options show as buttons. To answer in your own words, type in the composer (or the answer box
  under the options). The answer continues the same turn.

Either way, the thread moves to "Needs you" in the sidebar until you answer.

While a turn runs, the thread shows how long it has been working. You can write the next message
meanwhile: Enter queues it, and it is sent when the turn ends. **Send now** stops the turn and
sends it; the cross puts it back in the composer. A failed turn shows **Retry** (sends your last
message again) and **Resume** (sends `chat.resumePrompt`) in the error row.

### Skills

Type `$` in the composer to list installed skills with their descriptions, grouped by where they
come from (Project, User, Plugins) with the source on the right. Keep typing to filter, move with
the arrow keys, and press Enter or Tab (or click) to insert one; Escape closes the list. wow inserts
the form the thread's provider understands: `/name` for Claude and `$name` for Codex.

### Managing threads

The sidebar groups threads under **Needs you**, **Working**, **Idle** and **Done**, with pinned
threads first (pin from the thread header). Each row's second line says the project and when the
thread was last active. A thread whose turn failed sits under Idle with a marker. A thread started
by a workflow is titled by its step, with the workflow on the second line.

The thread header shows the project (hover it for the folder), the provider instance, and the
model, effort and permission selects. When a workflow run waits at a gate after the thread's step,
the thread shows the gate with **Continue** (**Ctrl+Enter**) and **Stop**, the same as the run
view.

**Mark thread done** in the thread header (or in the palette) moves a thread you have finished
with to **Done**. It is available while the agent neither works nor waits for you. **Reopen
thread** puts it back under Idle (a thread whose last turn failed keeps its marker), and sending a
new message to a done thread reopens it as well. A workflow step's thread moves to Done by itself
when its step completes; with a gate after the step, that happens once you press Continue.

Change model, effort or permission mode in the thread header; the next turn uses them. **Ctrl+.**
or the stop button interrupts a running turn and keeps what it produced. After a restart, a thread
continues its provider session; **Resume** sends `chat.resumePrompt` to pick up where it stopped.

### The palette

**Ctrl+K** opens the palette. Before you type it lists what needs you (threads waiting for an
answer, runs at a gate), your most recent threads, runs and backlog items
(`appearance.paletteRecent` sets how many), and the open view's actions. Typing searches
everything: threads, cards, workflows, runs, backlog items, settings pages and actions, with
matches in the title ranked first. The right side of each row says what it is ("Run · Waiting for
you · 14:39").

## Workflows

A workflow is an ordered list of skills. Each step runs as its own agent thread, and a gate is a
stop where nothing continues until you say so.

### Building one

Workflows → New workflow (or "New workflow from template" in the palette). Give it a name and start
from **Blank** or a template, then add steps. Each step is one line (number, skill, provider,
model); open it to edit:

- a skill from the installed list (Refresh skills re-reads the skill folders),
- a provider instance, model, effort and permission mode,
- an optional extra prompt,
- optional expected artifacts: paths or globs, one per line, such as `intents/*/spec.md`. With a
  project chosen to run in, the help line says how many files match there now.

Between steps (and before the first and after the last) the builder shows where the run waits:
**Waits for you** marks a gate; **Add a gate** adds one there. Reorder steps by dragging the handle
or with the move buttons. **Create workflow** stays disabled, with the reason in its tooltip, until
the workflow has a name and a step.

Templates are offered only for a new workflow. An existing one says which template it was based on;
**Replace steps with template…** swaps its steps after you confirm, and nothing changes until you
save. **Save as template…** stores the steps' skills, gates and expected artifacts as a template
under the name you give (a template with that name is replaced), so new workflows can start from
it; Settings → Workflows still has the full template list. **Delete** removes the workflow at once
and offers **Undo**. The templates (editable in
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

Open a workflow, pick the project next to **Run now** and press it (save changes first), or put it
on a card. The run view's header names the workflow, the project and when the run started, and
links to its card and backlog item. Each step shows not started, running, done or failed, how
long it took, a link to its thread and links to the expected artifacts that exist in the project.

When a run reaches a gate it waits: the run, its card and the step's thread show "waiting for
you", the step reads Done followed by a "Waiting for you" marker, and a desktop notification is
sent (`scheduler.notifications`). The gate shows what to review: the step's last message (folded)
and the artifacts it produced. Press **Continue** (**Ctrl+Enter**, `keybindings.continueRun`) in
the run view or the step's thread to start the next step, or **Stop** to end the run; Stop asks
first, because a stopped run cannot be continued. The next step's prompt is its skill invocation, its extra prompt, and the handover from
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
The list shows open items (not done, not dropped) by default; the state filter shows the rest.

Edit the title in the heading, the body with **Write** and **Preview**, and tags as chips (Enter or
a comma adds one; tags other items use are suggested). **Ctrl+S** saves. You set an item to Idea or
Dropped yourself; Planned, Running and Done follow its card and run and show read-only with the
reason. **Delete** removes the item at once and offers **Undo** (a card that pointed at it keeps
its time and workflow but loses the link).

- **Plan on calendar** suggests the next free slot in your work hours, around Outlook meetings and
  other cards, with Start and End like the card dialog, and the workflow you planned with last. It
  warns when the time overlaps something. It creates a card for the item and makes the item
  "planned". The item follows the run: "running" while it runs, "done" when it finishes, back to
  "planned" with the failure shown if it fails or is stopped.
- **Publish to Jira** and **Publish to GitHub** show the issue first: the target, an editable
  title, the item's tags to add as labels, and the description rendered. **Publish issue** creates
  it and stores its key and link on the item. Jira gets the description converted from markdown to
  its wiki markup, so headings, lists, emphasis, code and links show as in the preview; GitHub gets
  the markdown as written. Pressing publish again offers to open the existing issue instead. If the
  tracker is not set up, the dialog asks for the missing settings right there and then shows the
  preview. wow does not read the issue back afterwards.

Tracker settings (Settings → Trackers):

- Jira: base URL, auth mode (`cloud-basic` with email and API token, or `pat` for a personal
  access token on Server or Data Center), project key, issue type.
- GitHub: base URL (`https://api.github.com`, or `https://<host>/api/v3` for Enterprise Server),
  token, owner, repository, labels.

Tokens are stored encrypted; clearing the field deletes the stored token.

## Projects

Settings → Projects lists your projects with their folders and how many threads and cards use
each. **Add project** (also "New project" in the palette) asks for the folder first and names the
project after it; type another name if you like. In the desktop app **Choose folder…** opens the
system folder dialog; only the browser build of the app (development) takes a typed path, and the
server refuses a folder it cannot find. A name another project already has is refused too. Every
project picker (new thread, card dialog, Run now, Plan on calendar) offers the new project at once.

**Import from Claude and Codex** (also in the palette) looks through the session history of every
provider instance in Settings → Providers: Claude Code's `projects` folder in the instance's config
directory and Codex's `sessions` folder in its `CODEX_HOME`. It lists each folder they worked in
that still exists and is not a project yet, with which CLIs used it and how long ago, all checked.
Uncheck what you do not want (the box above the list checks or clears all) and press **Import**; each folder becomes a project named after it
(with a number when the name is taken). Nothing is changed in Claude's or Codex's files.

**Rename** changes only the name; threads, cards and runs follow it. **Remove** asks first and
leaves the folder and its files alone. Threads that used the project keep working in its folder
without a project. Cards lose the project, so their triggers will not fire until you pick another
one. Finished workflow runs keep their history. A project with a workflow run in progress cannot be
removed: stop the run or let it finish first. The palette has "Rename project …" and "Remove
project …" for every project.

## Settings

Settings are grouped: Providers, Projects, Chat, Calendar, Outlook, Scheduler, Workflows, Skills, Trackers,
Appearance, Keybindings, Desktop, Updates and Advanced. The search box above the groups finds a
setting by its name or description across all of them. Every setting shows its description and
its current value; numbers show their unit, and times in milliseconds are shown in seconds.
**Reset to default** appears only when a value differs from the default, and its tooltip says
what the default is. A change applies at once, except settings marked **Restart required** (the
server port): in the installed app **Restart now** appears after you change one. A value that does
not pass validation is refused and the old one stays. Turn on **Show setting keys** (Advanced) to
see each setting's key and raw default, for config files and bug reports.

Work hours are two times and a row of day buttons. The handover text has buttons that insert
each `{{placeholder}}` at the cursor. Settings → Trackers has a Jira and a GitHub section, each
with **Test connection**, which signs in with what you entered and says as whom; the Jira email is
only asked for Jira Cloud. Settings → Keybindings groups the keys by where they work and marks a
key that two commands share; click a key and press the new combination.

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
- Press **Try again** in the banner to read at once instead of waiting for the next poll.

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
