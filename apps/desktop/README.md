# @wow/desktop

Electron shell for wow: starts the server, shows the web app, and keeps running in the tray so
triggers fire while the window is closed.

## What it does

- Starts the bundled server as a child process (`ELECTRON_RUN_AS_NODE=1`), waits for
  `~/.wow/server.json` with the child's pid, and stops it over the IPC channel on quit. If the
  server dies, it asks whether to restart it.
- Serves the built web app from `wow://app/` and hands `server.json` to it through the preload
  (`window.wowServerInfo`).
- Tray: click opens the window; menu has Open, New thread, Pause/Resume scheduler and Quit.
  Pause toggles the `scheduler.paused` setting.
- Settings (Settings → Desktop): `desktop.closeToTray`, `desktop.autostart` (login item, starts in
  the tray), `desktop.startMinimized`. Notifications follow `scheduler.notifications` and come
  from changes on the server's `workflowRuns` topic (started, waiting for you, failed).
- One instance: a second launch shows the running window.

## Commands

```sh
pnpm --filter @wow/desktop test        # main-process tests against a fake server
pnpm --filter @wow/desktop build       # web app + out/ (main, preload, server bundle, renderer)
pnpm --filter @wow/desktop exec install-electron   # Electron binary, once, for start/smoke
pnpm --filter @wow/desktop smoke       # bundled server under Electron's Node
pnpm --filter @wow/desktop start       # run the built app
pnpm --filter @wow/desktop dist        # Windows NSIS installer in release/ (on Windows)
```

`WOW_HOME` moves `~/.wow`; `WOW_OUTLOOK=mock` and `WOW_PROVIDERS=mock` reach the server as usual.
The desktop writes its own log and the server's output to `~/.wow/desktop.log`.

The installer is unsigned and there is no auto-update. CI builds it on `windows-latest` and keeps it
as the `wow-installer-windows` artifact.
