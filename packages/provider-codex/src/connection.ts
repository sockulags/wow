import type {
  ClientNotificationMethod,
  ClientRequests,
  RequestId,
  ServerNotifications,
  ServerRequests,
} from './protocol/generated/index.js';
import type { CodexProcess } from './process.js';

export class CodexError extends Error {
  readonly code: 'exited' | 'timeout' | 'rpc' | 'protocol' | 'unsupported' | 'auth' | 'state';
  constructor(code: CodexError['code'], message: string) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
  }
}

export type ServerNotification = {
  [M in keyof ServerNotifications]: { method: M; params: ServerNotifications[M] };
}[keyof ServerNotifications];

export type ServerRequest = {
  [M in keyof ServerRequests]: { id: RequestId; method: M; params: ServerRequests[M]['params'] };
}[keyof ServerRequests];

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ConnectionHandlers {
  notification(message: ServerNotification): void;
  request(message: ServerRequest): void;
  // A server request whose method this build does not know; the connection already declined it.
  unknownRequest?(method: string): void;
  exit(error: CodexError): void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexError) => void;
  readonly timer: unknown;
}

const knownServerRequests = new Set<string>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
] satisfies (keyof ServerRequests)[]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === 'string' || typeof value === 'number';

// Newline-delimited JSON-RPC over the app-server's stdio. codex leaves out the "jsonrpc" member,
// so messages are told apart by which of id, method, result and error they carry.
export class CodexConnection {
  readonly #process: CodexProcess;
  readonly #handlers: ConnectionHandlers;
  readonly #timeoutMs: () => number;
  readonly #timers: Timers;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: CodexError | null = null;

  constructor(
    process: CodexProcess,
    handlers: ConnectionHandlers,
    timeoutMs: () => number,
    timers: Timers = systemTimers,
  ) {
    this.#process = process;
    this.#handlers = handlers;
    this.#timeoutMs = timeoutMs;
    this.#timers = timers;
    process.onLine((line) => this.#receive(line));
    process.onExit((reason) => this.#close(new CodexError('exited', reason)));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  request<M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
  ): Promise<ClientRequests[M]['result']> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.#timeoutMs();
      const timer = this.#timers.set(() => {
        this.#pending.delete(id);
        reject(
          new CodexError('timeout', `codex did not answer "${method}" within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.#process.write(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: ClientNotificationMethod): void {
    if (!this.#closed) this.#process.write(JSON.stringify({ method }));
  }

  respond<M extends keyof ServerRequests>(
    id: RequestId,
    _method: M,
    result: ServerRequests[M]['result'],
  ): void {
    if (!this.#closed) this.#process.write(JSON.stringify({ id, result }));
  }

  respondError(id: RequestId, code: number, message: string): void {
    if (!this.#closed) this.#process.write(JSON.stringify({ id, error: { code, message } }));
  }

  close(): void {
    this.#close(new CodexError('exited', 'codex app-server was stopped'));
  }

  #receive(line: string): void {
    if (this.#closed) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // codex writes logs to stderr; anything else that is not JSON is ignored the same way.
      return;
    }
    if (!isRecord(message)) return;
    const { id, method } = message;
    if (typeof method === 'string') {
      if (isRequestId(id)) this.#serverRequest(id, method, message['params']);
      else
        this.#handlers.notification({
          method,
          params: message['params'],
        } as ServerNotification);
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.#timers.clear(pending.timer);
    const error = message['error'];
    if (isRecord(error)) {
      const text = typeof error['message'] === 'string' ? error['message'] : 'unknown error';
      pending.reject(new CodexError('rpc', `codex rejected "${pending.method}": ${text}`));
    } else pending.resolve(message['result']);
  }

  #serverRequest(id: RequestId, method: string, params: unknown): void {
    if (!knownServerRequests.has(method)) {
      // Answer at once so codex does not wait on a request nobody will handle.
      this.respondError(id, -32601, `wow does not handle ${method}`);
      this.#handlers.unknownRequest?.(method);
      return;
    }
    this.#handlers.request({ id, method, params } as ServerRequest);
  }

  #close(error: CodexError): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      this.#timers.clear(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#process.kill();
    this.#handlers.exit(error);
  }
}
