import {
  settingsRegistry,
  type CalendarItem,
  type CalendarOccurrence,
  type CalendarRange,
  type Command,
  type WorkflowRun,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox, type Outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';
import { noRepeat, repeatDraft, repeatRule } from './card-form';
import { calendarCommands } from './commands';
import { occurrenceBlocks, occurrenceId } from './occurrences';

// Repeating cards in the calendar (recurring cards spec 11 to 17, plan U2). The calendar draws
// what the server's range read answers; the card, its run and the range here are invented.

const zone = 'Europe/Stockholm';

const card: CalendarItem = {
  id: 'standup-notes',
  source: 'local',
  externalId: null,
  title: 'Standup notes',
  start: '2026-11-16T07:30:00.000Z',
  end: '2026-11-16T07:45:00.000Z',
  zone,
  allDay: false,
  location: null,
  joinUrl: null,
  body: null,
  organizer: null,
  projectId: 'demo',
  backlogItemId: null,
  workflowId: 'notes',
  runId: 'run-16',
  state: 'done',
  updatedAt: '2026-11-10T09:00:00.000Z',
  repeat: {
    frequency: 'weekly',
    interval: 1,
    weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    end: { kind: 'never' },
  },
  skippedDates: ['2026-11-13'],
  nextAt: '2026-11-17T07:30:00.000Z',
};

const run: WorkflowRun = {
  id: 'run-16',
  workflowId: 'notes',
  projectId: 'demo',
  calendarItemId: 'standup-notes',
  backlogItemId: null,
  state: 'done',
  currentStep: 0,
  steps: [],
  startedAt: '2026-11-16T07:30:00.000Z',
  endedAt: '2026-11-16T07:40:00.000Z',
  occurrence: { date: '2026-11-16', start: '2026-11-16T07:30:00.000Z' },
};

const at = (day: number, hour: number, minute = 30) =>
  new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString();

function occurrence(day: number, extra: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    cardId: card.id,
    date: `2026-11-${day}`,
    start: at(day, 7),
    end: at(day, 7, 45),
    repeating: true,
    next: false,
    record: null,
    ...extra,
  };
}

const fired = occurrence(16, {
  record: {
    date: '2026-11-16',
    start: at(16, 7),
    end: at(16, 7, 45),
    outcome: 'fired',
    runId: 'run-16',
    reason: null,
    offerRunNow: false,
    at: at(16, 7),
  },
});

const range = (more: string[] = []): CalendarRange => ({
  from: '2026-11-15T23:00:00.000Z',
  to: '2026-11-22T23:00:00.000Z',
  occurrences: [
    fired,
    occurrence(17, { next: true }),
    occurrence(18),
    occurrence(19),
    occurrence(20),
  ],
  more,
});

interface Sent {
  readonly method: string;
  readonly params: unknown;
}

// The range read's answer: a range, or what the connection does instead.
type Answer = CalendarRange | (() => Promise<unknown>);

// A single card beside the series, on the Wednesday of the week shown.
const single: CalendarItem = {
  ...card,
  id: 'write-report',
  title: 'Write report',
  start: '2026-11-18T09:00:00.000Z',
  end: '2026-11-18T10:00:00.000Z',
  projectId: null,
  workflowId: null,
  runId: null,
  state: 'scheduled',
  repeat: null,
  skippedDates: [],
  nextAt: null,
};

// What the server pushes on a topic; a test sends the same rows again to ask for a new read.
const pushes = new Map<string, Set<(rows: unknown[]) => void>>();

