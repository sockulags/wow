import {
  npmInstallArgs,
  npmInstallCommand,
  type ProviderInstance,
  type ProviderUpdateProgress,
} from '@wow/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { providerInstances, threads, turns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import type { ProviderService } from './service.js';

// "Update Codex": runs the npm install a provider instance's last test offered as a server
// subprocess, stores its progress and output on the instance (`updateRun`), then tests every
// instance that runs the same binary again.

export interface NpmLaunch {
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly timeoutMs: number;
  readonly onOutput: (text: string) => void;
}

export interface NpmResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly startError: string | null;
}

export interface NpmProcess {
  readonly done: Promise<NpmResult>;
  stop(): void;
}

export type RunNpm = (launch: NpmLaunch) => NpmProcess;

// cmd.exe quoting for the arguments of npm.cmd, which Node only starts through a shell.
const quoteForCmd = (value: string): string =>
  /^[\w@./:=+-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;

export interface NpmRunnerOptions {
  // The npm executable; defaults to npm.cmd on Windows and npm elsewhere, found on PATH.
  readonly file?: string;
  // Arguments before npm's own, for a script run through node in tests.
  readonly prefixArgs?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

export function createNpmRunner(options: NpmRunnerOptions = {}): RunNpm {
  const platform = options.platform ?? process.platform;
  const file = options.file ?? (platform === 'win32' ? 'npm.cmd' : 'npm');
  return (launch) => {
    const args = [...(options.prefixArgs ?? []), ...launch.args];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(launch.env))
      if (value !== undefined) env[key] = value;
    const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const child = viaShell
      ? spawn([file, ...args].map(quoteForCmd).join(' '), {
          env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, launch.timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => launch.onOutput(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => launch.onOutput(chunk));
    const done = new Promise<NpmResult>((resolve) => {
      let settled = false;
      const finish = (code: number | null, startError: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: timedOut ? null : code, timedOut, startError });
      };
      child.on('error', (error) => finish(null, error.message));
      child.on('close', (code) => finish(code, null));
    });
    return { done, stop: () => child.kill() };
  };
}

export interface ProviderUpdatesDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly providers: ProviderService;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly env: Record<string, string | undefined>;
  readonly runNpm: RunNpm;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ProviderUpdates {
  readonly #deps: ProviderUpdatesDeps;
  readonly #running = new Map<string, { process: NpmProcess; finished: Promise<void> }>();
  #stopped = false;

  constructor(deps: ProviderUpdatesDeps) {
    this.#deps = deps;
  }

  // An update still running when the previous server process ended was cut off with it.
  recover(): void {
    for (const instance of this.#deps.db.select().from(providerInstances).all()) {
      if (instance.updateRun?.state !== 'running') continue;
      this.#record(instance.id, {
        phase: 'finished',
        ok: false,
        message: 'The server stopped while the update ran. Test the instance to see its version.',
        at: new Date().toISOString(),
      });
    }
  }

  start(providerInstanceId: string): { command: string } {
    const instance = this.#instance(providerInstanceId);
    const update = instance.update;
    if (update?.method !== 'npm') {
      throw new CommandRejected(
        'rejected',
        `${instance.name} has no update wow can run. Test it to see what it needs.`,
      );
    }
    if (this.#running.has(providerInstanceId) || instance.updateRun?.state === 'running')
      throw new CommandRejected('conflict', `${instance.name} is already being updated`);
    const sharing = this.#sharingBinary(instance);
    const busy = this.#deps.db
      .select({ id: turns.id })
      .from(turns)
      .innerJoin(threads, eq(threads.id, turns.threadId))
      .where(
        and(
          eq(turns.state, 'running'),
          inArray(
            threads.providerInstanceId,
            sharing.map((entry) => entry.id),
          ),
        ),
      )
      .all();
    if (busy.length > 0)
      throw new CommandRejected(
        'rejected',
        `A turn is running on ${instance.binaryPath || instance.name}. Stop it before updating.`,
      );
    const command = npmInstallCommand(update);
    this.#deps.engine.dispatch(`provider-update:${randomUUID()}`, {
      type: 'providerInstance.recordUpdate',
      providerInstanceId,
      progress: {
        phase: 'started',
        command,
        targetVersion: update.targetVersion,
        at: new Date().toISOString(),
      },
    });
    // The running app-server holds the binary open, which blocks the install on Windows.
    for (const entry of sharing) this.#deps.providers.release(entry.id);

    let pending = '';
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      if (pending === '') return;
      const text = pending;
      pending = '';
      this.#record(providerInstanceId, { phase: 'output', text });
    };
    const timeoutMs = this.#deps.settings.get('providers.updateTimeoutMs', { providerInstanceId });
    const process = this.#deps.runNpm({
      args: npmInstallArgs(update),
      env: this.#deps.env,
      timeoutMs,
      onOutput: (text) => {
        pending += text;
        if (flushScheduled) return;
        flushScheduled = true;
        // Output that arrives together is stored as one event.
        setImmediate(flush);
      },
    });
    const finished = process.done.then(async (result) => {
      flush();
      const ok = result.code === 0;
      const message = ok
        ? null
        : result.timedOut
          ? `npm did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`
          : result.startError
            ? `Could not start npm (${result.startError}). Is Node.js with npm on the PATH wow runs with?`
            : `npm exited with code ${result.code}. See its output above.`;
      this.#record(providerInstanceId, {
        phase: 'finished',
        ok,
        message,
        at: new Date().toISOString(),
      });
      this.#running.delete(providerInstanceId);
      if (!ok || this.#stopped) return;
      for (const entry of sharing) {
        await this.#deps.providers
          .test(entry.id)
          .catch((error: unknown) =>
            this.#deps.logger.warn(`test after update failed`, describeError(error)),
          );
      }
    });
    this.#running.set(providerInstanceId, { process, finished });
    return { command };
  }

  // Resolves when the instance's running update, and the tests after it, are done.
  async idle(providerInstanceId: string): Promise<void> {
    await this.#running.get(providerInstanceId)?.finished;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const running = [...this.#running.values()];
    for (const entry of running) entry.process.stop();
    await Promise.all(running.map((entry) => entry.finished.catch(() => undefined)));
  }

  #instance(providerInstanceId: string): ProviderInstance {
    const instance = this.#deps.db
      .select()
      .from(providerInstances)
      .where(eq(providerInstances.id, providerInstanceId))
      .get();
    if (!instance)
      throw new CommandRejected('not_found', `No provider instance ${providerInstanceId}`);
    return instance;
  }

  // Instances of the same kind that start the same binary (the PATH one when it is empty).
  #sharingBinary(instance: ProviderInstance): ProviderInstance[] {
    return this.#deps.db
      .select()
      .from(providerInstances)
      .where(
        and(
          eq(providerInstances.kind, instance.kind),
          eq(providerInstances.binaryPath, instance.binaryPath),
        ),
      )
      .all();
  }

  #record(providerInstanceId: string, progress: ProviderUpdateProgress): void {
    try {
      this.#deps.engine.dispatch(`provider-update:${randomUUID()}`, {
        type: 'providerInstance.recordUpdate',
        providerInstanceId,
        progress,
      });
    } catch (error) {
      this.#deps.logger.error('provider update progress was not stored', error);
    }
  }
}
