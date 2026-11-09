---
intent: 2026-11-review-loop
rev: 1
built_on: spec@1
status: accepted
source: files
---

# Plan: See, approve or send back agent work in wow while agent-os units run on their own between gates

Execution: units are delivered one at a time, in the wave order below, each by a worker and an
independent reviewer. Wave 1 is U1 to U4 (review without any host), wave 2 is U5 and U6 (plans
and GitHub), wave 3 is U7 to U10 (the automation), wave 4 is U11 to U14 (more hosts and the
guide). Every unit updates `docs/architecture.md` for what it changes, lists new settings there,
and leaves the repository checks green.

## Units

- [U1] Markdown and diagrams in chat
- [U2] File reading and the viewer in the side panel
- [U3] Run base and the Changes tab — depends on U2
- [U4] Review at a gate: tabs, Approve and Send back — depends on U2, U3
- [U5] Plan files and the Plans view
- [U6] Host reading: polling, GitHub pull requests, unit status — depends on U4, U5
- [U7] Working copies — depends on U3
- [U8] Plan runs over ready units — depends on U6, U7
- [U9] Event triggers — depends on U6, U7
- [U10] Gates that pass by themselves — depends on U4, U6
- [U11] Jira tickets beside a run — depends on U6
- [U12] GitLab merge requests — depends on U6
- [U13] Confluence pages in the viewer — depends on U2, U11
- [U14] End-to-end coverage, user guide and Windows smoke — depends on U8, U9, U10, U11, U12, U13

### U1 Markdown and diagrams in chat

Outcome: assistant messages, backlog bodies and publish previews render headings, nested lists,
tables, links, inline and fenced code through one shared renderer, and `mermaid` blocks draw as
diagrams with a switch to their source.
Boundaries: web only. No file viewer (U2). No change to how messages are stored or streamed. Do
not restyle `components/ui`.
Change surface: `apps/web/src/chat/items.tsx` (`AssistantText`, `splitFences`),
`apps/web/src/backlog/markdown.tsx` and its two callers, `components/code-block.tsx`; a new shared
renderer module under `apps/web/src/components`.
Acceptance:

- Given an assistant message with a heading, a nested list, a table, a link and fenced code, when
  the thread shows, then each renders as such and code is highlighted as before (spec 1).
- Given an `https` link, when clicked, then it opens outside the app; a `javascript:` or `file:`
  link renders as text (spec 1).
- Given a complete `mermaid` block, then a diagram is drawn with a Source switch; given an invalid
  one, then the source shows as code with a one-line reason (spec 2).
- Given a streaming message with an unfinished table or diagram fence, then that part shows as
  plain text until complete (spec 3).
- Given raw HTML in a message, then it appears as text (spec 4).
- Given a backlog item body, then it renders through the same component (spec 5).

Ground truth: `pnpm --filter @wow/web test` with named cases for each acceptance line;
`pnpm e2e` case "chat renders a table and a diagram"; screenshot saved at
`intents/2026-11-review-loop/sketches/chat-markdown.png`; repository checks.
Dependencies: none.
Evidence and settled decisions: `react-markdown` with `remark-gfm`, and `mermaid` loaded on first
use with its strict security level (spec Decisions). No raw HTML plugin.
Delivery target: commit on the delivery branch.
Open risks: mermaid needs layout APIs that the unit test DOM lacks; test the wrapper's states
with the library mocked and the real drawing in the e2e case. Report bundle size before and
after.

### U2 File reading and the viewer in the side panel

Outcome: an artifact link opens in the side panel next to the conversation: markdown rendered,
images fitted, HTML as a sandboxed page, other text as code. The server reads the file through
one RPC limited to the run's working folder and the project folder.
Boundaries: no editing. No directory listing. No diff (U3). No Confluence (U13). The server stays
WebSocket-only.
Change surface: `packages/contracts` (a `files.read` method and its result), `apps/server/src/rpc`
handlers and a new `apps/server/src/files` module, `apps/web/src/panel` (viewer state and
component), `apps/web/src/workflows/artifact-link.tsx`, settings registry (`viewer.maxFileBytes`,
`viewer.htmlScripts`).
Acceptance:

