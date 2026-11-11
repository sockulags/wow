---
intent: 2026-11-app-assistant
rev: 1
built_on: spec@1
status: done
source: files
---

# Plan: An assistant in wow that runs the app from what I say and never sees a secret

Execution: six units in order, each by a worker and an independent reviewer, on the delivery
branch after the review loop and workflow branches, which they build on. Every unit updates
`docs/architecture.md` for what it changes and leaves the repository checks green.

## Units

- [U1] Assistant tools on the server: read, change, propose, undo
- [U2] The assistant thread on Claude Code and Codex — depends on U1
- [U3] The Assistant view: change rows, proposals and secret fields — depends on U1, U2
- [U4] Token guides and diagnosis — depends on U1, U3
- [U5] A setup file to save and start from — depends on U1
- [U6] First start, end-to-end coverage and the guide — depends on U3, U4, U5

### U1 Assistant tools on the server: read, change, propose, undo

Outcome: the wow server offers the assistant's tools as one MCP server on its local port, behind
a token of its own. Through them a caller reads the app's state without any secret value, makes
ordinary changes that can be undone, and leaves proposals that only the user can accept. Gate
commands are refused.
Boundaries: no provider wiring (U2) and no view (U3). No token guides or diagnosis tool (U4). No
setup file (U5). The tools send the commands the views send; they add no other path into the
store. No tool returns thread messages or file content.
Change surface: a new `apps/server/src/assistant` (MCP endpoint, tool list, state readers, the
class table, proposals, undo), `packages/contracts` (assistant change, proposal and undo types;
commands `assistant.proposal.accept|decline`, `assistant.undo`; topics), `apps/server/src/core`
(origin on commands, decisions for proposals and undo), `db/schema.ts` and a migration, settings
(`assistant.providerInstanceId`, `assistant.model`, `assistant.effort`,
`assistant.secretPatterns`).
Acceptance:

- Given the endpoint without the assistant's token, then every request is refused (spec 2).
- Given the read tools, then they return settings with description and source, projects with
  folder, remote and host, provider instances with sign-in state, workflows, templates, skills,
  cards and meeting times and titles, backlog items, runs and plan runs with state, triggers,
  notifications and connection test results (spec 4).
- Given a stored secret holding a marked value, when every read tool is called, then no result,
  stored event or log line contains the value, and each secret shows only set or not set
  (spec 5, 18).
- Given the tool list, then no tool returns a thread's messages or a file's content (spec 6).
- Given an ordinary change (a calendar setting, a card, a backlog item, a tracker host), when its
  tool is called, then the same command a view sends is applied and an assistant change is stored
  with what changed, from what to what, and its place (spec 7, 13, 20).
- Given `assistant.undo` for a change, then the inverse is applied and the change is marked
  undone; given the thing changed again since, then undo is refused with what changed (spec 8).
- Given a change in the proposal class (a step's permission mode, a gate condition, step rules,
  an event trigger, "for units", "own working copy", the settings named in spec 9), when its tool
  is called, then nothing changes and a proposal is stored; `assistant.proposal.accept` with the
  user's origin applies it; the same command with the assistant's origin is refused (spec 9).
- Given the start-run tool, then a proposal "Start <workflow> in <project>" is stored and the run
  starts only on the user's accept (spec 10).
- Given `workflowRun.continue`, `sendBack` or `stop` from the assistant's origin, then the server
  refuses, and no tool offers them (spec 11).
- Given a command the app refuses, then the tool result carries the app's reason (spec 12).
- Given every server command type, then the class table names it ordinary, proposal or refused,
  and a test fails when a new command has no class.

Ground truth: `pnpm --filter @wow/server test` with a case per acceptance line, including the
marked-secret search and the table's completeness; `pnpm --filter @wow/contracts test`;
repository checks.
Dependencies: none inside this plan.
Evidence and settled decisions: the tools are one MCP server inside the wow server; the server
decides what waits for a yes from one class table; undo is the recorded inverse (spec Decisions).
Secret settings already store a reference `{secretRef}` and never the value.
Delivery target: commit on the delivery branch.
Open risks: an MCP library adds a dependency; prefer the official SDK and say its size. Commands
have no origin today; adding one must leave every existing caller as the user.

### U2 The assistant thread on Claude Code and Codex

Outcome: one assistant thread exists per install, run by the configured provider instance. Its
agent gets the wow tools and no file, shell or network tool, an instruction text that says what it
is for, and an empty folder of the app as its working folder.
Boundaries: provider-specific wiring stays inside `packages/provider-claude` and
`packages/provider-codex`; orchestration sees only a normalized option on `startTurn`. No view
(U3). Ordinary threads and workflow steps are unchanged.
Change surface: `packages/contracts` (`ProviderCommand.startTurn` gains an optional toolset and
instructions; the thread gains a kind), both adapters and the mock adapter,
`apps/server/src/providers` and `apps/server/src/assistant` (creating and finding the thread, the
instruction text as a setting `assistant.instructions`, the empty folder under the wow home).
Acceptance:

