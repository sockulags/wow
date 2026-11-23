---
intent: 2026-11-orchestrator-threads
rev: 2
built_on: intent@1
status: accepted
---

# Main threads that run the work

## Summary

A main thread is a chat thread the user started, with or without a project. Its agent has wow's
helper tools and the assistant's tools. Helpers (subagents) can start helpers down to
`chat.helperDepth`, in any folder or Git repository the starting agent names, sharing it or in
their own worktree. Every approval and question for the user from any depth is drawn in the main
thread's conversation and answered there. A workflow is a Markdown file that the main agent
follows in its own thread, started with `/<workflow> text` or by a scheduled calendar card. The
left side lists main threads by status; Calendar, Backlog, Workflows and Settings sit behind one
button. Plans, plan runs, the review loop, workflow runs with step threads, event triggers, the
Assistant page with its briefings and the decision queue, Threads at work, the Usage view and Quick ask are removed.

This builds on helper threads (`2026-11-agent-orchestration`), the assistant's MCP endpoint and
tools (`2026-11-app-assistant`), threads' working copies and Apply (`2026-11-thread-work`,
`2026-11-parallel-threads`), repeating cards (`2026-11-recurring-cards`) and wow skills
(`2026-11-wow-skills`).

## Behavior

### Main threads

1. A main thread is a chat thread with no `parentThreadId` and no `runId`. It has a project or
   none (`projectId` null). Without a project its folder is `<wow home>/threads/<threadId>`, made
   empty before its first turn, as the assistant's folder is today.
2. A new thread's instance and model come from `chat.defaultInstance` and `chat.defaultModel`
   (global), else the instance's own default. The user changes them in the new thread before the
   first message with the pickers that exist today.
3. Every main thread's agent carries the helper tools (spec 5) and the assistant's app tools
   (spec 24) beside its provider's own tools. There is no `chat.helpers` switch any more; the
   tools are always there.

### Helpers in depth

4. A helper is a thread with `parentThreadId` set to the thread that started it. Its depth is its
   parent's depth plus one; a main thread has depth 0. A helper whose depth is below
   `chat.helperDepth` (global, default 2, 1 to 5) carries the helper tools too; one at the limit
   carries none, and its tools' descriptions do not mention helpers.
5. `start_helper {brief, instance?, model?, effort?, folder?, isolation?: 'folder' | 'copy', title?}`
   works as in `2026-11-agent-orchestration` with two changes:
   - `folder` names any folder on the machine the starting thread may read (an absolute path, or
     relative to the starting thread's own folder). Absent, the starting thread's folder.
   - `isolation: 'copy'` makes a worktree on a new branch from the Git repository that holds
     `folder`, at that repository's current `HEAD`, refused with the reason when `folder` is not in
     Git. The branch is `wow/helper/<helperId>`.
6. `read_helper` answers, beside today's fields, the helper's folder, its repository, its branch
   and its commits ahead of where it started, so the agent can find the work.
7. A helper's end, failure or question is told to the thread that started it, not to the main
   thread, with the "From wow: your helper …" message of today. The thread that started it
   answers its question with `answer_helper_question`, or asks its own parent or the user.
8. Coupling covers the whole tree: stopping a thread's running turn stops every working helper
   under it, at any depth. Mark done, archive and removing a working copy are refused while any
   helper under the thread works, naming the deepest one that works.
9. Limits: `chat.helpersPerThread` counts a thread's own working helpers, `chat.helpersLive`
   counts all working helpers on the machine, and `chat.helpersPerTree` (global, default 8) counts
   the working helpers under one main thread. Over a limit `start_helper` answers which limit in
   words and starts nothing.
10. A helper's permission mode is its parent's, mapped as today (`helperPermissionMode`), so no
    thread in a tree has a wider mode than the main thread.

### Bringing work together

11. Each helper's work stays on its branch or in its shared folder. The tool descriptions tell the
    agent that when two or more of its helpers worked in their own copies of the same repository,
    it should have their branches merged with `merge_helpers` before it reports, and tell the user
    which merge helper holds the result.
12. `merge_helpers {ids, instance?, model?, effort?, title?}` starts a merge helper: a helper of the
    calling thread, in its own copy of the repository the named helpers' copies belong to, whose
    brief (`chat.mergeBrief`) lists their branches in order and tells it to merge them into its
    own branch with Git, resolve conflicts, and report which merged, which conflicted and how it
    resolved them. It is refused, with the reason, when fewer than two helpers are named, when one
    is not the caller's, has no copy of its own or works, or when their copies belong to different
    repositories. The limits of spec 9 and the depth of spec 4 apply as to any helper. The user's
    project folder is not touched.
13. The merge helper's Changes shows the merged work, and Apply to project folder and Commit and
    pull request work from there as for any thread with its own copy. The agent's report names the
    merge helper; the user opens it from its row. A helper's copy goes when its main thread is
    done, under the rules for working copies today.

### Gates in the main thread

14. An approval or a question for the user from any thread in a main thread's tree is drawn in the
    main thread's conversation, at the end, as a card: which helper asks (its title, provider and
    depth, "Helper of <parent>" when the parent is not the main thread), and the approval or the
    question as today's cards draw them. The user answers in that card. The answer goes to the
    asking thread exactly as if he had answered in its own thread.
