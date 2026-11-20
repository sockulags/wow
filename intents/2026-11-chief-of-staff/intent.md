---
id: 2026-11-chief-of-staff
status: draft
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
backlog item, a workflow and a slot, and move cards when a meeting moves. The assistant only acts
when asked, only on the app's settings and objects, and cannot read what the agents produced, so
it cannot tell him what matters. The overhead has moved from five windows into one, but it is
still his.

The direction is a chief of staff: one presence that knows what is going on, comes to him with
what needs him, prepares each decision so it takes a minute, and takes care of the rest within
limits he has set.

## Desired outcome

When this is done:

- **It tells him what matters, without being asked.** A short briefing when he starts the day,
  when he comes back from a meeting or after a while away, and at the end of the day: what ran,
  what finished, what failed and why, what waits for him, and what is planned next. It is written
  for reading in half a minute, with links to everything it names.
- **One queue of decisions.** Every gate, approval, question, proposal and failure that needs him
  is in one list, most urgent first, wherever it came from. Each one has a short brief from the
  assistant: what the agent did, what the decision is, what to look at, and its recommendation.
  He answers with one key. The decision stays his: the assistant prepares a gate, it never passes
  it.
- **From a thought to scheduled work in one sentence.** "Look at why the sync is slow when I am
  in the afternoon meeting" becomes a backlog item with a workflow, a project and a slot, without
  him choosing each. He sees what was planned and can change it.
- **It follows through.** It keeps the plan in line with the day: when a meeting moves into a
  planned slot, it moves the card; when a step fails on something it can see, it says why and
  what it would do; when a run has waited long, it reminds him once.
- **Standing permissions he gives and takes back.** "You may plan runs of the Bug workflow in free
  slots", "you may retry a failed step once", "you may move my cards around meetings". Within a
  permission it acts and reports; outside one it proposes and waits, as today. Every action can
  be undone and shows in the briefing.
- **It remembers how he works.** Preferences he states ("never before nine", "Tea is the
  important project this week") and patterns it is told to keep, stored where he can read and
  edit them, never learned silently.
- **Always one key away.** A global hotkey opens a small assistant prompt over any window, so a
  thought goes in without switching to wow. Voice is optional: push to talk in, and briefings
  read aloud if he turns it on.
- **A partner for the problem itself.** When he wants to think something through, the assistant
  can start a thread with a coding agent on the project, read what came back, and turn the
  conclusion into work. It does not do the project work itself.

## Out of scope

- The assistant approving, sending back or stopping a run at a gate. It prepares the decision;
  gates that pass on a stated condition stay as they are.
- Writing to Outlook, sending mail, or posting to trackers and chat services on its own.
- Learning preferences without telling him. What it keeps is visible and editable.
- Always-on listening. Voice is push to talk.
- A model or API key of its own; it runs on a connected provider, as today.
- Multi-user, mobile and remote access.

## Open questions

These change what is built, so they are the owner's:

1. **May the assistant read what agents produced?** Briefings and decision briefs need the final
   messages, diffs, artifacts and test results of runs and threads. Today it reads neither threads
   nor project files. The proposal: read-only access to run and thread outputs and to the files a
   step lists as artifacts, never to the rest of the project, and never secrets.
2. **How far may standing permissions go?** The proposal: only scheduling, moving and retrying
   inside work hours and free slots, and only for workflows he names. Never permission modes,
   rules, event triggers or anything that today waits for a yes.
3. **How often may it interrupt?** The proposal: briefings at fixed moments, a notification only
   when a decision is waiting and he is not in a meeting, quiet during focus blocks, and one
   reminder per waiting decision.
4. **Voice now or later?** The proposal: the global hotkey prompt now, voice in a later intent.
5. **Which provider runs the briefings?** They cost a turn each. The proposal: the assistant's own
   provider and a cheaper model setting for briefings, with a daily cap.

## Decision log
