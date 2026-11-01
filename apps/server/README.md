# @wow/server

Node 22 server: WebSocket RPC, SQLite, scheduler, providers, Outlook and skills. It owns every process, file and store; clients only send commands and render state.

- `pnpm --filter @wow/server start` runs it (`WOW_HOME` overrides `~/.wow`, `WOW_PROVIDERS=mock` uses the mock provider adapter).
- `pnpm --filter @wow/server db:generate` writes a migration after a change to `src/db/schema.ts`.
- `startServer()` from `src/server.ts` is what the desktop app calls; `src/hooks` is where providers, Outlook and background services plug in.
