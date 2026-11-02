import { Weekday, WorkHours, systemZone, type OutlookProfile } from '@wow/contracts';
import type { ProfileResult } from './protocol.js';
import { ianaZoneOf } from './windows-zones.js';

// Turns what the bridge read from Outlook (F-8) into the calendar's profile. Anything that does
// not parse is null, so the calendar falls back to the system's value for that part only.

// .NET DayOfWeek order: 0 is Sunday.
const dotnetWeekdays: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const xmlText = (xml: string, tag: string): string | undefined => {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([^<]*)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return match?.[1]?.trim();
};

// "08:00:00" or "08:00" to "08:00".
const clock = (text: string | undefined): string | undefined => {
  const match = text ? /^(\d{1,2}):(\d{2})/.exec(text) : null;
  return match ? `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}` : undefined;
};

// The WorkingHours.xsd document Outlook keeps in the calendar folder's IPM.Configuration.WorkHours
// message: a TimeSlot with Start and End, and WorkDays as space-separated English day names.
export function parseWorkHoursXml(xml: string | null | undefined): {
  readonly workHours: WorkHours | null;
  readonly timeZoneId: string | null;
} {
  if (!xml) return { workHours: null, timeZoneId: null };
  const slot = /<(?:\w+:)?TimeSlot\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TimeSlot>/i.exec(xml)?.[1] ?? '';
  const days = (xmlText(xml, 'WorkDays') ?? '')
    .split(/\s+/)
    .map((day) => day.toLowerCase())
    .filter((day): day is Weekday => Weekday.safeParse(day).success);
  const parsed = WorkHours.safeParse({
    start: clock(xmlText(slot, 'Start')),
    end: clock(xmlText(slot, 'End')),
    days: Weekday.options.filter((day) => days.includes(day)),
  });
  const zoneBlock = /<(?:\w+:)?TimeZone\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TimeZone>/i.exec(xml)?.[1];
  return {
    workHours: parsed.success ? parsed.data : null,
    timeZoneId: (zoneBlock ? xmlText(zoneBlock, 'Name') : undefined) || null,
  };
}

const offsetAt = (zone: string, instant: Date): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value ?? '';

// A Windows zone maps to one city per region ("W. Europe Standard Time" is Europe/Berlin). When
// the system zone keeps the same clock all year, it is the more precise name for the same zone.
export function preferSystemZone(zone: string, system: string, now: Date): string {
  if (zone === system) return zone;
  try {
    const later = new Date(now.getTime() + 182 * 24 * 60 * 60 * 1000);
    const same = [now, later].every(
      (instant) => offsetAt(zone, instant) === offsetAt(system, instant),
    );
    return same ? system : zone;
  } catch {
    return zone;
  }
}

export function parseProfile(
  result: ProfileResult,
  now: Date,
  system: string = systemZone(),
): OutlookProfile {
  const fromXml = parseWorkHoursXml(result.workHoursXml);
  const mapped = ianaZoneOf(result.timeZoneId) ?? ianaZoneOf(fromXml.timeZoneId);
  const address = result.address?.trim() ?? '';
  return {
    zone: mapped ? preferSystemZone(mapped, system, now) : null,
    workHours: fromXml.workHours,
    firstDayOfWeek:
      result.firstDayOfWeek === null ? null : (dotnetWeekdays[result.firstDayOfWeek] ?? null),
    address: address.includes('@') ? address : null,
  };
}
