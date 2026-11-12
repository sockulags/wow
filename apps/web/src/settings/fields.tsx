import {
  WorkHours,
  formatWorkHours,
  settingUnitDisplay,
  type SettingOption,
  type SettingUnit,
  type Weekday,
} from '@wow/contracts';
import { useRef, useState, type KeyboardEvent } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { ChoiceSelect } from '@/components/choice-select';
import { TimeField } from '@/components/date-time-fields';
import { IconButton } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { eventToBinding, formatBinding } from '@/app/keybindings';
import { FromOutlookField, ZoneField } from '@/calendar/settings-fields';
import { cn } from '@/lib/utils';
import type { FieldKind, ListItemKind } from './field-kind';

// Editors are controlled and take `unknown`: the value can be a draft that does not pass the
// schema yet, and the row around them reports why. Two widths only (audit A-06): `short` for
// numbers, choices and keys, `long` for text, paths and lists.
export const fieldWidth = { short: 'max-w-sm', long: 'max-w-xl' } as const;

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly value: unknown;
  readonly invalid: boolean;
  readonly onChange: (next: unknown) => void;
  readonly options?: Readonly<Record<string, SettingOption>> | undefined;
  readonly unit?: SettingUnit | undefined;
  readonly radio?: boolean | undefined;
  // Set by the FormField around the editor: the help and error text ids.
  readonly 'aria-describedby'?: string | undefined;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const humanize = (name: string): string =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());

export const optionLabel = (
  options: Readonly<Record<string, SettingOption>> | undefined,
  value: string,
): string => options?.[value]?.label ?? value;

// The suffix shown after a number, and the factor between the stored and the shown value.
export const unitDisplay: Readonly<Record<SettingUnit, { suffix: string; factor: number }>> =
  settingUnitDisplay;

// A value as a person reads it, for "Default: …" and the like.
export function readableValue(
  value: unknown,
  kind: FieldKind,
  options: Readonly<Record<string, SettingOption>> | undefined,
  unit: SettingUnit | undefined,
): string {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    if (!unit) return String(value);
    const { suffix, factor } = unitDisplay[unit];
    return `${value / factor} ${suffix}`;
  }
  if (typeof value === 'string') {
    if (kind.kind === 'keybinding') return formatBinding(value);
    if ((kind.kind === 'fromOutlook' || kind.kind === 'timeZone') && value === 'outlook') {
      return 'From Outlook';
    }
    if (kind.kind === 'timeZone' && value === 'system') return 'System';
    return optionLabel(options, value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((entry) => typeof entry === 'string')) {
      return value.map((entry) => optionLabel(options, entry)).join(', ');
    }
    return `${value.length} entries`;
  }
  if (kind.kind === 'workHours') {
    const hours = WorkHours.safeParse(value);
    if (hours.success) return formatWorkHours(hours.data);
    const loose = asRecord(value);
    const days = asArray(loose['days']).map((day) => shortDay[day as Weekday] ?? String(day));
    return `${asString(loose['start'])}–${asString(loose['end'])}, ${days.join(' ')}`;
  }
  return 'Custom';
}

