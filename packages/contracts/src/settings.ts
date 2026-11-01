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

// Where a stored value applies: 'global', 'project:<id>' or 'provider:<id>'. Reads resolve
// provider over project over global over the registry default.
export const SettingScopeRef = z
  .string()
  .regex(/^(global|project:.+|provider:.+)$/, 'Use global, project:<id> or provider:<id>');
export type SettingScopeRef = z.infer<typeof SettingScopeRef>;

// Settings marked `secret` store this reference; the value lives in the secret store.
export const SecretRef = z.object({ secretRef: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

export const LogLevel = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof LogLevel>;

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
  'advanced.port': defineSetting({
    schema: z.number().int().min(0).max(65535),
    group: 'advanced',
    label: 'Server port',
    description:
      'Local port the server listens on (127.0.0.1 only). 0 picks a free port at every start.',
    default: 0,
    scope: 'global',
    restartRequired: true,
  }),
  'advanced.logLevel': defineSetting({
    schema: LogLevel,
    group: 'advanced',
    label: 'Log level',
    description: 'How much the server writes to its log.',
    default: 'info',
    scope: 'global',
  }),
} as const satisfies Record<string, SettingDefinition>;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;
export type SettingValue<K extends SettingKey> = z.output<SettingsRegistry[K]['schema']>;
