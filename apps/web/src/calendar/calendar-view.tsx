import type { OutlookStatus } from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PauseIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { ShellToolbar } from '@/app/shell-toolbar';
import { useTopicState } from '@/app/topic-state';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { Banner } from '@/components/banner';
import { IconButton, ShortcutHint, WithTooltip } from '@/components/hint';
import { DisconnectedState, Stale } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { notify } from '@/lib/feedback';
import { formatWhen } from '@/lib/format';
import { CardDialog } from './card-dialog';
import { newCardRange, runNowCardIds } from './commands';
import { stepDays, visibleDays, type CalendarViewKind } from './layout';
import { MailRail } from './mail-rail';
import { useCalendarPrefs, useOutlookProfile } from './prefs';
import { anchorDate, type CalendarSearch } from './search';
import {
  addDays,
  formatDateRange,
  formatLongDay,
  formatShortDay,
  formatZone,
  isoDate,
  isoWeek,
  localDate,
  systemZone,
} from './time';
import { TimeGrid } from './time-grid';
import { useBelow } from '@/lib/use-breakpoint';
import { useContextPanelShown } from '@/panel/panel-state';
import { calendarZoom, presetHeight, zoomBounds, zoomPercent, zoomPresets } from './zoom';

// While Outlook cannot be read (spec 4): what happened, since when, and what to try.
function OutlookBanner({
  status,
  zone,
  onRetry,
}: {
  status: OutlookStatus | undefined;
  zone: string;
  onRetry: () => void;
}) {
  if (!status?.lastError) return null;
  const since = status.unavailableSince ? formatWhen(status.unavailableSince, zone) : undefined;
  return (
    <Banner
      tone="warning"
      testId="outlook-banner"
      actions={
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="xs" variant="ghost">
                What to check
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 text-xs">
              <ul className="flex list-disc flex-col gap-1.5 pl-4">
                <li>Outlook (classic) is open on this computer and signed in.</li>
                <li>No Outlook dialog is waiting for an answer, such as a sign-in prompt.</li>
                <li>
                  wow only reads Outlook. It never starts it, so open Outlook and then try again.
                </li>
              </ul>
            </PopoverContent>
          </Popover>
          <Button size="xs" variant="outline" onClick={onRetry}>
            <RefreshCwIcon />
            Try again
          </Button>
        </>
      }
    >
      <span className="font-medium">
        {since ? `Outlook unavailable since ${since}` : 'Outlook unavailable'}.
      </span>{' '}
      <span className="text-muted-foreground">
        {status.lastError}. Showing the last items read from Outlook.
      </span>
    </Banner>
  );
}

