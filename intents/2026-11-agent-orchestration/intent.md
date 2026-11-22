---
id: 2026-11-agent-orchestration
status: draft
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

- **Helper threads.** A chat thread can be given wow's helper tools. With them its agent starts
  a helper thread on a provider instance he allows (Claude Code or Codex, whichever the main
  thread runs on), with a brief, a model and a working copy (the main thread's folder read-only,
  or its own copy). The agent can read a helper's state and final answer, write to it and stop
  it. A helper is an ordinary thread: it shows in the thread list, Threads at work and the panel,
  and its changes come home with Apply.
- **Seen in the main thread.** A helper shows in the main thread's conversation as a row like a
  subagent's: "Helper · Codex · review the timer change · Running pnpm test · 1:12", opening to
  its live conversation in the side panel. Threads at work groups helpers under the thread that
  started them.
- **Units in parallel.** A plan run starts every ready unit up to a limit he sets, each in its
  own run and working copy, and starts the next one as one ends. Units that depend on each other
  still wait. The plan run's view, and Threads at work, show which unit runs where and on what.
- **Limits he sets.** How many helpers a thread may have at once, how many in total, which
  instances and modes a helper may use, and how many units run at the same time. A limit reached
  is said to the agent in words, not failed silently.
- **His rules stay.** Approvals and gates of a helper or a unit's run are his, as for every
  thread: a main thread's agent can never answer them. A helper never gets a wider permission
  mode than its main thread.

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

1. **How does a thread get the helper tools?** Proposal: a switch per thread at start ("Can start
   helpers"), with a project default `chat.helpers`. Off by default, since it lets an agent start
   work that costs money.
2. **Which providers may a helper use?** Proposal: any connected instance the setting
   `chat.helperInstances` lists; by default every connected one, so a Claude thread can use Codex
   and the other way round.
3. **Where does a helper work?** Proposal: in its own working copy when the project is in Git
   (so its changes can be applied or reviewed), else read-only in the main thread's folder. A
   helper that should only read or review gets read-only mode in the main thread's folder.
4. **Does a helper's question or approval go to the main thread's agent?** Proposal: questions
   may be answered by the main thread's agent (it wrote the brief), approvals never. Same rule as
   the assistant's delegation.
5. **Parallel units: the limit and the failure rule.** Proposal: `workflows.planRunParallel`
   (default 2). With `workflows.planRunOnFailure: stop`, a failed unit stops starting new ones and
   lets the running ones finish.
6. **What does "lite löst" mean for the owner?** Read as: helpers are loosely tied to their main
   thread, keep working when the main thread's turn ends, and can be opened and steered on their
   own. To confirm.

## Decision log

- 2026-11-22: draft from the owner's request ("parallella enheter; huvudtråden ska kunna skapa
  en subagent i både Codex och Claude, och man ska kunna se att dessa jobbar och med vad"). The
  coordinator found the means in place: wow's MCP endpoint already serves the assistant's
  `start_thread` tools to both Claude Code and Codex, and threads in their own working copies,
  Threads at work, the thread tab in the panel and Apply cover running, seeing and bringing home.
  What is new is a chat session that carries wow's tools beside its own, a parent link between
  threads, and more than one live unit in a plan run.
