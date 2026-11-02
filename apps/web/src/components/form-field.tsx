import { Slot } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// The one field layout (design rules, "Fields"): label above, the control, help text below, then
// the error. The control (the single child) gets the id, aria-describedby and aria-invalid, so
// callers do not wire them by hand.
//
//   <FormField id="name" label="Name" help="Shown in the sidebar." error={issue}>
//     <Input value={name} onChange={...} />
//   </FormField>
export interface FormFieldProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly help?: ReactNode | undefined;
  readonly error?: ReactNode | undefined;
  // Where a prefilled value came from, such as "Detected" or "From Outlook", shown after the label.
  readonly source?: ReactNode | undefined;
  // Something at the end of the label row, such as a Reset button.
  readonly labelAction?: ReactNode | undefined;
  // For groups (radio groups, checkbox lists) that have no single labelable control: the label
  // names the group with aria-labelledby instead of htmlFor.
  readonly group?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children: ReactElement;
}

export const fieldIds = (id: string) => ({
  label: `${id}-label`,
  help: `${id}-help`,
  error: `${id}-error`,
});

export function FormField({
  id,
  label,
  help,
  error,
  source,
  labelAction,
  group = false,
  className,
  children,
}: FormFieldProps) {
  const ids = fieldIds(id);
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const describedBy =
    [help !== undefined ? ids.help : undefined, hasError ? ids.error : undefined]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div data-slot="form-field" className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-center gap-2">
        <Label id={ids.label} htmlFor={group ? undefined : id}>
          {label}
        </Label>
        {source !== undefined && (
          <span className="text-2xs text-muted-foreground" data-testid={`${id}-source`}>
            {source}
          </span>
        )}
        {labelAction !== undefined && <div className="ml-auto">{labelAction}</div>}
      </div>
      <Slot.Root
        id={id}
        aria-describedby={describedBy}
        aria-invalid={hasError || undefined}
        {...(group ? { 'aria-labelledby': ids.label } : {})}
      >
        {children}
      </Slot.Root>
      {help !== undefined && (
        <p id={ids.help} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {hasError && (
        <p id={ids.error} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
