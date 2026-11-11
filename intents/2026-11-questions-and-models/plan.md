---
intent: 2026-11-questions-and-models
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: Questions with choices and a free text field in every chat, and an assistant that knows the models

Execution: two units, each by a worker and an independent reviewer. Every unit updates
`docs/architecture.md` for what it changes and leaves the repository checks green.

## Units

- [U1] The question card in every conversation, and the assistant's tool to ask
- [U2] Models for the assistant, guidance, and steps that need a model

### U1 The question card in every conversation, and the assistant's tool to ask

Outcome: every question in wow, from a provider's agent or from the assistant, is one card with
choices and a free text field, answered from the keyboard, and the assistant can ask with it.
Boundaries: no inputs other than choices and text. The providers' protocols are not changed, only
mapped. Nothing about models (U2).
Change surface: `packages/contracts` (the question and answer shapes: several questions, several
picks, typed text), `packages/provider-claude` and `packages/provider-codex` (mapping their
questions and the answer back), the mock provider, `apps/server/src/assistant` (the tool to ask,
the answer as the next message, the secret refusal, the instruction text), `apps/web/src/chat`
(the card, replacing today's question row) and the Assistant view, palette commands and
keybinding settings, `apps/web/e2e`, `docs/user-guide.md`, `docs/architecture.md`, a screenshot
`intents/2026-11-questions-and-models/sketches/question.png`.
Acceptance:

- Given a question with three choices, then the card shows them and a free text field; a choice,
  a typed text, or both can be sent; an empty answer cannot; with "several", more than one choice
  can be picked (spec 1, 2).
- Given an ask with two questions, then both are answered and sent together (spec 3).
- Given the card has focus, then arrows or digits pick, Enter sends and typing lands in the text
  field, and each action is in the palette (spec 4).
- Given an answered question and one whose turn was stopped, then the first shows the answer and
  the second says it was not answered and takes no answer (spec 5).
- Given a question from Claude Code and one from Codex, then each shows its choices and the text
  field, and the adapter sends back exactly the picked choice, the typed text as the provider's
  "other" answer or answer text, or both (spec 6); a run waiting for it is listed as waiting
  (spec 7); a thread stored before the change shows its questions as before (spec 8).
- Given the assistant's tool with one to four questions, then cards appear in the Assistant view,
  the turn ends, and the answer arrives in the assistant's next turn marked as the answer
  (spec 9); a typed answer that looks like a secret is held (spec 10); a question asking for a
  token or password is refused with the sentence pointing to the secret field (spec 11); the
  instruction text names the tool (spec 12).

Ground truth: `pnpm --filter @wow/provider-claude test`, `pnpm --filter @wow/provider-codex test`,
`pnpm --filter @wow/server test`, `pnpm --filter @wow/web test`; `pnpm e2e` for "answer a question
with a choice and with text" in a chat thread and in the Assistant view; repository checks.
Dependencies: none inside this plan. It builds on the question events of the providers and the
assistant's server tools and view.
Evidence and settled decisions: the assistant's question ends its turn and the answer is the next
message; every question has a free text field (spec Interface). Today a provider question is a
`questionAsked` event with options and `answerQuestion` takes one answer.
Delivery target: commit on the delivery branch.
Open risks: what each provider accepts as a free text answer; fix it in adapter tests and add a
line to `docs/windows-smoke.md` to check with the real providers.

### U2 Models for the assistant, guidance, and steps that need a model

Outcome: the assistant reads each provider's models and wow's guidance, writes workflows whose
steps each name a provider, model and effort the provider offers, and the server refuses a step
without a model its provider requires.
Boundaries: no model facts from the internet. The question card is U1's. No change to how a
thread picks its model.
Change surface: `packages/contracts` (whether a provider kind requires a model, the guidance
setting, the tools' shapes), the provider adapters (that fact), `apps/server/src/assistant` (the
tools to read models and guidance, the refusal of a model the instance does not offer, change
rows showing model and effort, the instruction text), `apps/server/src/core/workflows.ts` (the
refusal and the default), `apps/server/src/setup` and the diagnosis (the mark), the workflow
builder (the lists, the default mark, the refusal), `apps/web/e2e`, `docs/user-guide.md`,
`docs/architecture.md`.
Acceptance:

- Given two connected instances and one not connected, then the tool lists each connected one's
  models, efforts, defaults and whether a model is required, and the third as not connected
  (spec 13).
- Given the guidance setting, then the tool returns it, and an edited text is what the assistant
  reads next (spec 14).
- Given the assistant creates a workflow, then each step has an instance, a model and an effort
  the instance offers and the change row shows them; a model the instance does not offer is
  refused with the offered list; the instruction text says to give the reason and when to ask
  (spec 15, 16).
- Given a step on Codex without a model, then with an instance default it is saved with that
  default, and without one `workflow.create` and `update` are refused naming the step and the
  provider; a step on Claude Code without a model is saved as before (spec 17).
- Given the builder, then a step shows its instance's models and efforts with the default
  marked, and the refusal in words (spec 18).
- Given a workflow stored before this change with a Codex step without a model, then it loads and
  runs as before, the builder marks the step and the diagnosis names it; a setup file with such a
  step is applied with the step marked (spec 19, 20).

Ground truth: `pnpm --filter @wow/server test` with a named case per acceptance line;
`pnpm --filter @wow/web test`; `pnpm e2e` for "a workflow made by the assistant shows each step's
model" and the builder's refusal; repository checks.
Dependencies: none inside this plan; it can follow U1 so the assistant can ask about a model.
Evidence and settled decisions: guidance is a shipped, editable text; requiring a model is a fact
of the adapter, true for Codex (spec Interface). Today `listModels` returns each model with its
efforts, and instances have a default model and effort.
Delivery target: commit on the delivery branch.
Open risks: an instance whose model list cannot be read (signed out); list it as not connected
and let the assistant say so.
