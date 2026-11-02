import { resolveCalendarPrefs, systemWorkHours } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { loadFixtures } from './fixtures.js';
import { MockOutlookSource } from './mock-source.js';
import { FakeClock } from './testing.js';
import { parseProfile, parseWorkHoursXml, preferSystemZone } from './profile.js';
import { ProfileResult } from './protocol.js';
import { ianaZoneOf, windowsIdOf } from './windows-zones.js';

// Invented roaming XML in the shape Outlook writes to IPM.Configuration.WorkHours.
const workHoursXml = (start: string, end: string, days: string, zone = 'GMT Standard Time') =>
  `<?xml version="1.0"?><Root xmlns="WorkingHours.xsd"><WorkHoursVersion1><TimeZone><Bias>0</Bias><Name>${zone}</Name></TimeZone><TimeSlot><Start>${start}</Start><End>${end}</End></TimeSlot><WorkDays>${days}</WorkDays></WorkHoursVersion1></Root>`;

const now = new Date('2026-11-04T09:00:00Z');

describe('Outlook profile (F-8)', () => {
  it('reads work hours, days and the zone name from the work-hours XML', () => {
    expect(
      parseWorkHoursXml(workHoursXml('07:30:00', '16:00:00', 'Sunday Monday Tuesday Wednesday')),
    ).toEqual({
      workHours: {
        start: '07:30',
        end: '16:00',
        days: ['monday', 'tuesday', 'wednesday', 'sunday'],
      },
      timeZoneId: 'GMT Standard Time',
    });
  });

  it('gives null work hours for missing, empty or inverted slots', () => {
    expect(parseWorkHoursXml(null).workHours).toBeNull();
    expect(parseWorkHoursXml('<Root/>').workHours).toBeNull();
    expect(parseWorkHoursXml(workHoursXml('17:00:00', '08:00:00', 'Monday')).workHours).toBeNull();
    expect(parseWorkHoursXml(workHoursXml('08:00:00', '17:00:00', '')).workHours).toBeNull();
  });

  it('maps Windows zone ids to IANA zones and leaves unknown ones out', () => {
    expect(ianaZoneOf('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(ianaZoneOf('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(ianaZoneOf('Not A Zone')).toBeNull();
    expect(ianaZoneOf(null)).toBeNull();
    expect(windowsIdOf('Asia/Tokyo')).toBe('Tokyo Standard Time');
    expect(windowsIdOf('Europe/Stockholm', now)).toBe('W. Europe Standard Time');
  });

  it('names the zone after the system city when both keep the same clock all year', () => {
    expect(preferSystemZone('Europe/Berlin', 'Europe/Stockholm', now)).toBe('Europe/Stockholm');
    expect(preferSystemZone('Europe/Berlin', 'Europe/London', now)).toBe('Europe/Berlin');
    // Brisbane has no daylight saving; Sydney does, so they differ half the year.
    expect(preferSystemZone('Australia/Sydney', 'Australia/Brisbane', now)).toBe(
      'Australia/Sydney',
    );
  });

  it('turns a bridge answer into a profile, with Outlook zone first and the XML zone second', () => {
    const result = ProfileResult.parse({
      timeZoneId: 'Tokyo Standard Time',
      workHoursXml: workHoursXml('09:00:00', '18:00:00', 'Monday Friday'),
      firstDayOfWeek: 0,
      address: ' ada@lantern.example ',
    });
    expect(parseProfile(result, now, 'UTC')).toEqual({
      zone: 'Asia/Tokyo',
      workHours: { start: '09:00', end: '18:00', days: ['monday', 'friday'] },
      firstDayOfWeek: 'sunday',
      address: 'ada@lantern.example',
    });
    expect(parseProfile({ ...result, timeZoneId: null }, now, 'UTC').zone).toBe('Europe/London');
    expect(
      parseProfile(
        {
          timeZoneId: null,
          workHoursXml: null,
          firstDayOfWeek: null,
          address: '/o=Lantern/cn=ada',
        },
        now,
        'UTC',
      ),
    ).toEqual({ zone: null, workHours: null, firstDayOfWeek: null, address: null });
  });

  it('ships invented mock fixtures that parse to a full profile in the fixtures zone', async () => {
    const source = new MockOutlookSource({
      fixtures: await loadFixtures(),
      zone: 'Europe/Stockholm',
      clock: new FakeClock(now.toISOString()),
    });
    const answer = await source.profile();
    expect(answer.timeZoneId).toBe('W. Europe Standard Time');
    expect(parseProfile(answer, now, 'Europe/Stockholm')).toEqual({
      zone: 'Europe/Stockholm',
      workHours: {
        start: '08:30',
        end: '17:00',
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
      firstDayOfWeek: 'monday',
      address: 'you@lantern.example',
    });
  });

  it('falls back to the system per part while Outlook has not said, and settings win', () => {
    const stored = { zone: 'outlook', firstDayOfWeek: 'outlook', workHours: 'outlook' } as const;
    const empty = { zone: null, workHours: null, firstDayOfWeek: null, address: null };
    const fallback = resolveCalendarPrefs(stored, empty);
    expect(fallback).toMatchObject({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      zoneSource: 'system',
      workHours: systemWorkHours,
      workHoursSource: 'system',
      firstDayOfWeekSource: 'system',
    });
    expect(resolveCalendarPrefs(stored, undefined).zoneSource).toBe('system');
    const outlook = resolveCalendarPrefs(stored, {
      ...empty,
      zone: 'Asia/Tokyo',
      firstDayOfWeek: 'sunday',
    });
    expect(outlook).toMatchObject({
      zone: 'Asia/Tokyo',
      zoneSource: 'outlook',
      firstDayOfWeek: 'sunday',
      firstDayOfWeekSource: 'outlook',
      workHoursSource: 'system',
    });
    expect(
      resolveCalendarPrefs(
        { zone: 'Europe/Paris', firstDayOfWeek: 'saturday', workHours: systemWorkHours },
        { ...empty, zone: 'Asia/Tokyo', firstDayOfWeek: 'sunday' },
      ),
    ).toMatchObject({
      zone: 'Europe/Paris',
      zoneSource: 'setting',
      firstDayOfWeek: 'saturday',
      firstDayOfWeekSource: 'setting',
      workHoursSource: 'setting',
    });
  });
});
