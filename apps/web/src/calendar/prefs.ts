import { resolveCalendarPrefs, type CalendarPrefs, type OutlookProfile } from '@wow/contracts';
import { settingValue, type SettingValues } from '@wow/client-runtime';
import { useMemo } from 'react';
import { useSetting } from '@/app/runtime';
import { useTopic } from '@/chat/data';

// The calendar's zone, first day of the week and work hours with "outlook" resolved against the
// profile Outlook last returned (F-8). Everything in the calendar reads these instead of the raw
// settings, so a view never sees the "outlook" placeholder.

export function calendarPrefs(
  values: SettingValues,
  profile: OutlookProfile | null | undefined,
): CalendarPrefs {
  return resolveCalendarPrefs(
    {
      zone: settingValue(values, 'calendar.zone'),
      firstDayOfWeek: settingValue(values, 'calendar.firstDayOfWeek'),
      workHours: settingValue(values, 'calendar.workHours'),
    },
    profile,
  );
}

export function useOutlookProfile(): OutlookProfile | null {
  return useTopic('outlookStatus')?.[0]?.profile ?? null;
}

export function useCalendarPrefs(): CalendarPrefs {
  const zone = useSetting('calendar.zone');
  const firstDayOfWeek = useSetting('calendar.firstDayOfWeek');
  const workHours = useSetting('calendar.workHours');
  const profile = useOutlookProfile();
  return useMemo(
    () => resolveCalendarPrefs({ zone, firstDayOfWeek, workHours }, profile),
    [zone, firstDayOfWeek, workHours, profile],
  );
}
