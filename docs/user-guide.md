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

| Key              | Does                                     |
| ---------------- | ---------------------------------------- |
| Ctrl+K           | Command palette                          |
| Ctrl+1 … 4       | Calendar, Chat, Workflows, Backlog       |
| Ctrl+5           | Plans                                    |
| Ctrl+,           | Settings                                 |
| Ctrl+B           | Show or hide the sidebar                 |
| Ctrl+J           | Show or hide the context panel           |
| F6               | Move the focus into the panel and back   |
| Ctrl+Shift+L     | Dark or light theme                      |
| Ctrl+Alt+N       | New thread                               |
| Ctrl+.           | Stop the running turn                    |
| T, N, P          | Calendar: today, next, previous          |
| D, W             | Calendar: day view, week view            |
| C                | Calendar: new card on the day you are on |
| Ctrl+= / -       | Calendar: zoom in, zoom out              |
| Ctrl+0           | Calendar: reset zoom                     |
| Ctrl+Enter       | Run at a gate: Approve                   |
| Ctrl+Shift+Enter | Run at a gate: Send back                 |
| Ctrl+Shift+D     | Run: Steps or Changes tab                |
| Ctrl+Shift+Y     | Run: Steps or Path tab                   |
| O                | Changes tab: this step only, and back    |

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
row you can open to see its input and output. Tool calls one after another in a turn share one
row: it shows the latest call, how many there are ("10 tool calls") and how many failed, and opens
(click, or Enter or Space) to list every call. Anything else in the turn, such as text, an
approval or the Assistant's change rows and cards, starts a new row. `chat.groupToolCalls` off
shows every call on its own row. A turn ends with its usage: input, output and cached
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

The thread header shows the project (hover it for the folder), the provider instance, and the
model, effort and permission selects. When a workflow run waits at a gate after the thread's step,
the thread shows the gate with **Approve** (**Ctrl+Enter**), **Send back** (**Ctrl+Shift+Enter**)
and **Stop**, the same as the run view.

**Mark thread done** in the thread header (or in the palette) moves a thread you have finished
with to **Done**. It is available while the agent neither works nor waits for you. **Reopen
thread** puts it back under Idle (a thread whose last turn failed keeps its marker), and sending a
new message to a done thread reopens it as well. A workflow step's thread moves to Done by itself
when its step completes; with a gate after the step, that happens once you press Approve.

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
`disable-model-invocation: true` are offered too, because wow invokes them explicitly.

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
thread with your note (`workflows.sendBackTemplate`), the step shows "Attempt 2", and the run
waits at the same gate with the new result. A note is needed. A message you type in the thread
instead is a side conversation and leaves the run waiting. **Stop** ends the run; Stop asks
first, because a stopped run cannot be continued. The next step's prompt is its skill invocation, its extra prompt, and the handover from
`workflows.handoverTemplate` (by default the previous step's final message and the expected
artifact paths). Stopping a run keeps all its threads.

### Reviewing at a gate

When a run waits at a gate, its run view shows the review tabs and the side panel shows the step's
conversation with the gate bar (**Approve**, **Send back**, **Stop**). Each tab is also in the
palette ("Run: show changes" and so on) and in the address, so a reload shows the same tab.

- **Changes** (**Ctrl+Shift+D**, `keybindings.runChanges`; the same key goes back to Steps) lists
  every file added, changed, renamed or deleted since the run started, committed or not, including
  new files Git does not ignore, each with its added and removed lines. Pick a file for its diff
  on the right. A file the step under review changed is marked; **This step only** (**O**,
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

- **Pull request merged**,
- **Checks failed**,
- **Review comment added**.

When polling first sees the event, one run of the workflow starts with the pull request's link,
number, branch and the event in its handover, in the pull request's working copy when one exists
and otherwise in a new working copy at the pull request's head commit, on its branch when this
repository's branch is at that commit (a fork's pull request whose branch is named like one here
gets its own commit, on no branch). The same event seen again starts nothing, and
what was already true when you created the trigger or followed the plan starts nothing either;
only later changes do. For a review comment the run gets the comment's link and author, never its
text: the agent reads it with its own tools. Comments by accounts in
`triggers.ignoredCommentAuthors` (for example the account your agents write as) start nothing.
`triggers.eventsEnabled` off, or a paused scheduler, holds every event trigger; events seen
meanwhile are not started later. A run that cannot start leaves a failed notification.

## Plans

The **Plans** view (**Ctrl+5**, `keybindings.goPlans`) reads the intent, spec and plan files of
your projects, the format agent-os writes. Each project's `plans.intentsDirectory` (`intents` by
default) holds one folder per intent with `intent.md`, `spec.md` and `plan.md`. wow only reads
these files, and reads them again when they change (once a file has stayed the same for
`plans.writeSettleMs`).

