import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// The app-server subprocess as the connection sees it, so tests can hand in a fake one.
export interface CodexProcess {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (reason: string) => void): void;
  kill(): void;
}

export interface CodexLaunch {
  readonly binaryPath: string;
  readonly launchArgs: readonly string[];
  // Full environment for the child, CODEX_HOME included.
  readonly env: Record<string, string>;
}

export type SpawnCodex = (launch: CodexLaunch) => CodexProcess;

const stderrLines = 20;

// cmd.exe quoting for the arguments of a .cmd shim (the npm-installed codex on Windows).
const quoteForCmd = (value: string): string =>
  /^[\w./:=-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;

// Node refuses to start .cmd and .bat files without a shell since the 2024 security releases.
const needsShell = (file: string): boolean =>
  process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);

export interface CommandRun {
  // Null when the process did not exit by itself (it could not start, or was stopped).
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  // Why it could not start, such as ENOENT.
  readonly startError: string | null;
}

export interface CommandLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export type RunCommand = (launch: CommandLaunch) => Promise<CommandRun>;

// Runs a short command (`codex app-server generate-json-schema`, `npm prefix -g`) to its end, or
// stops it after timeoutMs.
export const runCommand: RunCommand = (launch) =>
  new Promise((resolve) => {
    const viaShell = needsShell(launch.file);
    const child = viaShell
      ? spawn([launch.file, ...launch.args].map(quoteForCmd).join(' '), {
          env: launch.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(launch.file, launch.args, {
          env: launch.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, launch.timeoutMs);
    timer.unref();
    const finish = (code: number | null, startError: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, startError });
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code, null));
  });

export const spawnCodexAppServer: SpawnCodex = (launch) => {
  const args = ['app-server', ...launch.launchArgs];
  const viaShell = needsShell(launch.binaryPath);
  const child = viaShell
    ? spawn([launch.binaryPath, ...args].map(quoteForCmd).join(' '), {
        env: launch.env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawn(launch.binaryPath, args, {
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr.push(line);
    if (stderr.length > stderrLines) stderr.shift();
  });
  const lines = createInterface({ input: child.stdout });
  const exitListeners: ((reason: string) => void)[] = [];
  let exited = false;
  const exit = (reason: string): void => {
    if (exited) return;
    exited = true;
    const detail = stderr.join('\n').trim();
    for (const listener of exitListeners) listener(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('error', (error) => exit(`could not start ${launch.binaryPath} (${error.message})`));
  // 'close' rather than 'exit', so the last stderr lines are read before the reason is built.
  child.on('close', (code, signal) =>
    exit(`codex app-server exited (${signal ?? `code ${code}`})`),
  );
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
};
