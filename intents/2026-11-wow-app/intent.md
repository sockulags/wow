---
id: 2026-11-wow-app
status: accepted
rev: 1
supersedes: null
---

# One desktop app that holds my working day: calendar, agent chat, workflows and backlog

## Who and why

Lucas works as a developer on Windows with the Outlook desktop client, Jira for tickets, GitHub
for code and pull requests, and both Codex and Claude Code as coding agents. The agent-os skills
(capture-intent, plan-work, shape-work, deliver-work, check-work, and the rest) describe how work
should move from a wish to a merged pull request, with a human in the loop at planning and spec.

Today those pieces live in separate windows: Outlook for the day's meetings and mail, Jira and a
notes file for ideas, two terminals for the agents, and the skills only in memory. Nothing shows
which skill comes next for a piece of work, whether a planned agent run has started, or what it is
waiting for. Scheduling an agent run for a free slot in the day is not possible at all.

## Desired outcome

When this is done, one app shows:

- A day and week calendar with Outlook meetings and unread mail, and local cards that only exist
  in the app. Putting a card with a workflow on the calendar schedules that workflow to start at
  that time, and the card shows whether it ran, is waiting for Lucas, or failed.
- A chat view with threads run by Codex or Claude Code, connected and configured from inside the
  app, where a workflow step is a thread and a normal thread can be started by hand.
- A workflow builder where a workflow is an ordered chain of installed skills with gates where a
  human must answer before the next step starts, and templates for the common ceremony levels.
- A backlog of ideas that are not in Jira or GitHub yet, from which an idea can get a workflow,
  land on the calendar, and optionally be published as a Jira or GitHub issue with a link back.

Everything that can be tuned is a setting in the app: provider binaries and config directories,
models and effort, permission modes, Outlook polling and lookahead, work hours, scheduler policies,
skill directories, theme and keybindings.

## Out of scope

- Writing to Outlook (creating meetings, sending mail). Outlook is read-only here. Local cards are
  not pushed to Outlook.
- Microsoft Graph. The Outlook bridge is COM through the desktop client, built behind an interface
  so Graph can be a second source later.
- Git worktree management, diff panel, terminal, checkpoints and revert, side chats, browser panel.
  These are the second version of the chat view; the first version needs none of them for
  agent-os workflows to run.
- Two-way status sync with Jira or GitHub. Publishing creates the issue and stores the link; the
  app does not poll the tracker.
- Mobile, remote access, multi-user.

## Decision log
