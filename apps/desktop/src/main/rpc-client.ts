import {
  ServerMessage,
  rpcMethods,
  subscriptionTopics,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type SubscriptionTopic,
  type TopicRow,
} from '@wow/contracts';
import { WebSocket } from 'ws';
import { z } from 'zod';

export class RpcRequestError extends Error {
  readonly code: string;

  constructor(method: string, error: RpcError) {
    super(`${method}: ${error.message}`);
    this.name = 'RpcRequestError';
    this.code = error.code;
  }
}

interface Pending {
  readonly method: RpcMethod;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

// The main process's own connection to the server: requests plus topic subscriptions. It does not
// reconnect; the server is the desktop's child, so a dropped socket means the server is gone and
// the lifecycle starts it again.
export class RpcClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<string, (data: unknown) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #onProblem: (message: string, error: unknown) => void;
  #nextId = 1;

  private constructor(socket: WebSocket, onProblem: (message: string, error: unknown) => void) {
    this.#socket = socket;
    this.#onProblem = onProblem;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      this.#receive(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    });
    socket.on('close', () => {
      const closed = new Error('The server connection closed.');
      for (const pending of this.#pending.values()) pending.reject(closed);
      this.#pending.clear();
      this.#subscriptions.clear();
      for (const listener of this.#closeListeners) listener();
    });
  }

  static connect(
    endpoint: { readonly port: number; readonly token: string },
    onProblem: (message: string, error: unknown) => void,
  ): Promise<RpcClient> {
    const url = `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`;
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.off('error', reject);
        socket.on('error', () => undefined);
        resolve(new RpcClient(socket, onProblem));
      });
      socket.once('error', reject);
    });
  }

  get open(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (!this.open) return Promise.reject(new Error('The server connection is closed.'));
    const id = String(this.#nextId++);
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: (result) => resolve(rpcMethods[method].result.parse(result) as RpcResult<M>),
        reject,
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  // Calls `onRows` with the topic's current rows now and after every change.
  async subscribe<T extends SubscriptionTopic>(
    topic: T,
    onRows: (rows: TopicRow<T>[]) => void,
  ): Promise<string> {
    const rowsSchema = z.array(subscriptionTopics[topic].row);
    const deliver = (data: unknown) => onRows(rowsSchema.parse(data) as TopicRow<T>[]);
    const { subscriptionId, data } = await this.request('subscribe', { topic });
    this.#subscriptions.set(subscriptionId, deliver);
    deliver(data);
    return subscriptionId;
  }

  close(): void {
    this.#socket.close();
  }

  #receive(text: string): void {
    let message: ServerMessage;
    try {
      message = ServerMessage.parse(JSON.parse(text));
    } catch (error) {
      this.#onProblem('unreadable server message', error);
      return;
    }
    if ('subscription' in message) {
      try {
        this.#subscriptions.get(message.subscription)?.(message.data);
      } catch (error) {
        this.#onProblem('subscription update failed', error);
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    try {
      if ('error' in message) pending.reject(new RpcRequestError(pending.method, message.error));
      else pending.resolve(message.result);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