On the left are the projects and their intents with title, status and revision, which files exist,
and a "stale" mark on a spec or plan whose `built_on` revision is older than its source. Pick one
to see its units on the right: key, title, dependencies, the `blocked:` note and, for a plan with
`source: files`, the unit's contract (Outcome, Boundaries and the rest). A plan with
`source: issues` shows key and title only. A plan that cannot be read shows the problem and its
line, and the other intents still show. The palette finds every intent by its title and each unit
of the open plan as "Unit <key>: <title>".

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
  key, issue type. GitHub: API URL (`https://api.github.com`, or `https://<host>/api/v3` for
  Enterprise Server), token, owner, repository, labels. Tokens saved here are shared: one GitHub
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
  other than github.com is taken to be GitHub Enterprise Server, so its API URL is
  `https://<host>/api/v3`. GitLab, Bitbucket and Azure DevOps remotes are not used.
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

**Rename** changes only the name; threads, cards and runs follow it. **Remove** asks first and
leaves the folder and its files alone. Threads that used the project keep working in its folder
without a project. Cards lose the project, so their triggers will not fire until you pick another
one. Finished workflow runs keep their history. A project with a workflow run in progress cannot be
removed: stop the run or let it finish first. The palette has "Rename project …" and "Remove
project …" for every project.

## Assistant

The Assistant section (sidebar, above Settings; `keybindings.goAssistant`, Ctrl+6) is one
conversation whose agent can only operate wow itself. Say what you want ("my projects are on our
GitLab", "move my work hours to end at four") and it asks what it needs, does it through the same
commands the views use, and says what it did and where that lives. The conversation is kept
between restarts; there is only one.

### What it runs on and what it can reach

It runs on a provider you connected: `assistant.providerInstanceId`, or the first connected
instance when that is empty, with `assistant.model` and `assistant.effort` (empty means the
instance's default). On Codex it runs only with `assistant.allowCodex` on, because Codex keeps a
read-only shell that could read files on your computer; with it off and only Codex connected, the
assistant says so. Its agent gets wow's own tools and nothing else: no files, no shell, no
network, in an empty folder of wow's (`~/.wow/assistant`). What it is told to do is the
`assistant.instructions` text.

It can read settings (secret ones only as "set" or "not set"), projects, providers, workflows,
templates and skills, calendar cards and meeting times and titles, the backlog, runs, triggers,
notifications and connection tests. It cannot read a chat thread or a file in a project. Ask it
for project work ("fix this test") and it offers to open a new thread in Chat with your text.

### Changes, proposals and Undo

An everyday change is made at once and shows as a row, for example "Work hours: 08:00–17:00 →
08:00–16:00 · Settings → Calendar", with **Undo**. Undo is refused, and says why, when the thing
was changed again since. Several changes in one answer get a row each.

A change that lets wow do more on its own shows as a proposal card with exactly what would change,
**Yes** and **No** (with an optional reason that goes back to the assistant), and nothing changes
until you press Yes: a step's permission mode, a gate condition, a step's rules, an event
trigger, "for units" or "own working copy" on a workflow, resuming the scheduler, the missed
policy `run`, `hosts.polling` or `triggers.eventsEnabled` on, `viewer.htmlScripts` on, and
starting a run ("Start <workflow> in <project>"). A card with a workflow that starts sooner than
`assistant.startSoonMinutes` (15) from now is a proposal too. A long value is cut short on its
line; "show all of it" under the line opens the whole of it. The palette has Yes and No for every
waiting proposal and Undo for every change.

It never answers a gate: approving, sending back or stopping a run is yours, and wow refuses those
commands from the assistant.

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
settings that differ from their default, tracker and host settings, and workflows and templates.
It holds no secret value (each secret that was set is listed under `toFillIn`), no project folder,
no account name and nothing from the calendar, backlog, threads or runs. Settings that belong to
this machine or this person (work hours, the calendar's zone, desktop settings, first start) stay
out too.

**Start from a setup file** (Settings → Advanced, the palette, or the first-start step) shows a
preview with what would be added and what would replace a value you have, and applies it as one
step you can undo. A file with an unknown key, a wrong type or a secret value is refused with the
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
runs with their error (until a later run of the same workflow in the same project ends done),
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
- `plans.intentsDirectory`, `hosts.polling`, `hosts.pollSeconds`, `triggers.eventsEnabled`
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
project. Check the project in the dialog first: the preview says which repository or Jira project
it publishes to, and Settings → Projects → Trackers says where each value came from.

**The window does not open**

wow may already run in the tray: click its icon. If the server stopped unexpectedly, wow asks
whether to restart it. `desktop.log` in the wow folder has the details.

**Starting over**

Quit wow from the tray and rename the wow folder. The next start creates a fresh one.
