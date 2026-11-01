import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerProcess, type ServerLaunch } from '../main/server-process.js';

export const fakeServerEntry = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));

export async function temporaryHome(): Promise<{ home: string; remove: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'wow-desktop-test-'));
  return { home, remove: () => rm(home, { recursive: true, force: true }) };
}

export type FakeServerMode = 'exit-early' | 'ignore-shutdown';

export const fakeLaunch = (
  home: string,
  overrides: { mode?: FakeServerMode; stopTimeoutMs?: number } = {},
): ServerLaunch => ({
  // Node stands in for the Electron binary; the child ignores ELECTRON_RUN_AS_NODE.
  execPath: process.execPath,
  entry: fakeServerEntry,
  home,
  env: { ...process.env, FAKE_SERVER_MODE: overrides.mode },
  startTimeoutMs: 20_000,
  stopTimeoutMs: overrides.stopTimeoutMs ?? 20_000,
});

export const startFakeServer = (home: string, overrides?: { mode?: FakeServerMode }) =>
  ServerProcess.start(fakeLaunch(home, overrides));