// [-] [100% ▾] [+]: the percent opens a menu of levels and Reset (audit B-12, B-13).
function ZoomControls({ hourHeight, floor }: { hourHeight: number; floor: number }) {
  const { settings } = useRuntime();
  const zoom = calendarZoom(settings);
  const [open, setOpen] = useState(false);
  const percent = zoomPercent(hourHeight);
  return (
    <div role="group" aria-label="Zoom" className="flex items-center">
      <IconButton
        label="Zoom out calendar"
        shortcut="keybindings.calendarZoomOut"
        disabled={hourHeight <= Math.max(zoomBounds.min, floor)}
        onClick={() => zoom.step(-1)}
      >
        <MinusIcon />
      </IconButton>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Zoom level ${percent}%`}
            data-testid="calendar-zoom"
            className="w-16 gap-0.5 px-1 tabular-nums"
          >
            {percent}%
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-44 p-1">
          <div role="menu" aria-label="Zoom levels" className="flex flex-col">
            {zoomPresets.map((preset) => {
              const height = presetHeight(preset);
              return (
                <Button
                  key={preset}
                  role="menuitemradio"
                  aria-checked={percent === preset}
                  variant="ghost"
                  size="sm"
                  disabled={height < floor}
                  className="justify-between tabular-nums"
                  onClick={() => {
                    zoom.set(height);
                    setOpen(false);
                  }}
                >
                  {preset}%{percent === preset && <span aria-hidden>✓</span>}
                </Button>
              );
            })}
            <Button
              role="menuitem"
              variant="ghost"
              size="sm"
              className="justify-between border-t border-border"
              onClick={() => {
                zoom.reset();
                setOpen(false);
              }}
            >
              Reset calendar zoom
              <ShortcutHint shortcut="keybindings.calendarZoomReset" />
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <IconButton
        label="Zoom in calendar"
        shortcut="keybindings.calendarZoomIn"
        disabled={hourHeight >= zoomBounds.max}
        onClick={() => zoom.step(1)}
      >
        <PlusIcon />
      </IconButton>
    </div>
  );
}

function ConnectedCalendar({ search }: { search: CalendarSearch }) {
  const { connection, layout, settings } = useRuntime();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const prefs = useCalendarPrefs();
  const profile = useOutlookProfile();
  const snap = useSetting('calendar.snapMinutes');
  const storedHourHeight = useSetting('calendar.hourHeight');
  const cardMinutes = useSetting('calendar.cardMinutes');
  const showWeekends = useSetting('calendar.showWeekends');
  const maxColumns = useSetting('calendar.weekMaxColumns');
  const mailRail = useSetting('outlook.mailRail');
  const mailRailCollapsed = useSetting('outlook.mailRailCollapsed');
  // A narrow window, or the context panel next to the calendar, folds the rail on its own;
  // opening it then only lasts until it is folded again.
  const narrow = useBelow('narrow');
  const panelShown = useContextPanelShown();
  const crowded = narrow || panelShown;
  const [railPeek, setRailPeek] = useState(false);
  const railCollapsed = mailRailCollapsed || (crowded && !railPeek);
  const zoom = calendarZoom(settings);
  const pendingHeight = useStore(zoom.store, (state) => state.pending);
  const floor = useStore(zoom.store, (state) => state.floor);
  // At the lowest zoom the day fills the view instead of leaving space under 24:00.
  const hourHeight = Math.max(pendingHeight ?? storedHourHeight, floor);
  const { rows: items = [], status: itemsStatus } = useTopicState('calendarItems');
  const status = useTopic('outlookStatus')?.[0];
  const triggers = useTopic('triggers');
  const paused = useSetting('scheduler.paused');

  const zone = prefs.zone;
  const view: CalendarViewKind = search.view ?? 'week';
  const anchor = anchorDate(search, zone);
  const today = localDate(new Date(), zone);
  const days = visibleDays(view, anchor, prefs.firstDayOfWeek, showWeekends);
  const cards = useMemo(() => items.filter((item) => item.source === 'local'), [items]);
  const runNowIds = useMemo(() => runNowCardIds(cards, triggers ?? []), [cards, triggers]);
  const runNow = (cardId: string) => {
    dispatch({ type: 'card.runNow', cardId, runId: globalThis.crypto.randomUUID() }).catch(
      (error: unknown) =>
        notify.error('The workflow could not start', { description: errorMessage(error) }),
    );
  };
  const refresh = () => void connection?.request('outlook.refresh', {}).catch(() => undefined);
  const first = days[0] ?? anchor;
  const last = days.at(-1) ?? anchor;
  // The zone is only worth a word when it is not the computer's own (audit B-09).
  const foreignZone = zone === systemZone() ? undefined : zone;

  const go = (next: CalendarSearch) => void navigate({ to: '/calendar', search: next });
  // The selection lives in the URL, replaced rather than pushed so Back leaves the calendar.
  const select = (itemId: string) => {
    if (search.item !== itemId) {
      void navigate({ to: '/calendar', search: { ...search, item: itemId }, replace: true });
    }
  };
  const shift = (direction: 1 | -1) =>
    go({ ...search, date: isoDate(addDays(anchor, direction * stepDays(view))) });
  const newCard = () =>
    layout.setState({
      cardDialog: {
        type: 'create',
        ...newCardRange(anchor, settings.getState().values, profile),
      },
    });

  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Calendar" className="@container flex min-w-0 flex-1 flex-col">
        <ShellToolbar>
          <a
            href="#calendar-grid"
            className="sr-only rounded-md bg-background px-2 py-1 text-xs focus:not-sr-only focus:ring-2 focus:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              const grid = document.getElementById('calendar-grid');
              const target =
                grid?.querySelector<HTMLElement>('[data-stop][tabindex="0"]') ?? grid ?? undefined;
              target?.focus();
            }}
          >
            Skip to calendar
          </a>
          <div className="@container flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
            <WithTooltip label="Today" shortcut="keybindings.calendarToday">
              <Button
                variant="outline"
                size="sm"
                onClick={() => go(search.view ? { view: search.view } : {})}
              >
                Today
              </Button>
            </WithTooltip>
            <IconButton
              label={view === 'day' ? 'Previous day' : 'Previous week'}
              shortcut="keybindings.calendarPrevious"
              onClick={() => shift(-1)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              label={view === 'day' ? 'Next day' : 'Next week'}
              shortcut="keybindings.calendarNext"
              onClick={() => shift(1)}
            >
              <ChevronRightIcon />
            </IconButton>
            <h2
              className="shrink-0 px-1 text-sm font-medium tabular-nums"
              data-testid="calendar-range"
            >
              {view === 'day' ? (
                <>
                  <span className="hidden @[40rem]:inline">{formatLongDay(anchor)}</span>
                  <span className="@[40rem]:hidden">{formatShortDay(anchor)}</span>
                </>
              ) : (
                <>
                  <span className="hidden @[40rem]:inline">{formatDateRange(first, last)}</span>
                  <span className="@[40rem]:hidden">{formatDateRange(first, last, false)}</span>
                </>
              )}
            </h2>
            {view === 'week' && (
              <span
                className="hidden shrink-0 text-xs text-muted-foreground tabular-nums @[46rem]:inline"
                data-testid="calendar-week"
              >
                Week {isoWeek(first)}
              </span>
            )}
            {foreignZone && (
              <WithTooltip label={`Times are in ${foreignZone}, not this computer's zone`}>
                <span
                  tabIndex={0}
                  data-testid="calendar-zone"
                  className="hidden shrink-0 truncate rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring @[60rem]:inline"
                >
                  {formatZone(foreignZone)}
                </span>
              </WithTooltip>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {paused && (
                <WithTooltip label="Triggers do not fire while the scheduler is paused. Click to resume.">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-warning"
                    aria-label="Scheduler paused. Resume"
                    onClick={() => void settings.write('scheduler.paused', false)}
                  >
                    <PauseIcon />
                    <span className="hidden @[48rem]:inline">Scheduler paused</span>
                  </Button>
                </WithTooltip>
              )}
              <div className="hidden @[34rem]:flex">
                <ZoomControls hourHeight={hourHeight} floor={floor} />
              </div>
              <ToggleGroup
                type="single"
                aria-label="View"
                value={view}
                onValueChange={(next) => {
                  if (next === 'day' || next === 'week') go({ ...search, view: next });
                }}
                className="gap-0"
              >
                <WithTooltip label="Day view" shortcut="keybindings.calendarDayView">
                  <ToggleGroupItem value="day" className="rounded-r-none">
                    Day
                  </ToggleGroupItem>
                </WithTooltip>
                <WithTooltip label="Week view" shortcut="keybindings.calendarWeekView">
                  <ToggleGroupItem value="week" className="-ml-px rounded-l-none">
                    Week
                  </ToggleGroupItem>
                </WithTooltip>
              </ToggleGroup>
              <IconButton label="Refresh Outlook" onClick={refresh}>
                <RefreshCwIcon />
              </IconButton>
              <WithTooltip label="New card" shortcut="keybindings.newCard">
                <Button variant="outline" size="sm" aria-label="New card" onClick={newCard}>
                  <PlusIcon />
                  <span className="hidden @[42rem]:inline">New card</span>
                </Button>
              </WithTooltip>
            </div>
          </div>
        </ShellToolbar>
        <OutlookBanner status={status} zone={zone} onRetry={refresh} />
        <Stale status={itemsStatus} className="flex min-h-0 flex-1 flex-col">
          <TimeGrid
            view={view}
            days={days}
            today={today}
            items={items}
            zone={zone}
            workHours={prefs.workHours}
            snap={snap}
            cardMinutes={cardMinutes}
            maxColumns={maxColumns}
            hourHeight={hourHeight}
            onZoom={(steps) => zoom.step(steps)}
            onFloor={(height) => zoom.setFloor(height)}
            onCreate={(range) => layout.setState({ cardDialog: { type: 'create', ...range } })}
            onEdit={(cardId) => layout.setState({ cardDialog: { type: 'edit', cardId } })}
            selectedId={search.item}
            panelShown={panelShown}
            onSelect={select}
            runNowIds={runNowIds}
            onRunNow={runNow}
            onChange={(cardId, range) => dispatch({ type: 'card.update', cardId, ...range })}
          />
        </Stale>
      </section>
      {mailRail && (
        <MailRail
          status={status}
          zone={zone}
          collapsed={railCollapsed}
          onCollapsedChange={(next) => {
            if (crowded) {
              setRailPeek(!next);
              if (!next && mailRailCollapsed)
                void settings.write('outlook.mailRailCollapsed', false);
              return;
            }
            void settings.write('outlook.mailRailCollapsed', next);
          }}
        />
      )}
      <CardDialog cards={cards} />
    </div>
  );
}

// Day and week views of Outlook items and local cards (spec 1 to 7).
export function CalendarView({ search }: { search: CalendarSearch }) {
  const { connection } = useRuntime();
  if (!connection) return <DisconnectedState offline />;
  return <ConnectedCalendar search={search} />;
}
