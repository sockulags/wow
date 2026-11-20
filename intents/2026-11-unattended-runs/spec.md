---
intent: 2026-11-unattended-runs
rev: 1
built_on: intent@1
status: draft
---

# Runs that can be left alone: ready working copies, limits on spending, and a view of how they go

## Summary

A project gets a setup command and a list of folders that can be made again. A new working copy,
for a run or a thread, runs the command before the first prompt; when the run ends, rebuildable
folders neither keep the copy nor get counted. A run stops at the end of a turn when it reaches
its cost or token limit and waits like it does at the step limit. A step turn that fails on a
passing provider error is sent again on its own. A workflow shows how its runs went.

## Behavior

### Setup command

1. Given a project whose `workspaces.setupCommand` is set (project scope, empty by default), when
   wow makes a working copy for a run or a thread, then it runs the command in the copy's folder
   through the system shell (`cmd.exe` on Windows) with the project's environment, after the copy
   is made and before the first prompt is sent.
2. Given the command runs, when it writes output, then the run view and the thread show a "Setup"
   row with the output as it comes and the time taken; exit code 0 lets the first prompt go out.
3. Given the command exits with another code or runs longer than
   `workspaces.setupTimeoutSeconds`, when it ends, then no turn starts: a run fails before its
   first step and a thread's first turn fails, both with the exit code and the last
   `workspaces.setupLogLines` lines. The copy is kept. "Run setup again" and "Skip setup" are
   offered on the run and on the failed turn.
4. Given the setting is empty, when a copy is made, then nothing runs and everything behaves as
   today.
5. Given Settings → Working copies for a project whose setup command is empty, when its folder
   holds a known lockfile, then the setting shows a suggestion from `workspaces.lockfileCommands`
   (`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json` → `npm ci`,
   `yarn.lock` → `yarn install --immutable`, `bun.lockb` → `bun install --frozen-lockfile`) with
   "Use this". Nothing is saved until the user presses it.

### Rebuildable folders and upkeep

6. Given `workspaces.rebuildablePaths` (project scope; default `node_modules`, `.pnpm-store`,
   `dist`, `build`, `out`, `.turbo`, `.next`, `coverage`, `.venv`, `target`), when wow counts what
   a working copy holds, then ignored files under those paths are not read file by file and do
   not keep the copy. Other ignored files still keep it, as today, because an agent's local file
   may be the only copy.
7. Given a run or thread copy that holds nothing but rebuildable folders, when it settles, then it
   is removed as a clean copy is today.
8. Given a kept copy, when `workspaces.slimAfterDays` (default 7) has passed since its run or
   thread ended, then wow deletes its rebuildable folders and keeps everything else; the copy
   shows "slimmed". "Slim now" does it at once. A copy whose run or thread is live is never
   touched.
9. Given a removal or slim that fails because a file is in use (`EBUSY`, `EPERM`), when it fails,
   then the copy shows "removal waiting: <path> is in use" and the scheduler tries again on its
   next tick and at startup, up to `workspaces.removeAttempts`; "Try again" does it at once.
10. Given Settings → Working copies, when it is shown, then it lists every copy with project, run
    or thread, branch, age, size (measured in the background and stored), state (live, kept,
    slimmed, removal waiting) and what keeps it (uncommitted files, other ignored files, unpushed
    commits), with Open folder, Slim now and Remove. The list's total size is shown at the top.

### Limits on spending

