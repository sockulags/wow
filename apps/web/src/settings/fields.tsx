import { useState, type KeyboardEvent } from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { ChoiceSelect } from '@/components/choice-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { eventToBinding, formatBinding } from '@/app/keybindings';
import { cn } from '@/lib/utils';
import type { FieldKind, ListItemKind } from './field-kind';

// Editors are controlled and take `unknown`: the value can be a draft that does not pass the
// schema yet, and the row around them reports why.

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly value: unknown;
  readonly invalid: boolean;
  readonly onChange: (next: unknown) => void;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const humanize = (name: string): string =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());

function ListField({
  id,
  label,
  item,
  value,
  invalid,
  onChange,
}: Omit<FieldProps, 'kind'> & { item: ListItemKind }) {
  const items = asArray(value);
  if (item.kind === 'enum') {
    return (
      <div role="group" aria-label={label} id={id} className="flex flex-wrap gap-x-4 gap-y-2">
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
              {option}
            </Label>
          );
        })}
      </div>
    );
  }
  return (
    <div role="group" aria-label={label} id={id} className="flex max-w-md flex-col gap-1.5">
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
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() => onChange(items.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
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

function KeyValueField({ id, label, value, invalid, onChange }: Omit<FieldProps, 'kind'>) {
  const rows = asArray(value).map(asRecord);
  const update = (index: number, patch: Record<string, unknown>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div role="group" aria-label={label} id={id} className="flex max-w-2xl flex-col gap-1.5">
      {rows.map((row, index) => {
        const secret = row['secret'] === true;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label={`${label} ${index + 1} key`}
              aria-invalid={invalid || undefined}
              placeholder="KEY"
              className="font-mono"
              value={asString(row['key'])}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <Input
              aria-label={`${label} ${index + 1} value`}
              type={secret ? 'password' : 'text'}
              placeholder="value"
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
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
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

function KeybindingField({ id, label, value, invalid, onChange }: Omit<FieldProps, 'kind'>) {
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
        aria-label={`${label}: ${recording ? 'press a shortcut' : binding || 'unbound'}`}
        aria-invalid={invalid || undefined}
        aria-pressed={recording}
        className={cn('min-w-32 justify-start font-mono', recording && 'border-ring')}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
      >
        {recording ? 'Press a shortcut…' : binding ? formatBinding(binding) : 'Unbound'}
      </Button>
      {binding !== '' && !recording && (
        <Button variant="ghost" size="sm" onClick={() => onChange('')}>
          Clear
        </Button>
      )}
    </div>
  );
}

function JsonField({ id, label, value, invalid, onChange }: Omit<FieldProps, 'kind'>) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(false);
  return (
    <textarea
      id={id}
      aria-label={label}
      aria-invalid={invalid || parseError || undefined}
      value={text}
      rows={4}
      onChange={(event) => {
        setText(event.target.value);
        try {
          onChange(JSON.parse(event.target.value));
          setParseError(false);
        } catch {
          setParseError(true);
        }
      }}
      className="w-full max-w-xl rounded-md border border-input bg-transparent p-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
    />
  );
}

export function Field(props: FieldProps) {
  const { id, label, kind, value, invalid, onChange } = props;
  switch (kind.kind) {
    case 'text':
      return (
        <Input
          id={id}
          aria-invalid={invalid || undefined}
          className="max-w-md"
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          aria-invalid={invalid || undefined}
          className="max-w-32"
          min={kind.min}
          max={kind.max}
          step={kind.integer ? 1 : 'any'}
          value={typeof value === 'number' && Number.isFinite(value) ? value : asString(value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : event.target.valueAsNumber)
          }
        />
      );
    case 'boolean':
      return (
        <Switch
          id={id}
          aria-invalid={invalid || undefined}
          checked={value === true}
          onCheckedChange={(next) => onChange(next)}
        />
      );
    case 'enum':
      return (
        <ChoiceSelect
          id={id}
          label={label}
          value={asString(value)}
          choices={kind.options.map((option) => ({ value: option, label: option }))}
          invalid={invalid}
          className="max-w-xs"
          onValueChange={onChange}
        />
      );
    case 'list':
      return <ListField {...props} item={kind.item} />;
    case 'keyValue':
      return <KeyValueField {...props} />;
    case 'keybinding':
      return <KeybindingField {...props} />;
    case 'object': {
      const record = asRecord(value);
      return (
        <div id={id} role="group" aria-label={label} className="flex flex-col gap-3">
          {kind.fields.map((field) => {
            const childId = `${id}-${field.name}`;
            const childLabel = humanize(field.name);
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <Label htmlFor={childId} className="text-xs text-muted-foreground">
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
    case 'json':
      return <JsonField {...props} />;
  }
}
