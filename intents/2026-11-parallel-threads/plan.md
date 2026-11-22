---
intent: 2026-11-parallel-threads
rev: 1
built_on: spec@1
status: done
source: files
---

# Plan: Many threads at once

Execution: three units. U1 and U2 have no dependency between them; U3 uses U2's row key and
starts once U2 is merged. Every unit updates `docs/architecture.md` (its section, the settings
list, the data model) and `docs/user-guide.md`, and leaves the repository checks green.

## Units

- [U1] Apply a thread's changes to the project folder
- [U2] Threads at work
- [U3] A thread in the side panel — depends on U2

### U1 Apply a thread's changes to the project folder

Outcome: a chat thread with its own working copy writes its changes into the project folder after
a confirm, merging cleanly where both changed and leaving the rest named, with a line and Undo.
Boundaries: chat threads with a working copy only; files only, no commit, index or branch change
in either folder; the assistant gets no tool.
Change surface: contracts `apply.ts`, `ThreadItemKind` `changes_applied`, the commands, event and
RPC; server `workspaces/apply.ts`, `projects/git.ts` (diff names, merge-file), `core/threads.ts`
(refusal, line), the projector, `rpc/handlers.ts`; web `chat/apply.tsx` (confirm, line),
`chat/thread-changes.tsx` (button), `chat/items.tsx`, `chat/find.ts`,
`chat/conversation-markdown.ts`, the palette.
Acceptance:

- Given a thread copy that edited a file, added one and deleted one, and an untouched project
  folder, then the preview lists them as write, write, delete and Apply writes them (spec 2, 3).
- Given the project folder changed the same file in another place, then it is merged; in the same
  place, it is left with `conflict`; deleted on one side and changed on the other, it is left
  (spec 3).
- Given the lists changed after the preview, then Apply writes nothing and answers `conflict`
  with the new preview (spec 6).
- Given a running turn in the thread or in a thread of the project folder, then it is refused
  (spec 5). HEAD, the index and the branches of both repositories are unchanged (spec 7).
- Given Undo, then the files are as before Apply; a file changed since is left and named (spec 9).
- Given the engine alone, then both commands are refused (spec 10).

Ground truth: `pnpm --filter @wow/server test` (`workspaces/apply.test.ts`), `pnpm --filter
@wow/web test` (`chat/apply.test.tsx`), repository checks.

### U2 Threads at work

Outcome: `/chat/work` lists threads that need you, work or finished unseen, each with what it does
now, waits for or last said; keys to move, open and send to the panel.
Boundaries: reads only; no new command. The thread list keeps its groups.
Change surface: contracts topic `threadActivity`; server `core/subscriptions.ts`; web router,
`chat/at-work.tsx`, the sidebar row, the palette and settings.
Acceptance:

- Given a working thread with a running command, one waiting for an approval and one finished
  unseen, then the view lists them in that group order with their lines (spec 11, 12).
- Given the arrow keys and Enter, then the thread opens (spec 13).

Ground truth: `pnpm --filter @wow/server test` (`core/thread-activity.test.ts`), `pnpm --filter
@wow/web test` (`chat/at-work.test.tsx`), repository checks.

### U3 A thread in the side panel

Outcome: any thread opens in a side panel tab beside the view, with its conversation and composer.
Boundaries: no find, export, restore, fork or edit in the tab.
Change surface: web `app/runtime.tsx` (tab kind), `panel/viewer.ts`, `panel/tabs.tsx`,
`panel/context-panel.tsx`, `chat/at-work.tsx` (P), the palette and settings.
Acceptance:

- Given "Open thread in panel…" and a pick, then the panel shows the thread's conversation in a tab
  named by its title, with Open thread (spec 15, 16).
- Given P on a row of Threads at work, then the same (spec 13).

Ground truth: `pnpm --filter @wow/web test` (`panel/thread-tab.test.tsx`), repository checks.
