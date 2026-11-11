---
id: 2026-11-recurring-cards
status: done
rev: 1
supersedes: null
---

# A calendar card that repeats, so a workflow can run on a schedule

## Who and why

Lucas schedules a workflow by putting a card on the calendar: at the card's start the workflow
runs. A card happens once. When he asked the assistant for something that should run every
weekday morning, it had no way to say "every weekday": it made twenty separate cards, one per
day, each to be changed or removed by itself, and the schedule ends when the cards run out.

Work that recurs is the common case for automation: a morning review of open pull requests, a
weekly report, a nightly check. He should be able to say it once.

## Desired outcome

When this is done:

- A card can repeat: every day, on chosen weekdays, every week or every month, with an interval
  ("every second week"), and it ends never, on a date or after a number of times.
- A repeating card is one thing. Changing it changes the schedule; deleting it removes it;
  one Undo puts it back. A single occurrence can be skipped without touching the rest.
- At each occurrence the card's workflow runs, exactly as a single card's does today. Each run is
  its own run, and the calendar shows how each past occurrence went.
- Times stay on the clock: "08:30 on weekdays" is 08:30 before and after a daylight saving change.
- When the app was closed over several occurrences, it does not run them all on start.
- The assistant makes one repeating card when asked for something recurring, and says in the
  change row how it repeats.

## Out of scope

- Moving or editing a single occurrence of a series (other than skipping it).
- Writing repeating items to Outlook, or changing how Outlook's own recurring meetings are shown.
- Cron expressions and schedules finer than a day ("every two hours").
- Repeating event triggers; those already fire on every event.
- Running occurrences at the same time: an occurrence whose previous run is still going is not
  started.

## Open questions

None. The owner asked for the feature and delegated its decisions; they are recorded in the spec.

## Decision log
