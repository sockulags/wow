---
intent: 2026-11-recurring-cards
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: A calendar card that repeats, so a workflow can run on a schedule

Execution: two units in order, each by a worker and an independent reviewer. Every unit updates
`docs/architecture.md` for what it changes and leaves the repository checks green.

## Units

- [U1] Repeat rules on the server: occurrences, firing, changing, and the assistant's tools
- [U2] Repeating cards in the calendar, the editor and the guide — depends on U1

### U1 Repeat rules on the server: occurrences, firing, changing, and the assistant's tools

Outcome: a card can carry a repeat rule; the server works out its occurrences in the card's zone,
fires the card's trigger at each one, handles busy and missed occurrences, and lets a card be
edited, skipped for one date, deleted and restored as one thing. The assistant's card tools take
the rule. Cards without a rule behave exactly as before.
Boundaries: no calendar or editor UI beyond what types force (U2). Outlook items untouched. No
schedule finer than a day. Event triggers, plan runs and gates untouched.
Change surface: `packages/contracts` (the rule type, `card.create` and `card.update` carrying it,
a command to skip one occurrence, the card projection with rule, skipped dates, next fire time and
per-occurrence runs, the calendar read returning occurrences for a range), a pure module that
computes occurrences (in `packages/shared` or beside the scheduler), `apps/server/src/scheduler`
(re-arming the card trigger, busy and missed occurrences), the card commands, events, projector
and a migration, `apps/server/src/assistant` (card tools, class table, change rows, instruction
text), settings (`calendar.maxOccurrences`), `docs/architecture.md`.
Acceptance:

- Given a rule "weekly on Monday to Friday" starting on a Wednesday at 08:30 in
  `Europe/Stockholm`, then the occurrences are every weekday at 08:30 local time, before and
  after both daylight saving changes (spec 1, 2).
- Given "monthly" starting on the 31st, then months without a 31st have no occurrence; given an
  interval of two, every second period; given an end by date or by count, nothing after it
  (spec 1, 3).
- Given a card stored before this change, or one made without a rule, then it loads and fires
  once as before (spec 4).
- Given a repeating card with a workflow and a project, when the clock reaches each occurrence,
  then a run starts named with the occurrence's date, and the trigger then shows the next
  occurrence; after the last occurrence nothing fires (spec 5, 6, 9).
- Given an occurrence due while an earlier occurrence's run is running or waiting, then nothing
  starts, the occurrence is recorded as skipped with the reason and a notification is made
  (spec 7).
- Given three occurrences passed while the server was stopped or paused, then with policy `run`
  only the latest starts, with `mark` only the latest is offered "Run now", with `skip` none
  starts, and the older two are recorded as missed (spec 8).
- Given an edit of time, rule or workflow, then occurrences not yet started follow it and past
  occurrences keep their runs; given "skip this occurrence", that date does not fire and the
  rest do; given a delete of the series with a live run, the command needs `stopRun` as for a
  single card (spec 10, 11 as a command, 12, 14).
- Given each of these changes, then one Undo restores the card with its rule, skipped dates and
  trigger (spec 13).
- Given a read of a range that needs more than `calendar.maxOccurrences` occurrences of one card,
  then that many are returned with a mark that there are more (spec 17).
- Given the assistant creates a card with a rule, then one card exists, the change row says the
  rule in words, Undo removes it, and it is a proposal exactly when the next occurrence starts
  within `assistant.startSoonMinutes`; the assistant can skip one occurrence and read the next
  fire time; the instruction text tells it to use one repeating card (spec 18 to 21).

Ground truth: `pnpm --filter @wow/server test` with a named case per acceptance line, the clock
moved by the test; tests of the occurrence module with the daylight saving and month-end cases;
repository checks.
Dependencies: none inside this plan. It builds on the app's cards and card triggers, the missed
trigger policy, and the assistant's server tools.
Evidence and settled decisions: occurrences are computed, not stored; one trigger row per card,
re-armed; local time in the card's zone is the anchor; catch-up runs at most one occurrence; a
busy card skips (spec Interface and Decisions). Today `card.create` takes one start and end, and a
card trigger fires once.
Delivery target: commit on the delivery branch.
Open risks: time zone arithmetic. Use the platform's zone data (`Intl` or the library the server
already uses for zones); do not hand-roll offsets.

### U2 Repeating cards in the calendar, the editor and the guide

Outcome: the calendar shows a repeating card's occurrences, the editor has a Repeat section that
says the rule in words and the next fire time, an occurrence can be skipped or the series deleted
from the calendar, and the user guide explains it.
Boundaries: no change to how the server computes or fires (U1). No single-occurrence exceptions
beyond skip. Outlook items untouched.
Change surface: `apps/web/src/calendar` (drawing occurrences from the range read, the repeating
mark, past occurrences opening their run, move and resize of an occurrence, the delete choice),
the card editor (Repeat section), palette commands and keybinding settings for the new actions,
the Assistant view's change row for a repeating card if it needs more than text,
`apps/web/e2e/calendar.spec.ts` and the e2e server seed, `docs/user-guide.md`,
`docs/architecture.md`, a screenshot `intents/2026-11-recurring-cards/sketches/repeat.png`.
Acceptance:

- Given a card made to repeat on weekdays in the editor, then the editor says the rule in words
  and the next fire time, and the week and the next week each show five occurrences marked as
  repeating (spec 15, 16).
- Given a past occurrence with a run, then it shows the run's state and opens the run; a future
  occurrence opens the card (spec 15).
- Given a drag of an occurrence to another time, then the series from that date on has the new
  time and earlier occurrences stay (spec 11).
- Given Delete on an occurrence, then the app offers "This occurrence" and "The whole series";
  the first removes that one only, the second removes all, and Undo restores either (spec 12, 13).
- Given a range with more occurrences than `calendar.maxOccurrences`, then the view says some are
  not shown (spec 17).
- Given every new action, then it has a palette command, and the common ones a keybinding setting.

Ground truth: `pnpm --filter @wow/web test`; `pnpm e2e` for the calendar spec file with the
cases "a card repeats on weekdays", "skip one occurrence" and "delete the series"; repository
checks.
Dependencies: U1.
Evidence and settled decisions: the UI renders occurrences the server returns and never works
them out from its own clock (project policy); moving an occurrence edits the series from that
date (spec Interface).
Delivery target: commit on the delivery branch.
Open risks: many occurrences in a month view; the limit and its notice cover it.
