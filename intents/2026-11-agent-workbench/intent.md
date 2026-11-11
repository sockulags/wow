---
id: 2026-11-agent-workbench
status: accepted
rev: 1
supersedes: null
---

# Working with an agent in wow as well as in Claude Code and Codex

## Who and why

Lucas works with agents all day, in wow and beside it in Claude Code and Codex. wow's review loop
around a gate is strong, but the chat, where the work with an agent happens, is the weakest part
of the app. A UI and UX audit of the built app (`audit.md` in this folder, November 2026) found
what pulls him back to the other tools:

- Choosing a model, an effort or a permission mode is a set of selects in the thread header with
  no key and no command, and the instance's default is not marked.
- The side panel in chat shows only static thread details. Files, pull requests, issues, Jira
  tickets and Confluence pages open beside a workflow run but not beside a chat.
- What the agent does is hard to read: tool calls show their input as JSON with no exit code or
  time, edits are not shown as diffs, the todo list scrolls away with its turn, subagent work is
  invisible, nothing can be copied with a button.
- Approvals are a generic JSON card: no deny with a note, no "always allow", and a plan the agent
  wants approved is not shown as a plan.
- A message queued during a turn, and any draft, is lost when he switches threads. There are no
  image attachments, no file mentions and no commands in the composer besides skills.
- A chat thread that needs him, or finishes, sends no notification. Threads cannot be renamed,
  archived or searched.

## Desired outcome

When this is done, the things Lucas does with an agent in Claude Code or the Codex app he can do
in wow, from the keyboard, with wow's own look:

- He picks the model, the effort and the permission mode in a bar at the composer, with keys and
  palette commands; each thread remembers its choice and shows what the provider offers and which
  is the default.
- The side panel in chat opens a file from the project, and a pull request, merge request, issue,
  Jira ticket or Confluence page, from a link or mention in a message, from the composer or from
  the palette.
- Tool work reads like a terminal and an editor: commands with exit code and time, edits as
  diffs, a todo list that stays in view, subagents and background work shown, copy buttons.
- Approvals and plan mode work as in Claude Code: allow once or always, deny with a note, the
  exact command shown, a rendered plan to approve or send back.
- Drafts and queued messages survive switching threads and a restart. He can attach images and
  pasted screenshots, mention files with `@`, and use commands in the composer.
- A thread that needs him or has finished notifies him. Threads can be renamed, archived,
  searched and marked unread.
- The review loop, the assistant, the calendar and plans lose the rough edges the audit lists.

## Out of scope

- A terminal, a file editor and a browser panel inside wow.
- Changing what the providers can do; wow shows and steers what Claude Code and Codex offer.
- Mobile and remote access.

## Open questions

None. The owner asked for the review, named the model choice and the side panel in chat as
examples, and delegated the rest: the reference is a mix of Claude Code and Codex by the
coordinator's judgement, keeping wow's keyboard focus and look.

## Decision log
