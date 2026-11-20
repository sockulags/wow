---
intent: 2026-11-chief-of-staff
rev: 1
built_on: spec@1
status: draft
source: files
---

# Plan: An assistant that runs the work around me

Execution: seven units, each by a worker and an independent reviewer. U1 and U6 can start at
once; U2 and U4 follow U1; U3 follows U2; U5 follows U2 and U4; U7 closes. Every unit updates
`docs/architecture.md` and `docs/user-guide.md` for what it changes, keeps the assistant's class
table test complete, and leaves the repository checks green.

## Units

- [U1] Reading what agents produced, and memory
- [U2] Standing permissions — depends on U1
- [U3] Delegated threads and runs — depends on U2
- [U4] Decision queue — depends on U1
- [U5] Briefings, follow-through and quiet — depends on U2, U4
- [U6] Quick ask from anywhere
- [U7] End-to-end, guide and smoke — depends on U3, U5, U6

### U1 Reading what agents produced, and memory

Outcome: read tools for a run's steps (final message, verdict, artifacts with text content,
changes with a bounded diff, checks) and a thread's recent messages, waiting request and usage,
all through the secret net and refusing other files and excluded projects; their reads shown in
words in the conversation; assistant notes with a `remember` tool, a Memory page and notes read
at the start of every turn; a free-slot reader over work hours, meetings and focus cards.
Boundaries: no permissions, no delegation, no queue.
Change surface: `packages/contracts` (read tool results, `AssistantNote`, settings
`assistant.readMaxBytes`, `assistant.readMaxDiffLines`, `assistant.readMaxMessages`,
`assistant.excludedProjects`), `apps/server/src/assistant` (readers, notes, the tool-name test that
today forbids "thread" and "file" in names, rewritten to check what each reader returns),
a migration for notes, `apps/web/src/assistant` and Settings → Assistant → Memory, docs.
Acceptance: spec 1, 2, 3, 29, 30.
Ground truth: server Vitest for each reader (artifact read, a non-artifact path refused, a secret
in a final message hidden, an excluded project refused) and for notes; repository checks.
Open risks: large diffs and final messages; the limits are settings and the readers cut with a
marker.

### U2 Standing permissions

