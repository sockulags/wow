import type { CalendarItem, OutlookStatus } from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PauseIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { formatBinding } from '@/app/keybindings';
import { useConnectionState, useRuntime, useSetting } from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/views/empty-views';
import { CardDialog } from './card-dialog';
import { newCardRange, runNowCardIds } from './commands';
import { stepDays, visibleDays, type CalendarViewKind } from './layout';
import { MailRail } from './mail-rail';
import { anchorDate, todayIn, type CalendarSearch } from './search';
import {
  addDays,
  formatDateRange,
  formatLongDay,
  formatTime,
  isoDate,
  localDate,
  resolveZone,
  sameDate,
} from './time';
import { TimeGrid } from './time-grid';
import { calendarZoom, zoomBounds } from './zoom';

const noItems: readonly CalendarItem[] = [];

function OutlookBanner({ status, zone }: { status: OutlookStatus | undefined; zone: string }) {
  if (!status?.lastError) return null;
  const since = status.unavailableSince ? new Date(status.unavailableSince) : undefined;
  const when = since
    ? sameDate(localDate(since, zone), todayIn(zone))
      ? formatTime(since, zone)
      : `${isoDate(localDate(since, zone))} ${formatTime(since, zone)}`
    : undefined;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-state-needs-you/10 px-3 py-1.5 text-xs"
    >
      <AlertTriangleIcon className="size-3.5 shrink-0 text-state-needs-you" aria-hidden />
      <span className="font-medium">
        {when ? `Outlook unavailable since ${when}` : 'Outlook unavailable'}
      </span>
      <span className="truncate text-muted-foreground">
        {status.lastError}. Showing the last items read from Outlook.
      </span>
    </div>
  );
}

function Shortcut({ binding }: { binding: string }) {
  return binding === '' ? null : (
    <kbd className="ml-1 font-mono text-[10px] text-muted-foreground">{formatBinding(binding)}</kbd>
  );
}

