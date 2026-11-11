---
id: 2026-11-questions-and-models
status: done
rev: 1
supersedes: null
---

# Questions with choices and a free text field in every chat, and an assistant that knows the models

## Who and why

Lucas sets wow up by talking to the assistant, and works with agents in chat threads. Two things
slow that down.

When the assistant or an agent needs a decision from him, it asks in prose and he types a
sentence back. Most such questions have a few likely answers. He wants to pick one, or write his
own when none fits, in the assistant and in every chat.

When the assistant builds a workflow it does not know which models each connected agent offers,
so it leaves the model out or guesses. Codex needs a model chosen; a step without one does not
run well. He wants the assistant to know the models and efforts each provider offers, recommend
one per step and say why, and never leave a step without what its provider requires.

## Desired outcome

When this is done:

- The assistant can ask a question with a short list of choices. Every such question also has a
  free text field. Lucas answers with a click or a few keys.
- A question an agent asks in any chat thread or workflow step is shown the same way: its
  choices, and a free text field, whichever provider asked.
- The assistant can read which models and efforts each connected provider offers, and what wow
  recommends for kinds of work (planning, building, reviewing, mechanical steps).
- When the assistant creates or changes a workflow, each step gets a provider, a model and an
  effort that the provider offers. Where it recommends, it says what and why; where the choice
  matters and is not obvious, it asks.
- A step on a provider that requires a model cannot be saved without one, by anyone.

## Out of scope

- Fetching model lists or prices from the internet. wow knows what the installed providers
  report and a guidance text that ships with the app and can be edited.
- Changing how the providers themselves ask questions.
- Forms with more than choices and text (dates, files, sliders).

## Open questions

None. The owner asked for both and delegated the decisions; they are recorded in the spec.

## Decision log
