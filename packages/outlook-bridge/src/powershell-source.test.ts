import { describe, expect, it } from 'vitest';
import { PowershellOutlookSource } from './powershell-source.js';
import { OutlookError } from './source.js';
import { FakeBridge, FakeClock } from './testing.js';

function setup(timeoutMs = 5000) {
  const clock = new FakeClock('2026-11-04T09:00:00Z');
  const bridges: FakeBridge[] = [];
  const source = new PowershellOutlookSource({
    requestTimeoutMs: () => timeoutMs,
    clock,
    spawn: () => {
      const bridge = new FakeBridge();
      bridges.push(bridge);
      return bridge;
    },
  });
  const current = (): FakeBridge => {
    const bridge = bridges.at(-1);
    if (!bridge) throw new Error('no bridge started');
    return bridge;
  };
  return { clock, bridges, source, current };
}

describe('PowershellOutlookSource', () => {
  it('starts the bridge lazily and matches answers to request ids in any order', async () => {
    const { source, bridges, current } = setup();
    expect(bridges).toHaveLength(0);
    const ping = source.ping();
    const mail = source.unreadMail(['Inbox'], 10);
    expect(current().requests).toEqual([
      { id: 1, op: 'ping' },
      { id: 2, op: 'unreadMail', folders: ['Inbox'], limit: 10 },
    ]);
    current().reply(2, { items: [], unreadCount: 3 });
    current().emit('not json from a profile script');
    current().reply(1, { version: '1', outlook: 'available', message: null });
    await expect(mail).resolves.toEqual({ items: [], unreadCount: 3 });
    await expect(ping).resolves.toMatchObject({ version: '1' });
    expect(source.starts).toBe(1);
  });

  it('turns bridge errors and malformed answers into OutlookErrors', async () => {
    const { source, current } = setup();
    const calendar = source.calendar({ from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' });
    current().emit(
      JSON.stringify({ id: 1, error: { code: 'unavailable', message: 'Outlook is not running' } }),
    );
    await expect(calendar).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Outlook is not running',
    });

    const open = source.open('abc');
    current().reply(2, { opened: 'maybe' });
    await expect(open).rejects.toMatchObject({ code: 'protocol' });
  });

  it('times out a hung request, kills the bridge and restarts it on the next request', async () => {
    const { source, clock, bridges, current } = setup(5000);
    const hung = source.calendar({ from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z' });
    const queued = source.ping();
    clock.advance(4999);
    expect(bridges[0]?.killed).toBe(false);
    clock.advance(1);
    await expect(hung).rejects.toMatchObject({ code: 'timeout' });
    await expect(queued).rejects.toBeInstanceOf(OutlookError);
    expect(bridges[0]?.killed).toBe(true);
    expect(clock.pendingTimers).toBe(0);

    const retry = source.ping();
    expect(source.starts).toBe(2);
    // A late answer from the killed process must not reach the new request.
    bridges[0]?.reply(3, { version: 'stale', outlook: 'available', message: null });
    current().reply(3, { version: '1', outlook: 'unavailable', message: 'Outlook is not running' });
    await expect(retry).resolves.toMatchObject({ version: '1', outlook: 'unavailable' });
  });

  it('fails pending requests when the bridge exits and starts a new one afterwards', async () => {
    const { source, current } = setup();
    const ping = source.ping();
    current().exit('bridge exited (code 1): Outlook.Application not registered');
    await expect(ping).rejects.toMatchObject({
      code: 'exited',
      message: 'bridge exited (code 1): Outlook.Application not registered',
    });
    const next = source.ping();
    expect(source.starts).toBe(2);
    current().reply(2, { version: '1', outlook: 'available', message: null });
    await expect(next).resolves.toMatchObject({ outlook: 'available' });
  });

  it('reads the timeout setting for every request', async () => {
    let timeoutMs = 1000;
    const clock = new FakeClock('2026-11-04T09:00:00Z');
    const source = new PowershellOutlookSource({
      requestTimeoutMs: () => timeoutMs,
      clock,
      spawn: () => new FakeBridge(),
    });
    timeoutMs = 3000;
    const ping = source.ping();
    clock.advance(2000);
    clock.advance(1000);
    await expect(ping).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('3000 ms'),
    });
  });

  it('rejects pending requests on close', async () => {
    const { source, bridges } = setup();
    const ping = source.ping();
    await source.close();
    await expect(ping).rejects.toMatchObject({ code: 'exited' });
    expect(bridges[0]?.killed).toBe(true);
  });
});
