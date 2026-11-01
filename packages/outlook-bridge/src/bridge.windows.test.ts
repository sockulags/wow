import { afterAll, describe, expect, it } from 'vitest';
import { PowershellOutlookSource } from './powershell-source.js';

// Runs the real bridge.ps1 under Windows PowerShell. CI runners have no Outlook, so this checks the
// "unavailable" path: the bridge starts, answers, and reports Outlook missing without crashing.
describe.runIf(process.platform === 'win32')('bridge.ps1 without Outlook', () => {
  const source = new PowershellOutlookSource({ requestTimeoutMs: () => 60_000 });
  afterAll(() => source.close());

  it('answers ping with unavailable', { timeout: 90_000 }, async () => {
    await expect(source.ping()).resolves.toEqual({
      version: '1',
      outlook: 'unavailable',
      message: 'Outlook is not running',
    });
  });

  it('rejects reads with an unavailable error and keeps running', { timeout: 90_000 }, async () => {
    await expect(
      source.calendar({ from: '2026-11-02T00:00:00+01:00', to: '2026-11-09T00:00:00+01:00' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(source.unreadMail(['Inbox'], 10)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(source.ping()).resolves.toMatchObject({ outlook: 'unavailable' });
    expect(source.starts).toBe(1);
  });
});
