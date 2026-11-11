---
intent: 2026-11-workflow-branches
rev: 1
built_on: spec@1
status: done
source: files
---

# Plan: Workflows that take different paths depending on how a step went

Execution: three units in order, each by a worker and an independent reviewer, on the delivery
branch after the review loop's units U1 to U10, which they build on. Every unit updates
`docs/architecture.md` for what it changes and leaves the repository checks green.

## Units

- [U1] Rules in the engine and the server
- [U2] Rules and the paths diagram in the builder — depends on U1
- [U3] The run's path, the default templates and the guide — depends on U1, U2

### U1 Rules in the engine and the server

Outcome: a workflow step can carry rules, and a run follows them: after the step's gate has
passed, the first rule that holds decides the next step. A run can go back to an earlier step,
skip to a later one, end, or follow a rule for a failed step, with a limit on how often a step
starts. Workflows without rules behave exactly as before.
Boundaries: no builder or run view changes beyond what types force (U2, U3). No new facts beyond
verdict, checks, artifacts and step failed. Send back by hand, gate conditions and plan runs keep
their behavior. No model decides anything.
Change surface: `packages/contracts` (`WorkflowStep.rules`, the rule and condition types,
`Workflow.maxStepVisits`, `StepRunState` gains `skipped`, `WorkflowRun.path`, the limit as a gate
state), `packages/workflow-engine/src/engine.ts` and `handover.ts` (routing after `completeStep`
and `continueRun`, going back through the same path send back uses, the limit, the failed rule),
`apps/server/src/core/workflows.ts` (validation and refusals), `workflows/runner.ts` (facts at
step end), the wait for checks, settings (`workflows.maxStepVisits`, `workflows.goBackTemplate`,
`workflows.verdictChangesRequestedLine`, `workflows.verdictBlockedLine`).
Acceptance:

- Given a step with rules "verdict is changes requested → build" and "verdict is blocked → End",
  when the step ends with `CHANGES_REQUESTED`, then `build` starts; with `BLOCKED`, the run is
  done; with `APPROVED`, the next step in the list starts (spec 1, 2, 6).
- Given `**CHANGES_REQUESTED**` or the line in backticks as the last non-empty line, then it is
  read as the verdict; given the word only earlier in the message, then the verdict is "no
  verdict" (spec 2).
- Given a rule on checks and checks still running, then the run waits for checks; when a read of
  the step's commit shows a failure, the "failed" rule is followed; after the timeout the run
  waits for the user (spec 3).
- Given a rule on artifacts and a glob that found nothing, then the "missing" rule is followed
  (spec 4).
- Given a failed turn and a rule "when the step failed → diagnose", then `diagnose` starts with
  the error in its handover; without the rule the run fails; a stopped step follows no rule
  (spec 5).
- Given review sends back to build, then build runs again in its own thread as attempt 2 with a
  message from `workflows.goBackTemplate` naming review, the fact and review's final message, and
  review then runs again as attempt 2 (spec 7, 8).
- Given a step that has started three times with the limit at three, when it would start again,
  then the run waits for the user with the limit sentence; Approve starts it once more, Stop ends
  the run; a workflow's own number wins over the setting (spec 9).
- Given a gate before the step gone back to, then the run waits there (spec 10).
- Given a rule to a later step, then the steps between show `skipped` for that pass (spec 11).
- Given a step using `plan-work` reached by a rule, then its gate waits for the user (spec 12).
- Given a gate after a step that waits for the user and a send back by hand, then it works as
  before and no rule is followed until the gate passes (spec 13).
- Given a rule naming a missing step, a rule on artifacts for a step without expected artifacts,
  or two rules with one condition, then `workflow.create` and `update` are refused with the reason
  (spec 16, server side).
- Given a run stored before this change and a workflow without rules, then both continue and
  finish as before (spec 17).
- Given every transition, then `run.path` gains a visit with step, attempt, how it ended and the
  reason for the next move (spec 18, data only).

