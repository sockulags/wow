import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { ClockTime, Weekday } from '@wow/contracts';
import { ProfileResult } from './protocol.js';

// Fixtures are invented and placed relative to "today", so the mock calendar always has something
// in the visible week.

const FixtureAppointment = z
  .object({
    entryId: z.string().min(1),
    subject: z.string(),
    location: z.string().nullable().default(null),
    body: z.string().nullable().default(null),
    organizer: z.string().nullable().default(null),
    busyStatus: z.number().int().default(2),
    cancelled: z.boolean().default(false),
    // One occurrence `dayOffset` days from today, or one on every listed weekday in the window.
    dayOffset: z.number().int().optional(),
    weekdays: z.array(Weekday).min(1).optional(),
    // Timed items have a start time and a length; all-day items span whole days.
    time: ClockTime.optional(),
    minutes: z.number().int().positive().optional(),
    allDayDays: z.number().int().positive().optional(),
  })
  .refine((item) => (item.dayOffset === undefined) !== (item.weekdays === undefined), {
    message: 'Give either dayOffset or weekdays',
  })
  .refine(
    (item) =>
      (item.allDayDays !== undefined) !== (item.time !== undefined && item.minutes !== undefined),
    { message: 'Give either time and minutes, or allDayDays' },
  );
export type FixtureAppointment = z.infer<typeof FixtureAppointment>;

// What the mock answers to `profile`, in the bridge's own shape. Without a profile.json it says
// nothing, like an Outlook whose work hours were never set.
export const emptyProfile: ProfileResult = {
  timeZoneId: null,
  workHoursXml: null,
  firstDayOfWeek: null,
  address: null,
};

export const OutlookFixtures = z.object({
  appointments: z.array(FixtureAppointment),
  profile: ProfileResult.default(emptyProfile),
});
export type OutlookFixtures = z.infer<typeof OutlookFixtures>;
export type OutlookFixturesInput = z.input<typeof OutlookFixtures>;

export const defaultFixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

export async function loadFixtures(dir: string = defaultFixturesDir): Promise<OutlookFixtures> {
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  const calendar = z
    .object({ appointments: z.array(z.unknown()) })
    .parse(await read('calendar.json'));
  const profile = await read('profile.json').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return OutlookFixtures.parse({
    appointments: calendar.appointments,
    profile,
  });
}
