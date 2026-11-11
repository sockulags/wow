---
intent: 2026-11-recurring-cards
rev: 1
built_on: intent@1
status: accepted
---

# A calendar card that repeats, so a workflow can run on a schedule

## Summary

A card gains an optional repeat rule. The card is still one row: its occurrences are worked out
from the rule, never stored one by one. The scheduler fires the card's trigger at each occurrence
and then waits for the next. The calendar draws the occurrences that fall in the range it shows.
The assistant's card tools take the rule, so "every weekday at 08:30" is one change.

## Behavior

### The rule

1. A card may carry a repeat rule: a frequency (`daily`, `weekly`, `monthly`), an interval of one
   or more, for `weekly` the weekdays it falls on (one or more; the start's weekday when none is
   given), and an end: never, on a date (inclusive), or after a count of occurrences.
2. The card's start and end are its first occurrence. Every later occurrence has the same local
   start time and the same length in the card's zone. A local time that does not exist on a day
   (the hour skipped when clocks go forward) moves to the first time after it that exists; a local
   time that happens twice uses the first.
3. `monthly` falls on the start's day of the month. A month without that day (the 31st in April)
   has no occurrence.
4. A card without a rule behaves exactly as before, and cards stored before this change have no
   rule.

### Running

5. A repeating card with a workflow and a project runs the workflow at each occurrence's start, as
   a single card does at its start. Each occurrence's run is its own run, named with the
   occurrence's date.
6. After an occurrence fires, is skipped or is missed, the card's trigger waits for the next
   occurrence. After the last one the card is finished and nothing more fires.
7. When an occurrence is due and the run of an earlier occurrence of the same card is still
   running or waiting, the occurrence starts nothing. It is recorded as skipped with the reason,
   and a notification says so.
8. When the app was not running, or was paused, over one or more occurrences: only the most
   recent missed occurrence follows the missed-trigger policy that single cards follow (`run`,
   `mark`, `skip`). Older ones are recorded as missed and start nothing.
9. The trigger list and the card show when the card fires next.

### Changing

10. Editing a repeating card (title, time, length, zone, project, workflow, body, the rule)
    changes every occurrence that has not started. Occurrences that already ran keep their runs
    and stay where they were.
11. Moving or resizing an occurrence in the calendar asks nothing: it changes the time or length
    of the series from that occurrence's date on, as an edit does. Past occurrences stay.
12. Deleting offers "This occurrence" and "The whole series". "This occurrence" records the date
    as skipped; the rest is untouched. "The whole series" deletes the card; when a run of it is
    running or waiting, the app asks whether to stop it first, as for a single card.
13. A single Undo reverses each of these, including a deleted series with its skipped dates.
14. Turning a single card into a repeating one, or back, is an edit of the rule.

### Seeing

15. The calendar draws every occurrence in the visible range, marked as repeating. A past
    occurrence shows the state of its run (done, failed, missed, skipped) and opens that run. A
    future occurrence opens the card.
16. The card's editor has a Repeat section: frequency, interval, weekdays, end. It says in words
    what the rule means ("Every weekday at 08:30, until 19 December") and when it fires next.
17. Reading a range never expands more than `calendar.maxOccurrences` occurrences of one card; a
    range that would need more shows the first ones and says so.

### Assistant

18. The assistant's tools for creating and changing a card take the repeat rule. A repeating card
    is one change row, which says how it repeats, and its Undo removes or restores the whole
    series.
19. The assistant's instruction text says to make one repeating card for anything recurring and
    never a card per day.
20. Whether creating or changing a repeating card waits for a yes follows the rule single cards
    follow: it is a proposal when the next occurrence starts within `assistant.startSoonMinutes`,
    and an ordinary change otherwise.
21. The assistant can skip one occurrence and can read when a card fires next.

## Interface

- Decided: (delegated) the rule is a small structure of wow's own (frequency, interval, weekdays,
  end), not an iCalendar RRULE string. It covers the intent and can be shown in words; an RRULE
  could be accepted later without changing what is stored.
- Decided: (delegated) occurrences are computed, not stored. What is stored per card: the rule,
  the dates skipped by hand, and per fired occurrence the run it started.
- Decided: (delegated) one trigger row per card, re-armed after each occurrence, so the scheduler
  and the trigger list keep their shape.
- Decided: (delegated) moving one occurrence changes the series from that date on (behavior 11);
  a true single-occurrence exception is out of scope.
- Decided: (delegated) catching up runs at most one occurrence (behavior 8).
- Decided: (delegated) a busy card skips, it does not queue (behavior 7).
- Left to delivery: the wording of the rule in words, the look of the repeating mark, key
  bindings, and the names of new settings other than `calendar.maxOccurrences`.

## Boundaries and non-goals

- Outlook items stay read-only; Outlook's recurring meetings are shown as Outlook gives them.
- No schedule finer than a day, no cron syntax.
- No per-occurrence title, body, workflow or time other than through behavior 11.
- Event triggers, plan runs and gates are untouched.
- The setup file still carries no cards.

## Decisions

- **Local time is the anchor.** The rule is evaluated in the card's zone so a schedule keeps its
  clock time across daylight saving changes. The server's clock, not the window's, decides what
  is due.
- **A series is one aggregate.** One card id, one Undo, one change row. Twenty cards were the
  problem this intent removes.
- **Catch-up is bounded.** After a week away the owner wants the latest report, not seven.
- **No overlap.** Two runs of the same recurring workflow in one project folder would work on the
  same files.
- **Old data keeps working.** Cards and stored events without a rule load and behave as before.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Server tests with a moved clock cover behaviors 1 to 14 with a named case each, including: a
  weekday rule across a daylight saving change in `Europe/Stockholm`; monthly on the 31st; an end
  by count and by date; a busy card; three missed occurrences with each missed-trigger policy; a
  card stored before the change; Undo of a deleted series.
- `pnpm e2e` covers 15, 16 and 12 against the mock provider: make a card repeat on weekdays, see
  its occurrences in the week and the next week, skip one, delete the series.
- Server tests cover the assistant's tools (18, 20, 21) and the instruction text (19).

## Open risks

- A rule the owner did not mean (every day instead of every weekday) starts unattended runs until
  noticed. Evidence: the editor and the change row say the rule in words and show the next fire
  time; the first occurrence within `assistant.startSoonMinutes` waits for a yes.
- Daylight saving and month-end arithmetic is easy to get wrong. Evidence: named cases in the
  ground truth, computed in the card's zone with the platform's own time zone data.
- Long-running workflows on a daily rule skip often. Evidence: each skip is a notification, and
  the card shows skipped occurrences.

## Decision log
