---
intent: 2026-11-unattended-runs
rev: 1
built_on: spec@1
status: draft
source: files
---

# Plan: Runs that can be left alone

Execution: four units, each by a worker and an independent reviewer. U1 and U4 can run side by
side; U3 follows U2 because both change the workflow runner. Every unit updates
`docs/architecture.md` and `docs/user-guide.md` for what it changes and leaves the repository
checks green.

## Units

- [U1] Working copies: setup command, rebuildable folders, upkeep and the list
- [U2] Limits on spending
- [U3] Passing provider errors sent again — depends on U2
- [U4] Workflow statistics

### U1 Working copies: setup command, rebuildable folders, upkeep and the list

Outcome: a project's setup command runs in every new run and thread working copy before the first
prompt, with its output on a Setup row and a failure that stops before any turn; rebuildable
folders neither keep a copy nor get counted; kept copies are slimmed after the keep days;
removals stopped by a locked file are tried again; Settings → Working copies lists every copy.
Boundaries: no command other than the setting. Nothing touched while a run or thread is live.
Change surface: `packages/contracts` (settings `workspaces.setupCommand`,
`workspaces.setupTimeoutSeconds`, `workspaces.setupLogLines`, `workspaces.lockfileCommands`,
`workspaces.rebuildablePaths`, `workspaces.slimAfterDays`, `workspaces.removeAttempts`; copy
states and setup output on runs and threads; commands for run setup again, skip setup, slim and
try again), `apps/server/src/workspaces` (setup, counting, slim, retried removal, size),
the scheduler tick, the thread working copy path, `apps/web` (Setup row, the list, the lockfile
suggestion), the assistant's setting wording for the setup command, docs.
Acceptance: spec 1 to 10 and 20.
Ground truth: the spec's working copy Vitest lines on both runners; `pnpm e2e --grep "working
copies|setup"`; repository checks.
Open risks: Windows file locks and long deletes; see the spec.

### U2 Limits on spending

Outcome: run totals of cost and tokens; per-run and daily limits that stop a run before its next
step through the step limit's gate; triggers held by the daily limit; the run header shows
spending against the limit.
Boundaries: hand threads are not limited. No change to the step limit's own rules.
Change surface: `packages/contracts` (settings `workflows.maxRunCostUsd`, `workflows.maxRunTokens`,
`workflows.limitStepUsd`, `workflows.limitStepTokens`, `workflows.maxDailyCostUsd`; the
workflow's own limits; the limit gate's reason), `packages/workflow-engine`, the runner and
scheduler in `apps/server`, the run view and card in `apps/web`, docs.
Acceptance: spec 11 to 14.
Ground truth: the spec's limit Vitest lines; `pnpm e2e --grep limit`; repository checks.
Open risks: none

### U3 Passing provider errors sent again

Outcome: both adapters mark passing errors on a failed turn; a workflow or plan run step's turn
that fails with one is sent again in the same thread after the delay, up to the attempts, before
the step fails; the thread and step row show it.
Boundaries: classification stays in the adapters; hand threads unchanged.
Change surface: `packages/contracts` (`passing` on the normalized turn failure; settings
`workflows.autoRetryAttempts`, `workflows.autoRetryDelaySeconds`), `packages/provider-claude`,
`packages/provider-codex`, the runner and scheduler, the thread and step row, docs.
Acceptance: spec 15 to 17.
Ground truth: adapter fixtures per error kind; the spec's retry Vitest lines; repository checks.
Open risks: error shapes are loosely documented; unknown stays non-passing.

### U4 Workflow statistics

Outcome: a statistics projection built from events and a Statistics tab for a workflow, also
readable by the assistant.
Boundaries: read-only, no export.
Change surface: `packages/contracts` (the statistics shape, `workflows.statsDays`), a projection
in `apps/server`, the assistant's read tool, the workflow view and context panel, docs.
Acceptance: spec 18, 19 and 21.
Ground truth: the projection rebuilt from a recorded event sequence in Vitest; `pnpm e2e --grep
statistics`; repository checks.
Open risks: rebuild time on a long history; build it from new events as they come.

## Epic contract

Epic outcome: a run started from a card while Lucas is in meetings starts with dependencies
installed, stops only for him, a limit or a gate, survives a provider hiccup, and leaves no
`node_modules` behind.
Acceptance: spec "Behavior", all.
Children or delivery units: U1 to U4.
Aggregate verification: repository checks and `pnpm e2e` on `main` after each unit, then the
Windows smoke line.
Final verification owner: Lucas (manual smoke) and the reviewer of each unit.
