// The connection talks to a socket through this small interface so tests can drive it without a
// network and a later mobile client can plug in its own transport.

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
}

export interface SocketHandle {
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

export const webSocketFactory: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  // A failed connect fires error and then close; close alone drives reconnection.
  socket.addEventListener('close', () => handlers.onClose());
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
};
