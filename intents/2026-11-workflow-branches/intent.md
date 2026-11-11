---
id: 2026-11-workflow-branches
status: done
rev: 1
supersedes: null
---

# Workflows that take different paths depending on how a step went

## Who and why

A workflow in wow is a straight chain: step one, then step two, then step three. Real work is not
straight. A review that finds problems should send the work back to the step that built it, not on
to the next step. A small change should skip the planning steps a large one needs. A failed build
should start a fix, not stop the run.

Today Lucas does all of this by hand. When `check-work` ends with `CHANGES_REQUESTED`, the run
either waits for him at a gate or carries on as if nothing happened, and he sends the work back
himself. That is the most common reason a run needs him, and it is the one he least needs to be
there for: the reviewer has already written what is wrong.

The review loop (`2026-11-review-loop`) gives a gate a condition that lets it pass by itself. This
intent uses the same conditions to decide where a run goes next, so that the common loops close
without him and he is called only when they do not.

The owner called this a very important function on 2026-11-10 and asked the agent to capture it
while he was away. The open questions below are his to answer.

## Desired outcome

When this is done:

- After a step, a workflow can go to different steps depending on how the step went: the verdict
  it ended with, whether the pull request's checks passed, whether the expected files exist, or
  whether the step failed.
- A workflow can go back to an earlier step, carrying what the later step said, so that deliver
  and review repeat until the review approves. Every such loop has a limit on how many times it
  may go round; at the limit the run stops and waits for Lucas with the reason.
- A workflow can skip steps when a condition holds, so one workflow serves both a small fix and a
  larger change.
- Lucas builds this in the workflow builder without drawing a graph: on a step he says "when this,
  go to that step", and the builder shows the paths so he can see where a run can go.
- A run shows the path it actually took: which steps ran, in which order, how many times, and why
  each choice was made.
- Every choice is made from facts wow already has. No model is asked which way to go.
- Gates work as before on every path. The gates at plan and spec always stop, whichever path led
  there.
- Workflows that exist keep working as straight chains without any change.
- The templates get the common loop built in: review sends back to delivery until approved, at
  most a set number of times.

## Out of scope

- Steps that run at the same time. A run is still in one step at a time; running units in parallel
  stays with `batch-work`.
- A free-form graph editor with boxes and arrows. The builder stays a list of steps with rules on
  them.
- Conditions written as code or expressions. A condition is chosen from the facts wow knows.
- A step that decides the path by asking a model. The agent's own answer can decide it only
  through a fixed last line, as the verdict does today.
- Workflows that call other workflows.

## Open questions

- Besides the verdict, checks, files and failure, is there a fact you want to branch on, such as
  the size of the change, the ticket's type, or a word the agent ends its answer with?
- When a loop reaches its limit, should the run wait for you (recommended), stop as failed, or go
  on to a step you name?
- Should a failed step be able to continue down a path of its own, such as "on failure, run
  diagnose-before-fix", or should a failure always end the run as it does today?
- Should the app assistant be allowed to add or change branches, and if so, does that count as a
  change that waits for your yes, like permission modes and gates that pass by themselves?

## Decision log
