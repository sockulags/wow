---
intent: 2026-11-chat-overview
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: See more at a glance

Execution: twelve units in four tracks that can run side by side. Each unit updates
`docs/architecture.md` (its section, the settings list and the data model) and
`docs/user-guide.md`, and leaves the repository checks green.

The tracks:

- **Thread list:** U1 → U2 → U3 → U4. U2 needs U1's change count. U3 and U4 change the same
  list component as U2, so they follow it in that order to avoid conflicts.
- **Conversation:** U5 and U6 have no dependency on each other. U6 shows U1's summaries when U1
  is in, and leaves them out before. U8 stands alone.
- **Composer:** U9, then U10, then U11. U10 reuses U9's message chips. U11 also waits on intent
  open question 1.
- **Overview:** U7 → U12.

## Units

- [U1] Turn summary
- [U2] Rows that say where a thread stands — depends on U1
- [U3] A list that stays tidy — depends on U2
- [U4] Actions on the row and several rows at once — depends on U3
- [U5] New since you looked
- [U6] Outline and marks
- [U7] Plan limits
- [U8] Pictures in tool rows
- [U9] Files in a message
- [U10] Mention threads and backlog items — depends on U9
- [U11] Mention host items — depends on U10
- [U12] Usage view — depends on U7

### U1 Turn summary

Outcome: each chat turn's usage row starts with what the turn changed, ran and how much failed.
The change part opens that turn's Changes. The thread keeps its latest change count.
Boundaries: the summary is computed on the server at turn end. Changes reuses its existing
measure. The Assistant gets none.
Change surface:

- contracts: `TurnSummary`, `usage` payload `summary`, `Thread.changeCount`, `threads.changes`
  `turnId`;
- server: turn end in `core/threads.ts`, the Changes measure, the projector;
- web: `chat/items.tsx`, `chat/thread-changes.tsx`, `chat/find.ts`,
  `chat/conversation-markdown.ts`.

Acceptance:

- Given a turn that edited two files and ran a command that failed, then its usage row reads
  "Changed 2 files +… −… · ran 1 command · 2 edits · 1 failed" (spec 1).
- Given a click on the change part of an earlier turn, then Changes lists the files of that turn
  only (spec 2).
- Given a folder outside Git, then the part reads "Changes not measured" (spec 2).
- Given a reload, then the same summary shows (spec 3), and `Thread.changeCount` matches the
  chip (spec 4).

Ground truth: `pnpm --filter @wow/server test` (`chat/turn-summary.test.ts`), `pnpm --filter
@wow/web test` (`chat/turn-summary.test.tsx`), repository checks.

### U2 Rows that say where a thread stands

Outcome: a thread row's second line shows activity, task progress, changes, place and time,
chosen by `chat.threadRowDetail`.
Boundaries: reads persisted state only. No new command.
Change surface:

- contracts: `Thread.tasks`, the setting;
- server: the projector sets `tasks`;
- web: `chat/chat-view.tsx` (row), `chat/activity-words.ts` (moved from `at-work.tsx`).

Acceptance:

- Given a thread running `pnpm test` with tasks 3/7 and changes, then its row reads "Running
  `pnpm test` · 0:12 · 3/7 · +42 −7 · wow/ring-twice · now" (spec 6).
- Given a thread waiting for an approval, then the row says what it wants (spec 6).
- Given `chat.threadRowDetail` without `changes`, then the part is gone (spec 7).

Ground truth: `pnpm --filter @wow/web test` (`chat/thread-row.test.tsx`), repository checks.

### U3 A list that stays tidy

Outcome: Idle and Done are grouped by time. Groups fold and stay folded. Done threads are
archived after `chat.doneArchiveDays`. The list can be grouped by project.
Boundaries: archiving by age never touches pinned threads or steps' threads. It uses the
existing archive event.
Change surface:

- contracts: the three settings, `thread.archived` `by`;
- server: the daily tick in the scheduler;
- web: `chat/chat-view.tsx`, `chat/model.ts` (grouping), the palette.

Acceptance:

- Given threads last active today, yesterday, three days ago and last month (with the week
  starting Monday), then Idle shows them under Today, Yesterday, This week and Older (spec 9).
