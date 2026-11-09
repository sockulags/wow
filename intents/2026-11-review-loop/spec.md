---
intent: 2026-11-review-loop
rev: 1
built_on: intent@1
status: accepted
---

# See, approve or send back agent work in wow while agent-os units run on their own between gates

## Summary

Today, when an agent stops and waits for you, wow shows you its last message and you go looking
for the rest in other windows. After this, the run's page shows everything you need to judge the
step: what it changed, the documents and pictures it made, and the pull request and ticket it
belongs to. You approve with one key, or write what is wrong and send it back with another, and
the agent tries again. Agent answers in the chat look the way they were written, with tables and
diagrams.

wow also learns to read your plans. It shows which pieces of a plan are ready, taken, finished or
blocked, and it can work through the ready ones by itself, each in its own copy of the project so
your own folder is left alone. A run can start because something happened, such as a pull request
being merged or a build failing. A stop can let the work through without you when a condition you
chose holds; the stops at plan and spec never do.

wow reads from GitHub Enterprise, Jira, GitLab and Confluence to show this. It asks them on a
timer and only about your own runs and plans. It never writes a review to them and never merges.

The owner asked the agent to take the open decisions for this spec on 2026-11-09 so that work
could continue overnight. Each such decision is marked "agent decision" below and is open to
change in review.

## Behavior

### Reading agent answers

1. Given an assistant message with headings, nested lists, tables, links, inline code and fenced
   code, when the thread is shown, then each is rendered as such, code is highlighted as before,
   and links open in the system browser only for http, https and mailto.
2. Given an assistant message with a fenced `mermaid` block, when the block is complete, then it
   is drawn as a diagram with a switch to its source; when the diagram cannot be drawn, the source
   is shown as code with a one-line reason.
3. Given a turn is still streaming, when text arrives, then the message renders as markdown as it
   grows, and an unfinished table or diagram shows as plain text until it is complete.
4. Given a message contains raw HTML, when it is shown, then the HTML appears as text and is never
   run.
5. Given a backlog item body or a publish preview, when it is shown, then it uses the same
   renderer as the chat.

### Looking at files a step produced

6. Given a run and a path inside its working folder, when the user opens an artifact or a changed
   file, then the side panel shows it next to the conversation: markdown rendered, an image shown
   to fit with a switch to full size, HTML shown as a page, and any other text as code.
7. Given an HTML file, when it is shown, then it runs in a frame that cannot reach the app, the
   network or the disk; scripts in it run only while the `viewer.htmlScripts` setting is on.
8. Given a path outside the run's working folder or the project folder, a missing file, a binary
   file that is not an image, or a file larger than `viewer.maxFileBytes`, when it is requested,
   then nothing is read and the panel says why.
9. Given the desktop app, when an artifact link is used, then it opens in the side panel; the
   `file://` link that did nothing is gone.

### Seeing what changed

