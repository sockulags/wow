---
intent: 2026-11-thread-work
rev: 1
built_on: intent@1
status: accepted
---

# A chat thread's work after the agent has changed files

## Summary

Five things a chat thread still lacks next to Claude Code and the Codex app once the agent has
changed files, in the owner's order of value. Ctrl+F finds text anywhere in a conversation and
the conversation copies or saves as Markdown. A thread in a Git project can work in its own
working copy and branch. Going back in a conversation can put the files back too, from a
snapshot wow keeps of every turn. The Changes tab commits and opens a pull or merge request. A
Tools tab shows what the session can use. Everything here is the user's action from the
keyboard; the agent and the assistant start none of it.

This intent builds on the agent workbench (`intents/2026-11-agent-workbench`) and on the review
loop's working copies, and names their files and functions as they are at 0.3.5.

## Behavior

### Find in the conversation and copy it

1. While a chat thread's conversation is on screen (the chat view, also for a workflow step's
   thread opened there), Ctrl+F opens a find bar above the conversation with its field focused,
   wherever the focus is in the view, the composer included. Pressed again it selects the field's
   text. Escape in the bar closes it and puts the focus back where it was.
2. Matching starts as the user types and ignores case for every letter. It matches the text the
   conversation shows: messages as rendered (`**bold**` is found as "bold"), reasoning, each tool
   row's line and its whole output, an edit's diff lines, the shown text of approval, plan and
   question cards, error, divider and compaction lines, task lists, and a subagent's nested rows
   and answer. It does not match the JSON behind Show JSON or Details, earlier versions of an
   edited message, or the composer.
3. The bar reads "3 of 12", "No matches", or the limit and a plus ("1000+") once there are more
   matches than `chat.findMaxMatches`. Enter or F3 goes to the next match and Shift+Enter or
   Shift+F3 to the previous one, wrapping at the ends; the bar has Previous and Next buttons. The
   current match is scrolled into view and marked in a stronger colour than the others.
4. A match inside something closed opens it: a tool row, a closed group of tool calls, reasoning,
   a subagent's nested list, or the earlier lines of an output ("Show all N lines"). What find
   opened stays open after the bar closes, as if opened by hand.
5. While a turn streams, the count follows the new text; the current match stays on the item it
   was on and the view moves only while the conversation follows the bottom.
6. The palette has "Find in conversation", "Find next" and "Find previous" while a chat thread is
   on screen. The keys are settings.
