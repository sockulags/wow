---
id: 2026-11-agent-orchestration
status: done
rev: 1
supersedes: null
---

# One thread runs others: helper threads on any provider, and units in parallel

## Who and why

Lucas runs several agents at once. Since 0.5.0 he can see every thread at work, keep one beside
another and bring a thread's work home without a pull request. But each piece of parallel work is
still started and divided by him, or by the assistant, which only works in its own conversation.

- **Inside one thread, the agent cannot hand work to another agent that wow knows about.** Claude
  Code's Agent tool and Codex's collab agents are subagents of the same provider, in the same
  session and folder. wow only shows them, and on Codex it does not even see their work. A
  Claude thread cannot ask Codex for a second opinion, or the other way round, and nothing it
  starts that way can be followed, stopped or brought home in wow.
- **A plan run takes one unit at a time.** Units that do not depend on each other wait in line,
  although each already gets its own run and its own working copy. The review loop and workflow
  branches left parallel units out on purpose ("one at a time first"); with working copies,
  Threads at work and Apply in place, the parts parallel work needs are now there.
- **What runs where is hard to see.** Threads at work lists threads, not who started them for
  what. A thread's helpers, and a plan run's units, should read as one piece of work.

## Desired outcome

When this is done:

- **Helper threads.** Every chat thread's agent has wow's helper tools. With them it starts a
  helper thread on any connected provider instance (Claude Code or Codex, whichever the main
  thread runs on), with a brief and a model. It uses them when the task needs it or the user asks,
  not by habit. A helper works the way Claude Code's subagents do: in the main thread's folder by
  default, or in its own working copy when the agent asks for that. The agent can read a
  helper's state and answer, write to it and stop it; a helper's question goes to the agent.
- **Coupled to the main thread.** A helper belongs to the thread that started it. Its final answer
  comes back to that thread's agent, which goes on with it. Stopping the main thread's turn stops
  the helpers it started. A helper cannot start helpers of its own.
- **Seen while they work.** A helper shows in the main thread's conversation as a row like a
  subagent's: "Helper · Codex · review the timer change · Running pnpm test · 1:12", opening to
  its live conversation in the side panel. Threads at work lists helpers under their main thread.
  Each helper is also an ordinary thread he can open.
- **Units in parallel.** A plan run can start several ready units at once, each in its own run and
  working copy, up to a limit he sets, and starts the next as one ends. Units that depend on each
  other still wait. The plan run's view and Threads at work show which unit runs where and on what.
- **His rules stay.** Approvals and gates of a helper or a unit's run are his, as for every
  thread; the main thread's agent can never answer them. A helper never gets a wider permission
  mode than its main thread. Limits on how many helpers run at once are said to the agent in words.

## Out of scope

- Steps of one workflow run that run at the same time, and workflows that call workflows.
- Merging helpers' or units' changes into one another. Each comes home on its own (Apply, a pull
  request); conflicts are his.
- Agents talking to each other except through the main thread's tools (no shared channel).
- Changing how Claude Code's or Codex's own subagents work; wow keeps showing them as today.
- The assistant using helper tools inside a chat thread; it keeps its own delegation tools.

This intent changes two boundaries: a chat thread may carry wow's tools beside its own (until now
only the assistant's tools-only session did), and a plan run may have more than one unit live
(`2026-11-review-loop`, "one at a time first").

## Open questions

- How many units a plan run may have live at once by default. The owner kept it open: it is the
  setting `workflows.planRunParallel`, which starts at 1 (one at a time, as today) until he
  chooses another default.

## Decision log

- 2026-11-22: draft from the owner's request ("parallella enheter; huvudtråden ska kunna skapa
  en subagent i både Codex och Claude, och man ska kunna se att dessa jobbar och med vad"). The
  coordinator found the means in place: wow's MCP endpoint already serves the assistant's
  `start_thread` tools to both Claude Code and Codex, and threads in their own working copies,
  Threads at work, the thread tab in the panel and Apply cover running, seeing and bringing home.
  What is new is a chat session that carries wow's tools beside its own, a parent link between
  threads, and more than one live unit in a plan run.
- 2026-11-22: the owner answered the draft's questions. Helper tools are on for every chat thread
  by default, and the agent uses them when needed or asked. A helper may run on any connected
  instance, works like Claude Code's subagents (the main thread's folder, or its own copy on
  request), and the main thread's agent answers its questions but never its approvals. Helpers
  are coupled to their main thread, and what they do must be visible. The parallel-units limit
  stays open.