Outcome: `assistant.delegation` and permission rows (kind, workflows, projects, permission mode
cap, end date, daily limit, paused), Settings → Assistant → Permissions, the class table consulting
them so covered proposals become ordinary changes marked "under <permission>", refused and
widening commands untouched, the assistant able to propose a permission, and Focus cards.
Boundaries: no thread starting yet (U3); thread commands stay refused here.
Change surface: `packages/contracts` (permission schema, settings, the card's `focus` flag),
`apps/server/src/assistant/classes.ts` and `core/assistant.ts`, change rows, the card form and
calendar block, docs.
Acceptance: spec 4 to 8 for Plan runs, Start runs, Retry and Move cards, and 28.
Ground truth: a table test over every `ServerCommand` type with and without each permission
kind; scope, limit, end date and pause cases; `pnpm e2e --grep permissions`; repository checks.
Open risks: the class table grows new cases; the table test fails on any command type without
an entry, as today.

### U3 Delegated threads and runs

Outcome: Start threads and Drive threads; threads with `startedBy: assistant`, always in their own
working copy in a Git project, mode capped by the permission; the assistant's first message from
the user's words; follow turns when a delegated thread's turn ends or asks, up to
`assistant.followTurns`; questions answered with the quote they came from; approvals to the
queue; `assistant.maxDelegatedLive`; Start runs and Plan runs from a request; the offer of a
thread without the permission carrying a written brief.
Boundaries: never an approval or a gate answer. No change to how threads run.
Change surface: `packages/contracts` (`startedBy`, follow-turn and answer records, settings),
`apps/server/src/assistant` (thread tools, follow turns), the classes for the new thread
commands, the chat list and question card in `apps/web`, docs.
Acceptance: spec 9 to 15.
Ground truth: server Vitest with the mock provider: one request starts a thread in a working copy
with a capped mode; the turn's end gives the assistant a follow turn and the limit stops them; a
question answered with its quote; an approval left for the user; the live limit plans instead of
starting; `pnpm e2e --grep delegation`; repository checks.
Open risks: a follow-up that drifts from the request; the follow-turn limit and the rule that a new
piece of work is a new ask, checked in the instruction text and by the reviewer on transcripts of
the mock runs.

### U4 Decision queue

Outcome: a `decisions` projection of everything that waits, in the order of spec 17; a fixed brief
per row and an assistant brief written once within `assistant.briefsPerDay`; the queue beside the
assistant conversation, in the tray and the palette; answers by keys; Ctrl+Shift+J following the
queue order.
Boundaries: no briefings or reminders (U5). Answers go through the existing commands.
Change surface: `packages/contracts` (decision rows, settings), a projection and brief writer in
`apps/server`, `apps/desktop` tray menu, `apps/web/src/assistant` and the next-that-needs-you key,
docs.
Acceptance: spec 16 to 19.
Ground truth: server Vitest for membership and order, the brief limit and fallback; `pnpm e2e
--grep "decision queue"` answering a gate, an approval and a proposal by keys; repository checks.
Open risks: none

### U5 Briefings, follow-through and quiet

Outcome: briefing moments on the scheduler clock (work hours start or first show, after a
meeting, after idle reported by the desktop, end of work hours), the fixed part and the model
summary on `assistant.briefingModel` within `assistant.briefingsPerDay`; cards moved around moved
meetings under Move cards or proposed; failure reading and Retry; one reminder per decision; quiet
during busy meetings, focus cards and outside work hours.
Boundaries: no voice. No new kinds of notification beyond the assistant's.
Change surface: `packages/contracts` (briefing items, settings), the scheduler and assistant in
`apps/server`, the desktop's idle report, notifications, the assistant conversation, docs.
Acceptance: spec 20 to 27.
Ground truth: server Vitest on the controllable clock for each moment, the fallback, the card move,
one reminder, quiet hold and release; desktop Vitest for the idle report; repository checks.
Open risks: a meeting read late moves a card after its run started; a started card is never moved.

### U6 Quick ask from anywhere

Outcome: `desktop.quickAskShortcut` registered with Electron's global shortcut, a small window on
top with the assistant composer and the streaming answer, Escape to close, "Open in wow", a clash
shown in Settings when the shortcut is taken, and off as an option.
Boundaries: no voice; the window holds no state of its own beyond what the server pushes.
Change surface: `apps/desktop` (shortcut, window, preload), a route in `apps/web` for the window,
settings, docs.
Acceptance: spec 31.
Ground truth: desktop Vitest with a fake shell: register, clash, open, send, close; repository
checks.
Open risks: focus stealing rules on Windows; the window is shown with focus only on the shortcut.

### U7 End-to-end, guide and smoke

Outcome: the e2e list of spec "Ground truth" is complete; the user guide's Assistant section
covers delegation, permissions, the queue, briefings, memory, Focus cards and quick ask;
`docs/windows-smoke.md` gains the manual lines.
Boundaries: no new features; defects found are fixed as their own commits.
Acceptance: spec "Ground truth", all lines but the manual one, which the owner runs.
Ground truth: `pnpm e2e` green on both runners; repository checks.
Open risks: none

## Epic contract

Epic outcome: a working day where Lucas talks to the assistant, it starts and follows the work he
gives it within his permissions, and he is only asked for decisions, each prepared.
Acceptance: spec "Behavior", all.
Children or delivery units: U1 to U7.
Aggregate verification: repository checks and `pnpm e2e` on `main` after each unit, then the
Windows smoke lines.
Final verification owner: Lucas (manual smoke) and the reviewer of each unit.
