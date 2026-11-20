---
intent: 2026-11-chief-of-staff
rev: 1
built_on: intent@1
status: draft
---

# An assistant that runs the work around me, so I can think about the problem

## Summary

Lucas starts the day with a briefing in the Assistant: two runs finished overnight, one failed on
a missing fixture, the plan gate of yesterday's feature waits with a three-line brief, and the
afternoon has a free hour. He writes "fix the failing fixture and look at why the sync is slow,
after lunch". The assistant, which he has allowed to start work in that project, starts a thread
in its own working copy for the fixture, plans a run of the investigation workflow at 13:00, and
says so. While he is in a meeting the thread's agent asks which fixture file to use; the
assistant answers from what he wrote. When the agent asks to run a command, that approval goes to
his decision queue with a brief, and the notification waits until the meeting ends. At 13:40 the
meeting runs long, so the card moves to the next free slot. At the end of the day the briefing
says what was done, under which permission, and what waits for tomorrow.

Behavior numbers here are this spec's own; "assistant behavior N" refers to
`intents/2026-11-app-assistant/spec.md`.

## Behavior

### Reading what agents produced

1. Given the assistant, when it needs to know what a run or thread did, then it can read, through
   read tools: a run's steps with each step's final message, verdict, artifacts found, the content
   of those artifact files when they are text under `assistant.readMaxBytes`, the step's changes
   as a file list with added and removed lines and the diff up to `assistant.readMaxDiffLines`,
   and checks; and a thread's title, state, provider, project, the last
   `assistant.readMaxMessages` assistant messages, its waiting approval or question with the
   request, and its usage.
2. Given anything those tools return, when it is handed to the agent, then it passes through
   `assistant.secretPatterns` first, as everything the assistant is shown does today. No tool
   reads a project file that is not a step's artifact, a secret value, or a thread the assistant
   has no reason to read (a thread in a project the user has excluded with
   `assistant.excludedProjects`).
3. Given the assistant's change rows, when it used a read tool, then the conversation shows it in
   words ("Read the plan step of Ring the bell"), so Lucas sees what it looked at.

### Standing permissions

4. Given Settings → Assistant → Permissions, when Lucas adds a permission, then he picks one of a
   fixed set of kinds and its scope:
   - **Plan runs**: create and move cards with a workflow, including ones that start soon, and
     plan backlog items, for the named workflows and projects, inside work hours.
   - **Start runs**: start a run of a named workflow in a named project now.
   - **Start threads**: start chat threads in named projects, with a permission mode no wider than
     the one the permission names, always in the thread's own working copy where the project is a
     Git repository.
   - **Drive threads**: send follow-up messages to threads the assistant started, and answer their
     agents' questions where Lucas's own words in the assistant conversation already answer them.
   - **Retry**: send a step's failed turn again once, when it failed on a provider error.
   - **Move cards**: move the assistant's own cards and cards with a workflow to the next free
     slot when a meeting comes to overlap them.

   Each permission has an optional end date and a daily count limit, and can be paused.

5. Given a command the assistant sends, when a permission covers it, then it is applied at once
   instead of waiting as a proposal, and its change row says "under <permission>" with Undo where
   the command can be undone; when none covers it, it is a proposal as today (assistant
   behavior 9). The server decides which permission covers a command, never the agent.
6. Given the kinds above, when a command is in today's `refused` class (gate answers, tool and
   command approvals, provider instances, secrets, project delete, restores) or changes what an
   agent may do on its own (permission modes, gate conditions, rules, event triggers, approval
   rules, the scheduler's pause and missed policy, the assistant's own settings and permissions),
   then no permission covers it: it stays refused or a proposal.
7. Given `assistant.delegation` off (the default), when the assistant runs, then no permission
   applies, whatever is stored, and the assistant behaves as today. Turning it on, adding a
   permission or widening one is a proposal when the assistant asks for it, and ordinary when
   Lucas does it in Settings.
8. Given a permission's daily limit or end date is reached, when the assistant would use it, then
   the command becomes a proposal and the row says why.

### Delegated work

9. Given **Start threads** covers a project, when Lucas asks the assistant for project work
   ("fix the failing fixture in Tea"), then it starts a chat thread in that project with the
   provider, model and effort the permission or the project's defaults name, a title it chooses,
   and a first message it writes from his words, and says so with a link. Without the permission
   it offers the thread as today (assistant behavior 3), now with its brief filled in.
10. Given a thread the assistant started, when it is listed, then it carries "started by the
    assistant" and a link back to the message that asked for it, and it belongs to Lucas like any
    thread: he can open it, write in it and stop it.
