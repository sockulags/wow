# wow UI/UX audit (November 2026)

Worktree `wt/ux` at `aa6daf1`. Screenshots were taken from the e2e servers (mock providers, mock
Outlook and hosts) at 1440x900 and 1024x768, scale 1, dark and light, and are in
`/tmp/wux/shots/` (named below as `shots/NN-name.png`). Claims marked "code" were checked in the
source; claims marked with a shot were seen on screen.

## Summary

Solid, calm and keyboard-aware; the review loop around a gate (tabs, diff, PR, ticket, pages,
viewers) is the strongest part. The chat, where the owner works next to Claude Code and Codex, is
the weakest: tool work shows as JSON, the model choice is in the header with no key, and the chat
side panel shows only static details. What would matter most to him:

1. A model / effort / mode bar in the composer, with keys and palette commands (findings 1 to 4).
2. A side panel that opens files, PRs, MRs, issues, Jira tickets and Confluence pages from any chat link or mention (7 to 10).
3. Tool calls that read like a terminal and an editor: commands with exit code and time, edits as diffs, a sticky todo list (13 to 16).
4. Approvals and plan mode at Claude Code's level: deny with a note, always-allow, a rendered plan to approve (19, 20).
5. Chat notifications and drafts that never get lost: queued messages and drafts survive switching threads (27, 33).

## Findings

### A. Model, effort and mode choice

**1. Model, effort and permission mode sit in the thread header, far from where you type**

- Where: chat thread header, `apps/web/src/chat/thread-view.tsx` (`ThreadHeader`), `apps/web/src/chat/thread-settings.tsx`; new thread `apps/web/src/chat/new-thread.tsx`.
- Today: three selects ("Model: Mock model", "Effort: Default", "Permissions: Ask for permissions") on the header's second row (`shots/05-chat-turn.png`, `13-chat-model-select.png`, `14-chat-permission-select.png`). They are remembered per thread (`thread.configure`, stored on the thread) and a new thread starts from the last one (F-5). Good. The composer itself shows nothing about them.
- Problem: you look at the composer when you decide "this needs the big model" or "let it edit". The choice is two rows up, mouse-only in practice, and the current mode is easy to forget (Bypass permissions looks like any other value).
- Proposal: a compact bar inside the composer's bottom edge, left of Stop/Send: `Opus · High · Ask ▾`. Each part is a popover list (cmdk, searchable). Keys while the composer has focus: Ctrl+Shift+M model list, Ctrl+Shift+E effort list, Shift+Tab cycles the permission mode the way Claude Code does (Ask → Accept edits → Plan only → back; Bypass never in the cycle). Mode colour: Plan blue, Accept edits green, Bypass red with a warning icon. The header keeps project and provider only. The same bar on `/chat/new` (replaces the row under the provider picker) and in the context panel's step-thread composer.
- Server/contracts: none; `thread.configure {model, effort, permissionMode}` exists and the adapters apply it before the next prompt (`setModel`, `setPermissionMode`). New keybinding settings `keybindings.chatModel`, `keybindings.chatEffort`, `keybindings.cycleMode`.
- Size M. Priority P1.

**2. No palette command or key for model, effort or mode**

- Where: `apps/web/src/chat/commands.ts`.
- Today: typing "model" in the palette finds only a thread whose keywords hold its model id (`shots/16b-palette-model.png`); `thread.configure` is sent only from the header select (code: the only caller is `thread-view.tsx:170`).
- Problem: keyboard-first owner cannot switch model without the mouse.
- Proposal: palette commands for the open thread: "Model: <label>" for each model the instance lists (current one marked), "Effort: <level>", "Permission mode: <label>", plus "Choose model…" that opens the composer bar list. Also the `/model`, `/effort`, `/mode` composer commands (finding 31).
- Server/contracts: none.
- Size S. Priority P1.

**3. The model list says too little about what the provider offers**

