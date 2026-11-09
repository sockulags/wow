---
id: 2026-11-app-assistant
status: accepted
rev: 1
supersedes: null
---

# An assistant in wow that runs the app from what I say and never sees a secret

## Who and why

wow has many parts to operate: settings for providers, models, Outlook, work hours, the scheduler
and skill directories; per project the trackers with their hosts and tokens; workflows with steps
and gates; cards on the calendar; the backlog. The review loop (`2026-11-review-loop`) adds four
self-hosted hosts, event triggers and gates that pass by themselves. Lucas knows what he wants the
app to do ("run the delivery workflow on this idea tomorrow after lunch") but doing it means
visiting several views, and a token has to be created somewhere in Jira, Confluence, GitHub
Enterprise or GitLab before it can be pasted in.

Colleagues who try wow on their own machines meet all of this at once, without having followed how
the app was built. If setting it up takes an afternoon of reading, they will not use it.

## Desired outcome

When this is done:

- wow has one assistant chat whose only job is the app itself. Lucas says what he wants and the
  assistant asks what it needs to know, does it, and says what it did and where that lives in the
  app. This covers the whole app: settings, projects and their trackers, creating and changing
  workflows, putting cards on the calendar and moving them, and backlog items.
- Everything the assistant does is visible and can be undone. Ordinary changes (work hours,
  models, host addresses, theme, a card, a backlog item) happen at once. A change that lets the
  app do more on its own waits for a yes first: what an agent is permitted to do, gates that pass
  by themselves, and runs that start from events. What an agent is permitted to do is decided by
  the workflow, so these changes are changes to a workflow.
- When a value is secret, the assistant does not ask for it in the chat. It says which secret is
  needed, where to create it on that host and with which rights, step by step, and points at the
  field where Lucas enters it himself. It can see whether the field is filled and whether the
  connection test passes. It cannot read the value, and a secret typed into the chat by mistake is
  not kept.
- A fresh install starts with one short fixed step: connect Claude Code or Codex. The assistant
  runs on that provider and takes over from there, so a colleague gets from first start to a
  working first run by answering its questions.
- Lucas can save his settings as a YAML file and send it to a colleague: host addresses, defaults
  and workflows, never a secret. A colleague's install starts from that file, and the assistant
  then only asks for what is personal, such as tokens and work hours.
- The assistant can answer "why does this not work" for the app: a failed connection test, a
  provider that is not signed in, a skill that is not found, a card that did not start.

## Out of scope

- Doing project work. The assistant does not write code or answer general questions, and it does
  not do a workflow step's work; the chat view and the workflow steps are for that.
- Changing anything outside wow: it does not create the token on the host, install a provider or
  edit its config files. It tells Lucas how.
- Settings kept in step between people. The file is a starting point that is sent once; each
  colleague has their own install and their own secrets, and multi-user stays out, as in the
  first intent.
- A model or API key of its own for the assistant. It uses a provider the user has connected,
  so there is no extra secret to handle.
- Replacing the views. Everything the assistant can do stays reachable by hand.

## Open questions

- May the assistant start a run now and answer a gate (approve or send back) for Lucas, or does it
  only prepare and schedule, leaving those two to him?
- What may the assistant read to do its job? The calendar, workflows, backlog and run states are
  needed to operate the app. Beyond that: the project's git remote, the provider's sign-in state,
  connection test results? Chat threads and project files?

## Decision log