function ConnectedCalendar({ search }: { search: CalendarSearch }) {
  const { connection, layout } = useRuntime();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const zoneSetting = useSetting('calendar.zone');
  const firstDay = useSetting('calendar.firstDayOfWeek');
  const workHours = useSetting('calendar.workHours');
  const snap = useSetting('calendar.snapMinutes');
  const storedHourHeight = useSetting('calendar.hourHeight');
  const cardMinutes = useSetting('calendar.cardMinutes');
  const mailRail = useSetting('outlook.mailRail');
  const todayKey = useSetting('keybindings.calendarToday');
  const nextKey = useSetting('keybindings.calendarNext');
  const previousKey = useSetting('keybindings.calendarPrevious');
  const newCardKey = useSetting('keybindings.newCard');
  const zoomInKey = useSetting('keybindings.calendarZoomIn');
  const zoomOutKey = useSetting('keybindings.calendarZoomOut');
  const zoomResetKey = useSetting('keybindings.calendarZoomReset');
  const { settings } = useRuntime();
  const zoom = calendarZoom(settings);
  const hourHeight = useStore(zoom.store, (state) => state.pending) ?? storedHourHeight;
  const zoomPercent = Math.round((hourHeight / zoomBounds.default) * 100);
  const items = useTopic('calendarItems') ?? noItems;
  const status = useTopic('outlookStatus')?.[0];
  const mail = useTopic('mailItems') ?? [];
  const triggers = useTopic('triggers');
  const paused = useSetting('scheduler.paused');
  const [runError, setRunError] = useState<string>();

  const zone = resolveZone(zoneSetting);
  const view: CalendarViewKind = search.view ?? 'week';
  const anchor = anchorDate(search, zoneSetting);
  const today = todayIn(zoneSetting);
  const days = visibleDays(view, anchor, firstDay);
  const cards = useMemo(() => items.filter((item) => item.source === 'local'), [items]);
  const runNowIds = useMemo(() => runNowCardIds(cards, triggers ?? []), [cards, triggers]);
  const runNow = (cardId: string) => {
    setRunError(undefined);
    dispatch({ type: 'card.runNow', cardId, runId: globalThis.crypto.randomUUID() }).catch(
      (error: unknown) => setRunError(errorMessage(error)),
    );
  };
  const first = days[0] ?? anchor;
  const last = days.at(-1) ?? anchor;

  const go = (next: CalendarSearch) => void navigate({ to: '/calendar', search: next });
  const shift = (direction: 1 | -1) =>
    go({ ...search, date: isoDate(addDays(anchor, direction * stepDays(view))) });

  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Calendar" className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => go(search.view ? { view: search.view } : {})}
          >
            Today
            <Shortcut binding={todayKey} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={view === 'day' ? 'Previous day' : 'Previous week'}
            title={previousKey === '' ? undefined : formatBinding(previousKey)}
            onClick={() => shift(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={view === 'day' ? 'Next day' : 'Next week'}
            title={nextKey === '' ? undefined : formatBinding(nextKey)}
            onClick={() => shift(1)}
          >
            <ChevronRightIcon />
          </Button>
          <h2 className="px-1 text-sm font-medium" data-testid="calendar-range">
            {view === 'day' ? formatLongDay(anchor) : formatDateRange(first, last)}
          </h2>
          <span className="text-[11px] text-muted-foreground">{zone}</span>
          <div className="ml-auto flex items-center gap-1">
            {paused && (
              <Button
                variant="ghost"
                size="sm"
                className="text-state-needs-you"
                title="Triggers do not fire while the scheduler is paused. Click to resume."
                onClick={() => void settings.write('scheduler.paused', false)}
              >
                <PauseIcon />
                Scheduler paused
              </Button>
            )}
            <div
              role="group"
              aria-label="Zoom"
              className="flex items-center rounded-md border border-border"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-r-none"
                aria-label="Zoom out calendar"
                title={zoomOutKey === '' ? undefined : formatBinding(zoomOutKey)}
                disabled={hourHeight <= zoomBounds.min}
                onClick={() => zoom.step(-1)}
              >
                <MinusIcon />
              </Button>
              <button
                type="button"
                aria-label="Reset calendar zoom"
                title={`Reset to 100%${zoomResetKey === '' ? '' : ` (${formatBinding(zoomResetKey)})`}`}
                data-testid="calendar-zoom"
                onClick={() => zoom.reset()}
                className="min-w-11 px-1 text-center text-xs text-muted-foreground tabular-nums hover:text-foreground"
              >
                {zoomPercent}%
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-l-none"
                aria-label="Zoom in calendar"
                title={zoomInKey === '' ? undefined : formatBinding(zoomInKey)}
                disabled={hourHeight >= zoomBounds.max}
                onClick={() => zoom.step(1)}
              >
                <PlusIcon />
              </Button>
            </div>
            <div role="group" aria-label="View" className="flex rounded-md border border-border">
              {(['day', 'week'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={view === kind}
                  onClick={() => go({ ...search, view: kind })}
                  className={cn(
                    'px-2 py-1 text-xs capitalize first:rounded-l-md last:rounded-r-md',
                    view === kind ? 'bg-accent font-medium' : 'text-muted-foreground',
                  )}
                >
                  {kind}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh Outlook"
              onClick={() => void connection?.request('outlook.refresh', {}).catch(() => undefined)}
            >
              <RefreshCwIcon />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                layout.setState({
                  cardDialog: {
                    type: 'create',
                    ...newCardRange(anchor, settings.getState().values),
                  },
                })
              }
            >
              <PlusIcon />
              New card
              <Shortcut binding={newCardKey} />
            </Button>
          </div>
        </div>
        <OutlookBanner status={status} zone={zone} />
        {runError && (
          <div
            role="alert"
            className="shrink-0 border-b border-border bg-state-failed/10 px-3 py-1.5 text-xs"
          >
            {runError}
          </div>
        )}
        <TimeGrid
          days={days}
          today={today}
          items={items}
          zone={zone}
          workHours={workHours}
          snap={snap}
          cardMinutes={cardMinutes}
          hourHeight={hourHeight}
          onZoom={(steps) => zoom.step(steps)}
          onCreate={(range) => layout.setState({ cardDialog: { type: 'create', ...range } })}
          onEdit={(cardId) => layout.setState({ cardDialog: { type: 'edit', cardId } })}
          runNowIds={runNowIds}
          onRunNow={runNow}
          onChange={(cardId, range) => dispatch({ type: 'card.update', cardId, ...range })}
        />
      </section>
      {mailRail && <MailRail mail={mail} unreadCount={status?.unreadCount ?? 0} zone={zone} />}
      <CardDialog cards={cards} />
    </div>
  );
}

// Day and week views of Outlook items and local cards (spec 1 to 7).
export function CalendarView({ search }: { search: CalendarSearch }) {
  const { configured } = useConnectionState();
  if (!configured) {
    return (
      <EmptyState icon={CalendarDaysIcon} title="No calendar items yet">
        Outlook meetings, unread mail and your own cards will appear here once the app is connected
        to the wow server.
      </EmptyState>
    );
  }
  return <ConnectedCalendar search={search} />;
}