- Given a connected instance, when the assistant thread is asked for, then it exists once, uses
  `assistant.providerInstanceId` or the first connected instance, and is found again after a
  restart (spec 1).
- Given the assistant's turn on Claude, then the options sent name the wow MCP server, allow only
  its tools, load no user or project settings, and use the app's empty folder (spec 2).
- Given the assistant's turn on Codex, then the thread is started with the wow MCP server, a
  read-only sandbox without network, and the app's empty folder (spec 2).
- Given an ordinary thread or a workflow step, then the options sent are exactly as before.
- Given the instruction text, then it says the assistant operates wow only, never asks for a
  secret, and sends other work to the chat view (spec 3); it is a setting.
- Given the provider instance is removed or its test fails, then the assistant thread says so
  and no turn starts (spec 27).
- Given the thread list of the chat view, then the assistant thread is not in it.

Ground truth: `pnpm --filter @wow/provider-claude test` and `pnpm --filter @wow/provider-codex
test` asserting the options sent for an assistant turn and for an ordinary turn;
`pnpm --filter @wow/server test`; repository checks.
Dependencies: U1 for the endpoint and its token.
Evidence and settled decisions: each adapter hands the MCP server to its agent with every other
tool off (spec Decisions). The Claude adapter builds Agent SDK options in `#options`; the Codex
adapter starts threads with `thread/start` settings.
Delivery target: commit on the delivery branch.
Open risks: the installed Codex version may name MCP servers differently in its protocol; use the
generated protocol types the adapter already checks against and fail the assistant with a clear
sentence when the option is missing.

### U3 The Assistant view: change rows, proposals and secret fields

Outcome: a sidebar section Assistant shows the conversation with the assistant. Changes it made
show as rows with Undo, proposals as cards with Yes and No, and a needed secret as a field whose
value goes straight to the secret store. A message that looks like a secret is held before it is
sent.
Boundaries: no token guide text or diagnosis (U4), no setup file (U5), no first-start step (U6).
The conversation reuses the chat view's components; do not fork them. Do not restyle
`components/ui`.
Change surface: `apps/web/src/assistant` (route, view, rows, cards, the held-message check),
`apps/web/src/app/sections.ts`, palette commands and keybinding settings
(`keybindings.goAssistant`), `packages/contracts` (a tool the assistant calls to ask for a secret
field; the pattern check shared with the server), `apps/server/src/assistant` (redacting stored
tool results).
Acceptance:

- Given the Assistant section, then it shows the one conversation with a composer and opens by
  palette and key (spec 1).
- Given an assistant change, then a row shows what changed, from what to what and a link to its
  place, with Undo; after Undo it shows "Undone"; a refused Undo shows the reason (spec 7, 8, 20).
- Given a proposal, then a card lists the exact changes with Yes and No; Yes applies it, No takes
  an optional reason, and both tell the assistant in its next turn (spec 9, 10).
- Given the assistant asks for a secret, then a card shows the setting's name and target with a
  password field, Save and Test connection; after Save it shows "Set" and the test result; the
  value appears in no message, tool result or stored row (spec 14, 16).
- Given text that matches `assistant.secretPatterns`, when send is pressed, then it is held with
  the reason, "Put it in <field>" and "Send anyway", and a held message is not stored (spec 17).
- Given a stored tool result that matches the patterns, then the row shows "[hidden]" (spec 18).
- Given a request for project work, then the assistant's offer opens a new thread in the chat
  view with the text (spec 3).

Ground truth: `pnpm --filter @wow/web test`; `pnpm e2e` cases "the assistant changes a setting
and it can be undone", "a proposal waits for yes" and "a secret goes to its field"; screenshots
at `intents/2026-11-app-assistant/sketches/assistant.png`, `change-row.png`, `proposal.png`,
`secret-field.png` and `held-message.png`; repository checks.
Dependencies: U1 for changes, proposals and undo; U2 for the thread.
Evidence and settled decisions: rows, proposals and secret fields are inline in the conversation
(spec Interface). The settings page already writes secrets through `secrets.set`.
Delivery target: commit on the delivery branch.
Open risks: the patterns will miss some secrets; the field in the fourth line is the mechanism,
the check is a net.

### U4 Token guides and diagnosis

