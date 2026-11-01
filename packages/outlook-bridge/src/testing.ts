import type { BridgeProcess } from './powershell-source.js';
import type { Clock } from './source.js';

// Test doubles shared by this package's tests. Time only moves when a test calls advance().
export class FakeClock implements Clock {
  #now: number;
  #nextHandle = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start: string) {
    this.#now = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { at: this.#now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .toSorted(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = until;
  }
}

// A bridge process that records requests and answers only when the test says so, so "hangs" is
// simply not answering.
export class FakeBridge implements BridgeProcess {
  readonly requests: Record<string, unknown>[] = [];
  killed = false;
  #lineListeners: ((line: string) => void)[] = [];
  #exitListeners: ((reason: string) => void)[] = [];

  write(line: string): void {
    this.requests.push(JSON.parse(line) as Record<string, unknown>);
  }

  onLine(listener: (line: string) => void): void {
    this.#lineListeners.push(listener);
  }

  onExit(listener: (reason: string) => void): void {
    this.#exitListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  emit(line: string): void {
    for (const listener of this.#lineListeners) listener(line);
  }

  reply(id: unknown, result: unknown): void {
    this.emit(JSON.stringify({ id, result }));
  }

  exit(reason: string): void {
    for (const listener of this.#exitListeners) listener(reason);
  }
}
