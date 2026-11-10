# Windows smoke check

The manual check from the spec's "Ground truth": on a real Windows machine, real Outlook items
appear, a real Claude and Codex turn stream, and a card trigger starts a thread while the app sits
in the tray. CI cannot do this, because it has no Outlook profile and no logged-in CLIs.

Run it for every release candidate. Copy the checklist into the pull request or release notes,
tick what passed, and write down what did not with the build, the step and what you saw. For a
release, fill in the copy in `docs/releases/v<version>.md` and change its "Smoke result" line; the
release workflow will not publish a tag whose notes still say "pending".

## Machine

- Windows 11, a normal (non-admin) user account.
- Classic Outlook desktop with a mail profile that has meetings this week (at least one recurring
  meeting and one with a Teams link) and some unread mail.
- `claude` and `codex` CLIs installed, on `PATH`, and logged in (`claude` and `codex` each answer
  a prompt in a terminal).
- A scratch Git repository to use as the project folder. Nothing in it should matter.
- No earlier wow data: rename `%USERPROFILE%\.wow` if it exists.

Record: Windows build, Outlook version, `claude --version`, `codex --version`, wow installer
version and the CI run it came from.

## 1. Install and first start

- [ ] Download `wow-installer-windows` from the CI run and run `wow-setup-<version>.exe`.
      SmartScreen warns (unsigned); "More info", "Run anyway" installs it.
- [ ] wow starts when the installer finishes; the window opens on the calendar.
- [ ] `%USERPROFILE%\.wow` holds `wow.sqlite`, `server.json` and `desktop.log`. `desktop.log` has
      "server listening" and no error about `better-sqlite3`.
- [ ] The "Set up providers" dialog lists `claude` and `codex` with their config folders.
- [ ] Create both instances. Each test shows the logged-in account and version, or a readable
      error.

## 2. Outlook

- [ ] Week view shows this week's Outlook meetings at their times, each with a lock marker.
- [ ] A recurring meeting appears once per occurrence.
- [ ] A meeting with a Teams link shows "Join Teams meeting"; clicking it opens Teams.
- [ ] The mail rail shows the unread count and the newest messages; clicking one opens it in
      Outlook.
- [ ] Move a meeting in Outlook. Within `outlook.pollSeconds` (60 s by default) it moves in wow,
      without a restart.
- [ ] Open a modal dialog in Outlook (for example File → Options) and press "Refresh Outlook". The
      banner "Outlook unavailable since <time>" appears within `outlook.requestTimeoutMs`, the
      meetings stay, and chat still works. Close the dialog, refresh: the banner goes away.
      Write down how long the banner took.
- [ ] Quit Outlook and refresh: the banner appears with "Outlook is not running". wow does not
      start Outlook. Start Outlook again and refresh: the banner goes away.
- [ ] Nothing was created or changed in Outlook by any of the above.

## 3. Claude turn

Threads can use a typed folder. Steps 6 and 7 need a project, and the app has no screen to add
one yet (see "Known gaps" in `docs/user-guide.md`); until it does, mark those steps blocked.

- [ ] New thread (Ctrl+Alt+N) on the Claude instance in the scratch repository. Ask it to list the
      files and then create `smoke.txt`.
- [ ] Text streams in as it is written; tool calls show as rows with input and output.
- [ ] The file change asks for approval; "Needs you" shows in the sidebar; Allow once continues the
      turn and the file exists afterwards.
- [ ] The turn ends with usage (tokens and cost).
- [ ] Type `$` in the composer: installed skills are listed; picking one inserts `/name`.
- [ ] Start a long answer and press Ctrl+. : the turn stops and the partial text stays.

## 4. Codex turn

Expected to fail until the bundled server registers the Codex adapter ("Known gaps" in
`docs/user-guide.md`); record the error you see.

- [ ] New thread on the Codex instance in the same folder. Ask it to read `smoke.txt`.
- [ ] Text streams; the command shows as a tool row; an approval appears for a command that needs
      one, and answering it continues the turn.
- [ ] The turn ends with usage.
- [ ] Type `$`: picking a skill inserts `$name`.

## 5. Secrets

