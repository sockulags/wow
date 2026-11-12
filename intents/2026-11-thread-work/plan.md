---
intent: 2026-11-thread-work
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: A chat thread's work after the agent has changed files

Execution: five units in the owner's order of value, each by a worker and an independent
reviewer. U1, U2, U3 and U5 have no dependency between them and may be built at the same time in
different working copies; U4 starts once U2 is merged. Files several units touch are changed only
in the parts named: `chat/thread-view.tsx` (U1 the find bar, U2 the copy chip, U3 the restore
line and Edit's choice, U5 the tools chip), `panel/thread-panel.tsx` (U2 the copy lines, U5 the
link to Tools), `providers/service.ts` (U2 `prepareThread`, U3 the snapshots, U4 `propose`, U5
`describeSession`) and `core/threads.ts`. Every unit updates `docs/architecture.md` (its section,
the settings list, the data model) and `docs/user-guide.md`, adds a line to
`docs/windows-smoke.md` for each provider or Windows fact it relies on, and leaves the repository
checks green. Migrations are numbered from 0034 in merge order. Sketches are written by sketch
cases: `WOW_E2E_SKETCHES=1 pnpm e2e -- --trace off -g sketch`. The mock provider is the scripted
one in `apps/web/e2e/server.ts`, which picks its events by words in the prompt; server tests use
`MockProviderAdapter` (`apps/server/src/hooks/providers.ts`), `MockGitHub` and `MockGitLab`.

## Units

- [U1] Find in the conversation and copy it
- [U2] A chat thread in its own working copy
- [U3] Restore files when going back
- [U4] Commit and pull request from a thread's Changes — depends on U2
- [U5] What the session can use

### U1 Find in the conversation and copy it

