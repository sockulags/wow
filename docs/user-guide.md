# wow user guide

wow puts your working day in one window: the week from Outlook plus your own cards, agent chats
with Claude Code and Codex, workflows that chain skills with stops for your answer, and a backlog
of ideas. Everything runs on your machine. Nothing is sent to Outlook, Jira or GitHub unless you
press a button that says so.

This guide covers the first run, providers, the calendar, chat, workflows (with review at a gate,
working copies, event triggers and gates that pass by themselves), plans, the backlog, the
assistant, settings and troubleshooting. Technical details are in `docs/architecture.md`.

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

On first start the app starts its local server. When no provider is set up yet, the whole
window is one step, **Connect an agent**: Claude Code and Codex side by side, each with the binary
found on your `PATH` (or a line saying it is not installed), a **Test** button and, when the test
fails, the reason in words (for example that you are not signed in). **Test** creates the
provider instance if there is none of that kind yet and runs the same test as Settings →
Providers. Nothing else of the app shows until one test passes; the palette offers "Connect
Claude Code", "Connect Codex" and "Start from a setup file" meanwhile. An install that already
has a provider, even one whose test fails, opens as usual; Assistant then shows the same step.

Below the two agents is **Start from a setup file**: a colleague's file (see "A setup to share"
under "Assistant") is previewed and applied as one step before you connect, and its secrets are
left for you to fill in.

Once a test passes, the step goes away for good (the `providers.offerSetup` setting turns off, so
removing a provider later never hides the app again) and the Assistant opens. wow sends it a first
message for you (`assistant.greeting`), also when the window was reloaded in between (then when you
next open Assistant), and the assistant answers with what is set up and what a
first run still needs: usually a project and a workflow. After a setup file it then goes through
what the file left to fill in, one thing per answer: each token through its field, then your work
hours, then your project folders, which a file never holds.

The older three-step guide (providers, projects, done) is still in the palette as "Detect
installed providers".

A project is a name and a folder; threads, cards and workflow runs work in that folder. Add your
projects in Settings → Projects (see "Projects" below). A thread can also use any folder you type
instead of a project; cards with a trigger and workflow runs need a project.

### Finding your way

The left sidebar has Calendar, Chat, Workflows, Plans, Backlog, Assistant and Settings. Chat and Workflows
show a yellow count when threads or runs wait for you; hovering an item or focusing it shows its
key.
Below 1280 pixels wide the sidebar narrows to icons. When the window cannot reach the wow server, a
bar under the header says so and offers **Retry now**; lists keep what they last showed, dimmed,
until the connection is back. Everything you can do is in
the command palette: press **Ctrl+K** and type. The palette searches threads, cards, backlog items,
workflows, runs, settings pages and actions together; arrow keys and Enter pick.

Default keys (all changeable in Settings → Keybindings):

| Key              | Does                                                         |
| ---------------- | ------------------------------------------------------------ |
| Ctrl+K           | Command palette                                              |
| Ctrl+1 … 5       | Calendar, Chat, Workflows, Plans, Backlog                    |
| Ctrl+,           | Settings                                                     |
| Ctrl+B           | Show or hide the sidebar                                     |
| Ctrl+J           | Show or hide the context panel                               |
| F6               | Move the focus into the panel and back                       |
| Ctrl+Shift+L     | Dark or light theme                                          |
| Ctrl+Alt+N       | New thread                                                   |
| Ctrl+.           | Stop the running turn                                        |
| Ctrl+B           | Chat: send the running command or subagent to the background |
| Ctrl+Shift+J     | Next that needs you                                          |
| Ctrl+O           | Chat: open or close all reasoning                            |
| Ctrl+F           | Chat: find in the conversation                               |
| F3 / Shift+F3    | Chat: next match, previous match                             |
| Alt+Up / Down    | Chat: previous message, next message                         |
| C                | Chat: copy the message that has the keyboard                 |
| E                | Chat: edit your last message, when it has the keyboard       |
| F                | Chat: fork from the message that has the keyboard            |
| Up               | Chat, in an empty message box: edit your last message        |
| End              | Chat: back to the newest output                              |
| T, N, P          | Calendar: today, next, previous                              |
| D, W             | Calendar: day view, week view                                |
| C                | Calendar: new card on the day you are on                     |
| Ctrl+= / -       | Calendar: zoom in, zoom out                                  |
| Ctrl+0           | Calendar: reset zoom                                         |
| Ctrl+Enter       | Run at a gate: Approve                                       |
| Ctrl+Shift+Enter | Run at a gate: Send back                                     |
| Ctrl+Shift+D     | Run: Steps or Changes tab                                    |
| Ctrl+Shift+Y     | Run: Steps or Path tab                                       |
| O                | Changes tab: this step only, and back                        |
| C                | Diff line: comment on it                                     |
| Shift+Enter      | Focused file or line: open in editor                         |

Ctrl+B sends to the background only while the open thread runs a command or subagent its provider
can move there (Claude Code), so the turn goes on; otherwise, on Windows and Linux, it shows or
hides the sidebar as usual.
Ctrl+Shift+J goes to the oldest approval, question, plan, gate or assistant proposal that waits for
you, wherever it is; pressed again, to the next one. C copies the message that has the keyboard, as
markdown for an answer and as written for your own; it and the other single-letter chat keys only
work while a message has the keyboard.

The single-letter calendar keys only work while the calendar is open and no text field has focus.
The zoom keys also only work while the calendar is open; there they zoom the calendar instead of
the whole window. The installed app has no window menu: Ctrl+R, Ctrl+Shift+I and the browser's
page zoom are off, so these keys always reach wow.

### The context panel

The panel on the right shows the thing you selected next to the view you are in. **Ctrl+J**, the
panel button at the right of the header or "Toggle context panel" in the palette show and hide it,
and it stays that way after a restart (`appearance.contextPanel`). What it shows depends on the
view:

- **Calendar**: click a card for its time, project, workflow, trigger, backlog item and notes,
  with **Edit card**. When the card has a run, the thread of the step the run is on follows live
  below it: the conversation, **Approve**, **Send back** and **Stop** when the run waits for you, and the
  composer to answer the step. Click a meeting for its time, place, organizer, **Join** and **Open
  in Outlook**. While the panel is open a click selects instead of opening the card form or the
  meeting's popover, and the arrow keys in the grid move the selection with the focus; Enter on
  a selected card, or **Edit card**, opens the form. The selection is in the address
  (`?item=…`), so a reload shows the same card.
- **Workflows**: a run shows its active step's thread; a workflow shows its steps, where it waits
  for you and its runs.
- **Backlog**: an item shows its state, tags, where it is planned on the calendar, its runs and
  the issue it was published to.
- **Chat**: the thread's provider, model, effort, permissions, project and folder, its token use
  and cost, and the run, card and backlog item it belongs to.

With nothing selected the panel says what would appear there. Drag its left edge to make it wider
or narrower, or focus the edge and use the arrow keys (Shift for bigger steps, Home and End for
the narrowest and widest); the width is kept (`appearance.contextPanelWidth`). **F6** ("Focus
context panel") moves the focus into the panel, opening it if needed, and back to where you were;
"Show in panel" in the palette does the same for the view's selection. In a window narrower than
1200 pixels the panel does not take room from the view: it folds away, and opening it lays it over
the view until you close it, without changing the setting.

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

### Codex versions

wow is tested with one Codex version, which the messages below name. When the installed `codex`
reports another version, **Test** asks that `codex` to describe its app-server protocol
(`codex app-server generate-json-schema`, which needs no network and no login) and compares it
with the methods and fields wow uses. This runs once per binary and version while wow runs.

- **Compatible**: the instance is **Ready** with a note such as "codex 0.164.0 differs from the
  tested 0.166.0; compatible". If wow does without a field the other version lacks (an optional
  detail), the note names it. Threads work as usual.
- **Not compatible**: the instance shows **Error** with each method or field that is missing or
  changed, for example "turn/start result.turn.id changed from string to number".
- **Cannot tell**: a Codex too old to describe its protocol shows **Error** with that reason.

When the version is not compatible, or older than the tested one, the instance offers the tested
version:

- Installed with npm (`npm install -g @openai/codex`, on Windows the `codex.cmd` in your npm
  folder): **Update Codex to <version>**. The confirmation names the exact command, usually
  `npm install -g @openai/codex@<version>` (with `--prefix` when codex lives under another npm folder
  than the `npm` wow finds). wow runs it, shows npm's output under the instance, and tests every
  instance that uses that `codex` again. It stops the Codex app-server first and refuses while a
  turn runs. `providers.updateTimeoutMs` (10 minutes by default) limits how long npm may take.
- Installed another way (Homebrew, a downloaded binary): the instance says what to run or
  download instead, then test again.

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
- **Enter** opens the item: a card's form, a meeting's details, or a "+N" list. With the context
  panel open, the arrow keys and Enter show the item in the panel, and Enter on the card the panel
  already shows opens its form.
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
the card form for the time right before or after the meeting. With the context panel open the
details show there instead (see "The context panel"). Outlook does not give wow the attendee list,
so it is not shown.

wow reads Outlook every `outlook.pollSeconds` (60 by default), so a moved or cancelled meeting
shows up within one interval. The refresh button in the toolbar and "Refresh Outlook" in the
palette read at once.

If Outlook is not running or does not answer (a modal dialog open in Outlook blocks it), the last
items stay on screen with a banner "Outlook unavailable since <time>". **Try again** reads at once
and **What to check** lists the usual causes. The rest of the app keeps working, and the banner goes away on the next good read.

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
  With the context panel open, a click shows the card there and **Edit card** opens the dialog.
- **Delete**: "Delete card" in the form deletes it at once; **Undo** in the message that follows
  puts it back. A card whose workflow run is still going asks first whether to stop the run.
- **Save from the keyboard**: **Ctrl+Enter** (`keybindings.calendarSaveCard`) creates or saves the
  card from any field of the form. Delete, Cancel and Create card stay at the bottom of the form
  while its fields scroll, also in a small window.

A card with a workflow and a project is a **trigger**: at the card's start time the workflow's first
step starts (see "Triggers" below). Moving the card moves the trigger with it. Triggers carry a
workflow icon and their state: Scheduled, Running, Waiting for you, Done, Failed, Stopped or Missed.
Plain cards show no state. A card with a workflow but no project is drawn dashed with "No project,
will not run". The form says what a trigger will do ("Starts at 16:30 in Demo · 4 steps, 2 gates"),
warns when it will not run, and links to its run once it has one.

### Repeating cards

A card can repeat, so a workflow runs on a schedule: a daily report, a weekly review. It stays
one card; wow works out its occurrences.

- **Make one**: in the card form, **Repeat** sets how often (Daily, Weekly or Monthly), **Every**
  how many days, weeks or months, **On days** the weekdays of a weekly card (Monday to Friday for
  every weekday), and **Stops** when: never, on a last day, or after a number of times. The form
  says the rule in words ("Every weekday at 08:30, until 19 December 2026") and, once saved, when
  the card fires next. The card's date and times are its first occurrence; every later one has
  the same clock time and length in the card's zone, also across a daylight saving change. A
  monthly card on the 31st has no occurrence in a month without one. "Does not repeat" makes it a
  single card again.
