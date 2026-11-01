import { z } from 'zod';

// Every tunable value in wow is one entry here. The server validates writes against `schema`, and
// the settings UI renders fields from it, so adding a setting needs no other code.

export const SettingScope = z.enum(['global', 'project', 'provider']);
export type SettingScope = z.infer<typeof SettingScope>;

export const SettingGroup = z.enum([
  'providers',
  'calendar',
  'outlook',
  'scheduler',
  'workflows',
  'skills',
  'trackers',
  'appearance',
  'keybindings',
  'desktop',
  'advanced',
]);
export type SettingGroup = z.infer<typeof SettingGroup>;

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly default: z.output<S>;
  readonly scope: SettingScope;
  readonly restartRequired?: boolean;
  readonly secret?: boolean;
}

const defineSetting = <S extends z.ZodType>(definition: SettingDefinition<S>) => definition;

export const Weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export type Weekday = z.infer<typeof Weekday>;

const isTimeZone = (zone: string): boolean => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
};

export const TimeZoneSetting = z.string().refine((zone) => zone === 'system' || isTimeZone(zone), {
  message: 'Use "system" or an IANA time zone such as Europe/Stockholm',
});

export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');

export const WorkHours = z
  .object({
    start: ClockTime,
    end: ClockTime,
    days: z.array(Weekday).min(1),
  })
  .refine((hours) => hours.start < hours.end, {
    message: 'Work hours must end after they start',
    path: ['end'],
  });
export type WorkHours = z.infer<typeof WorkHours>;

export const MissedTriggerPolicy = z.enum(['run', 'mark', 'skip']);
export type MissedTriggerPolicy = z.infer<typeof MissedTriggerPolicy>;

export const settingsRegistry = {
  'calendar.zone': defineSetting({
    schema: TimeZoneSetting,
    group: 'calendar',
    label: 'Time zone',
    description:
      'Zone the calendar is shown in and new cards are entered in. "system" follows the operating system.',
    default: 'system',
    scope: 'global',
  }),
  'calendar.firstDayOfWeek': defineSetting({
    schema: Weekday,
    group: 'calendar',
    label: 'First day of the week',
    description: 'Day the week view starts on.',
    default: 'monday',
    scope: 'global',
  }),
  'calendar.workHours': defineSetting({
    schema: WorkHours,
    group: 'calendar',
    label: 'Work hours',
    description: 'Hours and days highlighted in the day and week views.',
    default: {
      start: '08:00',
      end: '17:00',
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    scope: 'global',
  }),
  'calendar.lookaheadDays': defineSetting({
    schema: z.number().int().min(1).max(90),
    group: 'calendar',
    label: 'Lookahead (days)',
    description: 'How many days ahead Outlook items are read and cached.',
    default: 14,
    scope: 'global',
  }),
  'outlook.pollSeconds': defineSetting({
    schema: z.number().int().min(15).max(3600),
    group: 'outlook',
    label: 'Poll interval (seconds)',
    description: 'How often calendar items and unread mail are read from Outlook.',
    default: 60,
    scope: 'global',
  }),
  'outlook.folders': defineSetting({
    schema: z.array(z.string().min(1)).min(1),
    group: 'outlook',
    label: 'Mail folders',
    description:
      'Folders whose unread mail is shown in the mail rail. "Inbox" is the default inbox; other names are looked up under it, then at the top of the mailbox.',
    default: ['Inbox'],
    scope: 'global',
  }),
  'outlook.requestTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(300000),
    group: 'outlook',
    label: 'Request timeout (ms)',
    description:
      'How long one request to Outlook may take. A request that takes longer (for example while Outlook shows a dialog) marks Outlook unavailable and restarts the bridge on the next poll.',
    default: 20000,
    scope: 'global',
  }),
  'outlook.mailRail': defineSetting({
    schema: z.boolean(),
    group: 'outlook',
    label: 'Mail rail',
    description: 'Read unread mail from Outlook and show it next to the calendar.',
    default: true,
    scope: 'global',
  }),
  'outlook.mailLimit': defineSetting({
    schema: z.number().int().min(1).max(500),
    group: 'outlook',
    label: 'Mail rail size',
    description: 'Most unread messages read per poll, newest first. The count covers all of them.',
    default: 50,
    scope: 'global',
  }),
  'scheduler.tickSeconds': defineSetting({
    schema: z.number().int().min(5).max(3600),
    group: 'scheduler',
    label: 'Tick interval (seconds)',
    description: 'How often the scheduler looks for due triggers.',
    default: 30,
    scope: 'global',
  }),
  'scheduler.missedPolicy': defineSetting({
    schema: MissedTriggerPolicy,
    group: 'scheduler',
    label: 'Missed triggers',
    description:
      'What happens at startup to triggers whose time passed while the server was down: run them now, mark them missed with a "Run now" action, or mark them missed and skip them.',
    default: 'mark',
    scope: 'global',
  }),
  'scheduler.notifications': defineSetting({
    schema: z.boolean(),
    group: 'scheduler',
    label: 'Desktop notifications',
    description: 'Notify when a workflow run starts, waits for you, or fails.',
    default: true,
    scope: 'global',
  }),
} as const satisfies Record<string, SettingDefinition>;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;
export type SettingValue<K extends SettingKey> = z.output<SettingsRegistry[K]['schema']>;
