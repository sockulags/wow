import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

// Radix reserves the empty string for "nothing selected", but our forms use it for choices such
// as "No project". It stands in for '' inside the Select only.
const EMPTY = '\u0000empty';
const toItem = (value: string) => (value === '' ? EMPTY : value);
const fromItem = (value: string) => (value === EMPTY ? '' : value);

// A themed single choice from a short fixed list. Longer or searchable lists use Combobox.
export function ChoiceSelect({
  id,
  label,
  value,
  choices,
  onValueChange,
  placeholder,
  size = 'default',
  disabled,
  invalid,
  describedBy,
  title,
  className,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  readonly id?: string;
  // Accessible name when no <Label htmlFor> points at the trigger.
  readonly label?: string;
  readonly value: string;
  readonly choices: readonly Choice[];
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly size?: 'sm' | 'default';
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string | undefined;
  // Set by a FormField around the select.
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly title?: string;
  readonly className?: string;
}) {
  const known = choices.some((choice) => choice.value === value);
  return (
    <Select
      value={known ? toItem(value) : ''}
      onValueChange={(next) => onValueChange(fromItem(next))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid || ariaInvalid || undefined}
        aria-describedby={describedBy ?? ariaDescribedBy}
        title={title}
        size={size}
        className={cn('w-full', size === 'sm' && 'text-xs', className)}
      >
        <SelectValue placeholder={placeholder ?? value} />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem
            key={choice.value}
            value={toItem(choice.value)}
            className={cn(size === 'sm' && 'text-xs')}
          >
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
