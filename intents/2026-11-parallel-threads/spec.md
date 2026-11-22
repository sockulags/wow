---
intent: 2026-11-parallel-threads
rev: 1
built_on: intent@1
status: accepted
---

# Many threads at once: see them all, and take their work home

## Summary

Three things for running several agents at once. "Apply to project folder" writes what a thread
changed in its own working copy into the project's folder as uncommitted changes, merging a file
both sides changed where Git can and leaving the rest named, with Undo. "Threads at work" lists
every thread that works, waits or finished unread, with what each does now. Any thread opens in
a tab of the side panel next to the view.

This intent builds on thread work (`intents/2026-11-thread-work`: the thread's own working copy,
its Changes, snapshots and restore) and on the agent workbench's side panel tabs, and names their
files as they are at 0.4.0.

## Behavior

### Apply to project folder

1. A chat thread with its own working copy (`Thread.workingCopy` with a `startSha`) offers
   **Apply to project folder…** in its Changes tab, in the palette and on
   `keybindings.applyToProject` (Ctrl+Shift+A). Other threads do not offer it; the palette says
   why ("This thread works in the project folder; its changes are already there").
2. The thread's changes are every file that differs between the copy's start commit and the copy
   as it is now: commits on its branch, uncommitted changes and new files Git does not ignore.
   Ignored files are never read or written.
3. For each changed file wow compares three versions: the start commit's (base), the thread's
   (theirs) and the project folder's now (ours).
   - ours equals base: the thread's version is written, or the file is deleted (**write**,
     **delete**);
   - ours equals theirs: nothing to do (**same**, listed but not counted);
   - both changed a text file and `git merge-file` merges them without a conflict: the merged text
     is written (**merge**);
   - anything else is **left for you** with the reason: both changed and Git found a conflict,
     one side deleted what the other changed, a binary file both changed, a file larger than
     `chat.snapshotMaxFileBytes`, a link, or a path wow does not write (`..`, `.git`, a folder
     on the way that is a link).
4. A confirm lists the files under "Written", "Merged", "Deleted" and "Left for you" with the
   reason, names the project folder and the start commit, and its button reads "Apply". Enter
   confirms, Escape cancels. With nothing to write it says so and offers no Apply.
5. Apply is refused with the reason in words for: a thread that is not a chat thread or has no
   working copy, a turn running in the thread, a turn running in a thread that works in the
   project folder itself, a project folder that is missing or not in Git, git missing.
6. The server checks again when it applies. When the lists differ from what the confirm showed,
   nothing is written and the confirm shows the new lists ("The files changed since").
7. Apply writes files only: it never changes HEAD, a branch, the index, the stash or a commit of
   the project or of the thread's copy, and runs no hook or filter. Bytes are written as the
   thread has them (no line-ending conversion). A file the system refuses (held open on Windows)
   is listed as failed and the rest goes on.
8. Afterwards the thread shows a line "Applied to <project folder> · 3 written · 1 merged · 1
   deleted · 2 left for you" with **Undo**, found by Ctrl+F and written in the Markdown export.
9. **Undo** puts back each file Apply wrote or deleted, if it still holds what Apply left there;
   a file changed since is left as it is and named. Undo is offered on the thread's newest apply
   line until it is undone or its saved copies are dropped after `chat.snapshotKeepDays`.
10. The assistant has no tool for any of this; sent to the engine alone the commands are
    refused, as restore's are.

### Threads at work

11. **Threads at work** (`/chat/work`; palette "Show threads at work"; `keybindings.threadsAtWork`,
    Ctrl+Shift+O; a row "At work · 3" at the top of the thread list) lists the threads that
    need you, then those working, then those that finished a turn you have not seen, each group
    oldest first by when it came to that state. Archived threads and the Assistant are not in it;
    a workflow step's thread is, under its step's title.
