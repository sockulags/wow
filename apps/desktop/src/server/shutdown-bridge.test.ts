import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { shutdownMessage } from '../app.js';
import { installShutdownBridge, type ServerProcessLike } from './shutdown-bridge.js';

const fakeProcess = () => new EventEmitter() as EventEmitter & ServerProcessLike;

describe('installShutdownBridge', () => {
  it('turns the shutdown message into SIGTERM once', () => {
    const target = fakeProcess();
    const received: string[] = [];
    target.on('SIGTERM', (signal: string) => received.push(signal));
    installShutdownBridge(target);
    target.emit('message', { type: 'something else' });
    target.emit('message', shutdownMessage);
    target.emit('disconnect');
    expect(received).toEqual(['SIGTERM']);
  });

  it('stops the server when the desktop goes away', () => {
    const target = fakeProcess();
    let stopped = false;
    target.on('SIGTERM', () => {
      stopped = true;
    });
    installShutdownBridge(target);
    target.emit('disconnect');
    expect(stopped).toBe(true);
  });

  it('waits for the entry to listen when shutdown arrives during startup', async () => {
    const target = fakeProcess();
    installShutdownBridge(target);
    target.emit('message', shutdownMessage);
    const stopped = new Promise<string>((resolve) => target.on('SIGTERM', resolve));
    await expect(stopped).resolves.toBe('SIGTERM');
  });
});
