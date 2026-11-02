# wow — way of working

A personal desktop control surface for one developer's working day. It puts three things on one
screen:

- **Calendar** (day and week): meetings and unread mail from the local Outlook client, plus local
  cards that exist only in the app. A card with a workflow is a scheduled trigger.
- **Chat**: threads run by Codex (`codex app-server`) or Claude Code (Claude Agent SDK), with
  streaming, tool calls, approvals, agent questions, model and effort choice, and `$skill` picking.
- **Workflows and backlog**: a workflow is an ordered chain of installed skills (agent-os first)
  with human gates between steps. Backlog items are ideas that live only here until you choose to
  publish them to Jira or GitHub.

The look and the server/client split follow [T3 Code](https://github.com/pingdotgg/t3code) (MIT):
the server owns processes, files and Git; the UI is dumb and renders persisted state.

## Status

Planning. The delivery plan is `intents/2026-11-wow-app/plan.md`, the behavior is
`intents/2026-11-wow-app/spec.md`, and the technical decisions are `docs/architecture.md`. The
plan is executed by the workflow in `.claude/workflows/build-wow.js` with at most three agents at
a time.

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
