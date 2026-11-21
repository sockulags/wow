---
id: 2026-11-unattended-runs
status: draft
rev: 1
supersedes: null
---

# Runs that can be left alone: ready working copies, limits on spending, and a view of how they go

## Who and why

Lucas lets workflow runs and threads work in their own Git working copies while he is in
meetings. Four things still need him there:

- A fresh working copy has no dependencies. The first step spends a turn installing them, or
  fails because they are missing, and every run does it a little differently.
- Once anything is installed, the copy is never removed on its own: `node_modules` is ignored by
  Git, and wow counts every ignored file as something that could be lost. Copies pile up on disk,
  and counting what they hold reads all of `node_modules` (a known gap in 0.3.8). A removal that
  a locked file stops on Windows is not tried again.
- Nothing limits what a run spends. A run that loops within the step limit, or grows its context,
  keeps going until it ends. Cost is shown per turn, after the fact.
- A step whose turn fails on a provider hiccup (a lost connection, a rate limit) fails the run or
  waits for him, although sending the same turn again a minute later would have worked.

He also has no view of how a workflow performs over time: where its runs wait, how long steps
take, how often a step is sent back, and what it costs. So it is guesswork which workflow fits
which kind of work.

## Desired outcome

When this is done:

- A project can name a setup command (for example `pnpm install --frozen-lockfile`) that wow runs
  in each new working copy, for runs and threads, before the first prompt. Its output shows on the
  run or thread, and a failure stops before any turn with the reason.
- Folders that can be made again (`node_modules`, build output) do not keep a working copy alive
  and are not counted file by file. Kept copies can be slimmed, a removal stopped by a locked file
  is tried again, and Settings shows every working copy with its size and what keeps it.
- A run has a cost and token limit, and there is a daily limit across runs. Reaching one stops the
  run at the end of the turn and waits for him, like the step limit does.
- A step turn that fails on an error the provider marks as passing is sent again on its own, a
  set number of times, before the step counts as failed.
- Each workflow shows how its runs went: outcomes, time, cost, attempts and gate waits per step.
- The assistant can read and propose all of these settings like any other.

## Out of scope

- Running commands a repository declares (a `setup` script, a devcontainer). The only command wow
  runs is the setup command the user typed or applied.
- Sharing `node_modules` between working copies.
- Limits on threads started by hand. They keep showing cost as today.
- Retrying a hand thread's turn on its own. It keeps its Retry button.
- Exporting statistics.

## Open questions

- Is a daily limit across runs wanted at all, or only a limit per run? The spec includes both;
  the daily one can be dropped without touching the rest.

## Decision log

- 2026-11-20: written after a first draft built on the 0.1.2 code was dropped; worktrees,
  repeating cards, gate rules and the assistant already exist on `main`, so this intent only
  covers what is still missing there.
