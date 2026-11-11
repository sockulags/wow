---
intent: 2026-11-questions-and-models
rev: 2
built_on: intent@1
status: accepted
---

# Questions with choices and a free text field in every chat, and an assistant that knows the models

## Summary

One question card serves every conversation: a question, its choices, and always a free text
field. The assistant gets a tool to ask with it. Questions the providers' agents ask are shown
with it. The assistant also gets tools to read each provider's models and wow's guidance on
choosing one, and the server refuses a workflow step that lacks a model its provider requires.

## Behavior

### The question card

1. A question has a text, a short header of a word or two shown as a chip, zero or more choices
   (each a label and an optional description), and whether several may be picked. The card always
   has a free text field, shown as a last choice "Other" that takes the typed text. A choice the
   asker recommends is listed first and marked as recommended.
2. The answer is the picked choices, the typed text, or both. With no choices the card is the
   free text field alone. An empty answer cannot be sent.
3. One ask may hold several questions; they are answered together, each with its own choices and
   text field.
4. The card is used from the keyboard: the arrow keys or the digit keys pick, Enter sends, and
   typing goes to the text field. Each action has a palette command.
5. An answered question stays in the conversation showing what was asked and what was answered.
   A question that was not answered when its turn ended or was stopped shows that, and can no
   longer be answered.

### In chat threads and workflow steps

6. A question asked by an agent on Claude Code or Codex is shown with the card, with the choices
   the provider gave and the free text field. The answer goes back to the provider as its own
   protocol expects; typed text is sent as the provider's "other" answer where it has one, and as
   the answer text where it has not.
7. A run whose step is waiting for an answer says so where runs are listed, as it does today.
8. A thread stored before this change shows its old questions and answers as it did.

### The assistant asks

9. The assistant has a tool to ask: one to four questions as in 1 to 3. The questions appear as
   cards in the Assistant view and the assistant's turn ends there. The answer reaches the
   assistant as the user's next message, marked as the answer to those questions.
10. A typed answer goes through the same check a typed message does: text that looks like a
    secret is held with the same choices.
11. The assistant never asks for a secret with this tool; the tool refuses a question whose
    choices or text ask for a token, password or key and says to show the secret field instead.
    (It matches the words wow's secret patterns and settings already use; it is a net, not a
    proof.)
12. The assistant's instruction text says to ask with this tool when a few answers are likely,
    and to ask one thing at a time unless the questions belong together.

### Models

13. The assistant has a tool that reads, per connected provider instance: the models it offers,
    the efforts each takes, the instance's default model and effort, and whether the provider
    requires a model on a step. A provider that is not connected is listed as such with no
    models.
14. wow ships a guidance text on choosing a model and an effort per kind of work (planning and
    specification, building, reviewing, mechanical steps) for each provider kind. It is a
    setting, so it can be edited, and the assistant has a tool to read it. It names kinds of
    model, and the assistant matches it against what the instance actually offers.
15. When the assistant creates or changes a workflow, every step it writes names a provider
    instance, a model and an effort from what that instance offers. The change row or proposal
    shows each step's model and effort. Its instruction text says to state what it recommends
    and why in a sentence, and to ask (behavior 9) when two choices differ in a way the user
    would care about, such as cost against quality.
16. The assistant recommends from the guidance and the list, not from memory: a model that the
    instance does not offer is refused by the tool with the list of what it does offer.

### Steps that need a model

17. A workflow step on a provider that requires a model cannot be created or changed to have
    none: the command is refused with a sentence naming the step and the provider. Where the
    instance has a default model, a step saved without one takes that default and the builder
    shows it.
18. The builder shows, for each step, the models and efforts its provider instance offers, marks
    the instance's default, and shows the refusal in words beside the step.
19. A workflow stored before this change with such a step still loads and runs as it did; the
    builder marks the step, and the diagnosis names it as something to fix.
20. A setup file with such a step is applied with the step marked, as for a missing skill.

## Interface

- Decided: (delegated) the assistant's question ends its turn and the answer arrives as the next
  message (behavior 9), not as the tool's result. A tool call that waits for a person can time
  out; a message cannot.
- Decided: (delegated) every question has a free text field, also the providers' own
  (behavior 1, 6).
- Decided: (delegated) guidance is a text shipped with the app and editable as a setting
  (behavior 14). wow does not fetch model facts from the internet.
- Decided: (delegated) which providers require a model is a fact of the provider adapter
  (behavior 13): Codex does, Claude Code does not.
- Left to delivery: the wording of the guidance text, the look of the card, key bindings, and the
  names of the tools and settings.

## Boundaries and non-goals

- No dates, files or other inputs in a question.
- No change to the providers' own question protocols.
- No model prices or limits from outside wow.
- The assistant's secret rule is unchanged: a question never collects a secret.

## Decisions

- **One card everywhere**, so answering feels the same in the assistant, a chat and a step.
- **Free text is always there**, because the listed choices are a guess at what the user wants.
- **The server refuses a step without a required model**, so the rule holds for the builder, the
  assistant and a setup file alike.
- **Recommendations come from wow's guidance and the provider's own list**, so they stay true
  when models change and can be corrected by the owner.
- **Old data keeps working.**

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Adapter tests for Claude Code and Codex cover behavior 6: a question with choices answered by a
  choice, by text, and by both, with the exact answer sent back.
- Server tests cover 9 to 11, 13, 14, 16, 17, 19 and 20 with a named case each.
- `pnpm e2e` covers 1 to 5 in a chat thread and in the Assistant view against the mock provider,
  15 (a workflow made by the assistant shows each step's model) and 18.

## Open risks

- A provider's question protocol may not take free text for a question with choices. Evidence:
  the adapter tests fix what is sent; where a provider has no "other" answer the text is sent as
  the answer and the smoke list checks it with the real provider.
- Guidance goes stale when providers release models. Evidence: it is a setting, the list comes
  from the installed provider, and the tool refuses a model the instance does not offer.

## Decision log

- rev 2: the owner asked for the card to work like the question dialog of the coding agent he
  uses: a header chip per question, a recommended choice first, and free text as a last choice
  "Other" (behavior 1).
