import { describe, expect, it } from 'vitest';
import { traySummary, trayMenu } from './tray-menu.js';

// Chief of staff spec 16: the tray lists the first rows of the decision queue under "N need you",
// and both open the Assistant, where the queue is.

describe('the decision queue in the tray', () => {
  it('counts the queue and lists its first three rows in its order', () => {
    const summary = traySummary(
      [{ state: 'needs_you' }],
      [],
      [],
      new Date('2026-11-10T08:00:00.000Z'),
      () => '09:00',
      [
        { title: 'Allow pnpm test' },
        { title: 'deliver-work waits' },
        { title: 'Yes?' },
        { title: 'Fourth' },
      ],
    );
    expect(summary).toMatchObject({
      needsYou: 4,
      queue: ['Allow pnpm test', 'deliver-work waits', 'Yes?'],
    });
    const menu = trayMenu({
      serverReady: true,
      schedulerPaused: false,
      updateReady: undefined,
      ...summary,
    });
    expect(menu.slice(0, 4)).toEqual([
      { kind: 'item', label: '4 need you', action: 'openAssistant', enabled: true },
      { kind: 'item', label: '  Allow pnpm test', action: 'openAssistant', enabled: true },
      { kind: 'item', label: '  deliver-work waits', action: 'openAssistant', enabled: true },
      { kind: 'item', label: '  Yes?', action: 'openAssistant', enabled: true },
    ]);
  });

  it('falls back to threads, opening Chat, before the queue arrives', () => {
    const summary = traySummary(
      [{ state: 'needs_you' }, { state: 'needs_you' }],
      [],
      [],
      new Date(),
      () => '',
    );
    expect(
      trayMenu({
        serverReady: true,
        schedulerPaused: false,
        updateReady: undefined,
        ...summary,
      })[0],
    ).toEqual({ kind: 'item', label: '2 need you', action: 'openChat', enabled: true });
  });
});
