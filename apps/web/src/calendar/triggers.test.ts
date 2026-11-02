import type { AppNotification, CalendarItem, Trigger } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { freshNotifications } from '@/app/notifications';
import { calendarCommands, runNowCardIds } from './commands';

const card = (id: string, state: string): CalendarItem => ({
  id,
  source: 'local',
  externalId: null,
  title: `Card ${id}`,
  start: '2026-11-02T09:00:00.000Z',
  end: '2026-11-02T09:30:00.000Z',
  zone: 'UTC',
  allDay: false,
  location: null,
  joinUrl: null,
  body: null,
  projectId: 'p1',
  backlogItemId: null,
  workflowId: 'wf1',
  runId: null,
  state,
  updatedAt: '2026-11-02T08:00:00.000Z',
});

const trigger = (cardId: string, state: Trigger['state'], offerRunNow: boolean): Trigger => ({
  id: `${cardId}:trigger`,
  calendarItemId: cardId,
  workflowId: 'wf1',
  runAt: '2026-11-02T09:00:00.000Z',
  zone: 'UTC',
  state,
  runId: null,
  offerRunNow,
});

const notification = (id: string): AppNotification => ({
  id,
  at: '2026-11-02T09:00:00.000Z',
  kind: 'waiting',
  title: 'Waiting for you',
  body: '',
  path: '/workflows',
  runId: null,
  calendarItemId: null,
});

describe('Run now on missed cards (behavior 12)', () => {
  const cards = [card('marked', 'missed'), card('skipped', 'missed'), card('later', 'scheduled')];
  const triggers = [
    trigger('marked', 'missed', true),
    trigger('skipped', 'missed', false),
    trigger('later', 'scheduled', false),
  ];

  it('is offered only where the missed policy marked the card', () => {
    expect([...runNowCardIds(cards, triggers)]).toEqual(['marked']);
  });

  it('has a palette command next to Pause scheduler', () => {
    const titles = calendarCommands({
      search: undefined,
      cards,
      triggers,
      schedulerPaused: false,
    }).map((command) => command.title);
    expect(titles).toContain('Run now: Card marked');
    expect(titles).not.toContain('Run now: Card skipped');
    expect(titles).toContain('Pause scheduler');
    expect(
      calendarCommands({ search: undefined, cards, triggers, schedulerPaused: true }).map(
        (command) => command.title,
      ),
    ).toContain('Resume scheduler');
  });
});

describe('notification toasts', () => {
  it('shows only what arrives after the first snapshot, oldest first', () => {
    expect(freshNotifications(undefined, [notification('a')])).toEqual([]);
    expect(
      freshNotifications(new Set(['a']), [
        notification('c'),
        notification('b'),
        notification('a'),
      ]).map((row) => row.id),
    ).toEqual(['b', 'c']);
  });
});
