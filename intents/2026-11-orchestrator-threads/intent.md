---
id: 2026-11-orchestrator-threads
status: done
rev: 1
supersedes: null
---

# Main threads that run the work: one orchestrating agent per thread, and less app around it

## Who and why

Lucas has used wow up to 0.5.0 and knows now what he wants it for: chat threads in which one
agent runs the work and hands parts of it to other agents on Claude Code or Codex. The app has
grown around other ideas (plans, plan runs, a review loop, a separate assistant, a workflow
builder, event triggers, several overview pages), and for this use it is more than he needs.

- **The orchestration is there but shallow.** Since `2026-11-agent-orchestration` a chat thread's
  agent can start helper threads on any provider, but a helper cannot start helpers of its own,
  and parallel helpers in one project come back as separate branches for him to review one by one.
- **Gates live in other places.** A helper's approval goes to the decision queue and Threads at
  work; a workflow's gate goes to the run view. He wants every point where work waits for him in
  the conversation he is having with the main agent.
- **A workflow is a second kind of run.** A workflow run has its own step threads, its own view and
  its own builder. He wants a workflow to be a written procedure the main agent follows, in one
  thread, and a scheduled job to be one thread too, not one per step.
- **Too many places to go.** Calendar, chat, workflows, runs, triggers, plans, backlog, the
  assistant, usage, Threads at work and Quick ask are each a page. He wants the threads in front
  and the rest one click away.

## Desired outcome

When this is done:

- **A main thread is the unit of work.** He writes to its agent as in any chat, or starts a ready
  workflow with a slash command followed by text. He picks the provider and model per thread, with
  a default in the settings. He talks only to the main agent.
- **Agents in depth.** The main agent starts subagents on Claude Code or Codex, and a subagent can
  start its own, down to a depth limit he sets (2 to begin with: subagents and their subagents).
  Each subagent is its own thread in the background. Answers go up to the agent that started it.
  Stopping a thread stops everything under it.
- **Each agent picks where its subagents work.** The folder, any Git repository the task touches,
  and whether a subagent gets its own worktree are the starting agent's choice, as Claude Code and
  Codex choose for their own subagents. When several subagents worked in parallel in the same
  repository, the main agent can merge their branches before it shows him the result, so he has as
  little as possible to review. Nothing reaches his project folder or a pull request until he asks
  in the main thread.
- **Gates in the conversation.** Every approval or question meant for him, from any depth, shows in
  the main thread's conversation with the subagent that asks, and he answers there. Only that
  subagent waits; the others go on and he can keep talking to the main agent. The main agent can
  never answer an approval for him. Whether the agent asks before it hands out work is up to how
  he prompts it; the app forces nothing.
- **Workflows as text.** A ready workflow is a Markdown file with steps: for each step what to do,
  on which provider and model, and whether a gate follows. The main agent follows it, running steps
  as subagents, in the one thread. He edits it as text or asks a thread to write it.
- **Scheduled jobs are main threads.** A job on the calendar starts a main thread that runs its
  workflow. Per job he chooses a new thread for every run, or the same thread run after run.
  There are no event triggers.
- **The assistant is in every main thread.** What the assistant can do (settings, projects, cards,
  backlog, workflows, mail and calendar) any main thread's agent can do. A thread may belong to a
  project or to none. The Assistant page goes; its conversation becomes a main thread without a
  project.
- **Threads in front.** The app opens on chat. The left side lists main threads only, each with
  its title and its project under it, sorted by status: Waits for you (a small exclamation mark
  with a touch of colour), Working, Unread, Done. Calendar, Backlog, Workflows and Settings sit
  behind one settings button. Subagents are rows in their main thread, opening in the side panel.

## Out of scope

- Talking to a subagent directly. Its thread can be opened and read, and its row has Stop; all
  steering goes through the main agent.
- Event triggers (a new pull request, a CI failure, new mail).
- Plans, plan runs, intents in the app, the review loop and its gate screen. Intent files in his
  repositories stay as they are; wow no longer reads them.
- Quick ask and the Usage view. The usage and limits logic stays on the server for later use.
- Threads at work as a page; the left side takes its place.
- A shared channel between agents. They reach each other only through the tools of the thread
  that started them.

This intent changes boundaries set by `2026-11-agent-orchestration` (no helper of a helper),
`2026-11-app-assistant` and `2026-11-chief-of-staff` (one assistant thread with its own page),
`2026-11-wow-app` and `2026-11-workflow-branches` (a workflow as a chain of step threads edited in
a builder), `2026-11-review-loop` (plan runs, event triggers, the gate screen),
`2026-11-recurring-cards` (a run per occurrence), `2026-11-parallel-threads` (Threads at work) and
`2026-11-chat-overview` (the thread list's groups, the Usage view).

## Open questions

None.

## Decision log

- 2026-11-23: draft from the owner's answers in a session of questions. He found wow overdesigned
  for what he uses it for and wants an orchestration tool: a main thread whose agent runs
  subagents on Claude Code and Codex, subagents with subagents, gates that come up in the chat,
  ready workflows kept. He chose: a workflow driven by the main agent, gates from any depth in the
  main thread, threads with or without a project, a depth limit as a setting starting at 2,
  workflows as text files, only the asking branch waits at a gate, a discreet exclamation mark for
  "waits for you", each agent choosing folders and worktrees for its subagents in any repository,
  the main agent merging parallel branches in one repository, provider and model per thread with
  a default, talking only to the main agent, statuses Waits for you, Working, Unread and Done,
  calendar, backlog and workflows kept behind a settings button, scheduled jobs with a choice
  between a new thread per run and the same thread, no event triggers, the assistant's
  conversation kept as a thread and plans, plan runs, review loop and workflow runs deleted, the
  Usage view and Quick ask removed. The coordinator chose to fold the assistant into main threads
  rather than give it a thread of its own, as the owner left that to it.
- 2026-11-23: the owner accepted the intent and left the two open questions to the coordinator.
  The assistant's briefings, its delegation rules and the decision queue from
  `2026-11-chief-of-staff` go: "Waits for you" on the thread list replaces the queue, helpers
  replace delegation, and a briefing can be a scheduled job whose workflow asks for one. Workflow
  files live in `<wow home>/workflows` for his own and `<project>/.wow/workflows` for a project's,
  and the project's file wins on a name clash, so a project can carry its workflows in its
  repository.
