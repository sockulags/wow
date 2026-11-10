# wow — way of working

A personal desktop control surface for one developer's working day. It puts three things on one
screen:

- **Calendar** (day and week): meetings from the local Outlook client, plus local
  cards that exist only in the app. A card with a workflow is a scheduled trigger.
- **Chat**: threads run by Codex (`codex app-server`) or Claude Code (Claude Agent SDK), with
  streaming, tool calls, approvals, agent questions, model and effort choice, and `$skill` picking.
- **Workflows and backlog**: a workflow is an ordered chain of installed skills (agent-os first)
  with human gates between steps. Backlog items are ideas that live only here until you choose to
  publish them to Jira or GitHub.

The look and the server/client split follow [T3 Code](https://github.com/pingdotgg/t3code) (MIT):
the server owns processes, files and Git; the UI is dumb and renders persisted state.

## Status

The app (`intents/2026-11-wow-app`) and the review loop (`intents/2026-11-review-loop`: review
at a gate, plans, working copies, host reading, event triggers and gates that pass by themselves)
are built; workflow branches (`intents/2026-11-workflow-branches`) are delivered too. Each
intent's behavior is in its `spec.md` and its delivery units in its `plan.md`; the technical
decisions are in `docs/architecture.md`. `pnpm e2e --grep @review-loop` runs the end-to-end cases
the review loop's ground truth names. The manual Windows check with real hosts
(`docs/windows-smoke.md`, section 9) is still to be run.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm typecheck   # tsc -b over the project references in tsconfig.json
pnpm lint        # oxlint, then prettier --check
pnpm test        # vitest in every package
pnpm e2e         # Playwright against mock providers, the Outlook mock and mock trackers
```

The package layout is described in `docs/architecture.md`. How to use the app is in
`docs/user-guide.md`; the manual Windows check is `docs/windows-smoke.md`.

## Target machine

Windows 11 with the Outlook desktop client, Node 22+, pnpm, the `claude` and `codex` CLIs
installed and logged in. Linux and macOS run everything except the Outlook bridge, which falls
back to a fixture-backed mock.
