import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Timers } from './connection.js';
import type { CodexProcess } from './process.js';

type Message = Record<string, unknown>;

export interface FixtureEntry {
  readonly dir: 'in' | 'out';
  readonly msg: Message;
}

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export function readFixture(name: string): FixtureEntry[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureEntry);
}

// A codex app-server that only exists in a test: lines the adapter writes are recorded, lines
// the test emits are delivered at once.
export class FakeCodexProcess implements CodexProcess {
  readonly written: Message[] = [];
  killed = false;
  readonly #lines: ((line: string) => void)[] = [];
  readonly #exits: ((reason: string) => void)[] = [];

  write(line: string): void {
    this.written.push(JSON.parse(line) as Message);
    this.received(this.written.at(-1) ?? {});
  }

  // Hook for subclasses that answer what the adapter wrote.
  protected received(_message: Message): void {}

  onLine(listener: (line: string) => void): void {
    this.#lines.push(listener);
  }

  onExit(listener: (reason: string) => void): void {
    this.#exits.push(listener);
  }

  kill(): void {
    this.killed = true;
  }

  emit(message: unknown): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    for (const listener of this.#lines) listener(line);
  }

  exit(reason: string): void {
    for (const listener of this.#exits) listener(reason);
  }
}

// Replays a recorded session. Each line the adapter writes must match the next "out" entry
// (same method, or an answer to the same server request); the "in" entries up to the next "out"
// are then delivered. Request ids are mapped, so the adapter may number its requests freely.
export class ReplayCodexProcess extends FakeCodexProcess {
  readonly mismatches: string[] = [];
  readonly #entries: FixtureEntry[];
  readonly #ids = new Map<unknown, unknown>();
  #position = 0;

  constructor(entries: FixtureEntry[]) {
    super();
    this.#entries = entries;
  }

  get remaining(): FixtureEntry[] {
    return this.#entries.slice(this.#position);
  }

  protected override received(message: Message): void {
    const expected = this.#entries[this.#position];
    if (!expected || expected.dir !== 'out') {
      this.mismatches.push(`unexpected ${JSON.stringify(message)}`);
      return;
    }
    const isRequest = typeof message['method'] === 'string';
    const matches = isRequest
      ? expected.msg['method'] === message['method']
      : !('method' in expected.msg) && expected.msg['id'] === message['id'];
    if (!matches) {
      this.mismatches.push(
        `expected ${JSON.stringify(expected.msg)}, got ${JSON.stringify(message)}`,
      );
      return;
    }
    if (isRequest && 'id' in expected.msg) this.#ids.set(expected.msg['id'], message['id']);
    this.#position += 1;
    this.flush();
  }

  // Delivers the "in" entries up to the next "out" entry.
  flush(): void {
    while (this.#entries[this.#position]?.dir === 'in') {
      const { msg } = this.#entries[this.#position] as FixtureEntry;
      this.#position += 1;
      const isResponse = !('method' in msg) && 'id' in msg;
      this.emit(isResponse ? { ...msg, id: this.#ids.get(msg['id']) ?? msg['id'] } : msg);
    }
  }
}

// Timers a test fires by hand; nothing waits on the clock.
export class ManualTimers implements Timers {
  readonly #timers = new Map<number, { callback: () => void; ms: number }>();
  #next = 1;

  set(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { callback, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  fireAll(): void {
    const timers = [...this.#timers.values()];
    this.#timers.clear();
    for (const timer of timers) timer.callback();
  }
}
