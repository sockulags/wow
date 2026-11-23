---
intent: 2026-11-orchestrator-threads
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: Main threads that run the work

Eight units. U1 comes first. After it, U2, U3 and U4 can run side by side, since each touches a
different seam of the helper code. U5 needs U3's cards and U4's `ask_questions`. U6 needs U5's
workflow files. U7 needs U3's "waits for you" state. U8 removes what U4 to U7 replaced, so it
comes last. Every unit updates its section of `docs/architecture.md` (and the settings list and
data model there) and `docs/user-guide.md`, adds a line to `docs/windows-smoke.md` for each
provider fact it relies on and has not seen against the real program, and leaves the repository
checks green.

## Units

- [U1] Helpers in depth
- [U2] Bringing helpers' work together — depends on U1
- [U3] Gates in the main thread — depends on U1
- [U4] The assistant in every main thread — depends on U1
- [U5] Workflows as text — depends on U3, U4
- [U6] Scheduled jobs as main threads — depends on U5
- [U7] Threads in front — depends on U3
- [U8] Remove what was replaced — depends on U4, U5, U6, U7

### U1 Helpers in depth

Outcome: a helper below `chat.helperDepth` can start helpers of its own, in any folder or Git
repository it names, and their answers come back to it; stopping a thread stops its whole tree.
Boundaries: no gate cards in the main thread (U3); no `merge_helpers` or new `read_helper`
fields (U2); no assistant tools on `/threads/mcp` (U4); the thread list is unchanged (U7).
Change surface: `apps/server/src/helpers/decide.ts` (the "cannot start helpers" refusal, limits,
`folder`), `helpers/endpoint.ts` (`grant` for helpers below the depth), `helpers/helper-tools.ts`
(input and tool texts by depth), `helpers/follow.ts` (tell the parent), `core/threads.ts`
(`refuseWhileHelpersWork` and interrupt over the tree), `packages/contracts/src/helpers.ts`,
`packages/contracts/src/settings.ts`; a migration if depth needs an index.
Acceptance:

- Given `chat.helperDepth` 2, when a main thread's helper calls `start_helper`, then a helper at
  depth 2 starts, and its session has no helper tools (spec 4).
- Given `folder` in a second Git repository and `isolation: 'copy'`, then the helper's folder is a
  new worktree on `wow/helper/<id>` at that repository's `HEAD`; given a folder outside Git, then
  the tool answers why and nothing starts (spec 5).
- Given a depth 2 helper whose turn ends, then the depth 1 helper gets the "From wow: your
  helper …" message and the main thread gets nothing (spec 7).
- Given Stop on the main thread's turn, then working helpers at depth 1 and 2 are interrupted in
  the same commit; given Mark done while the depth 2 helper works, then it is refused naming it
  (spec 8).
- Given `chat.helpersPerTree` working helpers under one main thread, then `start_helper` anywhere
  in that tree answers which limit and starts nothing (spec 9).
- Given a Read only main thread, then a depth 2 Codex helper gets `read-only` (spec 10).
- Given a helper stored before this unit, then its depth is 1 and its row loads (spec 36).

Ground truth: `pnpm --filter @wow/server test` (helpers endpoint and decide tests extended with
the cases above), `pnpm --filter @wow/contracts test`, repository checks.
Dependencies: none.
Evidence and settled decisions:

- Depth is derived from the parent chain, not stored (spec Interface).
- `chat.helpers` is removed and the tools are always on for main threads (spec 3); the setting's
  stored values are dropped, not migrated.

Delivery target: pull request.
Open risks:

- A Codex helper that itself carries `mcp_servers.wow` with its own token is unseen against the
  real app-server; add a smoke line and keep the depth 1 path unchanged so only depth 2 is at risk.

### U2 Bringing helpers' work together

