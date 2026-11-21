---
id: 2026-11-chief-of-staff
status: accepted
rev: 1
supersedes: null
---

# An assistant that runs the work around me, so I can think about the problem

## Who and why

Lucas wants to spend his day thinking and solving problems, not managing the work around them.
wow already does the work: agents run workflows in their own working copies, cards start them on
the calendar, gates stop them for his judgement, and the assistant operates the app from what he
says. He has tested it, and it works.

But he is still the one who drives it. He has to open the right view to see what waits, read a
step's whole output to decide a gate, notice that a run failed and ask why, turn an idea into a
backlog item, a workflow and a slot, start the threads himself, and move cards when a meeting
moves. The assistant only acts when asked, only on the app's settings and objects, cannot start a
thread, and cannot read what the agents produced, so it cannot tell him what matters. The
overhead has moved from five windows into one, but it is still his.

The direction is a chief of staff: one presence he talks to, that knows what is going on, comes to
him with what needs him, prepares each decision so it takes a minute, and, when he wants it to,
runs the rest of the work itself: starts workflows and threads, follows them, and reports back.

## Desired outcome

When this is done:

- **One to talk to.** Lucas can give the assistant a piece of work in his own words and, if he has
  allowed it, the assistant starts the workflow run or the chat thread for it, briefs the agent,
  follows the work, answers the agent's questions where his words already answer them, and comes
  back with the result. He can also keep doing everything by hand; delegation is something he
  turns on.
- **It tells him what matters, without being asked.** A short briefing when he starts the day,
  when he comes back from a meeting or after a while away, and at the end of the day: what ran,
  what finished, what failed and why, what waits for him, and what is planned next, readable in
  half a minute, with links to everything it names.
- **One queue of decisions.** Every gate, approval, question, proposal and failure that needs him
  is in one list, most urgent first. Each has a short brief: what the agent did, what the decision
  is, what to look at, and the assistant's recommendation. He answers with one key. Gates and
  approvals stay his: the assistant prepares them and never passes them.
- **From a thought to scheduled work in one sentence.** "Look at why the sync is slow while I am
  in the afternoon meeting" becomes a backlog item with a workflow, a project and a slot.
- **It follows through.** When a meeting moves into a planned slot it moves the card, when a step
  fails it says why and what it would do, and when a decision has waited long it reminds him once.
- **Standing permissions he gives and takes back.** Within a permission the assistant acts and
  reports; outside one it proposes and waits, as today. Everything it did shows in the briefing
  and can be undone where undoing is possible.
- **It remembers how he works**, in notes he can read and edit, never learned silently.
- **Always one key away.** A global hotkey opens a small assistant prompt over any window.

## Out of scope

- The assistant answering a gate or a tool or command approval. Gates that pass on a stated
  condition stay as they are.
- Writing to Outlook, sending mail, or posting to trackers and chat services on its own.
- Voice. A later intent, once the hotkey prompt is in daily use.
- Learning preferences without telling him.
- A model or API key of its own; it runs on a connected provider.
- Multi-user, mobile and remote access.

This intent changes two boundaries of `2026-11-app-assistant`: the assistant may read what agents
produced (run and thread outputs, artifacts and the changes of a step, never other project files
or secrets), and, under a standing permission, start runs and threads.

## Open questions

None. The owner accepted the proposals of the first draft and added delegation.

## Decision log

- 2026-11-20: first draft with five open questions. The owner accepted every proposal: the
  assistant reads agents' outputs and artifacts but not the rest of the project; standing
  permissions cover scheduling, moving, retrying and starting work for named workflows and
  projects, never what today waits for a yes on its own; interruptions only for waiting decisions,
  never during meetings or focus cards, one reminder each; the hotkey prompt now and voice later;
  briefings on a cheaper model with a daily cap.
- 2026-11-20: the owner added that the assistant may start workflow runs and chat threads and run
  the other work for him, when he wants it to.
