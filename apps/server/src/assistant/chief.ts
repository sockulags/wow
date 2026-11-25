import { assistantAsked } from './briefs.js';
import {
  assistantThreadId,
  briefingMomentLabels,
  freeSlots,
  isoDate,
  localDate,
  atMinute,
  parseClockTime,
  weekdayOf,
  type Briefing,
  type BriefingLine,
  type BriefingMoment,
  type DomainEvent,
  type ServerCommand,
} from '@wow/contracts';
import { and, desc, eq, gte, inArray, lt, gt, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { proposalOf } from './changes.js';
import type { Engine } from '../core/engine.js';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import { decisionRowsWithoutBriefs } from './decisions.js';
import { calendarPrefs } from './outputs.js';
import { permitFor, settingValue, today } from './permissions.js';

// The assistant's own rhythm (chief of staff spec 20 to 27): briefings at the day's moments, one
// reminder for a decision that waited long, cards moved around meetings that come to overlap
// them, and quiet while the user is in a meeting, in focus time or off work. `Chief.tick` runs on
// the scheduler's clock; what it decides goes to the engine as commands.

// ---- deciding ---------------------------------------------------------------------------

export function decideBriefing(
  command: Extract<ServerCommand, { type: 'assistant.brief' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (read.briefing(command.briefingId)) return [];
  const limit = settingValue('assistant.briefingsPerDay', read, context);
  // The Assistant thread is a main thread without wow's assistant tools (orchestrator threads
  // spec 25), so it is not asked for what only those tools could write; this goes with them.
  const ask =
    assistantAsked &&
    read.thread(assistantThreadId) !== undefined &&
    typeof limit === 'number' &&
    read.briefingSummariesSince(today(read, context).since) < limit;
  const briefing: Briefing = {
    id: command.briefingId,
    at: context.now,
    moment: command.moment,
    since: command.since,
    lines: command.lines,
    summary: null,
    summaryPending: ask,
    notified: false,
  };
  const text = `From wow: briefing ${command.briefingId} (${briefingMomentLabels[command.moment]}). ${command.lines.map((line) => line.text).join(' ')} Read what you need and write a summary for the person in two to four sentences with write_briefing_summary: what matters, what waits for them, and what you would do first.`;
  return [
    { kind: 'briefing.made', aggregate: briefing.id, payload: briefing },
    ...(ask
      ? decide({ type: 'thread.sendMessage', threadId: assistantThreadId, text }, read, {
          ...context,
          origin: 'user',
        })
      : []),
  ];
}

export function decideBriefingSummary(
  command: Extract<ServerCommand, { type: 'assistant.writeBriefingSummary' }>,
  read: ReadModel,
): DomainEvent[] {
  const briefing = read.briefing(command.briefingId);
  if (!briefing || !briefing.summaryPending) {
    throw new CommandRejected(
      'rejected',
      `wow did not ask for a summary of briefing ${command.briefingId}; write one only when asked.`,
    );
  }
  return [
    {
      kind: 'briefing.summaryWritten',
      aggregate: briefing.id,
      payload: { briefingId: briefing.id, text: command.text },
    },
  ];
}

// Off with `scheduler.notifications`, like every other notification of wow.
const notifies = (read: ReadModel, context: DecideContext): boolean =>
  settingValue('scheduler.notifications', read, context) !== false;

const notification = (
  id: string,
  kind: 'briefing' | 'reminder',
  title: string,
  body: string,
  path: string,
  at: string,
): DomainEvent => ({
  kind: 'notification.sent',
  aggregate: id,
  payload: { id, at, kind, title, body, path, calendarItemId: null },
});

export function decideBriefingNotified(
  command: Extract<ServerCommand, { type: 'assistant.briefingNotified' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const briefing = read.briefing(command.briefingId);
  if (!briefing || briefing.notified) return [];
  const marked: DomainEvent = {
    kind: 'briefing.notified',
    aggregate: briefing.id,
    payload: { briefingId: briefing.id },
  };
  if (!notifies(read, context)) return [marked];
  return [
    marked,
    notification(
      `briefing:${briefing.id}`,
      'briefing',
      briefingMomentLabels[briefing.moment],
      briefing.lines
        .slice(0, 2)
        .map((line) => line.text)
        .join(' '),
      '/chat/assistant',
      context.now,
    ),
  ];
}

export function decideReminder(
  command: Extract<ServerCommand, { type: 'assistant.remind' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const marked: DomainEvent = {
    kind: 'decision.reminded',
    aggregate: command.decisionId,
    payload: { decisionId: command.decisionId, at: context.now },
  };
  if (!notifies(read, context)) return [marked];
  return [
    marked,
    notification(
      `reminder:${command.decisionId}`,
      'reminder',
      'Still waiting for you',
      command.title,
      command.path,
      context.now,
    ),
  ];
}

export function* decideMoveCard(
  commandId: string,
  command: Extract<ServerCommand, { type: 'assistant.moveCard' }>,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const card = read.calendarItem(command.cardId);
  if (!card || card.source !== 'local' || !card.projectId) return;
  const update = {
    type: 'card.update' as const,
    cardId: card.id,
    start: command.start,
    end: command.end,
  };
  const cover = permitFor({ kind: 'moveCards', projectId: card.projectId }, read, context);
  if (cover && 'covered' in cover) {
    const worded = proposalOf(commandId, update, read, context);
    yield decide(update, read, { ...context, origin: 'user' });
    yield [
      {
        kind: 'assistant.permissionUsed',
        aggregate: commandId,
        payload: {
          id: commandId,
          at: context.now,
          permissionId: cover.covered.id,
          kind: 'moveCards',
          commandType: 'card.update',
          what: `Moved "${card.title}" off ${command.meeting}`,
          place: worded.place,
        },
      },
    ];
    return;
  }
  const proposed = proposalOf(commandId, update, read, context);
  yield [
    {
      kind: 'assistant.proposed',
      aggregate: commandId,
      payload: {
        ...proposed,
        title: `Move "${card.title}" off ${command.meeting}`,
        lines: [
          ...proposed.lines,
          {
            what: 'Why',
            from: null,
            to: cover && 'held' in cover ? cover.held : `${command.meeting} now overlaps it`,
          },
        ],
      },
    },
  ];
}

// ---- watching ---------------------------------------------------------------------------

interface ChiefDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly clock: () => Date;
}

const minute = 60_000;

export class Chief {
  readonly #deps: ChiefDeps;
  readonly #unsubscribe: () => void;
  #lastTick: number;

  constructor(deps: ChiefDeps) {
    this.#deps = deps;
    this.#lastTick = deps.clock().getTime();
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind !== 'presence.returned') continue;
        const away = Date.parse(event.payload.at) - Date.parse(event.payload.awayFrom);
        const opened = deps.db
          .select({ id: t.threads.id })
          .from(t.threads)
          .where(eq(t.threads.id, assistantThreadId))
          .get();
        if (
          opened &&
          deps.settings.get('assistant.briefings') &&
          away >= deps.settings.get('assistant.briefAfterIdleMinutes') * minute
        ) {
          queueMicrotask(() => this.#brief('back', event.payload.at));
        }
      }
    });
  }

  stop(): void {
    this.#unsubscribe();
  }

  // Busy in an Outlook meeting, inside a focus card, or outside work hours (spec 27).
  quiet(now = this.#deps.clock()): boolean {
    const { zone, workHours } = calendarPrefs(this.#deps);
    const day = localDate(now, zone);
    const open = atMinute(day, parseClockTime(workHours.start) ?? 0, zone).getTime();
    const close = atMinute(day, parseClockTime(workHours.end) ?? 24 * 60, zone).getTime();
    const at = now.getTime();
    if (!workHours.days.includes(weekdayOf(day)) || at < open || at >= close) return true;
    const iso = now.toISOString();
    return this.#deps.db
      .select()
      .from(t.calendarItems)
      .where(
        and(
          lt(t.calendarItems.start, iso),
          gt(t.calendarItems.end, iso),
          ne(t.calendarItems.state, 'cancelled'),
        ),
      )
      .all()
      .some((item) => !item.allDay && (item.source === 'outlook' || item.focus));
  }

  tick(): void {
    const now = this.#deps.clock();
    const last = this.#lastTick;
    this.#lastTick = now.getTime();
    // The assistant's rhythm starts once its conversation exists: before that nobody set it up.
    const assistant = this.#deps.db
      .select({ id: t.threads.id })
      .from(t.threads)
      .where(eq(t.threads.id, assistantThreadId))
      .get();
    if (!assistant) return;
    try {
      this.#moments(now, last);
      const quiet = this.quiet(now);
      if (!quiet) {
        this.#releaseBriefings();
        this.#remind(now);
      }
      this.#moveCards(now);
    } catch (error) {
      this.#deps.logger.error('the assistant tick failed', error);
    }
  }

  #dispatch(commandId: string, command: ServerCommand): void {
    try {
      this.#deps.engine.dispatch(commandId, command);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      this.#deps.logger.debug(`${command.type} rejected`, error.message);
    }
  }

  #moments(now: Date, last: number): void {
    if (!this.#deps.settings.get('assistant.briefings')) return;
    const { zone, workHours } = calendarPrefs(this.#deps);
    const day = localDate(now, zone);
    const date = isoDate(day);
    const made = (moment: BriefingMoment) =>
      this.#deps.db
        .select({ id: t.briefings.id })
        .from(t.briefings)
        .where(eq(t.briefings.id, `${moment}:${date}`))
        .get() !== undefined;
    if (workHours.days.includes(weekdayOf(day))) {
      const open = atMinute(day, parseClockTime(workHours.start) ?? 0, zone).getTime();
      const close = atMinute(day, parseClockTime(workHours.end) ?? 24 * 60, zone).getTime();
      const at = now.getTime();
      if (at >= open && at < close && !made('morning'))
        this.#brief('morning', now.toISOString(), `morning:${date}`);
      if (at >= close && !made('evening'))
        this.#brief('evening', now.toISOString(), `evening:${date}`);
    }
    // A long meeting that ended since the last tick, if something happened while it ran.
    const long = this.#deps.settings.get('assistant.briefAfterMeetingMinutes') * minute;
    const ended = this.#deps.db
      .select()
      .from(t.calendarItems)
      .where(
        and(
          eq(t.calendarItems.source, 'outlook'),
          gt(t.calendarItems.end, new Date(last).toISOString()),
          lt(t.calendarItems.end, new Date(now.getTime() + 1).toISOString()),
          ne(t.calendarItems.state, 'cancelled'),
        ),
      )
      .all()
      .filter(
        (meeting) => !meeting.allDay && Date.parse(meeting.end) - Date.parse(meeting.start) >= long,
      );
    for (const meeting of ended) {
      if (this.#lines(meeting.start).happened) {
        this.#brief('afterMeeting', now.toISOString(), `afterMeeting:${meeting.id}`, meeting.start);
      }
    }
  }

  // What wow says itself since `since` (spec 21), and whether anything happened.
  #lines(since: string): { lines: BriefingLine[]; happened: boolean } {
    const { db } = this.#deps;
    const uses = db
      .select()
      .from(t.assistantPermissionUses)
      .where(gte(t.assistantPermissionUses.at, since))
      .all();
    const decisions = decisionRowsWithoutBriefs(db);
    const lines: BriefingLine[] = [];
    for (const use of uses)
      lines.push({ text: `The assistant: ${use.what}.`, path: use.place.path });
    lines.push({
      text:
        decisions.length === 0
          ? 'Nothing waits for you.'
          : `${decisions.length} wait${decisions.length === 1 ? 's' : ''} for you, first: ${decisions
              .slice(0, 3)
              .map((row) => row.title)
              .join('; ')}.`,
      path: '/chat/assistant',
    });
    const happened = uses.length > 0 || decisions.length > 0;
    return { lines: [...lines, ...this.#rest()], happened };
  }

  // The rest of today: cards still to come and the free time left.
  #rest(): BriefingLine[] {
    const now = this.#deps.clock();
    const { zone, workHours } = calendarPrefs(this.#deps);
    const day = localDate(now, zone);
    const end = atMinute(day, parseClockTime(workHours.end) ?? 24 * 60, zone);
    if (now >= end) return [];
    const cards = this.#deps.db
      .select()
      .from(t.calendarItems)
      .where(
        and(
          eq(t.calendarItems.source, 'local'),
          gte(t.calendarItems.start, now.toISOString()),
          lt(t.calendarItems.start, end.toISOString()),
        ),
      )
      .all();
    const busy = this.#deps.db
      .select()
      .from(t.calendarItems)
      .where(
        and(
          lt(t.calendarItems.start, end.toISOString()),
          gt(t.calendarItems.end, now.toISOString()),
          ne(t.calendarItems.state, 'cancelled'),
        ),
      )
      .all()
      .filter((item) => !item.allDay)
      .map((item) => ({
        title: item.title,
        start: Date.parse(item.start),
        end: Date.parse(item.end),
      }))
      .toSorted((a, b) => a.start - b.start);
    const free = freeSlots({
      from: now,
      to: end,
      zone,
      workHours,
      busy,
      // Every gap counts, however short; the whole of each is added up.
      minutes: this.#deps.settings.get('calendar.snapMinutes'),
      snapMinutes: this.#deps.settings.get('calendar.snapMinutes'),
      limit: Number.POSITIVE_INFINITY,
    });
    const freeMinutes = free.reduce(
      (sum, slot) => sum + (Date.parse(slot.end) - Date.parse(slot.start)) / minute,
      0,
    );
    return [
      ...(cards.length > 0
        ? [
            {
              text: `Still today: ${cards.map((card) => card.title).join(', ')}.`,
              path: '/calendar',
            },
          ]
        : []),
      {
        text: `${Math.round(freeMinutes)} free minutes left in your work hours.`,
        path: '/calendar',
      },
    ];
  }

  #brief(
    moment: BriefingMoment,
    at: string,
    id = `${moment}:${randomUUID()}`,
    since?: string,
  ): void {
    const previous = this.#deps.db
      .select({ at: t.briefings.at })
      .from(t.briefings)
      .orderBy(desc(t.briefings.at))
      .get();
    const from = since ?? previous?.at ?? new Date(Date.parse(at) - 24 * 60 * minute).toISOString();
    this.#dispatch(`brief:${id}`, {
      type: 'assistant.brief',
      briefingId: id,
      moment,
      since: from,
      lines: this.#lines(from).lines,
    });
    if (!this.quiet()) this.#releaseBriefings();
  }

  #releaseBriefings(): void {
    for (const briefing of this.#deps.db
      .select()
      .from(t.briefings)
      .where(eq(t.briefings.notified, false))
      .all()) {
      this.#dispatch(`brief-notified:${briefing.id}`, {
        type: 'assistant.briefingNotified',
        briefingId: briefing.id,
      });
    }
  }

  #remind(now: Date): void {
    const after = this.#deps.settings.get('assistant.remindAfterMinutes') * minute;
    const reminded = new Set(
      this.#deps.db
        .select({ id: t.decisionReminders.decisionId })
        .from(t.decisionReminders)
        .all()
        .map((row) => row.id),
    );
    for (const row of decisionRowsWithoutBriefs(this.#deps.db)) {
      if (reminded.has(row.id) || now.getTime() - Date.parse(row.at) < after) continue;
      this.#dispatch(`remind:${row.id}`, {
        type: 'assistant.remind',
        decisionId: row.id,
        title: row.title,
        path: row.path,
      });
    }
  }

  // Cards with a workflow whose trigger has not fired and that an Outlook meeting now overlaps
  // move to the next free slot of the same length in work hours (spec 24).
  #moveCards(now: Date): void {
    const { db } = this.#deps;
    const scheduled = new Set(
      db
        .select({ cardId: t.triggers.calendarItemId })
        .from(t.triggers)
        .where(eq(t.triggers.state, 'scheduled'))
        .all()
        .map((row) => row.cardId),
    );
    const cards = db
      .select()
      .from(t.calendarItems)
      .where(and(eq(t.calendarItems.source, 'local'), gt(t.calendarItems.start, now.toISOString())))
      .all()
      .filter(
        (card) => card.workflowId && card.projectId && !card.repeat && scheduled.has(card.id),
      );
    if (cards.length === 0) return;
    const meetings = db
      .select()
      .from(t.calendarItems)
      .where(
        and(
          eq(t.calendarItems.source, 'outlook'),
          ne(t.calendarItems.state, 'cancelled'),
          gt(t.calendarItems.end, now.toISOString()),
        ),
      )
      .all()
      .filter((meeting) => !meeting.allDay);
    const { zone, workHours } = calendarPrefs(this.#deps);
    for (const card of cards) {
      const meeting = meetings.find((entry) => entry.start < card.end && entry.end > card.start);
      if (!meeting) continue;
      const length = Date.parse(card.end) - Date.parse(card.start);
      const busy = db
        .select()
        .from(t.calendarItems)
        .where(
          and(
            ne(t.calendarItems.state, 'cancelled'),
            gt(t.calendarItems.end, now.toISOString()),
            inArray(t.calendarItems.source, ['outlook', 'local']),
          ),
        )
        .all()
        .filter((item) => !item.allDay && item.id !== card.id)
        .map((item) => ({
          title: item.title,
          start: Date.parse(item.start),
          end: Date.parse(item.end),
        }))
        .toSorted((a, b) => a.start - b.start);
      const [slot] = freeSlots({
        from: new Date(Math.max(now.getTime(), Date.parse(meeting.end))),
        to: new Date(now.getTime() + 7 * 24 * 60 * minute),
        zone,
        workHours,
        busy,
        minutes: Math.ceil(length / minute),
        snapMinutes: this.#deps.settings.get('calendar.snapMinutes'),
        limit: 1,
      });
      if (!slot) continue;
      const start = slot.start;
      const end = new Date(Date.parse(start) + length).toISOString();
      this.#dispatch(`move:${card.id}:${card.start}:${start}`, {
        type: 'assistant.moveCard',
        cardId: card.id,
        start,
        end,
        meeting: meeting.title || 'a meeting',
      });
    }
  }
}