Outcome: the main agent can see each helper's branch and commits and get a worktree of its own
to merge them in, so the user reviews one merged branch in the main thread's Changes.
Boundaries: wow runs no merge itself; the project folder is never touched; Apply and Commit and
pull request are as today.
Change surface: `apps/server/src/helpers/helper-tools.ts` (`read_helper` fields, `merge_helpers`,
tool texts per spec 11), `apps/server/src/projects/git.ts` (branch, ahead count),
`apps/server/src/workspaces/` and the thread working copy code that `isolation: 'copy'` uses.
Acceptance:

- Given two helpers with copies of one repository, then `read_helper` answers each one's folder,
  repository, branch and commits ahead (spec 6).
- Given `merge_helpers` from a main thread without a worktree in that repository, then a worktree
  on `wow/thread/<id>` is made from `HEAD` and its path answered, and `git status` of the project
  folder is unchanged (spec 12).
- Given a main thread that already has a worktree there, then `merge_helpers` answers its path and
  makes nothing (spec 12).
- Given the merged branch, then the main thread's Changes lists the merged files and Apply to
  project folder works from it (spec 13).

Ground truth: `pnpm --filter @wow/server test` with a temporary Git repository fixture, repository
checks.
Dependencies: U1 for `folder`, copies from any repository and the helper tree.
Evidence and settled decisions:

- The agent merges with its own Git tools; wow only prepares the worktree (spec Decisions).

Delivery target: pull request.
Open risks: none.

### U3 Gates in the main thread

Outcome: every approval and question for the user from any thread in a main thread's tree shows
as a card at the end of the main thread's conversation, answered there, while only the asking
thread waits.
Boundaries: the approval is still recorded and decided in the asking thread; the thread list's
mark is U7; workflow gates arrive through `ask_questions` in U5.
Change surface: contracts `gate_card` item (`GateCardItemPayload`), the projector
(`apps/server/src/core/projector.ts`) where approvals and questions are asked and answered,
`helpers/follow.ts`; web `chat/chat-view.tsx`, `chat/approval-card.tsx`, `chat/question-card.tsx`
(composed, not restyled), `chat/items.tsx`, `chat/find.ts`, `chat/conversation-markdown.ts`.
Acceptance:

- Given a depth 2 helper asking for an approval, then the main thread shows a card with the
  helper's title, provider and "Helper of <parent>"; Allow in it lets the helper go on (spec 14).
- Given a question from a depth 1 helper to the user, then the card shows its choices and free
  text, and the answer reaches the helper as its own `question.answer` (spec 14).
- Given a waiting card, then the main composer still sends to the main agent and other helpers
  keep working (spec 15).
- Given a question a helper asks its parent, then no card is drawn (spec 16).
- Given the card answered in the helper's own thread, then the main thread shows "Answered in
  <helper>" in its place (spec 18).
- `pnpm e2e` case "a Claude main thread's Codex helper starts a Claude helper whose approval is
  answered in the main thread".

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`, `pnpm e2e --grep
gate`, repository checks.
Dependencies: U1 for helpers at depth 2 and the tree walk.
Evidence and settled decisions:

- The card draws the asking thread's approval; the decision itself stays where it is today
  (spec Decisions, "Gates are drawn where they belong").

Delivery target: pull request.
Open risks: none.

### U4 The assistant in every main thread

Outcome: main threads may have no project, every main thread's agent has the assistant's app
tools, new threads start on a default instance and model, and the assistant's conversation is a
main thread named "Assistant".
Boundaries: the Assistant page, its briefings and the decision queue stay until U8; helpers get
none of the app tools; scheduled cards are U6.
Change surface: `apps/server/src/assistant/tools.ts` and `assistant/mcp.ts` (serve the app tools
through `helpers/endpoint.ts` for main threads), `assistant/thread.ts`, `core/threads.ts` (no
project, folder under `<wow home>/threads`), the provider service's `#chatTurn`
(`chat.instructions`), web new-thread defaults; settings `chat.defaultInstance`,
`chat.defaultModel`, `chat.instructions`; a migration for the assistant thread.
Acceptance:

- Given a new thread without a project, then its folder is `<wow home>/threads/<id>`, made empty
  before the first turn, and a non-empty folder fails the turn with what was found (spec 1).
- Given `chat.defaultInstance` and `chat.defaultModel`, then a new thread starts on them and the
  pickers can change them before the first message (spec 2).
- Given a main thread, then it can list projects and create a card; a change that lets the app do
  more on its own waits for the user's yes; a helper's session lists none of these tools (spec 24).
- Given the stored assistant thread, then after the migration it is a chat thread "Assistant"
  without a project, with its items and provider session, and `assistant.instructions` is now
  `chat.instructions` (spec 25).
- Given a main thread without a project, then `start_helper` with `folder` set to a project starts
  a helper there (spec 26).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/provider-claude test`,
`pnpm --filter @wow/provider-codex test`, repository checks.
Dependencies: U1 for the always-on helper endpoint that now also serves the app tools.
Evidence and settled decisions:

- Briefings, delegation rules and the decision queue are not carried over (intent decision log,
  2026-11-23); U8 removes them.

Delivery target: pull request.
Open risks:

- One MCP server now offers both tool sets to a session with the user's own tools; if a provider
  caps tool counts, keep the app tools behind fewer, broader tools and note it in the smoke list.

### U5 Workflows as text

Outcome: a workflow is a Markdown file the main agent follows; `/name text` in the composer starts
it in the thread; stored workflows are written out as files; Settings › Workflows lists and opens
them.
Boundaries: the builder, Runs and Triggers tabs stay reachable until U8; calendar cards keep
starting workflow runs until U6.
Change surface: new `apps/server/src/workflows/files.ts` (read, watch, write, one-time export),
the composer's slash list source beside skills (`apps/web/src/chat/composer.tsx`), the provider
service's message for a workflow start, web Settings › Workflows with the panel's file editor;
settings `workflows.followTemplate`, `workflows.newTemplate`.
Acceptance:

- Given a file with three steps on two providers and `gate: after` on the first, when the user
  sends `/name fix the timer`, then the main agent gets the workflow text, the user's text and the
  follow template, starts the first step as a helper on its instance and asks the user with
  `ask_questions` before the second (spec 19 to 21, with the mock providers).
- Given a project file and a user file of the same name, then the project's file is the one listed
  and used in that project's threads (spec 19).
- Given three stored workflows with gates and rules, then first start writes three files with
  steps, settings, `gate: after` lines and rules as text; a name clash writes `<name>-1.md`, and a
  second start writes nothing (spec 22).
- Given Settings › Workflows, then it lists each file with its place and "New workflow" makes one
  from `workflows.newTemplate` (spec 23).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`, repository checks.
Dependencies: U3 for gate cards; U4 for `ask_questions` in main threads.
Evidence and settled decisions:

- Files live in `<wow home>/workflows` and `<project>/.wow/workflows` (intent decision log).
- A workflow written by an agent waits for the user's yes, as a skill does (spec Security).

Delivery target: pull request.
Open risks:

- Agents may skip a gate written as text; if the e2e case shows it, strengthen
  `workflows.followTemplate` rather than adding an engine.

### U6 Scheduled jobs as main threads

Outcome: a calendar card's occurrence starts a new main thread, or continues the same one, that
runs the card's workflow, and the card follows that thread; event triggers are gone.
Boundaries: repeat rules, occurrences and missed policies as today; the Triggers tab's removal is
U8.
Change surface: `apps/server/src/scheduler/`, `core/triggers.ts` (start a thread, not a run),
`core/series.ts`, the card follow code; contracts `CalendarItem.threadMode`; web card editor (one
choice "New thread each time" or "Same thread"); a migration that sets `threadMode: new` and
deletes event triggers; removal of `triggers.*` settings.
Acceptance:

