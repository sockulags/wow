import { RpcRequest, ServerMessage, type RpcError, type SubscriptionTopic } from '@wow/contracts';
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

// Thread-scoped topics (turns, threadItems, approvals, questions) need a threadId.
export interface TopicParams {
  readonly threadId?: string;
}

export interface Connection {
  readonly state: StoreApi<ConnectionState>;
  request(method: string, params?: unknown): Promise<unknown>;
  // Subscribes now and again after every reconnect, and calls onData with the topic's current rows
  // whenever the server sends them. A second listener of the same topic shares the server
  // subscription and gets the last rows at once. Returns a function that stops listening.
  subscribe(
    topic: SubscriptionTopic,
    params: TopicParams | null,
    onData: (data: unknown) => void,
  ): () => void;
  // Tries to connect now instead of waiting for the next scheduled attempt ("Retry now").
  retry(): void;
  close(): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface Subscription {
  readonly topic: SubscriptionTopic;
  readonly threadId: string | undefined;
  readonly listeners: Set<(data: unknown) => void>;
  // The server's id for the current socket; undefined until the subscribe answer arrives.
  serverId: string | undefined;
  last: unknown;
  hasLast: boolean;
}

const subscriptionKey = (topic: string, threadId: string | undefined) =>
  threadId === undefined ? topic : `${topic}:${threadId}`;

const isSubscribeResult = (value: unknown): value is { subscriptionId: string; data: unknown } =>
  typeof value === 'object' &&
  value !== null &&
  'subscriptionId' in value &&
  typeof value.subscriptionId === 'string' &&
  'data' in value;

const defaultReconnect: ReconnectOptions = { initialDelayMs: 500, maxDelayMs: 10_000 };

const ignore: Pending = { resolve: () => undefined, reject: () => undefined };

export function reconnectDelay(attempt: number, options: ReconnectOptions): number {
  return Math.min(options.initialDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs);
}

export function createConnection(options: ConnectionOptions): Connection {
  const factory = options.socket ?? webSocketFactory;
  const reconnect = options.reconnect ?? defaultReconnect;

  const state = createStore<ConnectionState>(() => ({ status: 'connecting', attempts: 0 }));
  const inFlight = new Map<string, Pending>();
  const queued: { request: RpcRequest; pending: Pending }[] = [];
  const subscriptions = new Map<string, Subscription>();
  // Server subscription id -> key in `subscriptions`, for the current socket only.
  const byServerId = new Map<string, string>();
  // The server sends its subscribe answer after its own microtasks, so a commit's push can reach
  // this socket first. While an answer is awaited, the newest push of an id not yet known is kept
  // and delivered after that answer's rows.
  const early = new Map<string, unknown>();
  let awaitingAnswers = 0;
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
      const key = byServerId.get(message.subscription);
      const subscription = key === undefined ? undefined : subscriptions.get(key);
      if (subscription) deliver(subscription, message.data);
      else if (key === undefined && awaitingAnswers > 0)
        early.set(message.subscription, message.data);
      return;
    }
    const pending = inFlight.get(message.id);
    if (!pending) return;
    inFlight.delete(message.id);
    if ('error' in message) pending.reject(new RpcClientError(message.error));
    else pending.resolve(message.result);
  };

  const deliver = (subscription: Subscription, data: unknown) => {
    subscription.last = data;
    subscription.hasLast = true;
    for (const listener of subscription.listeners) listener(data);
  };

  const sendSubscribe = (key: string, subscription: Subscription) => {
    const params =
      subscription.threadId === undefined
        ? { topic: subscription.topic }
        : { topic: subscription.topic, threadId: subscription.threadId };
    awaitingAnswers += 1;
    const answered = () => {
      awaitingAnswers -= 1;
      if (awaitingAnswers === 0) early.clear();
    };
    transmit(makeRequest('subscribe', params), {
      resolve: (result) => {
        const pushed =
          isSubscribeResult(result) && early.has(result.subscriptionId)
            ? { data: early.get(result.subscriptionId) }
            : undefined;
        if (isSubscribeResult(result)) early.delete(result.subscriptionId);
        answered();
        if (!isSubscribeResult(result)) return;
        // Stopped while the answer was on its way, or replaced by a newer subscription.
        if (subscriptions.get(key) !== subscription) {
          transmit(makeRequest('unsubscribe', { subscriptionId: result.subscriptionId }), ignore);
          return;
        }
        subscription.serverId = result.subscriptionId;
        byServerId.set(result.subscriptionId, key);
        deliver(subscription, result.data);
        if (pushed) deliver(subscription, pushed.data);
      },
      reject: answered,
    });
  };

  const connect = () => {
    retryTimer = undefined;
    state.setState({ status: state.getState().attempts === 0 ? 'connecting' : 'reconnecting' });
    socket = factory(options.url, {
      onOpen: () => {
        open = true;
        state.setState({ status: 'open', attempts: 0 });
        for (const [key, subscription] of subscriptions) sendSubscribe(key, subscription);
        for (const item of queued.splice(0)) transmit(item.request, item.pending);
      },
      onMessage: handleMessage,
      onClose: () => {
        open = false;
        socket = undefined;
        // Server subscriptions end with their connection; the next open subscribes again.
        byServerId.clear();
        for (const subscription of subscriptions.values()) subscription.serverId = undefined;
        for (const pending of inFlight.values()) pending.reject(new Error('Connection lost'));
        inFlight.clear();
        early.clear();
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
    subscribe(topic, params, onData) {
      const threadId = params?.threadId;
      const key = subscriptionKey(topic, threadId);
      let subscription = subscriptions.get(key);
      if (!subscription) {
        subscription = {
          topic,
          threadId,
          listeners: new Set(),
          serverId: undefined,
          last: undefined,
          hasLast: false,
        };
        subscriptions.set(key, subscription);
        if (open) sendSubscribe(key, subscription);
      } else if (subscription.hasLast) {
        onData(subscription.last);
      }
      subscription.listeners.add(onData);
      const current = subscription;
      return () => {
        current.listeners.delete(onData);
        if (current.listeners.size > 0 || subscriptions.get(key) !== current) return;
        subscriptions.delete(key);
        const { serverId } = current;
        if (serverId === undefined) return;
        byServerId.delete(serverId);
        if (open) transmit(makeRequest('unsubscribe', { subscriptionId: serverId }), ignore);
      };
    },
    retry() {
      if (closedByUser || retryTimer === undefined) return;
      clearTimeout(retryTimer);
      connect();
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
