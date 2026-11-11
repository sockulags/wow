---
intent: 2026-11-agent-workbench
rev: 1
built_on: intent@1
status: accepted
---

# Working with an agent in wow as well as in Claude Code and Codex

## Summary

The chat becomes a workbench. The model, effort and permission mode move into a bar at the
composer with keys and palette commands. The side panel in chat becomes a place where files, pull
requests, merge requests, issues, tickets and pages open in tabs. Tool work reads like a terminal
and an editor: commands with exit code and time, edits as diffs, a pinned task list, subagents and
copy buttons. Approvals take a note, an "always allow" rule per project, and a plan card. Drafts and
queued messages survive switching threads, images and `@` file mentions go into the composer, and
threads notify, can be renamed, archived, searched and marked unread. The review loop, the
assistant, the calendar and plans lose the rough edges the audit (`audit.md`) lists. Numbers in
brackets name the audit's findings.

## Behavior

### Model, effort and mode

1. The composer has a bar at its bottom edge, left of Stop and Send, that reads the thread's model,
   effort and permission mode, such as "Opus · High · Ask". The thread header keeps the project and
   the provider; the three selects leave it. [1]
2. Each part of the bar opens a searchable list. While the composer has focus, Ctrl+Shift+M opens
   the model list and Ctrl+Shift+E the effort list; a pick applies to the next turn and is
   remembered by the thread, as today. [1]
3. While the composer has focus, Shift+Tab moves to the next permission mode in the provider's
   cycle: on Claude Code Ask, Accept edits, Plan only and back to Ask; on Codex Read only, Auto,
   Ask for every untrusted command and back. Bypass permissions and Full access are never in the
   cycle; they are chosen from the list only. [1]
4. The mode part is coloured by what it allows: Plan only blue, Accept edits green, Bypass
   permissions and Full access red with a warning icon. [1]
5. The same bar replaces the row under the provider picker on a new thread, and sits on the
   composer of a workflow step's thread in the side panel. [1]
6. The palette has, for the open thread, "Model: <label>" for each model the instance lists,
   "Effort: <level>" for each level of the current model and "Permission mode: <label>" for each
   mode, with the current one marked, and "Choose model…", which opens the bar's model list. [2]
7. Each model in the list shows its label and, under it in muted text, the provider's description.
   The instance's default model is marked "(default)", models the provider hides are left out, and
   where the provider says which models take images, those carry an image icon. [3]
8. The effort list holds the chosen model's own levels; the instance's default is marked
   "(default)" and, where the provider names one, the model's own default level is marked too. [3]
9. After a change of model, effort or mode, the next user message is preceded by one divider line
   naming the change, such as "Model: Opus → Sonnet · Mode: Accept edits". Each turn's usage row
   names the model the turn ran on. [4]
10. The Assistant view has the same bar with the provider instance, model and effort; a pick writes
    the assistant's settings, as Settings does. Its mode is shown as "Read only" and cannot be
    changed. [6]

### Side panel in chat

11. The side panel has a tab strip: "Details", with today's thread details, and one tab per item
    opened in it, each with an icon and a short name such as "spec.md", "PR #14" or "DEMO-42".
    Opening an item that is already open selects its tab. [7]
12. With focus in the panel, a key closes the selected tab, Ctrl+Tab and Ctrl+Shift+Tab move between
    tabs, and Alt+Left goes back to the tab shown before. Each has a palette command. [7]
13. A thread keeps its panel tabs: leaving the thread and coming back shows the same tabs, each read
    again from the server. [7]
14. In a run view, the step's conversation is one of the panel's tabs, so opening a file or a page
    there no longer replaces it. [7]
15. In a chat message, inline code or a link target that reads as a file path (it has a file
    extension or a slash, and no spaces), relative to the thread's folder or absolute inside it, is
    a file link; a relative markdown link is kept instead of dropped. Click or Enter opens the file
    in a panel tab with the existing viewer: markdown rendered, code highlighted, images fitted. [8]
16. A file opens only when it is inside the thread's folder or its project's folder, under the
    rules of the run's file viewer: a path outside, a link that leads outside, a missing, binary or
    too large file shows the refusal in words, and nothing is read. [8]