12. Each row shows the title, the project and the branch (or folder), and one line by state:
    - working: what runs now as the working line says it ("Running `pnpm test` · 2:10 · 14 tool
      calls"), or "Working · 0:12" between calls;
    - needs you: what it waits for, from the decision queue ("Wants to run `rm -rf build`",
      "Asks: Which port?", "Waits at the gate after step 2");
    - finished: the last line the agent wrote and when the turn ended.
13. The arrow keys move between rows, Enter opens the thread, and **P**
    (`keybindings.threadToPanel`) opens it in the side panel. With nothing at work the view says
    so and offers "New thread".
14. Times count from the stored start of the turn or state; the view adds no clock of its own
    beyond the running seconds the working line already shows.

### A thread in the side panel

15. **Open thread in panel…** (palette; `keybindings.openThreadInPanel`, Ctrl+Alt+O) lists the
    threads as the palette does and opens the pick in a tab of the side panel next to the view
    you are in: the conversation, its approval, question and gate cards, and its composer, as a
    workflow step's thread shows there. P on a row of Threads at work does the same.
16. The tab is named by the thread's title and has **Open thread** to go to it in the main view.
    It is one tab per thread per view; opening it again selects it. The thread on screen in the
    main view is not offered.
17. Find, export, restore, fork and edit stay in the main view, as for a step's thread in the
    panel.

### Old data

18. Threads and items stored before load and look as they did. A thread stored before has no
    apply line.

## Interface

### Apply (U1)

- Decided: contracts in `packages/contracts/src/apply.ts`: `ApplyChange` (`added`, `modified`,
  `deleted`), `ApplyOutcome` (`write`, `delete`, `merge`, `same`, `left`), `ApplyLeftReason`
  (`conflict`, `deletedHere`, `deletedThere`, `binary`, `tooLarge`, `link`, `unsafe`),
  `ApplyFile {path, change, outcome, reason}`, `ApplyStatus` (`ok`, `nothing`, `notChat`,
  `noWorkingCopy`, `turnRunning`, `projectBusy`, `folderMissing`, `noRepository`,
  `gitUnavailable`, `failed`), `ApplyPreview {status, message, projectFolder, base, files}`,
  `ApplyConfirmed {write, merge, left}` (the paths the confirm showed per kind; `write` holds
  writes and deletes), `ChangesAppliedItemPayload {projectFolder, base, written, merged, removed,
left: {path, reason}[], failed: {path, message}[], undoOf?, undoneBy?, at}` and
  `undoableApply`.
- RPC `threads.applyPreview {threadId}` answers `ApplyPreview`. Commands
  `thread.applyToProject {threadId, confirmed}` and `thread.undoApply {threadId, itemId}` are
  taken by the RPC `dispatch` handler before the engine; the engine alone refuses them.
  `conflict` with the new preview as `data` when the lists differ. Internal
  `thread.changesApplied {threadId, applied}`, event `thread.changesApplied {threadId, item}`,
  item kind `changes_applied` on the thread's last turn.
- Decided: `apps/server/src/workspaces/apply.ts` (`ThreadApply`). The changed paths come from
  `git diff --name-only -z --no-renames <startSha>` and `git ls-files --others --exclude-standard
-z` in the copy; base bytes from `git cat-file --batch` in the copy's repository; a merge from
  `git merge-file -p --no-diff3 <ours> <base> <theirs>` on scratch files in wow's home, never in a
  repository. Undo's copies are trees in wow's snapshot store of the project folder
  (`FolderSnapshots.storeOf`), under `refs/applies/<sha of item id>/before` and `/after`; refs of
  apply lines older than `chat.snapshotKeepDays` are dropped at the next apply into that folder.
- Decided: settings `keybindings.applyToProject` (Mod+Shift+A). Palette ids
  `chat.applyToProject`, `chat.undoApply`.

### Threads at work (U2)

- Decided: topic `threadActivity` (global): one row per non-Assistant thread that is working,
  needs you or has `seen` false, `{threadId, turnId, turnState, startedAt, endedAt, toolCalls,
runningTool, lastText}`. `runningTool` is the payload of the turn's running tool call, so the
  web names it with the same words as the working line; `lastText` is the last line of the turn's
  last answer, at most `chat.activityTextMaxLength` characters. Pushed when threads, turns or
  thread items change.
- Decided: route `/chat/work`, `apps/web/src/chat/at-work.tsx`; settings
  `keybindings.threadsAtWork` (Mod+Shift+O), `keybindings.threadToPanel` (P, in the list),
  `chat.activityTextMaxLength` (300). Palette id `chat.threadsAtWork`.

### A thread in the side panel (U3)

- Decided: panel tab kind `thread {threadId, from}` (`openThreadTab`, `threadTabId`) rendered by
  `ThreadConversation` with `compact`, beside the tab strip's other tabs. Setting
  `keybindings.openThreadInPanel` (Mod+Alt+O); palette id `chat.openThreadInPanel`.

## Boundaries and non-goals

- No merge commit, rebase, cherry-pick or stash; no staging in the project folder; no change to
  the thread's copy or branch.
- No change to how runs' working copies are delivered, or to commit and pull request.
- The assistant gets no tool and no topic for any of this beyond what it reads today.

## Decisions

- **Files, not history.** Applying writes the thread's files where the project folder has not
  moved, and merges with `git merge-file` only where Git reports no conflict. A merge of branches
  would change the project's history and leave conflicts in the folder; files can be committed,
  stashed or thrown away by the user in his own tools.
- **Nothing of his is lost.** A file he changed is written only when Git merged both changes
  cleanly, the confirm names it as merged, and Undo brings back what he had.
- **Undo's copies live in wow's store**, as restore's do: nothing is written to the project's
  repository, and the bytes are exact.
- **Activity on the server.** The overview needs a few facts of every live thread, not every item
  of every thread; one topic keeps the client from subscribing to each thread's items.
- **The panel reuses the step thread's conversation.** The same component, compact, so the
  cards, keys and composer behave as they do for a step.

## Security

- Apply reads the thread's copy and writes only inside the project folder; a path with `..`,
  `.git`, a full path or a link on the way is left, never written. It runs `git diff`,
  `ls-files`, `cat-file` and `merge-file` only, with hooks and filters off, and no program the
  repository names.
- Text the agent wrote is applied as files the user then sees in his folder; nothing runs.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm --filter @wow/server test` covers apply against repositories the tests make (write,
  delete, merge, conflict, deleted on one side, binary, a link, too large, a busy project folder,
  changed since the confirm, Undo with a file changed since) and the activity topic.
- `pnpm --filter @wow/web test` covers the confirm and the apply line, the overview's rows and
  keys, and the thread tab.

## Open risks

- `git merge-file` on Windows with CRLF files: it merges bytes as given, so a file whose two sides
  use different line endings conflicts. That is left for the user, which is safe.
- A project folder with a turn running in another program (Claude Code in a terminal) is not
  seen; the confirm's check for changes since covers what changed before Apply.
