import { CardState, type CalendarItem, type WorkHours } from '@wow/contracts';
import { LockIcon, PlayIcon, VideoIcon } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { cn } from '@/lib/utils';
import { cardTitle } from './commands';
import { allDayItemsOn, placeTimedItems, snapMinute, workSpan, type PlacedItem } from './layout';
import {
  atMinute,
  formatDayHeading,
  formatTime,
  isoDate,
  localDate,
  minuteOfDay,
  MINUTES_PER_DAY,
  parseClockTime,
  sameDate,
  type LocalDate,
} from './time';
import { wheelSteps } from './zoom';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// The shortest a block is drawn, so a 5-minute meeting stays readable when zoomed out; the
// layout gives short items this much room so their blocks sit beside the next item.
const MIN_BLOCK_PX = 18;

// The current instant, moved on at every whole minute for the now-line.
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

type Range = { readonly start: string; readonly end: string };

// A pointer gesture in progress. Minutes are from local midnight of `days[dayIndex]`.
type Gesture =
  | {
      readonly kind: 'create';
      readonly dayIndex: number;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly kind: 'move';
      readonly card: CalendarItem;
      // Where in the card the pointer took hold, in minutes from its top.
      readonly grab: number;
      readonly dayIndex: number;
      readonly minute: number;
      readonly moved: boolean;
    }
  | {
      readonly kind: 'resize';
      readonly card: CalendarItem;
      readonly dayIndex: number;
      readonly top: number;
      readonly end: number;
      readonly moved: boolean;
    };

const stateStyles: Readonly<Record<CardState, string>> = {
  scheduled: 'border-l-muted-foreground/60',
  running: 'border-l-state-working',
  waiting: 'border-l-state-needs-you bg-state-needs-you/15',
  done: 'border-l-state-done',
  failed: 'border-l-state-failed',
  stopped: 'border-l-muted-foreground/60',
  missed: 'border-l-state-failed',
};

const badgeStyles: Readonly<Record<CardState, string>> = {
  scheduled: 'text-muted-foreground',
  running: 'text-state-working',
  waiting: 'text-state-needs-you',
  done: 'text-state-done',
  failed: 'text-state-failed',
  stopped: 'text-muted-foreground',
  missed: 'text-state-failed',
};

const cardState = (item: CalendarItem): CardState => {
  const parsed = CardState.safeParse(item.state);
  return parsed.success ? parsed.data : 'scheduled';
};

export function StateBadge({ state }: { state: CardState }) {
  return (
    <span
      data-testid="card-state"
      className={cn('text-[10px] font-medium tracking-wide uppercase', badgeStyles[state])}
    >
      {state}
    </span>
  );
}

const timeRange = (item: CalendarItem, zone: string) =>
  `${formatTime(new Date(item.start), zone)}–${formatTime(new Date(item.end), zone)}`;

// The hover text: everything a narrow block may cut off.
const fullText = (title: string, item: CalendarItem, zone: string) =>
  [title, timeRange(item, zone), item.location].filter(Boolean).join('\n');

function OutlookBlock({ item, zone }: { item: CalendarItem; zone: string }) {
  const cancelled = item.state === 'cancelled';
  return (
    <div
      role="group"
      tabIndex={0}
      data-item="outlook"
      aria-label={`${item.title}, ${timeRange(item, zone)}${cancelled ? ', cancelled' : ''}, read-only`}
      title={fullText(item.title, item, zone)}
      className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-muted px-1.5 py-0.5 @max-[4rem]:px-0.5 text-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex min-w-0 items-center gap-1">
        <LockIcon
          aria-label="Read-only"
          className="size-3 shrink-0 text-muted-foreground @max-[4rem]:hidden"
        />
        <span className={cn('truncate font-medium', cancelled && 'line-through opacity-60')}>
          {item.title}
        </span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {timeRange(item, zone)}
        {item.location ? ` · ${item.location}` : ''}
      </span>
      {item.joinUrl && !cancelled && (
        <a
          href={item.joinUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Join Teams meeting"
          className="mt-auto inline-flex w-fit items-center gap-1 rounded border border-border bg-background px-1 text-[11px] hover:bg-accent"
        >
          <VideoIcon className="size-3" aria-hidden />
          Join
        </a>
      )}
    </div>
  );
}

function CardBlock({
  item,
  zone,
  dragging,
  onEdit,
  onRunNow,
}: {
  item: CalendarItem;
  zone: string;
  dragging: boolean;
  onEdit: () => void;
  // Set for a missed card whose trigger offers "Run now" (spec 12).
  onRunNow: (() => void) | undefined;
}) {
  const state = cardState(item);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onEdit();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-item="card"
      aria-label={`${cardTitle(item)}, ${timeRange(item, zone)}, ${state}`}
      title={fullText(cardTitle(item), item, zone)}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex h-full cursor-grab touch-none flex-col overflow-hidden rounded-md border border-l-[3px] border-border bg-card px-1.5 py-0.5 @max-[4rem]:px-0.5 text-xs shadow-sm select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        stateStyles[state],
        dragging && 'cursor-grabbing opacity-80 shadow-md',
      )}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium">{cardTitle(item)}</span>
        <span className="shrink-0 @max-[7rem]:hidden">
          <StateBadge state={state} />
        </span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{timeRange(item, zone)}</span>
      {onRunNow && (
        <button
          type="button"
          aria-label={`Run now: ${cardTitle(item)}`}
          className="mt-0.5 inline-flex w-fit items-center gap-1 rounded border border-border bg-background px-1 text-[11px] hover:bg-accent"
          // The card's own pointer handling would start a drag.
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRunNow();
          }}
        >
          <PlayIcon className="size-3" aria-hidden />
          Run now
        </button>
      )}
      <span
        data-resize
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
      />
    </div>
  );
}