- [ ] Add a secret-marked environment variable to an instance and save.
- [ ] `%USERPROFILE%\.wow\secrets.json` does not contain the value in plain text.
- [ ] Test the instance again: it still works.

## 6. Trigger from the tray

- [ ] Create a workflow from the Bug template on the Claude instance.
- [ ] Create a card two minutes from now with that workflow and a project.
- [ ] Close the window. wow stays in the tray, and Task Manager still shows it running.
- [ ] At the card's time (plus up to `scheduler.tickSeconds`), a Windows notification says the run
      started, and another says it is waiting for you when the step ends at its gate (or done).
- [ ] Click the tray icon: the window comes back; the card shows running or waiting, and the step's
      thread is in the sidebar with the workflow and step name.
- [ ] Tray → Pause scheduler; the calendar shows "Scheduler paused". Resume it from the tray.

## 7. Missed trigger and restart

- [ ] Create a card three minutes ahead with the workflow. Quit wow from the tray before its time.
- [ ] Start wow after the card's time. With the default `mark` policy the card shows "missed" with
      Run now; Run now starts the run.
- [ ] An earlier Claude thread opens after the restart and Resume continues its session.

## 8. Desktop settings

- [ ] Turn on `desktop.autostart`, sign out and in: wow starts in the tray, no window.
- [ ] Start wow again from the Start menu while it runs: the existing window shows; no second tray
      icon.
- [ ] Turn off `desktop.closeToTray`: closing the window quits wow.

## 9. Hosts, review and working copies

The manual check from the review loop spec's "Ground truth"
(`intents/2026-11-review-loop/spec.md`). It needs a project whose remote is on your GitHub
Enterprise Server, with a plan under its `intents` folder whose units carry `Intent-Unit:` lines in
their pull requests, a Jira site with an issue for one of those pull requests (its key in the pull
request title or branch), and a Confluence page that the issue description links to. Use invented
or throwaway content; nothing here writes to the hosts.

The three steps the spec asks for:

- [ ] **A followed plan shows unit status from GitHub Enterprise with a personal access token.**
      Put a GitHub Enterprise personal access token in Settings → Trackers (API URL
      `https://<host>/api/v3`), open the plan in Plans (Ctrl+5) and turn Follow on: units with
      pull requests show Delivered or Claimed with a link, state and checks, the others Ready,
      Waiting or Blocked, and "Last fetched" names the host. Write down the host's version from
      Test connection.
- [ ] **A Jira ticket and a Confluence page open beside a run.** With the Jira and Confluence
      sites and personal access tokens in Settings → Trackers, start a run on the pull request's
      branch. The Ticket tab shows key, summary, status, assignee, type and description with
      Open on host; the Pages tab lists the linked page, and opening it shows its body in the
      side panel next to the run, with no script run.
- [ ] **A working copy is created and removed under a path with spaces.** Set `workspaces.root`
      to a folder whose path has spaces (for example `C:\Users\<you>\wow work copies`). Turn
      on "Own working copy" for a workflow and run it: the run header shows the working copy
      under that folder, Explorer shows the folder, and the project folder is untouched. Let the
      run end with nothing unpushed: the copy is removed. Run it again, leave a file uncommitted
      and stop the run: the copy is kept and lists what is unpushed; "Remove working copy" asks
      first and then removes it. Write down how long the first step took (it installs
      dependencies in the fresh copy).

Further checks against the same hosts:

- [ ] Start a run in a project folder that is on a branch with a pull request: the Pull request
      tab shows it with its checks, the failing check names and review comments.
- [ ] Turn `hosts.polling` off: "Last fetched" stops moving; Refresh now moves it once.
- [ ] Put a wrong token in: the plan names the host and points to the GitHub token setting; the
      token appears nowhere in the view or in `desktop.log`.
- [ ] If a GitLab site is available: with `trackers.gitlab.baseUrl` and a token, a plan of a
      project on it shows unit status from merge requests, and Test connection shows the
      version.
- [ ] Optional: create an event trigger (Workflows → Triggers → New trigger, "Pull request
      merged") and merge a followed pull request on the host: one run starts within
      `hosts.pollSeconds`, and polling again starts no second one.

## 10. Uninstall

- [ ] Uninstall from Settings → Apps. `%USERPROFILE%\.wow` stays (your data).
