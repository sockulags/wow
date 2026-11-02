import type { Weekday } from '@wow/contracts';
import { CalendarIcon, ClockIcon } from 'lucide-react';
import { useState } from 'react';
import { clockTime, isoDate, parseClockTime, parseIsoDate } from '@/calendar/time';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Date and time fields in place of <input type="date|time">, whose pickers are browser chrome that
// ignores the theme. The text box keeps the same value format (YYYY-MM-DD, HH:MM), so typing
// still works; the button (or Alt+ArrowDown) opens a themed picker. The button's name leaves out
// the field's label so the label still names exactly one control.

const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function DateField({
  id,
  label,
  value,
  onValueChange,
  firstDayOfWeek,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly firstDayOfWeek: Weekday;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const parsed = parseIsoDate(value);
  const selected = parsed ? new Date(parsed.year, parsed.month - 1, parsed.day) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn('relative', className)}>
          <Input
            id={id}
            value={value}
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={(value !== '' && !parsed) || undefined}
            className="pr-9 tabular-nums"
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && event.altKey) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          />
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Choose a day"
              className="absolute top-0 right-0 text-muted-foreground"
            >
              <CalendarIcon />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          aria-label={label}
          autoFocus
          selected={selected}
          {...(selected ? { defaultMonth: selected } : {})}
          weekStartsOn={WEEKDAYS.indexOf(firstDayOfWeek) as 0 | 1 | 2 | 3 | 4 | 5 | 6}
          onSelect={(day) => {
            if (!day) return;
            onValueChange(
              isoDate({ year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() }),
            );
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function TimeField({
  id,
  label,
  value,
  onValueChange,
  stepMinutes,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  // Spacing of the times in the list; typing any minute still works.
  readonly stepMinutes: number;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const minute = parseClockTime(value);
  const step = Math.max(1, Math.round(stepMinutes));
  const times: string[] = [];
  for (let at = 0; at < 24 * 60; at += step) times.push(clockTime(at));
  // The list opens on the time at or just before the current value.
  const current = minute === undefined ? undefined : clockTime(Math.floor(minute / step) * step);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn('relative', className)}>
          <Input
            id={id}
            value={value}
            placeholder="HH:MM"
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={(value !== '' && minute === undefined) || undefined}
            className="pr-9 tabular-nums"
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && event.altKey) {
                event.preventDefault();
                setOpen(true);
              }
            }}
          />
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Show times"
              className="absolute top-0 right-0 text-muted-foreground"
            >
              <ClockIcon />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-32 p-0"
        // The list has no search box: give the keyboard to it and show the current time.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          content.querySelector<HTMLElement>('[cmdk-root]')?.focus();
          requestAnimationFrame(() =>
            content
              .querySelector('[cmdk-item][data-selected="true"]')
              ?.scrollIntoView({ block: 'center' }),
          );
        }}
      >
        <Command {...(current ? { defaultValue: current } : {})} label={`${label} times`}>
          <CommandList className="max-h-60">
            <CommandGroup>
              {times.map((time) => (
                <CommandItem
                  key={time}
                  value={time}
                  className="justify-center tabular-nums"
                  onSelect={() => {
                    onValueChange(time);
                    setOpen(false);
                  }}
                >
                  {time}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
