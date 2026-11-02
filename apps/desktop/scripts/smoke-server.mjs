// Starts the built server bundle (out/server/server.mjs) the way the desktop app does: under
// Electron's own Node with ELECTRON_RUN_AS_NODE=1, in a temporary WOW_HOME, with mocked Outlook and
// providers. It then connects with the token from server.json, makes two requests, asks the server
// to stop over the IPC channel, and checks that it exits cleanly and removes server.json. This is
// the proof that better-sqlite3's prebuild loads in Electron and that the bundle finds its files.
//
//   node scripts/smoke-server.mjs           use the Electron binary from the electron package
//   node scripts/smoke-server.mjs --node    use this Node instead (no Electron download needed)
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(desktopDir, 'out', 'server', 'server.mjs');
if (!existsSync(entry)) throw new Error(`Build first (pnpm --filter @wow/desktop build): ${entry}`);

const useNode = process.argv.includes('--node');
const execPath = useNode ? process.execPath : createRequire(import.meta.url)('electron');
const home = await mkdtemp(path.join(tmpdir(), 'wow-smoke-'));
const infoFile = path.join(home, 'server.json');
const timeoutMs = 60_000;

const child = spawn(execPath, [entry], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WOW_HOME: home,
    WOW_OUTLOOK: 'mock',
    WOW_PROVIDERS: 'mock',
  },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
const exited = once(child, 'exit');

const fail = async (message) => {
  child.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
  process.stderr.write(`smoke failed: ${message}\n`);
  process.exit(1);
};
const timer = setTimeout(() => void fail(`no result after ${timeoutMs} ms`), timeoutMs);
void exited.then(([code]) => {
  if (!stopping) void fail(`server exited early with code ${code}`);
});
let stopping = false;

const info = await new Promise((resolve) => {
  const check = () =>
    readFile(infoFile, 'utf8').then(
      (text) => {
        const parsed = JSON.parse(text);
        if (parsed.pid === child.pid) {
          watcher.close();
          resolve(parsed);
        }
      },
      () => undefined,
    );
  const watcher = watch(home, check);
  void check();
});

const socket = new WebSocket(
  `ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`,
);
await once(socket, 'open');
const answers = new Map();
socket.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  answers.get(message.id)?.(message);
});
const request = (id, method, params) =>
  new Promise((resolve) => {
    answers.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

const serverInfo = await request('1', 'server.info', {});
if (!serverInfo.result) await fail(`server.info answered ${JSON.stringify(serverInfo)}`);
const settings = await request('2', 'settings.resolve', {});
const closeToTray = settings.result?.find((setting) => setting.key === 'desktop.closeToTray');
if (closeToTray?.value !== true)
  await fail(`desktop.closeToTray resolved to ${JSON.stringify(closeToTray)}`);
socket.close();

stopping = true;
child.send({ type: 'wow:shutdown' });
const [code] = await exited;
clearTimeout(timer);
if (code !== 0) await fail(`server exited with code ${code} after shutdown`);
if (existsSync(infoFile)) await fail('server.json was not removed on shutdown');
await rm(home, { recursive: true, force: true });
process.stdout.write(
  `smoke ok: server ${serverInfo.result.version} ran under ${useNode ? 'Node' : 'Electron'} ${
    useNode ? process.versions.node : execPath
  }, answered on port ${info.port} and stopped cleanly\n`,
);