10. Given a run has started, when its first step begins, then the server records the commit the
    working folder was on (the run's base).
11. Given a run with a base, when the Changes tab is opened, then it lists every file added,
    changed, renamed or deleted since the base, committed or not, including new untracked files
    that Git does not ignore, each with its line changes; a file changed by the step under review
    is marked, and the list can be narrowed to those.
12. Given a changed file that is binary or larger than `diff.maxFileBytes`, when it is listed,
    then it shows its status and size without content.
13. Given the working folder is not a Git repository or Git is not installed, when the Changes tab
    is opened, then it says so and the rest of the review works.

### Deciding at a gate

14. Given a run waits at a gate, when its run view is opened, then the main area shows the review
    tabs (Changes, Artifacts, Pull request, Ticket, Pages; a tab with nothing to show says so) and
    the side panel shows the step's conversation with the gate bar.
15. Given a run waits at a gate, when the user presses Approve (the `keybindings.gateApprove` key,
    the gate bar button or the palette command), then the run continues exactly as Continue did
    before.
16. Given a run waits after a step, when the user presses Send back
    (`keybindings.gateSendBack`), writes a note and confirms, then the step runs again in the same
    thread with a message built from `workflows.sendBackTemplate` and the note, the step shows its
    attempt number, and when the turn ends the run waits at the same gate again with the new final
    message and artifacts.
17. Given a run waits before a step, when the user sends back, then the previous step runs again
    as in 16.
18. Given an empty note, when Send back is confirmed, then it is refused and nothing runs.
19. Given a step was sent back and waits again, when it waits, then a new notification is stored
    for that attempt.
20. Given a run waits at a gate, when the user types an ordinary message in the step's thread,
    then it is a side conversation as today: the run stays waiting and the step's final message
    and artifacts do not change.

### Plans and units

21. Given a project whose `plans.intentsDirectory` (default `intents`) holds intent folders, when
    the Plans view is opened, then each intent shows its title, status and revision, whether it
    has a spec and a plan, and each of those marked stale when its `built_on` revision is older
    than its source.
22. Given a plan with `source: files`, when it is shown, then each unit shows key, title,
    dependencies, its `blocked:` note and its contract fields; given `source: issues`, each unit
    shows key and title only.
23. Given a host is set up for the project, when a plan is shown, then each unit's status is:
    delivered when a merged pull request carries `Intent-Unit: <intent-id>/<unit-key>`, claimed
    when an open one does, blocked when its line has a `blocked:` note, ready when every
    dependency is delivered and none of the others apply, and waiting otherwise. A unit of a stale
    plan, or of a plan whose spec is stale, is never ready and says which file is stale.
24. Given no host is set up or the host cannot be reached, when a plan is shown, then units show
    what the files alone say (blocked, or "status unknown") with the reason, and nothing is
    guessed.
25. Given a plan file that cannot be read as a plan, when the view is shown, then the intent is
    listed with the parse problem and its line number, and other intents still show.
26. Given a unit with a pull request, when it is shown, then it links to the pull request and
    shows its state, checks and when that was last fetched.

### Reading from the hosts

27. Given a GitHub host and token for a project, when a plan is followed, then wow finds the
    plan's pull requests by their `Intent-Unit` line and reads state, draft, merge time, head
    branch and commit, check results and review comments for them.
28. Given a run with a working copy on a branch, when the branch has a pull request, then that
    pull request is the run's and shows in the Pull request tab with state, checks, the failing
    check names and review comments, each with a link to the host.
29. Given `hosts.pollSeconds` has passed, when wow asks the hosts, then it asks only about pull
    requests and tickets of live runs and of followed plans, one request per followed plan to find
    its pull requests, and never lists a whole project.
30. Given `scheduler.paused` is on or `hosts.polling` is off, when the interval passes, then
    nothing is asked; "Refresh now" in a view still asks once.
31. Given a host answers with an error, is unreachable or times out, when a view shows its data,
    then the last fetched data stays with "last fetched <time>" and the error, and the next
    interval tries again.
32. Given a host token that lacks rights or is wrong, when wow asks, then the view says which
    host refused and points to the setting; the token is never shown or logged.
33. Given a Jira host, when a run or unit has a ticket (the backlog item's issue, else a Jira key
    in the pull request title or branch name), then the Ticket tab shows key, summary, status,
    assignee, type and description, with a link.
34. Given a GitLab host, when a project's remote is on it, then merge requests fill the same role
    as pull requests in 23, 26, 27 and 28, with pipelines as checks and notes as review comments.
35. Given a Confluence host, when the ticket description, the pull request body or the intent
    links to a page on it, then the Pages tab lists those pages and opening one shows its rendered
    body in the side panel without running scripts; pages nothing links to are never read.

### Working copies

36. Given a workflow with "own working copy" on, when a run starts, then the server creates a Git
    working copy of the project under `workspaces.root` at the tip of the project's default
    branch (fetched first; the local tip when the fetch fails, with a note on the run), on no
    branch, and every step of the run works there. The project folder is not touched.
37. Given a run with a working copy ends, when its work is committed and reachable from a branch
    on the remote, then the working copy is removed; otherwise it is kept, listed with what is
    unpushed, and removed only by the user's "Remove working copy" with a confirmation.
38. Given a working copy cannot be created (not a Git repository, no disk space, path too long),
    when the run starts, then the run fails before its first step with the reason and nothing
    runs in the project folder instead.
39. Given a workflow with "own working copy" off, when a run starts, then it works in the project
    folder as today.

### Running over a plan's units

40. Given a workflow marked "for units" and a plan with ready units, when the user starts a plan
    run, then wow picks the first ready unit in plan order, starts a run of the workflow for it in
    its own working copy, and gives every step the intent id, unit key and title through
    `workflows.unitPromptTemplate`.
41. Given a unit run ends as done, when another unit is ready, then the next one starts; when
    units remain but none is ready, then the plan run waits and says what it waits for (for
    example "U2 waits for U1 to merge") and continues when the hosts show the change.
42. Given a unit is claimed by a pull request that this plan run did not start, when units are
    picked, then that unit is skipped.
43. Given a unit run fails or is stopped, when `workflows.planRunOnFailure` is `stop`, then the
    plan run stops there; when it is `skip`, then the unit is left and the next ready unit that
    does not depend on it starts.
44. Given every unit is delivered, when the hosts show it, then the plan run is done.
45. Given a plan run, when the user stops it, then the live unit run stops as a run does today
    and no further unit starts.
46. Given a plan or its spec is stale, or the plan has `source: issues`, when a plan run is
    asked for, then it is refused with the reason.
47. Given a plan run exists for a plan, when another is asked for the same plan, then it is
    refused: one unit at a time.

### Starting from an event

48. Given an event trigger for a project (event: pull request merged, checks failed or review
    comment added; a workflow; on or off), when polling first sees that event on a pull request
    wow follows, then one run of the workflow starts with the pull request's link, number, branch
    and the event in its handover, in the pull request's working copy when one exists and in a
    new one on its branch otherwise.
49. Given the same event is seen again, when polling runs, then nothing starts: an event starts
    at most one run per trigger.
50. Given a plan is followed or a trigger is created, when polling first reads the pull requests,
    then what is already true starts nothing; only later changes do.
51. Given a review comment event, when the run starts, then the handover carries the comment's
    link and author, not its text.
52. Given `triggers.eventsEnabled` is off or the scheduler is paused, when events are seen, then
    no run starts and they are not started later.
53. Given an event trigger's run cannot start, when it fires, then a failed notification is
    stored as for card triggers.

### Gates that pass by themselves

54. Given a step with a gate after it and a condition (any of: the final message ends with the
    approved verdict line, the run's pull request has every check successful, every expected
    artifact was found), when the step ends and every chosen part holds, then the gate passes, the
    next step starts, and the run records that the gate passed by itself and why.
55. Given a chosen part does not hold, when the step ends, then the run waits for the user as
    today and the gate bar says which part failed.
56. Given the checks part is chosen and checks are still running, when the step ends, then the
    run waits "for checks" and decides when polling shows them finished; after
    `workflows.gateChecksTimeoutMinutes` it waits for the user.
57. Given a step whose skill is in `workflows.alwaysStopSkills` (default: capture-intent,
    plan-work, design-work, shape-work), when a condition is set on its gate, then the builder
    does not offer it and the server refuses it; its gate always waits for the user.
58. Given a gate passed by itself, when the run is shown, then the step shows "passed by itself"
    with the parts that held, and no merge was done by wow.

## Interface

The project has no `## Design` section in its policy and the owner was not available, so no
sketch was made before building. The owner delegated these decisions on 2026-11-09. Delivery saves
a screenshot of each built screen at the path given, and the owner reviews those.

- Owner, chat message. Decided: (agent decision) one renderer for chat, backlog and the file
  viewer; diagrams draw in place with a "Source" switch. Rejected: a separate rendered and raw
  mode per thread (one more thing to toggle). Sketch:
  `intents/2026-11-review-loop/sketches/chat-markdown.png`.
- Owner, file viewer in the side panel. Decided: (agent decision) the viewer is a state of the
  existing side panel with a header (path, "Back to conversation", "Copy path") so the main view
  stays put. Rejected: a second panel (no room below 1200 px), a modal (hides the conversation).
  Sketch: `intents/2026-11-review-loop/sketches/file-viewer.png`.
- Owner, run view at a gate. Decided: (agent decision) review tabs in the main area and the
  step's conversation with the gate bar in the side panel; the gate bar has Approve, Send back
  and Stop, and Send back opens a note field in place. Rejected: a separate review route (a
  second place to look), conversation in the main area with tabs in the panel (the diff needs
  the width). Sketch: `intents/2026-11-review-loop/sketches/gate-review.png`.
- Owner, Changes tab. Decided: (agent decision) file list on the left, one unified diff per file
  on the right, "This step only" switch. Rejected: side-by-side diff (too wide next to the
  panel). Sketch: `intents/2026-11-review-loop/sketches/changes-tab.png`.
- Owner, Pull request, Ticket and Pages tabs. Decided: (agent decision) read-only summaries with
  state, a "last fetched" line, "Refresh now" and "Open on host". Rejected: embedding the host's
  page (needs the browser session). Sketch:
  `intents/2026-11-review-loop/sketches/host-tabs.png`.
- Owner, Plans view. Decided: (agent decision) a new sidebar section "Plans" after Workflows:
  projects and their intents on the left, the chosen plan's units with status on the right,
  "Follow", "Refresh now" and "Run ready units". Rejected: putting plans under Workflows (a plan
  is not a workflow). Sketch: `intents/2026-11-review-loop/sketches/plans.png`.
- Owner, plan run. Decided: (agent decision) shown in the Plans view above the units: state,
  what it waits for, the unit runs with links, Stop. Sketch:
  `intents/2026-11-review-loop/sketches/plan-run.png`.
- Owner, workflow builder. Decided: (agent decision) the workflow gets "Own working copy" and
  "For units" switches; a step's gate after it gets "Pass by itself when" with three checkboxes,
  hidden for always-stop skills. Sketch:
  `intents/2026-11-review-loop/sketches/builder-gate-condition.png`.
- Owner, event triggers. Decided: (agent decision) a "Triggers" tab in the Workflows view lists
  event triggers per project with on and off, and "New trigger" asks for project, event and
  workflow. Rejected: showing them on the calendar (they have no time). Sketch:
  `intents/2026-11-review-loop/sketches/event-triggers.png`.
- Owner, Settings. Decided: (agent decision) GitLab and Confluence join Jira and GitHub under
  Settings → Trackers and per project, with the same Test connection; new groups Hosts, Viewer and
  Working copies are generated from the registry. Sketch: none needed, generated page.

## Boundaries and non-goals

- wow reads from the hosts. The only write is the existing backlog publish.
- wow never merges, approves or comments on a pull request or ticket.
- No terminal, checkpoints, revert, side chats, browser panel or file editing.
- One unit at a time per plan. No parallel unit runs.
- The server runs Git itself with repository hooks disabled. It still never runs a command a
  repository declares; installing dependencies in a working copy is the agent's work.
- Provider adapters are unchanged. Host-specific behavior stays inside its host adapter;
  orchestration and UI see only the normalized pull request, ticket and page types.
- Workflows, runs, cards and triggers that exist keep working without change.
- This replaces two lines of the app spec (`2026-11-wow-app`): "No worktrees, diffs" and "No
  tracker polling after publishing". That spec is already stale against its intent and is
  reconciled when it is reconsidered.

## Decisions

Every decision here is an agent decision taken on the owner's instruction unless it cites the
intent.

- **Markdown through `react-markdown` with `remark-gfm`; diagrams through `mermaid`, loaded on
  first use with its strict security level.** Both build elements, not HTML strings. Rejected:
  growing the hand-written backlog parser (tables, nested lists and streaming edge cases are a
  long tail), rendering HTML from a markdown library (needs a sanitizer to be safe).
- **Files are read by the server through one RPC, limited to the run's working folder and the
  project folder after resolving symbolic links.** Rejected: `file://` links (blocked by the
  desktop shell, and unbounded), a local HTTP file server (a second surface to protect).
- **HTML is shown in a sandboxed frame from a string, with a content policy that allows no
  network.** Relative assets beside the file therefore do not load. Rejected: serving the folder
  (see above).
- **The diff is the run against its base, with "this step" marked from per-file content hashes
  stored when each step ends.** Rejected: a commit per step made by wow (changes the user's
  history), diff between commits only (misses uncommitted work, which is what a gate most often
  shows).
- **Send back is its own command and reuses the step's thread.** The agent keeps its context and
  the conversation stays in one place. Rejected: a new thread per attempt (loses context),
  treating any message typed at a gate as send back (a question would rerun the step and replace
  its handover).
- **Approve is Continue under a clearer name.** No new engine path.
- **A working copy is a Git worktree on no branch.** `deliver-work` names and creates its own
  branch, so wow does not guess the project's branch convention. Rejected: a full clone (slow,
  needs credentials again), wow-named branches (clash with the project policy).
