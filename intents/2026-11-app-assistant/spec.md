---
intent: 2026-11-app-assistant
rev: 1
built_on: intent@1
status: accepted
---

# An assistant in wow that runs the app from what I say and never sees a secret

## Summary

wow gets one chat whose only job is the app itself. You say what you want ("my projects are on our
GitLab", "run the delivery workflow on this idea tomorrow after lunch") and it asks what it needs,
does it, and says what it did and where that lives. Everyday changes happen at once and can be
undone. Changes that let the app do more on its own, and starting a run, are shown first and wait
for your yes. It never approves an agent's work for you.

When a token or password is needed, the assistant does not ask for it. It tells you where to
create it on that host and with which rights, and puts the field in front of you. What you type
there goes straight to the secret store; the assistant only learns that the field is filled and
whether the connection test passed.

You can save your setup as a file without any secret in it and send it to a colleague. Their app
starts with one fixed step, connecting Claude Code or Codex, and then the assistant takes them from
that file to a first working run.

The owner asked the agent to take the open decisions for this spec on 2026-11-10. Each is marked
"delegated" below and is open to change in review.

## Behavior

### What the assistant is

1. Given a provider instance that is connected, when the user opens Assistant, then one assistant
   thread is there, run by `assistant.providerInstanceId` (the first connected instance when
   empty) with `assistant.model` and `assistant.effort`, and it keeps its conversation between
   restarts.
2. Given the assistant thread, when a turn runs, then the agent has the app's own tools and no
   others: it cannot read or write files, run commands or reach the network, and it runs in an
   empty folder of the app, never in a project folder.
3. Given a request that is not about operating wow (write this code, explain this error in my
   project), when the user asks, then the assistant says the chat view is for that and offers to
   open a new thread there with the user's text.

### What it can see

4. Given a turn, when the assistant asks the app for state, then it can read: settings with their
   descriptions and where each value comes from; projects with their folder, git remote and host;
   provider instances and whether each is signed in; workflows, templates and installed skills;
   calendar cards and meetings' times and titles; backlog items; runs and plan runs with their
   state; triggers; notifications; and the result of each connection test.
5. Given a secret setting or a stored secret, when the assistant reads it, then it sees only
   whether a value is set, never the value or any part of it.
6. Given chat threads and files in a project, when the assistant asks, then there is no tool that
   returns a thread's messages or a file's content.

### What it changes

7. Given an ordinary change (a setting that is not listed in 9, a project, a tracker's host
   settings, a card, a backlog item, a workflow without the parts in 9), when the assistant makes
   it, then it is applied at once through the same command the views use, and the chat shows a
   change row: what changed, from what to what, and where it lives, with Undo.
8. Given a change row, when the user presses Undo, then the change is reversed and the row says
   so; when the thing was changed again since, then Undo is refused and says what changed.
9. Given a change that lets the app do more on its own (a step's permission mode, a gate's
   condition, a step's rules, an event trigger, a workflow's "for units" or "own working copy",
   turning `scheduler.paused` off, `scheduler.missedPolicy` to `run`, `hosts.polling` or
   `triggers.eventsEnabled` on, `viewer.htmlScripts` on), when the assistant wants it, then the
   chat shows a proposal with exactly what would change and Yes and No, and nothing changes until
   the user presses Yes. The assistant cannot answer its own proposal.
10. Given the user asks to start a run now, when the assistant starts it, then the chat shows a
    proposal "Start <workflow> in <project>" and the run starts on Yes.
11. Given a run that waits at a gate, when the assistant is asked to approve it, send it back or
    stop it, then it says only the user does that and gives the link to the run; there is no tool
    for it and the server refuses those commands from the assistant.
12. Given a command the app refuses (an unknown step, a card in the past, a live run), when the
    assistant sent it, then the assistant gets the app's reason and tells the user.
13. Given several changes in one answer, when they are made, then each has its own row and its
    own Undo, in the order they were made.

### Secrets

14. Given a secret is needed (a host token, a provider's secret environment variable), when the
    assistant asks for it, then the chat shows a secret field for that setting with its name and
    target; the typed value goes to the secret store and is never part of a message, a tool
    result, the event history or a log, and the assistant is told only "set" or "not set".
15. Given a host and auth mode, when the assistant explains how to get the token, then it uses
    the guide wow ships for that host: where in the host's own pages to create it (as a link
    built from the stored address), which rights it needs for reading, and what to copy. The
    guides cover GitHub and GitHub Enterprise, GitLab, Jira and Confluence.
16. Given a filled secret field, when the assistant runs the connection test, then it gets
    passed or the host's refusal in words, and the account name the host answered with.
17. Given a message the user is about to send that looks like a secret (a known token prefix, a
    private key block, a long random string after "token", "password" or "key"), when they press
    send, then the message is held, the chat says why, and offers to put the value in the secret
    field it belongs to or to send the message anyway; a held message is not stored.
18. Given a tool result or setting value that looks like a secret reached the assistant by
    mistake, when it is shown, then it is replaced by "[hidden]" before it is stored.

### Explaining and diagnosing

19. Given "why does this not work", when the assistant diagnoses, then it reads what is failing
    (a provider that is not signed in, a failed connection test, a skill a workflow names that is
    not installed, a trigger that failed, a run that failed with its error, a card that did not
    start and why) and says it with the setting or view to fix it in.
20. Given any change it made or setting it names, when the assistant answers, then it gives the
    place as a link the user can follow (Settings → Trackers, the workflow, the card).

### A setup to share

21. Given Settings, when the user chooses "Save setup to a file", then a YAML file is written
    with: global settings that differ from their default, tracker and host settings, workflows
    and templates, and no secret value, no project folder, no account name and nothing from
    calendar, backlog, threads or runs. Each secret setting that was set is listed as "to fill
    in".
22. Given a setup file, when the user chooses "Start from a setup file" (at first start or in
    Settings), then a preview lists what would be added and what would replace a value that is
    there, and on confirm it is applied as one undoable step.
23. Given a setup file with an unknown key, a wrong type, a workflow naming a skill that is not
    installed, or a secret value, when it is read, then the file is refused with the line and
    the reason, or for a missing skill applied with that workflow marked "skill not installed".
24. Given a setup was applied, when the assistant starts, then it goes through what the file
    listed as "to fill in" and what only this person can say (tokens, work hours, project
    folders), one at a time.

### First start

25. Given no provider instance is connected, when the app starts, then it shows one fixed step:
    connect Claude Code or Codex, with the binary found on the machine, a Test button and the
    error in words; "Start from a setup file" is offered beside it.
26. Given a provider passed its test, when the step is done, then the assistant opens and greets
    with what is set up and what is missing for a first run.
27. Given the assistant's provider is removed or signed out later, when Assistant is opened, then
    it says so and shows the same fixed step.

## Interface

No sketch was made before building; the owner delegated these on 2026-11-10 and reviews the built
screens, whose screenshots delivery saves at the paths given.

- Owner, Assistant section. Decided: (delegated) a sidebar section "Assistant" above Settings,
  with one conversation: the composer at the bottom, change rows, proposals and secret fields
  inline in the conversation where they happened. Rejected: a floating panel over every view
  (covers the thing being changed), several assistant threads (one job, one history). Sketch:
  `intents/2026-11-app-assistant/sketches/assistant.png`.
- Owner, change row. Decided: (delegated) one line "Work hours: 08:00–17:00 → 08:00–16:00 ·
  Settings → Calendar" with Undo, greyed and marked "Undone" after. Sketch:
  `intents/2026-11-app-assistant/sketches/change-row.png`.
- Owner, proposal. Decided: (delegated) a card that lists the exact changes, with Yes and No; No
  takes an optional reason that goes back to the assistant. Sketch:
  `intents/2026-11-app-assistant/sketches/proposal.png`.
- Owner, secret field. Decided: (delegated) a card with the setting's name, where the value
  goes, the token guide's steps above a password field, Save and Test connection; after saving
  it shows "Set" and the test result, never the value. Sketch:
  `intents/2026-11-app-assistant/sketches/secret-field.png`.
- Owner, held message. Decided: (delegated) the composer keeps the text and a line above it says
  what looks like a secret, with "Put it in <field>" and "Send anyway". Sketch:
  `intents/2026-11-app-assistant/sketches/held-message.png`.
- Owner or colleague, first start. Decided: (delegated) a full window step "Connect an agent"
  with Claude Code and Codex side by side and "Start from a setup file" below. Sketch:
  `intents/2026-11-app-assistant/sketches/first-start.png`.
- Owner, setup file. Decided: (delegated) "Save setup to a file" and "Start from a setup file"
  under Settings → Advanced and in the palette; the preview is a dialog with two lists, added
  and replaced. Sketch: `intents/2026-11-app-assistant/sketches/setup-preview.png`.

## Boundaries and non-goals

- The assistant does no project work and has no file, shell or network tools.
- It changes nothing outside wow: it creates no token on a host, installs no provider and edits
  no provider config file.
- It never answers a gate and never merges.
- It has no model or key of its own; it runs on a provider the user connected.
- A setup file is a starting point sent once. Nothing is kept in step between people.
- Everything the assistant does goes through the commands the views use; it has no path of its
  own into the store.
- The views stay complete: everything the assistant can do can be done by hand.
- Provider-specific wiring of the tools stays inside each provider adapter.

## Decisions

Every decision here is delegated unless it cites the intent.

- **The tools are one MCP server inside the wow server**, reached over the local port with a
  token made for the assistant thread, and each adapter hands it to its agent (the Agent SDK's
  MCP option for Claude, the MCP server setting for Codex) with every other tool turned off.
  Rejected: a tool protocol of wow's own (two adapters to teach it), letting the agent use the
  app through its files (no confirmation, no undo, and secrets within reach).
- **The server, not the model, decides what waits for a yes.** Each command the assistant can
  send has a class in one table: ordinary, proposal, or refused. A proposal is stored and applied
  only by a command that carries the user's origin. Rejected: asking the model to ask first (it
  will sometimes not).