Outcome: the assistant can tell the user where to create a token on each host and with which
rights, from guides wow ships, and can say what is failing in the setup with the place to fix it.
Boundaries: guides are data, not model knowledge. No host is written to. No new host kinds.
Change surface: `apps/server/src/assistant` (guides per host kind and auth mode, a diagnosis
reader), the secret field card (the guide's steps above the field), `docs/user-guide.md`.
Acceptance:

- Given GitHub Enterprise at a stored address, then the guide links to that host's token page,
  names the rights reading needs, and says what to copy; the same for github.com, GitLab, Jira
  with a personal access token, Jira Cloud, and Confluence (spec 15).
- Given no stored address, then the guide says the address is needed first.
- Given a provider that is not signed in, a failed connection test, a workflow naming a skill
  that is not installed, a failed trigger, a failed run and a card that did not start, then the
  diagnosis lists each with its reason and the setting or view to fix it in (spec 19, 20).
- Given nothing is failing, then the diagnosis says so.
- Given a guide, then it names the host versions it was written for.

Ground truth: `pnpm --filter @wow/server test` with a case per host kind and per failing thing;
`pnpm e2e` case "the assistant says why it does not work"; repository checks.
Dependencies: U1 for the tools; U3 for the card the guide shows in.
Evidence and settled decisions: guides ship with wow as data (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: token pages move between host versions; the guide says which versions it fits and
the Windows smoke list checks one real host.

### U5 A setup file to save and start from

Outcome: the user saves the setup as a YAML file without any secret, project folder or account
name, and another install starts from it after a preview, as one undoable step.
Boundaries: no syncing. No calendar, backlog, thread or run data. No first-start screen (U6).
Change surface: a new `apps/server/src/setup` (write, read, validate, preview, apply),
`packages/contracts` (the file's schema with a version key, methods), Settings → Advanced and the
palette, the `yaml` package.
Acceptance:

- Given settings that differ from their defaults, tracker and host settings, workflows and
  templates, when the setup is saved, then the file holds them, and holds no secret value, no
  project folder, no account name and nothing from calendar, backlog, threads or runs; each
  secret setting that was set is listed as "to fill in" (spec 21).
- Given that file on an install with other values, when it is read, then the preview lists what
  would be added and what would replace a value, and on confirm it is applied as one step that
  Undo reverses (spec 22).
- Given a file with an unknown key, a wrong type or a secret value, then it is refused with the
  line and the reason; given a workflow naming a skill that is not installed, then it is applied
  with that workflow marked (spec 23).
- Given a file with a newer version key, then it is refused and says which wow it needs.
- Given a saved file read back on the same install, then the preview is empty.

Ground truth: `pnpm --filter @wow/server test` with the round trip, each refusal and a marked
secret that must not appear in the file; `pnpm e2e` case "save a setup and start from it";
screenshot at `intents/2026-11-app-assistant/sketches/setup-preview.png`; repository checks.
Dependencies: U1 for the undoable step.
Evidence and settled decisions: YAML with a version key, validated with the commands' schemas;
project folders stay out (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: a file written on one platform and read on another must not depend on path or line
ending form; test with CRLF.

### U6 First start, end-to-end coverage and the guide

Outcome: an install with no connected provider starts with one step, connect Claude Code or
Codex, with "Start from a setup file" beside it. After that the assistant opens, says what is set
up and what is missing, and walks through what a setup file left to fill in. The user guide and
the Windows smoke list cover the assistant.
Boundaries: no new assistant behavior beyond the greeting and the walk-through. A defect found in
an earlier unit is fixed only when small.
Change surface: `apps/web/src/app` (the first-start gate), `apps/web/src/assistant`, the provider
onboarding that exists, `apps/web/e2e`, `docs/user-guide.md`, `docs/windows-smoke.md`,
`README.md`.
Acceptance:

- Given no connected provider, when the app starts, then only the step "Connect an agent" shows,
  with Claude Code and Codex, the binary found, Test and the error in words, and "Start from a
  setup file" (spec 25).
- Given a provider passes its test, then the assistant opens and its first message lists what is
  set up and what a first run still needs (spec 26).
- Given a setup was applied, then the assistant asks for each "to fill in" secret through its
  field and for work hours and project folders, one at a time (spec 24).
- Given the provider is removed later, then Assistant shows the step again and the rest of the
  app stays usable (spec 27).
- Given the spec's ground truth list, then each named behavior has an e2e case that names it.
- Given the user guide and `docs/windows-smoke.md`, then they have the assistant's section and
  the manual check from the spec.

Ground truth: `pnpm e2e` cases "first start connects an agent and opens the assistant" and "a
colleague starts from a setup file"; screenshot at
`intents/2026-11-app-assistant/sketches/first-start.png`; repository checks.
Dependencies: U3 for the view, U4 for guides in the walk-through, U5 for the setup file.
Evidence and settled decisions: first start reuses the provider onboarding and gates the rest of
the app only while no provider is connected (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: existing e2e servers seed a connected provider; the first-start case needs a server
without one and must not change the others.