17. Tool rows that read, edit or write a file have an Open button that opens it in a panel tab. [8]
18. "Open file…" in the palette (Ctrl+P) lists the thread folder's files, fuzzy filtered as you type,
    and opens the pick in a panel tab. The list holds the files Git tracks and the untracked files
    it does not ignore, or a bounded walk outside Git; its length is a setting. [8]
19. Details lists "Mentioned": every file path and host link recognised in the thread's messages,
    each opening in a tab with Enter. [10]
20. A link in a chat message to a GitHub pull request or issue, a GitLab merge request or issue, a
    Jira issue or a Confluence page, on a host wow has settings and a token for, shows as a chip
    with the host's icon and the item's key. Once the item was read, the chip adds its state, such
    as "PR #14 · Draft · 2 checks failed", "DEMO-42 · To Do" or the page's title. [9]
21. Click or Enter on a chip opens the item in a panel tab with the body the run's tabs have: a pull
    or merge request with state, checks and review comments; an issue with state, description and
    comments; a ticket with its fields and description; a page in its sandboxed frame. The tab shows
    "Last fetched", Refresh now and Open on host. Shift+click or Shift+Enter opens the browser. [9]
22. wow reads an item when its tab opens and on Refresh now, and never polls it. What it read is
    stored, so a reload or a restart shows the same chip and tab with the time it was fetched. [9]
23. A link to a host wow has no token for, or of a kind it cannot read, stays a plain link and opens
    in the browser as today. A token is only sent to its own host. A read that fails shows the
    host's reason in the tab and keeps the last data. [9]
24. A bare reference typed by the agent or the user, such as `DEMO-42`, `#14` or `!7`, is a chip when
    it matches the project's Jira project key or its repository on GitHub or GitLab. [9]
25. "Open issue, PR or ticket…" in the palette takes a key or a web address and opens it in a panel
    tab under the same rules. A link pasted into the composer shows its chip above the text with
    "Open in panel". [9]
26. What wow reads from a host is shown to the user only; nothing of a chip or a tab goes into a
    prompt. [9]

### Agent work: tools, diffs, todos, approvals, background

27. A command row reads `$ pnpm test` in mono, the folder when it is not the thread's folder, and on
    the right the exit code and duration, such as "exit 1 · 4.2 s"; where the provider gives no exit
    code, a failed command reads "failed". Opened, the output sits in a terminal-style box showing
    its last lines (a setting), with "Show all 312 lines" and Copy. [13]
28. A read, search or web tool is one line, such as "Read README.md lines 1-80", "Search kettle in
    src" or "Fetch example.org"; a path opens in the panel (15) and a web address follows the link
    rules (20, 23). [13]
29. An MCP tool row reads `server › tool` with its arguments as a short key: value list; the JSON
    shows only on request. [13]
30. A running tool row counts up its elapsed time and a finished one shows its duration. Start and
    end times are stored by the server, so a reload shows the same. [13]
31. The latest task list of the running or last turn is pinned above the composer as one line, such
    as "3/7 · Running the tests", that expands to the list; Ctrl+T toggles it. In the conversation
    each update is a one-line marker "Updated tasks (3/7)". Details lists the tasks too. [16]
32. An assistant message offers Copy (markdown) and Copy text on hover or focus; a code block offers
    Copy, and Open file when its label is a path; tool output offers Copy. [23]
33. An edit row reads "Edit src/timer.ts +4 −1" and opens to an inline coloured diff, with Open file.
    This holds for Claude Code's Edit, MultiEdit and Write and for Codex's file changes; a new file
    shows as added lines. [14]
34. A chat thread has a "Changes" view in the panel listing the files changed in its folder since
    its first turn, with added and removed lines, each opening its diff; "This turn only" (O)
    narrows it to changes since the last turn started. The header shows a chip such as "+42 −7 in 5
    files" that opens it. [15]
35. A thread whose folder is not in Git, or which was stored before this change, has no base; its
    Changes view says so instead of listing files. [15]
36. An approval card shows the request as what it is: a command line with its folder, an edit as its
    diff (33), a web address, or a tool with its arguments; the JSON stays behind "Details". [19]
37. Deny (D) opens a one-line note, "No, and tell it what to do instead"; Enter sends the denial with
    the note, and an empty note denies without one. The agent receives the note. [19]
