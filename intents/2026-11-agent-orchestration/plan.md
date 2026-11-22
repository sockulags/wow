---
intent: 2026-11-agent-orchestration
rev: 1
built_on: spec@1
status: done
source: files
---

# Plan: One thread runs others

Execution: five units. U1 and U5 have no dependency between them and may be built at the same
time; U2 needs U1, U3 needs U2, U4 needs U3. Every unit updates `docs/architecture.md` (its
section, the settings list, the data model) and `docs/user-guide.md`, adds a line to
`docs/windows-smoke.md` for each provider fact it relies on, and leaves the repository checks
green.

## Units

- [U1] wow's tools in an ordinary session
- [U2] Helper threads — depends on U1
- [U3] Following helpers — depends on U2
- [U4] Seeing helpers — depends on U3
- [U5] Units in parallel

### U1 wow's tools in an ordinary session

Outcome: a chat thread's turn can carry `helperTools {url, token}`; both adapters add the `wow`
MCP server beside the session's own tools and servers, and wow answers `/threads/mcp` for a live
turn's token with an empty tool list.
Boundaries: no helper tools yet; the Assistant's tools-only session unchanged.
Change surface: contracts `ProviderCommand` startTurn; `apps/server/src/helpers/endpoint.ts`
(path, per-turn tokens), the provider service; `packages/provider-claude`,
`packages/provider-codex`.
Acceptance:

- Given a chat turn with `chat.helpers` on, then the adapter's session options hold the user's
  servers and tools plus `wow`; with it off, they are as today (spec 1).
- Given a call with another turn's token, or after the turn ended, then 401 (Security).
- Given a step's thread or the Assistant, then no `helperTools` (spec 1).

Ground truth: `pnpm --filter @wow/server test`, `pnpm --filter @wow/provider-claude test`,
`pnpm --filter @wow/provider-codex test`, repository checks.

### U2 Helper threads

Outcome: `start_helper`, `list_helpers`, `read_helper`, `write_to_helper`, `stop_helper`; helper
threads with a parent, a folder or own copy, a mapped permission mode, and limits.
Boundaries: no follow messages (U3), no new web rows (U4).
Change surface: contracts `Thread.parentThreadId`, `startedBy: 'helper'`, `helper_started`, the
`helper.*` commands; server `helpers/service.ts`, `helpers/helper-tools.ts`, `core/threads.ts`,
the projector, a migration; settings `chat.helpers`, `chat.helpersPerThread`, `chat.helpersLive`.
Acceptance:

- Given `start_helper` naming the Codex instance from a Claude thread, then a Codex thread with
  the brief starts in the main thread's folder; with `isolation: 'copy'` in its own copy (spec 2,
  4, 5).
- Given the main thread in Accept edits, then a Claude helper gets Accept edits and a Codex
  helper no wider mode (spec 6).
- Given the limits reached, then the tool answers why and nothing starts (spec 8).
- Given the engine alone, then `helper.*` is refused (Interface).

Ground truth: `pnpm --filter @wow/server test`, repository checks.

### U3 Following helpers

Outcome: a helper's end, question or failure reaches the main thread's agent as "From wow: …";
`answer_helper_question`; stop and done coupling.
Boundaries: approvals never answered.
Change surface: server `helpers/follow.ts` (from `assistant/follow.ts`), `core/threads.ts`
(refusals while helpers work), the provider service (stop).
Acceptance:

- Given a helper that ends, then the main thread gets its final answer as a message, at once if
  its turn takes messages, else at its end (spec 3).
- Given a helper's question, then the main thread's agent can answer it; given an approval, the
  tool refuses (spec 2, 6).
- Given Stop on the main turn, then working helpers stop; given Mark done with a helper working,
  then it is refused with the reason (spec 7).

Ground truth: `pnpm --filter @wow/server test`, repository checks.

### U4 Seeing helpers

Outcome: the helper row in the main conversation, the thread list folding, Threads at work
grouping, the panel tab from the row.
Boundaries: web only, on the topics U2 and U3 fill.
Change surface: web `chat/tools/helper.tsx`, `chat/items.tsx`, `chat/find.ts`,
`chat/conversation-markdown.ts`, `chat/chat-view.tsx`, `chat/at-work.tsx`.
Acceptance:

- Given a working Codex helper, then its row reads "Helper · Codex · <title>" with the working
  line, Enter opens it in the panel, Stop stops it (spec 10).
- Given Threads at work and the thread list, then the helper is under its main thread (spec 11,
  12).
- `pnpm e2e` case "a Claude thread starts a Codex helper and goes on with its answer".

Ground truth: `pnpm --filter @wow/web test`, `pnpm e2e --grep helper`, repository checks.

### U5 Units in parallel

Outcome: a plan run with up to `workflows.planRunParallel` units live; failure rules; the plan
run view's live units.
Boundaries: one step at a time inside a run, as today.
Change surface: engine `plan-run.ts` (`advancePlanRun` with many live runs), server
`core/plan-runs.ts`, `plans/plan-runs.ts`; web plan run view; setting
`workflows.planRunParallel`.
Acceptance:

- Given the limit 2 and three ready independent units, then two runs start, and the third when
  one ends (spec 13).
- Given `stop` and a failing unit, then no new unit starts and the plan run fails once the other
  ends; with `skip` it goes on (spec 14).
- Given the default 1, then everything is as today (spec 13).

Ground truth: `pnpm --filter @wow/workflow-engine test`, `pnpm --filter @wow/server test`,
`pnpm --filter @wow/web test`, repository checks.