Outcome: Ctrl+F finds text anywhere in a chat thread's conversation, opening what holds a match;
the conversation copies and saves as Markdown with one line per tool call.
Boundaries: web and desktop only; no server contract, no search across threads (the thread
list's filter stays as it is). Not in the Assistant view or a step thread in the side panel. No
tool output, input or reasoning in the export unless the setting says reasoning.
Change surface: new `apps/web/src/chat/find.ts`, `chat/find-bar.tsx`,
`chat/conversation-markdown.ts`; `chat/thread-view.tsx` (bar above the conversation, header
menu), the open state of `chat/tools/row.tsx`, `group.tsx`, `output.tsx`, `agent.tsx` and the
reasoning row in `chat/items.tsx` (opened by find, as by a click); `chat/conversation-nav.ts`
(find commands); `app/runtime.tsx` (`saveTextFile`); `apps/desktop/src/preload/index.ts` and
`main/index.ts` (`wow:save-text-file`); settings for the keys, `chat.findMaxMatches`,
`chat.exportReasoning`; the mock's "tell the kettle story"; sketch `sketches/find-bar.png`.
Acceptance:

- Given a thread whose reply holds `**kettle**`, a command row whose 40-line output has "kettle"
  on line 3, a closed group and closed reasoning holding "kettle", when Ctrl+F is pressed in the
  composer and "KETTLE" typed, then the bar reads "1 of 5", F3 and Enter go forward, Shift+F3 back,
  wrapping, and each match's row, group, reasoning and "Show all 40 lines" open (spec 1 to 4).
- Given the JSON behind Show JSON and an earlier version holding the word, then they are not
  counted; given `chat.findMaxMatches` 3, the bar reads "3+" (spec 2, 3).
- Given a streaming turn that adds a match, then the count grows and the current match stays on
  its item (spec 5).
- Given Escape in the bar, then the focus returns to the composer and opened rows stay open; the
  palette lists Find in conversation, Find next and Find previous (spec 1, 6).
- Given "Copy conversation as Markdown", then the clipboard holds the title, the facts line, "You
  · <time>" and agent headings, and exactly one line per tool call, approval, question, error,
  divider and task update, worded as the rows; no output, no JSON, no reasoning, no earlier version
  (spec 7, 8).
- Given "Save conversation…" in the desktop app, then the main process shows the save dialog with
  the sanitized title and writes the text; in the browser build a download starts (spec 7).
- Given the Assistant view, then Ctrl+F and the export commands are not offered (spec 9).

Ground truth: `pnpm --filter @wow/web test` (matching over each item kind, count and limit,
opening, keys, the Markdown for each item kind), `pnpm --filter @wow/desktop test` (the save
channel answers only `wow://app`, writes UTF-8, null on cancel); `pnpm e2e` case "finds text in
closed rows and copies the conversation" in `chat.spec.ts`; the mock learns "tell the kettle
story" (two replies, a long command output, a group of reads, reasoning, all naming the kettle);
repository checks.
Dependencies: none inside this plan. It builds on the workbench's rows (`chat/tools/`), copy
helpers (`components/copy-button.tsx`) and conversation commands.
Evidence and settled decisions: find and export read the rows with the rows' own words; the
shell writes the export (spec Interface, Decisions).
Delivery target: commit on the delivery branch.
Open risks: rendered text through mdast may differ from the screen for footnotes or diagrams;
the row outline is the fallback (spec Open risks).

### U2 A chat thread in its own working copy

Outcome: a chat thread in a Git project can work in its own worktree on its own branch, shown in
the thread, settled when the thread is done, removed only with a yes when work would be lost.
Boundaries: chat threads in a project only; runs' working copies keep their behavior (shared code
only). No branch deletion, no push, no pull request (U4). No change to Changes, files or `@`
beyond using the thread's folder.
Change surface: contracts `Thread.workingCopy`, `thread.create.ownWorkingCopy`, the three internal
`thread.workingCopy*` commands, RPCs `threads.workingCopyStatus` and `threads.removeWorkingCopy`,
`branchName`, settings `chat.ownWorkingCopy`, `chat.workingCopyBranch`, `chat.workingCopyStart`;
server `workspaces/service.ts` (`prepareThread`, settle, `removeThread`, `recover`),
`workspaces/working-copy.ts` (new branch, again on its branch), `projects/git.ts`
(`addNewBranchWorktree`, `checkBranchName`), `core/threads.ts` (create, done, the copy events),
the projector, `providers/service.ts` (await `prepareThread`), a migration; web
`chat/new-thread.tsx` (switch and line), `chat/thread-view.tsx` (chip), `panel/thread-panel.tsx`
(lines, Remove), new `chat/working-copy.tsx`; sketch `sketches/thread-copy.png`.
Acceptance:

- Given project `tea-mug` with `chat.ownWorkingCopy` on, then `/chat/new` shows the switch on and
  "New branch wow/<slug>-<id> from main (<sha>)"; a folder without a project shows none (spec 10).
- Given the first message, then the worktree exists under `workspaces.root` on that branch before
  the mock is called, the mock's edit lands there, and the project folder's files, index and
  branch are unchanged (spec 11).
- Given the branch name taken or a folder that is not a repository, then the turn fails with
  git's reason, the provider got nothing, and Retry works once the cause is gone (spec 12).
- Given the thread, then the chip and Details show the branch and path; Copy path copies it
  (spec 13).
- Given Mark done with only commits, then the copy is removed and the branch keeps them; with an
  uncommitted and an ignored file, it is kept and says so (spec 14).
- Given Remove with an uncommitted file, then the dialog names it and removes only on "Remove and
  lose them"; given a file added after it opened, the server refuses with the new counts; given a
  running turn or another live thread in the folder, it is refused (spec 15).
- Given a message after removal, then the copy is made again on its branch; given the branch
  deleted, the turn fails with the reason (spec 16). A fork works in the same folder (spec 17).
- Given threads stored before, then they load with no copy (spec 18).