11. Given a thread the assistant started, when its turn ends, then the assistant is given a turn
    (`assistant.followTurns` per thread, default 3) to read the result and either report back in
    the assistant conversation, or, under **Drive threads**, send a follow-up that stays within
    the original request. It never widens the request; a new piece of work is a new ask to Lucas.
12. Given a delegated thread's agent asks a question, when **Drive threads** covers the thread and
    Lucas's messages in the assistant conversation answer it, then the assistant answers it and
    the question card shows "answered by the assistant: <answer> · because you said: <quote>";
    otherwise the question goes to the decision queue.
13. Given a delegated thread's agent asks for an approval, when it arrives, then it goes to the
    decision queue with a brief; the assistant never answers it.
14. Given **Start runs** or **Plan runs**, when Lucas asks for work that fits a workflow ("run the
    bug workflow on the login issue"), then the assistant starts or plans the run through the
    ordinary commands and reports what it started; gates of that run still wait for Lucas.
15. Given delegated work, when `assistant.maxDelegatedLive` (default 3) threads and runs started by
    the assistant are working, then the next one is planned for a free slot instead of started,
    and the assistant says so.

### Decision queue

16. Given anything that waits for Lucas (a run at a gate or at a limit, an approval, a question
    not answered by the assistant, an assistant proposal, a failed run, a failed trigger or a
    missed card, a failed connection test), when it appears, then it is a row in the decision
    queue: in the Assistant view beside the conversation, under "Needs you" in the tray menu, and
    in the palette. Ctrl+Shift+J walks the queue in its order.
17. Given the queue, when it is ordered, then approvals and questions that hold a running turn
    come first, then gates and limits, then proposals, then failures; within each, what blocks a
    card that starts soonest, then the oldest.
18. Given a row, when it is shown, then it has a brief: a fixed part wow builds itself (what,
    where, since when, the step and its artifacts, the size of the change, checks) and, within
    `assistant.briefsPerDay`, a few sentences from the assistant with its recommendation, written
    once when the row appears and kept. Over the limit the row shows the fixed part only.
19. Given a row, when Lucas answers it from the queue (approve, send back with a note, allow,
    deny, answer, yes, no, open), then the same command as in its own view is sent, with the keys
    of `keybindings` for those answers; the row leaves the queue when the answer is stored.

### Briefings

20. Given `assistant.briefings` on (the default), when a briefing moment comes, then the server
    asks the assistant for a briefing turn. The moments are: the start of work hours, or the first
    time the window is shown that day if later; the end of an Outlook meeting longer than
    `assistant.briefAfterMeetingMinutes` when something changed during it; the window shown after
    the computer was idle longer than `assistant.briefAfterIdleMinutes`; and the end of work
    hours.
21. Given a briefing turn, when it is written, then it has a fixed part wow builds from the
    projections (since the last briefing: runs started, finished, failed; what the assistant did
    under which permission; the decision queue's count and top three; the rest of today's cards and
    free slots) and a short summary from the assistant on `assistant.briefingModel`. It is shown
    in the assistant conversation as a briefing, with links.
22. Given `assistant.briefingsPerDay` is reached or the provider is not connected, when a moment
    comes, then the briefing is the fixed part alone, without a model turn.
23. Given a briefing, when it is new, then a notification says so only if the quiet rules allow
    it (behavior 27); otherwise it waits in the conversation.

### Follow-through

24. Given a card with a workflow that a moved or new Outlook meeting now overlaps, when the
    calendar is read, then under **Move cards** the card moves to the next free slot in work hours
    of the same length and the briefing lists it; without the permission the assistant proposes
    the move. A card that already started its run is not moved.
25. Given a run that failed, when it fails, then the assistant reads it (behavior 1) within
    `assistant.briefsPerDay` and its queue row says why and what it would do; under **Retry** a
    provider error is sent again once and reported.
26. Given a decision has waited longer than `assistant.remindAfterMinutes` (default 60), when the
    quiet rules allow, then one reminder is sent for it, never a second.

### Quiet

27. Given a notification from the assistant, when Lucas is in an Outlook meeting that shows him
    busy, or inside a local card marked **Focus**, or outside work hours, then it is held and
    sent when that ends; the decision queue and the conversation still show it at once.
28. Given the card form, when Lucas marks a card **Focus**, then it carries no workflow, shows as a
    focus block on the calendar, and the assistant's planning never puts work over it.

### Memory

29. Given the assistant, when Lucas states a preference ("never plan anything before nine", "Tea
    is the important project this week"), then the assistant writes it as a note with the
    `remember` tool, which is an ordinary change with a row and Undo; it never writes a note Lucas
    did not state or confirm on the question card.
30. Given Settings → Assistant → Memory, when it is shown, then every note is listed with when and
    from which message it came, and can be edited or removed. The assistant reads the notes at the
    start of every turn; notes with an end date stop applying after it.

### Quick ask

31. Given the desktop app runs, when Lucas presses `desktop.quickAskShortcut` (default
    Ctrl+Alt+Space) anywhere in Windows, then a small window opens on top with the assistant's
    composer; Enter sends the text to the assistant conversation and the window shows the answer as
    it streams; Escape closes it; "Open in wow" shows the conversation. The shortcut can be turned
    off, and a shortcut another program holds shows as a clash in Settings.

## Interface

- Decided: standing permissions are rows the server consults in the assistant's class table, not
  instructions to the agent. The agent can only ask for a permission through a proposal.
- Decided: threads the assistant starts are ordinary chat threads with a `startedBy` of
  `assistant`, so every chat feature works on them and Lucas can take one over at any time.
- Decided: the assistant follows a delegated thread through turns the server gives it when the
  thread's turn ends or it asks something, bounded by `assistant.followTurns`; it does not poll.
- Decided: briefings and briefs always have a fixed part wow builds without a model, so they work
  over the daily limits and without a provider.
- Decided: the decision queue is a server projection; the UI renders its order.
- Left to delivery: wording, the look of the queue, briefing and quick ask window, key bindings
  other than the ones named, and the exact default limits other than the ones named.

## Boundaries and non-goals

- The assistant never answers a gate or a tool or command approval, under any permission.
- No permission covers anything in today's `refused` class or anything that widens what agents
  may do on their own.
- The assistant reads run and thread outputs and step artifacts and changes; never other project
  files, never secrets, never threads in excluded projects.
- Delegation is off until Lucas turns it on.
- No writes to Outlook, mail, trackers or chat services.
- Tests do not sleep, poll or retry; briefing moments and reminders go through the scheduler's
  controllable clock.

## Decisions

- **Permissions in the server's class table.** The server already decides what each assistant
  command does; a permission is one more input to that decision. Rejected: telling the agent what
  it may do in its instructions (an agent can be talked out of it), a single "autonomous" switch
  (too coarse to give with confidence).
- **Delegated threads always in their own working copy.** Work the assistant starts never touches
  the project folder Lucas works in. Rejected: following the project's setting (Lucas might be
  editing in the folder at the time).
- **The assistant answers questions, never approvals.** A question asks for information Lucas has
  usually given already; an approval lets an agent act on the machine. Rejected: approvals under a
  permission (the permission mode of the thread is the place to allow more).
- **Briefs written once, kept.** A brief is written when its row appears and stored, so the queue
  costs one turn per decision at most and reads the same each time it is opened. Rejected:
  writing briefs when opened (slow, repeated cost).
- **Quiet from the calendar.** Meetings and focus cards already say when Lucas is busy. Rejected:
  a separate do-not-disturb schedule.
- **Memory as notes he can see.** Rejected: summarising the conversation into memory on its own.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
- Server Vitest: read tools return outputs, artifacts and diffs through the secret net and refuse
  other files and excluded projects (1, 2); for every command type, a permission never turns a
  refused or widening command into an ordinary one, and turns each covered proposal into an
  ordinary one only within scope, limit and end date (4 to 8; a table test over the class table);
  a delegated thread gets follow turns up to the limit, an answered question records its quote,
  an approval goes to the queue (9 to 15); queue order (17); briefing moments, the fixed part and
  the limit fallback on the controllable clock (20 to 22); card moves around a moved meeting (24);
  one reminder (26); quiet holds and releases (27); notes (29, 30).
- `pnpm e2e` against the mock provider: delegation from one message to a started thread with its
  link; the decision queue answered by keys; a briefing with its links; a permission added in
  Settings and used; Focus cards; Memory edited.
- Desktop Vitest with a fake shell: the quick ask shortcut registers, clashes, opens and sends (31).
- Manual Windows check added to `docs/windows-smoke.md`: a day with delegation on in one real
  project, a briefing after a real meeting, the quick ask shortcut over another program.

## Open risks

- Delegated threads multiply cost. Evidence: `assistant.maxDelegatedLive`, the permission's daily
  limit and the follow-turn limit, all visible in the briefing's fixed part.
- An agent's question answered wrongly from Lucas's words. Evidence: every answer shows the quote
  it came from, and Drive threads is its own permission.
- A global shortcut that another program holds on Windows. Evidence: the desktop test of the clash
  and the setting to change it.

## Decision log
