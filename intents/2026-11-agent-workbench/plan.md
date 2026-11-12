---
intent: 2026-11-agent-workbench
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: Working with an agent in wow as well as in Claude Code and Codex

Execution: fourteen units in the audit's order of work, each by a worker and an independent
reviewer. Units without a dependency between them may be built at the same time in different
working copies: U1 with U2, U3 with U4, U5 with U6, U7 with U8, then U9, U10, U11 and U13 side by
side, U12 after U10, U14 last. Each unit owns the files its Change surface names; a file two units
touch is changed only in the parts named. Every unit updates `docs/architecture.md` and
`docs/user-guide.md` for what it changes, adds a line to `docs/windows-smoke.md` for each provider
fact it relies on, and leaves the repository checks green. Sketches are written by sketch cases:
`WOW_E2E_SKETCHES=1 pnpm e2e -- --trace off -g sketch`. The mock provider is the scripted one in
`apps/web/e2e/server.ts`, which picks its events by words in the prompt.

## Units

- [U1] Model bar at the composer
- [U2] Chat notifications and the thread list
- [U3] Composer state: drafts, queued messages and commands
- [U4] Tool rows, pinned tasks and copy
- [U5] Panel tabs and files in chat — depends on U3
- [U6] Diffs, changes and approvals — depends on U4
- [U7] Host links in chat — depends on U5
- [U8] Images in the composer — depends on U3
- [U9] Run review polish — depends on U5, U6
- [U10] Conversation reading — depends on U4
- [U11] Subagents and background work — depends on U4
- [U12] Fork and edit — depends on U3, U10
- [U13] Assistant, calendar and plans polish — depends on U5, U6
- [U14] Small polish and sessions from the terminal — depends on U1, U3, U12

### U1 Model bar at the composer

Outcome: the model, effort and mode are picked in a bar at the composer with keys and palette
commands, on every composer that runs turns, and the lists say what the provider offers.
Boundaries: no divider or usage model (U10). The header's title element is U2's. The builder
keeps its selects. No change to how `thread.configure` applies a choice.
Change surface: new `apps/web/src/chat/model-bar.tsx` and `chat/model-commands.ts`;
`chat/thread-settings.tsx` (lists), `chat/thread-view.tsx` (`ThreadHeader` minus its title),
`chat/new-thread.tsx`, `panel/step-thread.tsx` (its composer only), `assistant/assistant-view.tsx`
(header and composer bar); contracts `ProviderModel` (optional default effort, default flag, image
input) and the cycle and danger facts in `providerChatOptions`; keybinding settings; `listModels`
in both adapters; the mock's `listModels`; sketch `sketches/model-bar.png`.
Acceptance:

- Given an open thread, then the bar reads "model · effort · mode", the header has no selects, and
  a pick from the bar or with Ctrl+Shift+M or Ctrl+Shift+E reaches `thread.configure` and holds
  after a reload (spec 1, 2).
- Given Claude Code in Ask, then Shift+Tab goes Accept edits, Plan only, Ask; Bypass is never
  reached by the key; on Codex the cycle skips Full access; the colours follow the mode, and a
  second key leaves the composer (spec 3, 4).
- Given `/chat/new` and a step thread in the panel, then both show the bar (spec 5).
- Given the palette, then "Model: <label>", "Effort: <level>", "Permission mode: <label>" with the
  current one marked, and "Choose model…" open or set the same values (spec 6).
- Given Codex models with descriptions, a default, a hidden one and image input, then the list
  shows two-line items, "(default)" on the instance default, the model's default effort, the image
  icon, and no hidden model; given Claude Code, the description shows and nothing is guessed
  (spec 7, 8).
- Given the Assistant view, then its bar writes the assistant's instance, model and effort
  settings and shows "Read only" without a choice (spec 10).

