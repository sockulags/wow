import { OutlookFixtures, type OutlookFixturesInput, type FixtureAppointment } from './fixtures.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  findJoinUrl,
  type Appointment,
  type BridgeOp,
  type PingResult,
  type ProfileResult,
} from './protocol.js';
import {
  OutlookError,
  systemClock,
  type CalendarWindow,
  type Clock,
  type OutlookSource,
} from './source.js';
import {
  addDays,
  localDate,
  resolveZone,
  startOfDay,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from './zone.js';
import { windowsIdOf } from './windows-zones.js';

export interface MockOutlookOptions {
  readonly fixtures: OutlookFixturesInput;
  readonly clock?: Clock;
  // Zone the fixture times are written in; "system" by default, like Outlook's own clock.
  readonly zone?: string;
}

// Answers like bridge.ps1 from fixtures. Tests and the Playwright suite change the fixtures or
// make it unavailable to exercise moved, cancelled and failing cases.
export class MockOutlookSource implements OutlookSource {
  readonly kind = 'mock';
  readonly opened: string[] = [];
  // Every operation asked of it, in order, so tests can see what a sync reads from Outlook.
  readonly asked: BridgeOp[] = [];
  #fixtures: OutlookFixtures;
  #unavailable: string | null = null;
  readonly #clock: Clock;
  readonly #zone: string;

  constructor(options: MockOutlookOptions) {
    this.#fixtures = OutlookFixtures.parse(options.fixtures);
    this.#clock = options.clock ?? systemClock;
    this.#zone = resolveZone(options.zone ?? 'system');
  }

  setFixtures(fixtures: OutlookFixturesInput): void {
    this.#fixtures = OutlookFixtures.parse(fixtures);
  }

  // A message makes every request fail as if Outlook were closed; null brings it back.
  setUnavailable(message: string | null): void {
    this.#unavailable = message;
  }

  async ping(): Promise<PingResult> {
    this.asked.push('ping');
    return this.#unavailable === null
      ? { version: `mock-${BRIDGE_PROTOCOL_VERSION}`, outlook: 'available', message: null }
      : {
          version: `mock-${BRIDGE_PROTOCOL_VERSION}`,
          outlook: 'unavailable',
          message: this.#unavailable,
        };
  }

  async calendar(window: CalendarWindow): Promise<Appointment[]> {
    this.asked.push('calendar');
    this.#assertAvailable();
    const from = new Date(window.from);
    const to = new Date(window.to);
    const today = localDate(this.#clock.now(), this.#zone);
    const items: Appointment[] = [];
    for (const fixture of this.#fixtures.appointments) {
      for (const day of this.#days(fixture, today, from, to)) {
        const appointment = this.#occurrence(fixture, day);
        if (new Date(appointment.start) < to && new Date(appointment.end) > from) {
          items.push(appointment);
        }
      }
    }
    return items.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async open(entryId: string): Promise<void> {
    this.asked.push('open');
    this.#assertAvailable();
    this.opened.push(entryId);
  }

  // A fixture profile without a zone answers with the zone the fixtures are written in.
  async profile(): Promise<ProfileResult> {
    this.asked.push('profile');
    this.#assertAvailable();
    const profile = this.#fixtures.profile;
    return profile.timeZoneId === null
      ? { ...profile, timeZoneId: windowsIdOf(this.#zone, this.#clock.now()) }
      : profile;
  }

  async close(): Promise<void> {}

  #assertAvailable(): void {
    if (this.#unavailable !== null) throw new OutlookError('unavailable', this.#unavailable);
  }

  #days(fixture: FixtureAppointment, today: LocalDate, from: Date, to: Date): LocalDate[] {
    if (fixture.dayOffset !== undefined) return [addDays(today, fixture.dayOffset)];
    const weekdays = new Set(fixture.weekdays);
    const days: LocalDate[] = [];
    // One day before the window start catches items that begin before it and run into it.
    for (
      let day = addDays(localDate(from, this.#zone), -1);
      startOfDay(day, this.#zone) < to;
      day = addDays(day, 1)
    ) {
      if (weekdays.has(weekdayOf(day))) days.push(day);
    }
    return days;
  }

  #occurrence(fixture: FixtureAppointment, day: LocalDate): Appointment {
    let start: Date;
    let end: Date;
    if (fixture.allDayDays !== undefined) {
      start = startOfDay(day, this.#zone);
      end = startOfDay(addDays(day, fixture.allDayDays), this.#zone);
    } else {
      const [hour = 0, minute = 0] = (fixture.time ?? '00:00').split(':').map(Number);
      start = zonedInstant({ ...day, hour, minute }, this.#zone);
      end = new Date(start.getTime() + (fixture.minutes ?? 0) * 60_000);
    }
    return {
      entryId: fixture.entryId,
      subject: fixture.subject,
      start: start.toISOString(),
      end: end.toISOString(),
      location: fixture.location,
      isAllDay: fixture.allDayDays !== undefined,
      isRecurring: fixture.weekdays !== undefined,
      isCancelled: fixture.cancelled,
      organizer: fixture.organizer,
      joinUrl: findJoinUrl(fixture.body, fixture.location),
      busyStatus: fixture.busyStatus,
      body: fixture.body,
    };
  }
}