- **In the calendar** every occurrence in the days shown is drawn with a repeat mark. One that
  has passed shows how it went (Done, Failed, Missed, or Skipped when the card's earlier run was
  still going) and opens its run; one still to come opens the card. When one card has more
  occurrences in the days shown than `calendar.maxOccurrences`, the first ones are drawn and a
  line above the grid says so. When the occurrences cannot be read from the server, a banner says
  so and **Try again** reads them once more.
- **Move**: drag an occurrence to another time, or its lower edge, or use Alt+Up and Alt+Down.
  That changes the time or length of the series from that day on, not of one day; the days
  before it keep their time. An occurrence stays on its day (to change the days, edit the rule),
  and one that has passed does not move.
- **Edit**: changing the title, time, workflow, project or rule changes every occurrence that has
  not started. Occurrences that have passed stay where they were, and those that ran keep their
  runs.
- **Delete**: **Delete…** in the form, or the **Delete** key (`keybindings.calendarDeleteCard`)
  on a card in the grid, asks **This occurrence** or **The whole series**. This occurrence skips
  that day only; the whole series deletes the card, and asks first whether to stop a run that is
  going. **Undo** brings back either, a series with its rule and skipped days.
- **Palette**: "Skip next occurrence: <title>" skips the day the card fires next, and "Delete
  series: <title>" opens the same choice. A single card has "Delete card: <title>", which asks
  before it deletes.

A repeating trigger starts one run per occurrence, named with its day. If the run of an earlier
occurrence is still going, the occurrence starts nothing and a notification says it was skipped.
A card whose remaining occurrences were all skipped by hand never fires again and shows Done.
After wow was closed or paused over several occurrences, only the latest follows
`scheduler.missedPolicy`; the older ones are recorded as missed.

## Chat

### Starting a thread

**Ctrl+Alt+N** or "New thread" opens a draft with the cursor in the composer. It starts with what
your last thread used: the same provider instance, model, effort, permission mode and project. The
dot before the provider says whether its last test passed. The project picker also lists folders
you used without a project, and **Another folder…** (the folder dialog in the desktop app, a path
box in the browser). The chosen folder shows under the picker; hover it for the full path. Write
the first message and press Enter; the first line becomes the thread's title. Until a project or
folder is chosen, Send stays disabled and says why.

A project can name what its new threads start with (see Projects, **Thread defaults**): its
provider instance, model, effort and mode then win over what your last thread used.

Settings → Chat → **Send key** chooses which key sends: **Enter** (Shift+Enter makes a new line) or
**Ctrl+Enter** (then Enter makes a new line).

#### A thread in its own working copy

When the chosen project's folder is a Git repository with a commit, the draft shows **Own working
copy** (also "New thread: own working copy" in the palette). It starts on or off as the project's
**Own working copy for new threads** setting says (Settings → Chat, per project; off by default).
With it on, the line under it says which branch is made and where it starts, such as "New branch
wow/ring-the-bell-3fa2c1 from main (4e1d2a0)". The thread then works in a Git worktree of the
project under the working copies folder (Settings → Working copies), on that new branch: its
turns, Changes, files and `@` are there, and your project folder, its index and its branch are
not touched. Changes you have not committed in the project folder stay there.

The copy is made just before the first message goes out. If it cannot be made (the branch name
is taken, the folder is not a repository), the turn fails with Git's reason and nothing is sent;
fix the cause and press Retry. A branch that is already in the repository is never used or
changed: rename that branch, or change the branch name setting. When Git made the branch but not the
folder, the branch stays and Retry uses it. The branch name comes from **Branch of a thread's working copy**
(`{{title}}` and `{{id}}`), and **Where a thread's working copy starts** picks the project
folder's commit (the default) or the default branch's tip.

The header shows the branch and "own working copy"; Details shows the branch, the folder (with
Copy path and Open in editor) and where it started. When you mark the thread done, wow removes the
copy if no uncommitted or ignored file is in it; commits stay on the branch. Otherwise the copy
is kept and the chip says what it holds. A commit made with no branch checked out (a detached
HEAD) is not on the branch, so it keeps the copy too. **Remove working copy** (Details or the palette) shows
what would be lost and removes only after **Remove and lose them**; it is refused while a turn
runs or while another thread that is not done (a fork) works in the same copy. wow never deletes
the branch and never pushes. Your next message makes the copy again on its branch. A fork works
in the same copy.

**Open session from Claude Code / Codex…** in the palette lists the sessions your provider
instances keep in their own files, the newest first, grouped by folder, each with its first prompt
and when it was last used. Pick one and it opens as a wow thread in that folder (and its project)
that goes on with the session: your next message resumes it. A session already open in wow opens
that thread. A session whose folder is gone is listed greyed with the reason. Nothing is written
to Claude's or Codex's files; how many sessions are listed and how much of the prompt shows are
in Settings → Providers.

### Model, effort and mode

The bar at the bottom of the composer, left of Send, reads the thread's model, effort and
permission mode, such as "Opus · High · Ask". It sits on every composer that runs turns: an open
thread, a new thread and a workflow step's thread in the side panel. Each part opens a list you
can type in to filter. While the composer has the cursor:

- **Ctrl+Shift+M** (`keybindings.composerModel`) opens the model list and **Ctrl+Shift+E**
  (`keybindings.composerEffort`) the effort list.
- **Shift+Tab** (`keybindings.composerModeCycle`) moves to the next permission mode: on Claude
  Code Ask, Accept edits, Plan only and back to Ask; on Codex Read only, Auto, Ask untrusted and
  back. Bypass permissions and Full access are never in that cycle; pick them from the list.
- **Escape** (`keybindings.composerLeave`) takes the cursor out of the composer to what comes
  before it, which is what Shift+Tab does everywhere else. In a context panel laid over the view
  (a narrow window) Escape closes the panel instead; a different key set for leaving the composer
  still leaves it there.

The mode is coloured by what it allows: Plan only blue, Accept edits (and Codex's Auto) green,
Bypass permissions and Full access red with a warning sign. A pick applies to the next turn and
the thread keeps it.

Each model in the list shows its label and, under it, the provider's description. The provider
instance's default model is marked "(default)"; when the instance has none, the model the
provider calls its own default is marked "(provider's default)". Models the provider hides are
not listed, and a model the provider says takes images carries an image icon. The effort list
holds the chosen model's levels, with the instance's default marked "(default)" and, where the
provider names one, the model's own default marked "(model's default)". Codex reports all of
these; Claude Code gives descriptions only, so its lists show no image icon and no model default.
A new thread without a last thread on its instance starts on the provider's default model and
that model's default effort.

The palette has the same choices for the thread on screen: "Model: <label>", "Effort: <level>"
and "Permission mode: <label>", with the current one marked **Current**, and "Choose model…" and
"Choose effort…", which open the bar's lists.