- Given a daily card with `new`, then each occurrence makes a main thread titled with the card and
  the day that starts the workflow with the card's text (spec 27).
- Given `same`, then each occurrence sends a message to the same thread; given that thread still
  working, then the occurrence is recorded `skipped` (spec 27, 28).
- Given a card thread with a waiting gate card, then the card shows `waiting`, and `done` or
  `failed` when the turn ends (spec 28).
- Given stored event triggers, then after the migration none remains and no `triggers.*` setting
  is listed (spec 29).

Ground truth: `pnpm --filter @wow/server test` with the scheduler's test clock, `pnpm --filter
@wow/web test`, repository checks.
Dependencies: U5 for starting a workflow in a thread.
Evidence and settled decisions: none.
Delivery target: pull request.
Open risks: none.

### U7 Threads in front

Outcome: the app opens on chat; the left side lists main threads with title, project and a status
in the order Waits for you, Working, Unread, Done; one settings button leads to Calendar, Backlog,
Workflows and Settings.
Boundaries: removed pages and their routes go in U8; the row menu, pin and multi-select stay.
Change surface: `apps/web/src/app/router.tsx` (`/` to `/chat`), `app/sidebar.tsx` and
`app/shell.tsx`, `chat/thread-sections.ts`, `chat/thread-row.ts`, `app/commands.ts`; contracts
`ThreadListStatus`, computed on the server from the thread tree.
Acceptance:

- Given the app starts, then it shows chat (spec 30).
- Given a main thread whose depth 2 helper waits for an approval, then its row has the exclamation
  mark and is listed first; given helpers, then none of them is a row (spec 30, 31).
- Given threads in each status, then they are ordered Waits for you, Working, Unread, Done, newest
  activity first within each (spec 31).
- Given the settings button, then each of its four entries opens its page and Escape goes back to
  the thread (spec 33).

Ground truth: `pnpm --filter @wow/web test`, `pnpm e2e --grep shell`, repository checks.
Dependencies: U3 for the "waits for you" state of a tree.
Evidence and settled decisions:

- The look follows `docs/architecture.md`, "Look", and composes shadcn components; the status mark
  uses an existing attention colour token.

Delivery target: pull request.
Open risks: none.

### U8 Remove what was replaced

Outcome: plans, plan runs, the review loop, workflow runs and the engine, the builder, the Runs
and Triggers tabs, the Assistant page with its briefings and the decision queue, Threads at work,
the Usage view and Quick ask are gone with their routes, commands, settings and rows.
Boundaries: usage records and provider limits stay on the server; intent files in repositories
are untouched; step threads stay as done threads.
Change surface: `packages/workflow-engine`; server `core/plan-runs.ts`, `plans/`,
`workflows/runner.ts`, `core/orchestrator.ts`, `assistant/chief.ts`, `assistant/decisions.ts`,
the projector's cases for these events; web `plans/`, `workflows/` runs and builder,
`assistant/`, `chat/at-work.tsx`, `chat/usage-view.tsx`, `quick-ask/`; the e2e specs for those
pages; a migration.
Acceptance:

- Given a database with plans, plan runs, workflow runs, triggers, briefings and decisions, then
  after the migration their rows are gone, step threads are done chat threads, and usage records
  and provider limits remain (spec 35).
- Given a restart after the migration, then the projector does not bring the removed rows back
  (spec 35).
- Given each removed route, then it does not resolve, and the palette lists no command for it
  (spec 34).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`, `pnpm e2e`,
repository checks.
Dependencies: U4 for the assistant thread already moved; U5 and U6 for workflows and schedules no
longer using runs; U7 for the new navigation.
Evidence and settled decisions:

- wow keeps an event store (`events`). Removing a feature means its events are skipped by the
  projector or deleted in the migration, so a rebuild cannot restore them.

Delivery target: pull request.
Open risks:

- The removal is wide; if the diff passes about 10,000 lines, split server and web removal into
  two pull requests under this unit rather than leaving dead code.
