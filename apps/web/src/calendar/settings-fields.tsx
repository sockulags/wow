import {
  FROM_OUTLOOK,
  systemFirstDayOfWeek,
  systemWorkHours,
  Weekday,
  type WorkHours,
} from '@wow/contracts';
import { useMemo, type ReactNode } from 'react';
import { Combobox, type ComboboxChoice } from '@/components/combobox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useOutlookProfile } from './prefs';
import { formatOffset, systemZone } from './time';

// Settings editors for the calendar preferences Outlook also knows (F-8, audit B-08, B-09, B-20).
// The settings page picks them from the schemas' `widget` meta.

const weekdayLabels: Readonly<Record<Weekday, string>> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

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

const describe = (shown: WorkHours | Weekday): string =>
  typeof shown === 'string' ? weekdayLabels[shown] : formatWorkHours(shown);

const zoneLabel = (zone: string, now: Date) =>
  `${zone.replaceAll('_', ' ')} (${formatOffset(zone, now)})`;

const supportedZones = (): readonly string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [systemZone()];
  }
};

// A searchable list of IANA zones, with "From Outlook" and "System" first.
export function ZoneField({
  id,
  label,
  value,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  invalid: boolean;
  onChange: (next: unknown) => void;
}) {
  const profile = useOutlookProfile();
  const choices = useMemo((): ComboboxChoice[] => {
    const now = new Date();
    const system = systemZone();
    return [
      {
        value: FROM_OUTLOOK,
        label: profile?.zone ? `From Outlook (${profile.zone})` : 'From Outlook',
        ...(profile?.zone ? {} : { detail: `not read yet, using ${system}` }),
      },
      { value: 'system', label: `System (${system})` },
      ...supportedZones().map((zone) => ({ value: zone, label: zoneLabel(zone, now) })),
    ];
  }, [profile?.zone]);
  return (
    <Combobox
      id={id}
      label={label}
      className="w-full max-w-sm"
      value={typeof value === 'string' ? value : FROM_OUTLOOK}
      choices={choices}
      placeholder="Choose a time zone"
      searchPlaceholder="Search zones, such as Stockholm or UTC+1…"
      emptyText="No zone matches."
      invalid={invalid}
      onValueChange={onChange}
    />
  );
}

type Preference = 'workHours' | 'weekday';

// A value that follows Outlook unless overridden: Outlook's value (or the system's while Outlook
// has not been read) with an Override switch that reveals the editor.
// The override editor is the settings page's own editor for the inner schema, passed as children.
export function FromOutlookField({
  id,
  preference,
  value,
  onChange,
  children,
}: {
  id: string;
  preference: Preference;
  value: unknown;
  onChange: (next: unknown) => void;
  children: ReactNode;
}) {
  const profile = useOutlookProfile();
  const override = value !== FROM_OUTLOOK;
  const outlookValue =
    preference === 'workHours' ? (profile?.workHours ?? null) : (profile?.firstDayOfWeek ?? null);
  const fallback = preference === 'workHours' ? systemWorkHours : systemFirstDayOfWeek();
  const followed: ReactNode = outlookValue ? (
    <>
      <span className="text-muted-foreground">From Outlook:</span> {describe(outlookValue)}
    </>
  ) : (
    <>
      <span className="text-muted-foreground">Outlook has not said yet, so wow uses</span>{' '}
      {describe(fallback)}
    </>
  );
  const current = (outlookValue ?? fallback) as WorkHours | Weekday;

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-override`}
          checked={override}
          onCheckedChange={(next) => onChange(next ? current : FROM_OUTLOOK)}
        />
        <Label htmlFor={`${id}-override`} className="font-normal">
          Override Outlook
        </Label>
      </div>
      {!override ? (
        <p id={id} className="text-sm" data-testid={`${id}-outlook`}>
          {followed}
        </p>
      ) : (
        children
      )}
    </div>
  );
}
