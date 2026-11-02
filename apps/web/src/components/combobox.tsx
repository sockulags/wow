import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxChoice {
  readonly value: string;
  readonly label: string;
  // Shown after the label, muted, and searched too.
  readonly detail?: string;
}

// A searchable single choice: a button that opens a filtered list (Popover + Command).
export function Combobox({
  id,
  label,
  value,
  choices,
  onValueChange,
  placeholder,
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing found.',
  size = 'default',
  disabled,
  invalid,
  className,
}: {
  readonly id?: string;
  readonly label?: string;
  readonly value: string;
  readonly choices: readonly ComboboxChoice[];
  readonly onValueChange: (value: string) => void;
  readonly placeholder: string;
  readonly searchPlaceholder?: string;
  readonly emptyText?: string;
  readonly size?: 'sm' | 'default';
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = choices.find((choice) => choice.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className={cn(
            'justify-between font-normal',
            size === 'sm' ? 'px-2 text-xs' : 'px-3',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-56 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.value}
                  value={choice.value}
                  keywords={[choice.label, ...(choice.detail ? [choice.detail] : [])]}
                  onSelect={() => {
                    onValueChange(choice.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{choice.label}</span>
                  {choice.detail && (
                    <span className="truncate text-xs text-muted-foreground">{choice.detail}</span>
                  )}
                  <CheckIcon
                    className={cn('ml-auto', choice.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Free text with a themed list of suggestions, in place of a native input list (datalist). The text
// box stays the field (typing works as before); the button or Alt+ArrowDown opens the list.
export function SuggestInput({
  id,
  label,
  value,
  suggestions,
  onValueChange,
  placeholder,
  emptyText = 'No suggestions.',
  className,
}: {
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly suggestions: readonly ComboboxChoice[];
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly emptyText?: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && (event.altKey || suggestions.length > 0)) {
      event.preventDefault();
      setOpen(true);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn('relative', className)}>
          <Input
            id={id}
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            className="pr-9"
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Show suggestions"
              className="absolute top-0 right-0 text-muted-foreground"
            >
              <ChevronDownIcon />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-56 p-0">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {suggestions.map((choice) => (
                <CommandItem
                  key={choice.value}
                  value={choice.value}
                  keywords={[choice.label, ...(choice.detail ? [choice.detail] : [])]}
                  onSelect={() => {
                    onValueChange(choice.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate font-mono text-xs">{choice.value}</span>
                  {choice.label !== choice.value && (
                    <span className="truncate text-xs text-muted-foreground">{choice.label}</span>
                  )}
                  <CheckIcon
                    className={cn('ml-auto', choice.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