Below the composer, the new-thread view offers starters: a few skills (the project's own first),
open backlog items to start from, and the thread you worked in last. `chat.starterCount` sets how
many; 0 hides them.

The reply streams as it is written. Reasoning is folded; click it to read.

Every tool call is one line, drawn by what the call does:

- **A command** reads `$ <command>` in a fixed-width font, then `in <folder>` when it ran
  somewhere other than the thread's folder, and on the right how it ended and how long it took:
  "exit 1 · 4.2 s" when the provider gives the exit code (Codex does), else "failed · 0.8 s" or
  "done · 0.8 s" (Claude Code gives no exit code, so wow says whether the call failed and measures
  the time itself). Opened (click, or Enter or Space), it shows the last lines of the output
  (`chat.toolOutputLines`, 20) with **Show all N lines** for the rest and **Copy output**, which
  copies all of it.
- **A read, a search or a web call** is one line: "Read README.md lines 1-80", "Search kettle in
  src", "Fetch example.org", "Search the web for …". A path inside the thread's folder is shown
  relative to it.
- **An MCP call** reads `server › tool` with its arguments as `key: value`; opened, it lists them
  one per line, **Show JSON** shows the arguments as sent, and the output sits below.
- **An edit** (Claude Code's Edit, MultiEdit and Write, Codex's file changes) reads "Edit
  src/timer.ts +4 −1"; opened, it shows the change in colour, removed lines red and added lines
  green, with **Open file**, which opens the file in a tab of the side panel (not offered for a
  file outside the thread's folder, and not while the edit is still running or its request waits
  for your answer, nor when it was denied or failed, since the file has not changed). A new file shows as
  added lines. Before Claude Code writes a whole file (its Write), the request and the row show
  only the new content, as added lines, with "The new content only; the file's current content
  is not shown": it may replace a file that exists. Once written, the row shows the real change. A very long diff is cut at `chat.editDiffMaxLines` lines; the thread's Changes
  have all of it.
- **Any other tool**, and every call stored before this version, keep the row they had: the
  tool's name and the first text of its input; opened, its input and output.

While a call runs, its time counts up from when it started; reloading the page shows the same
time, because the server stored the start. A call its turn left running reads "not finished".
Tool calls one after another in a turn share one row. While the turn is still at it, that row
shows the latest call, how many there are ("10 tool calls") and how many failed; once something
follows or the turn ends, it says what was done, such as "Read 2 files, ran 1 command · 1 failed".
It opens to list every call. Anything else in the turn, such as text, an approval or the
Assistant's change rows and cards, starts a new row. `chat.groupToolCalls` off shows every call
on its own row.

**Subagents**: when the agent hands work to a subagent (Claude Code's Agent tool, a Codex
collab agent), the call is one row, such as "Agent: explore the auth code · 3 tool calls · 1:32".
While the subagent works, its own tool calls and notes are listed under the row, drawn like the
thread's own; once it is done the row shows its answer, and clicking the row opens the list and
the prompt again. Codex does not send a subagent's own work to wow so far, so there the row shows
the prompt, how the agent stands (starting, running, done, failed) and its final message. Agent
calls stored before this version look as they did.

When the agent keeps a task list (Claude Code's todo and task tools, Codex's plan), the latest
list of the running turn, or else of the last turn, is pinned above the composer as one line,
"3/7 · <the task in progress>". **Ctrl+T** (`keybindings.toggleTasks`, or "Show task list" /
"Hide task list" in the palette) opens it to the whole list. Each time the list changes, the
conversation gets a line "Updated tasks (3/7)" that opens to the list as it was then; the same
list sent again adds nothing. The thread's Details in the context panel has a Tasks section with
the latest list. Tasks a finished turn left open read "not finished".

**Copying**: an assistant message has **Copy** (its markdown) and **Copy text** (what it reads on
screen) under it on hover or when you tab to it; a code block has **Copy code** in its corner,
and one labelled with a path (such as ` ```ts src/timer.ts `) shows the path above it with
**Open file**, which opens the file in a side panel tab; tool output has **Copy output**. The
palette has the same commands for the message or row the keyboard was last on: "Copy message",
"Copy message text", "Copy code", "Copy output", "Open file <path>" and "Show all N lines". When nothing could be copied (the browser has no clipboard or refused it), a notice
"Nothing was copied" says so.

**Changes**: a chat thread in a Git folder shows a chip in its header, such as "+42 −7 in 5
files": what changed in its folder since its first message, committed or not. Click it, or press
**Ctrl+Shift+D** (`keybindings.threadChanges`, "Show changes" in the palette), to list the files
in a **Changes** tab of the side panel with their added and removed lines; pick one to see its
diff, and **Back to details** (or Alt+W, or Ctrl+Shift+D again) to close the tab. **This turn only** (**O**) narrows the list to files that changed
since the last turn began. Files that were already edited when the thread began and have not
changed since are left out. A folder that is not in Git, and a thread that began before this
version, say so instead of listing files.

A turn ends with its usage: input, output and cached tokens, and the cost when the provider
reports one. With `chat.contextMeter` on, the composer shows
how much of the context window the thread uses, with a Compact action for Claude.

### When the agent needs you

- **Approvals**: when the agent wants to run a command, change files or use a tool, the thread
  shows the request as what it is: a command line with the folder it runs in, an edit as its
  diff, a web address, or a tool as `server › tool` with its arguments (the provider's own JSON is
  behind **Details**), and the permission mode. Answer with **Allow once** (**A**), **Allow for
  this session** (**S**), **Always allow in this project** (**Y**) or **Deny** (**D**). The request
  takes the focus, so the keys work at once; they are in Settings → Keybindings and in the
  palette. The tool row reads "waiting for approval" meanwhile.
  - **Deny** opens a one-line note, "No, and tell it what to do instead". Enter denies with what
    you wrote, or without a note when it is empty; Escape closes it. Claude Code gets the note as
    the reason for the denial. Codex takes no reason with a denial, so wow stops its turn and sends
    the note as your next message, as Codex itself does.
  - **Always allow in this project** shows the rule it keeps, such as "Run commands starting with
    `pnpm test`" (the command's first words) or "Use the tool `github › create_issue`", and allows
    the request. From then on a request any thread of the project makes that the rule covers is
    allowed without asking, on Claude Code and Codex alike, and its row reads "Allowed by rule:
    …". A command that chains, pipes, redirects or quotes (`&&`, `;`, `|`, `>`, `"`) is never
    covered, and neither is one that hands another command to a shell or a wrapper (`bash -c`,
    `powershell -Command`, `sudo`, `env`, `FOO=1 …`, `npx`, `pnpm exec`, `node -e`,
    `python -c`, `find … -exec`); when Codex runs a command through your shell, the
    command inside it is what is shown and matched. A rule matches the case it was stored in:
    `Pnpm test` asks again even where `pnpm test` is allowed. Edits get no rule (use the Accept edits mode
    for that), and a thread without a project does not offer it. Settings → Approvals lists each
    project's rules (the project setting `approvals.alwaysAllow`) with when they were added;
    **Remove** makes the next such request ask again. The app assistant cannot add a rule without
    your yes. wow keeps the rules itself and writes nothing to Claude
    Code's or Codex's settings.
- **Plans**: in Plan only, when Claude Code is ready to leave plan mode, the thread shows a plan
  card: the plan as formatted text, **Start, accept edits** (Enter, or **1**), **Start, ask each
  time** (**2**) and **Keep planning** (**3**), which opens a note for what to change. A start
  allows the request and sets the thread's mode, which the composer bar then shows. When Claude
  Code did not send the plan with its request, the card shows its last message and says it is the
  plan as written in the conversation. The choices are in the palette as "Plan: …".
- **Questions**: when the agent asks (Claude's `AskUserQuestion`, Codex's user input request), the
  thread shows a question card: each question with its header as a small chip, its choices (the
  one the agent recommends first, marked **Recommended**) and a last choice **Other** with a text
  field for your own words. Pick a choice, type, or both; where the agent lets you pick several,
  pick as many as you like. When the agent asks several questions at once, they are on one card
  and are sent together with **Send answers**. From the keyboard: the arrow keys move, the digit
  next to a choice picks it, typing goes to **Other**, and Enter sends. **Alt+Q**
  (`keybindings.questionFocus`) puts the keyboard on the card, and the palette has "Question: pick
  …", "Question: type your own answer" and "Question: send the answer". Typing in the composer
  also answers, as **Other**. The answer continues the same turn. A question that was still open
  when its turn ended or was stopped says "Not answered" and takes no answer any more; an answered
  one keeps showing what you answered.

Either way, the thread moves to "Needs you" in the sidebar until you answer. When the thread is a
workflow step, its run says "Waiting for an answer" in the lists of runs, the run view and the context panel.

While a turn runs, the thread shows how long it has been working. You can write the next message
meanwhile: Enter queues it with the server, and the conversation shows it as "Queued · sent when
the turn ends". A second message joins it. It stays queued when you switch threads or restart
wow, and the server sends it when the turn ends. **Edit** puts it back in the composer and
**Cancel** takes it off; both are in the palette too ("Edit queued message" only while the
thread's composer can take text). On Claude Code the message goes into the
running turn at once, as in Claude Code itself, and shows as "Sent during the turn". What you type
and have not sent stays with its thread: switch threads or restart wow and it is still there. A
failed turn shows **Retry** (sends your last
message again; in a workflow step's thread it sends the last message exactly as it went, the
step's skills and their texts included) and **Resume** (sends `chat.resumePrompt`) in the error row.

When Claude starts work in the background (a background agent or command), each piece of work is
a chip under the conversation with how long it has been running, such as "pnpm dev 2:05". A chip
opens to the latest output Claude reported for it (a subagent's progress line; Claude Code does
not hand wow a command's output after it went to the background) and has **Stop**. The palette
has "Show background task: …" and "Stop background task: …" for each. **Ctrl+B**
(`keybindings.toBackground`, "Send to the background" in the palette) sends the running command
or subagent of the turn to the background, as in Claude Code, and the turn goes on; on Windows
and Linux the key is also Toggle sidebar, which it does whenever nothing can go to the
background. A command that still waits for your approval cannot go to the background; answer it
first. When Claude refuses a Stop or a Ctrl+B, the conversation says so and why. Codex has no
background work, so its threads show no chips and Ctrl+B does nothing there. When Claude ends its turn to wait for background work, the line reads "Waiting for
background work". When that work ends,
Claude goes on by itself: the new turn appears in the thread as it runs, without a message from
you, its usage is counted, **Stop** stops it, and the thread is marked as after any turn. Should
the server stop while Claude waits, the waiting line goes away; only a workflow step that waited
for a background agent shows a failed turn (send a message to go on).

### Images in a message

Paste an image into the composer (**Ctrl+V**, a screenshot for example) or drop an image file on
it, and it shows as a small picture above the text; "Add an image to the message…" in the palette
picks a file instead. Click a picture, or press Enter on it, to see it full size. **Backspace** at
the start of the text takes the last picture off, the left arrow steps onto the pictures, and
Delete takes the one you are on off; the palette has "Remove <image> from the message" too. The
message goes with its pictures, and your message in the thread shows them; Retry sends them
again.

Only PNG, JPEG, GIF and WebP images up to `chat.imageMaxBytes` (5 MB to start with) are taken.
Anything else, and an image for a Codex model that says it takes no images, is refused with the
reason and not added. Claude Code does not say which of its models take images, so wow sends them
and shows Claude's own refusal, if any, as the turn's error. wow keeps the pictures in its own
folder (`~/.wow/images`, one folder per thread) and sends them only to the thread's provider. The
Assistant and a workflow step's thread take no images. A message with pictures written while a turn runs waits for the turn's
end, also on Claude Code.

### Skills

Type `/` at the start of a message or after a space to list skills with their descriptions,
grouped by where they come from (Yours, wow, Project, User, Plugins, Other), each with a mark for
its group and the source on the right. Keep typing to filter, move with the arrow keys, and press
Enter or Tab (or click) to pick one; Escape closes the list. The palette's "Pick a skill for the
message" opens the same list. The character is the setting `chat.skillTrigger` (`/` by default);
set it to `$` if you prefer the old key. In a thread, the list starts with "Commands": `/model`,
`/effort`, `/plan`, `/compact`, `/clear`, `/done`, `/stop` and the others that apply to the
thread, each running the palette command of that name. `/clear` starts a new thread with the same
provider, model, effort, mode and folder. Below them come Claude Code's own commands; picking one
puts `/name` in the message, sent as typed. A folder's list is kept for 30 seconds (Settings →
Providers, "Command list kept for"), so a command added meanwhile shows after that. Codex reports
none. A slash anywhere else (a path such as `src/app`, a date
such as `2026/11/12`) or in pasted text opens nothing.

A picked skill becomes a chip in front of the text: its name with the mark of its group. Backspace
at the start of the text removes the last chip whole, the left arrow steps onto the chips and the
right arrow back into the text, and Backspace or Delete on a chip (or its cross, or the palette's
"Remove skill <name> from the message") removes it. A message can be only chips. The starters
under a new thread's composer add their skill as a chip too.

When you send, wow sends each skill the way it works on the thread's provider: the text of a wow
skill (Yours or wow), and `/name` for Claude or `$name` for Codex for a skill from a folder. The
message in the thread shows the same chips above your text; click one to read the text that was
sent (or the invocation), and, on a step's prompt, why wow attached a built-in skill. Messages
sent before chips existed show their text as it was, `$name` included. The Assistant's composer
takes no skills.

### How answers look

Agent answers show the way they were written: headings, lists inside lists, tables, links, inline
code and highlighted code blocks. While a turn streams, the text is shown as markdown as it grows;
a table or a diagram that is not finished yet shows as plain text until it is. HTML written in a
message shows as text and never runs. Links open in your browser, and only for `http`, `https` and
`mailto` addresses; any other link shows as plain text.

A fenced `mermaid` block is drawn as a diagram. Its **Source** button (or "Toggle diagram source"
in the palette, for every diagram on screen) shows the text it was drawn from. A diagram that
cannot be drawn shows its source as code with a one-line reason, such as "Diagram not drawn:
Image shapes are not drawn": wow does not draw anything that would load from another address.

Backlog item bodies and the publish preview use the same rendering.

### Managing threads

The sidebar groups threads under **Needs you**, **Working**, **Idle** and **Done**, with pinned
threads first (pin from the thread header). Each row's second line says the project and when the
thread was last active. A thread whose turn failed sits under Idle with a marker. A thread started
by a workflow is titled by its step, with the workflow on the second line.

The thread header shows the project (hover it for the folder) and the provider instance; the
model, effort and mode are in the composer bar. When a workflow run waits at a gate after the thread's step,
the thread shows the gate with **Approve** (**Ctrl+Enter**), **Send back** (**Ctrl+Shift+Enter**)
and **Stop**, the same as the run view.

**Finding threads**: **Ctrl+Shift+F**, or **/** while the list has the keyboard, puts the cursor
in the filter above the list. It matches a thread's title, its project's name and words said in
its messages (messages only for a text up to `chat.threadSearchMaxLength`, 500 characters). When threads sit in more than one project, a chip per project narrows the list (also
"Show threads of <project>" and "Show threads of all projects" in the palette); when the chips go
away, so does the narrowing. The arrow keys move between rows and Enter opens one; Enter in the
filter opens the first.

**Rename, archive, unread**: **F2** or "Rename thread" edits the title in the header; the list
and the palette follow. A title can have up to `chat.threadTitleMaxLength` (200) characters. "Archive thread" hides a thread from the list; the filter and the palette
still find it once you type, marked "Archived", and "Unarchive thread" brings it back. A workflow
step's thread belongs to its run and is not archived on its own. An archived thread comes back to
the list by itself when a turn starts in it (you send a message, or the agent goes on after
background work) or when it asks for an approval or a question. A thread whose turn ended or that
needs you while you were not looking at it is bold with a dot until you open it; "Mark unread"
makes it bold again and goes back to the list, and **Alt+Shift+Down** (or "Next unread thread")
opens the next bold one.

**Notifications**: when a chat thread you are not looking at asks for an approval or a question,
wow tells you "Needs you: <thread>" with what it asks; clicking opens the thread, and in the
desktop app an approval's notification has **Allow once** and **Deny**. A turn that ran longer
than `chat.finishedAfterSeconds` (30) tells you "Finished: <thread>" when it ends. Choose in
`chat.notifications`: needs you and finished (the default), needs you only, or off. Nothing shows
for the thread on screen in a focused window, or for a turn you stopped yourself.

**Mark thread done** in the thread header (or in the palette) moves a thread you have finished
with to **Done**. It is available while the agent neither works nor waits for you. **Reopen
thread** puts it back under Idle (a thread whose last turn failed keeps its marker), and sending a
new message to a done thread reopens it as well. A workflow step's thread moves to Done by itself
when its step completes; with a gate after the step, that happens once you press Approve.

Change model, effort or permission mode in the composer bar; the next turn uses them. **Ctrl+.**
or the stop button interrupts a running turn and keeps what it produced; the turn ends with
"Stopped by you · <time>", which carries **Resume** on the last turn. After a restart, a thread
continues its provider session; **Resume** sends `chat.resumePrompt` to pick up where it stopped.

### Reading a long thread

- **What changed**: after you change the model, effort or mode, the next message starts with one
  line such as "Model: Opus → Sonnet · Mode: Accept edits", and each turn's usage row names the
  model it ran on.
- **What runs now**: while a turn runs, the line under the conversation reads "Running pnpm test ·
  0:42 · 6 tool calls · Ctrl+. to stop". Codex adds the tokens so far (↑12k ↓1.3k); Claude Code
  reports them only when the turn ends.
- **Compaction**: when Claude Code compacts the conversation (with `/compact` or by itself) a line
  says "Conversation compacted (auto) · 152k → 18k". From `chat.contextWarnPercent` (70 %) the
  context meter turns amber and offers **Compact now**. Codex has no compact action, so it shows
  no Compact.
- **Reasoning** reads "Thinking…" with its last line while it streams and "Thought for 12 s"
  after. **Ctrl+O** opens or closes all reasoning in the thread; `chat.reasoningOpen` opens it by
  default.
- **Times**: each message shows when its turn started, each answer when its turn ended.
- **Moving around**: scrolled up while output arrives, a **New output** pill shows; it or **End**
  goes back down and follows again. End works from the message box too once the cursor is at the
  end of what you typed (before that, it moves the cursor there). **Alt+Up** and **Alt+Down** move from message to message, and
  **C** copies the message that has the keyboard. All these keys are settings under Keybindings,
  for example if Alt+Up clashes with your screen reader.
- **Next that needs you**: **Ctrl+Shift+J** goes to the oldest approval, question, plan, gate or
  assistant proposal that waits for you, wherever it is, and puts the keyboard on it; press it
  again for the next one. Oldest means the one that has waited longest: renaming a thread or
  changing its model does not move it. A gate that waits for the pull request's checks is not
  waiting for you and is skipped.
- **Edit your last message**: press **Up** in an empty message box, **E** on your last message, or
  its **Edit** button. The message comes back into the box; send it and it replaces that message
  and its answer, and the agent goes on as if the old one had never been sent. The old exchange
  stays under **Earlier version** on the new message. Above the box you pick **Conversation
  only** (files stay as they are) or **Conversation and files** (the files go back to how they
  were before that message, after the same confirm as Restore; if they cannot, nothing is sent
  and the error says why). `chat.editRestoresFiles` picks which one comes first. **Cancel**
  leaves it.
- **Restore files to here**: on one of your messages (its button, **R** on the message that has
  the keyboard, or the palette) puts the thread's folder back to how it was when that message was
  sent: changed files get their content back, new files are deleted, deleted files come back.
  The conversation stays as it is, so this works on Codex too. A confirm lists what is written
  back and deleted, and first the files that changed outside the thread since its last turn (by
  you, an editor or another program); the button then reads **Restore anyway**. **Enter**
  confirms, **Escape** cancels. Afterwards a line such as "Files restored to before "Make the
  bell ring twice" · 4 written · 1 deleted" offers **Undo** until the next message or the next
  restore. A restore never touches commits, branches, the staged changes or ignored files (such
  as `.env` or build output); commits made since stay, and the restored files show as changes
  in the Changes view. wow keeps these snapshots of the files in its own folder
  (`snapshots/`), never in your repository, for `chat.snapshotKeepDays` days; a file larger than
  `chat.snapshotMaxFileBytes` is not kept and the confirm names it. A file the restore would
  delete but that the thread did not leave there (for example one Git lists only since you
  edited `.gitignore`), and a file now larger than `chat.snapshotMaxFileBytes` (wow holds no copy,
  so Undo could not bring it back), are left alone and the confirm names them under "Left alone".
  It is not offered for a
  folder outside Git, a step's thread, messages sent before this version, or while a turn runs,
  and it says why when it cannot (a folder reached through a link, too many files).
- **Fork from here**: on any of your messages, **Fork from here** (or **F** on the message that
  has the keyboard, or **/fork**) starts a new thread with the conversation up to that message
  and its answer, on the same model, effort, mode and folder, images included. The new thread says which one it
  came from. Edit and Fork work on Claude Code, for messages sent since wow keeps the place in
  the conversation; Codex cannot go back in its conversation, so it offers neither and the
  palette says why. If Claude Code cannot pick the conversation up where wow went back to (its
  own files were cleaned up, say), every message there fails the same way; the error then offers
  **Go on without going back** (the agent goes on with the whole conversation it has, the replaced
  exchange included) or, in a fork, **Start a new conversation**. Both are in the palette too.
- **Find**: **Ctrl+F** opens a find bar above the conversation, from anywhere in the thread, the
  message box included; pressed again it selects what you typed. It finds text as the
  conversation shows it, case ignored: messages as rendered (`**bold**` is found as "bold"),
  reasoning, each tool row's line and its whole output, an edit's diff, the cards, error and
  divider lines, task lists and a subagent's work. It does not search the JSON behind Show JSON
  or Details, earlier versions of an edited message, or the message box. The bar reads "3 of 12",
  "No matches", or "1000+" once there are more than `chat.findMaxMatches`. **Enter** or **F3**
  goes to the next match and **Shift+Enter** or **Shift+F3** to the one before, wrapping at the
  ends. A match inside a closed row, group of tool calls, reasoning, subagent or the earlier lines
  of an output opens it, and it stays open after the bar closes. While a turn streams the count
  follows it and the current match stays where it was. **Escape** closes the bar and puts the
  keyboard back where it was. Find is in the chat view only, not in the Assistant view or a step's
  thread in the side panel.
- **Copy or save the conversation**: **Copy conversation as Markdown** and **Save conversation…**
  (the palette, and the **⋯** menu in the thread's header) give the thread as Markdown: its
  title, a line with the provider, model, project, folder and branch, the time, then "You · 20:41"
  and "Claude Code · 20:42" headings with each message as written and one line per tool call,
  approval, question, error and task update, such as "$ pnpm test · exit 1 · 4.2 s" or "Denied:
  $ rm -rf build · note: keep the build". Tool output and input are left out, and so is reasoning
  unless `chat.exportReasoning` is on. The desktop app saves through the system's save dialog,
  named after the thread's title; the browser build downloads the file.
- **Session tools**: the side panel's **Tools** tab (Details → **Show session tools**, the palette
  **Show session tools**, or the header chip such as "1 MCP server failed") lists what the
  provider reported for the thread's session: the MCP servers with their state (Connected,
  Failed, Needs sign-in, Connecting, Turned off), a failed server's error, where it is configured,
  its version and address and its tools (marked read-only or destructive), the built-in tools,
  skills, commands, subagents and plugins, each with a count. The filter narrows all of them. The
  list is what Claude Code said as the last turn started; **Refresh** asks the open session again
  and is offered only while it is open. wow never starts Claude Code or a server to fill the tab,
  signs in or turns servers on or off: for a server that needs sign-in, run `/mcp` in Claude Code
  in a terminal. No environment value, header, argument or address path is shown or kept. Codex
  reports no such list, so a Codex thread shows the instruction files it loaded and the MCP
  servers its own tool calls used. A thread from before this version shows the tab empty until
  its next turn; the Assistant has no Tools tab.
- **Skills in chat** are listed Yours, Project, Recently used, User, Plugins and wow last; wow's
  own four are marked "for workflow steps". On a new thread the list opens under the box, so the
  provider and project pickers stay in view.

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

- a skill from the list (Refresh skills re-reads the skill folders); each choice says its group:
  Yours, wow, Project, User or Plugins,
- **Also follow**: more skills the step's agent follows after its own skill, in the order listed
  (see "Skills of a step" below),
- a provider instance, model, effort and permission mode,
- an optional extra prompt,
- optional expected artifacts: paths or globs, one per line, such as `intents/*/spec.md`. With a
  project chosen to run in, the help line says how many files match there now.

The model and effort lists are what the step's provider instance offers, read from the installed
provider; the instance's default model and effort are marked "(default)". Codex needs a model on
every step. A Codex step without one takes the instance's default model; when the instance has
none, the step says so in words ("Step check-work runs on Codex (…), which needs a model on every
step …"), and wow refuses to save it until you pick one. A workflow saved before wow had this
rule still loads and runs as it did; its builder marks such a step ("was saved without a model
…"), Save stores the model shown, and the assistant's "Why does this not work" names it. A setup
file with such a step is applied with the step marked. Claude Code steps may leave the model to
Claude Code, as before.

Between steps (and before the first and after the last) the builder shows where the run waits:
**Waits for you** marks a gate; **Add a gate** adds one there. Reorder steps by dragging the handle
or with the move buttons. **Create workflow** stays disabled, with the reason in its tooltip, until
the workflow has a name and a step.

Templates are offered only for a new workflow. An existing one says which template it was based on;
**Replace steps with template…** swaps its steps after you confirm, and nothing changes until you
save. **Save as template…** stores the steps' skills, gates, expected artifacts and rules as a
template under the name you give (a template with that name is replaced), so new workflows can
start from it; Settings → Workflows still has the full template list. **Delete** removes the workflow at once
and offers **Undo**. The templates (editable in
`workflows.templates`):

- **Bug**: deliver-work → check-work
- **Feature**: capture-intent (gate after) → plan-work (gate after) → deliver-work → check-work
- **Initiative**: capture-intent (gate after) → plan-work (gate after) → shape-work (gate after) →
  deliver-work → check-work

In all three, check-work has the rule "when the verdict is changes requested, go to deliver-work"
(see "Rules, the limit and the path" below). Templates you changed yourself are left as they are;
add the rule in Settings → Workflows or in a workflow's builder if you want it.

Skills come from the folders in `skills.directories` (`~/.claude/skills`, `~/.codex/skills` and
each project's `.claude/skills` and `.agents/skills` by default) and, with
`skills.includeClaudePlugins`, from installed Claude plugins. Skills marked
`disable-model-invocation: true` are offered too, because wow invokes them explicitly. A
project's skill folder that does not exist yet is not watched, so the first skill you write into it
by hand is listed after the next agent turn ends or when you press **Refresh skills**.

### Skills of a step

Settings → Skills has **Your skills**: skills you write in wow. **New skill** asks for a name (lower
case letters, digits and hyphens, not starting with `wow-`), when to use it, and the text the agent
is told. **Edit** changes the description and the text; **Delete** removes the skill at once. Each
of the three offers **Undo**. A name that is not allowed or already taken is refused with the
reason, and nothing is saved. wow keeps each skill as a `SKILL.md` file under its home folder
(`~/.wow/skills/<name>/SKILL.md`); a file you put there by hand is listed after **Refresh skills**.
Editing such a file changes only its name, description and text and keeps every other line of its
frontmatter, and **Undo** of an edit or a delete puts the file back exactly as it was. When two
folders name a skill the same, both are listed with their folder beside the name, and wow sends,
runs, edits and deletes neither until you rename one in its `SKILL.md`; it says which folders.
Your skills come first in every skill list. The palette has **New skill**, and **Edit skill** and
**Delete skill** for each of yours.

Below them are the skills wow ships: `wow-verdict` (end with exactly one verdict line),
`wow-artifacts` (write each expected artifact where the step expects it), `wow-pull-request` (put
the `Intent-Unit` line in the pull request) and `wow-handover` (end with what was done, what is left
and what the next step needs). They are read-only; **Show the text** shows what they say, and the
parts in braces are filled in from your settings and the run when they are sent. List one in
`skills.builtInOff` to switch it off.

A wow skill (yours or built in) is sent to the agent as its text, the same way on Claude Code and on
Codex. A skill from a folder is invoked as before (`/name` or `$name`).

In the builder, **Also follow** under a step's skill adds any other skill, from every group, as a
chip; the cross on a chip removes it. Below it, **Attached automatically** lists the built-in skills
wow gives the step by itself and why: `wow-verdict` when the gate after the step or one of its
rules reads the verdict, `wow-artifacts` when the step expects artifacts, and `wow-pull-request`
when a plan run delivers a unit with the workflow. **Leave out** keeps one away from that step
(**Attach again** undoes it). `workflows.attachBuiltInSkills` turns automatic attaching off. The
palette has the same actions for the step you are editing: "Also follow <skill> in step N", "Stop
following <skill> in step N" and "Leave <skill> out of step N".

### Running one

Open a workflow, pick the project next to **Run now** and press it (save changes first), or put it
on a card. The run view's header names the workflow, the project and when the run started, and
links to its card and backlog item. Each step shows not started, running, done or failed, how
long it took, a link to its thread and links to the expected artifacts that exist in the project.

When a run reaches a gate it waits: the run, its card and the step's thread show "waiting for
you", the step reads Done followed by a "Waiting for you" marker, and a desktop notification is
sent (`scheduler.notifications`). The gate shows what to review: the step's last message (folded)
and the artifacts it produced. In a wide window the side panel opens with the step's conversation
and the gate, and the run view's tabs (**Changes**, **Artifacts**, **Pull request**, **Ticket**,
**Pages**) show what to look at; a tab with nothing to show says so. Press **Approve**
(**Ctrl+Enter**, `keybindings.gateApprove`) in the panel, the run view or the step's thread to
start the next step. Press **Send back** (**Ctrl+Shift+Enter**, `keybindings.gateSendBack`) to
write what is wrong; **Send it back** (or the same key again) runs the step again in the same
thread with your note (`workflows.sendBackTemplate`; a template without `{{note}}` gets your note
after its text), the step shows "Attempt 2", and the run waits at the same gate with the new
result. A note is needed. A note you leave unsent belongs to that gate and is not offered at the
next one. A message you type in the thread
instead is a side conversation and leaves the run waiting. **Stop** ends the run; Stop asks
first, because a stopped run cannot be continued. The next step's prompt is its skill invocation, its extra prompt, and the handover from
`workflows.handoverTemplate` (by default the previous step's final message and the expected
artifact paths). Stopping a run keeps all its threads.

A step whose turn ends while a background agent of Claude's still runs is not done yet: it ends
with the turn Claude starts by itself once that agent ends, and that turn's last message is the
step's. A step does not wait for a background command such as a dev server or a watcher, which may
never end. If the agent ends and Claude does not go on, or Claude's session is closed, the step
ends with its last turn. When
the background work ends before Claude ends its turn, wow cannot tell that Claude will go on, and
the step ends with the first turn.

### Reviewing at a gate

When a run waits at a gate, its run view shows the gate bar (**Approve**, **Send back**, **Stop**)
at its top, whatever the side panel shows, and the review tabs under it; the side panel shows the
step's conversation with a copy of the gate bar. The note of **Send back** is written in the run
view's bar. In a window narrower than 1200 px the side panel lies over the view when you open it;
the gate bar then ends where the panel begins and puts its buttons under its text, so they stay
in reach. Over a run the panel's edge stops where the gate bar's room begins, and the width you
drag to there is the width kept; in a very small window the panel stays at its narrowest and the
gate bar takes what is left beside it. Each tab is also in the palette ("Run: show changes" and so on) and in the address, so
a reload shows the same tab. Workflows → **Runs** lists every run, the ones waiting for you
first, then the running ones ("Go to runs" in the palette).

- **Changes** (**Ctrl+Shift+D**, `keybindings.runChanges`; the same key goes back to Steps) lists
  every file added, changed, renamed or deleted since the run started, committed or not, including
  new files Git does not ignore, each with its added and removed lines. Pick a file for its diff
  on the right; drag the edge between the list and the diff (or focus it and use the arrow keys)
  to make the list wider (`appearance.changesListWidth`). Focus a line of the diff and press **C**
  (`keybindings.diffComment`), or click beside its line number, to write a comment on it; Enter
  adds `src/bell.ts:12 – your words` to the send-back note (`src/bell.ts:12 (removed) – your words`
  for a removed line, whose number is the one it had before), and **Ctrl+Shift+Enter** sends the note
  back. In a chat thread's Changes the same comment goes into the thread's composer as a reply.
  **Shift+Enter** (`keybindings.openInEditor`) on a changed file, a diff line, an artifact, a file
  link in chat or in the file viewer opens the file in your editor at its line; the command is the
  `viewer.editorCommand` setting (by default `code --goto {path}:{line}`, run by the wow server,
  not through a shell unless `viewer.editorShell` is on; in a shell line write `{path}` without
  quotes, since wow quotes it). A file the step under review changed
  carries a small mark ("This step changed it" on hover); **This step only** (**O**,
  `keybindings.changesStepOnly`) narrows the list to those. When the first step starts, wow
  records the commit the folder was on (the run's base); everything is compared with it. A binary
  file, or one larger than `diff.maxFileBytes`, shows its status and size without lines; past
  `diff.maxFiles` files the tab says how many it left out. When the folder is not a Git
  repository or Git is not installed, the tab says so and the rest of the review works.
- **Artifacts** lists the files the step produced. Opening one shows it in the side panel (see
  "Files in the side panel").
- **Pull request**, **Ticket** and **Pages** show what the hosts say about the run (see "Reading
  from the hosts" under Plans): the pull request on the run's branch with its state, checks, the
  failing check names and review comments; the Jira ticket with key, summary, status, assignee,
  type and description; and the Confluence pages the ticket, the pull request or the intent link
  to. Each has a "Last fetched" line, **Refresh now** and **Open on host**. A tab with nothing to
  show says why. A page larger than `hosts.pageMaxBytes` (1,000,000 bytes by default) is not kept:
  its line says so and points to that setting. A page Confluence no longer shows (deleted, moved
  or restricted) says to check the link.

### Files in the side panel

Opening an artifact, a changed file or a page shows it in the side panel next to the conversation,
while the main view stays where it is. The panel's header has the path, **Back to conversation**
(also Escape and the palette) and **Copy path**. "Open artifact: <path>" in the palette opens one
too.

- Markdown is rendered like a chat answer.
- A picture is fitted to the panel; **Full size** and **Fit to panel** switch.
- An HTML file shows as a page in a frame that cannot reach the app, the network or the disk.
  Pictures and styles beside the file therefore do not load. Its scripts run only while
  `viewer.htmlScripts` is on (off by default); scripts in attributes such as `onclick` never run.
- Any other text shows as code, colored up to `viewer.highlightMaxBytes` and plain beyond.

wow reads only files inside the run's folder and the project folder. A path outside them, a missing
file, a binary file that is not a picture, or a file larger than `viewer.maxFileBytes` is not read,
and the panel says why.

Each file or page opens in a **tab** of the panel. The first tab is the panel's own: in a run
view the step's **Conversation**, in a chat **Details**. Opening a file that is already open selects
its tab. With the focus in the panel, Alt+W closes the tab, Ctrl+Tab and Ctrl+Shift+Tab move
between tabs and Alt+Left goes back to the tab shown before (the "Panel" keys in Settings →
Keybindings, and "Close panel tab", "Next panel tab", "Previous panel tab" and "Back to the panel
tab shown before" in the palette). A thread or run keeps its tabs while you look at another one.
Escape closes the file you opened from the main view, also while the focus is still on its link.

In a chat, a path in an answer (`src/timer.ts` as code, or a link such as `[spec](docs/spec.md)`)
opens the file in a tab, and so does **Open** on a tool row that read or changed a file. A line
number or a heading after the path (`src/timer.ts:42`, `docs/spec.md#rules`) opens the file
itself. Paths are read from the thread's folder and its project's folder; anything outside is refused with the
reason. **Open file…** (Ctrl+P) lists the folder's files (what Git tracks plus untracked files it
does not ignore, or the folder's files outside Git, at most `viewer.fileListLimit`), shows the
best `viewer.fileMatchesShown` matches as you type, and opens the pick. Typing `@` at the start of
a word in the composer (`chat.fileTrigger`) opens the same list; a pick becomes a chip, and the
message names the file as `@path` for the agent. A pasted `@` opens nothing.

### Pull requests, issues and tickets in chat

A link in a chat to a pull or merge request, an issue, a Jira issue or a Confluence page on a host
you stored a token for in Settings → Trackers shows as a chip with the host's icon and the item's
key. In a project's thread, `DEMO-42` (the project's Jira key), `#14` and, on GitLab, `!7` are
chips too, except inside inline code (where only a Jira key or an address is a chip) and a `#`
number that reads as a colour, such as `#333` or `#102030`. Press Enter on a chip, or click it, to open the item in a side panel tab: the pull
request with its checks and review comments, the issue or ticket with its description, or the
page. Shift+Enter or Shift+click opens it in your browser instead.

wow reads the item once when its tab first opens and again only when you press Refresh now; it
never checks it on a timer. What it read is kept, so the chip shows its state ("PR #14 · Draft ·
2 checks failed") after a restart, and the tab says when it was fetched. If the host refuses or
fails, the tab shows its reason and keeps what it read before; when even the first read failed,
opening the tab again asks the host again. Links to hosts without a token
stay plain links. Nothing read from a host is sent to the agent.

"Open issue, PR or ticket…" in the palette takes a web address or a key. A link you paste into
the composer shows its chip above the text with "Open in panel". The thread's Details tab lists
under "Mentioned" every file and host item its messages name.

### Working copies

Turn on **Own working copy** in a workflow's builder (or "Own working copy" in the palette) and
each run gets its own Git working copy of the project, so your project folder is left alone. When
the run starts, wow fetches the project's remote (`workspaces.fetchBeforeCreate`, per project) and
creates the copy at the tip of the default branch, on no branch, under `workspaces.root` (a full
path, or a folder name inside the wow folder; `workspaces` by default). Every step works there;
the agent names and creates its own branch when it delivers. When the fetch fails, the copy starts
from the local tip and the run says so. Fetching, creating or removing a copy may take
`workspaces.gitTimeoutMs`.

When the run ends and everything in the copy is committed and reachable from a branch on the
remote, the copy is removed. Otherwise it is kept, and the run header lists what is unpushed
(uncommitted files, files the repository ignores, commits not on the remote). **Remove working copy** (also in the palette)
removes it after you confirm. If a copy cannot be created (the project is not a Git repository,
the disk is full, the path is too long), the run fails before its first step with the reason, and
nothing runs in the project folder instead. A short `workspaces.root` helps with Windows path
length.

### Gates that pass by themselves

A gate after a step can pass without you. Open the step in the builder; under the gate,
**Pass by itself when** has three checkboxes:

- **The final message ends with the approved verdict**: its last non-empty line is
  `workflows.verdictApprovedLine` (`APPROVED` by default), which is how check-work ends.
- **Every check of the run's pull request is successful**: read from the host for the commit the
  step left. While checks still run, the run says "Waiting for checks" and decides when polling
  shows them finished; after `workflows.gateChecksTimeoutMinutes` it waits for you instead.
- **Every expected artifact was found**: every path or glob the step expects exists.

When every chosen part holds, the next step starts and the step shows "passed by itself" with the
parts that held; wow never merges anything. When one does not, the run waits for you as usual and
the gate bar says which part failed. Steps whose skill is in `workflows.alwaysStopSkills`
(capture-intent, plan-work, design-work and shape-work, which cannot be removed) always wait for
you: the builder does not offer the checkboxes for them and the server refuses a condition there.

### Rules, the limit and the path

Without rules a run goes through its steps in order. A rule on a step sends the run somewhere
else depending on how the step went. In the builder, open a step and look under **After this
step**: **Add rule** (**Alt+R**, `keybindings.ruleAdd`) adds a row "When _fact_ is _value_, go to
_step or End_". The facts are:

- **the verdict**: the last line of the step's final message. `APPROVED`, `CHANGES_REQUESTED` and
  `BLOCKED` are read as approved, changes requested and blocked (the lines are the settings
  `workflows.verdictApprovedLine`, `workflows.verdictChangesRequestedLine` and
  `workflows.verdictBlockedLine`); anything else is "not given".
- **checks**: successful or failed, read from the run's pull request for the commit the step
  left. While they run, the run waits for them.
- **artifacts**: found or missing, for a step with expected artifacts.
- **the step failed**: without such a rule a failed step fails the run.

The rules are tried from the top and the first one that holds decides; move a rule with
**Alt+Up** and **Alt+Down** (`keybindings.ruleMoveUp`, `keybindings.ruleMoveDown`) or its buttons.
"Otherwise: the next step" is always last. The **Paths** diagram beside the steps draws every
path a run can take. A rule that cannot be followed (its step is gone, artifacts on a step that
expects none, the same condition twice) is marked, and the workflow is not saved until it is
fixed. wow chooses from these facts itself; no model is asked where to go.

A rule is followed after the step's gate has passed. Going to an earlier step runs it again in
its own thread, as the next attempt, with a message that says which step sent the work back, why,
and what that step wrote (`workflows.goBackTemplate`). The steps after it run again too, each in
its own thread. Going to a later step leaves the steps in between "Skipped" for that pass. Steps
whose skill is in `workflows.alwaysStopSkills` still always wait for you. When a rule sends the
run back to a step while you are talking with that step's thread, the step's new attempt waits
for the answer to your message and then starts in the same thread.

**The limit.** A step starts at most three times in a run (`workflows.maxStepVisits`, per
project). When a rule or the order of the steps would start it once more, the run waits for you
before that step: the gate says, for example, "deliver-work has run 3 times: the limit", and the
step's row says the same. **Run once more** (**Ctrl+Enter**, `keybindings.gateApprove`) lets the
step start one more time; **Stop** (`keybindings.stopRun`) ends the run. The next step that has
reached the limit asks again, so a loop never goes on without you.

**The path.** A step has one row under **Steps** however often it ran; the row shows "Attempt 2"
and so on. The **Path** tab (**Ctrl+Shift+Y**, `keybindings.runPath`; the same key goes back to
Steps) lists every time a step started, in the order it happened: the step, the attempt, how it
ended, and why the run went where it went next, for example "verdict changes requested →
deliver-work", "verdict approved: no rule held → next step" or "limit reached, waited for you".
**Open thread** on a row opens the step's conversation, which holds all its attempts. In the
**Changes** tab, **This step only** marks what the latest attempt of the step changed.

A plan run counts a unit's run as one run, however many times its steps repeat.

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

### Event triggers

An event trigger starts a run when something happens to a pull request wow follows (one of a
followed plan, or one of a live run). Workflows → **Triggers** ("Go to event triggers" in the
palette) lists them per project, each with an on and off switch and Delete. **New trigger** ("New event
trigger" in the palette) asks for the project, the event and the workflow:

- **Pull request merged** (**Merge request merged** for a project on GitLab),
- **Checks failed**,
- **Review comment added**.

When polling first sees the event, one run of the workflow starts with the pull request's link,
number, branch and the event in its handover, in the pull request's working copy when one exists
and otherwise in a new working copy at the pull request's head commit, on its branch when this
repository's branch is at that commit (a fork's pull request whose branch is named like one here
gets its own commit, on no branch). A merged pull request's run starts at the tip of the default
branch, which holds the merged code, unless its branch here is still at the head commit; it is
never left on the code from before the merge. A pull request or merge request from a fork starts
nothing: a run would work on the fork's files, and they would steer an agent on this computer. A
failed notification "Trigger started nothing" says so. Turn on
`triggers.forkPullRequests` ("Start runs for pull requests from forks", globally or for one
project) only for forks you trust. The same event seen again starts nothing, and
what was already true when you created the trigger or followed the plan starts nothing either;
only later changes do. For a review comment the run gets the comment's link and author, never its
text: the agent reads it with its own tools. Comments by accounts in
`triggers.ignoredCommentAuthors` (for example the account your agents write as) start nothing.
`triggers.eventsEnabled` off, or a paused scheduler, holds every event trigger; events seen
meanwhile are not started later. A run that cannot start leaves a failed notification.

## Plans

The **Plans** view (**Ctrl+4**, `keybindings.goPlans`) reads the intent, spec and plan files of
your projects, the format agent-os writes. Each project's `plans.intentsDirectory` (`intents` by
default) holds one folder per intent with `intent.md`, `spec.md` and `plan.md`. wow only reads
these files, and reads them again when they change (once a file has stayed the same for
`plans.writeSettleMs`). A project whose intents folder does not exist yet is not watched, so its
folder can still be renamed or removed on Windows (one with an intents folder is watched, and
Windows may then refuse; see "Troubleshooting"); wow looks for the folder again when you open
Plans or press **Refresh now**, when a project changes and after each agent turn or run step.

On the left are the projects and their intents with title, status and revision, which files exist,
and a "stale" mark on a spec or plan whose `built_on` revision is older than its source. Pick one
to see its units on the right: key, title, dependencies, the `blocked:` note and, for a plan with
`source: files`, the unit's contract (Outcome, Boundaries and the rest). A plan with
`source: issues` shows key and title only. A plan that cannot be read shows the problem and its
line, and the other intents still show. The palette finds every intent by its title and each unit
of the open plan as "Unit <key>: <title>".

Press Enter on `intent.md`, `spec.md` or `plan.md` (or click it) to read it, rendered, in the side
panel. **Start a thread for this unit** on a unit opens a new chat thread in the project with the
unit's contract as its first message; nothing is sent until you send it. The palette has "Plan:
open spec.md" and the like, and "Start a thread for <key>: <title>".

### Unit status

Turn **Follow** on for a plan ("Plan: follow" in the palette) and wow reads its pull requests from the project's host (see
"Reading from the hosts"). Each unit then shows:

- **Delivered**: a merged pull request carries `Intent-Unit: <intent-id>/<unit-key>`,
- **Claimed**: an open one does,
- **Blocked**: its line has a `blocked:` note,
- **Ready**: every unit it depends on is delivered,
- **Waiting**: none of the above.

A unit of a stale plan, or of a plan whose spec is stale, is never ready and says which file is
stale. A unit with a pull request links to it and shows its state, checks and when that was last
fetched. Without a followed plan, a host, or when the host cannot be reached, units show what the
files alone say (blocked, or "status unknown") with the reason; nothing is guessed.

### Plan runs

A workflow with **For units** on (in its builder) can work through a plan. **Run ready units** in
the plan ("Plan: run ready units with <workflow>" in the palette) picks the workflow and starts a plan run: wow takes the first ready
unit in plan order and starts an ordinary run of the workflow for it, always in its own working
copy, telling every step the intent, unit key and title (`workflows.unitPromptTemplate`, which
also asks the agent to put the `Intent-Unit:` line in its pull request). Gates, review and
notifications work as for any run.

The plan run is shown above the units: its state, what it waits for (for example "U2 waits for
U1 to merge"), each unit's run with a link, and **Stop**. When a unit run is done the next ready
unit starts; when units remain but none is ready, the plan run waits and goes on when the host
shows the change. A unit claimed by a pull request this plan run did not start is skipped. When a
unit run fails or is stopped, `workflows.planRunOnFailure` decides: `stop` (default) stops the
plan run, `skip` leaves that unit and goes on with the next ready unit that does not depend on
it. When every unit is delivered, the plan run is done. Stop ends the live unit run and starts no
further unit. One plan run per plan at a time; a stale plan or spec, or a plan with
`source: issues`, cannot be run, and the button says why.

### Reading from the hosts

wow reads GitHub (github.com or Enterprise Server), Jira, GitLab and Confluence to show unit status
and the run's Pull request, Ticket and Pages tabs. It only reads: it never merges, approves or
comments. Set them up under Settings → Trackers (and per project, see "Backlog"); GitLab
(`trackers.gitlab.baseUrl`, `trackers.gitlab.token`, a token with `read_api`) and Confluence
(`trackers.confluence.baseUrl`, `trackers.confluence.authMode`, `trackers.confluence.email`,
`trackers.confluence.token`) sit beside Jira and GitHub, each with **Test connection**. A project
whose remote is on the GitLab site reads merge requests (with pipelines as checks and notes as
review comments) instead of pull requests. A token only ever goes to the host you stored it for.

Every `hosts.pollSeconds` (60 by default) wow asks the hosts about the pull requests and tickets
of live runs and followed plans only: one search per followed plan for its `Intent-Unit:` lines,
never a list of the whole repository. A host without search is asked for its newest
`hosts.listFallbackCount` pull requests instead. The Ticket tab reads the backlog item's issue (only
from the project's Jira site; an issue published to another site is not asked for), or else a
Jira key in the pull request's title or branch; the Pages tab reads only Confluence pages
the ticket, the pull request or the intent link to. With `hosts.polling` off or the scheduler
paused nothing is asked on the timer; **Refresh now** in a view still asks once. When a host
fails, the last data stays with "Last fetched <time>" and the error, and the next interval tries
again; a token that is wrong or lacks rights names the host that refused and points to its
setting, and the token is never shown or logged. A host that says its request limit is used up is
left alone until the limit resets, but never longer than `hosts.longestWaitMinutes` (60 by
default).

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
- **Publish to Jira** and **Publish to GitHub** use the trackers of the item's project: the
  project of its card (from Plan on calendar) or of its run. An item without one asks which
  project the issue is for; **No project** uses the defaults in Settings → Trackers. The dialog
  then shows the issue first: where it goes ("Publishes to acme/widgets on github.com for
  Widgets", with where the repository came from, such as "From git remote"), an editable
  title, the item's tags to add as labels, and the description rendered. **Publish issue** creates
  it and stores its key and link on the item. Jira gets the description converted from markdown to
  its wiki markup, so headings, lists, emphasis, code and links show as in the preview; GitHub gets
  the markdown as written. Pressing publish again offers to open the existing issue instead. If the
  tracker is not set up, the dialog asks for the missing settings right there and then shows the
  preview: sign-in (site, email, token) is saved as the default every project shares, the rest
  (repository, project key) for the chosen project. wow does not read the issue back afterwards.

Tracker settings come in two places:

- **Settings → Trackers** holds the defaults for every project. Jira: site URL, sign-in (Jira
  Cloud with email and API token, or a personal access token on Server or Data Center), project
  key, issue type. GitHub: API URL (`https://api.github.com`, or `https://api.<name>.ghe.com` for
  `<name>.ghe.com`, or `https://<host>/api/v3` for Enterprise Server), token, owner, repository, labels. Tokens saved here are shared: one GitHub
  token and one Jira token serve all projects. While the Jira email is empty, wow signs in with
  the address Outlook uses.
- **Settings → Projects → Trackers** on each project (also "Trackers for project …" in the
  palette) shows what applies to that project and where each value came from: **From git
  remote**, **Set for this project**, **Default** or **Not set**. Type a value to set it for the
  project only; **Use git remote** or **Use default** goes back. **Use a different token** saves a
  token for this project only, which then replaces the shared one there. Each tracker has **Test
  connection**, which signs in with the project's values.

wow fills in what it can find, and never changes anything in the repository:

- GitHub owner, repository and API URL come from the project folder's git remote (`origin`, or
  the first GitHub remote when there is no `origin`). HTTPS and SSH remotes both work; a host
  `<name>.ghe.com` (GitHub Enterprise Cloud with data residency) gets the API URL
  `https://api.<name>.ghe.com`, and any other host than github.com is taken to be GitHub
  Enterprise Server, so its API URL is `https://<host>/api/v3`. GitLab, Bitbucket and Azure DevOps remotes are not used.
- The Jira project key is only suggested: wow looks for references such as `ABC-123` in the
  branch names and the latest commits (how many is **Commits searched for Jira keys**) and offers
  **Use ABC**. Likewise a project without a Jira site is offered the one another project uses.

Tokens are stored encrypted; clearing the field deletes the stored token. Removing a project
deletes the tokens saved for it alone.

## Projects

Settings → Projects lists your projects with their folders and how many threads and cards use
each. **Add project** (also "New project" in the palette) asks for the folder first and names the
project after it; type another name if you like. In the desktop app **Choose folder…** opens the
system folder dialog; only the browser build of the app (development) takes a typed path, and the
server refuses a folder it cannot find. A name another project already has is refused too. Every
project picker (new thread, card dialog, Run now, Plan on calendar) offers the new project at once.

Each row also says what wow found in the folder: the git remote and branch (`origin ·
github.com/acme/widgets · main`), **No git repository**, **No git remote**, or **Folder
missing** when the folder is gone (threads and runs cannot work there until it is back).
**Trackers** opens the project's Jira and GitHub settings (see Backlog).

**Import from Claude and Codex** (also in the palette) looks through the session history of every
provider instance in Settings → Providers: Claude Code's `projects` folder in the instance's config
directory and Codex's `sessions` folder in its `CODEX_HOME`. It lists each folder they worked in
that still exists and is not a project yet, with which CLIs used it and how long ago, all checked.
Uncheck what you do not want (the box above the list checks or clears all) and press **Import**; each folder becomes a project named after it
(with a number when the name is taken). Nothing is changed in Claude's or Codex's files.

**Thread defaults** (palette: "New thread defaults for project …") picks a provider instance and,
for it, a model, effort and permission mode that a new thread in the project starts with. "As the
last thread" clears them.

**Rename** changes only the name; threads, cards and runs follow it. **Remove** asks first and
leaves the folder and its files alone. Threads that used the project keep working in its folder
without a project. Cards lose the project, so their triggers will not fire until you pick another
one. Finished workflow runs keep their history. A project with a workflow run in progress cannot be
removed: stop the run or let it finish first. The palette has "Rename project …" and "Remove
project …" for every project.

To rename, move or delete a project's folder on disk, Remove is not needed first, but on Windows a
folder with an intents folder, `.claude/skills` or `.agents/skills` inside is watched by wow, and
Windows may refuse while wow runs. Close wow first if it does.

## Assistant

The Assistant section (sidebar, above Settings; `keybindings.goAssistant`, Ctrl+6) is one
conversation whose agent can only operate wow itself. Say what you want ("my projects are on our
GitLab", "move my work hours to end at four") and it asks what it needs, does it through the same
commands the views use, and says what it did and where that lives. The conversation is kept
between restarts; there is only one.

### What it runs on and what it can reach

It runs on a provider you connected: `assistant.providerInstanceId`, or the first connected
instance when that is empty, with `assistant.model` and `assistant.effort` (empty means the
instance's default). The bar at the bottom of its composer shows the instance, the model and the
effort, and a pick there writes these settings, as Settings → Assistant does; picking another
instance empties the model and effort, so it starts from that instance's defaults. Its mode
reads "Read only" and cannot be changed. On Codex it runs only with `assistant.allowCodex` on: wow switches off Codex's command, image,
image generation, computer and browser use, subagent, goal, app, plugin, skill search, tool
suggestion, sleep, code mode and question tools and your own Codex hooks for the assistant, but Codex's file edit tool and its MCP
resource tools have no switch and nobody has yet checked the resulting tool list on a real Codex
(the sandbox stays read-only, without network, as a second guard); with it off and only Codex
connected, the assistant says so. Its agent gets wow's own tools and nothing else: no files, no shell, no
network, in an empty folder of wow's (`~/.wow/assistant`). What it is told to do is the
`assistant.instructions` text.

It can read settings (secret ones only as "set" or "not set"), projects, providers, workflows,
templates and skills, calendar cards and meeting times and titles, the backlog, runs, triggers,
notifications and connection tests. It cannot read a chat thread or a file in a project. Ask it
for project work ("fix this test") and it offers to open a new thread in Chat with your text.

### When the assistant asks

When a few answers are likely, the assistant asks with the same question card a chat thread
shows: up to four questions, each with a header, its choices (the recommended one first) and
**Other** for your own words. Its turn ends there. Your answer, sent with **Send answer**, is your
next message, and the assistant reads it as the answer to those questions. If you write a message
instead, the card says "Not answered" and takes no answer any more. A typed answer that looks
like a secret is held exactly like a typed message ("Put it in …", "Send anyway"). The assistant
never asks for a token, password or key on the card: its tool refuses such a question and tells
it to show the secret's field instead. The words it looks for are `assistant.askRefusedWords`
(Settings → Assistant).

### When the assistant writes a workflow

Before it writes a workflow, the assistant reads the models and efforts each provider instance
offers (an instance that is not connected offers none, and it says so) and wow's guidance on
choosing one per kind of work: planning and specification, building, reviewing and mechanical
steps. Every step it writes names an instance, a model and an effort from that list; wow refuses
any other and tells it what is offered. It says what it recommends and why in a sentence, and asks
you on the question card when two choices differ in a way you would care about, such as cost
against quality. The change row shows each step with its instance, model and effort. The guidance
is `assistant.modelGuidance` (Settings → Assistant, "Guidance on choosing a model"); edit it and
the assistant reads your text the next time it chooses. wow never looks up models on the internet.

### Changes, proposals and Undo

An everyday change is made at once and shows as a row, for example "Work hours: 08:00–17:00 →
08:00–16:00 · Settings → Calendar", with **Undo**. Undo is refused, and says why, when the thing
was changed again since. Several changes in one answer get a row each.

A change that lets wow do more on its own shows as a proposal card with exactly what would change,
**Yes** and **No** (with an optional reason that goes back to the assistant), and nothing changes
until you press Yes: a step's permission mode, a gate condition, a step's rules, an event
trigger, "for units" or "own working copy" on a workflow, resuming the scheduler, the missed
policy `run`, `hosts.polling` or `triggers.eventsEnabled` on, `viewer.htmlScripts` on, any
change to `triggers.forkPullRequests`, writing, changing or removing one of your own skills (the
card shows the text, or what changes), and
starting a run ("Start <workflow> in <project>"). A card with a workflow that starts sooner than
`assistant.startSoonMinutes` (15) from now is a proposal too. A value longer than `assistant.valueLength` (160) characters is cut
short on its line; "show all of it" under the line opens the whole of it. The palette has Yes and No for every
waiting proposal and Undo for every change.

Rows say values as the settings page does ("Work hours: From Outlook → 08:00–16:00, Mon–Fri") and
name models by their label. A tool call that a row or card already shows has no row of its own;
any other reads in words, such as "Read your workflows". While a proposal waits, a line above the
composer names it ("1 proposal waits: …") with **Yes**, **No** and **Show**, which brings the card
into view.

Ask it to always allow a command or a tool in a project ("always allow `pnpm test` in Tea") and it
proposes the rule; the rule is stored, under Settings → Approvals, only when you press Yes. It
never stores one itself, and it cannot propose a rule for a command that runs other commands,
such as `bash` or `npx`, nor a rule outside a project, whichever way it asks.

It never answers a gate: approving, sending back or stopping a run is yours, and wow refuses those
commands from the assistant. It can read the list of skills and the text of a wow skill, and can
give a step "Also follow" skills as part of changing a workflow, but it cannot change the skills
wow ships or skills in other folders.

### Secrets

The assistant never asks you to type a token in the conversation. It puts the setting's field in
the conversation instead, with the token guide's steps above it (see below); **Save** writes the
value straight to the secret store and **Test connection** checks it. The assistant learns only
"set" or "not set" and the test's result. A provider's secret environment variable (an API key
the CLI reads) gets the same kind of card, named after the variable and its instance: Save puts
the value in the secret store, the instance keeps only its reference, and the instance is tested
again.

A message you are about to send that looks like a secret (a known token prefix, a private key, a
long random string after "token", "password" or "key") is held: a line above the composer says
what it looks like, with **Put it in <field>** and **Send anyway**. A held message is not stored.
When the field already holds a value, the line says that putting it there replaces it. Send
anyway sends what the box holds at that moment, queued like any message while the assistant is
still answering.
The patterns are `assistant.secretPatterns`; anything that matches them in what the assistant is
shown is replaced by "[hidden]".

### A setup to share

Settings → Advanced (and the palette) has **Save setup to a file**: a YAML file with the global
settings that differ from their default, tracker and host settings, workflows and templates, and
your own skills with their text.
It holds no secret value (each secret that was set is listed under `toFillIn`), no project folder,
no account name and nothing from the calendar, backlog, threads or runs. Settings that belong to
this machine or this person (work hours, the calendar's zone, desktop settings, first start) stay
out too.

**Start from a setup file** (Settings → Advanced, the palette, or the first-start step) shows a
preview with what would be added and what would replace a value you have, and applies it as one
step you can undo. A skill in the file is listed as added, or as replacing one of yours with the
same name, and **Show all of it** opens its whole text before you apply. A file with an unknown key, a wrong type or a secret value is refused with the
line and the reason; a workflow naming a skill that is not installed is applied and marked "skill
not installed". The row of an applied file under Settings → Advanced keeps those marks and lists
the secrets still to fill in, each with a link to its field, until they are set. A file larger
than `advanced.setupFileMaxBytes` (1 MB unless you change it) is refused before it is read. After a file is applied here, your next message to the assistant tells it what the file
left to fill in, and it goes through that list one thing per answer as after a first start.

### When it cannot start

When no provider can run the assistant (none connected, the one it ran on was removed or signed
out, or only Codex with `assistant.allowCodex` off), Assistant says why and shows the same step
**Connect an agent** as at first start, with links to Settings → Providers and Settings →
Assistant. The rest of the app stays usable. Once an agent passes its test the conversation is
back.

### Making a host token

When a GitLab, GitHub, Jira or Confluence token is needed, the assistant puts the token's field in
the conversation with the steps from a guide that ships with wow, never from what the agent
remembers. The guide links to the token page on your own host, built from the address stored in
Settings → Trackers (or the project's own; a project's own GitHub token is linked on the host of
the project's git remote when the project stores no GitHub API URL, since that is where wow sends
it), says which rights reading needs, what to copy, and which host versions it was written for:

| Host and sign-in                                   | Written for                                 | Rights                                                             |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| github.com                                         | github.com, November 2026                   | classic token, `repo` (`public_repo` for public repositories only) |
| GitHub Enterprise Server                           | 3.10 to 3.17                                | classic token, `repo`                                              |
| GitHub Enterprise Cloud with data residency        | GHE.com, November 2026                      | classic token, `repo`                                              |
| GitLab                                             | 16.9 and later, self-managed and gitlab.com | `read_api`                                                         |
| Jira Server or Data Center (personal access token) | 8.14 and later                              | your own account: Browse projects, Create issues for Publish       |
| Jira Cloud (API token)                             | November 2026                               | your own account, plus your email in Jira email                    |
| Confluence Server or Data Center                   | 7.9 and later                               | your own account: view the linked pages' spaces                    |
| Confluence Cloud (API token)                       | November 2026                               | your own account, plus your email in Confluence email              |

Without a stored address the guide only says to fill in the address first. Token pages move
between host versions; if the page is not where the guide says, your host is probably another
version than the one named. What you type in the field goes straight to the secret store.

### Why does this not work

Ask the assistant why something does not work and it reads what is failing: provider instances
that are not signed in, connection tests of the hosts you set up (it signs in as Test connection
does, and writes nothing), failed host reads (of a run only while it is running or waiting),
workflow steps whose skill is not installed, event triggers that could not start a run, failed
runs with their error (until a later run of the same workflow in the same project ends done; a
run of a deleted workflow or project is left out),
failed plan runs (until a later plan run of the same plan ends done), and cards that did not start
and why (until a later run of the card's workflow in its project ends done). Each comes with the
setting or view to fix it in, and times are in the calendar's time zone. When nothing fails it says so and what it looked at. It lists at
most `assistant.diagnosisLimit` (5) failed runs, failed triggers and cards of each kind, newest
first. A trigger's reason is kept only while desktop notifications are on.

## Settings

Settings are grouped: Providers, Projects, Chat, Calendar, Outlook, Scheduler, Workflows, Skills,
Plans, Trackers, Hosts, Event triggers, Viewer, Changes, Working copies, Assistant, Appearance, Keybindings,
Desktop, Updates and Advanced. The search box above the groups finds a
setting by its name or description across all of them. Every setting shows its description and
its current value; numbers show their unit, and times in milliseconds are shown in seconds.
**Reset to default** appears only when a value differs from the default, and its tooltip says
what the default is. A change applies at once, except settings marked **Restart required** (the
server port): in the installed app **Restart now** appears after you change one. A value that does
not pass validation is refused and the old one stays. Turn on **Show setting keys** (Advanced) to
see each setting's key and raw default, for config files and bug reports.

Work hours are two times and a row of day buttons. The handover text has buttons that insert
each `{{placeholder}}` at the cursor. Settings → Trackers has a Jira, a GitHub, a GitLab and a Confluence
section, each with **Test connection**, which signs in with what you entered and says as whom; the Jira email is
only asked for Jira Cloud. These are the defaults; each project can have its own under Settings →
Projects. Settings → Keybindings groups the keys by where they work and marks a
key that two commands share; click a key and press the new combination.

Useful ones to know:

- `providers.testTimeoutMs`, `providers.requestTimeoutMs` (how long Codex may take to answer one
  request; can be set per provider instance), `providers.updateTimeoutMs` (how long "Update Codex"
  may run npm)
- `calendar.zone`, `calendar.firstDayOfWeek`, `calendar.workHours`, `calendar.lookaheadDays`
- `outlook.pollSeconds`, `outlook.requestTimeoutMs`
- `scheduler.missedPolicy`, `scheduler.notifications`, `scheduler.paused`
- `workflows.templates`, `workflows.handoverTemplate`, `workflows.sendBackTemplate`
- `plans.intentsDirectory`, `hosts.polling`, `hosts.pollSeconds`, `triggers.eventsEnabled`,
  `triggers.forkPullRequests`
- `viewer.maxFileBytes`, `viewer.htmlScripts`, `diff.maxFileBytes`, `diff.maxHashBytes`, `workspaces.root`
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
| `skills/`      | Your own skills, one `<name>/SKILL.md` each                           |
| `snapshots/`   | Snapshots of chat threads' files, for Restore; one Git store a folder |

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
- Codex "is not compatible with wow": the installed `codex` lacks or changed a method or field wow
  needs (the message lists them). Use **Update Codex to …** or install the tested version as the
  instance says, then test again (see "Codex versions").
- Codex "cannot describe its app-server protocol": that `codex` is older than its schema
  generator. Install the tested version.
- **Update Codex** fails with "Could not start npm": the server cannot find `npm` (`npm.cmd` on
  Windows) on its `PATH`. Run the command from the confirmation in a terminal instead. With
  "EBUSY" or "EPERM" on Windows, close other programs that run `codex` (a terminal session, an
  editor extension) and try again.

**A project's folder cannot be removed or moved while wow runs (Windows)**

- A git that wow stopped for running out of time is stopped with the programs it started, and
  wow waits up to **Wait for a stopped git** (`advanced.gitStopWaitMs`, Settings → Advanced) for
  it to be gone. Wait that long and try again; if the folder is still held, another program has
  it open (a terminal or an editor in that folder).
- wow watches a project's intents folder, `.claude/skills` and `.agents/skills` when they exist,
  and Windows may refuse to rename or remove a folder with a watch below it. Close wow, move or
  remove the folder, and start wow again.

**A card did not start its run**

- The card needs both a workflow and a project.
- Check "Scheduler paused" in the calendar toolbar or the tray menu.
- If wow was closed at the card's time, the card shows "missed"; press **Run now**.
- The scheduler looks every `scheduler.tickSeconds` (30 by default), so a run can start up to that
  long after the card's time.

**A thread says "Needs you" but shows nothing to answer**

Scroll to the end of the thread; the approval or question row is the last one. If the server was
restarted mid-turn, the turn is marked failed; send a new message or press Resume.

**Skills are missing in the skill list or the builder**

Check `skills.directories`, then press "Refresh skills" in the builder or the palette. A
`SKILL.md` whose frontmatter does not parse is skipped and logged in `desktop.log`.

**Publishing to Jira or GitHub fails**

The error shows what the tracker answered. Common causes: a wrong base URL, an expired token, a
project key or repository the token cannot reach, or an issue type that does not exist in the Jira
project. Check the project in the dialog first: the preview says which repository or Jira project
it publishes to, and Settings → Projects → Trackers says where each value came from.

**The window does not open**

wow may already run in the tray: click its icon. If the server stopped unexpectedly, wow asks
whether to restart it. `desktop.log` in the wow folder has the details.

**Starting over**

Quit wow from the tray and rename the wow folder. The next start creates a fresh one.
