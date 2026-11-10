import {
  isCardTrigger,
  type CalendarItem,
  type OutlookProfile,
  type Trigger,
} from '@wow/contracts';
import { dispatch, settingValue, type SettingValues } from '@wow/client-runtime';
import type { AppCommand, CommandContext } from '@/app/commands';
import { stepDays, type CalendarViewKind } from './layout';
import { calendarPrefs } from './prefs';
import { anchorDate, todayIn, type CalendarSearch } from './search';
import {
  addDays,
  atMinute,
  isoDate,
  localDate,
  minuteOfDay,
  MINUTES_PER_DAY,
  parseClockTime,
  sameDate,
  type LocalDate,
} from './time';
import { calendarZoom } from './zoom';

// Where a card made without a pointer goes: the next snap from now when the day is today, else the
// start of work hours.
export function newCardRange(
  day: LocalDate,
  values: SettingValues,
  profile: OutlookProfile | null | undefined,
  now: Date = new Date(),
): { start: string; end: string } {
  const prefs = calendarPrefs(values, profile);
  const zone = prefs.zone;
  const snap = settingValue(values, 'calendar.snapMinutes');
  const length = settingValue(values, 'calendar.cardMinutes');
  const workStart = parseClockTime(prefs.workHours.start) ?? 0;
  let minute = workStart;
  if (sameDate(day, localDate(now, zone))) {
    const next = Math.ceil(minuteOfDay(now, zone) / snap) * snap;
    if (next + length <= MINUTES_PER_DAY) minute = next;
  }
  const start = atMinute(day, minute, zone);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + length * 60_000).toISOString(),
  };
}

export const cardTitle = (card: CalendarItem): string => card.title || 'Untitled card';

// Missed cards whose trigger offers a one-click "Run now" (missed policy `mark`, spec 12).
export function runNowCardIds(
  cards: readonly CalendarItem[],
  triggers: readonly Trigger[],
): ReadonlySet<string> {
  const missed = new Set(cards.filter((card) => card.state === 'missed').map((card) => card.id));
  return new Set(
    triggers
      .filter(isCardTrigger)
      .filter((trigger) => trigger.state === 'missed' && trigger.offerRunNow)
      .map((trigger) => trigger.calendarItemId)
      .filter((id) => missed.has(id)),
  );
}

export interface CalendarCommandData {
  // The calendar's URL state when it is the open view, else undefined.
  readonly search: CalendarSearch | undefined;
  readonly cards: readonly CalendarItem[];
  readonly triggers: readonly Trigger[];
  readonly schedulerPaused: boolean;
  // What Outlook last said about zone and work hours (F-8); undefined before the first read.
  readonly profile?: OutlookProfile | null | undefined;
  readonly showWeekends?: boolean | undefined;
  readonly mailRailCollapsed?: boolean | undefined;
}

