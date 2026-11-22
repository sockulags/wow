---
id: 2026-11-chat-overview
status: accepted
rev: 1
supersedes: null
---

# See more at a glance: a richer thread list and conversation

## Who and why

Lucas runs many threads at once, on Claude Code and Codex, in several projects. Since 0.5.0 the
chat does most of what the providers' own apps do, and more: approvals, questions, plans, tool
rows, subagents, task lists, Changes, commit and pull request, fork, edit, find, helpers and
Threads at work. What it does badly is show him, without opening things one by one, where each
thread stands and what it did.

- **The thread list says too little.** A row has the title, the project and when it was last
  active. What the thread waits for, what it runs, how far its task list is, what it changed and
  on which branch are known to wow, but only Threads at work shows some of it.
- **The list only grows.** Idle and Done hold every thread ever made, with no grouping by time
  or project, no folding and no tidying up.
- **Every action takes a trip.** Pin, archive, mark done and open in panel need the thread open
  or the palette; there is no menu on a row and no way to act on several threads at once.
- **A turn ends without saying what it did.** The usage line has tokens and cost; what the turn
  changed and ran is spread over its rows, and the Changes chip counts the whole thread.
- **Coming back to a thread** he has to find where he left off himself.
- **A long thread has no map.** Alt+Up steps message by message; there is no list of what was
  asked, and nothing he can mark to find again.
- **Plan limits are invisible.** Claude's five-hour and weekly limits and Codex's limits show up
  only when a turn is refused.
- **Pictures the agent sees stay hidden.** A screenshot a tool took, or a picture the agent read,
  is a line of text in the tool row.
- **Only images and files in the folder go into a message.** A log, a text file or a PDF from
  elsewhere has to be copied by hand; so does what another thread found or a backlog item says.
- **No sense of spend over time.** Tokens and cost are per turn and per thread, never per day,
  project or model.

## Desired outcome

When this is done:

1. **Rows that say where a thread stands**: what it waits for or runs, its task progress, its
   change count and its branch, on the row itself.
2. **A list that stays tidy**: Idle and Done grouped by Today, Yesterday, This week and Older,
   groups that fold, done threads archived after a number of days he chooses, and a choice to
   group the list by project instead.
3. **Actions on the row**: a menu on right-click or the context-menu key, hover buttons, and
   several rows picked at once to pin, archive, mark done or reopen together.
4. **A summary at the end of each turn**: "Changed 3 files +40 −2 · ran 2 commands · 1 failed",
   which opens that turn's changes.
5. **"New since you looked"**: opening a thread with unread output shows a line where he left
   off and starts there; a key goes to it.
6. **A map of the thread**: a panel tab lists his messages, the turn summaries and the answers
   he marked; a key marks an answer and jumps between marks.
7. **Plan limits in sight**: how much of each limit window is used and when it resets, near the
   model in the composer, in the provider's settings and in the usage view, with a notice before
   a limit is reached.
8. **Pictures in tool rows**: images a tool returned (a screenshot, a picture read from disk)
   show as thumbnails that open full size.
9. **More in a message**: text files and logs dropped or picked go in as quoted text, PDFs go to
   Claude as documents, and `@` can name another thread (its last answer goes in) or a backlog
   item (its text goes in).
10. **A usage view**: tokens and cost per day, project, provider and model, over a range he
    picks, beside the plan limits.

## Out of scope

- A new conversation layout, a grid of threads, or a mobile view.
- Charging, budgets or stopping turns because of spend. The usage view shows; it does not limit.
- Images the agent makes by itself outside a tool call (none of the providers send any).
- Files of any kind written into the project folder on the user's behalf by an attachment.
- The assistant's composer: it still takes no attachments and no mentions.

## Open questions

1. **Issues, pull requests and tickets in a message.** "Mention a host item" (`@` on an issue,
   pull request, Jira ticket or Confluence page, whose text then goes to the agent) crosses a
   line the agent workbench drew on purpose: nothing read from a host is sent to the agent,
   because a host's text is written by others and could steer the agent. The plan keeps it as
   its own unit (U11), built only after the owner says yes, with the safeguards the spec lists.

## Decision log

- 2026-11-22: the owner asked what the chat still lacks in the thread list and the conversation
  and, given eleven gaps, asked for an intent for all eleven ("skriv en intent för alla elva").
  The mention gap is split: threads and backlog items are wow's own data and go ahead; host items
  wait on open question 1.
