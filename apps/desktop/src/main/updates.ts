import type { ThreadState, UpdateState, WorkflowRunState } from '@wow/contracts';

// Auto-update from GitHub Releases (behavior 35). `UpdateManager` holds the state the web app and
// the tray show and decides when to check; `Updater` is the part electron-updater does (see
// electron-updater.ts), so tests drive the manager with a fake.

export type UpdaterEvent =
  | { readonly type: 'checking' }
  | { readonly type: 'available'; readonly version: string }
  | { readonly type: 'not-available' }
  | { readonly type: 'progress'; readonly percent: number }
  | { readonly type: 'downloaded'; readonly version: string }
  | { readonly type: 'error'; readonly message: string };

export interface Updater {
  // Looks for a newer stable release; one that is found downloads in the background. Outcomes
  // arrive as events.
  check(): Promise<void>;
  // Quits the app and runs the downloaded installer. A failure arrives as an error event or a
  // throw.
  quitAndInstall(): void;
  onEvent(listener: (event: UpdaterEvent) => void): void;
}

export interface UpdateTimers {
  // Calls `run` every `ms` until the returned function is called.
  every(ms: number, run: () => void): () => void;
}

export interface UpdateManagerOptions {
  readonly updater: Updater;
  readonly currentVersion: string;
  readonly timers: UpdateTimers;
  readonly now: () => Date;
  readonly onState: (state: UpdateState, previous: UpdateState) => void;
}

const minuteMs = 60_000;

// A check or download in flight, or an update waiting for the restart: nothing to check for.
const settled = new Set<UpdateState['status']>(['idle', 'error']);

export class UpdateManager {
  readonly #options: UpdateManagerOptions;
  #state: UpdateState;
  #config: { readonly enabled: boolean; readonly intervalMinutes: number } | undefined;
  #stopTimer: (() => void) | undefined;

  constructor(options: UpdateManagerOptions) {
    this.#options = options;
    this.#state = {
      status: 'idle',
      enabled: false,
      currentVersion: options.currentVersion,
      version: null,
      percent: null,
      error: null,
      checkedAt: null,
    };
    options.updater.onEvent((event) => this.#receive(event));
  }

  get state(): UpdateState {
    return this.#state;
  }

  // Follows `updates.enabled` and `updates.checkIntervalMinutes`. The first call with updates on
  // (startup, or the setting turned on) checks at once; every call restarts the interval.
  configure(enabled: boolean, intervalMinutes: number): void {
    const previous = this.#config;
    if (previous?.enabled === enabled && previous.intervalMinutes === intervalMinutes) return;
    this.#config = { enabled, intervalMinutes };
    this.#stopTimer?.();
    this.#stopTimer = undefined;
    this.#set({ enabled });
    if (!enabled) return;
    this.#stopTimer = this.#options.timers.every(intervalMinutes * minuteMs, () => {
      void this.check();
    });
    if (previous?.enabled !== true) void this.check();
  }

  async check(): Promise<void> {
    if (this.#config?.enabled !== true || !settled.has(this.#state.status)) return;
    this.#set({ status: 'checking', error: null });
    try {
      await this.#options.updater.check();
    } catch (error) {
      this.#fail(error);
      return;
    }
    // A check that ended without saying what it found found nothing.
    if (this.#state.status === 'checking') this.#set({ status: 'idle', checkedAt: this.#now() });
  }

  // Checks stay scheduled: they do nothing while the update is ready, and resume if the installer
  // fails to start.
  install(): void {
    this.#options.updater.quitAndInstall();
  }

  fail(error: unknown): void {
    this.#fail(error);
  }

  stop(): void {
    this.#stopTimer?.();
    this.#stopTimer = undefined;
  }

  #receive(event: UpdaterEvent): void {
    switch (event.type) {
      case 'checking':
        this.#set({ status: 'checking', error: null });
        return;
      case 'available':
        this.#set({ status: 'available', version: event.version, percent: 0, error: null });
        return;
      case 'not-available':
        this.#set({ status: 'idle', version: null, percent: null, checkedAt: this.#now() });
        return;
      case 'progress':
        this.#set({
          status: 'downloading',
          percent: Math.min(100, Math.max(0, Math.round(event.percent))),
        });
        return;
      case 'downloaded':
        this.#set({
          status: 'ready',
          version: event.version,
          percent: 100,
          error: null,
          checkedAt: this.#now(),
        });
        return;
      case 'error':
        this.#fail(event.message);
        return;
    }
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#set({ status: 'error', percent: null, error: message, checkedAt: this.#now() });
  }

  #now(): string {
    return this.#options.now().toISOString();
  }

  #set(change: Partial<UpdateState>): void {
    const previous = this.#state;
    const next = { ...previous, ...change };
    if (Object.entries(next).every(([key, value]) => previous[key as keyof UpdateState] === value))
      return;
    this.#state = next;
    this.#options.onState(next, previous);
  }
}

// Open risk in the plan: an update installed while an agent works. Restarting stops the server, so
// a running turn fails and a workflow step with it; the user is told and decides.
export function restartWarning(
  threads: readonly { readonly state: ThreadState }[],
  runs: readonly { readonly state: WorkflowRunState }[],
): string | undefined {
  const turns = threads.filter(
    (thread) => thread.state === 'working' || thread.state === 'needs_you',
  ).length;
  const steps = runs.filter((run) => run.state === 'running').length;
  if (turns === 0 && steps === 0) return undefined;
  const parts = [
    turns > 0 ? `${turns} ${turns === 1 ? 'thread has a turn' : 'threads have turns'} running` : '',
    steps > 0 ? `${steps} workflow ${steps === 1 ? 'run is' : 'runs are'} running` : '',
  ].filter((part) => part !== '');
  return `${parts.join(' and ')}. Restarting to update stops the server, and running turns end as failed. Restart and update now?`;
}