15. Only the asking thread waits. The main thread's composer stays open; a message sent while a
    card waits goes to the main agent as usual.
16. A question a helper asks its parent (spec 7) is not a gate: it goes to the parent's agent. It
    becomes a card for the user only when the parent passes it on with `ask_questions` or the user
    is asked directly by an approval.
17. No agent can answer an approval. `answer_helper_question` refuses an approval, as today.
18. A card answered elsewhere (in the helper's own thread in the panel) disappears from the main
    thread's conversation, with a line "Answered in <helper>".

### Workflows as text

19. A workflow is a Markdown file `<name>.md` in `<wow home>/workflows` or in
    `<project>/.wow/workflows`; a project's file wins over the user's own of the same name in
    threads of that project. Its front matter holds `name`, `description` and optional defaults
    `instance`, `model`, `effort`. Each `## ` heading is a step. Under it, free text says what the
    step does, and optional lines `instance:`, `model:`, `effort:`, `skill:`, `isolation:` and
    `gate: after` set how it runs. A step without `instance` runs on the workflow's default, else
    on the main thread's instance.
20. In the composer, `/` lists workflows beside skills. Sending `/<name> text` starts the workflow
    in that thread: wow sends the main agent the workflow's text, the user's text and
    `workflows.followTemplate` (global), which tells the agent to run each step as a helper with
    the step's settings, to pass on what earlier steps produced, and at a `gate: after` to ask the
    user with `ask_questions` before it goes on.
21. A gate in a workflow is a question card (spec 14) from the main agent. Conditions, loops and
    skips that the builder used to model are written as text in the step; the agent follows them.
22. Workflows that exist in the database are written out as files on first start after the
    upgrade, one per workflow, in `<wow home>/workflows` (a project-scoped one in its project's
    folder), with steps, gates and step settings. Rules between steps are written as text under the
    step. A file that exists is not overwritten; the workflow is then written as `<name>-1.md`.
23. Settings › Workflows lists the files with their place, opens one in an editor in the panel and
    makes a new one from `workflows.newTemplate`. The builder, the Runs tab and the Triggers tab
    go.

### The assistant in main threads

24. The assistant's app tools (settings, projects, trackers, workflows, cards, backlog, the
    readers of mail and calendar, `ask_questions`, `show_secret_field`) are served on `/threads/mcp`
    to every main thread, under each tool's rules from `2026-11-app-assistant`: changes that let
    the app do more on its own still wait for the user's yes. A helper does not get them.
25. The assistant thread (`kind: assistant`) becomes an ordinary main thread without a project, on
    the same instance and model, with its conversation and provider session kept, titled
    "Assistant". The `assistant.*` settings that chose its instance, model and instructions move:
    `assistant.instructions` becomes `chat.instructions`, sent to every main thread; the others go.
26. Delegation tools of the assistant (start a run or a thread for the user) are replaced by
    `start_helper`; a main thread without a project starts helpers with `folder` naming a project.

### Scheduled jobs

27. A calendar card with a workflow and a project (or without a project) starts, at each
    occurrence, a main thread that runs the workflow as in spec 20 with the card's text as the
    user's text. `CalendarItem.threadMode` is `new` (a new main thread per run, titled with the
    card and the day) or `same` (the same main thread every time; the next run is a new message in
    it, waiting in the queue if the thread is still working).
28. The card follows its thread: `running` while the thread works, `waiting` while a card in it
    waits for the user, `done` or `failed` when the turn ends. An occurrence whose `same` thread is
    still working is recorded `skipped` as today.
29. Event triggers are removed with their settings (`triggers.*`). A trigger row of kind event is
    deleted by the migration.

### Navigation and the thread list

30. The app opens on chat (`/` goes to `/chat`). The left side is the thread list, showing main
    threads only. A row has the title on the first line and the project name (or "No project") under
    it, and a status mark.
31. Statuses, in this order of sorting: **Waits for you** (a card waits anywhere in its tree;
    a small exclamation mark in a ring of the attention colour), **Working** (the main thread or
    any helper under it works), **Unread** (a turn ended since he last looked), **Done** (the rest).
    Within a status the newest activity first. Archived threads are hidden as today.
32. The list keeps pin, archive, mark done and the row menu from `2026-11-chat-overview`; its time
    groups and its group by project go.
