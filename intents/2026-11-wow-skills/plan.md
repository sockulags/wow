---
intent: 2026-11-wow-skills
rev: 1
built_on: spec@1
status: done
source: files
---

# Plan: Skills that belong to wow: built in, and my own, picked with a slash and shown as a chip

Execution: three units in order, each by a worker and an independent reviewer. Every unit updates
`docs/architecture.md` for what it changes and leaves the repository checks green.

## Units

- [U1] wow skills on the server: built in, own, sent as text, attached to steps
- [U2] Your skills in Settings, "Also follow" in the builder, the setup file and the assistant — depends on U1
- [U3] Skills with a slash and as chips in the composer and the thread — depends on U1

### U1 wow skills on the server: built in, own, sent as text, attached to steps

Outcome: the server knows two new sources of skills, the four built-in ones and the user's own
under wow's home, lists them in their groups, sends a wow skill as its text on every provider,
lets a step carry "Also follow" skills, attaches built-in skills where the workflow depends on
them, and stores which skills a message or step was sent with.
Boundaries: no Settings page, builder or composer changes beyond what types force (U2, U3). No
installation into the providers' folders. Skills from other folders are invoked as before.
Change surface: `packages/skills` (the built-in skills as files shipped with the package, the
"wow" and "Yours" roots, the template fill), `packages/contracts` (the skill's source and group,
commands to create, update and delete an own skill with Undo, `WorkflowStep.alsoFollow`, skills
as structured parts of a message, the settings), `packages/workflow-engine` and
`apps/server/src/workflows` (the step prompt, automatic attaching, replacing the sentences wow
adds today), `apps/server/src/core` (sending a message with skills, the missing-skill refusal),
a migration if stored shapes change, `docs/architecture.md`.
Acceptance:

- Given a fresh install, then the skill list has `wow-verdict`, `wow-artifacts`,
  `wow-pull-request` and `wow-handover` in a group "wow", and none of them can be changed or
  deleted; given one named in the switch-off setting, then it is in no list and attached nowhere
  (spec 1, 3, 4).
- Given changed verdict line settings, a step with two expected artifacts and a run for unit U2 of
  an intent, then the texts sent name those lines, those paths and that `Intent-Unit` line; given
  a send without a unit, the unit sentence is left out (spec 2).
- Given an own skill created by command, then a file exists under wow's home in the skill file
  format, the skill is listed in "Yours" before other groups, an invalid or taken name or one
  starting with `wow-` is refused with the reason, update and delete work, each is undone by
  Undo, and a file added there by hand is listed after a refresh (spec 5 as commands, 6, 7).
- Given an own skill and a folder skill with the same name, then both are listed with their
  groups and running one sends only that one (spec 9).
- Given a step that runs a wow skill and also follows one wow skill and one folder skill, then
  the prompt sent to Claude Code and to Codex is exactly: the skill's text marked with its name,
  the other wow skill's text, the folder skill's invocation for that provider, then the extra
  prompt (spec 10, 11).
- Given a step whose rule reads the verdict, one with expected artifacts and a run for a unit,
  then the built-in skills are attached with the reason; with the setting off or the step leaving
  one out, they are not; the sentence wow added before is not sent as well (spec 12, 13).
- Given a run stored before this change, then it continues with the prompts it had; a workflow
  without `alsoFollow` loads (spec 13).
- Given a message or step sent with skills, then the stored item names them and the text is
  reachable; given a step naming a skill that is gone, then it fails before starting with the
  skill's name (spec 14, 15).

Ground truth: `pnpm --filter @wow/skills test`, `pnpm --filter @wow/workflow-engine test`,
`pnpm --filter @wow/server test` with a named case per acceptance line; repository checks.
Dependencies: none inside this plan. It builds on the skill scan, workflow steps and handover, the
verdict lines, expected artifacts and plan runs.
Evidence and settled decisions: a wow skill is sent as text; four built-in skills; texts are
templates filled from settings and the run; automatic attaching is on by default (spec Interface
and Decisions). Today skills come from `skills.directories` and are invoked as `/<name>` on Claude
Code and `$<name>` on Codex.
Delivery target: commit on the delivery branch.
Open risks: the sentences wow adds today may be spread over the engine and the server; find each
before replacing it, and keep old runs on their stored prompts.

