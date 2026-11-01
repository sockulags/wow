# @wow/provider-claude

Claude Agent SDK adapter that maps to `ProviderEvent` and `ProviderCommand`. See
`docs/architecture.md`, "Providers", for what it does and why.

- `ClaudeAdapter` / `createClaudeAdapter(instance, context)`: one adapter per provider instance,
  one streaming-input `query()` per thread.
- Tests replay `src/fixtures/turn.json` (invented) through a fake `query()` in
  `src/testing/fake-query.ts`.
- `WOW_REAL_PROVIDERS=1 pnpm --filter @wow/provider-claude test` also runs `src/smoke.test.ts`
  against the installed `claude` (found on `PATH`, or `WOW_CLAUDE_BINARY`; config directory from
  `WOW_CLAUDE_CONFIG_DIR`) with the user's own login.
