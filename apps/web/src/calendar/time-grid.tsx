import { CardState, type CalendarItem, type WorkHours } from '@wow/contracts';
import { LockIcon, VideoIcon } from 'lucide-react';
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
  MINUTES_PER_DAY,
  parseClockTime,
  sameDate,
  type LocalDate,
} from './time';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

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

function OutlookBlock({ item, zone }: { item: CalendarItem; zone: string }) {
  const cancelled = item.state === 'cancelled';
  return (
    <div
      role="group"
      data-item="outlook"
      aria-label={`${item.title}, ${timeRange(item, zone)}${cancelled ? ', cancelled' : ''}, read-only`}
      className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs"
    >
      <span className="flex min-w-0 items-center gap-1">
        <LockIcon aria-label="Read-only" className="size-3 shrink-0 text-muted-foreground" />
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
}: {
  item: CalendarItem;
  zone: string;
  dragging: boolean;
  onEdit: () => void;
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
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex h-full cursor-grab touch-none flex-col overflow-hidden rounded-md border border-l-[3px] border-border bg-card px-1.5 py-0.5 text-xs shadow-sm select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        stateStyles[state],
        dragging && 'cursor-grabbing opacity-80 shadow-md',
      )}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium">{cardTitle(item)}</span>
        <StateBadge state={state} />
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{timeRange(item, zone)}</span>
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
  // Pixel height of one hour (the calendar.hourHeight setting).
  readonly hourHeight: number;
  onCreate(range: Range): void;
  onEdit(cardId: string): void;
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
  onCreate,
  onEdit,
  onChange,
}: TimeGridProps) {
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture>();
  const [pending, setPending] = useState<ReadonlyMap<string, Range>>(new Map());
  const workStart = parseClockTime(workHours.start) ?? 0;
  const daysKey = days.map(isoDate).join(',');
  const px = (minutes: number) => (minutes / 60) * hourHeight;

  // Start the day at work hours instead of midnight.
  useLayoutEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = Math.max(0, ((workStart - 30) / 60) * hourHeight);
  }, [daysKey, workStart, hourHeight]);

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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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
                  {placeTimedItems(shown, day, zone).map((placed) => (
                    <div
                      key={placed.item.id}
                      className="absolute px-px"
                      style={{
                        top: px(placed.top),
                        height: Math.max(px(placed.bottom - placed.top), 18),
                        left: `${(placed.lane / placed.lanes) * 100}%`,
                        width: `${100 / placed.lanes}%`,
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
                        />
                      ) : (
                        <OutlookBlock item={placed.item} zone={zone} />
                      )}
                    </div>
                  ))}
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
