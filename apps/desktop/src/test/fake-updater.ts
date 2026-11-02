import type { Updater, UpdaterEvent, UpdateTimers } from '../main/updates.js';

// Stands in for electron-updater: counts checks and installs, and lets a test say what the
// updater reports.
export class FakeUpdater implements Updater {
  checks = 0;
  installs = 0;
  // What a check reports after "checking". Throwing makes the check fail.
  onCheck: () => void = () => this.emit({ type: 'not-available' });
  // Runs when the installer is asked to start. Throwing makes the start fail.
  onInstall: () => void = () => undefined;
  readonly #listeners: ((event: UpdaterEvent) => void)[] = [];

  check(): Promise<void> {
    this.checks++;
    try {
      this.emit({ type: 'checking' });
      this.onCheck();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  quitAndInstall(): void {
    this.installs++;
    this.onInstall();
  }

  onEvent(listener: (event: UpdaterEvent) => void): void {
    this.#listeners.push(listener);
  }

  emit(event: UpdaterEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

// Interval timers a test fires by hand, so nothing waits on the clock.
export class FakeTimers implements UpdateTimers {
  readonly #active = new Map<number, { readonly ms: number; readonly run: () => void }>();
  #next = 1;

  every(ms: number, run: () => void): () => void {
    const id = this.#next++;
    this.#active.set(id, { ms, run });
    return () => this.#active.delete(id);
  }

  // Runs every active interval once, as if its time had passed.
  fire(): void {
    for (const timer of this.#active.values()) timer.run();
  }

  get intervals(): number[] {
    return [...this.#active.values()].map((timer) => timer.ms);
  }
}
