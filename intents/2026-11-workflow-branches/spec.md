---
intent: 2026-11-workflow-branches
rev: 1
built_on: intent@1
status: accepted
---

# Workflows that take different paths depending on how a step went

## Summary

Today a workflow runs its steps in order, whatever happens. After this, each step can say where
the run goes next depending on how the step went: the review said "changes requested", the build
failed, the expected file is missing, or the step itself failed. The most common use is a loop:
the review sends the work back to the step that built it, with what the reviewer wrote, until the
review approves. Every loop has a limit, and at the limit the run stops and waits for you.

You set this up in the workflow builder as plain rules on a step ("when the verdict is changes
requested, go to Deliver"), and the builder draws the paths a run can take. A run shows the path
it actually took and why. Nothing is decided by asking a model: wow chooses from facts it already
has. The stops at plan and spec still always stop.

The owner asked the agent to take the open decisions for this spec on 2026-11-10. Each is marked
"delegated" below and is open to change in review.

## Behavior

### Rules on a step

1. Given a step with rules, when the step has ended and its gate (if any) has passed, then the
   first rule whose condition holds decides the next step; when none holds, the run goes to the
   next step in the list, as today.
2. Given a rule on the verdict, when the step's final message ends with the approved, changes
   requested or blocked line (`workflows.verdictApprovedLine`,
   `workflows.verdictChangesRequestedLine`, `workflows.verdictBlockedLine`; backticks and bold
   around the line are ignored), then the verdict is that one; any other ending is "no verdict".
3. Given a rule on checks, when the run's pull request shows every check successful for the commit
   the step left, then checks are "successful"; when one failed, "failed". While they run the run
   waits for checks as a gate does, and after `workflows.gateChecksTimeoutMinutes` it waits for
   the user and says so.
4. Given a rule on artifacts, when every expected artifact glob of the step found a file, then
   artifacts are "found"; otherwise "missing".
5. Given a rule "when the step failed", when the step's turn fails, then the run goes to the
   rule's step with the error in the handover. Without such a rule a failed step fails the run, as
   today. A step that was stopped by the user never follows a rule.
6. Given a rule that goes to "End", when it holds, then the run finishes as done.

### Going back

7. Given a rule that goes to an earlier step, when it holds, then that step runs again in its own
   thread, as attempt N+1, with a message built from `workflows.goBackTemplate`: which step sent
   it back, why (the fact that held) and that step's final message.
8. Given the steps between the earlier step and the one that sent back, when the run reaches them
   again, then each runs again as its next attempt in its own thread.
9. Given a step that has started `workflows.maxStepVisits` times in a run (the workflow may set
   its own number), when a rule or the list would start it again, then the run waits for the
   user at that step and says "Deliver has run 3 times: the limit". Approve lets it run once
   more; Stop ends the run.
10. Given a gate before the step that is gone back to, when the rule holds, then the run waits at
    that gate as it would on the first visit.

### Skipping

11. Given a rule that goes to a later step, when it holds, then the steps in between do not run
    in this pass and show "skipped"; a later pass can still run them.

### Gates and planning skills

12. Given a step whose skill is in `workflows.alwaysStopSkills`, when a run reaches it by any
    path, then its gate waits for the user; a rule never passes it.
13. Given a step with a gate after it that waits for the user, when the user sends the step back
    by hand, then that works as today and no rule is followed until the gate passes.

### Building

14. Given the builder, when a step is edited, then under "After this step" the user adds rules,
    each "When <fact> is <value>, go to <step or End>", orders them, and removes them; "Otherwise:
    the next step" always shows last.
15. Given a workflow with rules, when the builder shows it, then a diagram draws the steps, the
    order, every rule as an arrow with its condition, and gates, and it follows each edit.
16. Given a rule that names a step that no longer exists, a rule on artifacts for a step without
    expected artifacts, or two rules with the same condition on one step, when the workflow is
    saved, then it is refused and the rule is marked with the reason.
17. Given a workflow without rules, when it is saved and run, then nothing differs from today.

### Seeing the path

18. Given a run, when its view is opened, then a Path list shows each step visit in the order it
    happened: step, attempt, how it ended, and why the run went where it went next ("verdict
    changes requested → Deliver", "no rule held → next step", "limit reached, waited for you").
19. Given a step that ran more than once, when the run view shows it, then the step row shows its
    attempt count and the Changes tab's "this step" marks the latest attempt.

### Templates and plan runs

20. Given the default templates, when a workflow is made from "Bug", "Feature" or "Initiative",
    then the check-work step has the rule "when the verdict is changes requested, go to
    deliver-work".
21. Given a plan run, when a unit's run follows rules, then the plan run treats the unit's run as
    one run, however many times its steps repeat.

## Interface

No sketch was made before building; the owner delegated these on 2026-11-10 and reviews the built
screens, whose screenshots delivery saves at the paths given.

- Owner, workflow builder, a step's rules. Decided: (delegated) a list of rule rows under the
  step, each three selects (fact, value, target), drag handle or Alt+arrow to order, and a fixed
  last line "Otherwise: the next step". Rejected: a graph editor (the intent rules it out), a
  rule language typed as text. Sketch: `intents/2026-11-workflow-branches/sketches/step-rules.png`.
- Owner, workflow builder, paths diagram. Decided: (delegated) a read-only flowchart beside the
  step list, drawn with the diagram component the chat already has, with rule arrows labelled by
  their condition and gates as marks on the arrows. Rejected: a text list of paths (hard to read
  once there is a loop). Sketch: `intents/2026-11-workflow-branches/sketches/paths-diagram.png`.
- Owner, run view, Path. Decided: (delegated) a "Path" tab next to Steps and Changes with one row
  per step visit and the reason for the next move. Rejected: annotating the step list only (a
  step that ran three times needs three rows). Sketch:
  `intents/2026-11-workflow-branches/sketches/run-path.png`.
- Owner, run view, waiting at the limit. Decided: (delegated) the gate bar shows the limit
  sentence with Approve ("Run once more") and Stop. Sketch:
  `intents/2026-11-workflow-branches/sketches/loop-limit.png`.

## Boundaries and non-goals

- One step at a time. No parallel steps, no workflows calling workflows.
- No expressions or code in conditions, and no model decides a path.
- No graph editor.
- Facts are the four above. Change size, ticket type and free words are not facts yet.
- Existing workflows, runs and templates the user edited keep working unchanged; only the default
  templates gain a rule, and stored templates are not rewritten.
- Send back by hand, gate conditions and plan runs behave as the review loop spec says.

## Decisions

Every decision here is delegated unless it cites the intent.

- **A rule is evaluated after the step's gate has passed.** The gate is where a person or a
  condition lets the work through; the rule then says where it goes. Rejected: rules before the
  gate (a run would loop without ever showing the owner a stop he asked for).
- **Going back reuses the step's thread, like send back.** The agent keeps its context and the
  conversation stays in one place; the reviewer's final message takes the place of the owner's
  note. Rejected: a new thread per visit.
- **The limit counts starts of a step in a run, default 3, and at the limit the run waits for the
  owner** (the intent's recommendation). Rejected: failing the run (loses the work), going on to
  the next step (passes work a review just refused).
- **A failed step can have a rule** (intent open question). It lets "on failure, diagnose" exist
  without making failure silent: without a rule nothing changes.
- **Verdicts are check-work's three lines**, read as the last non-empty line, the same way the
  approved line is read for gate conditions. Rejected: a free word the agent ends with (the
  intent rules out the agent choosing the path beyond a fixed last line).
- **The run keeps a path log** (`run.path`) of step visits and reasons, and `StepRun` stays one
  row per step with its attempt count, so every view that reads steps by position still works.
- **Skipped is a step state for a pass, not for the run.**
- **The checks fact reuses the gate's wait for checks**, including the rule that only checks of
  the commit the step left count.
- **Whether the app assistant may change rules** is left to the assistant's spec; rules let the
  app do more on its own, so the assistant intent's "waits for a yes" applies.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Engine tests cover behaviors 1 to 13 and 21 with a case each, including: review sends back
  twice then approves; the limit reached; a failed step with and without a rule; a skip; a
  planning skill reached by a rule; checks pending then failed.
- `pnpm e2e` covers 14, 15, 16, 18 and 20 against mock providers and the mock host: build a
  workflow with a loop, run it, see the path.
- Server tests cover a run made before this change continuing unchanged (17) and the default
  templates (20).

## Open risks

- A loop that costs a lot per round can spend three rounds before the owner sees it. Evidence:
  the limit is a setting and per workflow; watch the first real runs.
- Agents do not always end with one of the three lines. Evidence: "no verdict" is a value a rule
  can name, and the Path list shows it, so a missing line is visible instead of silent.
- The diagram of a workflow with many rules may be hard to read. Evidence: the screenshot with
  the Initiative template plus two rules; fall back to the rule list, which is always there.

## Decision log
