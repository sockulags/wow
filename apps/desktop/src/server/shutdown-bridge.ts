import { shutdownMessage } from '../app.js';

// The server's command-line entry stops on SIGINT/SIGTERM. Windows has no signals between
// processes, so the desktop sends a message over the IPC channel instead, and this turns it into
// the SIGTERM event the entry already listens for. When the desktop goes away without asking
// (crash, killed from Task Manager) the channel closes and the server stops the same way, so no
// orphaned server keeps the database open.
export interface ServerProcessLike {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  on(event: 'newListener', listener: (event: string | symbol) => void): unknown;
  off(event: 'newListener', listener: (event: string | symbol) => void): unknown;
  listenerCount(event: 'SIGTERM'): number;
  emit(event: 'SIGTERM', signal: 'SIGTERM'): boolean;
}

const isShutdown = (message: unknown): boolean =>
  typeof message === 'object' &&
  message !== null &&
  (message as { type?: unknown }).type === shutdownMessage.type;

export function installShutdownBridge(target: ServerProcessLike): void {
  let requested = false;
  const stop = () => {
    if (requested) return;
    requested = true;
    if (target.listenerCount('SIGTERM') > 0) {
      target.emit('SIGTERM', 'SIGTERM');
      return;
    }
    // Still starting: the entry adds its SIGTERM handler once the server is up.
    const waitForHandler = (event: string | symbol) => {
      if (event !== 'SIGTERM') return;
      target.off('newListener', waitForHandler);
      queueMicrotask(() => target.emit('SIGTERM', 'SIGTERM'));
    };
    target.on('newListener', waitForHandler);
  };
  target.on('message', (message) => {
    if (isShutdown(message)) stop();
  });
  target.on('disconnect', stop);
}
