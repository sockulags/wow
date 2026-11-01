import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createConnection, reconnectDelay, RpcClientError } from './connection.js';
import { endpointFromServerInfo, endpointFromUrl } from './endpoint.js';
import type { SocketFactory, SocketHandlers } from './socket.js';
import { createSubscriptionStore } from './subscription-store.js';

class FakeServer {
  readonly sockets: { url: string; handlers: SocketHandlers; sent: unknown[]; closed: boolean }[] =
    [];

  readonly factory: SocketFactory = (url, handlers) => {
    const socket = { url, handlers, sent: [] as unknown[], closed: false };
    this.sockets.push(socket);
    return {
      send: (data) => socket.sent.push(JSON.parse(data)),
      close: () => {
        socket.closed = true;
        handlers.onClose();
      },
    };
  };

  get current() {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('no socket');
    return socket;
  }

  push(message: unknown) {
    this.current.handlers.onMessage(JSON.stringify(message));
  }
}

describe('endpoints', () => {
  it('builds a loopback URL from server.json', () => {
    expect(endpointFromServerInfo('{"port":4317,"token":"a b","pid":12}')).toBe(
      'ws://127.0.0.1:4317/?token=a%20b',
    );
  });

  it('rejects a server.json without a token', () => {
    expect(() => endpointFromServerInfo({ port: 4317 })).toThrow(/token/);
  });

  it('turns an http dev URL into a WebSocket URL with the token', () => {
    expect(endpointFromUrl('http://localhost:4317', 't')).toBe('ws://localhost:4317/?token=t');
    expect(() => endpointFromUrl('ftp://x')).toThrow(/protocol/);
  });
});

describe('connection', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues requests until open and resolves them by id', async () => {
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    const answer = connection.request('ping', { n: 1 });
    expect(server.current.sent).toEqual([]);
    server.current.handlers.onOpen();
    expect(server.current.sent).toEqual([{ id: '1', method: 'ping', params: { n: 1 } }]);
    server.push({ id: '1', result: 'pong' });
    await expect(answer).resolves.toBe('pong');
    expect(connection.state.getState().status).toBe('open');
  });

  it('rejects with the server error', async () => {
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    server.current.handlers.onOpen();
    const answer = connection.request('nope');
    server.push({ id: '1', error: { code: 'unknown_method', message: 'no such method' } });
    await expect(answer).rejects.toBeInstanceOf(RpcClientError);
  });

  it('reconnects with backoff and subscribes again', () => {
    const connection = createConnection({
      url: 'ws://x',
      socket: server.factory,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    const seen: unknown[] = [];
    connection.subscribe('threads', null, (data) => seen.push(data));
    server.current.handlers.onOpen();
    expect(server.current.sent).toEqual([
      { id: '1', method: 'subscribe', params: { name: 'threads', params: null } },
    ]);

    server.current.handlers.onClose();
    expect(connection.state.getState()).toEqual({ status: 'reconnecting', attempts: 1 });
    vi.advanceTimersByTime(99);
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(server.sockets).toHaveLength(2);

    server.current.handlers.onClose();
    vi.advanceTimersByTime(200);
    expect(server.sockets).toHaveLength(3);

    server.current.handlers.onOpen();
    expect(connection.state.getState()).toEqual({ status: 'open', attempts: 0 });
    expect(server.current.sent).toEqual([
      { id: '2', method: 'subscribe', params: { name: 'threads', params: null } },
    ]);
    server.push({ subscription: 'threads', data: ['t1'] });
    expect(seen).toEqual([['t1']]);
  });

  it('caps the backoff delay', () => {
    const options = { initialDelayMs: 500, maxDelayMs: 10_000 };
    expect([1, 2, 3, 10].map((attempt) => reconnectDelay(attempt, options))).toEqual([
      500, 1000, 2000, 10_000,
    ]);
  });

  it('fails in-flight requests when the socket drops', async () => {
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    server.current.handlers.onOpen();
    const answer = connection.request('slow');
    server.current.handlers.onClose();
    await expect(answer).rejects.toThrow('Connection lost');
  });

  it('stops reconnecting after close', () => {
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    server.current.handlers.onOpen();
    connection.close();
    expect(connection.state.getState().status).toBe('closed');
    vi.runAllTimers();
    expect(server.sockets).toHaveLength(1);
  });

  it('unsubscribes when the last listener leaves', () => {
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    server.current.handlers.onOpen();
    const stop = connection.subscribe('threads', null, () => undefined);
    stop();
    expect(server.current.sent.at(-1)).toEqual({
      id: '2',
      method: 'unsubscribe',
      params: { name: 'threads' },
    });
  });
});

describe('subscription store', () => {
  it('keeps the last valid snapshot and reports rejected pushes', () => {
    const server = new FakeServer();
    const connection = createConnection({ url: 'ws://x', socket: server.factory });
    server.current.handlers.onOpen();
    const store = createSubscriptionStore(connection, 'count', z.number());
    expect(store.getState()).toEqual({ data: undefined, error: undefined });
    server.push({ subscription: 'count', data: 3 });
    expect(store.getState()).toEqual({ data: 3, error: undefined });
    server.push({ subscription: 'count', data: 'three' });
    expect(store.getState().data).toBe(3);
    expect(store.getState().error).toBeDefined();
    store.dispose();
  });
});
