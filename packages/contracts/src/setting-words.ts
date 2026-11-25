import { AlwaysAllowRule, ruleText } from './approvals.js';
import {
  FROM_OUTLOOK,
  Weekday,
  WorkHours,
  type SettingDefinition,
  type SettingUnit,
} from './settings.js';

// A setting's value in the words the settings page uses (agent workbench spec 95): "From
// Outlook", "08:00–16:00, Mon–Fri", "On", an option's label, a number with its unit. The
// settings page and the assistant's change rows read the same functions, so a row says a value
// as the page that holds it does.

const weekdayLabels: Readonly<Record<Weekday, string>> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

export const weekdayLabel = (day: Weekday): string => weekdayLabels[day];

const short = (day: Weekday) => weekdayLabels[day].slice(0, 3);

// "Mon–Fri", "Mon, Wed, Fri", "Every day".
export function formatDays(days: readonly Weekday[]): string {
  const ordered = Weekday.options.filter((day) => days.includes(day));
  if (ordered.length === 7) return 'Every day';
  const indexes = ordered.map((day) => Weekday.options.indexOf(day));
  const consecutive = indexes.every(
    (at, position) => position === 0 || at === (indexes[position - 1] ?? -2) + 1,
  );
  const first = ordered[0];
  const last = ordered.at(-1);
  if (consecutive && ordered.length > 2 && first && last) return `${short(first)}–${short(last)}`;
  return ordered.map(short).join(', ');
}

export const formatWorkHours = (hours: WorkHours): string =>
  `${hours.start}–${hours.end}, ${formatDays(hours.days)}`;

// The suffix shown after a number, and the factor between the stored and the shown value.
export const settingUnitDisplay: Readonly<
  Record<SettingUnit, { readonly suffix: string; readonly factor: number }>
> = {
  ms: { suffix: 's', factor: 1000 },
  seconds: { suffix: 's', factor: 1 },
  minutes: { suffix: 'min', factor: 1 },
  days: { suffix: 'days', factor: 1 },
  pixels: { suffix: 'px', factor: 1 },
  percent: { suffix: '%', factor: 1 },
  bytes: { suffix: 'KB', factor: 1000 },
};

export type SettingWordsSource = Pick<SettingDefinition, 'schema' | 'options' | 'unit'>;

const optionLabel = (definition: SettingWordsSource, value: string): string =>
  definition.options?.[value]?.label ?? value;

// The value in words, or undefined for a shape this has no words for (an object the page edits
// as JSON), which the caller says its own way.
export function settingValueWords(
  definition: SettingWordsSource,
  value: unknown,
): string | undefined {
  if (value === null || value === undefined || value === '') return 'None';
  const widget = definition.schema.meta()?.['widget'];
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    if (!definition.unit) return String(value);
    const { suffix, factor } = settingUnitDisplay[definition.unit];
    return `${value / factor} ${suffix}`;
  }
  if (typeof value === 'string') {
    if ((widget === 'fromOutlook' || widget === 'timeZone') && value === FROM_OUTLOOK) {
      return 'From Outlook';
    }
    if (widget === 'timeZone' && value === 'system') return 'System';
    return optionLabel(definition, value);
  }
  const hours = WorkHours.safeParse(value);
  if (hours.success) return formatWorkHours(hours.data);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((entry) => typeof entry === 'string')) {
      return value.map((entry) => optionLabel(definition, entry)).join(', ');
    }
    const rules = value.map((entry) => AlwaysAllowRule.safeParse(entry));
    if (rules.every((rule) => rule.success))
      return rules.map(({ data }) => ruleText(data)).join('; ');
  }
  return undefined;
}
