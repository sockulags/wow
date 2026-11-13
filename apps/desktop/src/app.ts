// Identity and wiring shared by the main process, the preload, and the build scripts.

export const appId = 'dev.wow.desktop';
export const productName = 'wow';

// The web app is served from this privileged scheme so its router sees ordinary paths such as
// `/chat`, which a `file://` URL would not give it.
export const appScheme = 'wow';
export const appHost = 'app';
export const appOrigin = `${appScheme}://${appHost}`;

// The main process hands `server.json` to the preload as a command-line argument of the
// renderer, because a sandboxed preload cannot read files.
export const serverInfoArgPrefix = '--wow-server-info=';

// A login item starts the app with this flag so it opens in the tray, not in front of the user.
export const hiddenFlag = '--hidden';

// Message the desktop sends over the child's IPC channel to stop the server cleanly. Signals do
// not reach a child process on Windows, so the channel is the portable way.
export const shutdownMessage = { type: 'wow:shutdown' } as const;

export const encodeServerInfoArg = (info: unknown): string =>
  `${serverInfoArgPrefix}${encodeURIComponent(JSON.stringify(info))}`;

export function decodeServerInfoArg(argv: readonly string[]): unknown {
  const arg = argv.find((value) => value.startsWith(serverInfoArgPrefix));
  if (arg === undefined) return undefined;
  return JSON.parse(decodeURIComponent(arg.slice(serverInfoArgPrefix.length))) as unknown;
}

// IPC between the preload's `window.wowDesktop.updates` and the main process (behavior 35).
// renderer → main (invoke): the native folder dialog; answers the chosen path or null.
export const folderChannels = { pick: 'wow:pick-folder' } as const;

// renderer → main (invoke): the native save dialog for a text file (thread work spec 7); writes
// it as UTF-8 and answers the path, or null when cancelled.
export const fileChannels = { saveText: 'wow:save-text-file' } as const;

// renderer → main (invoke): "Restart now" for settings that need a restart.
export const appChannels = { restart: 'wow:app-restart' } as const;

export const updateChannels = {
  // main → renderer: the update state, on every change.
  state: 'wow:update-state',
  // renderer → main (invoke): the current state, null when updates do not run in this build.
  getState: 'wow:update-get-state',
  check: 'wow:update-check',
  install: 'wow:update-install',
} as const;
