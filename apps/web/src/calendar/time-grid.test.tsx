import type { CalendarItem } from '@wow/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRuntime } from '@/test/render';
import { TimeGrid, type TimeGridProps } from './time-grid';
import { parseIsoDate, type LocalDate } from './time';

const zone = 'Europe/Stockholm';
const day = parseIsoDate('2026-11-03') as LocalDate;

const item = (id: string, start: string, end: string, extra: Partial<CalendarItem> = {}) =>
  ({
    id,
    source: 'local',
    externalId: null,
    title: id,
    start,
    end,
    zone,
    allDay: false,
    location: null,
    joinUrl: null,
    body: null,
    organizer: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: start,
    ...extra,
  }) satisfies CalendarItem;

const items = [
  item('Standup', '2026-11-03T08:15:00.000Z', '2026-11-03T08:30:00.000Z', {
    source: 'outlook',
    externalId: 'standup',
    location: 'https://teams.microsoft.com/l/meetup-join/invented',
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/invented',
    organizer: 'Ada Lindqvist',
  }),
  item('Focus', '2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00.000Z'),
  item('Feature run', '2026-11-03T13:00:00.000Z', '2026-11-03T14:00:00.000Z', {
    workflowId: 'wf',
    projectId: 'demo',
    state: 'waiting',
  }),
  item('Lost run', '2026-11-03T15:00:00.000Z', '2026-11-03T16:00:00.000Z', { workflowId: 'wf' }),
];

function setup(overrides: Partial<TimeGridProps> = {}) {
  const props: TimeGridProps = {
    view: 'day',
    days: [day],
    today: day,
    items,
    zone,
    workHours: { start: '08:00', end: '17:00', days: ['tuesday'] },
    snap: 15,
    cardMinutes: 30,
    maxColumns: 2,
    hourHeight: 48,
    onZoom: () => true,
    onCreate: vi.fn<TimeGridProps['onCreate']>(),
    onEdit: vi.fn<TimeGridProps['onEdit']>(),
    onChange: vi.fn<TimeGridProps['onChange']>(() => Promise.resolve()),
    ...overrides,
  };
  renderWithRuntime(<TimeGrid {...props} />);
  return props;
}

const block = (name: RegExp) => screen.getByRole('button', { name });

describe('TimeGrid', () => {
  it('shows a state only on triggers and warns about a workflow without a project', () => {
    setup();
    expect(block(/^Focus, /).textContent).not.toMatch(/Scheduled/);
    expect(block(/^Feature run, /)).toHaveProperty(
      'ariaLabel',
      'Feature run, 14:00–15:00, needs you',
    );
    expect(block(/^Feature run, /).textContent).toContain('Needs you');
    expect(block(/^Lost run, /)).toHaveProperty(
      'ariaLabel',
      'Lost run, 16:00–17:00, no project, will not run',
    );
  });

  it('is one Tab stop and moves with the arrow keys', () => {
    const props = setup();
    const stops = document.querySelectorAll('[data-stop]');
    expect([...stops].filter((stop) => stop.getAttribute('tabindex') === '0')).toHaveLength(1);
    const standup = block(/^Standup, /);
    standup.focus();
    fireEvent.keyDown(standup, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(block(/^Focus, /));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(block(/^Lost run, /));
    expect(block(/^Lost run, /).getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(block(/^Lost run, /), { key: 'Enter' });
    expect(props.onEdit).toHaveBeenCalledWith('Lost run');
  });

  it('moves and resizes a card with Alt and the arrow keys', () => {
    const props = setup();
    const focus = block(/^Focus, /);
    focus.focus();
    fireEvent.keyDown(focus, { key: 'ArrowDown', altKey: true });
    expect(props.onChange).toHaveBeenLastCalledWith('Focus', {
      start: '2026-11-03T09:15:00.000Z',
      end: '2026-11-03T10:15:00.000Z',
    });
    fireEvent.keyDown(block(/^Focus, /), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(props.onChange).toHaveBeenLastCalledWith('Focus', {
      start: '2026-11-03T09:15:00.000Z',
      end: '2026-11-03T10:00:00.000Z',
    });
    expect(document.activeElement).toBe(block(/^Focus, /));
  });

  it('opens a meeting with Enter and shows it as a Teams meeting', async () => {
    const props = setup();
    const standup = block(/^Standup, /);
    standup.focus();
    fireEvent.keyDown(standup, { key: 'Enter' });
    const details = await screen.findByTestId('outlook-details');
    expect(details.textContent).toContain('Teams meeting');
    expect(details.textContent).toContain('Ada Lindqvist');
    expect(details.textContent).not.toContain('https://');
    fireEvent.click(screen.getByRole('button', { name: 'Card after' }));
    expect(props.onCreate).toHaveBeenCalledWith({
      start: '2026-11-03T08:30:00.000Z',
      end: '2026-11-03T09:00:00.000Z',
    });
  });

  it('puts the rest of a crowded week-view cluster behind "+N"', () => {
    const crowd = ['A', 'B', 'C'].map((id) =>
      item(id, '2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00.000Z'),
    );
    setup({ view: 'week', items: crowd });
    expect(screen.getByRole('button', { name: '2 more items' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^B, / })).toBeNull();
  });
});
