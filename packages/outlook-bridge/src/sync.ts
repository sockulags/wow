import {
  FROM_OUTLOOK,
  resolveCalendarPrefs,
  type OutlookProfile,
  type Weekday,
} from '@wow/contracts';
import { parseProfile } from './profile.js';
import { bodySnippet, type Appointment, type UnreadMessage } from './protocol.js';
import {
  OutlookError,
  systemClock,
  type CalendarWindow,
  type Clock,
  type OutlookErrorCode,
  type OutlookSource,
} from './source.js';
import { calendarWindow } from './zone.js';

// Rows in the shape of the `calendar_items` (source 'outlook') and `mail_items` projections. The
// server stores them; this package decides what they contain and what changed.

export type OutlookItemState = 'scheduled' | 'cancelled';

export interface OutlookCalendarEntry {
  readonly id: string;
  readonly externalId: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly zone: string;
  readonly location: string | null;
  readonly joinUrl: string | null;
  readonly allDay: boolean;
  readonly recurring: boolean;
  readonly organizer: string | null;
  readonly snippet: string | null;
  readonly busyStatus: number | null;
  readonly state: OutlookItemState;
}

export interface OutlookMailEntry {
  readonly id: string;
  readonly externalId: string;
  readonly folder: string;
  readonly from: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly unread: true;
  readonly snippet: string;
}

// Occurrences of a recurring meeting share the series' EntryID, so the occurrence start is part of
// the key. A moved occurrence therefore replaces the old row instead of updating it.
export function calendarExternalId(appointment: Appointment): string {
  return appointment.isRecurring
    ? `${appointment.entryId}@${new Date(appointment.start).toISOString()}`
    : appointment.entryId;
}

// The EntryID to ask Outlook to open for a calendar row's external id: a recurring occurrence
// opens its series. EntryIDs are hex, so "@" only ever comes from calendarExternalId.
export const entryIdOf = (externalId: string): string => externalId.split('@')[0] ?? externalId;

export function toCalendarEntry(appointment: Appointment, zone: string): OutlookCalendarEntry {
  const externalId = calendarExternalId(appointment);
  return {
    id: `outlook:${externalId}`,
    externalId,
    title: appointment.subject,
    start: new Date(appointment.start).toISOString(),
    end: new Date(appointment.end).toISOString(),
    zone,
    location: appointment.location,
    joinUrl: appointment.joinUrl,
    allDay: appointment.isAllDay,
    recurring: appointment.isRecurring,
    organizer: appointment.organizer,
    snippet: bodySnippet(appointment.body),
    busyStatus: appointment.busyStatus,
    state: appointment.isCancelled ? 'cancelled' : 'scheduled',
  };
}

export function toMailEntry(message: UnreadMessage): OutlookMailEntry {
  return {
    id: `outlook-mail:${message.entryId}`,
    externalId: message.entryId,
    folder: message.folder,
    from: message.from,
    subject: message.subject,
    receivedAt: new Date(message.receivedAt).toISOString(),
    unread: true,
    snippet: message.snippet,
  };
}

export interface OutlookSnapshot {
  readonly at: string;
  readonly window: CalendarWindow;
  readonly calendar: readonly OutlookCalendarEntry[];
  // Empty when the mail rail is off, so the rail's rows are cleared.
  readonly mail: readonly OutlookMailEntry[];
  readonly unreadCount: number;
  readonly bridgeVersion: string;
  // Null when Outlook could not say this poll (the sink keeps the last one).
  readonly profile: OutlookProfile | null;
}

export interface OutlookFailure {
  readonly at: string;
  readonly code: OutlookErrorCode;
  readonly message: string;
  // The first failed poll since the last good one; drives "Outlook unavailable since <time>".
  readonly unavailableSince: string;
}

// What the server provides: turn a snapshot into projection changes plus an `outlook_status`
// update, and a failure into an `outlook_status` error while keeping the cached rows.
export interface OutlookSink {
  synced(snapshot: OutlookSnapshot): void | Promise<void>;
  failed(failure: OutlookFailure): void | Promise<void>;
}

export interface RowChanges<Row> {
  readonly upsert: readonly Row[];
  readonly remove: readonly string[];
}

const sameRow = <Row extends object>(a: Row, b: Row): boolean => {
  const left = new Map<string, unknown>(Object.entries(a));
  const right = new Map<string, unknown>(Object.entries(b));
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
};

// Outlook rows overlapping the polled window that Outlook no longer returns were deleted there;
// rows outside the window are left alone so the cache keeps history.
export function diffCalendar(
  existing: readonly OutlookCalendarEntry[],
  snapshot: Pick<OutlookSnapshot, 'window' | 'calendar'>,
): RowChanges<OutlookCalendarEntry> {
  const from = Date.parse(snapshot.window.from);
  const to = Date.parse(snapshot.window.to);
  const before = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set(snapshot.calendar.map((row) => row.id));
  return {
    upsert: snapshot.calendar.filter((row) => {
      const old = before.get(row.id);
      return !old || !sameRow(old, row);
    }),
    remove: existing
      .filter(
        (row) => !seen.has(row.id) && Date.parse(row.start) < to && Date.parse(row.end) > from,
      )
      .map((row) => row.id),
  };
}

