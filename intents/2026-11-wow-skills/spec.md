---
intent: 2026-11-wow-skills
rev: 1
built_on: intent@1
status: accepted
---

# Skills that belong to wow: built in, and my own, picked with a slash and shown as a chip

## Summary

wow gains two sources of skills beside the folders it already reads: skills shipped with the app
and skills the user writes in wow. Both are "wow skills": a name, a description and a text. A wow
skill is not looked up by the provider; wow puts its text into the prompt it sends, so it works
the same on every provider. A workflow step can carry extra skills beside the one it runs, and wow
attaches a built-in skill by itself where the workflow depends on it. The composer picks skills
with `/` and shows a picked skill as a chip.

## Behavior

### Built-in skills

1. wow ships these skills, in a group "wow" in every skill list: `wow-verdict` (end with exactly
   one of the verdict lines a gate or a rule reads), `wow-artifacts` (write each artifact the step
   expects, at the path it expects), `wow-pull-request` (put the `Intent-Unit` line in the pull
   request or merge request body, one per unit), `wow-handover` (end with what was done, what is
   left and what the next step needs).
2. A built-in skill's text is filled in from what wow knows when it is sent: the verdict lines
   from the settings that hold them, the step's expected artifacts, the run's intent id and unit
   key. A value that is not known for this send (no unit, no expected artifacts) leaves its
   sentence out.
3. Built-in skills cannot be edited or removed. A setting lists built-in skills that are switched
   off; a switched-off skill is in no list and is attached nowhere.
4. Built-in skills come with the app version. Nothing is written to the user's skill folders.

### Own skills

5. Settings → Skills has "Your skills": a list with New, Edit and Delete. A skill has a name
   (lower case letters, digits and hyphens, unique among wow skills, not starting with `wow-`), a
   description of when to use it, and a text. Each change can be undone.
6. Own skills are stored by wow under its home folder, one file per skill in the same format as
   other skill files, and are read from there at start and when changed. A file edited or added
   there by hand is picked up like any skill folder.
7. Own skills are in every skill list in a group "Yours", before the other groups.
8. The setup file carries own skills. Starting from a file shows each skill to be added or
   replaced, with its full text reachable in the preview, and one Undo removes them again.
9. A name used by both an own skill and a skill from another folder shows both, each with its
   group; picking one never runs the other.

### Using a wow skill

10. A wow skill (built in or own) picked in chat or run by a workflow step is sent as its text in
    the prompt, marked with its name, on every provider. Skills from other folders are invoked as
    before.
11. A workflow step has "Also follow": zero or more skills, wow skills or others, beside the skill
    it runs. Their texts or invocations are added to the step's prompt after the skill it runs
    and before the extra prompt, in the order listed.
12. wow attaches a built-in skill to a step by itself when the workflow depends on it:
    `wow-verdict` when the step's gate condition or one of its rules reads the verdict;
    `wow-artifacts` when the step has expected artifacts; `wow-pull-request` when the run is for a
    unit of a plan. The builder shows these as attached automatically, with the reason. A setting
    turns automatic attaching off; a step can leave one out.
13. Where wow today adds its own sentence to a prompt for one of these purposes, the built-in
    skill replaces it, so the text exists once. A run stored before this change continues with
    the prompts it had.
14. The thread shows which skills a message or a step was sent with, by name; the skill's text is
    reachable from there and is not shown in full in the conversation.
15. A step naming a skill that no longer exists fails before it starts with a sentence naming the
    skill, as for a missing skill today.

### Composer

16. A skill is picked by typing `/` at the start of the message or after a space. The list shows
    skills with their descriptions, grouped, and filters as the user types. The character is the
    setting `chat.skillTrigger`, `/` by default; `$` no longer opens the list unless the setting
    says so.
17. A picked skill is a chip in the composer: its name with a mark for its group. Backspace
    directly after a chip removes it as one thing; the arrow keys step over it; it can be removed
    with a click.
18. A sent message shows its skills as the same chips. A message stored before this change, with
    the skill as raw text, is shown as it was.
19. Text that merely contains the trigger character (a path such as `src/app`, a date) opens no
    list and becomes no chip. Only a pick from the list makes a chip.
20. The assistant's composer takes no skills: the assistant has its own instruction text.

### Assistant

21. The assistant can read the list of skills with their descriptions, and the text of wow skills.
22. The assistant can propose a new own skill, a change to one or its removal. Each waits for a
    yes; the proposal shows the full text, or what changes. It cannot change built-in skills or
    skills in other folders.
23. The assistant can set a step's "Also follow" as part of changing a workflow, under the rules
    workflow changes already follow.

## Interface

- Decided: (delegated) a wow skill is sent as text, not installed into the providers' folders.
  It behaves the same on both providers and nothing is written outside wow's home.
- Decided: (delegated) four built-in skills (behavior 1); more can come with later versions.
- Decided: (delegated) built-in texts are templates filled from settings and the run (behavior 2),
  so changing a verdict line in Settings changes what agents are told.
- Decided: (delegated) automatic attaching is on by default (behavior 12).
- Decided: (delegated) the trigger character is a setting and defaults to `/` (behavior 16).
- Decided: (delegated) a message stores its skills as structured parts, not as text; old messages
  stay as they are (behavior 18).
- Decided: (delegated) own skills written by the assistant always wait for a yes (behavior 22).
- Left to delivery: the wording of the four built-in texts, the look of the chip and the group
  marks, key bindings, and the names of new settings other than `chat.skillTrigger`.

## Boundaries and non-goals

- No scripts or bundled files in a wow skill.
- No editing of skills in other folders.
- No change to how Claude Code or Codex find and run their own skills.
- No sharing other than the setup file.

## Decisions

- **Text, not installation.** Writing into `~/.claude/skills` and `~/.codex/skills` would put
  wow's files among the user's and need two formats kept in step.
- **One text per purpose.** The verdict, artifacts and unit sentences wow adds today move into
  the built-in skills instead of existing twice.
- **A skill steers agents**, so one the assistant writes is a proposal with its full text shown,
  and a setup file's skills are shown in the preview.
- **A chip is made only by a pick**, never by parsing text, so a slash in a path stays a slash.
- **Old data keeps working.** Stored messages, workflows and runs without the new fields load and
  behave as before.

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Package and server tests cover behaviors 1 to 15 and 21 to 23 with a named case each,
  including: the exact prompt of a step with a wow skill and two "Also follow" skills on Claude
  Code and on Codex; `wow-verdict` attached because of a rule and filled from changed settings; a
  run stored before the change; an own skill made, changed, deleted and undone; a setup file with
  a skill; the assistant's proposal for a skill.
- `pnpm e2e` covers 5, 7, 11, 12 and 16 to 19 against the mock provider: write a skill, pick it
  with `/` as a chip, send it, see the chip in the thread, add it to a step, see `wow-verdict`
  attached by itself.

## Open risks

- A built-in text that agents do not follow is worse than none. Evidence: the texts are short and
  each names one thing to do; the first real runs show whether the verdict line appears.
- A long skill text in every step's prompt costs tokens. Evidence: wow skills are text the user
  can read in Settings; "Also follow" is per step.
- A chip editor in a plain text box is easy to get wrong on the keyboard. Evidence: named cases
  for backspace, arrows and paste in the web tests.

## Decision log
