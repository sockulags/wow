---
id: 2026-11-review-loop
status: accepted
rev: 1
supersedes: null
---

# See, approve or send back agent work in wow while agent-os units run on their own between gates

## Who and why

Lucas runs agent-os work through wow 0.1: a workflow is a fixed chain of skills, started by hand
or by a calendar card, and every gate is answered by hand. Two things still pull him out of the
app.

The first is judging the work. At a gate he has the agent's last message and nothing else. What
changed in the files, the sketch or document a step wrote, the pull request it opened and the
ticket it belongs to are all in other windows: a terminal, a browser, Jira, Confluence, GitHub or
GitLab. Long agent answers with tables, code and diagrams are also harder to read in the chat than
they should be. So approving or rejecting a step takes several window switches, and that cost is
paid at every gate.

The second is keeping the work moving. agent-os moves a plan forward unit by unit, and a unit's
status comes from its pull request. wow knows neither the plan nor the pull requests, so Lucas
starts each unit himself, watches CI and reviews himself, and decides himself when the next unit
may start.

The first intent (`2026-11-wow-app`) left the diff panel, worktrees and reading back from trackers
out of its first version. This intent picks those three up, because the review loop cannot work
without them. The rest of that list stays out.

## Desired outcome

When this is done:

- At a gate, one screen shows what Lucas needs to decide: the step's conversation, the files it
  changed as a diff, the artifacts it wrote, and the pull request and ticket it belongs to with
  their current state. From there he approves, or sends the work back with a note that the agent
  acts on. Both are one action from the keyboard.
- Approve and send back act inside wow only. Approve passes the gate; send back runs the step
  again with the note. Lucas still approves and merges the pull request on the host himself.
- Chat messages render the way the agent wrote them: headings, lists, tables, code and diagrams.
  A side panel opens a markdown file, an image or an HTML page that a step produced, next to the
  conversation.
- wow shows the intents and units of a project and each unit's status (ready, claimed, delivered,
  blocked), read from the plan files and the pull requests, by the same rule `dispatch-next` uses.
- A workflow can run over every ready unit of a plan, one after another, each in its own working
  copy, so runs do not disturb each other or the folder Lucas works in.
- A run can start from something that happened, not only from a time: a pull request merged, CI
  failed, a review comment arrived.
- wow notices these things by asking the hosts on a timer, because self-hosted hosts cannot reach
  a desktop app. It asks only about the pull requests and tickets that belong to a live run or to
  a unit of a plan Lucas has open, never a whole project. How often is a setting, asking stops
  while the app is paused, and the view shows when a status was last fetched.
- A gate can pass by itself when its condition holds (for example the review found nothing and CI
  is green) and stops for Lucas otherwise. Which gates may do this is his choice per workflow;
  the gates at plan and spec always stop.
- Pull requests, issues and pages are read from the hosts his projects actually use: Jira,
  Confluence, GitHub Enterprise and GitLab, all self-hosted. Each is reached through its standard
  API at the host's own address, signed in with a personal access token Lucas creates.

## Out of scope

- A terminal, checkpoints and revert, side chats and a browser panel. The side panel shows files a
  step produced; it does not browse the web. Git and pull requests already cover undo.
- Editing files in wow. Lucas sends work back to the agent; he does not fix it by hand here.
- Managing trackers from wow: boards, sprints, editing tickets or pages. wow shows the items that
  belong to a run or a unit and nothing else.
- Running several units at the same time. One at a time first; `batch-work` stays a choice Lucas
  makes outside a workflow.
- Writing review results to the hosts, for now: no approval or "request changes" on a pull
  request and no comment on a ticket from wow. wow reads from the hosts, so read-only tokens are
  enough for the review loop. Publishing a backlog item as an issue stays as it is.
- Merging without Lucas. A gate that passes by itself lets the next step start; it never merges a
  pull request.
- Writing to Outlook, mobile, remote access and multi-user, as in the first intent.

## Open questions

- Which of the four hosts comes first, and which versions do they run? The agents already reach
  them through MCP servers; wow reads them itself so that status never depends on an agent.
- What is Confluence for here: pages shown next to a run, pages given to the agent as background,
  or both?

## Decision log