Ground truth: `pnpm --filter @wow/contracts test` (`branchName` against Git's rules and case),
`pnpm --filter @wow/server test` (create, fail, settle, remove, again on its branch, restart,
old rows, against repositories the tests make, cloned with `core.autocrlf=false`), `pnpm --filter
@wow/web test` (draft switch, chip, dialog); `pnpm e2e` case "a thread works in its own working
copy" in `working-copy.spec.ts`; the Changes server copy seeds project `tea-mug` (its own
repository with a bare `origin`); the mock already edits in a folder under `<home>/workspaces`;
repository checks.
Dependencies: none inside this plan. It builds on the review loop's working copies
(`workspaces/`) and the workbench's Changes, which measures the thread's folder.
Evidence and settled decisions: a thread's copy is on a branch and starts at the project folder's
commit; commits on the branch do not hold a removal (spec Decisions). Today `createWorkingCopy`
makes a copy on no branch except for a run at a pull request's head, and a chat thread's
`branch` column exists (shown in Details) but nothing sets it.
Delivery target: commit on the delivery branch.
Open risks: Windows path length and a file locked during removal; the copy is kept with the
reason, as for runs.

### U3 Restore files when going back

Outcome: Edit of the last message and "Restore files to here" can put the thread's files back to
a turn's start from snapshots wow keeps, after showing what changes and what someone else
changed, with Undo.
Boundaries: chat threads whose folder is in Git; not step threads or the Assistant. No change to
how Edit and Fork go back in the provider's conversation. No HEAD, index, branch, stash, commit
or ignored file is touched. Nothing is written to the user's repository.
Change surface: new `apps/server/src/files/snapshots.ts` (take, compare, restore, expire),
`projects/git.ts` (the plumbing in the spec's Interface, run with `GIT_DIR` set to wow's store),
`providers/service.ts` (start snapshot in `#marked`, end snapshot after `turn.ended`, restore
before an edit's turn), `core/threads.ts` and `core/go-back.ts` (`thread.restoreFiles`,
`thread.undoRestore`, `editLast.restoreFiles`, `thread.snapshotTaken`), the projector, an RPC
handler for `threads.restorePreview`, a migration; contracts `TurnSnapshot`, `Turn.restorable`,
`RestorePreview`, `FilesRestoredItemPayload`, the settings; web `chat/items.tsx` (button and line),
new `chat/restore.tsx` (confirm), `chat/composer.tsx` (Edit's choice only),
`chat/conversation-nav.ts` (R); sketch `sketches/restore.png`.
Acceptance:

- Given two turns that edit `src/bell.ts`, add `docs/notes.md` and delete `docs/old.md`, then
  each turn has start and end snapshots in `<wow home>/snapshots`, the repository's objects,
  refs and index are byte for byte as before, and an ignored `.env` is in neither (spec 19).
- Given "Restore files to here" on the first message, then the confirm lists `src/bell.ts` and
  `docs/old.md` written back and `docs/notes.md` deleted; after Enter the files equal the first
  snapshot, CRLF kept, `.env` untouched, and the line shows with Undo; Undo brings back the state
  before (spec 20, 22, 24).
- Given Edit with "Conversation and files", then the restore runs before the mock gets the new
  message; given a restore that fails, the mock gets nothing (spec 21).
- Given a file changed by the test after the last turn ended, then it is listed as changed
  outside and the button reads "Restore anyway"; a command whose `confirmed` lists differ is
  refused with `conflict` (spec 22).
- Given a folder outside Git, an old turn, a running turn, a link out of the folder and a file
  over `chat.snapshotMaxFileBytes`, then each says why; the large file is named and the rest
  waits for a yes (spec 23).
- Given a commit made after the turn, then HEAD and the commit stay and the files show as changes
  (spec 25); given `chat.snapshotKeepDays` passed on the test clock, the turn offers no Restore
  (spec 26); old turns offer none (spec 44).

Ground truth: `pnpm --filter @wow/server test` (snapshots against real repositories: tracked,
untracked, ignored, CRLF, executable bit where the system has one, links, limits, outside
changes, Undo, expiry by an injected clock, a Windows run of the path rules), `pnpm --filter
@wow/web test` (confirm, Edit's choice, R, the line); `pnpm e2e` case "restores files to before a
message and undoes it" in `changes.spec.ts`, project `tea-chat`; the mock learns "add the notes"
(adds `docs/notes.md`, deletes `docs/old.md`), and the test writes a file between turns as an
editor would; repository checks.
Dependencies: none inside this plan. It builds on the workbench's Edit (`core/go-back.ts`) and
turn marks (`#marked` in `providers/service.ts`).
Evidence and settled decisions: wow's own store, raw bytes, end snapshots to tell outside
changes (spec Decisions). Claude Code's `rewindFiles` is declared in the SDK types; it is not
used, since it is Claude's only and is said to cover only its file tools.
Delivery target: commit on the delivery branch.
Open risks: the first snapshot of a large folder delays the first turn; files locked on Windows
(spec Open risks).

### U4 Commit and pull request from a thread's Changes

Outcome: from a chat thread's Changes the user commits chosen files with hooks running and a
message the agent may propose, and opens a pull or merge request whose chip shows in the thread.
Boundaries: chat threads only; whole files; no amend, merge, rebase, pull, force push, branch
deletion or review action. The assistant gets no tool. Polling of hosts is unchanged.
Change surface: contracts `CommitPlan`, `CommitRefusal`, `PullRequestPlan`, the RPCs, the
`propose` ProviderCommand, item kinds `committed` and `change_request_opened`, the internal
commands, the settings; server `projects/git.ts` (status, hooks, commit, push), new
`apps/server/src/workspaces/thread-git.ts` (plans, commit, push, open), `hosts/adapter.ts`,
`hosts/github.ts`, `hosts/gitlab.ts`, `hosts/mock-github.ts`, `hosts/mock-gitlab.ts`,
`providers/service.ts` (`propose` only), both adapters' `propose`; web `chat/thread-changes.tsx`
(buttons), new `chat/commit-dialog.tsx` and `chat/pull-request-dialog.tsx`, the two lines in
`chat/items.tsx`; sketch `sketches/commit-dialog.png`.
Acceptance:

- Given a thread in `tea-mug`'s working copy that edited `src/bell.ts` and a file the user
  changed, then Commit… ticks the first only and lists the hook `pre-commit` (spec 27).
- Given Propose, then the mock's `propose` gets the diff of the ticked file and no tools, the
  thread's conversation is unchanged, and "Ring the bell twice" fills the field (spec 28).
- Given Commit, then only the ticked file is in the commit, a staged other file stays staged, the
  hook's mark file exists, the line shows the sha and subject; given a refusing hook, its output
  shows and nothing is committed (spec 29).
- Given an empty message, a running turn or a rebase in progress, then each is refused; given a
  detached HEAD, Commit needs a new branch name and commits on it (spec 30).
- Given Open pull request…, then target `main`, the commits, title and body show; Open pushes to
  the bare `origin` with the upstream set, `MockGitHub` gets one `POST …/pulls`, and the thread
  shows "Opened pull request #<n>" with a chip opening the tab (spec 31, 32).
- Given no token, a protected branch, the target as branch, or no commit ahead, then nothing is
  pushed and the reason names the setting or fact; given an open pull request, the dialog offers
  Open in panel and Push the new commits (spec 33).
- Given `MockGitHub` refusing with 422, then its message shows, the branch stays pushed and Open
  works again (spec 34); given GitLab, a merge request with "Draft:" (spec 31).
- Given a push that needs credentials, then it fails without waiting and says to push in a
  terminal; the token is in no git argument or environment (spec 35, 36).

Ground truth: `pnpm --filter @wow/server test` (commit and push against a local bare repository,
hooks that mark and refuse, `--no-verify` absent from every argument list, refusals, host
requests to `MockGitHub` and `MockGitLab`, the token only in the host header), both adapters'
tests (`propose` options: no tools, no session kept, empty folder), `pnpm --filter @wow/web test`;
`pnpm e2e` cases "commits with a proposed message and opens a pull request" in `changes.spec.ts`
and "opens a merge request from a thread" in `gitlab.spec.ts`; `tea-mug` gets a tracked
`hooks/pre-commit` with `core.hooksPath=hooks` and project GitHub settings for `acme/tea-mug` on
`MockGitHub`; the mock answers `propose` with fixed text; repository checks.
Dependencies: U2, whose thread branch and working copy are the main case the dialogs and their
tests are written for.
Evidence and settled decisions: hooks run on the user's click; push with Git's credentials, open
with the host token; proposals outside the conversation (spec Decisions, Security). Today every
wow git command turns hooks off and host adapters only read.
Delivery target: commit on the delivery branch.
Open risks: hooks needing programs on Windows; push without a credential prompt (spec Open
risks).

### U5 What the session can use

Outcome: a Tools tab lists the MCP servers with state and error, the tools, skills, commands,
subagents and plugins the provider reported for the thread's session, with nothing secret.
Boundaries: read-only: no sign-in, reconnect, toggle or probe; nothing starts a session or an
MCP server. Not for the Assistant. The composer's `/` list keeps `provider.listCommands`.
Change surface: contracts `SessionTools`, `McpServerInfo`, ProviderEvent `sessionTools`,
ProviderCommand `describeSession`, RPC `threads.refreshTools`, internal `thread.toolsReported`,
topic `threadTools`; server projector and table `thread_tools`, a migration,
`providers/service.ts` (`describeSession` only); Claude adapter (`system/init`,
`system/commands_changed`, `mcpServerStatus()`, `supportedAgents()`, the `ClaudeQuery` seam);
Codex adapter (`instructionSources`, the generator's `METHODS` and `FIELDS`); web new
`panel/tools-tab.tsx`, the tab kind in `panel/viewer.ts`, the chip in `chat/thread-view.tsx`, the
Details link in `panel/thread-panel.tsx`; mocks; sketch `sketches/session-tools.png`.
Acceptance:

- Given a Claude session whose init names three servers and whose status calls answer one
  connected with two tools, one failed with "spawn tea-tracker ENOENT" and one needing sign-in,
  then the tab shows them with states, the error, source, version and tools, plus built-in tools,
  skills, commands, subagents and plugins with counts; the filter narrows all (spec 37, 38).
- Given a server config with `env`, `headers`, `args` and a URL with a path and `?key=`, then no
  value of them reaches the event, the table or the page; the address shows as origin or program
  name (spec 41).
- Given the header, then "1 MCP server failed" shows and opens the tab (spec 37).
- Given a live session, then Refresh asks it again and stores only a changed list; given none,
  Refresh is not offered and no adapter call is made (spec 39); needs sign-in reads "Sign in from
  Claude Code: /mcp in a terminal" (spec 40).
- Given Codex, then the tab shows the instruction files and the servers seen in the thread's MCP
  calls, with the line that Codex reports no list (spec 42).
- Given the Assistant and an old thread, then no tab, and an empty tab until the next turn
  (spec 43, 44).

Ground truth: `pnpm --filter @wow/provider-claude test` (init, status, agents, commands changed,
the secret-bearing config, a failing status call giving `complete: false`), `pnpm --filter
@wow/provider-codex test` (instruction files; the generator run recorded in the pull request),
`pnpm --filter @wow/server test` (stored only when changed, refresh without a session asks
nothing, the assistant refused), `pnpm --filter @wow/web test`; `pnpm e2e` case "lists what the
session can use" in `chat.spec.ts`; the mock Claude reports servers `tea-docs` (connected),
`tea-tracker` (failed) and `tea-cloud` (needs sign-in) at each turn, the mock Codex instruction
files only; repository checks.
Dependencies: none inside this plan.
Evidence and settled decisions: reports, never probes; named fields only (spec Decisions). The
SDK types declare the init message's lists and `mcpServerStatus()`; Codex's generated protocol
has no list method.
Delivery target: commit on the delivery branch.
Open risks: no Codex list unless the regenerated protocol has one; Claude facts read from types
only (spec Open risks).
