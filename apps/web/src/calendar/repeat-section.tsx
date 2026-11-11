import {
  repeatMaxCount,
  repeatMaxInterval,
  repeatRuleWords,
  repeatWeekdays,
  type RepeatRule,
  type RepeatWeekday,
  type Weekday,
} from '@wow/contracts';
import { Repeat2Icon } from 'lucide-react';
import { ChoiceSelect } from '@/components/choice-select';
import { DateField } from '@/components/date-time-fields';
import { FormField } from '@/components/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { weekdayOfDate, type RepeatDraft, type RepeatResult } from './card-form';

const dayNames: Readonly<Record<RepeatWeekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const unit: Readonly<Record<RepeatRule['frequency'], [string, string]>> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
};

// The card editor's Repeat section (recurring cards spec 16): frequency, interval, weekdays and
// end, the rule in words and, for a stored card, when its trigger fires next. The words come
// from the same `repeatRuleWords` the server uses for the assistant's change rows.
export function RepeatSection({
  draft,
  result,
  date,
  start,
  zone,
  firstDayOfWeek,
  next,
  onChange,
}: {
  readonly draft: RepeatDraft;
  readonly result: RepeatResult;
  // The card's first day (YYYY-MM-DD) and start instant, when the form gives them.
  readonly date: string;
  readonly start: string | undefined;
  readonly zone: string;
  readonly firstDayOfWeek: Weekday;
  // What to say about the next fire time; undefined says nothing.
  readonly next: string | undefined;
  onChange(changes: Partial<RepeatDraft>): void;
}) {
  const repeats = draft.frequency !== 'none';
  const interval = Number(draft.interval);
  const [one, many] = repeats ? unit[draft.frequency as RepeatRule['frequency']] : ['', ''];
  const words =
    result.ok && result.rule
      ? repeatRuleWords(result.rule, start ? { start, zone } : undefined)
      : undefined;
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-md border border-border p-3">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
        <Repeat2Icon className="size-4 text-muted-foreground" aria-hidden />
        Repeat
      </legend>
      <div className="grid grid-cols-2 gap-3">
        <FormField id="card-repeat" label="Repeats">
          <ChoiceSelect
            id="card-repeat"
            value={draft.frequency}
            choices={[
              { value: 'none', label: 'Does not repeat' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
            onValueChange={(value) => {
              const frequency = value as RepeatDraft['frequency'];
              const first = weekdayOfDate(date);
              // A weekly rule starts on the card's own weekday, so that choice is visible.
              const weekdays =
                frequency !== 'weekly'
                  ? []
                  : draft.weekdays.length > 0
                    ? draft.weekdays
                    : first
                      ? [first]
                      : [];
              onChange({ frequency, weekdays });
            }}
          />
        </FormField>
        {repeats && (
          <FormField
            id="card-interval"
            label="Every"
            help={Number.isInteger(interval) && interval === 1 ? one : many}
            error={!result.ok && result.field === 'interval' ? result.message : undefined}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={repeatMaxInterval}
              value={draft.interval}
              onChange={(event) => onChange({ interval: event.target.value })}
            />
          </FormField>
        )}
      </div>
      {draft.frequency === 'weekly' && (
        <FormField id="card-weekdays" label="On days" group>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            aria-label="On days"
            value={[...draft.weekdays]}
            onValueChange={(chosen) =>
              onChange({ weekdays: repeatWeekdays.filter((day) => chosen.includes(day)) })
            }
          >
            {repeatWeekdays.map((day) => (
              <ToggleGroupItem key={day} value={day} aria-label={dayNames[day]}>
                {dayNames[day].slice(0, 3)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FormField>
      )}
      {repeats && (
        <div className="grid grid-cols-2 gap-3">
          <FormField id="card-repeat-stop" label="Stops">
            <ChoiceSelect
              id="card-repeat-stop"
              value={draft.end}
              choices={[
                { value: 'never', label: 'Never' },
                { value: 'on', label: 'On a day' },
                { value: 'after', label: 'After a number of times' },
              ]}
              onValueChange={(value) => onChange({ end: value as RepeatDraft['end'] })}
            />
          </FormField>
          {draft.end === 'on' && (
            <FormField
              id="card-repeat-last"
              label="Last day"
              error={!result.ok && result.field === 'endDate' ? result.message : undefined}
            >
              <DateField
                id="card-repeat-last"
                label="Last day"
                value={draft.endDate}
                firstDayOfWeek={firstDayOfWeek}
                onValueChange={(endDate) => onChange({ endDate })}
              />
            </FormField>
          )}
          {draft.end === 'after' && (
            <FormField
              id="card-repeat-count"
              label="Times"
              error={!result.ok && result.field === 'count' ? result.message : undefined}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={repeatMaxCount}
                value={draft.count}
                onChange={(event) => onChange({ count: event.target.value })}
              />
            </FormField>
          )}
        </div>
      )}
      {words && (
        <p data-testid="repeat-words" className="text-xs">
          {words}
        </p>
      )}
      {repeats && next && (
        <p data-testid="repeat-next" className="text-xs text-muted-foreground">
          {next}
        </p>
      )}
    </fieldset>
  );
}