- **A working copy is removed only when nothing in it would be lost.** Rejected: always remove
  (loses work when a push failed), never remove (fills the disk).
- **Plan files are read by a pure package that follows the agent-os parser**
  (`quality-ratchet/scripts/intent-files.mjs`): the same unit line, dependency, blocked and
  `built_on` rules. Rejected: calling the agent-os script (not always installed; wow must not run
  repository code).
- **Unit status follows `dispatch-next`** (intent). wow adds one word, "waiting", for a unit that
  is neither blocked nor ready, so the list never shows an empty status.
- **Pull requests of a plan are found with one search per followed plan** for its `Intent-Unit:`
  prefix, falling back to the newest `hosts.listFallbackCount` pull requests when the host has no
  search. Rejected: listing every pull request of the repository (the intent forbids it).
- **A plan is "open" when the user follows it or a plan run is live on it.** Following is a
  switch stored per plan. Rejected: "the plan currently on screen" (polling would depend on which
  view is open, and the UI would drive the server).
- **A plan run starts ordinary runs, one per unit.** Everything that works for a run (gates,
  review, notifications) works for a unit run. Rejected: one long run whose steps repeat (the run
  model follows steps by position).
- **Event triggers and card triggers are one table with a kind.** Each seen event has a stable
  id from the host (pull request and commit, or comment id), so a repeated poll starts nothing.
  Rejected: webhooks (self-hosted hosts cannot reach a desktop app; intent).