7. "Copy conversation as Markdown" (palette, and the thread header's menu) puts the conversation
   on the clipboard as Markdown. "Save conversation…" saves the same text as a `.md` file: in the
   desktop app through the system's save dialog, in the browser build as a download. The file
   name comes from the thread's title, with characters Windows refuses taken out.
8. The Markdown holds the title as a heading; one line with the provider instance, model,
   project, folder and branch; the time of export; then each exchange: "You · 20:41" and
   "Claude Code · 20:42" (the instance's name) headings with the message as written (the `@path`
   line kept, images as `[image: <name>]`, skills as one line), and every tool call, approval,
   plan, question, error, divider, compaction and task list update as one list line, worded as
   the conversation words it ("$ pnpm test · exit 1 · 4.2 s", "Edit src/timer.ts +4 −1",
   "Allowed once: $ pnpm test", "Denied: $ rm -rf build · note: keep the build"). A subagent call
   is its line and its answer. It holds no tool output, no tool input, no reasoning (unless
   `chat.exportReasoning`), no earlier version and no queued message: nothing the conversation
   does not show.
9. The Assistant view has neither find nor export: its rows are its own and its conversation
   holds the secret-field and change cards.

### A chat thread in its own working copy

10. On `/chat/new`, when the chosen project's folder is in a Git repository with a commit, the
    draft shows a switch "Own working copy" that starts from the project's `chat.ownWorkingCopy`
    (off by default), with a palette command. Under it the draft says where the copy starts and
    on which branch, such as "New branch wow/ring-twice-3fa2c1 from main (4e1d2a0). Uncommitted
    changes in the project folder stay there." A folder without a project, or one not in Git,
    shows no switch.
11. With the switch on, the thread works in a Git worktree of the project's repository under
    `workspaces.root`, on a new branch named by `chat.workingCopyBranch`, starting where
    `chat.workingCopyStart` says: the commit the project folder is on (the default) or the
    default branch's tip after a fetch (when `workspaces.fetchBeforeCreate` is on). The thread's
    folder is that working copy: its turns, Changes, file links, `@`, Open in editor and the
    agent's commands work there. The project folder's files, index and branch are not touched.
12. The copy is made before the first message goes out. When it cannot be made (not a
    repository, no commit, the branch name taken, the path too long, git's own message), the
    first turn fails with the reason and nothing is sent to the provider; nothing falls back to
    the project folder. Retry tries again.
13. The header shows a chip with the branch and "own working copy". Details shows the branch,
    the working copy's path with Copy path and Open in editor, where it started and, when that
    is not what the setting asked for, why.
14. When the thread is marked done and no turn runs, wow settles the copy as it settles a run's:
    it is removed when nothing in it would be lost (no uncommitted, untracked or ignored file);
    the branch and its commits stay. Otherwise it is kept, and the chip and Details say what it
    holds, such as "2 uncommitted files, 1 ignored folder · 3 commits on wow/ring-twice-3fa2c1".
15. "Remove working copy" (Details, palette) shows what would be lost, read at that moment, and
    removes only after "Remove and lose them"; with nothing to lose it removes after a plain
    confirm. It is refused while a turn runs, while another thread that is not done works in the
    same folder, and when the copy holds more than the dialog showed (the dialog shows the new
    counts and asks again). Commits stay on the branch. wow never deletes a branch and never
    pushes here.
16. A message to a thread whose copy was removed makes the copy again on its branch before the
    turn goes out. When the branch is gone or another folder is on it, the turn fails with git's
    reason.
17. A fork of such a thread works in the same working copy and on the same branch.
18. Threads stored before this change have no working copy and work as they did.

### Restore files when going back

19. For a chat thread whose folder is in Git, wow keeps a snapshot of the folder at each turn's
    start and end: every file Git tracks and every untracked file Git does not ignore, byte for
    byte. Ignored files (build output, a local `.env`) are never in a snapshot and never touched
    by a restore.
20. "Restore files to here" on a user message (a button on hover or focus, R on the focused
    message, a palette command) puts the thread's folder back to the snapshot taken when that
    message's turn started: changed files get their content back, files that did not exist then
    are deleted, deleted files come back, and folders a delete leaves empty go. The conversation
    does not change, so this works on Codex too, which cannot go back in its conversation.
21. Edit of the last message (Up, E, the Edit button) offers "Conversation only" (as today) and
    "Conversation and files", the default from `chat.editRestoresFiles`. The second restores the
    files to the start of the replaced turn before the new message goes out; when that restore
    fails, nothing is sent and the turn's error says why.
22. Before anything is written, a confirm lists what the restore does: the files written back and
    the files deleted. Files that changed after the thread's last turn ended (by the user, an
    editor, another thread or program) are listed first as "Changed outside this thread since its
    last turn", and the button then reads "Restore anyway". Enter confirms, Escape cancels.
23. Restore is refused with the reason in words for a folder not in Git or without git; a turn
    without a snapshot (stored before this change, snapshots off, the folder over
    `chat.snapshotMaxFiles`, git out of time); a running turn; a path that leads outside the
    folder, through a link or a junction; a workflow step's thread and the Assistant. A file that
    was larger than `chat.snapshotMaxFileBytes` when the snapshot was taken cannot be restored:
    the confirm names it, and the rest is restored only after a yes.
24. After a restore the conversation shows a line such as "Files restored to before "Make the
    bell ring twice" · 4 written, 1 deleted" with Undo. Undo puts the files back as they were
    just before the restore, with the same confirm and check. It is offered until the next turn
    starts or another restore is made.
25. A restore never changes HEAD, a branch, the index, the stash, a commit or an ignored file.
    Commits the agent made after that turn stay, so the restored files show as changes against
    them. The Changes view and chip read again after a restore.
26. A snapshot is kept for `chat.snapshotKeepDays` days; then it is dropped and its turn no longer
    offers Restore.

### Commit and pull request from a thread's Changes

27. The Changes view of a chat thread (not a step's) has "Commit…" (a key and a palette command).
    The dialog lists every changed, deleted and new file of the folder that Git does not ignore,
    with added and removed lines; the files of the thread's own Changes are ticked and the others
    are not. It shows the branch the commit goes on, a message field, and the commit hooks that
    will run (the hook names found in the repository's hooks folder or its `core.hooksPath`), or
    "No commit hooks".
28. "Propose" in the dialog asks the thread's provider instance and model for a message: a
    one-off request without tools, outside the thread's conversation and session, given the
    chosen files' diff (cut at `chat.proposalPatchMaxBytes`) and the thread's title through
    `chat.commitMessageTemplate`. The answer fills the field and stays editable. While it is
    asked the field reads "Writing a message…" with Cancel. Nothing is committed until Commit.
29. Commit (Ctrl+Enter in the dialog) commits exactly the ticked files with the message, the
    user's own Git identity and settings. What else was staged stays staged and uncommitted. The
    repository's hooks run as `git commit` in a terminal runs them: wow never passes
    `--no-verify` and never turns hooks off for this command. When a hook refuses, its output
    shows in the dialog and nothing is committed. wow adds no trailer and no attribution. The
    conversation then shows "Committed 3 files · 4e1d2a0 Ring the bell twice".
30. Commit is refused with the reason for nothing ticked, an empty message, a running turn, a
    folder not in Git, and a merge, rebase, cherry-pick or revert in progress. A folder on no
    branch gets a "New branch" field in the dialog: with a valid name the branch is made where
    the folder is and the commit goes on it; without one Commit is refused.
31. "Open pull request…" ("Open merge request…" on GitLab; the Changes view and the palette)
    shows the branch; the target, the remote's default branch, editable among the remote's
    branches; the commits that would be in it; a title (the subject of the only commit, or of
    the newest) and a body (the commits' messages), both editable; "Propose" for both, as in 28,
    through `chat.pullRequestTemplate`; and "Draft", from `chat.pullRequestDraft`. It names what
    happens: "Pushes wow/ring-twice-3fa2c1 to origin and opens a pull request on github.com in
    acme/tea".
32. Open pushes the branch to its upstream's remote, else the project's primary remote, and sets
    the upstream; it never forces and the repository's pre-push hook runs. Then it creates the
    pull or merge request with the project's GitHub or GitLab settings and token. The
    conversation shows "Opened pull request #14 · Ring the bell twice" with the host chip, which
    opens the pull request in a panel tab as other chat links do.
33. Before anything is pushed, Open is refused with the reason for no remote; no GitHub or
    GitLab settings or token for the remote's host (naming the setting); a folder on no branch;
    the branch being the target; a branch the host reports as protected; no commit beyond the
    target; a running turn. When a pull request is already open for the branch, the dialog says
    so with Open in panel and, when the folder has commits the remote branch lacks, "Push the new
    commits".
34. When the host refuses after the push (a token without the right to open pull requests, a
    title the host rejects), the dialog shows the host's message, the branch stays pushed and Open
    can be tried again.
35. Push uses Git's own credentials (its credential helper, an SSH agent) and nothing that asks:
    when Git would need a password or a passphrase, the push fails and the dialog says to push
    once in a terminal. The host token is never given to Git.
36. Commit, push and opening a pull request happen only on the user's click in these dialogs:
    never by the assistant, by the thread's agent through wow, by a trigger or by a workflow.

### What the session can use

37. A chat thread's panel has a "Tools" tab, opened from Details, the palette ("Show session
    tools") or the header chip that shows while an MCP server failed or needs sign-in ("1 MCP
    server failed").
38. The tab lists what the provider reported for the thread's session: MCP servers with their
    state (Connected, Failed, Needs sign-in, Connecting, Turned off), the error a failed server
    gave, where the server is configured (user, project, local, plugin…) and its version; each
    connected server's tools with their descriptions and read-only or destructive marks; the
    built-in tools; skills; slash commands; subagents with description and model; plugins with
    version and load errors. Each section shows a count, and a filter field narrows all of them.
39. The tab says when the list was reported ("Reported as the turn of 20:41 started"). Refresh
    asks the thread's live session again; without a live session Refresh is not offered and the
    tab says the list is filled at the next turn. wow never starts a session, a probe or an MCP
    server to fill this tab.
40. A server that needs sign-in says "Sign in from Claude Code: /mcp in a terminal". wow does not
    sign in, reconnect or turn servers on or off.
41. Nothing secret is shown or stored: no environment values, headers, command arguments, URL
    paths or queries, tokens. A remote server's address shows as its scheme, host and port, a
    local one as its program's file name. Names and descriptions show as plain text.
42. On Codex the tab shows what the Codex adapter can learn (see Open risks): at least the
    instruction files the session loaded and the MCP servers and tools the thread's own tool
    calls used, marked "Seen in this thread's tool calls", with a line saying Codex reports no
    list of its servers, tools or skills to wow.
43. The Assistant has no Tools tab. A thread stored before this change shows an empty tab until
    its next turn.

### Old data

44. Threads, turns, items, approvals and settings stored before this change load and look as they
    did. No item, line or chip is added to old turns; old turns offer no Restore.

## Interface

### Find and copy (U1)

- Decided: no server contract. Find and the export are built in the web app from the rows the
  thread view already subscribes to (`threads`, `turns`, `threadItems`, `approvals`,
  `questions`), with the text functions the rows draw with (`oneLine`, `commandOutcome`,
  `agentTask`, `groupSummary` in `chat/tools/facts.ts`, `settingsChangeText` and
  `compactionText` in `chat/items.tsx`), so what is found and exported is what is shown. New
  `apps/web/src/chat/find.ts` (`conversationText`: each shown item's text pieces in reading order
  with the part each lies in; `findMatches(pieces, query, limit)`), `chat/find-bar.tsx`,
  `chat/conversation-markdown.ts` (`conversationMarkdown`, `exportFileName`).
- Decided: a message's text is its markdown turned into text by the parse the renderer uses
  (mdast to string), so matches and the rendered text agree.
- Decided: matches are marked with the CSS Custom Highlight API over the opened row's text
  nodes, never by rewriting the rendered markup; where the API is missing (jsdom), the current
  match's row is outlined. Rows open through the conversation's existing open state, the one a
  click sets.
- Decided: saving goes through the shell that shows the dialog: the preload's `saveTextFile`
  takes `{suggestedName, text}` and answers the path or null; the main process answers
  `wow:save-text-file` with `dialog.showSaveDialog` (Markdown filter), only for `wow://app`
  pages like `wow:pick-folder`, and writes UTF-8; the web app reaches it as
  `Runtime.saveTextFile`, and the browser build downloads instead. The server gets no RPC that
  writes to a path a client names.
- Decided: settings `keybindings.findInConversation` (Mod+F), `keybindings.findNext` (F3),
  `keybindings.findPrevious` (Shift+F3), `chat.findMaxMatches` (1000), `chat.exportReasoning`
  (false). Palette ids `chat.find`, `chat.findNext`, `chat.findPrevious`, `chat.copyMarkdown`,
  `chat.saveMarkdown`. Enter and Shift+Enter in the find field are the field's own keys, as in
  the palette's input.

### Own working copy (U2)

- Decided: contracts `Thread.workingCopy` (`WorkingCopy.nullable().optional()`, the run's schema
  from `packages/contracts/src/workflow.ts`, with `branch` set) and `Thread.branch` holding the
  branch; `thread.create.ownWorkingCopy?: boolean`, refused without a project, on a folder thread,
  for the assistant and with `resumeSessionId` (a provider session belongs to its folder); a
  fork takes the origin's copy. Internal commands `thread.workingCopyReady`,
  `thread.workingCopyFailed`, `thread.workingCopySettled` (the run's three, by thread). RPC
  `threads.workingCopyStatus {threadId}` answering `UnpushedWork`, and
  `threads.removeWorkingCopy {threadId, expect: UnpushedWork}`, refused with `conflict` and the
  new counts when the copy holds more than `expect`.
- Decided: `branchName(template, title, threadId)` in contracts makes a name Git takes (the
  rules of `git check-ref-format --branch`: no space, `..`, `~^:?*[\`, leading `-` or `.`,
  `.lock` or `/` at the end) and that differs in more than case from another thread's, since
  Windows keeps refs as files. The server checks it with `git check-ref-format` before it makes
  the copy.
- Decided: server `apps/server/src/workspaces` handles a thread's copy beside a run's:
  `Workspaces.prepareThread(threadId)` (awaited by the provider service before a chat turn goes
  out, as the runner awaits `prepare`), settling at `thread.setDone`, `removeThread`, and
  `recover()` for a copy left `pending`. `createWorkingCopy` (`working-copy.ts`) gains a new
  branch (`addNewBranchWorktree`: `git worktree add -b <branch> <path> <commit>`) and making a
  removed copy again on its branch (`addBranchWorktree`). The path is
  `<workspaces.root>/<project slug, 16 characters>-t<8 hex of the thread id's SHA-256>`.
- Decided: settings `chat.ownWorkingCopy` (project, false), `chat.workingCopyBranch` (project,
  template, `wow/{{title}}-{{id}}`; `title` is a slug of at most 32 characters, `id` 6 hex of the
  thread id's SHA-256), `chat.workingCopyStart` (project, `head` or `defaultBranch`, `head`).
  `workspaces.root`, `workspaces.fetchBeforeCreate` and `workspaces.gitTimeoutMs` apply as for
  runs. Palette ids `chat.draft.ownWorkingCopy`, `chat.removeWorkingCopy`,
  `chat.copyWorkingCopyPath`; no new key.
- Decided: migration `threads.working_copy` (JSON), numbered at delivery from 0034 in merge
  order.

### Restore files (U3)

- Decided: a snapshot is a Git tree in wow's own bare repository per thread folder,
  `<wow home>/snapshots/<folder key>.git` (`folderKey` from `files/folder-key.ts`, hashed). Taking
  one: `git ls-files --cached --others --exclude-standard -z` in the thread's folder (stopped at
  `chat.snapshotMaxFiles`); files whose size and modification time match the previous snapshot's
  manifest keep its blob, the rest are hashed with
  `git hash-object --no-filters -w --stdin-paths` into wow's repository (`GIT_DIR` set to it,
  so nothing is written to the user's);
  `git update-index --index-info` with a temporary index of wow's and `git write-tree` make the
  tree; `git update-ref refs/turns/<turnId>-<start|end>` there keeps it. A link is stored as a
  link (mode 120000) and never followed. Restoring reads blobs with `git cat-file --batch` and
  writes the bytes with `node:fs`; no checkout, no filter, no hook.
- Decided: contracts `TurnSnapshot {tree, files, omitted: {path, size}[], at}` stored on the turn
  (`turns.start_snapshot`, `turns.end_snapshot`, JSON; migration numbered at delivery) and
  `Turn.restorable` on the turns topic (the tree is not sent). Internal command
  `thread.snapshotTaken {threadId, turnId, at: 'start' | 'end', snapshot}`. RPC
  `threads.restorePreview {threadId, turnId} | {threadId, undoItemId}` answering
  `RestorePreview {status, message, write, remove, outside, notRestorable}` (`status` `ok` or a
  refusal kind: `noRepository`, `gitUnavailable`, `noSnapshot`, `turnRunning`, `outside`,
  `notChat`). Commands `thread.restoreFiles {threadId, turnId, confirmed}` (`confirmed` is
  `{outside, notRestorable}`, the lists the confirm showed),
  `thread.undoRestore {threadId, itemId, confirmed}` and
  `thread.editLast.restoreFiles?: {confirmed}`; the server refuses with `conflict` when the lists
  differ from what it finds when it restores. Item kind `files_restored`
  (`FilesRestoredItemPayload {toTurnId, written, removed, failed, undoOf?, undoneBy?, at}`) on
  the thread's last turn.
- Decided: settings `chat.snapshots` (project, true), `chat.snapshotMaxFiles` (20 000),
  `chat.snapshotMaxFileBytes` (10 MB), `chat.snapshotTimeoutMs` (30 s), `chat.snapshotKeepDays`
  (30), `chat.editRestoresFiles` (false), `keybindings.restoreMessage` (R, on a focused message,
  like E and F). Palette ids `chat.restoreFiles`, `chat.undoRestore`, and in the edit composer
  `chat.edit.withFiles`.

### Commit and pull request (U4)

- Decided: RPC `threads.commitPlan {threadId}` answers `CommitPlan`: status, message, branch,
  hooks (names) and files (path, status, added, removed, `inThread`). RPC `threads.commit` takes
  `{threadId, files, message, newBranch?}` and answers `{sha, subject}`, or `rejected` with
  `CommitRefusal {reason, output}` (git's and a hook's output, its last
  `chat.commitOutputMaxBytes` bytes). After a commit the server dispatches the internal
  `thread.committed {threadId, sha, subject, files}`, stored as item kind `committed`.
- Decided: RPC `threads.pullRequestPlan {threadId}` answers `PullRequestPlan`: status, message,
  host, host name, repository, remote, branch, target, the remote's branches, the commits ahead,
  an open request for the branch (`existing`) and the missing setting. RPC
  `threads.openPullRequest` takes `{threadId, target, title, body, draft}` and answers
  `{number, url}`; `threads.pushBranch {threadId}` pushes new commits to an open one. After a
  request is opened the server dispatches the internal `thread.changeRequestOpened` (thread,
  `HostItemRef`, number, title, url), stored as item kind `change_request_opened` and drawn with
  the workbench's `HostChip`.
- Decided: RPC `threads.propose` takes `{threadId, purpose, files?, target?}` (`purpose` is
  `commitMessage` or `pullRequest`) and answers `{text}` or `{title, body}`, through a new
  ProviderCommand `propose {prompt, model, effort}` answering `{text}`: on Claude Code a query
  with no tools, one turn, no stored session and an empty folder of wow's; on Codex an ephemeral
  thread in a read-only sandbox with approvals declined, no MCP servers and the same empty
  folder. Cancel aborts it.
- Decided: `HostAdapter` (`apps/server/src/hosts/adapter.ts`) gains `openChangeRequest` (head,
  base, title, body, draft) and `branchProtected(branch)`. GitHub:
  `POST /repos/<owner>/<repo>/pulls` and `GET /repos/<owner>/<repo>/branches/<branch>` (its
  `protected`). GitLab: `POST /projects/<id>/merge_requests` (a draft as GitLab's "Draft:" title
  prefix) and `GET /projects/<id>/repository/branches/<branch>`. `findForBranch` finds an open
  one. `MockGitHub` and `MockGitLab` learn both.
- Decided: `projects/git.ts` gains `readStatusFiles` (`status --porcelain=v2 -z` with
  `--untracked-files=all`), `readOperationInProgress`, `readCommitHooks` (from
  `rev-parse --git-path hooks` and `config core.hooksPath`), `commitPaths` (`add --` for new
  files, then `commit -F <file> -- <paths>`) and `pushBranch`
  (`push --porcelain --set-upstream <remote> refs/heads/<b>:refs/heads/<b>`). These two run
  without the `core.hooksPath` override every other git command of wow has, keep
  `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, set `GIT_SSH_COMMAND` to
  `ssh -o BatchMode=yes` only when none is set, and use `chat.commitTimeoutMs` and
  `chat.pushTimeoutMs`.
- Decided: settings `chat.commitTimeoutMs` (120 s), `chat.pushTimeoutMs` (120 s),
  `chat.commitOutputMaxBytes` (64 KB), `chat.proposalTimeoutMs` (60 s),
  `chat.proposalPatchMaxBytes` (60 000), `chat.commitMessageTemplate` and
  `chat.pullRequestTemplate` (templates with `files`, `patch`, `title` and, for the second,
  `commits`), `chat.pullRequestDraft` (project, false), `keybindings.commitChanges`
  (Mod+Shift+K), `keybindings.commitConfirm` (Mod+Enter, in the dialogs). Palette ids
  `chat.commit`, `chat.openPullRequest`, `chat.pushBranch`, `chat.propose`. No migration: the
  new items are JSON payloads in `thread_items`.

### Session tools (U5)

- Decided: contracts `SessionTools` (`reportedAt`, `complete`, `mcpServers`, `builtInTools`,
  `skills`, `commands` as `ProviderSlashCommand[]`, `agents`, `plugins`, `instructionFiles`) and
  `McpServerInfo` (`name`; `state`, one of `connected`, `failed`, `needsAuth`, `pending`,
  `disabled`, `other`; `stateWord`, `error`, `source`, `version`, `address`; `tools` with name,
  description, `readOnly` and `destructive`), with lengths bounded in the schema. No field can
  hold a config object, an environment, headers or arguments.
- Decided: ProviderEvent `sessionTools {threadId, tools}`; ProviderCommand
  `describeSession {threadId}` answering `SessionTools` or null without a live session. RPC
  `threads.refreshTools {threadId}`; internal command `thread.toolsReported`, stored only when
  the list differs; the projection `thread_tools` (thread id, report as JSON, time; migration
  numbered at delivery) and the thread-scoped topic `threadTools`.
- Decided: the Claude adapter reports at each `system/init` message of a thread's session, then
  completes it from the live query's `mcpServerStatus()`, `supportedCommands()` and
  `supportedAgents()` (the `ClaudeQuery` seam in `provider-claude/src/sdk.ts` gains
  `mcpServerStatus` and `supportedAgents`, which it lacks today); `system/commands_changed`
  replaces the commands. The adapter copies only the fields `McpServerInfo` has; a server's
  `config` gives only `address` (an http or sse URL's origin, a stdio command's file name).
- Decided: the Codex adapter reports `instructionSources` from `thread/start` and
  `thread/resume` (in the generated types, added to the fingerprint's `FIELDS`) and nothing else
  until a method listing servers, tools or skills is generated and checked (Open risks). The web
  app adds the MCP servers and tools the thread's `mcp` tool rows name, marked as seen.
- Decided: palette ids `chat.sessionTools`, `chat.refreshTools`; no new key or setting.

### All units

- Decided: everything the units add that crosses the wire is a zod schema in
  `packages/contracts`; provider facts are read and normalized only in `provider-claude` and
  `provider-codex`; every tunable named above is a registry entry listed in
  `docs/architecture.md`'s settings list.
- Left to delivery: the look of the find bar, chips, dialogs, lines and the Tools tab; wording
  not quoted above; how find stores its state; how the commit and pull request dialogs lay out
  their lists.

## Boundaries and non-goals

- No terminal, editor or Git client: no hunk staging, branch switching, merge, rebase, pull,
  conflict resolution or history view. Commit takes whole files.
- No merge, approval or comment on a pull request; no change to how runs, followed plans and
  event triggers read hosts.
- No MCP sign-in, reconnect or toggle; no change to a provider's settings files.
- No change to workflow runs and their working copies, except the code the two kinds of copy
  share.
- The assistant gets no tool for any of this, and sees none of it.

## Decisions

- **Find what is shown.** Find and the export read the rows the conversation draws, with the
  same words, so a match or a line is never something the user cannot see. Searching the DOM
  alone would miss closed rows, which hold most of a long thread's text.
- **The shell writes the export.** The user picks the path in a native dialog, as a browser
  download does. An RPC that writes files to a path a client names would be a write tool on the
  server for anything that reaches the socket.
- **A thread's copy is on a branch, unlike a run's.** A run's delivery skill names its own
  branch; a chat has no such step, and a pull request (U4) needs one. Commits on the branch keep
  their work, so settling and removal ask only about files that are not committed.
- **A thread's copy starts where the user is**, the project folder's commit, by default: a chat
  is most often about the work in hand. The default branch's tip is a setting away.
- **Snapshots live in wow's own Git repository, not the user's.** wow writes no object, ref or
  index entry into the user's repository; the user's `git gc` cannot drop a snapshot, and no
  push can carry one. `--no-filters` keeps the exact bytes (line endings included) and runs no
  filter program. Claude Code's `enableFileCheckpointing` and `rewindFiles` (declared in the SDK
  types) were not taken: by Claude Code's own account its checkpoints cover edits made through
  its file tools, not files a command wrote (not seen here), and Codex has none.
- **Restore asks when someone else touched the files.** A snapshot at each turn's end tells the
  thread's changes from the rest; what changed after the last turn is shown before it is
  overwritten, and Undo keeps the state just before the restore. This changes the agent
  workbench's rule that Edit never rewinds files (its spec 63 and Interface): files are rewound
  only when the user picks it.
- **Hooks run when the user commits.** The owner's rule: a commit from wow is the user's commit,
  and a repository's hooks are its checks. It is the one place wow runs a program the repository
  names, so it happens only on the user's click and the dialog names the hooks first.
- **Push with Git's credentials, open with the host's token.** The token stays an API token, sent
  only to its host in a header; giving it to Git would let a credential helper store it.
- **The proposal is a side request.** A message proposed outside the thread's conversation does
  not change the thread's session, history or files, and runs with no tools in an empty folder,
  so text in the diff that tries to steer a model can only change the proposed words, which the
  user reads before Commit.
- **The Tools tab shows reports, never probes.** Filling it by starting Claude Code in the folder
  would start the project's MCP servers, which a repository's `.mcp.json` names.
- **Old data keeps working.** Threads, turns and items stored before load and look as they did.

## Security

What the assistant may do: it sees no secret value, as before, and none of these units gives it a
tool. It may change the new settings as ordinary settings with change rows and Undo, since none of
them starts a program or pushes by itself; it never commits, pushes, opens a pull request, restores
files or removes a working copy, and it does not read a thread's Tools tab or export.

What content from a fork's pull request can and cannot trigger:

- Find and export (U1) read stored rows; text an agent quoted from a fork's files is shown and
  exported as text and runs nothing.
- A thread's working copy (U2) starts at the project folder's commit or the default branch's tip,
  never at a pull request's head. As for runs, git runs without hooks and without a file system
  monitor; checking out may run a filter program the user's own Git config names (git-lfs), never
  one named only in the repository's tracked files.
- Snapshots and restores (U3) run no hook, filter or program of the repository; a file name from
  Git is a literal path, and a name with `..` or one that leads through a link out of the folder
  is refused.
- Commit and push (U4) run the repository's hooks, which in a repository with `core.hooksPath` set
  to a tracked folder are tracked files. So they are offered only for chat threads (never for a
  step's thread, so never in an event run's copy at a fork's head), only on the user's click, and
  the dialog names the hooks before they run. A proposal reads the diff, which may hold text meant
  to steer a model; its answer only fills fields the user edits.
- The Tools tab (U5) shows what Claude Code reported. A repository's `.mcp.json` can name servers,
  but wow starts no session to read it, and names and descriptions are shown as plain text.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm --filter @wow/web test` covers find (matching, count, limit, opening rows, keys) and the
  Markdown export line by line for each item kind (spec 1 to 9), the draft switch and the chip
  (10, 13), the restore confirm and line (20 to 24), the commit and pull request dialogs (27
  to 33) and the Tools tab (37 to 43).
- `pnpm --filter @wow/server test` covers working copies of threads against real repositories made
  by the tests (11 to 17, with a Windows run of the path and branch rules), snapshots and restores
  (19 to 26, also files with CRLF, a link out of the folder, a file over the limit, a change
  outside the thread, Undo), commit and push against a local bare repository with a hook that
  writes a mark and one that refuses (29, 30, 32, 35), the host requests against `MockGitHub` and
  `MockGitLab` (31 to 34), the tools projection (38, 39, 43) and old rows (18, 44).
- `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex test` cover the
  `propose` command and `sessionTools` (28, 38, 41, 42), including a server config with an
  environment, headers and arguments that must not come through.
- `pnpm --filter @wow/desktop test` covers `wow:save-text-file` (7).
- `pnpm e2e` against the mock providers and mock hosts covers each unit's cases named in the plan.

## Open risks

- Provider facts are read from the installed types, not seen against the real CLIs: the Claude
  Agent SDK 0.3.316 (`sdk.d.ts`) and Codex's generated protocol (codex 0.166.0,
  `packages/provider-codex/src/protocol/generated`). The Windows smoke list gets a line for each.
- Claude Code's init message (`SDKSystemMessage`, subtype `init`) declares `tools`, `mcp_servers`
  (name, status, source), `slash_commands`, `skills`, `agents`, `plugins` and `plugin_errors`,
  and is said to come at the start of each turn. `Query.mcpServerStatus()` declares state
  `connected | failed | needs-auth | pending | disabled`, `error`, `serverInfo`, `scope`,
  `source`, `config` (which can hold `env`, `headers` and `args`, hence the copy of named fields
  only) and `tools` with annotations. `supportedAgents()` gives name, description and model;
  `supportedCommands()` name, description, argument hint and `builtin`;
  `system/commands_changed` replaces the commands. None of this was seen from a running Claude
  Code. Fallback: when the live calls fail, the tab shows the init message's names and states
  only and says so (`complete: false`).
- Codex: the generated protocol holds only the methods wow uses and has no method that lists MCP
  servers, tools or skills; `ThreadStartResponse` and `ThreadResumeResponse` declare
  `instructionSources`. Codex's own documentation names methods such as `mcpServerStatus/list`
  and `skills/list`; they were not seen here. U5 adds them to the generator's `METHODS` and runs
  it against an installed codex; the script fails when codex does not define them, and then
  Codex threads keep the fallback of behavior 42.
- The `propose` command on Codex: an ephemeral thread with no MCP servers follows the assistant's
  toolset config (`provider-codex/src/toolset.ts`), checked against a real codex only for the
  assistant's case.
- Snapshot cost: the first snapshot of a thread hashes every listed file; later ones only files
  whose size or time changed. A large folder delays the first turn up to `chat.snapshotTimeoutMs`,
  after which the turn goes without a snapshot. Measured on Windows in the smoke list.
- A change made by another program while a turn runs counts as the thread's; only changes after
  the last turn's end are told apart. A file written in the moment between a turn's end and its
  end snapshot counts as the thread's.
- Restore on Windows: a file held open by an editor cannot be written or deleted. The restore
  writes what it can, lists what failed, and Undo puts back the state taken just before it.
- Hooks on Windows run through Git for Windows' own shell, as in a terminal; a hook that needs a
  program missing from the server's PATH fails there and not in the user's terminal. The dialog
  shows the hook's output.
- Push without a prompt: Git Credential Manager with `GCM_INTERACTIVE=never` uses a stored
  credential or fails; an SSH key with a passphrase and no agent fails. Both say to push once in a
  terminal.
- Find matches rendered text through mdast; a renderer feature the text conversion does not
  mirror (a footnote, a diagram) may count a match the screen does not show. The current match is
  then its row, outlined.

## Decision log