- Given a run and a relative path to a markdown, PNG, HTML or text file in its folder, when
  opened, then the panel shows it rendered, fitted, as a page, or as code, with path, Back to
  conversation and Copy path (spec 6).
- Given an HTML file, then it is shown in a frame with no access to the app, network or disk, and
  its scripts run only while `viewer.htmlScripts` is on (spec 7).
- Given `../outside`, an absolute path outside the folders, a symbolic link pointing outside, a
  missing file, a non-image binary or a file over `viewer.maxFileBytes`, then nothing is read and
  the panel says why (spec 8).
- Given the desktop or the browser build, when an artifact link is used, then the panel opens and
  no `file://` link remains (spec 9).

Ground truth: `pnpm --filter @wow/server test` with cases for every refusal in the third
acceptance line and one read of each kind; `pnpm --filter @wow/web test` for the viewer states;
`pnpm e2e` case "an artifact opens in the side panel"; screenshot at
`intents/2026-11-review-loop/sketches/file-viewer.png`; repository checks.
Dependencies: none. Uses U1's renderer for markdown when U1 is delivered; if not, render markdown
as code and note it.
Evidence and settled decisions: paths are resolved with `node:path` and `realpath` before the
containment check; HTML goes into the frame as a string with a content policy that allows no
network (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: Windows path case and separators in the containment check; cover with a test that
runs on `windows-latest`.

### U3 Run base and the Changes tab

Outcome: a run remembers the commit its folder was on when it started, and the run view has a
Changes tab that lists every file changed since then with its diff, marking the files the step
under review changed.
Boundaries: no worktrees (U7). No syntax-highlighted or side-by-side diff. wow makes no commits
and changes nothing in the folder. Git runs with hooks disabled and the existing timeouts.
Change surface: `apps/server/src/projects/git.ts` (new read-only commands), `packages/contracts`
(`WorkflowRun.baseSha`, a per-step file hash list, a `workflowRuns.diff` method),
`packages/workflow-engine` and `apps/server/src/workflows/runner.ts` (record base at start and
hashes at step end), `apps/web/src/workflows` (Changes tab), settings (`diff.maxFileBytes`).
Acceptance:

- Given a run starts in a Git folder, then its base commit is stored (spec 10).
- Given committed, uncommitted, untracked (not ignored), renamed and deleted files since the base,
  when Changes opens, then each is listed with status and line changes (spec 11).
- Given two steps that changed different files, when the second waits, then only its files are
  marked and "This step only" narrows the list to them (spec 11).
- Given a binary file or one over `diff.maxFileBytes`, then it shows status and size only
  (spec 12).
- Given a folder that is not a repository, or no Git, then the tab says so and the run view works
  (spec 13).
- Given a file in the list, when opened, then it shows in U2's viewer.

Ground truth: `pnpm --filter @wow/server test` with a temporary repository covering each status
in the second line, the two-step case, binary, oversize and no-repository; `pnpm e2e` case "the
Changes tab shows what a step changed"; screenshot at
`intents/2026-11-review-loop/sketches/changes-tab.png`; repository checks.
Dependencies: U2 gives the viewer that a changed file opens in.
Evidence and settled decisions: diff is run against base, "this step" from content hashes stored
at step end (spec Decisions). Existing runs without a base show "no base recorded".
Delivery target: commit on the delivery branch.
Open risks: line endings on Windows can make every line differ; pass Git the options that
respect the repository's attributes and test with a CRLF file.

### U4 Review at a gate: tabs, Approve and Send back

Outcome: a run waiting at a gate shows review tabs in the main area and the step's conversation
with the gate bar in the side panel. Approve continues the run. Send back takes a note and runs
the step again in the same thread, after which the run waits at the same gate with the new result.
Boundaries: Pull request, Ticket and Pages tabs exist but say "nothing to show yet" until U6, U11
and U13 fill them. No gate conditions (U10). Ordinary messages at a gate keep today's behavior.
Change surface: `packages/contracts` (`workflowRun.sendBack`, `StepRun.attempt`),
`packages/workflow-engine/src/engine.ts` (a `sendBack` input beside `continue` and `stop`),
`apps/server/src/core/workflows.ts` and `workflows/runner.ts`, notification ids,
`apps/web/src/workflows` (run view tabs, `gate-bar.tsx`), palette commands, settings
(`workflows.sendBackTemplate`, `keybindings.gateApprove`, `keybindings.gateSendBack`).
Acceptance:

- Given a run waiting at a gate, when its view opens, then tabs Changes, Artifacts, Pull request,
  Ticket and Pages show in the main area and the conversation with the gate bar in the panel
  (spec 14).
- Given a waiting run, when Approve is used by key, button or palette, then the run continues as
  Continue did (spec 15).
- Given a run waiting after a step, when Send back is confirmed with a note, then the same thread
  gets a message from `workflows.sendBackTemplate`, the step shows attempt 2, and when the turn
  ends the run waits again with the new final message and artifacts (spec 16).
- Given a run waiting before a step, when sent back, then the previous step runs again (spec 17).
- Given an empty note, then Send back is refused (spec 18).
- Given a second wait after a send back, then a new notification is stored (spec 19).
- Given an ordinary message typed at a gate, then the run stays waiting and the step's result is
  unchanged (spec 20).
- Given a run that is not waiting, then Send back is refused with a reason.

Ground truth: `pnpm --filter @wow/workflow-engine test` and `pnpm --filter @wow/server test` with
cases for each line, including send back twice on one step; `pnpm e2e` case "approve and send
back at a gate"; screenshot at `intents/2026-11-review-loop/sketches/gate-review.png`; repository
checks.
Dependencies: U2 for the Artifacts tab's viewer, U3 for the Changes tab.
Evidence and settled decisions: send back is its own command and reuses the thread; Approve is
Continue renamed (spec Decisions). The runner today ignores later turns in a step's thread
(`runner.ts`, "a later turn the user sent"); a send-back turn must be told apart from those.
Delivery target: commit on the delivery branch.
Open risks: thread ids are `<runId>.<stepId>` and the projector inserts threads without conflict
handling, so the rerun must not create the thread again.

### U5 Plan files and the Plans view

Outcome: a Plans section lists each project's intents with status, revision, spec and plan, marks
stale files, and shows a plan's units with key, title, dependencies, blocked note and contract.
Without a host, status says what the files alone say.
Boundaries: no host calls and no pull request status (U6). No plan runs (U8). wow never writes
intent, spec or plan files and never runs agent-os scripts.
Change surface: a new pure package `packages/agent-os` (parse and staleness), `apps/server` (a
plans service that reads `plans.intentsDirectory` per project and watches it), `packages/contracts`
(plan projections and topic), `apps/web/src/plans` (route, view, palette commands),
`apps/web/src/app/sections.ts`, settings (`plans.intentsDirectory`).
Acceptance:

- Given `intents/<id>/{intent,spec,plan}.md`, when Plans opens, then the intent shows title,
  status, revision, and spec and plan presence (spec 21).
- Given a spec with `built_on: intent@1` and an intent at `rev: 2`, then the spec is marked stale;
  the same for a plan against its spec (spec 21).
- Given unit lines `- [U2] Title — depends on U1 — blocked: reason` and `- [U3] Title -- depends on
U1, U2`, then keys, titles, dependencies and the blocked note are read, and `### U2` contract
  fields show for `source: files` (spec 22).
- Given `source: issues`, then units show key and title only (spec 22).
- Given no host, then a blocked unit shows blocked and the others "status unknown" with the
  reason (spec 24).
- Given a plan with no `## Units` lines or a duplicate key, then the intent lists the problem
  with its line number and other intents still show (spec 25).
- Given a plan file changes on disk, then the view follows without a restart.

Ground truth: `pnpm --filter @wow/agent-os test` against plan files written in the agent-os
format, including this repository's two plans; `pnpm --filter @wow/server test`; `pnpm e2e` case
"plans view lists units"; screenshot at `intents/2026-11-review-loop/sketches/plans.png`;
repository checks.
Dependencies: none.
Evidence and settled decisions: follow `intent-files.mjs` in agent-os: intent id
`^\d{4}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$`, unit line `^-\s+\[([A-Za-z0-9][A-Za-z0-9._/-]*)\]\s+(.+)$`,
notes split on an em dash or `--` with spaces around, `depends on` and `blocked:` case-insensitive,
contract starts at `^###\s+(\S+)`, frontmatter is flat `key: value`, `built_on` is `<kind>@<n>`.
Delivery target: commit on the delivery branch.
Open risks: the U1 to U17 plan in this repository predates some contract fields; missing fields
are shown as absent, not as errors.

### U6 Host reading: polling, GitHub pull requests, unit status

Outcome: with a GitHub host and token, a followed plan's units show delivered, claimed, ready,
blocked or waiting from pull requests carrying their `Intent-Unit` line, and a run's Pull request
tab shows its pull request with state, checks, failing check names and review comments. wow asks
on a timer, only about live runs and followed plans, and shows when data was last fetched.
Boundaries: read only; GitHub only (U11 to U13 add the others behind the same interface). No
event triggers (U9) and no plan runs (U8), but store what they need: per pull request, the last
seen state, head commit, check result and newest comment id.
Change surface: `packages/contracts` (normalized `ChangeRequest`, check and comment types, host
kind, plan follow command, topics), a new `apps/server/src/hosts` (adapter interface, GitHub
adapter over `trackers/http.ts`, poller started with the scheduler), `packages/agent-os` (status
derivation, pure), `apps/web/src/plans` and the run view's Pull request tab, e2e tracker mock,
settings (`hosts.polling`, `hosts.pollSeconds`, `hosts.listFallbackCount`).
Acceptance:

- Given a merged pull request whose body has `Intent-Unit: <id>/U1`, an open one for U2, U3
  depending on U1, U4 depending on U2, and U5 with a blocked note, then the units show delivered,
  claimed, ready, waiting and blocked (spec 23).
- Given a stale plan or spec, then no unit is ready and the stale file is named (spec 23).
- Given a unit with a pull request, then it links to it and shows state, checks and last fetched
  (spec 26, 27).
- Given a run whose folder is on a branch with a pull request, then the Pull request tab shows
  it with failing check names and review comments, each linked (spec 28).
- Given one followed plan and one live run, when a poll runs, then the mock host records one
  search for the plan and requests only for those pull requests (spec 29).
- Given `scheduler.paused` or `hosts.polling` off, then a poll asks nothing and Refresh now asks
  once (spec 30).
- Given the host returns 500 or times out, then the last data stays with last fetched and the
  error (spec 31); given 401, then the view names the host and the setting, and the token appears
  in no log line (spec 32).
- Given a host without search, then the newest `hosts.listFallbackCount` pull requests are read.

Ground truth: `pnpm --filter @wow/agent-os test` for the status rule; `pnpm --filter @wow/server
test` with invented fixtures for each line and a clock the test moves; `pnpm e2e` cases "unit
status from pull requests" and "pull request beside a run"; screenshot at
`intents/2026-11-review-loop/sketches/host-tabs.png`; repository checks.
Dependencies: U5 for parsed plans and the Plans view; U4 for the Pull request tab.
Evidence and settled decisions: status rule is `dispatch-next`'s; one search per followed plan
for the `Intent-Unit: <intent-id>/` prefix; a plan is open when followed or when a plan run is
live (spec Decisions). GitHub Enterprise is `https://<host>/api/v3`, already resolved from the
remote by `trackers/resolve.ts`.
Delivery target: commit on the delivery branch.
Open risks: GitHub Enterprise Server versions differ in search and check runs; read both check
runs and commit statuses and treat a missing endpoint as "no checks". Stretch the interval when
rate headers say so.

### U7 Working copies

Outcome: a workflow with "Own working copy" runs each run in a Git worktree under
`workspaces.root`, created at the tip of the project's default branch on no branch. The worktree
is removed when the run ends and nothing in it would be lost, and kept and listed otherwise.
Boundaries: no dependency install or any repository-declared command. No branch naming. Runs
without the switch use the project folder as today.
Change surface: `packages/contracts` (`Workflow.ownWorkingCopy`, run working folder and its
state), a new `apps/server/src/workspaces`, `apps/server/src/core/workflows.ts` (`stepThread`
cwd), `projects/git.ts`, the builder and run view, palette "Remove working copy", settings
(`workspaces.root`, `workspaces.fetchBeforeCreate`).
Acceptance:

- Given the switch on, when a run starts, then a worktree exists under `workspaces.root` at the
  default branch tip, detached, every step's thread has it as `cwd`, and the project folder's
  status is unchanged (spec 36).
- Given the fetch fails, then the local tip is used and the run carries a note (spec 36).
- Given the run ends with all work committed and reachable from a remote branch, then the
  worktree is removed (spec 37).
- Given uncommitted or unpushed work, then it is kept and listed with what is unpushed, and
  "Remove working copy" removes it after a confirmation (spec 37).
- Given the project is not a repository, then the run fails before step one with the reason and
  nothing runs in the project folder (spec 38).
- Given the switch off, then the run uses the project folder (spec 39).
- Given a working copy, then the Changes tab and the viewer read from it.

Ground truth: `pnpm --filter @wow/server test` with a temporary repository and bare remote for
each line, including a path with spaces; the same tests on `windows-latest` in CI; `pnpm e2e`
case "a run in its own working copy"; repository checks.
Dependencies: U3 records the run base that the worktree's start commit becomes.
Evidence and settled decisions: Git worktree on no branch, because `deliver-work` creates its
own branch; removed only when nothing would be lost; hooks disabled for Git that wow runs (spec
Decisions).
Delivery target: commit on the delivery branch.
Open risks: Windows long paths and locked files on removal; keep the folder name short, retry
nothing, and list a working copy that could not be removed.

### U8 Plan runs over ready units

Outcome: from a followed plan the user starts a plan run with a workflow marked "For units". wow
runs the workflow for the first ready unit in its own working copy, then the next, waits when
nothing is ready and says for what, and is done when every unit is delivered.
Boundaries: one unit at a time. No merging. No change to how a single run works. Not for stale
plans or `source: issues`.
Change surface: `packages/contracts` (`Workflow.forUnits`, `PlanRun` projection, start and stop
commands, the run's unit reference), `packages/workflow-engine` (pure plan run decisions and unit
values in the prompt), `apps/server/src/core`, the hosts poller's change notifications,
`apps/web/src/plans`, settings (`workflows.unitPromptTemplate`, `workflows.planRunOnFailure`).
Acceptance:

- Given ready units U1 and U3 in plan order, when a plan run starts, then a run for U1 starts in
  a working copy and its step prompts carry intent id, unit key and title (spec 40).
- Given U1's run is done and U3 is ready, then U3 starts; given only U2 remains and it depends on
  unmerged U1, then the plan run waits and says "U2 waits for U1 to merge", and starts U2 when a
  poll shows U1 merged (spec 41).
- Given a unit claimed by a pull request this plan run did not start, then it is skipped
  (spec 42).
- Given a unit run fails with `planRunOnFailure` `stop`, then the plan run stops; with `skip`, the
  next ready unit not depending on it starts (spec 43).
- Given every unit delivered, then the plan run is done (spec 44).
- Given Stop, then the live unit run stops and no unit starts (spec 45).
- Given a stale plan, a `source: issues` plan, a workflow not for units, or a plan run already
  live on the plan, then the start is refused with the reason (spec 46, 47).

Ground truth: `pnpm --filter @wow/workflow-engine test` for the decisions; `pnpm --filter
@wow/server test` with mock provider and mock host for each line; `pnpm e2e` case "a plan run
works through ready units"; screenshot at `intents/2026-11-review-loop/sketches/plan-run.png`;
repository checks.
Dependencies: U6 for unit status and change notifications; U7 for working copies.
Evidence and settled decisions: a plan run starts ordinary runs, one per unit (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: a unit run that ends done without opening a pull request leaves the unit ready; do
not start it twice in one plan run, and say "no pull request found for U1".

### U9 Event triggers

Outcome: an event trigger starts a workflow run when polling first sees a pull request merged,
its checks fail or a review comment arrive, on pull requests wow follows. Each event starts at
most one run per trigger.
Boundaries: no webhooks. Events only for followed plans' and wow runs' pull requests. Card
triggers behave as before. Comment text is never put in a prompt.
Change surface: `packages/contracts` (trigger kind and event fields; the card fields become
optional for event triggers), `apps/server/src/core/triggers.ts`, `db/schema.ts` and a migration,
the hosts poller, the handover values, `apps/web/src/workflows` (Triggers tab), settings
(`triggers.eventsEnabled`).
Acceptance:

- Given a trigger for "pull request merged" and a followed pull request that a later poll shows
  merged, then one run starts with the link, number, branch and event in its handover, in the
  pull request's working copy when it exists, otherwise in a new one on its branch (spec 48).
- Given the next poll shows the same state, then no run starts (spec 49).
- Given a pull request already merged when the plan is followed or the trigger is made, then no
  run starts (spec 50).
- Given a new review comment, then the handover has its link and author and not its text
  (spec 51).
- Given `triggers.eventsEnabled` off or the scheduler paused, then no run starts then or later
  (spec 52).
- Given the workflow is gone, then a failed notification is stored (spec 53).
- Given existing card triggers in the database, then they still fire after the migration.

Ground truth: `pnpm --filter @wow/server test` with a moved clock and mock host for each line,
plus a migration test from the previous schema; `pnpm e2e` case "a merged pull request starts a
run"; screenshot at `intents/2026-11-review-loop/sketches/event-triggers.png`; repository checks.
Dependencies: U6 for the seen state per pull request; U7 for the working copy of the run.
Evidence and settled decisions: one trigger table with a kind; event ids from the host (pull
request and commit, or comment id); comment by link only (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: a force push changes the head commit and can look like a new failure; key "checks
failed" on the head commit so each commit fails at most once.

### U10 Gates that pass by themselves

Outcome: a step's gate after it can carry a condition. When the step ends and every chosen part
holds (approved verdict line, checks successful, expected artifacts found), the next step starts
and the run records why. Otherwise the run waits and says which part failed. Planning skills
always stop.
Boundaries: only gates after a step. No merging. No model judges anything. Gates without a
condition behave as before.
Change surface: `packages/contracts` (`WorkflowStep.gateAfterCondition`, how a gate was passed on
`StepRun`), `packages/workflow-engine/src/engine.ts`, `apps/server/src/core/workflows.ts`
(validation), the hosts poller for checks, the builder and `gate-bar.tsx`, settings
(`workflows.verdictApprovedLine`, `workflows.alwaysStopSkills`,
`workflows.gateChecksTimeoutMinutes`).
Acceptance:

- Given the verdict part and a final message whose last non-empty line is `APPROVED`, then the
  gate passes and the step shows "passed by itself" with the part (spec 54, 58).
- Given a last line `CHANGES_REQUESTED`, or `APPROVED` only earlier in the message, then the run
  waits and the gate bar names the verdict part (spec 55).
- Given the checks part and all checks successful, then it passes; given a failing check, then it
  waits naming the check (spec 54, 55).
- Given checks still running, then the run waits "for checks", passes when a poll shows success,
  and waits for the user after `workflows.gateChecksTimeoutMinutes` (spec 56).
- Given the artifacts part and a missing expected artifact, then it waits naming the glob
  (spec 55).
- Given a step using `plan-work`, then the builder offers no condition and
  `workflow.create` or `update` with one is refused (spec 57).
- Given the four default skills removed from `workflows.alwaysStopSkills`, then they still stop.

Ground truth: `pnpm --filter @wow/workflow-engine test` with a case per part passing and failing;
`pnpm --filter @wow/server test` for the checks wait and timeout with a moved clock and for the
refusal; `pnpm e2e` cases "a gate passes by itself" and "a planning gate always stops";
screenshot at `intents/2026-11-review-loop/sketches/builder-gate-condition.png`; repository
checks.
Dependencies: U4 for the gate bar and the step result after send back; U6 for check results.
Evidence and settled decisions: the verdict is the last non-empty line, as `check-work` writes it
and as agent-os's review job reads it (spec Decisions).
Delivery target: commit on the delivery branch.
Open risks: an agent may wrap the verdict in backticks or bold; strip those two and nothing else,
and test both.

### U11 Jira tickets beside a run

Outcome: the Ticket tab shows the Jira issue of a run or unit: key, summary, status, assignee,
type and description, with a link and when it was fetched.
Boundaries: read only. Jira only. No boards, transitions or comments. Publishing stays as it is.
Change surface: `apps/server/src/hosts` (Jira adapter over `trackers/jira.ts` auth),
`packages/contracts` (normalized `Ticket`), ticket resolution, the Ticket tab, e2e mock.
Acceptance:

- Given a run whose backlog item was published to Jira, then the tab shows that issue (spec 33).
- Given no backlog issue and a pull request titled `ABC-12 Fix it`, or a branch `abc-12-fix`,
  with the project's Jira key `ABC`, then the tab shows `ABC-12` (spec 33).
- Given no ticket is found, then the tab says so.
- Given the description in Jira wiki markup, then it shows readable, with markup not run.
- Given 401, 404 or a timeout, then the behavior of spec 31 and 32 holds for Jira.
- Given a poll, then only tickets of live runs and followed plans are asked for (spec 29).

Ground truth: `pnpm --filter @wow/server test` with invented fixtures for each line; `pnpm e2e`
case "a Jira ticket beside a run"; repository checks.
Dependencies: U6 for the adapter interface, poller and tab.
Evidence and settled decisions: `GET <base>/rest/api/2/issue/<key>` with the existing `pat` and
`cloud-basic` modes; v2 because Server and Data Center accept it.
Delivery target: commit on the delivery branch.
Open risks: none beyond the host versions named in the spec.

### U12 GitLab merge requests

Outcome: a project whose remote is on a GitLab host gets unit status, the Pull request tab,
plan runs and event triggers from merge requests, with pipelines as checks and notes as review
comments.
Boundaries: read only. Only what U6's interface needs. No GitLab issues.
Change surface: `apps/server/src/projects/git.ts` (recognize a GitLab remote and its project
path), `apps/server/src/hosts` (GitLab adapter), `trackers/resolve.ts` and `whoami.ts`, settings
(`trackers.gitlab.baseUrl`, `trackers.gitlab.token`), Settings → Trackers and per project, e2e
mock.
Acceptance:

- Given a remote `git@gitlab.example.test:group/sub/app.git` and a GitLab host setting, then the
  project resolves to that host and project path (spec 34).
- Given merged and open merge requests whose descriptions carry `Intent-Unit` lines, then unit
  status matches U6's first acceptance line (spec 34).
- Given a merge request with a failed pipeline and a note, then the Pull request tab shows the
  failing job names and the note (spec 34).
- Given Test connection with a good token, then it shows the account and the host version; with
  a bad one, the host's message.
- Given 401 or a timeout, then spec 31 and 32 hold for GitLab.

Ground truth: `pnpm --filter @wow/server test` with invented fixtures; `pnpm e2e` case "unit
status from GitLab merge requests"; repository checks.
Dependencies: U6 for the interface and everything that consumes it.
Evidence and settled decisions: GitLab API v4 with the `PRIVATE-TOKEN` header; merge requests
found by searching descriptions for the `Intent-Unit: <intent-id>/` prefix.
Delivery target: commit on the delivery branch.
Open risks: nested group paths must be URL-encoded as one project id.

### U13 Confluence pages in the viewer

Outcome: the Pages tab lists Confluence pages linked from the ticket description, the pull
request body or the intent, and opening one shows its rendered body in the side panel.
Boundaries: read only. Only linked pages. No search, no spaces, no attachments. Pages are not
given to agents.
Change surface: `apps/server/src/hosts` (Confluence adapter, link finding), `packages/contracts`
(normalized `Page`), the Pages tab and the viewer, settings (`trackers.confluence.baseUrl`,
`trackers.confluence.token`, `trackers.confluence.authMode`), e2e mock.
Acceptance:

- Given a ticket description linking `<base>/pages/viewpage.action?pageId=123` and an intent
  linking `<base>/display/ENG/Design+notes`, then both pages are listed with title and last
  fetched (spec 35).
- Given a page is opened, then its body shows in the side panel in a frame where scripts do not
  run, with "Open on host" (spec 35).
- Given a link to another site, then it is not read.
- Given no links, then the tab says so and no request is made (spec 35).
- Given 401, 404 or a timeout, then spec 31 and 32 hold for Confluence.

Ground truth: `pnpm --filter @wow/server test` with invented fixtures; `pnpm e2e` case "a
Confluence page beside a run"; repository checks.
Dependencies: U2 for the viewer; U11 for the ticket description.
Evidence and settled decisions: `GET <base>/rest/api/content/<id>?expand=body.view,version` and
`GET <base>/rest/api/content?spaceKey=&title=` for display links, bearer token or basic.
Delivery target: commit on the delivery branch.
Open risks: images in a page need the host session and will not load; say so in the viewer.

### U14 End-to-end coverage, user guide and Windows smoke

Outcome: `pnpm e2e` covers the behaviors the spec's ground truth names, `docs/user-guide.md`
explains review, plans, working copies, event triggers and gate conditions, and
`docs/windows-smoke.md` has the manual check with real hosts.
Boundaries: no new behavior. Fix a defect found here only when it is small; otherwise report it.
Change surface: `apps/web/e2e`, `docs/user-guide.md`, `docs/windows-smoke.md`, `README.md` status
line, `docs/architecture.md` consistency.
Acceptance:

- Given the spec's ground truth list, then each named behavior has an e2e case that names it.
- Given the user guide, then each new view and setting group has a section with the keys used.
- Given `docs/windows-smoke.md`, then it has the three manual steps from the spec's ground truth.
- Given `settings/coverage.test.ts`, then every new setting is listed in `docs/architecture.md`.
- Given the sketches folder, then a screenshot exists for every Interface entry that names one.

Ground truth: `pnpm e2e` green with the case list in the report; repository checks.
Dependencies: every earlier unit, for the behavior under test.
Evidence and settled decisions: none.
Delivery target: commit on the delivery branch.
Open risks: none.