- **Starting a run is a proposal too.** The intent says the assistant starts a run when asked
  for exactly that; a run cannot be undone, so the yes is one click on a card that names the
  workflow and project. Rejected: starting at once (a misread request spends an agent run).
- **Undo is the inverse command, recorded when the change is made**, and refused when the thing
  changed again. Rejected: restoring a snapshot (would undo other people's or the app's own later
  changes too).
- **Secret values never enter the thread.** The field writes through `secrets.set` as the
  settings page does; tool results carry "set" or "not set". The check for secret-looking text on
  send and on tool results is a net, not the mechanism. Rejected: trusting the model not to ask.
- **Token guides ship with wow as data per host kind and auth mode**, with links built from the
  stored address. Rejected: letting the model recall where a host's token page is (it differs by
  version and the model may be wrong with confidence).
- **The assistant cannot read chat threads or project files** (intent), so "why did my run fail"
  is answered from the run's stored error and state, not from the conversation.
- **One assistant thread, kept.** Its history is the record of what was changed and why.
- **The setup file is YAML with a version key**, read with the `yaml` package the repository
  already uses, validated with the same schemas as the commands it turns into. Project folders
  stay out because they differ per machine.
- **First start reuses the provider onboarding that exists** and adds the gate in front of the
  rest of the app only while no provider is connected.
