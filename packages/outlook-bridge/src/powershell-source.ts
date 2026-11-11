import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  parseResponseLine,
  resultSchemas,
  type Appointment,
  type BridgeOp,
  type BridgeRequest,
  type BridgeResult,
  type PingResult,
  type ProfileResult,
} from './protocol.js';
import {
  OutlookError,
  systemClock,
  type CalendarWindow,
  type Clock,
  type OutlookSource,
} from './source.js';

// The subprocess as the supervisor sees it, so tests can hand in a fake one.
export interface BridgeProcess {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (reason: string) => void): void;
  kill(): void;
}

export type SpawnBridge = () => BridgeProcess;

export const bridgeScriptPath = fileURLToPath(new URL('../bridge.ps1', import.meta.url));

export function spawnPowershellBridge(scriptPath: string = bridgeScriptPath): BridgeProcess {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 20) stderr.shift();
  });
  const lines = createInterface({ input: child.stdout });
  const exitListeners: ((reason: string) => void)[] = [];
  let exited = false;
  const exit = (reason: string): void => {
    if (exited) return;
    exited = true;
    const detail = stderr.join('').trim();
    for (const listener of exitListeners) listener(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('error', (error) => exit(`could not start powershell.exe (${error.message})`));
  child.on('exit', (code, signal) => exit(`bridge exited (${signal ?? `code ${code}`})`));
  // A write to a process that just died fails asynchronously; the exit handler reports it.
  child.stdin.on('error', () => {});
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lines.on('line', listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    kill: () => {
      child.kill();
    },
  };
}

export interface PowershellOutlookOptions {
  // Read before every request so a settings change applies without a restart.
  readonly requestTimeoutMs: () => number;
  readonly spawn?: SpawnBridge;
  readonly clock?: Clock;
}

interface Pending {
  readonly op: BridgeOp;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: OutlookError) => void;
  readonly timer: unknown;
}

// Supervises one long-lived bridge.ps1: starts it on first use, matches responses to request ids,
// times requests out, and after a timeout or exit starts a fresh process on the next request.
export class PowershellOutlookSource implements OutlookSource {
  readonly kind = 'bridge';
  #process: BridgeProcess | null = null;
  #nextId = 1;
  #starts = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #spawn: SpawnBridge;
  readonly #clock: Clock;
  readonly #timeoutMs: () => number;

  constructor(options: PowershellOutlookOptions) {
    this.#spawn = options.spawn ?? (() => spawnPowershellBridge());
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.requestTimeoutMs;
  }

  // How many times a bridge process was started; a restart shows up as a second start.
  get starts(): number {
    return this.#starts;
  }

  ping(): Promise<PingResult> {
    return this.#request({ op: 'ping' });
  }

  async calendar(window: CalendarWindow): Promise<Appointment[]> {
    return (await this.#request({ op: 'calendar', from: window.from, to: window.to })).items;
  }

  async open(entryId: string): Promise<void> {
    await this.#request({ op: 'open', entryId });
  }

  profile(): Promise<ProfileResult> {
    return this.#request({ op: 'profile' });
  }

  async close(): Promise<void> {
    this.#stop(new OutlookError('exited', 'Outlook bridge closed'));
  }

  #request<R extends BridgeRequest>(request: R): Promise<BridgeResult<R['op']>> {
    const bridge = this.#ensureProcess();
    const id = this.#nextId++;
    return new Promise<BridgeResult<R['op']>>((resolve, reject) => {
      const timeoutMs = this.#timeoutMs();
      const timer = this.#clock.setTimeout(() => {
        // A hung COM call (Outlook showing a modal dialog) blocks every later request too, so the
        // process is replaced rather than waited on.
        this.#stop(
          new OutlookError(
            'timeout',
            `Outlook did not answer "${request.op}" within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        op: request.op,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      bridge.write(JSON.stringify({ id, ...request }));
    });
  }

  #ensureProcess(): BridgeProcess {
    if (this.#process) return this.#process;
    const bridge = this.#spawn();
    this.#starts += 1;
    this.#process = bridge;
    bridge.onLine((line) => {
      if (this.#process === bridge) this.#receive(line);
    });
    bridge.onExit((reason) => {
      if (this.#process === bridge) this.#stop(new OutlookError('exited', reason));
    });
    return bridge;
  }

  #receive(line: string): void {
    const response = parseResponseLine(line);
    if (!response) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    this.#clock.clearTimeout(pending.timer);
    if ('error' in response) {
      pending.reject(new OutlookError(response.error.code, response.error.message));
      return;
    }
    const parsed = resultSchemas[pending.op].safeParse(response.result);
    if (parsed.success) pending.resolve(parsed.data);
    else
      pending.reject(
        new OutlookError('protocol', `Unexpected "${pending.op}" answer from the bridge`),
      );
  }

  #stop(error: OutlookError): void {
    const bridge = this.#process;
    this.#process = null;
    for (const pending of this.#pending.values()) {
      this.#clock.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    bridge?.kill();
  }
}