// The mail rail mirrors what is unread now, so anything not returned is gone.
export function diffMail(
  existing: readonly OutlookMailEntry[],
  mail: readonly OutlookMailEntry[],
): RowChanges<OutlookMailEntry> {
  const before = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set(mail.map((row) => row.id));
  return {
    upsert: mail.filter((row) => {
      const old = before.get(row.id);
      return !old || !sameRow(old, row);
    }),
    remove: existing.filter((row) => !seen.has(row.id)).map((row) => row.id),
  };
}

export interface OutlookSyncSettings {
  readonly pollSeconds: number;
  // The settings as stored: "outlook" follows the profile read in the same poll.
  readonly zone: string;
  readonly firstDayOfWeek: Weekday | typeof FROM_OUTLOOK;
  readonly lookaheadDays: number;
  readonly folders: readonly string[];
  readonly mailRail: boolean;
  readonly mailLimit: number;
}

export interface OutlookSyncOptions {
  readonly source: OutlookSource;
  readonly sink: OutlookSink;
  // Read at every poll so settings changes apply without a restart.
  readonly settings: () => OutlookSyncSettings;
  readonly clock?: Clock;
  // A sink that throws must not stop polling; the server logs it.
  readonly onError?: (error: unknown) => void;
}

export type SyncOutcome = 'synced' | 'failed';

// Polls the source every `outlook.pollSeconds`. One poll at a time; the next is scheduled when the
// current one has finished, so a slow Outlook never stacks requests.
export class OutlookSync {
  readonly #source: OutlookSource;
  readonly #sink: OutlookSink;
  readonly #settings: () => OutlookSyncSettings;
  readonly #clock: Clock;
  readonly #onError: (error: unknown) => void;
  #timer: unknown = null;
  #running: Promise<void> | null = null;
  #started = false;
  #unavailableSince: string | null = null;
  // The last profile Outlook returned, for polls where reading it fails.
  #profile: OutlookProfile | null = null;

  constructor(options: OutlookSyncOptions) {
    this.#source = options.source;
    this.#sink = options.sink;
    this.#settings = options.settings;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#poll();
  }

  // Resolves when the poll in flight, if any, has been handed to the sink.
  async whenIdle(): Promise<void> {
    await this.#running;
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
    await this.#source.close();
  }

  async syncOnce(): Promise<SyncOutcome> {
    const settings = this.#settings();
    const now = this.#clock.now();
    const at = now.toISOString();
    let snapshot: OutlookSnapshot;
    try {
      const ping = await this.#source.ping();
      if (ping.outlook === 'unavailable') {
        throw new OutlookError('unavailable', ping.message ?? 'Outlook is not running');
      }
      const profile = await this.#readProfile(now);
      const prefs = resolveCalendarPrefs(
        { zone: settings.zone, firstDayOfWeek: settings.firstDayOfWeek, workHours: FROM_OUTLOOK },
        profile ?? this.#profile,
      );
      const zone = prefs.zone;
      const window = calendarWindow(now, {
        zone,
        firstDayOfWeek: prefs.firstDayOfWeek,
        lookaheadDays: settings.lookaheadDays,
      });
      const appointments = await this.#source.calendar(window);
      const mail = settings.mailRail
        ? await this.#source.unreadMail(settings.folders, settings.mailLimit)
        : { items: [], unreadCount: 0 };
      snapshot = {
        at,
        window,
        calendar: appointments.map((appointment) => toCalendarEntry(appointment, zone)),
        mail: mail.items.map(toMailEntry),
        unreadCount: mail.unreadCount,
        bridgeVersion: ping.version,
        profile,
      };
    } catch (error) {
      this.#unavailableSince ??= at;
      const failure =
        error instanceof OutlookError
          ? { code: error.code, message: error.message }
          : {
              code: 'failed' as const,
              message: error instanceof Error ? error.message : String(error),
            };
      await this.#sink.failed({ at, ...failure, unavailableSince: this.#unavailableSince });
      return 'failed';
    }
    this.#unavailableSince = null;
    await this.#sink.synced(snapshot);
    return 'synced';
  }

  // A profile Outlook cannot read (an old mailbox, a missing work-hours message) is not a failed
  // poll: the calendar and mail still sync, and the settings keep their fallback.
  async #readProfile(now: Date): Promise<OutlookProfile | null> {
    try {
      const profile = parseProfile(await this.#source.profile(), now);
      this.#profile = profile;
      return profile;
    } catch (error) {
      if (error instanceof OutlookError && error.code === 'unavailable') throw error;
      return null;
    }
  }

  #poll(): void {
    this.#timer = null;
    this.#running = this.syncOnce()
      .then(
        () => {},
        (error: unknown) => this.#onError(error),
      )
      .finally(() => {
        this.#running = null;
        if (this.#started) {
          this.#timer = this.#clock.setTimeout(
            () => this.#poll(),
            this.#settings().pollSeconds * 1000,
          );
        }
      });
  }
}