Ground truth: `pnpm --filter @wow/workflow-engine test` with a named case per acceptance line,
including "review sends back twice then approves"; `pnpm --filter @wow/server test` for the
checks wait, validation and a run from before the change; repository checks.
Dependencies: none inside this plan. It builds on the review loop's U4 (send back reuses a
thread) and U10 (verdict line, wait for checks, always-stop skills).
Evidence and settled decisions: a rule is evaluated after the gate has passed; going back reuses
the thread; the limit counts starts and waits for the owner; `StepRun` stays one row per step
(spec Decisions). The engine today follows steps by position and thread ids are
`<runId>.<stepId>`.
Delivery target: commit on the delivery branch.
Open risks: plan runs and event runs start ordinary runs and must not break; run their tests.
A migration is needed only if the run row's shape cannot take the new optional fields as they
are; prefer optional fields with defaults.

### U2 Rules and the paths diagram in the builder

Outcome: in the workflow builder a step has an "After this step" list where the user adds,
orders and removes rules, and a diagram beside the steps draws every path a run can take and
follows each edit.
Boundaries: no run view changes (U3). No graph editing: the diagram is read-only. No new facts.
Do not restyle `components/ui`.
Change surface: `apps/web/src/workflows` (builder: step form, a rules component, validation
messages from the server's refusals, palette commands and keybindings for adding and moving a
rule), a pure module that turns a workflow into diagram source, the existing `MermaidDiagram`
component.
Acceptance:

- Given a step in the builder, when the user adds a rule and picks fact, value and target, then
  the workflow is saved with it and "Otherwise: the next step" shows last (spec 14).
- Given two rules, when the user moves the second up by keyboard, then their order is saved
  (spec 14).
- Given a step without expected artifacts, then the artifacts fact is not offered for it; given a
  target step that is deleted, then the rule is marked with the server's reason (spec 16).
- Given a workflow with a loop and a gate, then the diagram shows each step, the list order, the
  rule arrow with its condition, and the gate, and changes when a rule is edited (spec 15).
- Given a workflow without rules, then the builder looks and saves as before and the diagram
  shows a straight line (spec 17).
- Given a step name with quotes, brackets or a newline, then the diagram still draws and shows
  the name as text.

Ground truth: `pnpm --filter @wow/web test` with cases for the rules component and for the
diagram source of a straight workflow, a loop, a skip and a hostile step name; `pnpm e2e` case
"build a workflow with a loop"; screenshots at
`intents/2026-11-workflow-branches/sketches/step-rules.png` and `paths-diagram.png`; repository
checks.
Dependencies: U1 for the rule types and the server's validation.
Evidence and settled decisions: rules are rows of three selects with a fixed last line; the
diagram is drawn with the chat's diagram component (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: the diagram component refuses sources it finds unsafe; build the source from ids and
escaped labels only.

### U3 The run's path, the default templates and the guide

Outcome: a run shows the path it took and why, a step that ran several times shows its attempts,
waiting at the loop limit is clear in the gate bar, the default templates loop review back to
delivery, and the user guide explains rules.
Boundaries: no engine changes; a defect found in U1 is fixed only when small, otherwise
reported. Stored templates the user edited are not rewritten.
Change surface: `apps/web/src/workflows` (run view "Path" tab, step rows, `gate-bar.tsx`),
`packages/contracts/src/settings.ts` (default templates), `apps/web/e2e`, `docs/user-guide.md`,
`docs/architecture.md`.
Acceptance:

- Given a run where review sent back once and then approved, then Path lists build 1, review 1
  ("verdict changes requested → Build"), build 2, review 2 ("verdict approved → next step")
  (spec 18).
- Given a step on attempt 2, then its row says so and the Changes tab's "this step" marks what
  the latest attempt changed (spec 19).
- Given a run waiting at the limit, then the gate bar shows the limit sentence with "Run once
  more" and Stop (spec 9).
- Given a workflow made from the default "Feature" template, then its check-work step has the
  rule to go back to deliver-work on changes requested; a stored template is unchanged (spec 20).
- Given a plan run whose unit run looped twice, then the plan run lists one run for the unit
  (spec 21).
- Given the user guide, then it has a section on rules, the limit and the path, with the keys
  used.

Ground truth: `pnpm --filter @wow/web test`; `pnpm e2e` case "a review sends the work back and
the run shows its path"; screenshots at `intents/2026-11-workflow-branches/sketches/run-path.png`
and `loop-limit.png`; repository checks.
Dependencies: U1 for `run.path` and the limit state; U2 for building the workflow the e2e runs.
Evidence and settled decisions: Path is a tab next to Steps and Changes (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: none.