function runtimeWith(answer: Answer, box: Outbox<Sent>): Runtime {
  const topics: Readonly<Record<string, unknown[]>> = {
    calendarItems: [card, single],
    workflowRuns: [run],
    triggers: [],
  };
  const connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (method: string, params: unknown) => {
      box.record({ method, params });
      if (method === 'calendar.occurrences') {
        return typeof answer === 'function' ? answer() : Promise.resolve(answer);
      }
      return Promise.resolve({ commandId: 'c', seqs: [], duplicate: false });
    },
    subscribe(topic: string, _params: unknown, onData: (rows: unknown[]) => void) {
      pushes.set(topic, (pushes.get(topic) ?? new Set()).add(onData));
      onData(topics[topic] ?? []);
      return () => {
        pushes.get(topic)?.delete(onData);
      };
    },
    retry: () => undefined,
    close: () => undefined,
  } as Connection;
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, {
        'providers.offerSetup': false,
        'calendar.zone': zone,
        'calendar.firstDayOfWeek': 'monday',
        'calendar.maxOccurrences': 5,
      }),
    ),
  };
}

const commandsSent = (box: Outbox<Sent>): Command[] =>
  box.sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Command }).command);

async function showWeek(answer: Answer = range()) {
  const box = outbox<Sent>();
  const shown = await renderApp('/calendar?view=week&date=2026-11-18', runtimeWith(answer, box));
  await act(() =>
    box.until((sent) => sent.some((entry) => entry.method === 'calendar.occurrences')),
  );
  const grid = await screen.findByRole('group', { name: /^Calendar grid/ });
  return { ...shown, box, grid };
}

const block = (grid: HTMLElement, name: RegExp) => within(grid).getByRole('button', { name });

describe('the Repeat section', () => {
  it('turns the form into a rule, and says why it cannot', () => {
    expect(repeatRule(noRepeat, '2026-11-16')).toEqual({ ok: true, rule: null });
    const weekdays = {
      ...noRepeat,
      frequency: 'weekly' as const,
      weekdays: ['fri', 'mon', 'tue', 'wed', 'thu'] as const,
      end: 'on' as const,
      endDate: '2026-12-19',
    };
    expect(repeatRule(weekdays, '2026-11-16')).toEqual({
      ok: true,
      rule: {
        frequency: 'weekly',
        interval: 1,
        weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
        end: { kind: 'on', date: '2026-12-19' },
      },
    });
    expect(repeatRule({ ...weekdays, endDate: '2026-11-01' }, '2026-11-16')).toMatchObject({
      ok: false,
      field: 'endDate',
    });
    expect(
      repeatRule({ ...noRepeat, frequency: 'daily', interval: '0' }, '2026-11-16'),
    ).toMatchObject({ ok: false, field: 'interval' });
    expect(
      repeatRule({ ...noRepeat, frequency: 'monthly', end: 'after', count: '10001' }, '2026-11-16'),
    ).toMatchObject({ ok: false, field: 'count' });
    expect(repeatRule(repeatDraft(card.repeat), '2026-11-16')).toEqual({
      ok: true,
      rule: card.repeat,
    });
  });

  it('says the rule in words and when the card fires next', async () => {
    const { grid } = await showWeek();
    const next = within(grid).getAllByRole('button', { name: /, repeats, scheduled$/ })[0];
    if (!next) throw new Error('no future occurrence');
    fireEvent.keyDown(next, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'Edit card' });
    expect(within(dialog).getByTestId('repeat-words').textContent).toBe('Every weekday at 08:30');
    expect(within(dialog).getByTestId('repeat-next').textContent).toBe(
      'Fires next Tue 17 Nov, 08:30',
    );
  });
});

// What the range read answers while the server cannot, with what it cannot parse, and at last.
const restarting = (): Promise<unknown> => Promise.reject(new Error('Server is restarting'));
const unreadable = (): Promise<unknown> => Promise.resolve({ from: 'not a range' });
const readable = (): Promise<unknown> => Promise.resolve(range());