Ground truth: `pnpm --filter @wow/contracts test`, `pnpm --filter @wow/provider-claude test`,
`pnpm --filter @wow/provider-codex test` (the new model fields), `pnpm --filter @wow/web test`
(keys and cycle), `pnpm e2e` cases "picks model, effort and mode from the composer bar" and "sets
the model from the palette" in `chat.spec.ts` and "the assistant's bar writes its settings" in
`app-assistant.spec.ts`; the mock answers `listModels` with descriptions, a default, a default
effort and image input; repository checks.
Dependencies: none inside this plan. It builds on `thread.configure`, the instance defaults and
`provider.listModels`.
Evidence and settled decisions: the bar replaces the header selects; keys are settings; the cycle
is a contracts fact; unreported fields stay empty (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: Shift+Tab traps the focus; the second key out and a web test settle it.

### U2 Chat notifications and the thread list

Outcome: a chat thread that needs the user or finishes notifies; threads can be filtered,
searched, renamed, archived and marked unread from the keyboard.
Boundaries: no Delete. The header's bar is U1's; only its title element changes here. A workflow
step's thread is not archived on its own. "Next that needs you" is U10's.
Change surface: contracts `AppNotification` (`threadId`, kind `finished`), `Thread` (archived,
seen), commands `thread.rename`, `thread.setArchived`, `thread.markSeen`, `thread.markUnread`,
RPC `threads.search`, settings for the chat notification choice and seconds; server
`core/threads.ts` (those cases), the projector, a migration, the search over stored message
text; `apps/web/src/chat/chat-view.tsx`, new `chat/thread-commands.ts`, `app/notifications.tsx`;
`apps/desktop/src/main/index.ts` (buttons on a notification); sketch `sketches/thread-list.png`.
Acceptance:

- Given a chat thread whose agent asks for approval, then a notification "Needs you: <thread> ·
  <summary>" is stored with the thread's id and opens it; in the desktop app it has Allow once and
  Deny; given that thread on screen in a focused window, none shows (spec 64).
- Given a turn longer than the setting's seconds and the choice "needs you and finished", then
  "Finished: <thread>" is stored; with "needs you" it is not; with "off", neither is (spec 64, 65).
- Given the list, then Ctrl+Shift+F or `/` focuses the filter, which matches title, project and a
  word only in a message; a project chip narrows it; arrows and Enter open (spec 66, 69).
- Given F2 or "Rename thread", then the title changes in list, header and palette (spec 67).
- Given Archive, then the thread leaves the list, the filter and palette find it, Unarchive brings
  it back, and a step's thread refuses it (spec 68).
- Given a turn ending in a thread not opened since, then it is bold with a dot until opened, "Mark
  unread" sets it again, and Alt+Shift+Down goes to the next unread (spec 70).
- Given threads stored before, then they load as read, not archived, titled as before (spec 48).

Ground truth: `pnpm --filter @wow/server test` (notification, rename, archive, seen, search, a
migration from an old database), `pnpm --filter @wow/web test`, `pnpm --filter @wow/desktop test`;
`pnpm e2e` cases "notifies when a chat thread needs you" and "filters, renames, archives and marks
unread" in `chat.spec.ts`; the mock's "approve" and plain prompts suffice; repository checks.
Dependencies: none inside this plan.
Evidence and settled decisions: no Delete, only Archive; the server writes notifications and
keeps unread state (spec Interface). Today only workflows and triggers write notifications.
Delivery target: commit on the delivery branch.
Open risks: notification buttons on Windows; the click opening the thread is the fallback.

### U3 Composer state: drafts, queued messages and commands

Outcome: nothing typed is lost: drafts stay per thread, a queued message is held and sent by the
server; `/` lists wow's and the provider's commands.
Boundaries: no images (U8), no `@` (U5), no Edit of the last message (U12). The slash table names
commands other units bring; an entry shows only when its palette command exists.
Change surface: `apps/web/src/chat/composer.tsx` (drafts, queue row, Commands group),
`chat/composer-store.ts`, new `chat/drafts.ts` and `chat/slash-commands.ts`; contracts
`thread.sendMessage` accepted during a turn, `thread.cancelQueued`, a queued mark on the user item,
the provider command list; server `core/threads.ts` (`thread.sendMessage` and the queue only),
`providers/service.ts` (send at turn end); Claude adapter (hand over mid-turn,
`supportedCommands()`); mock; sketch `sketches/composer-queued.png`.
Acceptance:

- Given text and a skill chip typed in thread A, then after opening thread B and a reload, A's
  composer holds both; after Send it is empty (spec 49).
- Given Enter during a running turn on Codex, then the item "Queued · sent when the turn ends"
  shows, survives a reload, and is sent by the server when the turn ends; a second message joins
  it (spec 50).
- Given the same on Claude Code, then the adapter hands it to the running turn and the item shows
  sent (spec 51).
- Given Edit or Cancel on a queued item, then it returns to the composer or goes, and the server
  sends nothing (spec 52).
- Given `/`, then Commands lists `/model`, `/compact`, `/clear` and the others whose palette
  command exists for the thread, above the skills; `/clear` opens a new thread with the same
  instance, settings and folder (spec 58, 59).
- Given Claude Code's command list, then its commands follow wow's and a pick goes as text; Codex
  shows none (spec 60).
- Given the Assistant view, then `/` opens no list (spec 61).

Ground truth: `pnpm --filter @wow/server test` (queue, send at turn end, cancel, restart),
`pnpm --filter @wow/provider-claude test` (mid-turn hand-over, commands), `pnpm --filter @wow/web
test` (drafts, Commands group); `pnpm e2e` cases "keeps a draft and a queued message across
threads and a reload" and "runs /clear from the composer" in `chat.spec.ts`; the mock's "wait"
turn must end on a test control so the queue is sent; repository checks.
Dependencies: none inside this plan. It replaces the composer's own queue and its "Send now".
Evidence and settled decisions: drafts in the web app's storage, queued messages on the server
(spec Interface). Today the server refuses `thread.sendMessage` during a turn.
Delivery target: commit on the delivery branch.
Open risks: a Claude turn wow started may not take a mid-turn message; then it waits (spec Open
risks).

### U4 Tool rows, pinned tasks and copy

Outcome: tool calls read like a terminal: commands with exit code and time, one-line reads and
searches, MCP calls as key: value; the task list stays above the composer; everything copies.
Boundaries: edit rows and diffs are U6's (the `edit` kind is defined here, drawn there). No
subagent rows (U11), no working line (U10). Old items render as today.
Change surface: split `apps/web/src/chat/items.tsx` into `chat/tools/` (command, read, search,
web, mcp, group, the generic row) and new `chat/task-pin.tsx`; `components/code-block.tsx` and
`components/markdown-body.tsx` (Copy on code blocks only); contracts `ToolCallItemPayload` (kind,
command, path, exit code, start and end) and `toolCallStarted` and `toolCallCompleted` fields;
server `core/threads.ts` (the tool and task item cases); both adapters' tool mapping; a setting for
the output lines; mock; sketch `sketches/tool-rows.png`.
Acceptance:

- Given a Codex command that exits 1 after 4.2 s, then the row reads `$ <command>`, the folder when
  it differs, "exit 1 · 4.2 s", the last lines with "Show all N lines" and Copy; given a failed
  Claude Bash call, "failed" and the server's duration (spec 27, 30).
- Given Read, Grep, WebFetch and an MCP call, then each is one line with its path, pattern or
  address, and the MCP row shows `server › tool` with key: value arguments (spec 28, 29).
- Given a running call, then its time counts up, and a reload shows the same start (spec 30).
- Given a turn with a task list, then the pin above the composer reads "3/7 · <current task>",
  Ctrl+T opens it, the stream shows "Updated tasks (3/7)", and Details lists them (spec 31).
- Given a message, a code block and tool output, then each Copy puts the right text on the
  clipboard (spec 32).
- Given a stopped turn, then "Stopped by you · <time>" with Resume ends it; a closed group reads
  "Read 2 files, ran 1 command · 1 failed" (spec 89, 91).
- Given a thread stored before, then its tool rows show name, input and output as today (spec 48).

Ground truth: `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex
test` (kind, command, path, exit code), `pnpm --filter @wow/server test` (times, an old item),
`pnpm --filter @wow/web test` (rows, pin, copy); `pnpm e2e` case "reads commands, reads and MCP
calls as rows with exit code and time" in `chat.spec.ts`; the mock learns a "run the tools" prompt
with a failing command, a read and an MCP call; repository checks.
Dependencies: none inside this plan.
Evidence and settled decisions: adapters normalize, durations from the server where the provider
gives none (spec Interface). Claude's Bash result has no exit code; Codex's has.
Delivery target: commit on the delivery branch.
Open risks: `items.tsx` is shared by U3's queued row; U3 adds its row beside, not inside, the tool
rows.

### U5 Panel tabs and files in chat

Outcome: the side panel opens files in tabs beside a chat; paths in messages and tool rows, the
palette and `@` in the composer reach them, within the thread's folders.
Boundaries: host items are U7's; Changes is U6's view, which this unit registers as a tab if U6 is
merged first. "Open in editor" is U9's. The Assistant view gets no file links or `@`.
Change surface: `apps/web/src/panel/` (`context-panel.tsx`, `model.ts`, `viewer.ts`,
`file-viewer.tsx`, `thread-panel.tsx`, new `panel/tabs.tsx`), the layout store in `app/runtime.tsx`,
`workflows/run-view.tsx` (the conversation as a tab only), `components/markdown-body.tsx` (path
links), an Open button component used by U4's read rows, `chat/composer.tsx` (`@` only); contracts
`FileReadParams` as a union of run, thread and project scope, RPC `files.list`, a file part on the
user item, the list limit setting; server `files/read.ts`, new `files/list.ts`; sketch
`sketches/panel-tabs.png`.
Acceptance:

- Given two files and Details open, then the strip shows three tabs with icons and names; opening
  one again selects it; the close key, Ctrl+Tab, Ctrl+Shift+Tab and Alt+Left work with focus in the
  panel and are in the palette (spec 11, 12).
- Given another thread and back, then the tabs are as left (spec 13); in a run view the
  conversation is a tab and an artifact opens beside it (spec 14).
- Given `src/timer.ts` as inline code and `[spec](docs/spec.md)`, then both are links and open the
  file; given `../outside.txt`, a link to outside, a binary or a too large file, the tab shows the
  refusal and the server read nothing (spec 15, 16).
- Given a Read row, then Open opens its file (spec 17).
- Given Ctrl+P, then the list holds tracked and untracked unignored files, filters fuzzily, stops
  at the setting's limit, and a folder outside Git is walked (spec 18).
- Given `@ti` typed, then the list opens and a pick is a chip sent as the path and shown in the
  thread; pasted `@ti` opens nothing (spec 56).
- Given a file opened from the main view with focus on its link, then Escape closes it (spec 87).

Ground truth: `pnpm --filter @wow/server test` (thread and project scope refusals, `files.list` in
and outside Git), `pnpm --filter @wow/web test` (path recognition, tab keys, `@`); `pnpm e2e`
cases "opens a file from a chat message in a panel tab" and "mentions a file with @" in
`panel.spec.ts`; the mock's reply names `src/timer.ts` in inline code for a "show the file"
prompt; repository checks.
Dependencies: U3, whose drafts and message parts carry the file chip.
Evidence and settled decisions: tabs are UI state per thread; files only inside the thread's or
project's folder (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: path recognition in prose; the rule is narrow (extension or slash, no spaces) and a
miss opens a refusal, never a read outside.

### U6 Diffs, changes and approvals

Outcome: edits show as diffs in rows and approvals; a chat thread has a Changes view; approvals
take a note and an "always allow" rule per project; Claude Code's plan mode has a plan card.
Boundaries: the assistant's proposal of a rule is U13's. Line comments are U9's. The tab frame is
U5's: Changes ships as one view with an open function. No rule for edits.
Change surface: new `apps/web/src/chat/tools/edit.tsx`, `chat/approval-card.tsx` (from
`ApprovalRow`), `chat/plan-card.tsx`, `chat/thread-changes.tsx`, the header chip in
`chat/thread-view.tsx`; the rule list in `apps/web/src/settings`; contracts edit payload,
`ApprovalDecision` with `allowAlways`, `approval.answer` note, `ApprovalKind` `plan`, RPC
`threads.diff`, the project rule setting; server: thread base and turn marks, `threads.diff` with
the run diff code, answering by rule in `providers/service.ts`; both adapters (diff, note, plan);
mock; sketches `sketches/approval-diff.png` and `sketches/plan-card.png`.
Acceptance:

- Given a Claude Edit, a Write of a new file and a Codex file change, then each row reads "Edit
  <path> +n −m" and opens to the diff with Open file (spec 33).
- Given two turns that change files, then Changes lists them with counts, "This turn only" (O)
  narrows to the second, the chip reads "+a −b in n files"; a folder outside Git or an old thread
  says why (spec 34, 35).
- Given an approval for a command, an edit and an MCP tool, then the card shows the command and
  folder, the diff, or `server › tool` with arguments (spec 36).
- Given Deny with a note, then Claude Code gets it as the denial message, and on Codex the turn
  stops and the note is the next message (spec 37).
- Given Y on `pnpm test --watch`, then the card first shows the rule, the request is allowed, a
  later `pnpm test` in another thread of the project reads "Allowed by rule", and after Remove in
  Settings the next one asks (spec 38 to 40).
- Given Plan only and `ExitPlanMode`, then the card renders the plan; "Start, accept edits" allows
  and sets the mode; "Keep planning" denies with the note; digits and palette work (spec 42, 43).

Ground truth: both adapters' tests (diff, note, plan request), `pnpm --filter @wow/server test`
(base and marks, diff, rule matching, no rule for edits), `pnpm --filter @wow/web test`; `pnpm
e2e` cases "approves an edit seen as a diff", "denies with a note", "always allows a command in
this project", "starts from a plan" in `chat.spec.ts` and "lists a thread's changes" in
`changes.spec.ts`; the mock learns "edit the timer" and "plan the work"; repository checks.
Dependencies: U4, whose rows and item fields this unit extends.
Evidence and settled decisions: wow keeps the rules and answers itself; Codex's note goes as the
next message; plan card for Claude Code only (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: the plan text may not be in the request; fall back to the turn's last text (spec Open
risks). This is the largest unit; deliver it in the order of the acceptance lines.

### U7 Host links in chat

Outcome: a link or reference to the user's GitHub, GitLab, Jira or Confluence item is a chip that
opens in a panel tab with what the run's tabs show, read once and stored.
Boundaries: the run and plan scopes and their polling stay as they are. No host without settings
and a token. `chat/composer.tsx` is not edited: the pasted-link chip reads U3's draft store.
Change surface: contracts `HostReadScope` with `thread`, ticket and page reads keyed by scope, an
issue shape, RPC `hosts.lookup`; server `apps/server/src/hosts/github.ts` and `gitlab.ts` (issue
reads), `core/hosts.ts` (lookup and storage); `components/markdown-body.tsx` (chips), new
`panel/host-tab.tsx`, the bodies of `workflows/pull-request-tab.tsx`, `ticket-tab.tsx` and
`pages-tab.tsx` shared, "Mentioned" in `panel/thread-panel.tsx`; sketch `sketches/host-chip.png`.
Acceptance:

- Given links to a PR, a GitLab MR, an issue, a Jira issue and a Confluence page on configured
  hosts, then each is a chip with icon and key, and after the read its state or title (spec 20).
- Given Enter on a chip, then a tab shows the body, "Last fetched", Refresh now and Open on host;
  Shift+Enter opens the browser (spec 21).
- Given the tab opened and a reload, then the host was asked once and the tab shows the stored read
  and time; Refresh now asks again; no poll (spec 22).
- Given a link to a host without a token, then it is a plain link; given a refused read, the tab
  shows the reason and keeps the last data; no token reaches another host (spec 23).
- Given `DEMO-42`, `#14` and `!7` in a message of a project with that key and repository, then each
  is a chip; elsewhere plain text (spec 24).
- Given the palette with a URL, and a link pasted into the composer, then both open the tab or show
  the chip (spec 25); Details lists the thread's paths and links (spec 19).
- Given a read issue, then no prompt sent afterwards contains its text (spec 26).

Ground truth: `pnpm --filter @wow/server test` (lookup per host, token host check, issue reads
against `mock-github.ts` and `mock-gitlab.ts`, stored scope); `pnpm --filter @wow/web test` (link
and key recognition); `pnpm e2e` case "opens a pull request and a Jira issue from a chat link" in
`hosts.spec.ts`; the mock's reply for "link the work" holds those links; repository checks.
Dependencies: U5, whose panel tabs host the items.
Evidence and settled decisions: read on open and Refresh now, never polled; only hosts with a
token (spec Interface). Today GitHub is read for pull requests only.
Delivery target: commit on the delivery branch.
Open risks: a thread without a project has no repository or Jira key; its bare references stay
text, its links still resolve against Settings → Trackers.

### U8 Images in the composer

Outcome: pasted and dropped images go with a message to the provider and show in the thread.
Boundaries: no images in the Assistant view or a workflow step. No editing of images.
Change surface: `apps/web/src/chat/composer.tsx` (image chips only), new
`chat/image-chip.tsx`, the user message's images in `chat/items.tsx`; contracts RPC
`attachments.put`, `thread.sendMessage.attachments`, `startTurn.images`, the size limit setting;
server storage under wow's home per thread and the read for display; Claude adapter (image blocks),
Codex adapter (`localImage`); mock; sketch `sketches/image-chip.png`.
Acceptance:

- Given a pasted screenshot and a dropped PNG, then two thumbnail chips show; Backspace removes the
  last as one thing; a click shows it full size (spec 53).
- Given a send, then both adapters receive the images in their own form and the thread shows them
  after a reload (spec 53, 55).
- Given an image over the limit, a BMP, or a Codex model without image input, then it is refused
  with the reason; given a Claude model, it is sent (spec 54).
- Given the images folder, then the files are under wow's home for that thread (spec 55); the
  Assistant view takes no image (spec 61).

Ground truth: `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex
test` (exact input sent), `pnpm --filter @wow/server test` (storage, limit, type), `pnpm --filter
@wow/web test` (chips); `pnpm e2e` case "sends a pasted image" in `chat.spec.ts`; the mock echoes
the number of images it received; repository checks.
Dependencies: U3, whose drafts and composer code this extends.
Evidence and settled decisions: images go once to the server and are referenced by id (spec
Interface).
Delivery target: commit on the delivery branch.
Open risks: neither provider has taken an image from wow yet; the smoke list checks it.

### U9 Run review polish

Outcome: the gate bar stays in one place and visible at 1024 px, runs are easy to find, diff lines
take comments, files open in the user's editor.
Boundaries: no change to gate rules or verdicts. Send back stays a text note.
Change surface: `apps/web/src/workflows/run-view.tsx`, `gate-bar.tsx`, `workflows-view.tsx`,
`changes-tab.tsx`, the overlay part of `panel/context-panel.tsx`, the comment hook in U6's
`chat/thread-changes.tsx`, "Open in editor" on U5's file links and viewer; contracts RPC
`files.openInEditor`, the editor command setting; server spawn of that command; sketch
`sketches/run-gate.png`.
Acceptance:

- Given a run at a gate with an artifact open in the panel, then the gate bar is at the top of the
  run view, and the panel copy shows only with the conversation tab (spec 77).
- Given 1024 px with the panel over the view, then Approve, Send back and Stop are visible (spec
  78).
- Given twelve workflows and a waiting run, then the Runs tab lists the run first (spec 79).
- Given C on two diff lines with text, then the send-back note holds `path:line – text` for both
  and Ctrl+Shift+Enter sends it; in a chat Changes view they fill the composer (spec 80).
- Given Shift+Enter on a changed file, then the server runs the setting's command with the path and
  line (spec 81); "this step" is a dot with a tooltip and the split resizes (spec 94).

Ground truth: `pnpm --filter @wow/server test` (the command built from the setting, no shell
unless the setting says so), `pnpm --filter @wow/web test`; `pnpm e2e` cases "keeps the gate bar
in view at 1024 px" in `gate.spec.ts` and "sends back with line comments" in `changes.spec.ts`;
repository checks.
Dependencies: U5 (panel tabs and file links) and U6 (the chat Changes view).
Evidence and settled decisions: the server runs the editor (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: `code` on Windows is a `.cmd`; the smoke list checks the default command.

### U10 Conversation reading

Outcome: a long thread reads well: what changed and when, what runs now, when it was compacted,
keys to move through it and to the next thing that needs the user.
Boundaries: E and F on a focused message are U12's. No subagent rows (U11).
Change surface: `apps/web/src/chat/thread-view.tsx` (conversation, scroll, meter),
`chat/items.tsx` (reasoning, working line, dividers), the skill list order in `chat/composer.tsx`
and `chat/view-model.ts`, `app/use-commands.ts` (next that needs you); contracts item kinds for
settings changes and compaction, `model` on the usage item, ProviderEvent `compacted`, settings
for the context threshold and the reasoning default; server projector; Claude adapter
(`compact_boundary`); mock; sketch `sketches/conversation.png`.
Acceptance:

- Given a model and mode change between turns, then one divider names both before the next
  message, and each usage row names its model (spec 9).
- Given a running command, then the working line reads "Running <command> · time · n tool calls",
  with tokens on Codex and none on Claude Code (spec 45).
- Given Claude's compact boundary, then the divider shows trigger and counts; at 82 % the meter is
  amber with "Compact now"; Codex shows no Compact (spec 46, 47).
- Given the chat skill list, then Yours leads, wow is last and its step skills are marked; the
  list does not cover the pickers (spec 57).
- Given scroll up during output, then "New output" shows and End returns; Alt+Up/Down move
  between messages and C copies; times show in the rows (spec 73 to 75).
- Given a waiting approval in one thread and a gate in a run, then Ctrl+Shift+J goes to the older
  first (spec 76); reasoning reads "Thought for n s" and Ctrl+O opens all (spec 88).

Ground truth: `pnpm --filter @wow/provider-claude test` (compaction), `pnpm --filter @wow/server
test` (divider and usage model, old threads unchanged), `pnpm --filter @wow/web test`; `pnpm e2e`
cases "shows a model change and a compaction in the conversation" and "jumps to the next that
needs you" in `chat.spec.ts`; the mock learns "compact" (a compaction event) and a two-tool turn;
repository checks.
Dependencies: U4, whose item fields the working line reads.
Evidence and settled decisions: Codex has no compact method (spec Open risks).
Delivery target: commit on the delivery branch.
Open risks: Alt+Up/Down may clash with screen readers; the keys are settings.

### U11 Subagents and background work

Outcome: what a subagent does is shown under its call, and background tasks can be seen and
stopped.
Boundaries: no new provider abilities; where a provider sends nothing the row says less.
Change surface: contracts `parentItemId` on tool and text events and items, a `subagent` kind,
`BackgroundTask` with start, kind and last output, ProviderCommands to stop and to background a
task; server projector (nested items) and `providers/service.ts`; Claude adapter (keep
`parent_tool_use_id` messages, `stopTask`, `backgroundTasks`), Codex adapter
(`collabAgentToolCall`); new `apps/web/src/chat/tools/agent.tsx`, `BackgroundIndicator` in
`chat/items.tsx`; mock; sketch `sketches/subagent.png`.
Acceptance:

- Given a Claude Agent call with three nested tool calls and a final answer, then one agent row
  shows the description, "3 tool calls", the time, the nested rows while it runs and the answer
  after (spec 44).
- Given a Codex collab agent call, then the row shows prompt, state and final message (spec 44).
- Given two background tasks, then two chips count up; one opens to its last output; Stop on
  Claude Code stops it; Ctrl+B on a running command sends it to the background (spec 90).
- Given a thread stored before, then its agent calls show as before (spec 48).

Ground truth: `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex
test` (nesting and stop), `pnpm --filter @wow/server test` (nested items), `pnpm --filter @wow/web
test`; `pnpm e2e` case "shows a subagent's work under its call" in `chat.spec.ts`; the mock learns
"explore with an agent" with nested events; repository checks.
Dependencies: U4, whose rows the nested list uses.
Evidence and settled decisions: subagent and background facts as checked (spec Open risks).
Delivery target: commit on the delivery branch.
Open risks: Codex subagent items may never reach wow; the row without nesting is the fallback.

### U12 Fork and edit

Outcome: the last message can be edited and resent, and any user message can start a fork, on
Claude Code; Codex says why not.
Boundaries: no file rewind. Opening sessions from a terminal is U14's.
Change surface: contracts `thread.create` with `forkFrom`, a command to edit the last message,
"Earlier version" on the user item; server `core/threads.ts` (fork and edit) and the provider
service; Claude adapter (message ids, `forkSession`, `resumeSessionAt`); `UserMessage` in
`apps/web/src/chat/items.tsx`, Up in `chat/composer.tsx`, E and F on a focused message; sketch
`sketches/fork.png`.
Acceptance:

- Given Up in an empty composer, then the last message loads; sent, the conversation goes on from
  before it, and "Earlier version" shows the replaced exchange (spec 62).
- Given that turn changed files, then the composer says files stay as they are (spec 63).
- Given "Fork from here" or F on the second of three messages, then a new thread holds the first
  two exchanges, the same settings and folder, and names its origin (spec 71, 74).
- Given a Codex thread, then Edit and Fork are not offered and their palette commands say why
  (spec 63, 71); E on a message that is not the last does nothing.

Ground truth: `pnpm --filter @wow/provider-claude test` (exact resume and fork options),
`pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`; `pnpm e2e` case "edits the last
message and forks from an earlier one" in `chat.spec.ts`; the mock answers a fork by replaying the
kept messages; repository checks.
Dependencies: U3 (composer drafts) and U10 (focused messages).
Evidence and settled decisions: go back in the conversation, never rewind files (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: the message id Claude Code needs must be recorded when sending; old threads lack it,
so Edit is offered only for messages sent after this unit.

### U13 Assistant, calendar and plans polish

Outcome: the assistant's conversation drops duplicate rows, words its changes and shows a waiting
proposal; the card form fits; plan files open and a unit can start a thread; light text reads.
Boundaries: the assistant's tools and secret rules stay; only its rule proposal is new.
Change surface: `apps/web/src/assistant/rows.tsx`, `assistant/assistant-view.tsx` (the waiting
line), server `apps/server/src/assistant/changes.ts` and the proposal tool for an "always allow"
rule, `calendar/card-dialog.tsx`, `plans/plans-view.tsx`, `styles/tokens.css`; sketch
`sketches/assistant-polish.png`.
Acceptance:

- Given a change row, a proposal, a secret field and a question card, then no raw tool row sits
  above them; another tool reads in words (spec 82).
- Given the assistant proposes "always allow `pnpm test`" for a project, then it waits for a yes and
  is stored only on Yes (spec 41).
- Given a 900 px window with workflow and repeat, then the footer is in view and Ctrl+Enter saves
  (spec 83).
- Given a plan, then Enter on spec.md opens it rendered; "Start a thread for this unit" opens a
  draft with the unit's contract, unsent (spec 84).
- Given the light theme, then "Waiting for you" text measures at least 4.5:1 (spec 85).
- Given work hours set, then the row reads "From Outlook → 08:00–16:00, Mon–Fri" and models by
  label; a waiting proposal shows above the composer (spec 95, 96).

Ground truth: `pnpm --filter @wow/server test` (wording, rule proposal), `pnpm --filter @wow/web
test` (contrast from tokens); `pnpm e2e` cases "the assistant proposes an always-allow rule" in
`app-assistant.spec.ts`, "opens a plan file and starts a unit's thread" in `plans.spec.ts` and the
card form at 900 px in `calendar.spec.ts`; the assistant agent in `e2e/assistant-agent.ts` learns
the rule proposal; repository checks.
Dependencies: U5 (files read by project, panel tabs) and U6 (the rule setting).
Evidence and settled decisions: the assistant only proposes a rule (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: none beyond the spec's.

### U14 Small polish and sessions from the terminal

Outcome: labels, keys, palette, settings, wording and diagrams lose their slips, and a Claude Code
or Codex session started in a terminal opens as a wow thread.
Boundaries: one small change per item; no new contract beyond the session list and resume.
Change surface: a `modelLabel` helper used in `workflows/builder.tsx`, `run-view.tsx` and the
Assistant header; `app/sections.ts` and keybinding defaults; `app/palette.tsx`; Settings → Chat
and project defaults with the new-thread draft; wording in `workflows/path-tab.tsx`,
`hosts.ts` labels, `panel/workflow-panel.tsx`, `providerChatOptions`; `components/mermaid.ts` and
`workflows/paths-diagram.ts`; contracts `thread.create` with `resumeSessionId`, RPC
`provider.listSessions`; both adapters' session lists; sketch `sketches/polish.png`.
Acceptance:

- Given the builder, a run and the Assistant header, then models read by label with the id in a
  tooltip (spec 86).
- Given the defaults, then Ctrl+4 opens Plans and Ctrl+5 Backlog; the palette's input stays put as
  results shrink (spec 92, 93).
- Given the send key set to Ctrl+Enter, then Enter makes a new line; given a project default model,
  a new thread there starts with it (spec 97).
- Given each slip in spec 98, then the new wording shows; diagram labels have no grey box and the
  last paths label is whole (spec 98, 99).
- Given "Open session from Claude Code / Codex…", then sessions from the instances' files list per
  folder with first prompt and time, and a pick opens a thread that resumes it (spec 72).

Ground truth: `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex
test` (session lists), `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`; `pnpm e2e`
case "opens a session started in a terminal" in `projects.spec.ts`, using the invented session
files the e2e server already writes; repository checks.
Dependencies: U1 (new-thread draft), U3 (send key in the composer), U12 (`thread.create`).
Evidence and settled decisions: both providers resume a session today; listing comes from their
own session files (spec Open risks).
Delivery target: commit on the delivery branch.
Open risks: a session whose folder is gone; list it greyed with the reason.