### U2 Your skills in Settings, "Also follow" in the builder, the setup file and the assistant

Outcome: the user writes, changes and removes own skills in Settings → Skills, gives a step extra
skills in the builder and sees what wow attached, the setup file carries own skills, and the
assistant can read skills and propose own ones.
Boundaries: no composer changes (U3). No editing of built-in skills or skills in other folders.
Change surface: `apps/web/src/settings` (Your skills: list, editor, delete with Undo), the
workflow builder (Also follow, the automatically attached marks), palette commands and keybinding
settings, `apps/server/src/setup` (own skills in the file, the preview with full text),
`apps/server/src/assistant` (read tools, proposals for own skills, the class table, change rows),
the Assistant view's proposal card if a skill's text needs more than existing rows show,
`apps/web/e2e`, `docs/user-guide.md`, `docs/architecture.md`, a screenshot
`intents/2026-11-wow-skills/sketches/your-skills.png`.
Acceptance:

- Given Settings → Skills, then New, Edit and Delete work on own skills with the name rule's
  reason shown when refused, each can be undone, and built-in skills are listed read-only with
  their text (spec 3, 5).
- Given the builder, then a step's "Also follow" adds and removes skills from every group, and a
  step whose rule reads the verdict shows `wow-verdict` as attached automatically with the reason
  and a way to leave it out (spec 11, 12).
- Given Save setup, then the file holds own skills; given a file with a skill, then the preview
  lists it as added or replaced with its full text reachable, Apply writes it and one Undo
  removes it (spec 8).
- Given the assistant, then it can list skills, read a wow skill's text, and a new, changed or
  removed own skill is a proposal showing the full text or the change; a built-in skill or one
  from another folder is refused; setting "Also follow" follows the workflow rules (spec 21 to
  23).
- Given every new action, then it has a palette command.

Ground truth: `pnpm --filter @wow/web test`; `pnpm --filter @wow/server test` for the setup file
and the assistant; `pnpm e2e` for "write a skill and add it to a step" and "wow-verdict is
attached by itself"; repository checks.
Dependencies: U1.
Evidence and settled decisions: a skill steers agents, so the assistant's are proposals and a
file's are shown in the preview (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: a long skill text in a proposal card; show it in full on request as setup previews
do.

### U3 Skills with a slash and as chips in the composer and the thread

Outcome: the composer opens the skill list on `/`, a picked skill is a chip there and in the sent
message, and old messages look as they did.
Boundaries: no change to which skills exist or how they are sent (U1). The assistant's composer
takes no skills.
Change surface: `apps/web/src/chat` (the composer's trigger, list and chips, the message row),
the setting `chat.skillTrigger`, the starters under the new-thread view if they insert skills as
text today, `apps/web/e2e/chat.spec.ts`, `docs/user-guide.md` (every place that says `$`),
`docs/architecture.md`, a screenshot `intents/2026-11-wow-skills/sketches/skill-chip.png`.
Acceptance:

- Given `/` typed at the start or after a space, then the grouped list opens and filters; given
  `$`, nothing opens; given `chat.skillTrigger` set to `$`, the reverse (spec 16).
- Given a pick, then the composer shows a chip; Backspace after it removes it whole, the arrow
  keys step over it, a click removes it, and pasted text with a slash makes no chip (spec 17,
  19).
- Given a send, then the message carries the skill as a structured part, the thread shows the
  chip, and the agent received the skill as U1 sends it (spec 18).
- Given a message stored before this change with `$name` in its text, then it is shown as it was
  (spec 18).
- Given `src/app` or `2026/11/12` typed in a sentence, then no list opens (spec 19).
- Given the Assistant view, then its composer opens no skill list (spec 20).

Ground truth: `pnpm --filter @wow/web test` with named cases for backspace, arrows, paste and the
old message; `pnpm e2e` for "pick a skill with a slash, see the chip, send it"; repository checks.
Dependencies: U1.
Evidence and settled decisions: a chip is made only by a pick; the trigger is a setting,
default `/` (spec Interface and Decisions).
Delivery target: commit on the delivery branch.
Open risks: caret handling around chips in the browser; keep the composer a plain text box with
chips held beside the text if an editable rich box proves fragile, as long as the acceptance
lines hold.
