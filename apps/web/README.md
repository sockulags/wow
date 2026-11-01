# @wow/web

React 19 + Vite client. Renders server state and sends commands. No Node APIs.

- `pnpm --filter @wow/web dev` starts Vite on `127.0.0.1:5173`. Without a server it runs offline
  with in-memory settings; `?server=ws://127.0.0.1:<port>&token=<token>` (or
  `VITE_WOW_SERVER_URL`) connects it to a running server.
- `pnpm --filter @wow/web test` runs the component tests (Vitest, jsdom).
- `pnpm e2e --grep shell` runs the Playwright shell tests. Set `WOW_E2E_CHROMIUM` to a Chrome
  binary when Playwright's own Chromium is not installed.

Layout: `src/app` (shell, router, sidebar, palette, commands, keybindings), `src/views` (one
view per section), `src/settings` (the page generated from `settingsRegistry`),
`src/components/ui` (shadcn/ui, compose rather than restyle), `src/styles/tokens.css` (all colors).
