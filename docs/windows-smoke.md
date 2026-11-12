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
- Classic Outlook desktop with a profile that has meetings this week (at least one recurring
  meeting and one with a Teams link) and some unread messages in the Inbox.
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
- [ ] Only the step "Connect an agent" shows, with no sidebar: Claude Code and Codex side by
      side, each with the binary found on the `PATH`, a Test button, and "Start from a setup
      file" below.
- [ ] Test the agent you are not signed in to (or rename its binary for a moment): the card
      says why in words and the step stays.
- [ ] Test the other one: the step goes away, the Assistant opens and its first answer lists what
      is set up and that a first run still needs a project and a workflow.
- [ ] Settings → Providers lists the instance with its account and version. Add the second CLI
      there, or with "Detect installed providers" in the palette.

## 2. Outlook

- [ ] Week view shows this week's Outlook meetings at their times, each with a lock marker.
- [ ] A recurring meeting appears once per occurrence.
- [ ] A meeting with a Teams link shows "Join Teams meeting"; clicking it opens Teams.
- [ ] After the update that reads Outlook for meetings only, the calendar still loads this
      week's meetings, the time grid takes the whole width, and nothing in wow shows the Inbox or
      its unread messages.
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
- [ ] Ask Claude to ask you two questions with choices at once ("Ask me, with your question tool,
      which test runner and which folders to test"). One card shows both, each with its header
      chip and **Other**. Pick a choice on the first, type text in **Other** of the second, Send
      answers. Write down what Claude says it received for each: expected the picked label for
      the first and your typed text for the second. Ask once more and answer with a choice and
      typed text together: expected "<label>, <your text>".
- [ ] Ask Claude to run a background agent and wait for it ("Start a background agent that
      counts the files in this folder, then end your turn and wait for it"). The turn ends and the
      thread says "Waiting for background work" with the agent's description. Without writing
      anything, Claude's answer appears when the agent is done, the thread goes to Working and then
      Idle, and the new turn has its own usage. Write down whether the waiting line showed.
- [ ] The composer bar on Claude. Open its model list (Ctrl+Shift+M): each model shows Claude
      Code's description under its label, no image icon and no "(model's default)" in the effort
      list (Claude Code's `supportedModels()` reports neither). With the cursor in the composer,
      Shift+Tab goes Accept edits, Plan only, Ask and never Bypass permissions; Escape leaves the
      composer. Pick Plan only and send "Plan a change to smoke.txt": write down whether Claude
      plans without editing, which shows the mode reached Claude Code.
- [ ] Images on Claude. Take a screenshot with Win+Shift+S, paste it into the composer with
      Ctrl+V and drop a PNG file from Explorer on it: two pictures show; Backspace at the start of
      the text takes the dropped one off. Drop it again, ask "What do these two pictures show?"
      and send. Write down whether Claude describes both (they went as image blocks), and that
      `%USERPROFILE%\.wow\images\<thread id>` holds the two files. Drop a BMP: it is refused with
      the reason.

## 4. Codex turn

Expected to fail until the bundled server registers the Codex adapter ("Known gaps" in
`docs/user-guide.md`); record the error you see.

- [ ] New thread on the Codex instance in the same folder. Ask it to read `smoke.txt`.
- [ ] Text streams; the command shows as a tool row; an approval appears for a command that needs
      one, and answering it continues the turn.
- [ ] The turn ends with usage.
- [ ] Type `$`: picking a skill inserts `$name`.
- [ ] The composer bar on Codex. Open its model list: each model shows its description, the
      instance's default (or Codex's own) is marked, models that take images have the image icon,
      and no hidden model is listed; the effort list marks the model's own default. Write down the
      models and marks you see, which come from `model/list` (`description`, `isDefault`,
      `defaultReasoningEffort`, `inputModalities`, `hidden`). Shift+Tab goes Auto, Ask untrusted,
      Read only and never Full access.
- [ ] Images on Codex. On a model with the image icon, paste a screenshot and send "What is in
      this picture?": write down whether Codex describes it (it went as a `localImage` path under
      `%USERPROFILE%\.wow\images`). On a model without the icon, pasting is refused with the
      reason.
