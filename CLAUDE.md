# wow project policy

`CLAUDE.md` and `AGENTS.md` are identical so Codex and Claude Code get the same rules.

## Sources of truth

- `intents/<id>/intent.md`: who needs what and why. One folder per intent: `2026-11-wow-app` (the
  app), `2026-11-review-loop`, `2026-11-app-assistant`,
  `2026-11-workflow-branches`, `2026-11-recurring-cards`,
  `2026-11-wow-skills`, `2026-11-questions-and-models`.
- `intents/<id>/spec.md`: behavior, boundaries, decisions, ground truth.
- `intents/<id>/plan.md`: delivery units and dependencies. A unit's contract is its `###` section.
  Unit keys never change.
- `docs/architecture.md`: package layout, data model, protocols, and the reasons behind them. When
  code and this file disagree, fix one of them in the same pull request.

## Delivery

- One unit per branch `agent/<unit-key>-<slug>`, one pull request into `main`, body carries
  `Intent-Unit: <intent-id>/<unit-key>`. Keep the change inside the unit's boundaries; put
  anything else in a note in the pull request, not in the diff.
- Before claiming a unit done, run its ground truth and the repository checks and paste the exact
  commands and results in the pull request.
- Repository checks: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `git diff --check`. CI runs them on Linux and Windows.
- Never commit secrets, `~/.wow` contents, or fixtures copied from real mail or calendars. Fixtures
  are invented.

## Code

- TypeScript strict everywhere, ESM, Node 22. pnpm workspaces. No `any`; prefer inferred types.
- Everything that crosses the wire is a zod schema in `packages/contracts`. Clients never import
  server code.
- The server owns subprocesses, files, Git, SQLite and the scheduler. The UI renders persisted
  state and sends commands; it never derives status from its own clock or caches.
- Provider-specific behavior stays inside its adapter package. Orchestration and UI only see the
  normalized `ProviderEvent` and `ProviderCommand` types from `packages/contracts`.
- Every tunable value is a settings-registry entry (see `docs/architecture.md`, "Settings
  registry"), never a constant in code. If you add a constant someone might want to change, add a
  setting instead.
- Tests: Vitest for packages and server, Playwright for the web app against mocked providers and
  the Outlook mock. Tests do not sleep, poll, or retry.
- Windows is the target: paths through `node:path`, PowerShell only inside `packages/outlook-bridge`
  and `packages/secrets`, line endings handled by `.gitattributes`.
- Comments are rare and say why, not what. Plain language in docs, commits and pull requests.

## UI

- React 19, Vite, Tailwind v4, shadcn/ui components in `apps/web/src/components/ui` (do not restyle
  them in place; compose), TanStack Router, Zustand stores fed by server subscriptions, cmdk for
  the palette, Shiki for code. Dark theme by default, light theme available.
- Keyboard first. Every action in a view has a palette command and, where common, a keybinding
  from the keybindings setting.
