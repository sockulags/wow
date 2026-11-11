import type { CalendarItem, WorkHours } from '@wow/contracts';
import {
  AlertTriangleIcon,
  LockIcon,
  PlayIcon,
  Repeat2Icon,
  VideoIcon,
  WorkflowIcon,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { cardTitle } from './commands';
import {
  applyCardKey,
  cardKeyChange,
  gridMove,
  nextStop,
  stopKey,
  type GridStop,
} from './grid-keys';
import { cardKind, cardState, meetingPlace, occurrenceStateLabels, timeRange } from './items';
import {
  allDayItemsOn,
  capColumns,
  placeTimedItems,
  snapMinute,
  workSpan,
  type CalendarViewKind,
  type OverflowChip,
  type PlacedItem,
} from './layout';
import type { OccurrenceState, ShownOccurrence } from './occurrences';
import { OutlookDetails, type NewCardRange } from './outlook-details';
import {
  atMinute,
  formatShortDay,
  isoDate,
  isWeekend,
  localDate,
  minuteOfDay,
  MINUTES_PER_DAY,
  parseClockTime,
  sameDate,
  startOfDay,
  type LocalDate,
} from './time';
import { wheelSteps } from './zoom';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The shortest a block is drawn, so a 5-minute meeting stays readable when zoomed out; the
// layout gives short items this much room so their blocks sit beside the next item.
const MIN_BLOCK_PX = 18;
// One text line in a block (12px text on a 16px line) and the block's vertical padding.
const LINE_PX = 16;
const BLOCK_PADDING_PX = 4;
// The height of an xs button row (Join, Run now).
const BUTTON_LINES = 2;
const MAX_TITLE_LINES = 3;

// How a block spends its height (audit B-13): the title wraps into the lines left after the time
// and any buttons, and a block too short for a button row gets Join as an icon on the title line.
export function blockLines(
  heightPx: number,
  { extra = 0, button = false }: { extra?: number; button?: boolean } = {},
) {
  const lines = Math.max(1, Math.floor((heightPx - BLOCK_PADDING_PX) / LINE_PX));
  const showTime = lines >= 2;
  const showButton = button && lines >= 2 + BUTTON_LINES;
  const showExtra = extra > 0 && lines >= 2 + extra + (showButton ? BUTTON_LINES : 0);
  const used = (showTime ? 1 : 0) + (showExtra ? extra : 0) + (showButton ? BUTTON_LINES : 0);
  return {
    titleLines: Math.min(MAX_TITLE_LINES, Math.max(1, lines - used)),
    showTime,
    showButton,
    showExtra,
  };
}

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

// Only triggers carry a state color; plain cards keep the neutral event border.
const stateBorder: Readonly<Record<OccurrenceState, string>> = {
  scheduled: 'border-l-muted-foreground',
  running: 'border-l-state-working',
  waiting: 'border-l-state-needs-you bg-state-needs-you/15',
  done: 'border-l-state-done',
  failed: 'border-l-state-failed',
  stopped: 'border-l-muted-foreground',
  missed: 'border-l-state-failed',
  skipped: 'border-l-muted-foreground',
};

const stateText: Readonly<Record<OccurrenceState, string>> = {
  scheduled: 'text-muted-foreground',
  running: 'text-state-working',
  waiting: 'text-state-needs-you',
  done: 'text-state-done',
  failed: 'text-state-failed',
  stopped: 'text-muted-foreground',
  missed: 'text-state-failed',
  skipped: 'text-muted-foreground',
};

export function StateBadge({ state }: { state: OccurrenceState }) {
  return (
    <span data-testid="card-state" className={cn('text-2xs font-medium', stateText[state])}>
      {occurrenceStateLabels[state]}
    </span>
  );
}

// The time a block shows: a block continued from the day before says when it ends.
const blockTime = (item: CalendarItem, zone: string, day: LocalDate) =>
  Date.parse(item.start) < startOfDay(day, zone).getTime()
    ? `until ${timeRange(item, zone).split('–')[1] ?? ''}`
    : timeRange(item, zone);

// What a card block says: its own state, or for an occurrence of a repeating card the state of
// that occurrence (none for one that ran nothing).
const blockState = (
  item: CalendarItem,
  occurrence: ShownOccurrence | undefined,
): OccurrenceState | null =>
  cardKind(item) !== 'trigger' ? null : occurrence ? occurrence.state : cardState(item);

const itemLabel = (item: CalendarItem, zone: string, occurrence?: ShownOccurrence): string => {
  if (item.source !== 'local') {
    const cancelled = item.state === 'cancelled' ? ', cancelled' : '';
    return `${item.title}, ${timeRange(item, zone)}${cancelled}, read-only`;
  }
  const kind = cardKind(item);
  const state = blockState(item, occurrence);
  const suffix =
    kind === 'unrunnable'
      ? ', no project, will not run'
      : state
        ? `, ${occurrenceStateLabels[state].toLowerCase()}`
        : '';
  const repeats = occurrence ? ', repeats' : '';
  return `${cardTitle(item)}, ${timeRange(item, zone)}${repeats}${suffix}`;
};

// Everything a narrow block may cut off, on hover and on keyboard focus (audit A-15, B-13).
function BlockTooltip({
  lines,
  disabled,
  children,
}: {
  lines: readonly (string | null | undefined)[];
  disabled: boolean;
  children: ReactElement;
}) {
  const shown = lines.filter((line): line is string => Boolean(line));
  return (
    <Tooltip open={disabled ? false : undefined}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" align="start" data-testid="block-tooltip">
        <span className="flex flex-col">
          {shown.map((line, index) => (
            <span key={index} className={index === 0 ? 'font-medium' : undefined}>
              {line}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

interface BlockProps {
  readonly item: CalendarItem;
  readonly zone: string;
  readonly day: LocalDate;
  readonly heightPx: number;
  readonly stop: string;
  readonly active: boolean;
  // Shown in the context panel; only marked while the panel is open.
  readonly selected: boolean;
}

const blockBase =
  'relative flex h-full flex-col overflow-clip rounded-md border px-1.5 py-0.5 text-xs outline-none @max-[4rem]:px-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';
const selectedBlock = 'ring-2 ring-ring ring-offset-1 ring-offset-background';

// The title stays in view while a tall block is scrolled past (its row is sticky), and wraps on
// whole words into the lines it has; a narrow block keeps it on one line with an ellipsis.
function Title({
  lines,
  className,
  children,
}: {
  lines: number;
  className?: string;
  children: string;
}) {
  return (
    <span
      className={cn(
        'min-w-0 flex-1 font-medium',
        lines === 1 ? 'truncate' : 'line-clamp-3 @max-[5rem]:truncate',
        className,
      )}
      style={lines === 1 ? undefined : { WebkitLineClamp: lines }}
    >
      {children}
    </span>
  );
}

function OutlookBlock({
  item,
  zone,
  day,
  heightPx,
  stop,
  active,
  selected,
  open,
  onOpenChange,
  cardMinutes,
  onNewCard,
}: BlockProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cardMinutes: number;
  readonly onNewCard: (range: NewCardRange) => void;
}) {
  const cancelled = item.state === 'cancelled';
  const place = meetingPlace(item.location, item.joinUrl);
  const join = item.joinUrl && !cancelled ? item.joinUrl : undefined;
  const layout = blockLines(heightPx, { button: join !== undefined });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BlockTooltip lines={[item.title, blockTime(item, zone, day), place]} disabled={open}>
        <PopoverTrigger asChild>
          <div
            role="button"
            tabIndex={active ? 0 : -1}
            data-item="outlook"
            data-stop={stop}
            aria-haspopup="dialog"
            aria-label={itemLabel(item, zone)}
            aria-current={selected ? 'true' : undefined}
            className={cn(
              blockBase,
              'cursor-pointer border-event-outlook-border bg-event-outlook hover:brightness-[0.98] dark:hover:brightness-110',
              selected && selectedBlock,
            )}
          >
            <span className="sticky top-0 flex min-w-0 items-start gap-1">
              <LockIcon
                aria-label="Read-only"
                className="mt-0.5 size-3 shrink-0 text-muted-foreground @max-[4rem]:hidden"
              />
              <Title
                lines={layout.titleLines}
                className={cn(cancelled && 'line-through opacity-60')}
              >
                {item.title}
              </Title>
              {join && !layout.showButton && (
                <a
                  href={join}
                  target="_blank"
                  rel="noreferrer"
                  tabIndex={-1}
                  aria-label="Join Teams meeting"
                  className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                  onClick={(event) => event.stopPropagation()}
                >
                  <VideoIcon className="size-3.5" aria-hidden />
                </a>
              )}
            </span>
            {layout.showTime && (
              <span className="shrink-0 truncate text-2xs text-muted-foreground tabular-nums">
                {blockTime(item, zone, day)}
                {place ? ` · ${place}` : ''}
              </span>
            )}
            {join && layout.showButton && (
              <Button
                asChild
                size="xs"
                variant="outline"
                className="mt-auto w-fit shrink-0 @max-[4rem]:px-1"
              >
                <a
                  href={join}
                  target="_blank"
                  rel="noreferrer"
                  tabIndex={-1}
                  aria-label="Join Teams meeting"
                  onClick={(event) => event.stopPropagation()}
                >
                  <VideoIcon aria-hidden />
                  <span className="@max-[4rem]:hidden">Join</span>
                </a>
              </Button>
            )}
          </div>
        </PopoverTrigger>
      </BlockTooltip>
      <PopoverContent side="right" align="start" className="w-80">
        <OutlookDetails
          item={item}
          zone={zone}
          cardMinutes={cardMinutes}
          onNewCard={(range) => {
            onOpenChange(false);
            onNewCard(range);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function CardBlock({
  item,
  zone,
  day,
  heightPx,
  stop,
  active,
  selected,
  dragging,
  onRunNow,
  occurrence,
}: BlockProps & {
  readonly dragging: boolean;
  // Set for a missed card whose trigger offers "Run now" (spec 12).
  readonly onRunNow: (() => void) | undefined;
  // Set for one occurrence of a repeating card (recurring cards spec 15).
  readonly occurrence: ShownOccurrence | undefined;
}) {
  const state = blockState(item, occurrence);
  const kind = cardKind(item);
  // A reached occurrence stays where it was: it opens its run and does not move.
  const fixed = occurrence?.record != null;
  const layout = blockLines(heightPx, {
    extra: kind === 'unrunnable' ? 1 : 0,
    button: onRunNow !== undefined,
  });
  return (
    <BlockTooltip
      lines={[
        cardTitle(item),
        blockTime(item, zone, day),
        occurrence ? 'Repeats' : undefined,
        state
          ? occurrenceStateLabels[state]
          : kind === 'unrunnable'
            ? 'No project, will not run'
            : undefined,
        occurrence?.record?.reason,
      ]}
      disabled={dragging}
    >
      <div
        role="button"
        tabIndex={active ? 0 : -1}
        data-item="card"
        data-kind={kind}
        data-stop={stop}
        data-repeating={occurrence ? '' : undefined}
        aria-label={itemLabel(item, zone, occurrence)}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          blockBase,
          'touch-none border-event-card-border bg-event-card shadow-xs select-none',
          fixed ? 'cursor-pointer' : 'cursor-grab',
          kind === 'trigger' && cn('border-l-[3px]', stateBorder[state ?? 'scheduled']),
          kind === 'unrunnable' && 'border-dashed',
          dragging && 'cursor-grabbing opacity-80 shadow-md',
          selected && selectedBlock,
        )}
      >
        <span className="sticky top-0 flex min-w-0 items-start gap-1">
          {kind === 'trigger' && (
            <WorkflowIcon
              aria-hidden
              className="mt-0.5 size-3 shrink-0 text-muted-foreground @max-[4rem]:hidden"
            />
          )}
          {kind === 'unrunnable' && (
            <AlertTriangleIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-warning" />
          )}
          <Title lines={layout.titleLines}>{cardTitle(item)}</Title>
          {occurrence && (
            <Repeat2Icon
              aria-hidden
              data-testid="card-repeats"
              className="mt-0.5 size-3 shrink-0 text-muted-foreground @max-[3rem]:hidden"
            />
          )}
          {state && (
            <span className="shrink-0 @max-[7rem]:hidden">
              <StateBadge state={state} />
            </span>
          )}
        </span>
        {layout.showTime && (
          <span className="shrink-0 truncate text-2xs text-muted-foreground tabular-nums">
            {blockTime(item, zone, day)}
          </span>
        )}
        {layout.showExtra && (
          <span className="shrink-0 truncate text-2xs text-warning @max-[5rem]:hidden">
            No project, will not run
          </span>
        )}
        {onRunNow && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            tabIndex={-1}
            aria-label={`Run now: ${cardTitle(item)}`}
            className={cn(
              'w-fit shrink-0',
              layout.showButton ? 'mt-auto' : 'absolute top-0 right-0',
            )}
            // The card's own pointer handling would start a drag.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRunNow();
            }}
          >
            <PlayIcon aria-hidden />
            Run now
          </Button>
        )}
        {!fixed && (
          <span
            data-resize
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          />
        )}
      </div>
    </BlockTooltip>
  );
}

// "+N" for the items of a crowded week-view cluster (audit B-02). Its popover lists them; a card
// opens its dialog and a meeting shows its details in place.
function OverflowButton({
  chip,
  zone,
  stop,
  active,
  open,
  onOpenChange,
  cardMinutes,
  onEdit,
  onNewCard,
  onSelect,
}: {
  readonly chip: OverflowChip;
  readonly zone: string;
  readonly stop: string;
  readonly active: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cardMinutes: number;
  readonly onEdit: (cardId: string) => void;
  readonly onNewCard: (range: NewCardRange) => void;
  // Shows the item in the context panel; false when the panel is closed and the item opens here.
  readonly onSelect: (itemId: string) => boolean;
}) {
  const [meeting, setMeeting] = useState<CalendarItem>();
  const count = chip.items.length;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setMeeting(undefined);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          tabIndex={active ? 0 : -1}
          data-stop={stop}
          data-item="overflow"
          aria-haspopup="dialog"
          aria-label={`${count} more ${count === 1 ? 'item' : 'items'}`}
          className="h-5 w-full justify-center px-1 tabular-nums"
        >
          +{count}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-80 p-2">
        {meeting ? (
          <div className="p-2">
            <OutlookDetails
              item={meeting}
              zone={zone}
              cardMinutes={cardMinutes}
              onNewCard={(range) => {
                onOpenChange(false);
                onNewCard(range);
              }}
            />
          </div>
        ) : (
          <ul aria-label="Overlapping items" className="flex flex-col gap-0.5">
            {chip.items.map((item) => (
              <li key={item.id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-2 py-1.5 text-left"
                  onClick={() => {
                    if (onSelect(item.id)) onOpenChange(false);
                    else if (item.source === 'local') {
                      onOpenChange(false);
                      onEdit(item.id);
                    } else setMeeting(item);
                  }}
                >
                  {item.source === 'local' ? (
                    <WorkflowIcon
                      aria-hidden
                      className={cn(cardKind(item) !== 'trigger' && 'invisible')}
                    />
                  ) : (
                    <LockIcon aria-hidden className="text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {item.source === 'local' ? cardTitle(item) : item.title}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                    {timeRange(item, zone)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export interface TimeGridProps {
  readonly view: CalendarViewKind;
  readonly days: readonly LocalDate[];
  readonly today: LocalDate;
  readonly items: readonly CalendarItem[];
  readonly zone: string;
  readonly workHours: WorkHours;
  readonly snap: number;
  readonly cardMinutes: number;
  // Week view: most items side by side in one day before a "+N" chip (calendar.weekMaxColumns).
  readonly maxColumns: number;
  // Pixel height of one hour: the calendar.hourHeight setting, or a zoom on its way there.
  readonly hourHeight: number;
  // Zooms by a number of steps (fractional for a pinch); returns whether the height changed. The
  // grid keeps the time under the pointer in place, or the middle of the view for other changes.
  onZoom(steps: number): boolean;
  // The hour height at which the whole day fills the view; zooming out stops there.
  onFloor?(height: number): void;
  onCreate(range: Range): void;
  onEdit(cardId: string): void;
  // The item shown in the context panel, and whether the panel is open. While it is, a click or
  // Enter selects an item for the panel instead of opening its dialog or popover, and the arrow
  // keys move the selection with the focus (owner decision F-1).
  readonly selectedId?: string | undefined;
  readonly panelShown?: boolean;
  onSelect?(itemId: string): void;
  // Cards that offer a one-click "Run now", and what it does.
  readonly runNowIds?: ReadonlySet<string>;
  onRunNow?(cardId: string): void;
  // Stores a moved or resized card; the grid shows the new place until the server's row matches.
  onChange(cardId: string, range: Range): Promise<unknown>;
  // The occurrences of repeating cards among `items`, by item id. An occurrence moves within its
  // own day only, and one already reached does not move at all.
  readonly occurrences?: ReadonlyMap<string, ShownOccurrence>;
  // The key that asks how to delete the focused card (keybindings.calendarDeleteCard).
  readonly deleteKey?: string;
  onDelete?(itemId: string): void;
}

type ShownDay = {
  readonly day: LocalDate;
  readonly blocks: readonly PlacedItem[];
  readonly overflow: readonly OverflowChip[];
};

export function TimeGrid({
  view,
  days,
  today,
  items,
  zone,
  workHours,
  snap,
  cardMinutes,
  maxColumns,
  hourHeight,
  onZoom,
  onFloor,
  onCreate,
  onEdit,
  selectedId,
  panelShown = false,
  onSelect,
  runNowIds,
  onRunNow,
  onChange,
  occurrences,
  deleteKey,
  onDelete,
}: TimeGridProps) {
  // The panel shows the card, whichever of its occurrences was chosen.
  const cardIdOf = (itemId: string): string => occurrences?.get(itemId)?.cardId ?? itemId;
  // True when the panel takes the item; the caller opens it in place otherwise.
  const select = (itemId: string): boolean => {
    onSelect?.(cardIdOf(itemId));
    return panelShown;
  };
  const fixedItem = (itemId: string): boolean => occurrences?.get(itemId)?.record != null;
  const columnsRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture>();
  const [pending, setPending] = useState<ReadonlyMap<string, Range>>(new Map());
  // Roving focus: the one item that takes Tab, and the popover that is open.
  const [activeStop, setActiveStop] = useState<string>();
  const [openStop, setOpenStop] = useState<string>();
  const focusAfterRender = useRef<string>(undefined);
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
  const floorRef = useRef(onFloor);
  floorRef.current = onFloor;
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

  // The view's height decides how far zooming out may go: never past a whole day.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const report = () => {
      if (element.clientHeight > 0) floorRef.current?.(element.clientHeight / 24);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  // A card moved with the keyboard keeps the focus, even when it lands in another column.
  useLayoutEffect(() => {
    const key = focusAfterRender.current;
    if (key === undefined) return;
    const element = columnsRef.current?.querySelector<HTMLElement>(
      `[data-stop="${CSS.escape(key)}"]`,
    );
    if (element) {
      focusAfterRender.current = undefined;
      element.focus();
    }
  });

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

  const shownDays: ShownDay[] = days.map((day) => {
    const placed = placeTimedItems(shown, day, zone, (MIN_BLOCK_PX / hourHeight) * 60);
    if (view === 'day') return { day, blocks: placed, overflow: [] };
    const capped = capColumns(placed, maxColumns);
    return { day, blocks: capped.shown, overflow: capped.overflow };
  });

  // Every focusable stop in reading order: by day, then by start, then left to right.
  const stops: GridStop[] = shownDays.flatMap(({ blocks, overflow }, dayIndex) =>
    [
      ...blocks.map((placed) => ({
        key: stopKey(dayIndex, placed.item.id),
        dayIndex,
        top: placed.top,
        column: placed.column,
      })),
      ...overflow.map((chip) => ({
        key: stopKey(dayIndex, `+${chip.cluster}`),
        dayIndex,
        top: chip.top,
        column: chip.column,
      })),
    ].toSorted((a, b) => a.top - b.top || a.column - b.column),
  );
  const todayIndex = days.findIndex((day) => sameDate(day, today));
  const rovingStop =
    activeStop !== undefined && stops.some((stop) => stop.key === activeStop)
      ? activeStop
      : (stops.find((stop) => stop.dayIndex === todayIndex) ?? stops[0])?.key;

  const focusStop = (key: string | undefined) => {
    if (key === undefined) return;
    setActiveStop(key);
    columnsRef.current?.querySelector<HTMLElement>(`[data-stop="${CSS.escape(key)}"]`)?.focus();
  };

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
      if (fixedItem(gesture.card.id)) return;
      const next = snapMinute(minute - gesture.grab, snap);
      // An occurrence moves within its day; another day would be a change of the rule.
      const toDay = occurrences?.has(gesture.card.id) ? gesture.dayIndex : dayIndex;
      if (next !== gesture.minute || toDay !== gesture.dayIndex) {
        setGesture({ ...gesture, minute: next, dayIndex: toDay, moved: true });
      }
    } else {
      if (fixedItem(gesture.card.id)) return;
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
      if (!select(gesture.card.id)) onEdit(gesture.card.id);
    } else {
      const moved = preview(gesture.card);
      commit(gesture.card, { start: moved.start, end: moved.end });
    }
  };

  const itemOfStop = (key: string): CalendarItem | undefined => {
    const [dayPart, ...rest] = key.split(':');
    const id = rest.join(':');
    return shownDays[Number(dayPart)]?.blocks.find((placed) => placed.item.id === id)?.item;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-stop]');
    const key = target?.dataset['stop'];
    if (key === undefined || target !== event.target) return;
    const move = gridMove(event);
    if (move) {
      event.preventDefault();
      const next = nextStop(stops, key, move);
      focusStop(next);
      const nextItem = next === undefined ? undefined : itemOfStop(next);
      if (panelShown && nextItem) onSelect?.(nextItem.id);
      return;
    }
    const item = itemOfStop(key);
    const binding = eventToBinding(event);
    if (
      item?.source === 'local' &&
      onDelete &&
      deleteKey &&
      binding !== undefined &&
      binding === normalizeBinding(deleteKey)
    ) {
      event.preventDefault();
      onDelete(item.id);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      // Enter on the card the panel already shows opens its form.
      const shownInPanel = panelShown && item !== undefined && cardIdOf(item.id) === selectedId;
      if (item && !shownInPanel && select(item.id)) return;
      if (shownInPanel && item?.source !== 'local') return;
      if (item?.source === 'local') onEdit(item.id);
      else setOpenStop(key);
      return;
    }
    if (item?.source !== 'local') return;
    const change = cardKeyChange(event, snap);
    if (!change) return;
    event.preventDefault();
    if (fixedItem(item.id)) return;
    const range = applyCardKey(preview(item), change, zone, snap);
    const occurrence = occurrences?.get(item.id);
    if (occurrence && isoDate(localDate(new Date(range.start), item.zone)) !== occurrence.date)
      return;
    commit(item, range);
    const landed = days.findIndex((day) => sameDate(day, localDate(new Date(range.start), zone)));
    const next = stopKey(landed === -1 ? Number(key.split(':')[0]) : landed, item.id);
    focusAfterRender.current = next;
    setActiveStop(next);
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
  const newCard = (range: NewCardRange) => onCreate(range);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid shrink-0 border-b border-border [scrollbar-gutter:stable] overflow-hidden"
        style={columns}
      >
        <div />
        {days.map((day) => {
          const isToday = sameDate(day, today);
          const weekend = isWeekend(day);
          return (
            <div
              key={isoDate(day)}
              className="flex min-w-0 flex-col border-l border-border px-1.5 py-1"
            >
              <span
                aria-current={isToday ? 'date' : undefined}
                aria-label={formatShortDay(day)}
                className={cn(
                  'flex items-center gap-1 text-xs',
                  isToday
                    ? 'font-medium text-foreground'
                    : weekend
                      ? 'text-muted-foreground/70'
                      : 'text-muted-foreground',
                )}
              >
                {DAY_NAMES[new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()]}
                <span
                  className={cn(
                    'inline-flex size-6 items-center justify-center rounded-full tabular-nums',
                    isToday && 'bg-primary text-primary-foreground',
                  )}
                >
                  {day.day}
                </span>
              </span>
              <div
                className="flex min-h-5 flex-col gap-0.5 pt-0.5"
                aria-label={`All day ${isoDate(day)}`}
              >
                {allDayItemsOn(shown, day, zone).map((item) => (
                  <span
                    key={item.id}
                    className={cn(
                      'flex items-center gap-1 truncate rounded-sm border border-event-outlook-border bg-event-outlook px-1 text-2xs',
                      item.source === 'local' && 'border-event-card-border bg-event-card',
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
                className="absolute right-1.5 -translate-y-1/2 text-2xs text-muted-foreground tabular-nums"
                style={{ top: px(hour * 60) }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
            {showsToday && (
              <span
                data-testid="now-dot"
                className="absolute -right-1 z-[5] size-2 -translate-y-1/2 rounded-full bg-event-now"
                style={{ top: px(nowMinute) }}
              />
            )}
          </div>
          <div
            ref={columnsRef}
            id="calendar-grid"
            role="group"
            aria-label={stops.length === 0 ? 'Calendar grid, no items' : 'Calendar grid'}
            aria-describedby="calendar-grid-keys"
            tabIndex={stops.length === 0 ? 0 : undefined}
            className="relative grid touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{
              gridColumn: `2 / span ${days.length}`,
              gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            }}
            onPointerDown={startCreate}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setGesture(undefined)}
            onKeyDown={onKeyDown}
          >
            <span id="calendar-grid-keys" className="sr-only">
              Arrow keys move between items, Enter opens one. Alt with the arrow keys moves a card,
              Alt+Shift with up or down changes its end.
            </span>
            {shownDays.map(({ day, blocks, overflow }, dayIndex) => {
              const work = workSpan(workHours, day);
              const isNowDay = sameDate(day, nowDay);
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
                      className="pointer-events-none absolute inset-x-0 bg-event-work-hours"
                      style={{ top: px(work.top), height: px(work.bottom - work.top) }}
                    />
                  )}
                  {/* Under the items, so it never covers their text; faint on the other days. */}
                  {showsToday && (
                    <div
                      aria-hidden
                      data-testid={isNowDay ? 'now-line' : 'now-line-faint'}
                      className={cn(
                        'pointer-events-none absolute inset-x-0 z-[5] bg-event-now',
                        isNowDay ? 'h-0.5' : 'h-px opacity-30',
                      )}
                      style={{ top: px(nowMinute) - (isNowDay ? 1 : 0) }}
                    />
                  )}
                  {/* Items leave a strip on the right free, so a slot next to a meeting can still
                      be clicked for a new card. */}
                  <div className="pointer-events-none absolute inset-y-0 right-2 left-0">
                    {blocks.map((placed) => {
                      const key = stopKey(dayIndex, placed.item.id);
                      const heightPx = Math.max(px(placed.bottom - placed.top), MIN_BLOCK_PX);
                      const common = {
                        item: placed.item,
                        zone,
                        day,
                        heightPx,
                        stop: key,
                        active: rovingStop === key,
                        selected: panelShown && selectedId === cardIdOf(placed.item.id),
                      };
                      return (
                        <div
                          key={placed.item.id}
                          data-placed={placed.item.id}
                          className="@container pointer-events-auto absolute px-px has-focus-visible:left-0! has-focus-visible:w-full! has-focus-visible:z-30!"
                          style={{
                            top: px(placed.top),
                            height: heightPx,
                            left: `${(placed.column / placed.columns) * 100}%`,
                            width: `${(placed.span / placed.columns) * 100}%`,
                            zIndex: draggingId === placed.item.id ? 20 : 10,
                          }}
                          onFocus={() => setActiveStop(key)}
                          onPointerDown={(event) =>
                            placed.item.source === 'local'
                              ? startCard(event, placed, dayIndex)
                              : event.stopPropagation()
                          }
                        >
                          {placed.item.source === 'local' ? (
                            <CardBlock
                              {...common}
                              dragging={draggingId === placed.item.id}
                              occurrence={occurrences?.get(placed.item.id)}
                              onRunNow={
                                onRunNow && runNowIds?.has(placed.item.id)
                                  ? () => onRunNow(placed.item.id)
                                  : undefined
                              }
                            />
                          ) : (
                            <OutlookBlock
                              {...common}
                              open={openStop === key}
                              onOpenChange={(next) => {
                                if (next && select(placed.item.id)) return;
                                setOpenStop(next ? key : undefined);
                              }}
                              cardMinutes={cardMinutes}
                              onNewCard={newCard}
                            />
                          )}
                        </div>
                      );
                    })}
                    {overflow.map((chip) => {
                      const key = stopKey(dayIndex, `+${chip.cluster}`);
                      return (
                        <div
                          key={key}
                          className="pointer-events-auto absolute z-10 px-px"
                          style={{
                            top: px(chip.top),
                            left: `${(chip.column / chip.columns) * 100}%`,
                            width: `${100 / chip.columns}%`,
                          }}
                          onFocus={() => setActiveStop(key)}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <OverflowButton
                            chip={chip}
                            zone={zone}
                            stop={key}
                            active={rovingStop === key}
                            open={openStop === key}
                            onOpenChange={(next) => setOpenStop(next ? key : undefined)}
                            cardMinutes={cardMinutes}
                            onEdit={onEdit}
                            onNewCard={newCard}
                            onSelect={select}
                          />
                        </div>
                      );
                    })}
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