describe('occurrences in the week', () => {
  it('are drawn from the range read, marked as repeating, with their own state', async () => {
    const { grid, box } = await showWeek();
    expect(box.sent.find((entry) => entry.method === 'calendar.occurrences')?.params).toEqual({
      from: '2026-11-15T23:00:00.000Z',
      to: '2026-11-22T23:00:00.000Z',
    });
    const blocks = within(grid).getAllByRole('button', { name: /^Standup notes, / });
    expect(blocks).toHaveLength(5);
    for (const shown of blocks) {
      expect(shown.dataset['repeating']).toBe('');
      expect(within(shown).getByTestId('card-repeats')).toBeTruthy();
    }
    expect(blocks.map((shown) => shown.getAttribute('aria-label'))).toEqual([
      'Standup notes, 08:30–08:45, repeats, done',
      'Standup notes, 08:30–08:45, repeats, scheduled',
      'Standup notes, 08:30–08:45, repeats, scheduled',
      'Standup notes, 08:30–08:45, repeats, scheduled',
      'Standup notes, 08:30–08:45, repeats, scheduled',
    ]);
  });

  it('opens the run of a past occurrence and the card of a future one', async () => {
    const { grid, router } = await showWeek();
    const future = within(grid).getAllByRole('button', { name: /, repeats, scheduled$/ })[1];
    if (!future) throw new Error('no future occurrence');
    fireEvent.keyDown(future, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Edit card' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit card' }), { key: 'Escape' });

    fireEvent.keyDown(block(grid, /, repeats, done$/), { key: 'Enter' });
    await act(() => router.load());
    expect(router.state.location.pathname).toBe('/workflows/runs/run-16');
  });

  it('moves an occurrence as the series from that day, and keeps a reached one where it was', async () => {
    const { grid, box } = await showWeek();
    fireEvent.keyDown(block(grid, /, repeats, done$/), { key: 'ArrowDown', altKey: true });
    expect(commandsSent(box)).toEqual([]);

    const wednesday = within(grid).getAllByRole('button', { name: /, repeats, scheduled$/ })[1];
    if (!wednesday) throw new Error('no Wednesday occurrence');
    fireEvent.keyDown(wednesday, { key: 'ArrowDown', altKey: true });
    // Another day would be a change of the rule, so Alt+Right does nothing on an occurrence.
    fireEvent.keyDown(wednesday, { key: 'ArrowRight', altKey: true });
    await act(() => box.until((sent) => sent.some((entry) => entry.method === 'dispatch')));
    expect(commandsSent(box)).toEqual([
      {
        type: 'card.moveOccurrence',
        cardId: card.id,
        date: '2026-11-18',
        start: at(18, 7, 45),
        end: at(18, 8, 0),
      },
    ]);
  });

  it('keeps an occurrence that went by without a record in place, and moves a later one', async () => {
    // Monday went by before the card had its workflow, so nothing recorded it; Tuesday is next.
    const { grid, box } = await showWeek({
      ...range(),
      occurrences: [occurrence(16), ...range().occurrences.slice(1)],
    });
    const blocks = () => within(grid).getAllByRole('button', { name: /^Standup notes, / });
    const monday = blocks()[0];
    if (!monday) throw new Error('no Monday occurrence');
    expect(monday.className).not.toContain('cursor-grab');
    expect(monday.querySelector('[data-resize]')).toBeNull();
    fireEvent.keyDown(monday, { key: 'ArrowDown', altKey: true });
    expect(commandsSent(box)).toEqual([]);

    const wednesday = blocks()[2];
    if (!wednesday) throw new Error('no Wednesday occurrence');
    fireEvent.keyDown(wednesday, { key: 'ArrowDown', altKey: true });
    await act(() => box.until(() => commandsSent(box).length === 1));
    expect(commandsSent(box)).toEqual([
      {
        type: 'card.moveOccurrence',
        cardId: card.id,
        date: '2026-11-18',
        start: at(18, 7, 45),
        end: at(18, 8, 0),
      },
    ]);
    expect(blocks().map((shown) => shown.getAttribute('aria-label'))).toEqual([
      'Standup notes, 08:30–08:45, repeats',
      'Standup notes, 08:30–08:45, repeats, scheduled',
      'Standup notes, 08:45–09:00, repeats, scheduled',
      'Standup notes, 08:30–08:45, repeats, scheduled',
      'Standup notes, 08:30–08:45, repeats, scheduled',
    ]);

    // Delete on it offers only the whole series: that day has gone by.
    fireEvent.keyDown(blocks()[0] as HTMLElement, { key: 'Delete', code: 'Delete' });
    const choice = await screen.findByRole('alertdialog', { name: 'Delete which?' });
    expect(within(choice).queryByRole('button', { name: 'This occurrence' })).toBeNull();
  });

  it('says when the range cannot be read, and reads it again on Try again', async () => {
    let answer = restarting;
    const { grid, box } = await showWeek(() => answer());
    const reads = () => box.sent.filter((entry) => entry.method === 'calendar.occurrences').length;
    const failed = await screen.findByTestId('occurrences-failed');
    expect(failed.textContent).toContain('Repeating cards could not be read.');
    expect(failed.textContent).toContain('Server is restarting. Their occurrences are not shown.');
    expect(within(grid).queryAllByRole('button', { name: /^Standup notes, / })).toEqual([]);

    answer = unreadable;
    const before = reads();
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    await act(() => box.until(() => reads() > before));
    expect(screen.getByTestId('occurrences-failed').textContent).toContain(
      'The server answered with occurrences wow cannot read.',
    );
    answer = readable;
    fireEvent.click(
      within(screen.getByTestId('occurrences-failed')).getByRole('button', { name: 'Try again' }),
    );
    expect(await within(grid).findAllByRole('button', { name: /^Standup notes, / })).toHaveLength(
      5,
    );
    expect(screen.queryByTestId('occurrences-failed')).toBeNull();

    // A later read that fails keeps what was drawn, and says it may be out of date.
    answer = restarting;
    const held = reads();
    act(() => {
      for (const push of pushes.get('calendarItems') ?? []) push([card, single]);
    });
    await act(() => box.until(() => reads() > held));
    expect((await screen.findByTestId('occurrences-failed')).textContent).toContain(
      'Server is restarting. The occurrences shown may be out of date.',
    );
    expect(within(grid).getAllByRole('button', { name: /^Standup notes, / })).toHaveLength(5);
  });

  it('says when a card has more occurrences than are shown', async () => {
    await showWeek(range([card.id]));
    expect((await screen.findByTestId('occurrences-more')).textContent).toContain(
      'Standup notes repeats more than 5 times in this range; the first 5 are shown.',
    );
  });
});