- **A review comment reaches the agent as a link, not as text.** Text from someone else must not
  become an instruction in a prompt wow writes. The agent reads it with its own tools and
  permission model.
- **The approved verdict is the last non-empty line of the step's final message equal to
  `workflows.verdictApprovedLine` (default `APPROVED`),** which is what `check-work` ends with and
  what agent-os's own review job greps for. Rejected: asking a model to judge the message (a
  second opinion nobody chose).
- **Skills that plan or specify always stop** (intent). The list is a setting so a project with
  other planning skills can extend it; the four defaults cannot be removed.
- **Existing `trackers.*` settings stay; GitLab and Confluence are added beside them** with the
  same per-project resolution. Polling settings live in a new `hosts` group. Rejected: renaming
  `trackers` to `hosts` (breaks stored settings for no gain).
- **Host order: GitHub Enterprise, Jira, GitLab, Confluence** (intent).

## Ground truth

- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && git diff --check`
  green on Linux and Windows CI.
- `pnpm e2e` covers behaviors 1, 2, 6, 7, 11, 14, 15, 16, 21, 23, 28, 31, 33, 35, 36, 40, 41, 48,
  54, 55 and 57 against mock providers and a mock of each host.
- Package and server tests cover the rest, including: the plan parser against plan files written
  in the agent-os format (and the parse problems of 25); path refusal (8); diff of committed,
  uncommitted, untracked, renamed, deleted and binary files (11, 12); send back twice on one step
  (16, 19); working copy kept when unpushed (37); one event starting one run (49, 50); every
  condition part passing and failing (54 to 57).
- Manual check on Windows with real hosts, added to `docs/windows-smoke.md`: a followed plan
  shows unit status from GitHub Enterprise with a personal access token; a Jira ticket and a
  Confluence page open beside a run; a working copy is created and removed under a path with
  spaces.

## Open risks

- The self-hosted versions are unknown. GitHub Enterprise Server search and check runs, Jira and
  Confluence personal access tokens and GitLab's merge request search differ by version. Evidence
  that settles it: Test connection reports the host's version, and the manual Windows check runs
  against the real hosts. The list fallback covers a host without search.
- Windows path length and locked files can stop a working copy from being created or removed.
  Evidence: the Windows CI test creates and removes one under a long path; `workspaces.root` is a
  setting so a short path can be chosen.
- A working copy has no installed dependencies, so the first step of each unit pays for an
  install. Evidence: time a unit run during the manual check; if it hurts, a later change can let
  a workflow name a setup step.
- Diagram and markdown libraries add weight to the web app. Evidence: bundle size before and
  after in the delivering pull request; both load on first use.
- Polling many followed plans can meet a host's rate limit. Evidence: the poller reads the rate
  headers where the host sends them and stretches its interval; watched during the manual check.

## Decision log