- [ ] Ask Codex to ask you a question with choices with its user input tool (this may need
      Codex's plan mode or collaboration mode; write down how you got it to ask). Answer with a
      choice and typed text in **Other** together. Write down what Codex says it received:
      expected both the label and the text as separate answers. If Codex ignores the typed text
      when the question has choices, note it: wow sends it as an answer of its own because
      the protocol has no separate "other" field.
- [ ] The assistant on Codex. With only the Codex instance connected and "Let the assistant run
      on Codex" off (Settings → Assistant, the default), the assistant says it does not run on
      Codex and why, and no codex turn starts. Turn the setting on and send the assistant a
      message that asks it to run `Get-ChildItem env:` and to list the MCP servers it has: the
      command shows no variable of the instance (no API key), and the only server is `wow`, none
      from your own `config.toml`. Write down what codex printed.

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

## 10. Assistant

The manual check from the app assistant spec's "Ground truth"
(`intents/2026-11-app-assistant/spec.md`). It needs a GitLab you can make a personal access token
on (gitlab.com or your own), a real Claude Code sign-in, and nothing secret in the conversation.

- [ ] **Set a GitLab host through the assistant, fill the token in the field, and see the test
      pass.** In Assistant (Ctrl+6) write "Our projects are on GitLab at <address>". A change row
      "GitLab URL: … · Settings → Trackers" appears with Undo, then the GitLab token's field with
      the guide's steps. Follow the link in the guide: write down whether it opens the token page
      of your GitLab version, and which version that is. Create a token with `read_api`, paste it
      in the field, Save: the card says "Set". Test connection: it passes and names your account.
- [ ] **The token is nowhere else.** Search the conversation (Ctrl+F) for the first characters of
      the token: no match. Search `%USERPROFILE%\.wow` with
      `Select-String -Path "$env:USERPROFILE\.wow\*.log","$env:USERPROFILE\.wow\wow.sqlite" -Pattern "<token>" -SimpleMatch`:
      no match.
- [ ] Paste the token into the composer and press Enter: the message is held, with "Put it in
      GitLab token" and "Send anyway". Press the cross; nothing was sent.
- [ ] Ask the assistant to read `C:\Windows\win.ini` and to run `dir`: it says it cannot, and no
      tool row reads a file or runs a command.
- [ ] Ask it to start a run of a workflow: a card "Start <workflow> in <project>" waits for Yes.
      Press No.
- [ ] Settings → Advanced → Save setup to a file. Open the file: no token, no project folder, no
      email; `trackers.gitlab.token` is listed under `toFillIn`.
- [ ] **The assistant on Codex.** With a signed-in Codex instance, turn on "Let the assistant run
      on Codex" (`assistant.allowCodex`) and pick that instance as the assistant's provider. Ask
      the assistant "List every tool you have, with its exact name". Write down the list it gives
      and the codex version (`codex --version`); expected: the `wow/` tools, and none of
      `exec_command`, `write_stdin`, `shell`, `view_image`, a subagent, goal or app tool,
      `request_user_input`, web search, an image generation, computer use or browser tool, a
      plugin or skill search tool, a tool suggestion, `sleep`, or a code mode tool. Also check
      that a hook in your own Codex config does not run for the assistant's turns. Note whether `apply_patch` and the MCP resource tools
      (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) are there and
      whether any MCP server from your own `%USERPROFILE%\.codex\config.toml` shows up. Then ask
      it to read `C:\Windows\win.ini`: write down what it did (refused, a tool row, an error).
      Turn the setting off again.
- [ ] Remove the assistant's provider instance in Settings → Providers (or sign it out and test
      it): Assistant says so and shows "Connect an agent"; the calendar and chat still work.

## 11. Uninstall

- [ ] Uninstall from Settings → Apps. `%USERPROFILE%\.wow` stays (your data).