function ListField({
  id,
  label,
  item,
  value,
  invalid,
  onChange,
  options,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'> & { item: ListItemKind }) {
  const items = asArray(value);
  if (item.kind === 'enum') {
    return (
      <div
        role="group"
        aria-label={label}
        aria-describedby={describedBy}
        id={id}
        className="flex flex-wrap gap-x-4 gap-y-2"
      >
        {item.options.map((option) => {
          const checked = items.includes(option);
          return (
            <Label key={option} className="font-normal">
              <Checkbox
                checked={checked}
                aria-invalid={invalid || undefined}
                onCheckedChange={(next) =>
                  onChange(
                    item.options.filter((candidate) =>
                      candidate === option ? next === true : items.includes(candidate),
                    ),
                  )
                }
              />
              {optionLabel(options, option)}
            </Label>
          );
        })}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      id={id}
      className={cn('flex flex-col gap-1.5', fieldWidth.long)}
    >
      {items.map((entry, index) => (
        <div key={index} className="flex gap-1.5">
          <Input
            aria-label={`${label} ${index + 1}`}
            aria-invalid={invalid || undefined}
            value={asString(entry)}
            onChange={(event) =>
              onChange(items.map((old, at) => (at === index ? event.target.value : old)))
            }
          />
          <IconButton
            label={`Remove ${label} ${index + 1}`}
            size="icon"
            onClick={() => onChange(items.filter((_, at) => at !== index))}
          >
            <XIcon />
          </IconButton>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...items, ''])}
      >
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

function KeyValueField({
  id,
  label,
  value,
  invalid,
  onChange,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'>) {
  const rows = asArray(value).map(asRecord);
  const update = (index: number, patch: Record<string, unknown>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      id={id}
      className={cn('flex flex-col gap-1.5', fieldWidth.long)}
    >
      {rows.map((row, index) => {
        const secret = row['secret'] === true;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label={`${label} ${index + 1} key`}
              aria-invalid={invalid || undefined}
              placeholder="Name"
              className="font-mono"
              value={asString(row['key'])}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <Input
              aria-label={`${label} ${index + 1} value`}
              type={secret ? 'password' : 'text'}
              placeholder="Value"
              className="font-mono"
              value={asString(row['value'])}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <Label className="shrink-0 font-normal">
              <Checkbox
                aria-label={`${label} ${index + 1} secret`}
                checked={secret}
                onCheckedChange={(next) => update(index, { secret: next === true })}
              />
              Secret
            </Label>
            <IconButton
              label={`Remove ${label} ${index + 1}`}
              size="icon"
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <XIcon />
            </IconButton>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}
      >
        <PlusIcon />
        Add variable
      </Button>
    </div>
  );
}

export function KeybindingField({
  id,
  label,
  value,
  invalid,
  onChange,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'>) {
  const [recording, setRecording] = useState(false);
  const binding = asString(value);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Recording owns the keyboard: no global shortcut or focus move while a key is captured.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }
    const pressed = eventToBinding(event.nativeEvent);
    if (!pressed) return;
    setRecording(false);
    onChange(pressed);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button
        id={id}
        variant="outline"
        size="sm"
        aria-label={`${label}: ${recording ? 'press a key combination' : binding || 'unbound'}`}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-pressed={recording}
        className={cn(
          'min-w-40 justify-start font-normal tabular-nums',
          recording && 'border-ring text-muted-foreground ring-2 ring-ring',
          !binding && !recording && 'text-muted-foreground',
        )}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
      >
        {recording ? 'Press a key combination…' : binding ? formatBinding(binding) : 'Not set'}
      </Button>
      {binding !== '' && !recording && (
        <Button variant="ghost" size="sm" onClick={() => onChange('')}>
          Clear
        </Button>
      )}
    </div>
  );
}

function JsonField({
  id,
  label,
  value,
  invalid,
  onChange,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'>) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(false);
  return (
    <Textarea
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || parseError || undefined}
      value={text}
      rows={8}
      onChange={(event) => {
        setText(event.target.value);
        try {
          onChange(JSON.parse(event.target.value));
          setParseError(false);
        } catch {
          setParseError(true);
        }
      }}
      className={cn('font-mono text-xs', fieldWidth.long)}
    />
  );
}

// A multi-line text with chips that insert its {{placeholders}} at the cursor (audit E-05).
function TemplateField({
  id,
  value,
  invalid,
  onChange,
  placeholders,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'> & { placeholders: readonly string[] }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const text = asString(value);
  const insert = (name: string) => {
    const element = area.current;
    const token = `{{${name}}}`;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    onChange(text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className={cn('flex flex-col gap-1.5', fieldWidth.long)}>
      <Textarea
        ref={area}
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        rows={10}
        className="font-mono text-xs"
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
      {placeholders.length > 0 && (
        <div role="group" aria-label="Insert placeholder" className="flex flex-wrap gap-1.5">
          {placeholders.map((name) => (
            <Button
              key={name}
              type="button"
              variant="outline"
              size="xs"
              className="font-mono"
              onClick={() => insert(name)}
            >
              <PlusIcon />
              {name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const shortDay: Readonly<Record<Weekday, string>> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

// Work hours (audit E-07): two time fields and a Mon–Sun toggle group.
function WorkHoursField({
  id,
  label,
  value,
  onChange,
  'aria-describedby': describedBy,
}: Omit<FieldProps, 'kind'>) {
  const hours = asRecord(value);
  const days = asArray(hours['days']);
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex flex-wrap items-end gap-4"
    >
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-start`} className="text-xs font-normal text-muted-foreground">
            From
          </Label>
          <TimeField
            id={`${id}-start`}
            label="Start"
            className="w-28"
            stepMinutes={30}
            value={asString(hours['start'])}
            onValueChange={(start) => onChange({ ...hours, start })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-end`} className="text-xs font-normal text-muted-foreground">
            To
          </Label>
          <TimeField
            id={`${id}-end`}
            label="End"
            className="w-28"
            stepMinutes={30}
            value={asString(hours['end'])}
            onValueChange={(end) => onChange({ ...hours, end })}
          />
        </div>
      </div>
      <ToggleGroup
        type="multiple"
        aria-label={`${label} days`}
        value={days.filter((day): day is string => typeof day === 'string')}
        onValueChange={(next) =>
          onChange({ ...hours, days: weekdays.filter((day) => next.includes(day)) })
        }
      >
        {weekdays.map((day) => (
          <ToggleGroupItem key={day} value={day} aria-label={day[0]?.toUpperCase() + day.slice(1)}>
            {shortDay[day]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function NumberField({
  id,
  kind,
  value,
  invalid,
  onChange,
  unit,
  'aria-describedby': describedBy,
}: FieldProps & { kind: Extract<FieldKind, { kind: 'number' }> }) {
  const display = unit ? unitDisplay[unit] : { suffix: '', factor: 1 };
  const { factor } = display;
  const shown =
    typeof value === 'number' && Number.isFinite(value) ? value / factor : asString(value);
  return (
    <div className={cn('relative w-full', fieldWidth.short)}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={cn('tabular-nums', display.suffix !== '' && 'pr-12')}
        min={kind.min === undefined ? undefined : kind.min / factor}
        max={kind.max === undefined ? undefined : kind.max / factor}
        step={kind.integer && factor === 1 ? 1 : 'any'}
        value={shown}
        onChange={(event) =>
          onChange(
            event.target.value === ''
              ? ''
              : factor === 1
                ? event.target.valueAsNumber
                : Math.round(event.target.valueAsNumber * factor),
          )
        }
      />
      {display.suffix !== '' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
        >
          {display.suffix}
        </span>
      )}
    </div>
  );
}

export function Field(props: FieldProps) {
  const {
    id,
    label,
    kind,
    value,
    invalid,
    onChange,
    options,
    radio,
    'aria-describedby': describedBy,
  } = props;
  switch (kind.kind) {
    case 'text':
      return (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={fieldWidth.long}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number':
      return <NumberField {...props} kind={kind} />;
    case 'boolean':
      return (
        <Switch
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          checked={value === true}
          onCheckedChange={(next) => onChange(next)}
        />
      );
    case 'enum':
      if (radio) {
        return (
          <RadioGroup
            id={id}
            aria-label={label}
            aria-describedby={describedBy}
            value={asString(value)}
            onValueChange={onChange}
            className={cn('gap-2', fieldWidth.long)}
          >
            {kind.options.map((option) => {
              const optionId = `${id}-${option}`;
              const description = options?.[option]?.description;
              return (
                <div key={option} className="flex items-start gap-2">
                  <RadioGroupItem
                    id={optionId}
                    value={option}
                    className="mt-0.5"
                    aria-describedby={description ? `${optionId}-description` : undefined}
                  />
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor={optionId} className="font-normal">
                      {optionLabel(options, option)}
                    </Label>
                    {description && (
                      <p id={`${optionId}-description`} className="text-xs text-muted-foreground">
                        {description}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </RadioGroup>
        );
      }
      return (
        <ChoiceSelect
          id={id}
          label={label}
          value={asString(value)}
          choices={kind.options.map((option) => ({
            value: option,
            label: optionLabel(options, option),
          }))}
          invalid={invalid}
          describedBy={describedBy}
          className={fieldWidth.short}
          onValueChange={onChange}
        />
      );
    case 'list':
      return <ListField {...props} item={kind.item} />;
    case 'keyValue':
      return <KeyValueField {...props} />;
    case 'keybinding':
      return <KeybindingField {...props} />;
    case 'workHours':
      return <WorkHoursField {...props} />;
    case 'template':
      return <TemplateField {...props} placeholders={kind.placeholders} />;
    case 'object': {
      const record = asRecord(value);
      return (
        <div
          id={id}
          role="group"
          aria-label={label}
          aria-describedby={describedBy}
          className="flex flex-col gap-3"
        >
          {kind.fields.map((field) => {
            const childId = `${id}-${field.name}`;
            const childLabel = humanize(field.name);
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <Label htmlFor={childId} className="text-xs font-normal text-muted-foreground">
                  {childLabel}
                </Label>
                <Field
                  id={childId}
                  label={`${label} ${childLabel}`}
                  kind={field.kind}
                  value={record[field.name]}
                  invalid={invalid}
                  onChange={(next) => onChange({ ...record, [field.name]: next })}
                />
              </div>
            );
          })}
        </div>
      );
    }
    case 'timeZone':
      return <ZoneField {...props} />;
    case 'fromOutlook':
      return (
        <FromOutlookField
          id={id}
          preference={kind.inner.kind === 'enum' ? 'weekday' : 'workHours'}
          value={value}
          onChange={onChange}
        >
          <Field {...props} kind={kind.inner} />
        </FromOutlookField>
      );
    case 'json':
      return <JsonField {...props} />;
  }
}