- Given a folded group and a restart, then it is still folded (spec 10).
- Given a done thread 15 days old and a pinned one, then only the first is archived (spec 11).
- Given grouping by project, then each project is a group with its threads in state order
  (spec 12).

Ground truth: `pnpm --filter @wow/server test` (`core/archive-by-age.test.ts`), `pnpm --filter
@wow/web test` (`chat/thread-list.test.tsx`), repository checks.

### U4 Actions on the row and several rows at once

Outcome: a context menu and hover buttons on rows, a selection with a bar of bulk actions, and
Undo for a bulk archive.
Boundaries: no new server command. Every action is the palette command of the same name.
Change surface: web `components/ui/context-menu.tsx` (shadcn), `chat/chat-view.tsx`,
`chat/thread-commands.ts`, `threadListStore`.

Acceptance:

- Given right-click on a row, then the menu lists the actions of spec 13. Pin there pins the
  thread.
- Given Ctrl+click on two rows and Archive, then both are archived. The notice offers Undo, and
  Undo brings both back (spec 15, 16).
- Given a working thread among the picked rows and Mark done, then it is skipped and the bar
  says why (spec 15).

Ground truth: `pnpm --filter @wow/web test` (`chat/row-actions.test.tsx`), Playwright
(`e2e/thread-list.spec.ts`), repository checks.

### U5 New since you looked

Outcome: an unseen thread opens at a divider before what is new. Shift+End goes there.
Boundaries: the divider is not an item, so Find and the export do not see it.
Change surface:

- contracts: `Thread.seenItemIndex`, the setting;
- server: mark-seen;
- web: `chat/thread-view.tsx`, `chat/conversation-nav.ts`.

Acceptance:

- Given a thread seen at item 10 that got items 11 to 20, then it opens with the divider before
  item 11, scrolled there (spec 17).
- Given a message sent, then the divider is gone (spec 18).
- Given a thread from before, then it opens at the bottom (spec 20).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`
(`chat/new-since.test.tsx`), repository checks.

### U6 Outline and marks

Outcome: an Outline panel tab lists the thread's messages, summaries and marks. B marks a
message, and keys move between marks.
Boundaries: chat threads in the main view only.
Change surface:

- contracts: the commands, event and `Thread.marks`;
- server: `core/threads.ts`, fork;
- web: `panel/` (tab kind `outline`), `chat/outline.tsx`, `chat/items.tsx` (mark sign),
  `chat/conversation-nav.ts`, the palette and settings.

Acceptance:

- Given a thread with three messages, then Outline lists three rows. Enter on the second
  scrolls to it and gives it the keyboard (spec 21).
- Given B on an answer and a restart, then it is still marked, and Alt+Shift+Down reaches it
  (spec 22, 23).
- Given a fork after that answer, then the fork has the mark (spec 22).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`
(`chat/outline.test.tsx`), repository checks.

### U7 Plan limits

Outcome: limits the providers report show in the composer bar, Settings → Providers and a
notice when they cross the warning.
Boundaries: only what the providers send, with no account details.
Change surface:

- contracts: `ProviderLimit`, the `limits` provider event, the `providerLimits` topic, the
  setting;
- adapters: `provider-claude` and `provider-codex` (the protocol is regenerated if needed);
- server: a store table and the topic;
- web: `chat/model-bar.tsx`, `settings/` providers, `app/notifications.tsx`.

Acceptance:

- Given a recorded Claude `rate_limit_event` with five-hour utilization 0.84, then the topic
  holds `fiveHour` at 84 % and the bar shows "5 h: 84 % · resets …" in amber (spec 25, 27).
- Given the same at 0.5, then the bar shows nothing and Settings shows the window (spec 27,
  28).
- Given a reset time in the past, then Settings says it was not reported since (spec 26).
- Given a second report above the warning within one window, then there is one notice only
  (spec 29).

Ground truth: `pnpm --filter @wow/provider-claude test`, `pnpm --filter @wow/provider-codex
test`, `pnpm --filter @wow/server test` (`providers/limits.test.ts`), `pnpm --filter @wow/web
test` (`chat/limits.test.tsx`), repository checks.

