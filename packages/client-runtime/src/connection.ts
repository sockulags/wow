import { RpcRequest, ServerMessage, type RpcError } from '@wow/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { webSocketFactory, type SocketFactory, type SocketHandle } from './socket.js';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  // Consecutive failed attempts since the last successful open.
  readonly attempts: number;
}

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ConnectionOptions {
  readonly url: string;
  readonly socket?: SocketFactory;
  // An option rather than a setting: settings themselves arrive over this connection.
  readonly reconnect?: ReconnectOptions;
  readonly subscribeMethod?: string;
  readonly unsubscribeMethod?: string;
}

export class RpcClientError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcClientError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface Connection {
  readonly state: StoreApi<ConnectionState>;
  request(method: string, params?: unknown): Promise<unknown>;
  // Subscribes now and again after every reconnect. Returns a function that stops listening.
  subscribe(name: string, params: unknown, onData: (data: unknown) => void): () => void;
  close(): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface Subscription {
  readonly params: unknown;
  readonly listeners: Set<(data: unknown) => void>;
}

const defaultReconnect: ReconnectOptions = { initialDelayMs: 500, maxDelayMs: 10_000 };

const ignore: Pending = { resolve: () => undefined, reject: () => undefined };

export function reconnectDelay(attempt: number, options: ReconnectOptions): number {
  return Math.min(options.initialDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs);
}

export function createConnection(options: ConnectionOptions): Connection {
  const factory = options.socket ?? webSocketFactory;
  const reconnect = options.reconnect ?? defaultReconnect;
  const subscribeMethod = options.subscribeMethod ?? 'subscribe';
  const unsubscribeMethod = options.unsubscribeMethod ?? 'unsubscribe';

  const state = createStore<ConnectionState>(() => ({ status: 'connecting', attempts: 0 }));
  const inFlight = new Map<string, Pending>();
  const queued: { request: RpcRequest; pending: Pending }[] = [];
  const subscriptions = new Map<string, Subscription>();
  let socket: SocketHandle | undefined;
  let open = false;
  let closedByUser = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;

  const transmit = (request: RpcRequest, pending: Pending) => {
    inFlight.set(request.id, pending);
    socket?.send(JSON.stringify(RpcRequest.parse(request)));
  };

  const makeRequest = (method: string, params: unknown): RpcRequest => ({
    id: String(nextId++),
    method,
    params,
  });

  const handleMessage = (raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if ('subscription' in message) {
      for (const listener of subscriptions.get(message.subscription)?.listeners ?? []) {
        listener(message.data);
      }
      return;
    }
    const pending = inFlight.get(message.id);
    if (!pending) return;
    inFlight.delete(message.id);
    if ('error' in message) pending.reject(new RpcClientError(message.error));
    else pending.resolve(message.result);
  };

  const connect = () => {
    retryTimer = undefined;
    state.setState({ status: state.getState().attempts === 0 ? 'connecting' : 'reconnecting' });
    socket = factory(options.url, {
      onOpen: () => {
        open = true;
        state.setState({ status: 'open', attempts: 0 });
        for (const [name, subscription] of subscriptions) {
          transmit(makeRequest(subscribeMethod, { name, params: subscription.params }), ignore);
        }
        for (const item of queued.splice(0)) transmit(item.request, item.pending);
      },
      onMessage: handleMessage,
      onClose: () => {
        open = false;
        socket = undefined;
        for (const pending of inFlight.values()) pending.reject(new Error('Connection lost'));
        inFlight.clear();
        if (closedByUser) {
          state.setState({ status: 'closed' });
          return;
        }
        const attempts = state.getState().attempts + 1;
        state.setState({ status: 'reconnecting', attempts });
        retryTimer = setTimeout(connect, reconnectDelay(attempts, reconnect));
      },
    });
  };

  connect();

  return {
    state,
    request(method, params = null) {
      return new Promise<unknown>((resolve, reject) => {
        if (closedByUser) {
          reject(new Error('Connection closed'));
          return;
        }
        const request = makeRequest(method, params);
        const pending = { resolve, reject };
        if (open) transmit(request, pending);
        else queued.push({ request, pending });
      });
    },
    subscribe(name, params, onData) {
      let subscription = subscriptions.get(name);
      if (!subscription) {
        subscription = { params, listeners: new Set() };
        subscriptions.set(name, subscription);
        if (open) transmit(makeRequest(subscribeMethod, { name, params }), ignore);
      }
      subscription.listeners.add(onData);
      const current = subscription;
      return () => {
        current.listeners.delete(onData);
        if (current.listeners.size > 0 || subscriptions.get(name) !== current) return;
        subscriptions.delete(name);
        if (open) transmit(makeRequest(unsubscribeMethod, { name }), ignore);
      };
    },
    close() {
      closedByUser = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      for (const item of queued.splice(0)) item.pending.reject(new Error('Connection closed'));
      if (socket) socket.close();
      else state.setState({ status: 'closed' });
    },
  };
}
