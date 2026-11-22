---
intent: 2026-11-chat-overview
rev: 1
built_on: intent@1
status: accepted
---

# See more at a glance: a richer thread list and conversation

## Summary

Ten outcomes in eleven parts. They fall into four areas:

- **Thread list:** richer rows, time groups and folding, row actions and picking several rows.
- **Conversation:** a summary per turn, "New since you looked", an outline with marks, and
  pictures in tool rows.
- **Composer:** attached files and `@` mentions of threads and backlog items, plus host items
  once the owner agrees.
- **Overview:** plan limits and a usage view.

This builds on:

- the agent workbench (`intents/2026-11-agent-workbench`): tool rows, Changes, the panel tabs,
  images, unread, the palette;
- thread work: snapshots and a turn's changes;
- parallel threads: the `threadActivity` topic and Threads at work.

It names their files as they are at 0.5.0.

## Behavior

### Turn summary (U1)

1. When a turn ends (completed, failed or stopped), its usage row starts with a summary of
   the turn:
   - what it changed in a chat thread's folder ("Changed 3 files +40 −2"), measured from the
     turn's start snapshot to its end snapshot;
   - what it ran, in the words of a closed group of tool calls ("Read 2 files, ran 1 command");
     a subagent's own calls count as its one call;
   - how many calls failed ("1 failed").

   Parts with nothing to say are left out. A turn that changed nothing and ran nothing has no
   summary, and neither has a turn without a usage row (one that failed before the provider
   reported usage).

2. The change part is a button. It opens the thread's Changes tab narrowed to that turn: **This
   turn only** for the last turn, and "Turn N only" for an earlier turn, listing the files that
   changed between its start and end snapshots and still differ. When the turn has no two snapshots (the folder is not in Git, snapshots are off for the project, git ran out of time), the summary has no change part.
3. The change count is stored with the usage row; what ran is read from the turn's stored rows.
   A reload or a restart shows the same. Find matches the summary text. The Markdown export
   writes it as a line "Turn: …" at the turn's end.
4. The thread stores the latest change count of the whole thread (the header chip's numbers) as
   of its last turn end, for the thread list (spec 6). The chip itself still measures live.
5. A workflow step's thread gets what ran and failed; its changes are its run's Changes, so it
   has no change part. Threads from before this change have no change part either. The
   Assistant's turns ran nothing in a folder of the user's and get what ran only.

### Rows that say where a thread stands (U2)

6. A thread row keeps its first line (state dot, title, marks). Its second line becomes, in this
   order and as far as it fits:
   - **What it is doing**: what it waits for, in the decision queue's words ("Wants to run
     `rm -rf build`"), what it runs ("Running `pnpm test`", without a running clock, which only
     Threads at work and the thread itself show), "Working" between calls, or nothing for a
     thread at rest.
   - **Task progress**, "3/7", when its latest task list has open tasks.
   - **Changes**, "+42 −7" from spec 4, when the thread changed something.
   - **Place**: the branch for a thread with its own working copy, else the project or folder.
   - **When** it was last active.

   The hover title of the row holds the whole line, untruncated.

7. `chat.threadRowDetail` chooses the parts shown on the second line, from `activity`, `tasks`,
   `changes`, `place` and `time`. All are on by default. Turning a part off leaves the others in
   order.
8. The row reads its parts from the persisted state only, never from a clock of its own: the
   `threadActivity` topic, the thread's stored task progress and change count. The running time
   is the one Threads at work already counts from the stored start.

### A list that stays tidy (U3)

9. Within **Idle** and **Done**, rows are grouped under **Today**, **Yesterday**, **This week**
   and **Older**, by when the thread was last active, in the user's time zone and first day of
   the week. Needs you and Working stay ungrouped. Pinned threads stay first, above the groups.
10. Each group heading (Needs you, Working, Idle, Done and the time groups) folds and unfolds on
    click, Enter or Space. A folded group shows its count. Which groups are folded is kept
    across restarts (`chat.threadListFolded`). Done starts folded. A folded group still shows
    the thread on screen, and while the filter has text no group is folded.
11. A thread in Done that has not been active for `chat.doneArchiveDays` days is archived by the
    server, as "Archive thread" would. The default is 14 days; 0 never archives. Pinned threads
    and workflow steps' threads are never archived this way. Unarchive brings one back as today.
