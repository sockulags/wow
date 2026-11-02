import type { OutlookProfile } from './projections.js';
import { FROM_OUTLOOK, Weekday, type WorkHours } from './settings.js';

// The calendar's zone, first day of the week and work hours, after "outlook" (the default) is
// resolved against what Outlook last said (F-8). The server uses it for the polled window, the
// web app for the grid; both get the same answer from the same stored profile.

export type PrefSource = 'outlook' | 'system' | 'setting';

export interface CalendarPrefs {
  readonly zone: string;
  readonly zoneSource: PrefSource;
  readonly firstDayOfWeek: Weekday;
  readonly firstDayOfWeekSource: PrefSource;
  readonly workHours: WorkHours;
  readonly workHoursSource: PrefSource;
}

export interface CalendarPrefSettings {
  readonly zone: string;
  readonly firstDayOfWeek: Weekday | typeof FROM_OUTLOOK;
  readonly workHours: WorkHours | typeof FROM_OUTLOOK;
}

// What the system offers while Outlook has not said. These were the settings' defaults before
// Outlook was read, and an explicit value in settings always wins over them.
export const systemWorkHours: WorkHours = {
  start: '08:00',
  end: '17:00',
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
};

export const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

// Intl numbers week days 1 (Monday) to 7 (Sunday), the order of `Weekday`.
const intlWeekdays: readonly Weekday[] = Weekday.options;

interface WeekInfo {
  readonly firstDay?: number;
}

// The first day of the week of the system's region, Monday where the runtime cannot tell.
export function systemFirstDayOfWeek(locale?: string): Weekday {
  try {
    const resolved = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale);
    const withInfo = resolved as Intl.Locale & {
      readonly weekInfo?: WeekInfo;
      readonly getWeekInfo?: () => WeekInfo;
    };
    const info = withInfo.getWeekInfo?.() ?? withInfo.weekInfo;
    const day = info?.firstDay;
    return (day === undefined ? undefined : intlWeekdays[day - 1]) ?? 'monday';
  } catch {
    return 'monday';
  }
}

export function resolveZoneSetting(
  setting: string,
  profile: OutlookProfile | null | undefined,
): { readonly zone: string; readonly source: PrefSource } {
  if (setting === FROM_OUTLOOK) {
    return profile?.zone
      ? { zone: profile.zone, source: 'outlook' }
      : { zone: systemZone(), source: 'system' };
  }
  if (setting === 'system') return { zone: systemZone(), source: 'system' };
  return { zone: setting, source: 'setting' };
}

export function resolveCalendarPrefs(
  settings: CalendarPrefSettings,
  profile: OutlookProfile | null | undefined,
): CalendarPrefs {
  const zone = resolveZoneSetting(settings.zone, profile);
  const firstDay =
    settings.firstDayOfWeek !== FROM_OUTLOOK
      ? { value: settings.firstDayOfWeek, source: 'setting' as const }
      : profile?.firstDayOfWeek
        ? { value: profile.firstDayOfWeek, source: 'outlook' as const }
        : { value: systemFirstDayOfWeek(), source: 'system' as const };
  const workHours =
    settings.workHours !== FROM_OUTLOOK
      ? { value: settings.workHours, source: 'setting' as const }
      : profile?.workHours
        ? { value: profile.workHours, source: 'outlook' as const }
        : { value: systemWorkHours, source: 'system' as const };
  return {
    zone: zone.zone,
    zoneSource: zone.source,
    firstDayOfWeek: firstDay.value,
    firstDayOfWeekSource: firstDay.source,
    workHours: workHours.value,
    workHoursSource: workHours.source,
  };
}