33. One settings button at the bottom of the left side opens a menu: Calendar, Backlog, Workflows,
    Settings. Each opens its page in the main area; Escape or the thread list goes back. Palette
    commands and keybindings for each page stay.
34. Removed pages and their routes: `/workflows/runs`, `/workflows/triggers`, `/workflows/$id`
    builder, `/plans`, `/assistant`, `/chat/work`, `/chat/usage`, Quick ask. A link or palette
    command to one of them is removed with it.

### What is removed and old data

35. The migration deletes plans, plan runs, workflow runs and their step threads' links, event
    triggers and the decision queue's rows. Step threads stay as ordinary threads, marked done.
    Usage records and provider limits stay. Intent files in repositories are not touched.
36. Threads and helpers stored before keep their depth (a helper stored before is depth 1).

## Interface

- Contracts: `Thread.depth` (derived, not stored), `CalendarItem.threadMode`, the `start_helper`
  input with `folder`, `read_helper` answer with `folder`, `repository`, `branch`, `ahead`, tool
  `merge_helpers`, item kind `gate_card` (`GateCardItemPayload {fromThreadId, kind: 'approval' |
'question', requestId}`) on the main thread, `ThreadListStatus` `waits_for_you | working |
unread | done`. Removed: plan run, workflow run and trigger contracts that only the removed pages
  use.
- Server: `helpers/` gains depth, tree limits and `merge_helpers`; `/threads/mcp` serves the
  assistant's app tools; `workflows/files.ts` reads and writes workflow files and the one-time
  export; the scheduler starts main threads; the workflow engine, runner and plan runs go.
- Web: the thread list (`chat/thread-sections.ts`, `chat/thread-row.ts`), the gate card in the
  conversation, the settings button and its menu, Settings › Workflows; removed views as in spec 34.
- Settings: added `chat.helperDepth` (2), `chat.helpersPerTree` (8), `chat.defaultInstance`,
  `chat.defaultModel`, `chat.instructions`, `chat.mergeBrief`, `workflows.followTemplate`,
  `workflows.newTemplate`.
  Removed: `chat.helpers`, `assistant.*`, `triggers.*`, `workflows.planRun*`, the review loop's
  and the builder's settings.

## Boundaries and non-goals

- No change to Claude Code's or Codex's own subagents.
- wow does not merge branches itself; a merge helper does, with Git, in its own copy.
- No direct messages from the user to a helper.
- No workflow engine: a workflow's order, gates and conditions are text the agent follows.

## Decisions

- **The main agent drives a workflow.** One thread per piece of work is what the owner asked for;
  a written procedure needs no engine, and gates become ordinary question cards.
- **Gates are drawn where they belong and shown where he is.** The approval stays in the asking
  thread, so answering it changes nothing in the providers; the main thread only draws it.
- **Answers go to the parent, not to the main thread.** Each agent coordinates the helpers it
  started, as Claude Code's subagents do; the main thread sees the result through its own
  helpers.
- **A merge helper merges.** Which branches belong together is a judgment about the task, so the
  agent picks them. The merge runs in a helper's own copy because a thread cannot move to another
  folder once its session started (both providers bind a session to its folder) and a Codex
  session may write only in its own folder; a merge helper works the same on both, and its copy
  keeps the user's folder untouched until he asks (owner's choice, 2026-11-23).
- **The assistant folds into every main thread** rather than staying a separate thread, since its
  tools are what a project-less main thread needs, and one kind of thread is simpler.

## Security

- A helper never has a wider permission mode than its main thread (spec 10).
- `folder` reaches only where the starting thread's own provider may read; wow checks that the
  folder exists and is not wow's home, and names it in the helper's row.
- The assistant's app tools keep their yes-first rules in every main thread, and never answer an
  approval or reveal a secret.
- A workflow file is text the user wrote or approved; a workflow written by an agent waits for his
  yes, as a skill does today.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm --filter @wow/server test` covers depth and its limit, tree coupling and limits, `folder`
  and copies in another repository, answers to the parent, `merge_helpers`, gate cards from depth
  2, the app tools on `/threads/mcp`, the assistant thread's move, workflow files and their export,
  scheduled jobs with `new` and `same`, and the migration of removed rows.
- `pnpm --filter @wow/web test` covers the gate card, the thread list's statuses and order, the
  settings menu, Settings › Workflows and that removed routes are gone.
- `pnpm e2e` with the mock providers covers a Claude main thread whose Codex helper starts a
  Claude helper that asks for an approval, answered in the main thread.

## Open risks

- How well agents follow a workflow written as text, compared with the engine's fixed order;
  to be watched in use and tuned in `workflows.followTemplate`.
- Merge conflicts the agent resolves wrongly. The main thread's Changes and the user's review
  before Apply or a pull request are the check.
- A deep tree multiplies what runs on the machine; the depth and tree limits keep it bounded.
