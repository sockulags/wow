import { ServerInfo } from '@wow/contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { shutdownMessage } from '../app.js';

export const serverInfoFileName = 'server.json';

// Same rule as the server's wowHome. Repeated here so the main bundle does not pull in the server
// (SQLite, providers) just to find a directory.
export function wowHome(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['WOW_HOME'];
  return override && override.length > 0 ? path.resolve(override) : path.join(homedir(), '.wow');
}

export interface ServerEndpoint {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

export interface ServerLaunch {
  // The Electron binary in the app; Node in tests. Started with ELECTRON_RUN_AS_NODE=1.
  readonly execPath: string;
  readonly entry: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly startTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly onOutput?: (chunk: string) => void;
}

export class ServerStartError extends Error {
  constructor(message: string, output: string) {
    super(output.trim() === '' ? message : `${message}\n${output.trim()}`);
    this.name = 'ServerStartError';
  }
}

// Keeps the end of the child's output so a failed start can say why.
const outputTailLength = 4000;

function parseEndpoint(text: string): ServerEndpoint | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const info = ServerInfo.safeParse(json);
  if (!info.success) return undefined;
  const pid = info.data['pid'];
  if (typeof pid !== 'number') return undefined;
  return { port: info.data.port, token: info.data.token, pid };
}

// Resolves with the endpoint once `server.json` names this child's pid. The server writes the file
// with a rename, so a read never sees half of it. A file left by another server (another pid) is
// ignored rather than trusted.
function waitForEndpoint(
  child: ChildProcess,
  home: string,
  timeoutMs: number,
  tail: () => string,
): Promise<ServerEndpoint> {
  const file = path.join(home, serverInfoFileName);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      finish();
    };
    const check = () => {
      readFile(file, 'utf8').then(
        (text) => {
          const endpoint = parseEndpoint(text);
          if (endpoint !== undefined && endpoint.pid === child.pid) settle(() => resolve(endpoint));
        },
        () => undefined,
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(() =>
        reject(
          new ServerStartError(
            `The server exited before it was ready (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`,
            tail(),
          ),
        ),
      );
    const onError = (error: Error) =>
      settle(() =>
        reject(new ServerStartError(`The server could not start: ${error.message}`, '')),
      );
    // Watch before the first read so a write between the two is not missed.
    const watcher = watch(home, check);
    watcher.on('error', (error) => settle(() => reject(error)));
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new ServerStartError(`The server was not ready after ${timeoutMs} ms.`, tail())),
        ),
      timeoutMs,
    );
    child.once('exit', onExit);
    child.once('error', onError);
    check();
  });
}

export class ServerProcess {
  readonly endpoint: ServerEndpoint;
  readonly #child: ChildProcess;
  readonly #stopTimeoutMs: number;
  readonly #exited: Promise<void>;
  #running = true;
  #stopping = false;
  #exitListeners = new Set<(code: number | null) => void>();

  private constructor(child: ChildProcess, endpoint: ServerEndpoint, stopTimeoutMs: number) {
    this.#child = child;
    this.endpoint = endpoint;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#exited = once(child, 'exit').then(([code]: unknown[]) => {
      this.#running = false;
      if (this.#stopping) return;
      for (const listener of this.#exitListeners) listener(typeof code === 'number' ? code : null);
    });
  }

  static async start(launch: ServerLaunch): Promise<ServerProcess> {
    await mkdir(launch.home, { recursive: true, mode: 0o700 });
    const child = spawn(launch.execPath, [launch.entry], {
      env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1', WOW_HOME: launch.home },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let tail = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-outputTailLength);
      launch.onOutput?.(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    try {
      const endpoint = await waitForEndpoint(child, launch.home, launch.startTimeoutMs, () => tail);
      return new ServerProcess(child, endpoint, launch.stopTimeoutMs);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      throw error;
    }
  }

  get running(): boolean {
    return this.#running;
  }

  // Called when the server exits without being asked to stop.
  onUnexpectedExit(listener: (code: number | null) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  // Asks the server to shut down cleanly (it removes server.json and closes SQLite), and kills it
  // when it does not finish in time.
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#stopping = true;
    if (this.#child.connected) this.#child.send(shutdownMessage);
    else this.#child.kill();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#stopTimeoutMs);
    });
    const result = await Promise.race([this.#exited.then(() => 'exited' as const), timedOut]);
    clearTimeout(timer);
    if (result === 'timeout') {
      this.#child.kill('SIGKILL');
      await this.#exited;
    }
  }
}