38. A fourth choice, "Always allow in this project" (Y), shows the exact rule it stores, such as
    "Run commands starting with `pnpm test`" or "Use the tool `github › create_issue`", and allows
    the request. Edits have no such rule (Accept edits is for that), and a thread without a project
    does not offer it. [19]
39. A later request in any thread of that project that a stored rule covers is allowed without
    asking; its row reads "Allowed by rule: …" with the rule. [19]
40. Settings lists each project's "always allow" rules with when they were added, and Remove; a
    removed rule asks again from the next request on. [19]
41. The assistant can propose an "always allow" rule; it waits for a yes like the assistant's other
    proposals, and the assistant never stores one itself. [19]
42. In Plan only, when the agent asks to leave plan mode, the conversation shows a plan card: the
    plan rendered as markdown, "Start, accept edits" (Enter), "Start, ask each time" and "Keep
    planning" with a note field. A start choice allows the request and sets the thread's mode, as
    the bar shows; Keep planning denies with the note. [20]
43. The plan card's choices have palette commands and digit keys, as approval answers do. [20]
44. A subagent call is an agent row, such as "Agent: explore the auth code · 14 tool calls · 1:32",
    with a nested list of its tool calls while it runs, drawn as in 27 to 33, and the subagent's
    final answer at the end. [17]
45. While a turn runs, the working line names the running tool call, the elapsed time, the number of
    tool calls, the live token counts where the provider reports them and the stop key, such as
    "Running pnpm test · 0:42 · 6 tool calls · ↑12k ↓1.3k · Ctrl+. to stop". [21]
46. When the provider compacts the conversation, by request or by itself, the conversation shows a
    divider such as "Conversation compacted (auto) · 152k → 18k", with the counts the provider
    gives. [24]
47. The context meter turns amber from a threshold (a setting, 70 % by default) and then reads
    "Context 82 % full · Compact now". `/compact` compacts where the provider has a compact action;
    a provider without one shows no Compact, as Codex does today. [24]
48. Threads, turns, items, approvals and messages stored before this change load and look as they
    did: a tool row without the new fields shows its name, input and output as today, and no
    divider, marker or chip is added to old turns.

### Composer

49. What is typed in a thread's composer, text and chips, is kept per thread and comes back when the
    user returns to the thread and after a restart of the app; sending clears it. [27]
50. Enter while a turn runs queues the message with the server: the conversation shows it as "Queued
    · sent when the turn ends" with Edit and Cancel, it survives switching threads and a restart,
    and the server sends it when the turn ends. A second message queued meanwhile joins the first,
    as today. [27]
51. On Claude Code a queued message is handed to the running turn at once, as Claude Code's own
    queue does, and shows as sent; on Codex it waits for the turn to end. [27]
52. Edit on a queued message puts it back in the composer and takes it off the queue; Cancel takes
    it off. Neither is offered once it is sent. [27]
53. Pasting an image (Ctrl+V) or dropping an image file on the composer adds a thumbnail chip;
    Backspace after it removes it as one thing, and a click shows it full size. The message is sent
    with its images, and the user's message in the thread shows them. [28]
54. An image over the size limit (a setting), of a type other than PNG, JPEG, GIF or WebP, or for a
    model the provider says takes no images, is refused with the reason and not added. Where the
    provider does not say, the image is sent, and a refusal by the provider shows as the turn's
    error. [28]
55. Images are stored by wow under its home folder, per thread, and are sent to nothing but the
    thread's provider. [28]
56. `@` typed at the start of a word opens the thread folder's file list (18), filtered as you type;
    pasted text opens nothing. A pick is a file chip; the message carries the path in its text, and
    the sent message shows the chip, which opens the file in the panel. [29]
57. In chat, the skill list orders its groups Yours, Project, recently used, User, Plugins and wow
    last, and marks the four wow step skills "for workflow steps". It opens as a popover that does
    not cover the new thread's provider and project pickers. [30]
58. Typing `/` shows a "Commands" group above the skills with `/model`, `/effort`, `/mode`, `/plan`,
    `/compact`, `/clear`, `/fork`, `/rename`, `/done`, `/stop` and `/open`. Each runs the palette
    command of that name for the open thread; one that does not apply to the thread is not listed.
    [31]