async function askDelete() {
  const shown = await showWeek();
  const thursday = within(shown.grid).getAllByRole('button', {
    name: /, repeats, scheduled$/,
  })[2];
  if (!thursday) throw new Error('no Thursday occurrence');
  fireEvent.keyDown(thursday, { key: 'Delete', code: 'Delete' });
  const choice = await screen.findByRole('alertdialog', { name: 'Delete which?' });
  return { ...shown, choice };
}

describe('Delete on an occurrence', () => {
  it('skips only that day with "This occurrence", and Undo puts the skipped days back', async () => {
    const { choice, box } = await askDelete();
    expect(choice.textContent).toContain('Delete only Thu 19 Nov, or every occurrence');
    fireEvent.click(within(choice).getByRole('button', { name: 'This occurrence' }));
    await act(() => box.until((sent) => sent.some((entry) => entry.method === 'dispatch')));
    expect(commandsSent(box)).toEqual([
      { type: 'card.skipOccurrence', cardId: card.id, date: '2026-11-19' },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await act(() => box.until(() => commandsSent(box).length === 2));
    expect(commandsSent(box)[1]).toEqual({
      type: 'card.update',
      cardId: card.id,
      skippedDates: ['2026-11-13'],
    });
  });

  it('deletes the card with "The whole series", and Undo makes it again with its rule', async () => {
    const { choice, box } = await askDelete();
    fireEvent.click(within(choice).getByRole('button', { name: 'The whole series' }));
    await act(() => box.until((sent) => sent.some((entry) => entry.method === 'dispatch')));
    expect(commandsSent(box)).toEqual([{ type: 'card.delete', cardId: card.id }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await act(() => box.until(() => commandsSent(box).length === 2));
    expect(commandsSent(box)[1]).toEqual({
      type: 'card.create',
      cardId: card.id,
      title: card.title,
      start: card.start,
      end: card.end,
      zone,
      projectId: 'demo',
      workflowId: 'notes',
      repeat: card.repeat,
      skippedDates: ['2026-11-13'],
    });
  });
});

// Runs a palette command the way the owner does: open the palette, type, pick it.
function runFromPalette(runtime: Runtime, title: string) {
  act(() => runtime.layout.setState({ paletteOpen: true }));
  fireEvent.change(screen.getByPlaceholderText('Type a command or search…'), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${title}`) }));
}

describe('the new actions', () => {
  it('have palette commands, and Delete a keybinding setting', () => {
    const ids = calendarCommands({
      search: undefined,
      cards: [card, single],
      triggers: [],
      schedulerPaused: false,
    }).map((command) => command.id);
    expect(ids).toContain(`card.skipNext.${card.id}`);
    expect(ids).toContain(`card.deleteSeries.${card.id}`);
    expect(ids).toContain(`card.delete.${single.id}`);
    expect(ids).not.toContain(`card.skipNext.${single.id}`);
    expect(ids).not.toContain(`card.delete.${card.id}`);
    expect(settingsRegistry['keybindings.calendarDeleteCard'].default).toBe('Delete');
  });

  it('skips the next occurrence from the palette, and Undo puts the skipped days back', async () => {
    const { runtime, box } = await showWeek();
    runFromPalette(runtime, 'Skip next occurrence: Standup notes');
    await act(() => box.until(() => commandsSent(box).length === 1));
    expect(commandsSent(box)).toEqual([
      { type: 'card.skipOccurrence', cardId: card.id, date: '2026-11-17' },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await act(() => box.until(() => commandsSent(box).length === 2));
    expect(commandsSent(box)[1]).toEqual({
      type: 'card.update',
      cardId: card.id,
      skippedDates: ['2026-11-13'],
    });
  });

  it('asks which to delete from "Delete series", and deletes the series', async () => {
    const { runtime, box } = await showWeek();
    runFromPalette(runtime, 'Delete series: Standup notes');
    const choice = await screen.findByRole('alertdialog', { name: 'Delete which?' });
    // Opened from the palette, not from a day, so there is no one occurrence to skip.
    expect(within(choice).queryByRole('button', { name: 'This occurrence' })).toBeNull();
    expect(commandsSent(box)).toEqual([]);
    fireEvent.click(within(choice).getByRole('button', { name: 'The whole series' }));
    await act(() => box.until(() => commandsSent(box).length === 1));
    expect(commandsSent(box)).toEqual([{ type: 'card.delete', cardId: card.id }]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('deletes a single card from "Delete card", after asking', async () => {
    const { runtime, box } = await showWeek();
    runFromPalette(runtime, 'Delete card: Write report');
    const question = await screen.findByRole('alertdialog', { name: 'Delete the card?' });
    expect(commandsSent(box)).toEqual([]);
    fireEvent.click(within(question).getByRole('button', { name: 'Delete card' }));
    await act(() => box.until(() => commandsSent(box).length === 1));
    expect(commandsSent(box)).toEqual([{ type: 'card.delete', cardId: single.id }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await act(() => box.until(() => commandsSent(box).length === 2));
    expect(commandsSent(box)[1]).toMatchObject({ type: 'card.create', cardId: single.id });
  });

  it('name each occurrence by its card and day', () => {
    const blocks = occurrenceBlocks([card], range(), [run]);
    expect([...blocks.shown.keys()]).toEqual(
      [16, 17, 18, 19, 20].map((day) => occurrenceId(card.id, `2026-11-${day}`)),
    );
    expect(blocks.shown.get(occurrenceId(card.id, '2026-11-16'))).toMatchObject({
      state: 'done',
      runId: 'run-16',
    });
    // A single card is drawn from its own row, not from the range.
    expect(occurrenceBlocks([{ ...card, repeat: null }], range(), [run]).items).toEqual([]);
  });
});