### U8 Pictures in tool rows

Outcome: images in tool results are stored as the thread's attachments and shown as thumbnails
on the tool row.
Boundaries: the same types and size limit as message images. Nothing is fetched.
Change surface:

- contracts: tool output `images`, the payload fields, the setting;
- adapters: Claude tool results, Codex image view and MCP content;
- server: the attachments store;
- web: `chat/tools/row.tsx`, `chat/tools/group.tsx`, `chat/find.ts`,
  `chat/conversation-markdown.ts`.

Acceptance:

- Given a recorded MCP result with a PNG, then the row shows its thumbnail, and a click opens it
  full size (spec 31 to 33).
- Given an image over `chat.imageMaxBytes`, then the row says "1 image not shown (too large)"
  (spec 32).
- Given the export, then the tool line ends "(1 image)" (spec 34).

Ground truth: adapter tests, `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`
(`chat/tools/tool-images.test.tsx`), repository checks.

### U9 Files in a message

Outcome: text files go in as fenced blocks, PDFs go to Claude as documents, and files in the
folder become `@` mentions, all as chips.
Boundaries: nothing is written into the thread's folder. The Assistant and steps take none.
Change surface:

- contracts: `attachments.ts` (types, ids, `SentFile`), the settings;
- server: attachment sniffing, message building, `provider-claude` document blocks;
- web: `chat/composer.tsx`, `chat/image-chip.tsx` (now a file chip too),
  `chat/image-commands.ts`.

Acceptance:

- Given a dropped `build.log` of 3 KB from outside the folder, then the sent message holds it as
  a fenced block named `build.log`, and the chip shows it (spec 35).
- Given a file inside the folder, then it becomes an `@` mention (spec 35).
- Given a PDF on a Codex thread, then it is refused with the reason (spec 35).
- Given a 1 MB binary, then it is refused (spec 35).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/provider-claude test`,
`pnpm --filter @wow/web test` (`chat/file-chips.test.tsx`), repository checks.

### U10 Mention threads and backlog items

Outcome: `@` lists threads and backlog items, and their text is copied into the message at send
time.
Boundaries: the server builds the text. The named thread is not changed.
Change surface:

- contracts: `SentMention`, the settings;
- server: message building;
- web: `chat/file-mentions` list sections, the chips.

Acceptance:

- Given `@` and a thread picked, then the sent message ends with a block holding that thread's
  last answer, and the chip shows it (spec 36).
- Given a backlog item, then its title, state, tags and body are added (spec 36).
- Given a text longer than `chat.mentionMaxChars`, then it is cut with a line saying so (spec
  36).

Ground truth: `pnpm --filter @wow/server test` (`chat/mentions.test.ts`), `pnpm --filter
@wow/web test`, repository checks.

### U11 Mention host items

Outcome: with the project setting on and a confirm per message, a host item wow already read
goes into the message as quoted host text.
Boundaries: no fetching; the project setting is off by default and every message asks first.
Change surface: contracts `SentMention` `hostItem`, the project setting; server message
building from stored host links; web the `@` section and the confirm.

Acceptance:

- Given the setting off, then no section shows (spec 37).
- Given it on, `#14` picked and the confirm answered yes, then the message ends with a quoted
  block marked as host text (spec 37).
- Given the confirm answered no, then the chip is removed (spec 37).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`, repository
checks.

### U12 Usage view

Outcome: `/chat/usage` shows tokens and cost per day, project, instance and model over a chosen
range, with the plan limits above.
Boundaries: reads only, with no budgets.
Change surface: contracts the `usage.summary` RPC; server the summing over stored turns; web
`chat/usage-view.tsx`, the router, the palette and the thread list link.

Acceptance:

- Given turns on two days in two projects, with one without cost, then the rows and totals
  match. The unknown cost shows "—" and is not summed (spec 39, 40).
- Given a click on a model, then the days narrow to it (spec 40).

Ground truth: `pnpm --filter @wow/server test` (`usage/summary.test.ts`), `pnpm --filter
@wow/web test` (`chat/usage.test.tsx`), repository checks.