59. `/clear` starts a new thread with the same provider instance, model, effort, mode and folder; the
    old thread stays in the list. [31]
60. Below wow's commands, the provider's own commands are listed where the provider reports them
    (Claude Code's built-in and project commands); a pick is sent as text, as typed today. [31]
61. The Assistant view's composer opens no skill or command list and takes no images and no `@`
    mentions. The assistant never sees a secret, as before.
62. Up in an empty composer, or Edit on the last user message, loads that message into the composer.
    Sending it replaces the last exchange: the conversation goes on from before that message, and
    the replaced exchange stays reachable as "Earlier version" on the message. [32]
63. Edit does not undo the file changes the replaced turn made; the composer says so when that turn
    changed files. Where the provider cannot go back in its conversation, Edit is not offered, and
    its palette command says why. [32]

### Threads and navigation

64. When a chat thread starts to need the user (an approval, a question, a plan card), wow notifies
    "Needs you: <thread> · Allow pnpm test?" with Open, and in the desktop app with Allow once and
    Deny for an approval. When a turn that ran longer than a setting's seconds ends, it notifies
    "Finished: <thread>". Neither shows while that thread is on screen in a focused window. [33]
65. A setting in Settings → Chat chooses chat notifications: off, needs you, or needs you and
    finished (the default). Clicking a notification opens the thread. [33]
66. A filter field on top of the thread list (Ctrl+Shift+F, or `/` while the list has focus) matches
    titles, project names and message text; project chips narrow the list to one project. Arrow
    keys move in the list and Enter opens. [34]
67. F2, the header's title or "Rename thread" in the palette renames a thread; the new title shows
    wherever the thread is named. [34]
68. "Archive" hides a chat thread from the list; the filter and the palette still find it, and
    Unarchive brings it back. A workflow step's thread is not archived on its own. [34]
69. The palette finds threads by title, project and message text. [34]
70. A thread that ended a turn or started to need the user since it was last opened shows its title
    bold with a dot until it is opened; "Mark unread" sets it again. Alt+Shift+Down and a palette
    command go to the next unread thread. The server keeps the unread state. [35]
71. "Fork from here" on a user message starts a new thread with the conversation up to that message
    and the same settings and folder; the new thread names the one it came from. Where the provider
    cannot fork, it is not offered and its palette command says why. [36]
72. "Open session from Claude Code / Codex…" in the palette lists the configured instances' recent
    sessions per folder with their first prompt and time, and opens one as a new wow thread that
    resumes it. [36]
73. When the conversation is scrolled up and new output arrives, a "New output" pill shows; it, or
    End, returns to the bottom and following resumes. [37]
74. Alt+Up and Alt+Down move the focus from message to message. On a focused message C copies it, E
    edits it when it is the last user message (62), and F forks from it (71). [37]
75. Each user message shows its turn's start time in the row, not only on hover; each assistant
    message shows when its turn ended. [37]
76. Ctrl+Shift+J, "Next that needs you", goes to the oldest waiting approval, question, plan card,
    gate or assistant proposal, wherever it is, and focuses it. [38]

### Workflows, runs and gates

77. A run waiting at a gate shows its gate bar at the top of the run view whatever the panel shows;
    the panel shows its own copy only while its conversation tab is selected. [42]
78. Below 1200 px, where the panel opens over the view, the gate's Approve, Send back and Stop stay
    visible: the gate bar wraps its buttons under its text, and the panel never covers them. [43]
79. The Workflows view has a "Runs" tab beside Workflows and Triggers, with live and waiting runs
    first. [44]
80. In a diff, C on a line or a click in its gutter adds a comment to that line; the comments gather
    in the send-back note as `src/bell.ts:12 – …`, and Ctrl+Shift+Enter sends them back. In a chat
    thread's Changes view the same comments go into the composer as a reply. [45]
81. "Open in editor" (Shift+Enter) on a changed file, an artifact, a chat file link or in the file
    viewer opens the file at its line with the editor command a setting names. [46]

### Assistant

82. A tool call of the assistant that a change row, proposal card, secret field or question card
    already shows has no tool row of its own; any other tool call is named in words, such as "Read
    your workflows". [49]

### Calendar and plans

83. The card form keeps Delete, Cancel and Create card in a footer that stays in view in a 900 px
    window; Ctrl+Enter saves; above 1200 px the workflow and the repeat sit side by side. [53]
84. In Plans, Enter or a click on intent.md, spec.md or plan.md opens it rendered in the panel. A
    unit has "Start a thread for this unit", which opens a new thread draft in the project with the
    unit's contract as its first message, unsent; "Run with <workflow>" stays. [54]

### Light theme

85. Text in the "needs you" colour, such as "Waiting for you", has a contrast of at least 4.5:1 in
    the light theme; dots and borders keep the bright colour. [56]

### Polish

86. Models are named by the provider's label in the builder's step summaries, run step rows, the
    Assistant header and the assistant's change rows; the id is in a tooltip. [5]
87. Escape closes a file or page opened in the panel from the main view, also when the focus stayed
    on the link that opened it, unless the focus is in a text field. [11]
88. While reasoning streams, its last line shows in muted text beside "Thinking…"; afterwards it
    reads "Thought for 12 s". Ctrl+O opens or closes all reasoning in the thread, and a setting
    opens it by default. [18]
89. A turn the user stopped ends with a muted line "Stopped by you · 20:41" with Resume. [22]
90. Background tasks show as chips with their elapsed time; a chip opens to the latest output the
    provider reported and has Stop. Ctrl+B sends the running command or agent to the background
    where the provider can. [25]
91. A closed group of tool calls reads as a summary of what was done, such as "Read 2 files, ran 1
    command · 1 failed"; a running group shows its latest call and its elapsed time. [26]
92. The sidebar order and Ctrl+1 to Ctrl+6 match: Ctrl+4 is Plans and Ctrl+5 Backlog by default.
    [39]
93. The palette stays anchored near the top of the window, so its input does not move as results
    change. [40]
94. In a run's Changes tab, "this step" is a small mark with the words in a tooltip, and the split
    between the file list and the diff can be resized. [47]
95. The assistant's change rows show values as the settings page does, such as "From Outlook →
    08:00–16:00, Mon–Fri", and models by label. [50]
96. While an assistant proposal waits, a line above the assistant's composer names it with Yes, No
    and Show. [51]
97. Settings → Chat has the send key (Enter or Ctrl+Enter). Each project can set a default provider
    instance, model, effort and mode, which a new thread in that project starts from. [55]
98. Wording: "Waiting for you" everywhere; "From the backlog item's Jira issue" on the Ticket tab; no
    "Open run" in the panel of the run on screen; "Deny unless allowed" for Claude Code's dontAsk
    mode; "Took under 1 s" for a turn under a second. [57]
99. Diagram edge labels have no grey box in either theme, and the paths diagram shows its last label
    in full. [58]

## Interface

- Decided: (delegated) the composer bar replaces the header selects in chat, on a new thread, on a
  step's thread and in the Assistant view (behaviors 1, 5, 10); the builder keeps its selects and
  gets the same marked lists. One place to look when typing, and the builder edits steps, not
  turns.
- Decided: (delegated) keys follow Claude Code where it has one (Shift+Tab mode, Ctrl+T tasks,
  Ctrl+O reasoning, Ctrl+B background) and every key is a keybinding setting. A default the browser
  or the desktop window already takes, such as Ctrl+W in a browser, is replaced by a free one, so no
  key closes a window by surprise.
- Decided: (delegated) which modes are in the Shift+Tab cycle and which are dangerous is a fact per
  provider kind in the contracts' provider options (behavior 3, 4), so the bar, the palette and the
  cycle read one list.
- Decided: (delegated) a model's description, default effort, default flag and image input are
  optional fields filled by each adapter from what its provider reports (behavior 7, 8, 54); a
  field the provider does not report stays empty and nothing is guessed.
- Decided: (delegated) panel tabs are UI state kept per thread like today's file viewer; what a tab
  shows is read from the server when it opens (behavior 13), so the UI shows server state.
- Decided: (delegated) files are read for a thread (its folder and its project's folder) and for a
  project, with the run viewer's refusals (behavior 16, 84), and listed by the server from Git or a
  bounded walk (behavior 18). A file outside is never read.
- Decided: (delegated) host items in chat are read when their tab opens and on Refresh now, never
  polled, and stored under a thread scope beside the plan and run scopes (behavior 22). Chat links
  are many and mostly looked at once; polling them would multiply requests to the user's hosts.
- Decided: (delegated) a link is recognised only against hosts wow has settings and a token for,
  through the existing host adapters; nothing else is fetched from the internet (behavior 23).
- Decided: (delegated) tool items carry a normalized kind, command, path, exit code and start and
  end times set by the adapters and the server (behavior 27 to 30); the UI never reads provider
  shapes. Durations come from the server's clock where the provider gives none.
- Decided: (delegated) an edit carries a unified diff made in the adapter (behavior 33, 36).
- Decided: (delegated) a chat thread's changes are measured from a base the server records at the
  thread's first turn and a mark at each turn's start, with the run diff code (behavior 34).
- Decided: (delegated) "always allow" rules are a project setting that wow answers by itself
  (behavior 38 to 40): a command rule matches by prefix, a tool rule by name, and nothing is
  written to the providers' own settings files. One list for both providers, removed in one place,
  effective at once. The assistant's tools can only propose it (behavior 41).
- Decided: (delegated) a denial's note goes to Claude Code as the denial's message; Codex takes no
  message with a decline, so wow declines, stops the turn and sends the note as the next message,
  as Codex's own "tell it what to do instead" does (behavior 37).
- Decided: (delegated) the plan card is Claude Code's plan mode (behavior 42); wow's Codex modes
  have no plan mode.
- Decided: (delegated) drafts are kept by the web app per thread in its own storage (behavior 49);
  queued messages are kept by the server (behavior 50). A draft is unsent input; a queued message
  is something the server will send.
- Decided: (delegated) images go to the server once, are stored under wow's home per thread and
  are referenced by id in the message (behavior 53, 55).
- Decided: (delegated) Edit and Fork go back in the provider's conversation and never rewind files
  (behavior 62, 63, 71). Rewinding needs checkpoints on every session and would throw away work the
  user may want.
- Decided: (delegated) there is no Delete for a thread, only Archive (behavior 68), so approvals,
  step threads and provider sessions are never lost.
- Decided: (delegated) chat notifications are written by the server; the app does not show one for
  the thread on screen in a focused window (behavior 64). Unread state is the server's (behavior
  70), so the tray and every window agree.
- Decided: (delegated) "Open in editor" is run by the server with the command the setting names
  (behavior 81), since the server owns subprocesses; it works in the browser build too.
- Decided: (delegated) every new tunable is a settings-registry entry: the line count of command
  output, the file list limit, the image size limit, the context threshold, the notification
  choice and seconds, the reasoning default, the send key, the editor command, the always-allow
  rules and the new keybindings.
- Left to delivery: the look of the bar, tabs, chips, rows and cards; wording not quoted above; the
  names of settings, commands, RPCs and item kinds; how search indexes message text; where the
  rule list sits in Settings.

## Boundaries and non-goals

- No terminal, file editor or browser panel inside wow.
- No change to what the providers can do. Where a provider does not send something a behavior
  needs, the fallback in Open risks applies and nothing is guessed.
- Nothing is fetched from the internet except the user's own hosts, through the existing host
  adapters and tokens. No model facts from outside.
- The assistant never sees a secret; its composer takes no skills, commands, images or file
  mentions; nothing read from a host goes into any prompt.
- No change to how runs and followed plans read their hosts.
- Nothing is written to the providers' settings files, and no file is rewound.
- No mobile or remote access.

## Decisions

- **The composer is where choices are made**, so the model, effort and mode sit where the user
  types, with keys.
- **The panel is where things open**, in tabs, so a chat and what it mentions sit side by side.
- **Adapters normalize, the UI renders**: exit codes, diffs, subagents and plans reach the UI as
  wow's own fields, so the UI never parses a provider's shapes.
- **wow keeps its own rules**: "always allow" lives in wow's settings per project, shown and
  removed there, the same on both providers.
- **No silent loss**: drafts and queued messages survive switching threads and a restart.
- **Only the user's hosts, only with their tokens**; other links open in the browser.
- **Old data keeps working.** Threads, runs and messages stored before this change load and look as
  they did.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Adapter tests for Claude Code and Codex cover behaviors 7, 8, 27, 33, 37, 38, 42, 44, 46, 51, 53,
  60, 62 and 71 with a named case each, including what is sent back and the fallback where the
  provider does not send a field.
- Server tests cover 16, 18, 22 to 24, 26, 30, 34, 35, 39 to 41, 48, 50, 55, 64, 66 to 70 and 81
  with a named case each.
- `pnpm --filter @wow/web test` covers the bar's keys, the tab keys, file and host link
  recognition, the composer's chips, drafts and `@`, and the rows of 27 to 33.
- `pnpm e2e` against the mock provider covers each unit's cases named in the plan, and the sketch
  cases write the screenshots under `intents/2026-11-agent-workbench/sketches/`.

## Open risks

- Checked in the adapters and in the installed SDK types (`@anthropic-ai/claude-agent-sdk`
  0.3.316, Codex's generated protocol in `packages/provider-codex/src/protocol/generated`), not run
  against the real CLIs. The Windows smoke list gets a line per item.
- Models: Claude Code's `supportedModels()` gives label, description and effort levels, but no
  default effort and no image input. Codex's `model/list` gives description, default effort,
  default flag, `hidden` and `inputModalities`. Fallback: Claude models show no image icon and no
  model default, and images are not refused before sending (behavior 54).
- Exit codes: Codex's command item has `exitCode` and `durationMs` (the adapter folds the code into
  ok or error today). Claude Code's Bash result has stdout, stderr and `interrupted`, no exit code;
  only `is_error`. Fallback: a failed Claude command reads "failed", and its duration comes from
  the server's clock.
- Edits: Claude Code's Edit and Write inputs hold the old and new text or the content, and the
  result holds a structured patch; Codex's file change holds a unified `diff`, also captured for
  its approval. Fallback: when an edit's old text cannot be matched in the file, the row shows the
  old and new text as removed and added lines.
- Approvals: Claude Code's deny takes a `message` and offers rule suggestions; Codex's decline
  takes no message (hence behavior 37's fallback) and may propose an exec policy amendment, which
  wow reads only to word the rule.
- Plan mode: Claude Code's `ExitPlanMode` reaches the permission callback, but this SDK's input type
  declares no plan field; only the tool's result has `plan`. Not verified that the request carries
  the text. Fallback: the card shows the turn's last assistant text, labelled as the plan written
  in the conversation.
- Subagents: Claude Code marks subagent messages with `parent_tool_use_id` (the adapter drops them
  today) and the Agent result gives tool count and duration. Codex sends `collabAgentToolCall` items
  with prompt, receiving threads and their last messages; whether the subagent's own items reach
  wow's connection is not verified. Fallback on Codex: the agent row shows prompt, state and final
  message without a nested list.
- Background: Claude Code's query has `stopTask` and `backgroundTasks(toolUseId)`, and its messages
  report task progress; reading a task's output is a control request not verified as a query
  method. Codex has none. Fallback: chips without output and without Stop where not offered.
- Compaction: Claude Code sends `compact_boundary` with trigger and token counts. Codex's generated
  protocol has no compact method or notice. Live token counts: Codex sends them during a turn,
  Claude Code only at its end, so the working line has no tokens there.
- Queued messages: Claude Code takes streaming input and folds queued messages into a running turn
  (the adapter already does this for turns Claude Code starts itself); not verified for a turn wow
  started. Fallback: the message waits for the turn to end, as on Codex.
- Images: Claude Code takes image blocks in a user message and Codex a `localImage` input; neither
  was sent in a test yet.
- Commands: Claude Code's `supportedCommands()` lists them; Codex reports none, so only wow's
  commands are listed there.
- Fork and edit: Claude Code has `forkSession` and `resumeSessionAt`, which need the id of the
  message to go back to; the adapter must record it when sending. Codex's generated protocol has
  `thread/resume` but no fork or rollback, so Edit and Fork are not offered on Codex until the
  protocol is generated again and checked.
- Notifications: Electron 45 has notification buttons, not tried on Windows. Fallback: the
  notification opens the thread with the approval focused.
- The editor command on Windows: `code` is a `.cmd` file and needs to be run the Windows way; the
  setting holds the whole command.
- Shift+Tab in the composer no longer moves the focus back. Evidence: the key is a setting, and U1
  gives the composer another key out (named in the user guide) with a web test.

## Decision log