12. `chat.threadListGroupBy` chooses **State** (the default, as above) or **Project**:
    - With Project, each project (and "Other folders") is a foldable group. Its threads are
      ordered as Needs you, Working, then by last activity. The state shows through the row's
      dot and second line.
    - The project chips still narrow the list.
    - The palette has "Group threads by state" and "Group threads by project".

### Actions on the row (U4)

13. Right-click on a row, the context-menu key or Shift+F10 on a focused row opens a menu:
    - Open
    - Open in panel
    - Pin or Unpin
    - Rename
    - Mark done or Reopen
    - Mark unread
    - Archive or Unarchive
    - Copy conversation as Markdown

    Each item is the palette command of the same name, offered or refused for the same reasons.

14. Hovering or focusing a row shows two buttons at its right: **Pin** and **Archive**, or
    **Unarchive** on an archived row. They do not take the keyboard from the list.
15. Ctrl+click and Space on a focused row add it to a selection or take it out. Shift+click and
    Shift+Up/Down extend the selection. While rows are picked, a bar above the list reads "3
    picked" and offers Pin, Unpin, Mark done, Reopen, Archive, Unarchive and Clear. Each action
    applies to the picked rows that allow it. The bar says how many it skipped and why ("1 is
    working"). Escape clears the selection.
16. Picking several rows sends one command per thread. Archive of several shows a notice with
    **Undo**, which unarchives the same threads.

### New since you looked (U5)

17. The server stores, per thread, the last item the user saw: the newest item when the thread
    was last marked seen. Opening a thread whose `seen` is false shows a divider **New since you
    looked** before the first item after that one. The conversation opens there, not at the
    bottom.
18. The divider stays until the user leaves the thread or sends a message. It is not found by
    Find and not written in the export.
19. **Shift+End** (`keybindings.jumpToNew`, "Go to what is new" in the palette) goes to the
    divider while it shows.
20. Threads from before this change, and threads never seen, open at the bottom as today.

### A map of the thread (U6)

21. **Outline** is a tab of the side panel in a chat thread (Details → **Show outline**,
    `keybindings.threadOutline` Ctrl+Shift+U, palette "Show outline"). It lists, in order, one
    row per user message (its first line and time) with the turn's summary (spec 1) under it,
    and the marked answers. It also shows the divider of spec 17 when present. The filter at the
    top narrows rows by text. Enter or click scrolls the conversation to the row's item and puts
    the keyboard on it.
22. **B** on a message that has the keyboard (`keybindings.markMessage`, "Mark message" /
    "Unmark message" in the palette, or its button on hover) marks an assistant answer or a user
    message. A marked message shows a bookmark sign. Marks are kept on the server per thread and
    survive restarts, forks and edits of other messages. A message that Edit replaced keeps its
    mark under Earlier version.
23. **Alt+Shift+Up / Down** (`keybindings.previousMark`, `keybindings.nextMark`) move between
    marked messages.
24. A step's thread in the panel and the Assistant have no outline and no marks.

### Plan limits (U7)

25. When a provider reports how much of a plan limit is used, the adapter turns it into
    `ProviderLimit` events:
    - **window**: `fiveHour`, `week`, `weekModel` with the model family, or `other` with the
      provider's own name;
    - **used percent**;
    - **reset time**;
    - **state**: `ok`, `warning` or `reached`.

    The sources are:
    - Claude Code sends them as rate-limit events in the stream.
    - Codex sends them with its token counts and its account notifications, where its version
      does.

    Nothing is fetched or estimated otherwise, and a provider that says nothing shows nothing.

26. The server keeps the latest of each window per provider instance, with when it was reported,
    and publishes it in the `providerLimits` topic. A window whose reset time has passed is shown
    as "reset at <time>, not reported since", not as used.
27. The composer bar shows the instance's highest window when it is at or above
    `chat.limitWarnPercent` (80), as "5 h: 84 % · resets 16:40". It is amber from the warning
    percent and red when reached. Hovering lists every window.
28. Settings → Providers shows every window of each instance with its bar, reset time and when
    it was reported. The usage view shows them too (spec 39).
29. When a window crosses `chat.limitWarnPercent` or is reached, wow shows a notice once per
    window per reset: "Claude Code: 5-hour limit at 85 %, resets 16:40". It follows
    `chat.notifications`. A turn refused because a limit is reached shows the reset time in its
    error row, where the provider sent it.
30. No account name, email or plan tier is shown or stored with the limits.

### Pictures in tool rows (U8)

31. When a tool's result holds images, the adapter hands them to wow as bytes with their media
    type. Examples are a browser screenshot over MCP, Claude Code reading a PNG, and Codex's
    image view.
    - Claude Code: image blocks in a tool result.
    - Codex: an image view's path, read by the server, and image content in an MCP result.
32. The server stores each image as an attachment of the thread, the same way and with the same
    limits as images in a message (PNG, JPEG, GIF, WebP up to `chat.imageMaxBytes`). The tool
    call's payload names the stored ids. An image over the limit or of another type is not
    stored; the row says "1 image not shown (too large)". Text in the result stays as today, and
    the `[image]` placeholder line is no longer added for a stored image.
33. The tool row shows its images as thumbnails under its line, also while the row is closed,
    at most `chat.toolImagesShown` (4) with "+N more", which opens the row. A click or Enter
    opens one full size, as a message's image opens. In a group of tool calls, the group line
    shows the count ("2 images") and the thumbnails show when it is opened.
34. Find matches "image" in a tool row with images. The Markdown export writes
    "(2 images)" on the tool's line. The images are deleted with the thread's other attachments.

### More in a message (U9, U10, U11)

35. **Files** (U9): dropping, pasting or picking a file other than an image ("Attach a file to
    the message…" in the palette) puts it in the message as a chip with its name and size.
    - A file inside the thread's folder becomes an `@` mention of its relative path, as the `@`
      list makes it.
    - A text file (UTF-8 without NUL, up to `chat.attachTextMaxBytes`, 200 KB) is stored as an
      attachment. When sent, it goes in after the message text as a fenced block headed by its
      name.
    - A PDF up to `chat.attachDocumentMaxBytes` (10 MB) goes to Claude Code as a document of the
      message. For Codex, which takes none, it is refused with that reason.
    - Anything else, and anything over the limits, is refused with the reason and not added.

    The sent message shows the chips. A click shows the text that was sent, or opens the PDF in
    the system viewer. Retry sends them again. Nothing is written into the thread's folder.

36. **Threads and backlog items** (U10): the `@` list has two more sections after the files.
    - **Threads**: other threads, newest first, matched by title.
    - **Backlog**: open backlog items, matched by title.

    A pick becomes a chip. When the message is sent, wow adds a block after the text for each:
    - for a thread: its title, project and its last answer (or, with `chat.mentionThreadWhole`
      on, the thread as its Markdown export without tool output), cut at
      `chat.mentionMaxChars` (20 000) with a line saying so;
    - for a backlog item: its title, state, tags and body.

    The sent message's chip shows what was added. The thread named is not changed or told.
    Workflow step threads and the Assistant thread are not offered. A thread or item deleted
    before sending is dropped from the message with a notice.

37. **Host items** (U11, waits on intent open question 1): the `@` list gets a third section,
    **Issues and tickets**. It holds the items wow has already read for the project's hosts:
    chips seen in its threads, and items opened in the panel. A pick asks once per message:
    "The text of #14 was written on github.com by others. Send it to the agent as quoted
    text?". On yes, the item's title, state and body, as wow last read them, go after the text
    in a fenced block marked as quoted host text. wow never fetches an item for this. A project
    setting `chat.mentionHostItems` (off by default) has to be on for the section to show.
38. The Assistant's composer and a step's composer offer none of spec 35 to 37.

### Usage view (U12)

39. **Usage** (`/chat/usage`; palette "Show usage"; a link at the foot of the thread list) shows
    tokens (input, output, cached) and cost over a range:
    - the range is Today, 7 days, 30 days or This month;
    - the rows are per day, with a small bar per day;
    - totals are given per project, per provider instance and per model.

    The plan limits of every instance (spec 28) are at the top. A cost the provider did not
    report is shown as "—" and counted as unknown, not as zero.

40. The figures come from the stored usage of turns, the Assistant's included and marked as
    such, grouped by the turn's end in the user's time zone. Turns without usage are counted as
    "no usage reported". Clicking a project or model narrows the day rows to it.
41. The view reads only. It has no budgets and stops nothing.

### Old data

42. Threads, turns and items stored before load and look as they did. They have no summary, no
    stored change count (the row leaves the part out), no last-seen item (spec 20), no marks and
    no tool images.

## Interface

### U1 Turn summary

- Decided: `ChangeCount {files, added, removed}` in `packages/contracts/src/projections.ts`;
  `UsageItemPayload.changes?: ChangeCount | null` and `Thread.changeCount?: ChangeCount | null`.
- Decided: after a chat turn's end snapshot, `FolderSnapshots` diffs the turn's start and end
  trees in wow's store (`git diff-tree --numstat`) and reads the thread's Changes
  (`readThreadDiff`), then dispatches `thread.turnChangesMeasured {threadId, turnId, changes,
threadChanges}`. The engine patches the usage row (none is added) and emits
  `thread.changeCounted`.
- Decided: `threads.diff` takes `turnId?`; for a turn other than the last, `turnPaths` are that
  turn's files from its snapshots.
- Web: `chat/turn-summary.ts` (the words, from the usage row and the turn's tool rows),
  `chat/items.tsx` (usage row), `chat/thread-changes.tsx` (a turn other than the last),
  `chat/find.ts`, `chat/conversation-markdown.ts`.

### U2 Rows

- Decided: `Thread.tasks?: {done, total} | null`, set when a task list item is written.
- Decided: `threadActivity` rows already give the activity. The row reuses at-work's `where` and
  activity wording (`apps/web/src/chat/at-work.tsx`), moved to `chat/activity-words.ts`.
- Decided: setting `chat.threadRowDetail` (array of the five parts, all by default).

### U3 Tidy list

- Decided: settings `chat.threadListFolded` (array of group keys; `done` by default),
  `chat.doneArchiveDays` (int 0–365, 14), `chat.threadListGroupBy` (`state` | `project`). The
  archiving runs in the existing scheduler's daily tick on the server and emits
  `thread.archived` with `by: 'age'`. Palette ids `chat.groupByState`, `chat.groupByProject`.

### U4 Row actions

- Decided: shadcn `context-menu` added to `apps/web/src/components/ui` with the shadcn CLI, not
  restyled. Selection lives in `threadListStore` (`picked: string[]`). There is no new server
  command; bulk actions dispatch the existing per-thread commands.

### U5 New since you looked

- Decided: `Thread.seenItemIndex?: {turnIndex, itemIndex} | null`, set by the existing
  mark-seen command to the thread's newest item. Setting `keybindings.jumpToNew` (Shift+End).

### U6 Outline and marks

- Decided: commands `thread.markItem {threadId, itemId}` and `thread.unmarkItem`, event
  `thread.itemMarked {threadId, itemId, marked}`, `Thread.marks?: Id[]`. A fork copies the marks
  of the items it copies.
- Decided: panel tab kind `outline {threadId}`. Settings `keybindings.threadOutline`
  (Mod+Shift+U), `keybindings.markMessage` (B, on a message), `keybindings.previousMark`
  (Alt+Shift+Up), `keybindings.nextMark` (Alt+Shift+Down).

### U7 Plan limits

- Decided: `ProviderLimit {window, model?, usedPercent: number | null, resetsAt: Timestamp |
null, state: 'ok' | 'warning' | 'reached'}` and provider event `limits {limits:
ProviderLimit[]}` in `packages/contracts/src/provider.ts`. Topic `providerLimits` (global):
  `{providerInstanceId, limits, reportedAt}[]`, kept in SQLite so a restart shows the last
  report.
- Claude: `rate_limit_event` messages (`rate_limit_info`: `rateLimitType`, `utilization`,
  `resetsAt`, `status`) in `packages/provider-claude/src/adapter.ts`. The SDK's experimental
  usage call is not used.
- Codex: the rate limits Codex sends with token counts and in its account rate-limit
  notification. The generated protocol under `packages/provider-codex/src/protocol/generated`
  is regenerated from the pinned Codex version if it lacks them.
- Decided: settings `chat.limitWarnPercent` (int 1–100, 80).

### U8 Tool images

- Decided: `ProviderEvent` tool output gets `images?: {base64, mediaType}[]`. The tool call
  payload gets `images?: SentImage[]` and `imagesOmitted?: {count, reason}`. Stored through the
  attachments store under the thread's folder.
- Decided: setting `chat.toolImagesShown` (int 1–20, 4).

### U9 Files

- Decided: `AttachmentMediaType` gains `text/plain` and `application/pdf`. `AttachmentId`
  allows `txt` and `pdf`. `SentFile {id, mediaType, name, size}` sits beside `SentImage` on the
  message. Text is sniffed by the server (UTF-8, no NUL).
- Decided: settings `chat.attachTextMaxBytes` (200 000), `chat.attachDocumentMaxBytes`
  (10 000 000).

### U10 Mentions of threads and backlog items

- Decided: `SentMention {kind: 'thread' | 'backlog', id, title, text}` on the message, `text`
  being exactly what was added. The server builds `text` when the message is sent, never the
  client.
- Decided: settings `chat.mentionMaxChars` (20 000), `chat.mentionThreadWhole` (false).

### U11 Mentions of host items

- Decided: `SentMention.kind` gains `hostItem` with the host link key. Project setting
  `chat.mentionHostItems` (false). Reads only what `hostLinks` already stored.

### U12 Usage

- Decided: RPC `usage.summary {from, to, timeZone}` answers rows per day × project × provider
  instance × model with token sums, cost sum, unknown-cost and no-usage counts. Route
  `/chat/usage`, palette id `chat.showUsage`.

## Boundaries and non-goals

- No new provider ability: every part shows what the providers send. Where one sends nothing
  (Codex subagent work, Claude command output in the background, limits on an API key), the part
  is absent and says why where it would be expected.
- Nothing is written into a thread's folder by attachments, mentions or the summary.
- No fetching from hosts for mentions; no host text goes to an agent without the owner's yes
  (open question 1) and the per-message confirm.
- The usage view never limits, warns about money, or stops a turn.
- The Assistant keeps its own composer rules.

## Decisions

- **Persisted state only.** Rows, summaries, the divider and the limits are computed on the
  server and stored. The UI derives nothing from its own clock (CLAUDE.md).
- **One measure of a turn's changes.** The summary uses the same start mark and snapshots as
  Changes and Restore, so the numbers agree everywhere.
- **Attachments, not files in the folder.** A dropped file outside the folder is stored in wow's
  home and sent as text or a document, so the agent's folder and its permissions are untouched.
- **Mentions are copied at send time.** The block is fixed in the message, so the thread shows
  exactly what the agent got, even when the named thread goes on.
- **Host text needs two yeses.** A project setting and a per-message confirm, because host text
  is written by others.

## Security

- Tool images and attachments are checked by their bytes, stored under wow's home with ids the
  server picks, and served only to the app, as message images are.
- PDFs are never rendered inside wow. They open in the system viewer.
- Limits carry no account details. Usage figures stay local.
- Host items (U11) are quoted, marked as text from others, and confirmed per message.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm --filter @wow/server test` covers:
  - the turn summary and change count;
  - auto-archive by age;
  - the last-seen item;
  - marks;
  - limits from recorded Claude and Codex messages, the warning crossing and a passed reset;
  - tool images stored and refused;
  - text and PDF attachments;
  - mention blocks built at send;
  - the usage summary over turns in two time zones.
- `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex test` cover
  limits and tool images from invented recorded streams.
- `pnpm --filter @wow/web test` covers:
  - the row's parts and the setting;
  - time groups and folding;
  - the context menu and selection;
  - the divider and its key;
  - the outline and mark keys;
  - the composer limit chip;
  - tool thumbnails;
  - file chips;
  - the `@` sections;
  - the usage view.
- Playwright (`apps/web/e2e`) covers one path per area against the mocked providers: a turn ends
  with a summary that opens Changes; a row shows a running command; picking two rows and
  archiving them.

## Open risks

- Claude Code sends a rate-limit event only for claude.ai plans, and it may send only the window
  that is closest to its limit. The composer then shows that one, and Settings shows what was
  reported, with when.
- Codex's limit fields have changed between versions. When the pinned version's protocol lacks
  them, U7 ships Claude only and says so in the release note.
- PDFs as documents depend on Claude Code's SDK accepting a document block in a user message;
  U9 checks it against the pinned SDK and, if it does not, refuses PDFs on Claude too.
- Auto-archive changes a thread without the user acting. It never touches pinned threads, and
  the notice-free way back is the filter, which still finds archived threads.