export interface TimeGridProps {
  readonly days: readonly LocalDate[];
  readonly today: LocalDate;
  readonly items: readonly CalendarItem[];
  readonly zone: string;
  readonly workHours: WorkHours;
  readonly snap: number;
  readonly cardMinutes: number;
  // Pixel height of one hour: the calendar.hourHeight setting, or a zoom on its way there.
  readonly hourHeight: number;
  // Zooms by a number of steps (fractional for a pinch); returns whether the height changed. The
  // grid keeps the time under the pointer in place, or the middle of the view for other changes.
  onZoom(steps: number): boolean;
  onCreate(range: Range): void;
  onEdit(cardId: string): void;
  // Cards that offer a one-click "Run now", and what it does.
  readonly runNowIds?: ReadonlySet<string>;
  onRunNow?(cardId: string): void;
  // Stores a moved or resized card; the grid shows the new place until the server's row matches.
  onChange(cardId: string, range: Range): Promise<unknown>;
}

export function TimeGrid({
  days,
  today,
  items,
  zone,
  workHours,
  snap,
  cardMinutes,
  hourHeight,
  onZoom,
  onCreate,
  onEdit,
  runNowIds,
  onRunNow,
  onChange,
}: TimeGridProps) {
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture>();
  const [pending, setPending] = useState<ReadonlyMap<string, Range>>(new Map());
  const workStart = parseClockTime(workHours.start) ?? 0;
  const daysKey = days.map(isoDate).join(',');
  const px = (minutes: number) => (minutes / 60) * hourHeight;
  const now = useNow();
  const nowDay = localDate(now, zone);
  const nowMinute = minuteOfDay(now, zone);
  const showsToday = days.some((day) => sameDate(day, nowDay));

  // The height the grid is laid out with, and where the next zoom should pivot.
  const shownHeight = useRef(hourHeight);
  const zoomAnchor = useRef<{ readonly minute: number; readonly offset: number }>(undefined);
  const wheelCarry = useRef(0);
  const zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;
  const nowRef = useRef(nowMinute);
  nowRef.current = nowMinute;

  // Opening a range starts at work hours; when today is in it and now is outside that window, it
  // starts with now in the middle instead. Zooming does not move it back there.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const height = shownHeight.current;
    const workTop = Math.max(0, ((workStart - 30) / 60) * height);
    const nowTop = (nowRef.current / 60) * height;
    const nowVisible = nowTop >= workTop && nowTop <= workTop + element.clientHeight;
    element.scrollTop = showsToday && !nowVisible ? nowTop - element.clientHeight / 2 : workTop;
  }, [daysKey, workStart, showsToday]);

  // A new hour height keeps the anchored time at the same place on screen.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const before = shownHeight.current;
    shownHeight.current = hourHeight;
    if (!element || before === hourHeight) return;
    const anchor = zoomAnchor.current ?? {
      offset: element.clientHeight / 2,
      minute: ((element.scrollTop + element.clientHeight / 2) / before) * 60,
    };
    zoomAnchor.current = undefined;
    element.scrollTop = (anchor.minute / 60) * hourHeight - anchor.offset;
  }, [hourHeight]);

  // Ctrl+wheel and pinch (which Chromium reports as a wheel with ctrlKey) zoom the grid instead of
  // the page. React's wheel handler is passive, so this one is added by hand.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const offset = event.clientY - element.getBoundingClientRect().top;
      zoomAnchor.current = {
        offset,
        minute: ((element.scrollTop + offset) / shownHeight.current) * 60,
      };
      // A pinch sends many small deltas; they add up until they make a whole pixel.
      const steps = wheelCarry.current + wheelSteps(event);
      const changed = zoomRef.current(steps);
      wheelCarry.current = changed ? 0 : steps;
      if (!changed) zoomAnchor.current = undefined;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // A stored move replaces the pending one once the server's row shows it.
  useEffect(() => {
    setPending((current) => {
      const left = new Map(
        [...current].filter(([id, range]) => {
          const row = items.find((item) => item.id === id);
          return row !== undefined && (row.start !== range.start || row.end !== range.end);
        }),
      );
      return left.size === current.size ? current : left;
    });
  }, [items]);

  const dayAt = (index: number): LocalDate => days[index] ?? days[0] ?? today;

  const preview = (item: CalendarItem): CalendarItem => {
    if (gesture?.kind === 'move' && gesture.card.id === item.id) {
      const start = atMinute(dayAt(gesture.dayIndex), gesture.minute, zone);
      const length = Date.parse(item.end) - Date.parse(item.start);
      return {
        ...item,
        start: start.toISOString(),
        end: new Date(start.getTime() + length).toISOString(),
      };
    }
    if (gesture?.kind === 'resize' && gesture.card.id === item.id) {
      return { ...item, end: atMinute(dayAt(gesture.dayIndex), gesture.end, zone).toISOString() };
    }
    const waiting = pending.get(item.id);
    return waiting ? { ...item, ...waiting } : item;
  };
  const shown = items.map(preview);

  const locate = (event: PointerEvent): { dayIndex: number; minute: number } => {
    const rect = columnsRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { dayIndex: 0, minute: 0 };
    const dayIndex = Math.min(
      days.length - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * days.length)),
    );
    const minute = Math.min(
      MINUTES_PER_DAY,
      Math.max(0, ((event.clientY - rect.top) / hourHeight) * 60),
    );
    return { dayIndex, minute };
  };

  const capture = (event: PointerEvent) => columnsRef.current?.setPointerCapture(event.pointerId);

  const startCreate = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const { dayIndex, minute } = locate(event);
    const from = Math.min(MINUTES_PER_DAY - snap, Math.floor(minute / snap) * snap);
    capture(event);
    setGesture({ kind: 'create', dayIndex, from, to: from });
  };

  const startCard = (event: PointerEvent, placed: PlacedItem, dayIndex: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const { minute } = locate(event);
    capture(event);
    const resize =
      event.target instanceof HTMLElement && event.target.dataset['resize'] !== undefined;
    setGesture(
      resize
        ? {
            kind: 'resize',
            card: placed.item,
            dayIndex,
            top: placed.top,
            end: placed.bottom,
            moved: false,
          }
        : {
            kind: 'move',
            card: placed.item,
            grab: minute - placed.top,
            dayIndex,
            minute: placed.top,
            moved: false,
          },
    );
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!gesture) return;
    const { dayIndex, minute } = locate(event);
    if (gesture.kind === 'create') {
      const to = snapMinute(minute, snap);
      if (to !== gesture.to) setGesture({ ...gesture, to });
    } else if (gesture.kind === 'move') {
      const next = snapMinute(minute - gesture.grab, snap);
      if (next !== gesture.minute || dayIndex !== gesture.dayIndex) {
        setGesture({ ...gesture, minute: next, dayIndex, moved: true });
      }
    } else {
      const end = Math.max(gesture.top + snap, snapMinute(minute, snap));
      if (end !== gesture.end) setGesture({ ...gesture, end, moved: true });
    }
  };

  const commit = (card: CalendarItem, range: Range) => {
    setPending((current) => new Map(current).set(card.id, range));
    onChange(card.id, range).catch(() =>
      setPending((current) => {
        const left = new Map(current);
        left.delete(card.id);
        return left;
      }),
    );
  };

  const onPointerUp = () => {
    if (!gesture) return;
    setGesture(undefined);
    if (gesture.kind === 'create') {
      const day = dayAt(gesture.dayIndex);
      const from = Math.min(gesture.from, gesture.to);
      const to = Math.max(gesture.from, gesture.to);
      const start = atMinute(day, from, zone);
      // A click (no range) makes a card of the configured length.
      const end =
        to > from ? atMinute(day, to, zone) : new Date(start.getTime() + cardMinutes * 60_000);
      onCreate({ start: start.toISOString(), end: end.toISOString() });
    } else if (!gesture.moved) {
      onEdit(gesture.card.id);
    } else {
      const moved = preview(gesture.card);
      commit(gesture.card, { start: moved.start, end: moved.end });
    }
  };

  const createPreview =
    gesture?.kind === 'create'
      ? {
          dayIndex: gesture.dayIndex,
          top: Math.min(gesture.from, gesture.to),
          bottom: Math.max(gesture.from, gesture.to, Math.min(gesture.from, gesture.to) + snap),
        }
      : undefined;
  const columns = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };
  const draggingId = gesture && gesture.kind !== 'create' ? gesture.card.id : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid shrink-0 border-b border-border [scrollbar-gutter:stable] overflow-hidden"
        style={columns}
      >
        <div />
        {days.map((day) => {
          const isToday = sameDate(day, today);
          return (
            <div key={isoDate(day)} className="flex flex-col border-l border-border px-1.5 py-1">
              <span
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'text-xs',
                  isToday ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {formatDayHeading(day)}
              </span>
              <div
                className="flex min-h-5 flex-col gap-0.5 pt-0.5"
                aria-label={`All day ${isoDate(day)}`}
              >
                {allDayItemsOn(shown, day, zone).map((item) => (
                  <span
                    key={item.id}
                    className={cn(
                      'flex items-center gap-1 truncate rounded bg-muted px-1 text-[11px]',
                      item.state === 'cancelled' && 'line-through opacity-60',
                    )}
                  >
                    {item.source === 'outlook' && (
                      <LockIcon aria-label="Read-only" className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{item.title}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div
        ref={scrollRef}
        data-testid="calendar-scroll"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        <div className="grid" style={columns}>
          <div className="relative" style={{ height: px(MINUTES_PER_DAY) }} aria-hidden>
            {HOURS.slice(1).map((hour) => (
              <span
                key={hour}
                className="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground"
                style={{ top: px(hour * 60) }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          <div
            ref={columnsRef}
            className="relative grid touch-none select-none"
            style={{
              gridColumn: `2 / span ${days.length}`,
              gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            }}
            onPointerDown={startCreate}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setGesture(undefined)}
          >
            {days.map((day, dayIndex) => {
              const work = workSpan(workHours, day);
              return (
                <div
                  key={isoDate(day)}
                  data-testid={`day-${isoDate(day)}`}
                  className="relative border-l border-border"
                  style={{
                    height: px(MINUTES_PER_DAY),
                    backgroundImage:
                      'linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
                    backgroundSize: `100% ${hourHeight}px`,
                  }}
                >
                  {work && (
                    <div
                      aria-hidden
                      data-testid="work-hours"
                      className="pointer-events-none absolute inset-x-0 bg-accent/50"
                      style={{ top: px(work.top), height: px(work.bottom - work.top) }}
                    />
                  )}
                  {sameDate(day, nowDay) && (
                    <div
                      aria-hidden
                      data-testid="now-line"
                      className="pointer-events-none absolute inset-x-0 z-[15] h-0.5 bg-state-failed"
                      style={{ top: px(nowMinute) - 1 }}
                    >
                      <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-state-failed" />
                    </div>
                  )}
                  {/* Items leave a strip on the right free, so a slot next to a meeting can still
                      be clicked for a new card. */}
                  <div className="pointer-events-none absolute inset-y-0 right-2 left-0">
                    {placeTimedItems(shown, day, zone, (MIN_BLOCK_PX / hourHeight) * 60).map(
                      (placed) => (
                        <div
                          key={placed.item.id}
                          data-placed={placed.item.id}
                          className="@container pointer-events-auto absolute px-px has-focus-visible:left-0! has-focus-visible:w-full! has-focus-visible:z-30!"
                          style={{
                            top: px(placed.top),
                            height: Math.max(px(placed.bottom - placed.top), MIN_BLOCK_PX),
                            left: `${(placed.column / placed.columns) * 100}%`,
                            width: `${(placed.span / placed.columns) * 100}%`,
                            zIndex: draggingId === placed.item.id ? 20 : 10,
                          }}
                          onPointerDown={(event) =>
                            placed.item.source === 'local'
                              ? startCard(event, placed, dayIndex)
                              : event.stopPropagation()
                          }
                        >
                          {placed.item.source === 'local' ? (
                            <CardBlock
                              item={placed.item}
                              zone={zone}
                              dragging={draggingId === placed.item.id}
                              onEdit={() => onEdit(placed.item.id)}
                              onRunNow={
                                onRunNow && runNowIds?.has(placed.item.id)
                                  ? () => onRunNow(placed.item.id)
                                  : undefined
                              }
                            />
                          ) : (
                            <OutlookBlock item={placed.item} zone={zone} />
                          )}
                        </div>
                      ),
                    )}
                  </div>
                  {createPreview?.dayIndex === dayIndex && (
                    <div
                      aria-hidden
                      data-testid="new-card-preview"
                      className="pointer-events-none absolute inset-x-0.5 z-30 rounded-md border border-dashed border-ring bg-accent/60"
                      style={{
                        top: px(createPreview.top),
                        height: px(createPreview.bottom - createPreview.top),
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