// Palette commands for the calendar (spec 7, 22). Today, next, previous and the view switches only
// exist while the calendar is open, so their plain-key shortcuts do nothing elsewhere.
export function calendarCommands({
  search,
  cards,
  triggers,
  schedulerPaused,
  profile,
  showWeekends = true,
  mailRailCollapsed = false,
}: CalendarCommandData): AppCommand[] {
  const commands: AppCommand[] = [];
  const zoneSetting = ({ settings }: CommandContext) =>
    calendarPrefs(settings.getState().values, profile).zone;
  if (search) {
    const view: CalendarViewKind = search.view ?? 'week';
    const shift =
      (direction: 1 | -1) =>
      (context: CommandContext): void => {
        const anchor = anchorDate(search, zoneSetting(context));
        void context.navigate({
          to: '/calendar',
          search: { ...search, date: isoDate(addDays(anchor, direction * stepDays(view))) },
        });
      };
    commands.push(
      {
        id: 'calendar.today',
        title: 'Calendar: today',
        group: 'Calendar',
        keywords: ['now', 'calendar'],
        keybinding: 'keybindings.calendarToday',
        run: ({ navigate }) =>
          void navigate({ to: '/calendar', search: search.view ? { view: search.view } : {} }),
      },
      {
        id: 'calendar.next',
        title: view === 'day' ? 'Calendar: next day' : 'Calendar: next week',
        group: 'Calendar',
        keywords: ['forward', 'calendar'],
        keybinding: 'keybindings.calendarNext',
        run: shift(1),
      },
      {
        id: 'calendar.previous',
        title: view === 'day' ? 'Calendar: previous day' : 'Calendar: previous week',
        group: 'Calendar',
        keywords: ['back', 'calendar'],
        keybinding: 'keybindings.calendarPrevious',
        run: shift(-1),
      },
      {
        id: 'calendar.dayView',
        title: 'Calendar: day view',
        group: 'Calendar',
        keybinding: 'keybindings.calendarDayView',
        run: ({ navigate }) =>
          void navigate({ to: '/calendar', search: { ...search, view: 'day' } }),
      },
      {
        id: 'calendar.weekView',
        title: 'Calendar: week view',
        group: 'Calendar',
        keybinding: 'keybindings.calendarWeekView',
        run: ({ navigate }) =>
          void navigate({ to: '/calendar', search: { ...search, view: 'week' } }),
      },
      // The grid keeps the time at the middle of the view in place.
      {
        id: 'calendar.zoomIn',
        title: 'Zoom in calendar',
        group: 'Calendar',
        keywords: ['zoom', 'larger', 'hour height', 'calendar'],
        keybinding: 'keybindings.calendarZoomIn',
        repeatable: true,
        run: ({ settings }) => void calendarZoom(settings).step(1),
      },
      {
        id: 'calendar.zoomOut',
        title: 'Zoom out calendar',
        group: 'Calendar',
        keywords: ['zoom', 'smaller', 'hour height', 'calendar'],
        keybinding: 'keybindings.calendarZoomOut',
        repeatable: true,
        run: ({ settings }) => void calendarZoom(settings).step(-1),
      },
      {
        id: 'calendar.zoomReset',
        title: 'Reset calendar zoom',
        group: 'Calendar',
        keywords: ['zoom', 'default', 'hour height', 'calendar'],
        keybinding: 'keybindings.calendarZoomReset',
        run: ({ settings }) => void calendarZoom(settings).reset(),
      },
      {
        id: 'calendar.toggleMailRail',
        title: mailRailCollapsed ? 'Show mail rail' : 'Collapse mail rail',
        group: 'Calendar',
        keywords: ['mail', 'unread', 'rail', 'outlook', 'hide', 'show'],
        keybinding: 'keybindings.toggleMailRail',
        run: ({ settings }) => void settings.write('outlook.mailRailCollapsed', !mailRailCollapsed),
      },
    );
  }

  commands.push({
    id: 'calendar.toggleWeekends',
    title: showWeekends ? 'Calendar: hide weekends' : 'Calendar: show weekends',
    group: 'Calendar',
    keywords: ['weekend', 'saturday', 'sunday', 'week view', 'work week'],
    run: ({ settings }) => void settings.write('calendar.showWeekends', !showWeekends),
  });

  commands.push(
    {
      id: 'calendar.newCard',
      title: 'New card',
      group: 'Calendar',
      keywords: ['calendar', 'create', 'event', 'block'],
      // A plain key, so it only applies while the calendar is open.
      ...(search ? { keybinding: 'keybindings.newCard' as const } : {}),
      run: (context) => {
        const day = search
          ? anchorDate(search, zoneSetting(context))
          : todayIn(zoneSetting(context));
        if (!search) void context.navigate({ to: '/calendar' });
        context.layout.setState({
          cardDialog: {
            type: 'create',
            ...newCardRange(day, context.settings.getState().values, profile),
          },
        });
      },
    },
    {
      id: 'outlook.refresh',
      title: 'Refresh Outlook',
      group: 'Calendar',
      keywords: ['sync', 'poll', 'mail', 'meetings'],
      run: ({ connection }) => {
        // The outcome shows up in the calendar's banner, which follows outlook_status.
        if (connection) void connection.request('outlook.refresh', {}).catch(() => undefined);
      },
    },
    {
      id: 'scheduler.togglePaused',
      title: schedulerPaused ? 'Resume scheduler' : 'Pause scheduler',
      group: 'Actions',
      keywords: ['scheduler', 'triggers', schedulerPaused ? 'resume' : 'pause'],
      run: ({ settings }) => void settings.write('scheduler.paused', !schedulerPaused),
    },
  );

  const runNow = runNowCardIds(cards, triggers);
  for (const card of cards) {
    if (!runNow.has(card.id)) continue;
    commands.push({
      id: `card.runNow.${card.id}`,
      title: `Run now: ${cardTitle(card)}`,
      value: `Run now ${cardTitle(card)} ${card.id}`,
      group: 'Cards',
      keywords: ['missed', 'trigger', 'workflow', 'start'],
      run: ({ connection }) => {
        // The outcome shows up on the card, which follows its run.
        if (!connection) return;
        void dispatch(connection, {
          type: 'card.runNow',
          cardId: card.id,
          runId: globalThis.crypto.randomUUID(),
        }).catch(() => undefined);
      },
    });
  }

  for (const card of cards) {
    commands.push({
      id: `card.${card.id}`,
      title: `Edit card: ${cardTitle(card)}`,
      value: `Edit card ${cardTitle(card)} ${card.id}`,
      group: 'Cards',
      keywords: ['card', 'calendar', card.state],
      run: (context) => {
        const date = isoDate(localDate(new Date(card.start), zoneSetting(context)));
        void context.navigate({ to: '/calendar', search: { ...search, date } });
        context.layout.setState({ cardDialog: { type: 'edit', cardId: card.id } });
      },
    });
  }
  return commands;
}
