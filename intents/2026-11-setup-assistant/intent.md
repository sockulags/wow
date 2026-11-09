---
id: 2026-11-setup-assistant
status: accepted
rev: 1
supersedes: null
---

# An assistant in wow that sets the app up from my answers and never sees a secret

## Who and why

wow has many settings: provider binaries and sign-in, models, permission modes, Outlook, work
hours, the scheduler, skill directories, and per project the trackers with their hosts and tokens.
The review loop (`2026-11-review-loop`) adds four self-hosted hosts on top. Lucas knows what he
wants the app to do but not always which setting does it, and a token has to be created somewhere
in Jira, Confluence, GitHub Enterprise or GitLab before it can be pasted in.

Colleagues who try wow on their own machines meet all of this at once, without having followed how
the app was built. If setting it up takes an afternoon of reading, they will not use it.

## Desired outcome

When this is done:

- wow has one assistant chat whose only job is the app itself. Lucas says what he wants ("my
  projects are on our GitLab", "do not start runs after 16", "use the bigger model for review
  steps") and the assistant asks what it needs to know, changes the settings, and says what it
  changed and where that setting lives.
- Every change the assistant makes is visible and can be undone.
- When a value is secret, the assistant does not ask for it in the chat. It says which secret is
  needed, where to create it on that host and with which rights, step by step, and points at the
  field where Lucas enters it himself. It can see whether the field is filled and whether the
  connection test passes. It cannot read the value, and a secret typed into the chat by mistake is
  not kept.
- A colleague with a fresh install gets from first start to a working first run by answering the
  assistant's questions.
- The assistant can answer "why does this not work" for setup problems: a failed connection test,
  a provider that is not signed in, a skill that is not found.

## Out of scope

- Doing project work. The assistant does not write code, run workflows for their result or answer
  general questions; the chat view is for that.
- Changing anything outside wow: it does not create the token on the host, install a provider or
  edit its config files. It tells Lucas how.
- Shared settings between people. Each colleague has their own install and their own secrets;
  multi-user stays out, as in the first intent.
- Replacing the settings page. Everything the assistant can set stays reachable by hand.

## Open questions

- The assistant needs an agent to run on, but connecting a provider is the first thing a new
  install needs help with. Is a short fixed first step (connect one provider) acceptable before
  the assistant takes over, or must it help from the very first screen?
- Does the assistant apply a change at once and offer undo, or show it and wait for a yes? Should
  that differ for changes that make the app do more on its own, such as permission modes and gates
  that pass by themselves?
- Is handing wow to colleagues a goal now? If so, should an install be able to start from a
  prepared set of the company's hosts and defaults, without any secrets in it?
- May the assistant read anything besides settings to help, such as the project's git remote or
  the provider's sign-in state?

## Decision log