- **Workflow rules count as "more on its own"** (the branches spec left this here).

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- Server tests: every assistant tool against the class table (an ordinary change applies and
  can be undone; a proposal changes nothing until the user's yes; gate commands are refused); no
  tool result contains a secret value, checked by storing a marked value and searching every
  result, event and log line for it; the setup file round trip and each refusal in 23.
- Adapter tests: the Claude and Codex adapters start the assistant's turn with the wow tools and
  no file, shell or network tool, in the app's empty folder.
- `pnpm e2e` with the mock provider scripted to call the tools: 7, 8, 9, 10, 11, 14, 17, 19, 21,
  22, 25 and 26.
- Manual check on Windows, added to `docs/windows-smoke.md`: with a real provider, set a GitLab
  host through the assistant, fill the token in the field, and see the test pass; confirm the
  conversation and `~/.wow` logs do not contain the token.

## Open risks

- A real agent may ignore the tools-only setting in some provider version. Evidence: the adapter
  tests assert the options sent; the manual check asks the assistant to read a file and expects a
  refusal.
- The secret-looking check will miss some secrets and hold some harmless text. Evidence: the
  patterns are a setting; the mechanism in 14 does not depend on it.
- Token pages move between host versions. Evidence: each guide names the host versions it was
  written for and the assistant says so when the test fails after following it.
- A setup file from a newer wow may carry settings an older wow does not know. Evidence: the
  version key and the refusal in 23.

## Decision log