11. Given `workflows.maxRunCostUsd` or `workflows.maxRunTokens` (project scope, empty by default;
    a workflow's own value wins), when a run's total reaches it, then after the current turn ends
    the run waits before its next step with "Limit reached: $4.12 of $4.00". "Run once more"
    raises the limit for this run by `workflows.limitStepUsd` or `workflows.limitStepTokens` and
    goes on; Stop ends it. It is the same gate, keys and notification as the step limit.
12. Given `workflows.maxDailyCostUsd` (global, empty by default), when the cost of all workflow
    and plan runs since local midnight in the calendar zone reaches it, then no trigger starts a
    run until midnight (the card shows "held: daily limit" with Run now), and runs that are going
    wait before their next step as in 11.
13. Given a provider that reports tokens but no cost for a turn, when only a cost limit is set,
    then the run shows that the cost limit cannot see those turns; a token limit still applies.
14. Given a run, when its header is shown, then it shows its cost and tokens so far against its
    limit.

### Passing provider errors

15. Given a workflow or plan run step whose turn fails with an error its adapter marks as passing
    (connection lost, rate limited, overloaded, provider timeout), when
    `workflows.autoRetryAttempts` (project scope, default 1) is above zero, then the same turn is
    sent again in the same thread after `workflows.autoRetryDelaySeconds` (default 30, timed by
    the scheduler clock), and only when the attempts are used up does the step fail, and its
    rules apply.
16. Given a passing error, when it is retried, then the thread shows "Sent again after: <error>"
    and the step row counts it; retries do not count as step starts toward the step limit.
17. Given any other failure (an agent error, a refused permission, an unknown model), when it
    happens, then it is never sent again on its own.

### Statistics

18. Given a workflow, when it is selected in Workflows or in the context panel, then a Statistics
    tab shows over `workflows.statsDays` (default 30): runs by outcome; per step the median and
    longest time, median cost and tokens, attempts per run, how often a rule sent work back to
    it, and passing errors retried; per gate how often it waited, passed by itself, and the median
    wait.
19. Given steps were added or removed since a run, when statistics are shown, then steps are
    matched by id and removed steps are listed as removed.

### Assistant

20. Given the assistant, when it reads settings, then the new settings are listed with their
    schema and descriptions, and a proposal of any of them is held as a proposal like every
    `setting.set`. A proposed `workspaces.setupCommand` is shown in full with "wow will run this
    command in every new working copy of <project>".
21. Given the assistant's read tools, when asked how a workflow is doing, then it can read the
    statistics of 18.

## Interface

- Decided: the setup command is a project setting the user types or applies. wow never runs a
  command because a repository file declares it.
- Decided: rebuildable paths are a list of folder names matched anywhere in the copy, not globs
  over file contents; it keeps counting cheap and the rule easy to read.
- Decided: the spending limit reuses the step limit's gate, keys and words, so a run has one kind
  of "waits for you because a limit was reached".
- Decided: a passing error is sent again in the same thread as the same turn, not as a new
  attempt of the step, so the step limit and rules see one start.
- Decided: statistics are a projection on the server built from events; the UI only renders them.
- Left to delivery: wording, the look of the Setup row and the statistics tab, key bindings, and
  which errors each adapter marks as passing, from what the SDK and app-server actually report.

## Boundaries and non-goals

- wow runs no command in a working copy other than `workspaces.setupCommand`.
- Limits and retries apply to workflow and plan runs only.
- No change to what keeps a copy for files outside `workspaces.rebuildablePaths`.
- Tests do not sleep, poll or retry; delays go through the scheduler's controllable clock.

## Decisions

- **Setup command over letting the agent install.** Rejected: the first step installs (a turn
  every run, done differently each time), sharing `node_modules` through a junction (a branch can
  change the lockfile, and one copy's install breaks the others).
- **Rebuildable folders do not keep a copy.** Rejected: ignoring every ignored file (an agent's
  `.env` or notes can be the only copy), keeping today's rule (a copy with `node_modules` is never
  removed and is slow to count).
- **Limits stop between turns.** Interrupting mid-turn can leave files half-edited. Rejected: a
  hard stop.
- **Retry only what the adapter calls passing.** Unknown errors are not passing, so an agent's own
  failure is never repeated.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
- Server Vitest against temporary Git repositories: setup command exit 0, exit 1, timeout on the
  controllable clock (1 to 4); a copy holding only `node_modules` removed, one with a `.env` kept,
  `node_modules` not walked (6, 7); slim after the keep days (8); a file held open on the Windows
  runner leaves removal waiting and the next tick removes it once closed (9).
- Server Vitest with the controllable clock and mock usage: run limit after a turn, Run once more,
  daily hold across two runs and the midnight rollover in the calendar zone, tokens-only turns
  (11 to 13); a passing error retried, limit of attempts, a non-passing error not retried, retries
  not counted toward the step limit (15 to 17); statistics rebuilt from a recorded event sequence
  (18, 19).
- Adapter Vitest with invented fixtures for each passing and non-passing error kind.
- `pnpm e2e`: the Setup row and Skip setup, the working copies list, the limit gate, the
  statistics tab, the assistant proposing a setup command.
- Manual Windows check added to `docs/windows-smoke.md`: a run in this repository with
  `pnpm install --frozen-lockfile` as setup command, ended and removed with its `node_modules`.

## Open risks

- Deleting a large `node_modules` on Windows can take minutes. Evidence: the delete runs off the
  event loop and the scheduler tick is not delayed in the Windows test.
- Which provider errors are passing is loosely documented. Evidence: adapter fixtures from real
  error shapes, invented in content; unknown errors stay non-passing.
- Codex turns without cost leave cost limits partial for Codex. Evidence: behavior 13 shown.

## Decision log
