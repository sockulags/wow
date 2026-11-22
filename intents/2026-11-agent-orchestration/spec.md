---
intent: 2026-11-agent-orchestration
rev: 1
built_on: intent@1
status: accepted
---

# One thread runs others: helper threads on any provider, and units in parallel

## Summary

Every chat thread's agent gets a small set of wow tools that start, follow and stop helper
threads on any connected Claude Code or Codex instance. A helper works like Claude Code's
subagent: in the main thread's folder, or in its own working copy on request; its answer goes
back to the main thread's agent; it stops with the main thread's turn. It is drawn in the main
thread as a row with what it does now, and Threads at work lists it under its main thread. A plan
run can have several units live at once, up to `workflows.planRunParallel`.

This intent builds on the assistant's MCP endpoint and toolset (`2026-11-app-assistant`), the
assistant's delegation and its follower (`2026-11-chief-of-staff`), threads' own working copies
(`2026-11-thread-work`), Threads at work and the thread tab (`2026-11-parallel-threads`) and plan
runs (`2026-11-review-loop`).

## Behavior

### Helper tools in a chat thread

1. Every chat thread that is not a helper and not a workflow step's thread carries wow's helper
   tools beside its provider's own tools, while `chat.helpers` (project scope, on by default) is
   on. The tools' descriptions tell the agent to use a helper when the task needs a second agent
   (another provider's view, work that can run beside its own) or the user asks for one, not by
   habit. A step's thread, a helper and the Assistant have none.
2. The tools:
   - `start_helper {brief, instance?, model?, effort?, isolation?: 'folder' | 'copy', title?}`
     starts a helper and answers its id at once. `instance` names a connected instance by its name
     (any provider); absent, the main thread's own instance. `isolation: 'copy'` gives the helper
     its own working copy (refused, with the reason, outside Git).
   - `list_helpers {}` answers the thread's helpers: id, title, instance, state, what it runs now.
   - `read_helper {id}` answers its state, its last answer and the files it changed.
   - `write_to_helper {id, text}` sends it a message (queued while it works).
   - `answer_helper_question {id, answers}` answers a question the helper asked.
   - `stop_helper {id}` stops its running turn.
     No tool answers an approval or a gate.
3. When a helper's turn ends, asks a question, or fails, wow tells the main thread's agent with a
   message "From wow: helper <title> …" that carries its final answer, the question, or the
   error. It goes to the running turn when the provider takes messages during a turn, otherwise it
   waits for the turn's end, as queued messages do. The main thread's agent goes on with it.

### Helper threads

4. A helper is a chat thread with `parentThreadId` set to its main thread and `startedBy:
'helper'`. It has the main thread's project, the brief as its first message, and its own
   session on the instance it runs on. Its title is `title`, else the brief's first line.
5. Its folder: by default the main thread's own folder (its working copy when it has one), shared
   as Claude Code's subagents share theirs. With `isolation: 'copy'`, a new working copy on a new
   branch made from where the main thread's folder is, as a thread's own copy is made.
6. Its permission mode is the main thread's, mapped to the nearest mode of the helper's provider
   that is not wider. Its approvals go to the user, as every thread's do, and appear in the
   decision queue and Threads at work under "Needs you".
7. Coupling: stopping the main thread's running turn stops every helper it started that is
   working. Marking the main thread done, archiving or removing its working copy is refused while
   a helper works, with the reason. A helper cannot start helpers.
8. Limits: at most `chat.helpersPerThread` helpers of one main thread work at once, and
   `chat.helpersLive` in all. Over a limit, `start_helper` answers the reason in words and starts
   nothing.
9. A helper is an ordinary thread for the user: it is in the thread list (under its main thread),
   can be opened, written to, stopped and applied (Apply to project folder, for a helper with its
   own copy).

### Seeing helpers

10. The main thread's conversation shows each helper where it was started as one row: "Helper ·
    Codex · review the timer change", then what it does now as the working line says it, what it
    waits for, or its last line once done, and its time. Enter or a click opens the helper in a
    tab of the side panel; the row has **Open thread** and **Stop**.
11. Threads at work lists a helper indented under its main thread when both are listed, and under
    its own group otherwise, with "Helper of <main thread>".
12. The thread list shows a main thread's helpers folded under it, with a count of those working.

### Units in parallel

13. A plan run keeps up to `workflows.planRunParallel` units' runs live at once (default 1, which
    is today's behavior). When it has room, it starts the next ready units in plan order, each in
    its own run and working copy. A unit whose dependency is not delivered is not ready, as today.
14. With `workflows.planRunOnFailure: stop`, a failed or stopped unit's run ends the plan run as
    failed once its other live runs have ended, and no new unit starts meanwhile. With `skip` the
    plan run goes on.
15. The plan run's view lists each live unit with its run's step, state and what the step's thread
    runs now; Threads at work shows each unit's step thread under "Working" with its unit key.

### Old data

16. Threads, plan runs and items stored before load and look as they did. A thread stored before
    has no parent and no helpers.

## Interface

- Decided: contracts `Thread.parentThreadId` (nullable, optional), `Thread.startedBy` gains
  `'helper'`, item kind `helper_started` (`HelperStartedItemPayload {helperThreadId, title,
instanceName, isolation, at}`), commands `helper.start`, `helper.write`, `helper.answer`,
  `helper.stop` (only the helper endpoint sends them; the engine refuses them from anyone else),
  internal `helper.followed`. Migration numbered at delivery.
- Decided: a second MCP path on the wow port, `/threads/mcp`, with the same transport as
  `/assistant/mcp` (`assistant/mcp.ts`), answering only the helper tools. Each main thread's turn
  gets its own token, kept in memory and tied to that thread, so a call can only reach that
  thread's helpers. The token is never stored or logged.
- Decided: adapters. A `startTurn` gets `helperTools?: {url, token}` beside its ordinary options:
  the Claude adapter adds the `wow` MCP server to the session's own (no `strictMcpConfig`, the
  user's settings, tools and servers stay) and allows `mcp__wow__*_helper*` tools; the Codex
  adapter adds `mcp_servers.wow` to the thread's config and keeps everything else. This is the
  first ordinary session with wow's tools; the tools-only session of the Assistant is unchanged.
- Decided: server `apps/server/src/helpers/` (`HelperService`: start, follow, stop, limits;
  `helper-tools.ts`: the tools), built on `assistant/delegation.ts` and `assistant/follow.ts`
  (`DelegationFollower` generalised to follow a helper for its main thread).
- Decided: settings `chat.helpers` (project, true), `chat.helpersPerThread` (3),
  `chat.helpersLive` (6), `workflows.planRunParallel` (1).
- Decided: web `chat/tools/helper.tsx` (the row), the thread list's folding, Threads at work's
  grouping (`atWorkRows` by `parentThreadId`), and the plan run view's live units.
- Decided: engine `advancePlanRun` takes the live runs (many) and the limit, and answers the units
  to start (many); `PlanRun` gains nothing new (its `units` already list each run).

## Boundaries and non-goals

- No change to Claude Code's or Codex's own subagents.
- No helper of a helper, no helper of a step's thread, no helper tools in the Assistant.
- No merging of helpers' changes; a shared folder is shared as Claude Code shares it.
- No parallel steps in one run.

## Decisions

- **A helper is a thread.** Everything wow does for threads (list, panel, approvals, Apply,
  notifications, restore) works for helpers with no second model of an agent.
- **Answers come back as messages.** A tool call that waits for a whole helper turn would hit the
  providers' tool timeouts and hold the main turn open; a message after the helper's turn is how
  the assistant's follower already works and survives a restart.
- **Shared folder by default**, because the owner asked for Claude Code's behavior. Two agents
  writing one file at once is the same risk as with Claude Code's subagents; a helper that should
  not share asks for its own copy.
- **The limit for parallel units starts at 1**, so nothing changes until the owner picks a value.

## Security

- The helper endpoint answers only with a live main turn's token and only for that thread's
  helpers. A brief, a helper's answer and its question are text to the agent; they start nothing
  but what the tools above do, inside the limits.
- A helper never gets a wider permission mode than its main thread, and its approvals stay the
  user's. The assistant's tools and permissions are unchanged.
- Text from a fork's pull request reaches a helper only through a main thread the user started;
  a step's thread has no helper tools, so an event run cannot start one.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm --filter @wow/server test` covers the helper endpoint and its tokens, start in the folder
  and in a copy, the follow messages, coupling on stop, limits, permission mapping and old rows;
  plan runs with two units live, a failure with `stop` and `skip`, and the limit of 1.
- `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex test` cover a
  session with the user's own tools and servers plus `wow`.
- `pnpm --filter @wow/web test` covers the helper row, the thread list's folding, Threads at work
  and the plan run view.
- `pnpm e2e` with the mock providers covers a Claude thread that starts a Codex helper and goes on
  with its answer.

## Open risks

- Neither provider's handling of an extra MCP server beside the user's own was seen against the
  real programs; Codex's `mcp_servers` merge with the user's `config.toml` in particular. The
  Windows smoke list gets a line for each.
- How often agents call `start_helper` unasked depends on the tools' descriptions; to be watched
  in use and tuned in the descriptions, which are text in the server, not settings.
- Two units live at once double what runs on the machine; the default of 1 keeps that a choice.