- Where: `apps/web/src/chat/thread-settings.tsx`, `packages/contracts/src/provider.ts` (`ProviderModel`), `packages/provider-codex/src/adapter.ts` (`model/list`), `packages/provider-claude` (`supportedModels()`).
- Today: the list shows labels only ("Mock model", "Mock model, large"; `shots/13-chat-model-select.png`). Neither the thread header nor the new-thread draft passes `defaults` to `ThreadSettings`, so the instance's default is not marked there (code; only the workflow builder marks it, `builder.tsx:557`). The model's `description` is in `ProviderModel` but never shown.
- Problem: on Codex you choose between several similar names with no hint; you cannot see which model takes images or which effort is the model's own default.
- Proposal: two-line items (label, then the provider's description in muted text), "(default)" on the instance default, effort list per model with the model's default effort marked; an image icon on models that take images. Hidden models (Codex `hidden`) left out.
- Server/contracts: extend `ProviderModel` with `defaultEffort?`, `isDefault?`, `inputModalities?` (Codex `Model` has `defaultReasoningEffort`, `supportedReasoningEfforts` with descriptions, `inputModalities`, `hidden`; Claude's `supportedModels()` gives description and effort levels). Adapters fill them.
- Size S. Priority P2.

**4. A dangerous mode or a mid-thread change leaves no trace in the conversation**

- Where: `thread-view.tsx`, server `core/threads.ts` projector.
- Today: changing model or mode updates the select only. The transcript does not say that turns 1 to 4 ran on one model and 5 on another, or that Bypass was on.
- Problem: when reading back a thread (or a step thread at a gate) you cannot tell what ran with what.
- Proposal: a one-line divider item "Model: Opus → Sonnet · Mode: Accept edits" before the next user message after a change; turn usage row names the model it ran on.
- Server/contracts: the `thread.configured` event exists; add a thread item kind `settings_changed {model?, effort?, permissionMode?}` written by the projector, and `model` on `UsageItemPayload`.
- Size S. Priority P2.

**5. Raw model ids in several places instead of the provider's labels**

- Where: builder step summary (`apps/web/src/workflows/builder.tsx`), run step rows (`run-view.tsx`), assistant header (`assistant/assistant-view.tsx:349`), assistant change rows (server `assistant/changes.ts`).
- Today: "Mock Claude · mock-model" in the builder and run steps (`shots/26-builder-new.png`, `30-run-gate-steps.png`), "Assistant Mock Claude · mock-model" (`46-assistant-change.png`), "plan-work (Mock Claude, mock-model-large, high)" in the change row (`49b-assistant-workflow.png`), while the selects say "Mock model".
- Proposal: one helper `modelLabel(instanceId, id)` from `provider.listModels` used everywhere; the id stays in a tooltip.
- Server/contracts: none for the UI; the assistant change text is built on the server and would use the same labels (`read_models` already has them).
- Size S. Priority P3.

**6. The assistant's model and effort can only be changed in Settings**

- Where: `apps/web/src/assistant/assistant-view.tsx`.
- Today: header shows instance and raw model id, plus a "Settings" link (`shots/45-assistant.png`).
- Proposal: the same composer bar as finding 1, writing `assistant.providerInstanceId`, `assistant.model`, `assistant.effort` (mode stays fixed and is shown read-only, "Read only").
- Server/contracts: none (settings writes; `thread.openAssistant` already re-aligns the thread).
- Size S. Priority P2.

### B. Side panel in chat

**7. The panel in chat mode shows only static thread details; it needs to become a place things open in**

- Where: `apps/web/src/panel/context-panel.tsx`, `panel/model.ts` (`panelSelection`), `panel/thread-panel.tsx`, `panel/viewer.ts`, `panel/file-viewer.tsx`, `panel/page-viewer.tsx`, layout store in `app/runtime.tsx`.
- Today: in chat the panel is "Thread details": provider, model, effort, permissions, project, folder, usage, run/card/backlog links (`shots/12-chat-panel.png`). The file viewer and the Confluence page viewer exist, but only for a run: `openFile` stores `{runId, path, from}`, `FileReadParams` requires `runId`, `openPage` takes a run's `PageRead` (code). The panel holds one thing at a time: opening a file replaces the conversation (`32b-run-artifact-in-panel.png`).
- Problem: the owner's request: show markdown, a GitHub issue, a Jira issue next to a chat. Nothing in chat can open in the panel today.
- Proposal: the panel gets a tab strip: "Details" (today's content) plus one tab per opened item (file, PR/MR, issue, ticket, page), each with an icon and short name ("PR #14", "DEMO-42", "spec.md"). Ctrl+W closes the panel tab, Ctrl+Tab / Ctrl+Shift+Tab move between tabs while focus is in the panel, Alt+Left goes back. Tabs are kept per thread (layout store keyed by route), so returning to a thread restores them. In a run view the conversation becomes one of the tabs, which also fixes the gate bar jumping (finding 42).
- Server/contracts: none for the frame (UI state like today's `viewer`).
- Size M. Priority P1. Prerequisite for 8, 9, 10.

**8. Open files from a chat: from a message, a tool row, the composer or the palette**

- Where: `components/markdown-body.tsx` (inline code and links), `chat/items.tsx` (tool rows), `panel/viewer.ts`, server `files.read` handler, `packages/contracts/src/files.ts`.
- Today: inline code like `login.ts` is plain text (`shots/11b-chat-markdown-end.png`); a relative link in markdown is dropped by `safeHref` (only http, https, mailto); a `Read README.md` tool row cannot be opened as a file (`06-chat-tools.png`).
- Proposal: inline code and link targets that look like a path relative to the thread's folder (or absolute inside it) render as a file link; tool rows of Read/Edit/Write/fileChange get an "Open" icon. Click or Enter opens it in a panel tab (markdown rendered, code highlighted, image fitted: the existing viewer); Shift+Enter opens it in the system editor (finding 46). Palette "Open file…" (Ctrl+P) with a fuzzy list of the thread folder's files; `@` in the composer uses the same list (finding 29).
- Server/contracts: `FileReadParams` becomes a union `{runId, path} | {threadId, path}` (thread scope: the thread's `cwd`, same refusals: outside, missing, binary, too large). New RPC `files.list {threadId | runId, query, limit}` answering paths from `git ls-files` (and untracked not ignored) or a bounded walk when not a Git folder; limit as a setting.
- Size M. Priority P1.

**9. Open a GitHub PR or issue, GitLab MR, Jira ticket or Confluence page from a link in chat**

- Where: `components/markdown-body.tsx` (`a` renderer), `workflows/pull-request-tab.tsx`, `workflows/ticket-tab.tsx`, `workflows/pages-tab.tsx`, `panel/page-viewer.tsx`; server `apps/server/src/hosts/{github,gitlab,jira,confluence}.ts`, `hosts/poller.ts`; contracts `packages/contracts/src/hosts.ts`.
- Today: every http(s) link opens in the browser (code: `target="_blank"`). Host reads exist only for followed plans and live runs: `HostReadScope = ['plan','run']`, `TicketRead`/`PageRead` carry a `runId` (code). GitHub is read for pull requests only (`/pulls`, `/search/issues` used to find PRs); there is no read of a GitHub or GitLab issue. Confluence links are parsed by `confluencePageOf` / `confluenceLinksIn`, Jira keys by `jiraKeyIn` (code).
- Proposal: a link whose host matches a configured tracker (Settings → Trackers, or the project's git remote) renders as a chip with the host icon and key ("PR #14 · Draft · 2 checks failed", "DEMO-42 · To Do", "Watering schedule"). Click or Enter opens it in a panel tab with the same body as the run tabs (state, checks, review comments; ticket fields and description; page in its sandboxed frame), with "Last fetched", Refresh now and Open on host. Shift+click opens the browser. A bare key typed by the agent or by you (`DEMO-42`, `#14`, `!7`) is linked when it matches the project's Jira key or repository. Palette: "Open issue, PR or ticket…" takes a key or URL. Composer: pasting such a link shows the chip and "Open in panel".
- Server/contracts: new RPC `hosts.lookup {threadId, url | ref}` that resolves the URL against configured hosts (a token only goes to its own host, as today), reads once with the existing host adapters and stores the result under a new scope `thread:<threadId>` (`HostReadScope` gains `thread`; `TicketRead`/`PageRead` get `scope` instead of only `runId`) so the panel renders persisted rows and a reload shows the same thing. New reads: GitHub issue (`GET /repos/{o}/{r}/issues/{n}` with comments), GitLab issue and MR by IID; Jira by key and Confluence by page ref already exist in the adapters. Polling only while the tab is open (or never: Refresh now), as a setting.
- Size L. Priority P1.

**10. A "Links and files" section in Thread details**

- Where: `panel/thread-panel.tsx`.
- Today: no list of what a thread touched or mentioned.
- Proposal: in the Details tab, "Mentioned": every recognised link and file path in the thread (chips from 8 and 9), and "Changed files" (finding 15) with counts; Enter opens each in a tab.
- Server/contracts: none beyond 8, 9 and 15 (the list is derived from stored items; host reads come from `thread:` scope rows).
- Size S. Priority P2.

**11. Escape does not close a file opened from the main view**

- Where: `panel/file-viewer.tsx:224`, `workflows/artifact-link.tsx`.
- Today: the Escape handler sits on the viewer, and opening an artifact leaves focus on the link in the run view; pressing Escape and switching tabs left the file open (`shots/33-run-path.png`). The guide says Escape goes back.
- Proposal: move focus into the viewer when it opens from a click or Enter (not from hover), or listen for Escape at the panel level while a viewer is shown and focus is not in a text field.
- Server/contracts: none.
- Size S. Priority P3.

### C. Agent work display (tools, diffs, todos, thinking, background)

**12. What works well**: streaming with a cursor, tool calls grouped per turn with a failure count (`shots/06-chat-tools.png`), approval and question cards that take focus and digits (`07-chat-approval.png`, `08-chat-question.png`), the error row with Retry and Resume (`10-chat-error.png`), "Waiting for background work" (`20-chat-background.png`), per-turn usage and the context meter with Compact (`05-chat-turn.png`). Keep these.

**13. Tool calls show JSON, not what happened**

- Where: `apps/web/src/chat/items.tsx` (`ToolCall`, `ToolCallLine`, `inputSummary`), `packages/contracts/src/projections.ts` (`ToolCallItemPayload`), `provider.ts` (`toolCallCompleted`).
- Today: a row is wrench, tool name, the first string of the input, status word; open, it shows the input as JSON and the output as plain text (`shots/07b-chat-approval-done.png`: `{ "command": "pnpm test" }` then "All 12 tests passed"). No exit code, no duration, no cwd, no line count. `ToolCallItemPayload` is `{name, input, output, status}`; thread items carry no timestamps (code). The Codex adapter folds `exitCode` into ok/error and drops it (code, `provider-codex/src/adapter.ts:237`).
- Proposal: renderers per tool kind, chosen from the normalized payload:
  - Command (Bash, Codex `command`): header `$ pnpm test` in mono, cwd if not the thread folder, then right side `exit 1 · 4.2 s`; output in a terminal-style box, last 20 lines shown, "Show all 312 lines", Copy.
  - Read / Grep / Glob / WebFetch / WebSearch: one line each ("Read README.md lines 1-80", "Grep kettle · 3 files"), path or URL opens in the panel (findings 8, 9).
  - MCP tools: `server › tool` with arguments as a short key: value list, JSON only on demand.
  - Running rows show a live elapsed time.
- Server/contracts: `toolCallCompleted` gains optional `exitCode` and `durationMs` (Codex `commandExecution` has `exitCode` and `durationMs`; Claude: duration from the projector's own clock at start and end); `ToolCallItemPayload` gains `startedAt`, `endedAt`, `exitCode?`, and a normalized `kind` (`command | read | search | edit | web | mcp | other`) plus `command?`, `path?` set by each adapter so the UI never parses provider shapes.
- Size M. Priority P1.

**14. File edits show as JSON or plain text, not as diffs**

- Where: `chat/items.tsx`; adapters `provider-claude/src/adapter.ts` (Edit, MultiEdit, Write tool_use), `provider-codex/src/adapter.ts` (`fileChange`: diffs joined into `output`); diff rendering in `workflows/changes-tab.tsx`.
- Today: a Claude Edit is shown as the JSON of `old_string`/`new_string`; a Codex fileChange as raw unified diff text in "Output" (code). The run's Changes tab has a real diff view (`shots/31-run-changes.png`), the chat does not.
- Proposal: an edit row "Edit src/timer.ts +4 −1" that opens to an inline coloured diff (the Changes tab's renderer), with "Open file" (panel tab) and "Open in editor". In an approval for an edit (Ask mode), the same diff sits in the approval card above Allow / Deny, so you approve what you see.
- Server/contracts: normalized `edit` payload on `toolCallStarted` / the item: `{path, diff}` (unified diff) computed in each adapter (Claude: from old/new strings or the Write content against the file; Codex: the change's `diff`); same on `approvalRequested` for file changes.
- Size M. Priority P1.

**15. No changed-files view for a chat thread**

- Where: chat view; the run's Changes tab (`workflows/changes-tab.tsx`, RPC `workflowRuns.diff`).
- Today: only workflow runs record a base commit and show changes (code; user guide "Run base and changes").
- Problem: Codex app and Claude Code desktop show the session's diff; in wow a chat thread that edits files has no review surface.
- Proposal: "Changes" tab in the chat panel (and a "+42 −7 in 5 files" chip in the thread header) listing files changed since the thread's first turn, each opening its diff; "This turn only" toggle like "This step only" (key O).
- Server/contracts: store a base commit on `thread.create` / first turn (like `workflowRuns` base), and RPC `threads.diff {threadId, path?, turnId?}` reusing the run diff code.
- Size M. Priority P1.

**16. The todo list scrolls away with the turn**

- Where: `chat/items.tsx` (`TaskList`), `thread-view.tsx`.
- Today: the task list is one item per turn in the stream; after the turn it shows unfinished tasks as "not finished" (`shots/05-chat-turn.png`). While a long turn runs, it scrolls up out of view.
- Proposal: the latest task list of the running (or last) turn pinned above the composer as one line "3/7 · Running the tests ▸" that expands to the list; Ctrl+T toggles it (Claude Code's key); also listed in Thread details. The in-stream copy becomes a one-line "Updated tasks (3/7)" marker.
- Server/contracts: none (latest `task_list` item).
- Size S. Priority P1.

**17. Subagents are invisible**

- Where: `packages/provider-claude/src/adapter.ts:485,499,530` (`if (message.parent_tool_use_id !== null) return;`), `provider-codex/src/adapter.ts` (`toolView` returns null for collab agent items).
- Today: a Claude `Task`/agent call is one generic tool row; everything the subagent does is dropped (code). Codex sub-agent calls are not shown at all.
- Proposal: an agent row "Agent: explore the auth code · 14 tool calls · 1:32" with a live nested list (same renderers as 13), the subagent's final answer at the end, and Stop (finding 25).
- Server/contracts: `parentItemId?` on `toolCallStarted`, `toolCallOutput`, `textDelta` (and a `subagent` kind on the parent's item); the projector stores nested items under the parent; Claude: keep messages with `parent_tool_use_id` and map it; Codex: map collab agent items.
- Size M. Priority P2.

**18. Thinking is hidden while it streams and has no duration**

- Where: `chat/items.tsx` (`Reasoning`).
- Today: collapsed "Thinking…" then "Reasoning" (`shots/05-chat-turn.png`, opened by the test).
- Proposal: while streaming, show the last line of the reasoning in muted text next to "Thinking…"; after, "Thought for 12 s". A setting `chat.reasoningOpen` and a key (Ctrl+O, Claude Code's transcript key) to expand all reasoning in the thread.
- Server/contracts: duration needs item timestamps (see 13; `ThreadItem` has none today).
- Size S. Priority P3.

**19. Approvals miss deny-with-a-note, always-allow and a readable request**

- Where: `chat/items.tsx` (`ApprovalRow`), contracts `ApprovalDecision`, adapters `#permission` (Claude), approval mapping (Codex).
- Today: kind badge, summary, folder, mode, "Details" JSON, Allow once (A) / Allow for this session (S) / Deny (D) (`shots/07-chat-approval.png`). Works well from the keyboard. Missing: a reason with Deny, a rule that persists beyond the session, and a request shown as what it is (command line, diff, URL) instead of JSON.
- Proposal: Deny opens a one-line note ("No, and tell it what to do instead"), Enter sends; a fourth choice "Always allow in this project" (key Y) showing the exact rule it writes ("Bash(pnpm test:*)"); the request body uses the renderers of 13 and 14.
- Server/contracts: `ApprovalDecision` adds `allowAlways`; `approval.answer` and `answerApproval` get `message?` for deny. Claude: deny `message` exists in `PermissionResult`; always = the SDK's `suggestions` with destination `localSettings` (today only `session`). Codex: `acceptWithExecpolicyAmendment` exists in the generated `CommandExecutionApprovalDecision`.
- Size M. Priority P1.

**20. Plan mode has no plan card**

- Where: `providerChatOptions.claude.permissionModes` ("Plan only"), `provider-claude/src/adapter.ts` `#permission`.
- Today: in Plan only, Claude's `ExitPlanMode` reaches wow as an ordinary approval titled with the tool name and the plan inside the JSON "Details" (code: `summary: options.title ?? toolName`, request `{toolName, input}`).
- Proposal: a plan card: the plan rendered as markdown, with "Start, accept edits" (Enter), "Start, ask each time", and "Keep planning" with a note field; the chosen start mode is applied to the thread. Shift+Tab into Plan only (finding 1).
- Server/contracts: `ApprovalKind` adds `plan` with `plan` text in the request; on allow, the provider service sends `setPermissionMode` and stores `thread.configured`.
- Size M. Priority P1.

**21. The working line says only "Working · 0:42"**

- Where: `chat/items.tsx` (`WorkingIndicator`).
- Today: spinner, "Working · 0:00" (`shots/09-chat-running-queued.png`).
- Proposal: "Running pnpm test · 0:42 · 6 tool calls · ↑12k ↓1.3k · Ctrl+. to stop", taken from the latest running tool item and live usage.
- Server/contracts: none for the tool part; live token counts need `usage` events during the turn (Codex sends `thread/tokenUsage/updated` during turns; Claude only at the end).
- Size S. Priority P2.

**22. A stopped turn is not marked**

- Where: `thread-view.tsx`, `items.tsx`.
- Today: after Ctrl+. the partial "Working on it" stays with no marker (`shots/09b-chat-stopped.png`); a Resume button appears only in the composer footer.
- Proposal: a muted line "Stopped by you · 20:41" at the end of the interrupted turn, with Resume on it.
- Server/contracts: none (`turns` already has state `interrupted`).
- Size S. Priority P3.

**23. No copy buttons on messages, code blocks or tool output**

- Where: `components/code-block.tsx`, `components/markdown-body.tsx`, `chat/items.tsx`.
- Today: none anywhere in chat (code; `shots/11b-chat-markdown-end.png`). Copy exists only for paths in the panel and run view.
- Proposal: on hover or focus of an assistant message: Copy (markdown) and Copy text; on code blocks: Copy and, for a fenced block with a path label, Open file; on tool output: Copy. Keys: with a message focused (Alt+Up/Down, finding 37), C copies it.
- Server/contracts: none.
- Size S. Priority P1.

**24. Compaction is not visible, and Codex has no Compact**

- Where: `thread-view.tsx` (`ContextMeter`), `provider-claude/src/adapter.ts`, `providerChatOptions.codex.compactPrompt = null`.
- Today: meter "50,000 / 200,000 context (25%)" and Compact for Claude only (`shots/05-chat-turn.png`). Claude's `compact_boundary` system message (manual or auto, with pre-compaction tokens in the SDK types) is not handled by the adapter (code: no match).
- Proposal: a divider "Conversation compacted (auto) · 152k → 18k" in the stream; the meter turns amber at 70 % and offers Compact in words ("Context 82 % full · Compact now"); `/compact` as a composer command; Codex compact when its app-server offers one (the generated subset in `provider-codex/src/protocol/generated` does not include such a method; check `codex app-server generate-ts`).
- Server/contracts: new `ProviderEvent` `compacted {trigger, preTokens?}` and item kind; Codex method only after checking the protocol.
- Size S. Priority P2.

**25. Background work cannot be looked at or stopped**

- Where: `chat/items.tsx` (`BackgroundIndicator`), contracts `BackgroundTask {id, description}`.
- Today: one line "Waiting for background work: Count the tea leaves" (`shots/20-chat-background.png`).
- Proposal: chips per task with elapsed time; open one for its output so far; Stop per task; "Send to background" (Ctrl+B like Claude Code) for a long running command or agent.
- Server/contracts: Claude SDK has `stopTask(taskId)`, a background control request for in-flight tasks, and `task_progress` / `task_notification` messages (seen in the SDK's `sdk.d.ts`). New `ProviderCommand`s `stopBackgroundTask {threadId, taskId}` and `backgroundTool {threadId, itemId?}`, and `BackgroundTask` with `startedAt`, `kind`, `lastOutput?`.
- Size M. Priority P3.

**26. The grouped tool row mixes signals**

- Where: `chat/items.tsx` (`ToolCallGroup`).
- Today: "Read README.md · 3 tool calls · 1 failed · done" (`shots/06-chat-tools.png`): the "done" belongs to the last call, not the group.
- Proposal: closed: a summary "Read 2 files, searched 1 pattern · 1 failed"; while running: the live latest call with its elapsed time.
- Server/contracts: none (needs `kind` from 13 for good wording).
- Size S. Priority P3.

### D. Composer

**27. A queued message and the draft are lost when you switch threads**

- Where: `apps/web/src/chat/composer.tsx` (`text`, `chips`, `queued` are component state), `app/router.tsx:87` (`<ThreadView key={threadId}>`).
- Today (code): the composer remounts per thread, so leaving a thread drops what you typed and a message queued with Enter during a running turn is never sent. Reloading the window drops it too.
- Problem: this is silent data loss in the core flow (write next instruction, glance at another thread).
- Proposal: drafts per thread kept in a store (text and chips) and restored on return; a queued message is held by the server, shown in the thread as "Queued · sent when the turn ends" with Edit and Cancel, and sent by the server when the turn ends (Claude: or into its input queue at once, which the SDK supports, so it lands within the turn as Claude Code does).
- Server/contracts: `thread.sendMessage` accepted while a turn runs, stored as a queued user item (`queued: true`) and started by the provider service at `turn.ended`; `thread.cancelQueued {threadId, itemId}`.
- Size M. Priority P1.

**28. No images or pasted screenshots**

- Where: `composer.tsx` (plain textarea), contracts `thread.sendMessage {text, skills}`, `ProviderCommand.startTurn {prompt: string}`.
- Today: text only (code).
- Proposal: paste (Ctrl+V) or drop an image: a thumbnail chip in the composer (Backspace removes it like a skill chip), click for full size; sent with the message and shown in the user bubble. Refused with the reason when the model takes no images (finding 3).
- Server/contracts: RPC `attachments.put {threadId, mediaType, base64}` storing under `~/.wow/attachments/<threadId>/`; `thread.sendMessage.attachments: [{id}]`; `startTurn.images: [{path, mediaType}]`. Claude: image content blocks in the `SDKUserMessage`; Codex: `UserInput` `{type: 'localImage', path}` exists in the generated protocol. Size limit as a setting.
- Size L. Priority P1.

**29. No @-mention of files**

- Where: `composer.tsx`, `chat/model.ts` (`typedTrigger`, `skillQuery`).
- Today: only the skill trigger exists.
- Proposal: `@` at a word start opens the file list of the thread folder (same mechanics as the skill list: typed only, paste opens nothing); a pick becomes a file chip; sent as the path in the text (both CLIs read files themselves), with an option to inline the content for small files. Chips in sent messages open the file in the panel.
- Server/contracts: `files.list` from finding 8.
- Size M. Priority P1.

**30. Workflow-only built-in skills lead the chat skill list**

- Where: `composer.tsx` (`SkillPicker`, `inPickerOrder`), `chat/view-model.ts` (`skillGroups`).
- Today: "/" opens with wow-artifacts, wow-handover, wow-pull-request, wow-verdict first (`shots/04-composer-skills.png`); Enter on the first entry picked wow-artifacts in our run (`05-chat-turn.png`). The list also covers the draft's provider and project pickers.
- Proposal: in chat, order Yours, Project, recently used, User, Plugins, then wow last; mark the four step skills "for workflow steps". Open the list downward or as a popover that does not hide the draft settings.
- Server/contracts: none (recent use can come from stored user items).
- Size S. Priority P2.

**31. Slash commands beyond skills**

- Where: `composer.tsx`, `chat/commands.ts`.
- Today: "/" lists skills only; typing `/compact` shows "No matching skills" and the text goes to the agent as is (code).
- Proposal: a "Commands" group at the top of the same list: `/model`, `/effort`, `/mode`, `/plan`, `/compact`, `/clear` (wow: new thread with the same settings and folder, the old one kept), `/fork`, `/resume`, `/rename`, `/done`, `/stop`, `/open <file|url>`. They run the palette commands. Below, the provider's own commands (Claude: built-ins and `.claude/commands`), sent as text.
- Server/contracts: the provider's list from Claude SDK `supportedCommands()` (in `sdk.d.ts`); a `ProviderEvent` `commands {list}` or an RPC `provider.listCommands {instanceId, cwd}`.
- Size M. Priority P1.

**32. Edit and resend the last message**

- Where: `chat/items.tsx` (`UserMessage`), composer.
- Today: not possible (code: no command).
- Proposal: Up in an empty composer, or Edit on the last user message, loads it into the composer; sending replaces the last exchange by forking the session at that point (the old branch stays reachable as "Earlier version" on the message).
- Server/contracts: Claude SDK `resumeSessionAt` plus `forkSession` (in `sdk.d.ts`) and `rewindFiles(userMessageId)` for file state; Codex rollback or fork if its app-server has it (not in the generated subset; to check). Contracts: `thread.editLast {threadId, text, skills?}` or the general fork of finding 36.
- Size L. Priority P2.

### E. Threads and navigation

**33. No notification when a chat thread needs you or finishes**

- Where: server `core/workflows.ts` and `core/triggers.ts` (the only `AppNotification` producers), `app/notifications.tsx`, `apps/desktop/src/main/index.ts`.
- Today (code): notifications exist for workflow gates, failed runs and triggers. A chat thread waiting for an approval or question, or a long turn finishing, produces nothing; only the sidebar count and the tray count change.
- Problem: the owner works in Claude Code and Codex in other windows; wow must tap him on the shoulder.
- Proposal: a desktop notification and toast "Needs you: <thread> · Allow pnpm test?" with Open (and, for an approval, Allow once / Deny as notification actions in the desktop app), and "Finished: <thread>" for turns longer than `chat.notifyAfterSeconds` when the thread is not on screen. Setting `chat.notifications` (off, needs you, needs you and finished).
- Server/contracts: projector emits `AppNotification` (kind `waiting` / new `finished`) with `threadId` on `thread.stateChanged` to `needs_you` and on turn completion; `AppNotification` gets `threadId?`.
- Size S. Priority P1.

**34. The thread list cannot be searched, renamed, filtered or archived**

- Where: `apps/web/src/chat/chat-view.tsx` (`ThreadList`), contracts `thread.*` commands.
- Today: groups Needs you / Working / Idle / Done, pin, titles from the first line (`shots/18-chat-1024.png`). The palette finds threads by title only (code: `value: title + id`). No rename, delete or archive command exists (code).
- Proposal: a filter field on top of the list (focus with Ctrl+Shift+F or `/` in the list) matching title, project and message text; project chips to filter; F2 / "Rename thread" in header and palette; "Archive" hides a thread from the list (kept and searchable); Delete with Undo. Arrow keys move in the list, Enter opens.
- Server/contracts: `thread.rename {threadId, title}`, `thread.setArchived`, RPC `threads.search {query}` over stored items (SQLite FTS).
- Size M. Priority P1.

**35. No "unread" state**

- Where: `chat-view.tsx`.
- Today: a thread that finished a turn while you were elsewhere looks the same as one you read (`shots/18-chat-1024.png`).
- Proposal: bold title and a small dot until opened; "Next unread" key (Alt+Shift+Down) and palette command.
- Server/contracts: `thread.markSeen {threadId}` storing `seenAt`; unread = `updatedAt > seenAt`. Stored on the server so the tray can count it.
- Size S. Priority P2.

**36. No fork, and no way to open a Claude Code or Codex session started in a terminal**

- Where: chat; `projects.discover` already reads the instances' session folders (code).
- Today: "Switch provider" starts an empty draft (`chat/commands.ts`); import brings folders only.
- Proposal: "Fork from here" on any user message (new thread from that point, same settings); palette "Open session from Claude Code / Codex…" listing recent sessions per folder with their first prompt, creating a wow thread that resumes it.
- Server/contracts: `thread.create` gains `resumeSessionId?` and `forkFrom? {threadId, itemId}`; Claude `forkSession` / `resumeSessionAt`; Codex `thread/resume` exists, fork to check; RPC `provider.listSessions {instanceId, cwd?}`.
- Size L. Priority P2.

**37. Long threads: no jump to latest, no message-to-message keys**

- Where: `thread-view.tsx` (`useStickToBottom`).
- Today: following stops when you scroll up, with no way back except scrolling; assistant messages have no time; user times only on hover (code, `05-chat-turn.png`).
- Proposal: a "↓ New output" pill when not following (End key too); Alt+Up / Alt+Down move focus between messages (then C copies, E edits, F forks); turn start time on each user message in the row, not on hover only.
- Server/contracts: none.
- Size S. Priority P2.

**38. One key to the next thing that needs you**

- Where: `app/use-commands.ts`, palette.
- Today: the palette lists "needs you" items first, which is good, but there is no single key that cycles through waiting threads, gates and proposals.
- Proposal: Ctrl+Shift+J "Next that needs you" goes to the oldest waiting approval, question, gate or proposal, wherever it is.
- Server/contracts: none.
- Size S. Priority P2.

**39. Sidebar order and Ctrl+number do not match**

- Where: `app/sections.ts`, keybinding defaults.
- Today: the sidebar reads Calendar, Chat, Workflows, Plans, Backlog, Assistant; the keys are Ctrl+1 Calendar, Ctrl+2 Chat, Ctrl+3 Workflows, Ctrl+4 Backlog, Ctrl+5 Plans, Ctrl+6 Assistant (`shots/01-shell-calendar-week.png`, `29-settings-keybindings.png`, user guide table).
- Proposal: swap the defaults so Ctrl+4 is Plans and Ctrl+5 Backlog, or swap the sidebar order.
- Server/contracts: none.
- Size S. Priority P3.

**40. The palette jumps as results shrink**

- Where: `app/palette.tsx` (`CommandDialog`).
- Today: the dialog is centred vertically, so its input moves from y≈300 to y≈410 when results get fewer (`shots/15-palette.png` against `16b-palette-model.png`).
- Proposal: anchor the dialog to the top fifth of the window.
- Server/contracts: none.
- Size S. Priority P3.

### F. Workflows, runs and gates

**41. What works well**: the run view's tabs with keys and URL state, the gate bar with Ctrl+Enter / Ctrl+Shift+Enter, the Changes tab with "This step only", PR / ticket / pages with "Last fetched" and Refresh now (`shots/30-run-gate-steps.png`, `31-run-changes.png`, `35-run-pr.png`, `36-run-ticket.png`, `37-run-pages.png`), and the page viewer (`38-run-page-in-panel.png`). The builder's per-step agent row reuses the chat selects (`27b-builder-step-scrolled.png`), so finding 1's bar should be used there too.

**42. The gate bar moves between the panel and the main view**

- Where: `workflows/run-view.tsx`, `workflows/gate-bar.tsx`, `panel/step-thread.tsx`.
- Today: with the conversation in the panel, the gate is at the bottom of the panel (`30-run-gate-steps.png`); open an artifact and it appears at the top of the main view instead (`32b-run-artifact-in-panel.png`).
- Proposal: the run view always carries the gate bar in one place (sticky at the top of the run view), the panel copy only when the panel shows the conversation; with panel tabs (finding 7) the conversation stays one tab away.
- Server/contracts: none.
- Size S. Priority P2.

**43. At 1024 px the panel covers the gate's buttons**

- Where: `panel/context-panel.tsx` (overlay below 1200 px), run view.
- Today: the overlay panel hides Approve / Send back / Stop; the gate text is cut ("Approve starts check-wo…") (`shots/42-run-1024.png`).
- Proposal: in overlay mode, show the gate bar inside the panel whatever it shows, or let the gate bar wrap its buttons under the text in the visible part.
- Server/contracts: none.
- Size S. Priority P2.

**44. Runs are listed below all workflow definitions**

- Where: `workflows/workflows-view.tsx`.
- Today: the left column lists 11 workflows, then "Runs" at the bottom (`shots/30-run-gate-steps.png`); with more workflows the live runs fall below the fold.
- Proposal: a "Runs" tab beside Workflows and Triggers, or live and waiting runs above the definitions.
- Server/contracts: none.
- Size S. Priority P2.

**45. Send back is free text only; no comments on diff lines**

- Where: `workflows/changes-tab.tsx`, `gate-bar.tsx`.
- Today: Send back opens a note field; the Changes diff has no way to point at a line.
- Proposal: in a diff, C on a line (or a click in the gutter) adds a comment; comments gather into the send-back note as `src/bell.ts:12 – …`; Ctrl+Shift+Enter sends them. Same in the chat thread Changes tab (finding 15) as a "Reply with comments".
- Server/contracts: none (the note is text).
- Size M. Priority P2.

**46. No "open in my editor"**

- Where: `workflows/changes-tab.tsx`, `panel/file-viewer.tsx`, `apps/desktop` runtime.
- Today: Copy path and "Open file" (in the panel) only (`31-run-changes.png`).
- Proposal: "Open in editor" (Shift+Enter) on changed files, artifacts and chat file links, using a setting `desktop.editorCommand` (default `code -g {path}:{line}`).
- Server/contracts: a desktop runtime call (`Runtime.openInEditor`), or a server RPC that spawns the configured command; it is local either way.
- Size S. Priority P2.

**47. "This step" badge on every changed file is noisy**

- Where: `workflows/changes-tab.tsx`.
- Today: every row carries a "This step" button-like badge and the narrow file column wraps "Binary file · 10 bytes" (`shots/31-run-changes.png`).
- Proposal: a small dot or bar for "this step", the label in the tooltip; a resizable split between list and diff.
- Server/contracts: none.
- Size S. Priority P3.

### G. Assistant

**48. What works well**: change rows with Undo, the proposal card with Yes / No, the secret field with the host's own token page and "Not set", the held-secret line, and the question card (`shots/46`, `47`, `48`, `49`, `49c-assistant-held.png`). Light theme reads well (`49d-assistant-light.png`).

**49. Raw tool rows repeat what the change rows say**

- Where: `assistant/rows.tsx`, `chat/items.tsx`.
- Today: every action shows a row "mcp__wow__set_setting calendar.workHours done" above its human row (`shots/46-assistant-change.png`, `48-assistant-secret.png`); "mcp__wow__ask_questions" above the card.
- Proposal: hide the tool row when a change, proposal, secret field or question card renders the same call; otherwise name tools in words ("Read your workflows").
- Server/contracts: none (`assistantToolOf` already maps names).
- Size S. Priority P2.

**50. Change rows print stored values, not what you set**

- Where: server `apps/server/src/assistant/changes.ts` (`show`), `assistant/rows.tsx`.
- Today: "Work hours: outlook (default) → 08:00–16:00 (monday, tuesday, wednesday, thursday, friday)" (`46-assistant-change.png`); workflow steps with model ids (`49b-assistant-workflow.png`).
- Proposal: format like the settings page ("From Outlook → 08:00–16:00, Mon–Fri"), models by label.
- Server/contracts: formatting in `show` per setting kind (the web's `settings/field-kind.ts` holds the same knowledge; share it through contracts).
- Size S. Priority P3.

**51. A waiting proposal can scroll out of sight**

- Where: `assistant/assistant-view.tsx`.
- Today: the sidebar shows "Assistant 1" while the proposal is far up the conversation (`49b-assistant-workflow.png`).
- Proposal: a line above the composer "1 proposal waits: Run scripts in HTML files · Yes / No / Show".
- Server/contracts: none.
- Size S. Priority P3.

### H. Calendar and plans

**52. What works well**: week and day grid, zoom, keyboard in the grid, the card form's trigger line and repeat words ("Every week on Wednesday at 20:45"), light theme and 1024 px (`shots/01`, `22b-card-dialog-repeat.png`, `23-calendar-light.png`, `19b-calendar-1024.png`).

**53. The card form does not fit a 900 px window**

- Where: `apps/web/src/calendar/card-dialog.tsx`.
- Today: with a workflow and a repeat, Notes and the Create card button are below the fold (`shots/22b-card-dialog-repeat.png`).
- Proposal: sticky footer (Delete left, Cancel and Create card right), Ctrl+Enter saves; workflow and repeat side by side above 1200 px.
- Server/contracts: none.
- Size S. Priority P2.

**54. Plan files cannot be opened, and a unit cannot start a chat**

- Where: `apps/web/src/plans/plans-view.tsx`, `panel/viewer.ts`.
- Today: intent.md, spec.md and plan.md are listed with status but are not links (`shots/41-plan-detail.png`); `openFile` is called only from runs (code).
- Proposal: Enter on a file opens it rendered in the panel; on a unit, "Start a thread for this unit" opens a draft in the project with the unit's contract as the first message (and "Run with <workflow>" stays).
- Server/contracts: `files.read` with a `{projectId, path}` scope (same union as finding 8).
- Size S. Priority P2.

### I. Settings

**55. Settings are thorough; chat preferences are thin**

- Where: `settings/settings-page.tsx`, settings registry.
- Today: Chat has context meter, resume message, group tool calls, starters, skill character (`shots/29-settings-chat.png`). Providers, trackers, keybindings and skills are clear (`29-settings-providers.png`, `29-settings-trackers.png`, `29-settings-keybindings.png`, `29-settings-skills.png`, `29b-provider-editor.png`).
- Proposal: add the settings the findings above need: `chat.notifications`, `chat.notifyAfterSeconds`, `chat.reasoningOpen`, `chat.sendKey` (Enter or Ctrl+Enter), `desktop.editorCommand`, attachment size limit, `files.listLimit`; and per project a default provider instance, model, effort and mode (projects hold different kinds of work).
- Server/contracts: settings registry entries (project scope already exists in the registry).
- Size S. Priority P3.

### J. General polish and bugs seen

**56. Yellow "needs you" text is hard to read in the light theme**

- Where: `apps/web/src/styles/tokens.css` (`--state-needs-you: oklch(0.75 0.16 85)` on `--background: oklch(0.99 0 0)`).
- Today: that colour is used for text such as "waiting for approval" and "Waiting for you"; by the token values the contrast is about 2:1 (code, not measured on a shot).
- Proposal: a darker text variant for light (around `oklch(0.55 0.13 75)`), keeping the bright one for dots and borders.
- Server/contracts: none.
- Size S. Priority P2.

**57. Small wording and consistency slips**

- Where: `workflows/path-tab.tsx`, `workflows/ticket-tab.tsx`, `panel/workflow-panel.tsx`, `providerChatOptions`.
- Today: "waiting for you" in lower case on the Path tab while everywhere else says "Waiting for you" (`33-run-path.png`); "Found in the issue its backlog item was published as" (`36-run-ticket.png`); the run panel offers "Open run" while that run is open (`35-run-pr.png`); "Do not ask (deny what is not allowed)" reads backwards (`14-chat-permission-select.png`); "Took 0 s".
- Proposal: "Waiting for you"; "From the backlog item's Jira issue"; hide "Open run" when the run view shows that run; "Deny unless allowed"; "Took under 1 s".
- Server/contracts: none.
- Size S. Priority P3.

**58. Diagram labels sit in grey boxes over the edges, and the paths diagram clips**

- Where: `components/mermaid.ts` theme variables, `workflows/paths-diagram.ts`.
- Today: "send back" and "gate" labels are drawn in grey boxes over the arrows (`11b-chat-markdown-end.png`, `26-builder-new.png`); the last label of the paths diagram is cut at the bottom ("verdict changes requested", `26-builder-new.png`).
- Proposal: transparent edge label background in both themes; the paths panel scrolls or fits its height.
- Server/contracts: none.
- Size S. Priority P3.

## Proposed order of work

Each batch is one unit-sized piece one agent builds and another reviews. Batches on the same line
touch mostly different files and can be built side by side.

1. **P1, first pair**
   - Batch 1 "Model bar" (findings 1, 2, 3, 6; 5 as a follow-on): `chat/thread-settings.tsx`, `chat/thread-view.tsx` header, `chat/new-thread.tsx`, `chat/commands.ts`, `assistant/assistant-view.tsx` header, `ProviderModel` in contracts and the two adapters' `listModels`.
   - Batch 2 "Notifications and thread list" (33, 34, 35): server projector and notifications, `app/notifications.tsx`, desktop notification actions, `chat/chat-view.tsx`, new `thread.rename`, `thread.setArchived`, `thread.markSeen`, `threads.search`.
2. **P1, second pair**
   - Batch 3 "Composer state" (27, then 31): `chat/composer.tsx`, `chat/composer-store.ts`, server queued messages in the provider service.
   - Batch 4 "Tool rows" (13, 16, 23, 26, 22): split `chat/items.tsx` into `chat/tools/*` renderers; `ToolCallItemPayload` and `toolCallCompleted` fields; adapters' tool mapping.
3. **P1, third pair**
   - Batch 5 "Panel frame and files in chat" (7, 8, 11, then 29 for `@`): `panel/*`, `FileReadParams` union, `files.list`, `components/markdown-body.tsx` path links.
   - Batch 6 "Diffs and approvals" (14, 15, 19, 20): edit payload in adapters, `threads.diff`, `ApprovalRow` moved to `chat/approval-card.tsx`, `ApprovalDecision` and `ApprovalKind` changes. Builds on batch 4's renderers, so it starts after batch 4 is merged; it pairs with batch 5, which touches other files.
4. **P1, fourth pair**
   - Batch 7 "Host links in chat" (9, 10): `hosts.lookup`, `thread:` scope, GitHub and GitLab issue reads, chips in `markdown-body.tsx`, panel tabs for PR / ticket / page. After batch 5.
   - Batch 8 "Images" (28): attachments RPC and storage, `startTurn.images` in both adapters, composer chips. After batch 3.
5. **P2**
   - Batch 9 "Run review polish" (42, 43, 44, 46, 47, 45): `workflows/run-view.tsx`, `gate-bar.tsx`, `workflows-view.tsx`, `changes-tab.tsx`, desktop editor command.
   - Batch 10 "Conversation reading" (4, 18, 21, 24, 37, 38, 30): `thread-view.tsx` conversation part, `items.tsx` reasoning and working line, compaction event, settings-changed item, skill list order.
   - Batch 11 "Subagents and background" (17, 25): Claude adapter `parent_tool_use_id`, Codex collab items, nested items in the projector, background task commands.
   - Batch 12 "Fork, edit and sessions" (32, 36): `thread.create` with resume and fork, Claude `forkSession` / `resumeSessionAt` / `rewindFiles`, Codex after checking its protocol.
   - Batch 13 "Assistant, calendar and plans polish" (49, 50, 51, 53, 54, 56): `assistant/rows.tsx`, server `assistant/changes.ts`, `calendar/card-dialog.tsx`, `plans/plans-view.tsx`, `styles/tokens.css`.
6. **P3 sweep**: batch 14 (5, 39, 40, 55, 57, 58): small, mostly one file each.

Finding count: 58 numbered entries; 12, 41, 48 and 52 are short "what works well" notes. The
other 54 are findings: P1 18, P2 22, P3 14.
