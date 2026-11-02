import type { SettingKey } from '@wow/contracts';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { formatBinding } from '@/app/keybindings';
import { useSetting } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type KeybindingKey = Extract<SettingKey, `keybindings.${string}`>;

// A stored binding ("Mod+K") as one key chip, or nothing when unbound.
export function KeyHint({
  binding,
  className,
}: {
  binding: string;
  className?: string | undefined;
}) {
  if (binding === '') return null;
  return <Kbd className={className}>{formatBinding(binding)}</Kbd>;
}

// The current binding of a keybindings.* setting as a key chip.
export function ShortcutHint({
  shortcut,
  className,
}: {
  shortcut: KeybindingKey;
  className?: string | undefined;
}) {
  const binding = useSetting(shortcut);
  return <KeyHint binding={binding} className={className} />;
}

// Wraps one focusable element in a tooltip with its label and, when given, its key. Keyboard
// users get it on focus as well as on hover, unlike a native `title`.
export function WithTooltip({
  label,
  binding,
  shortcut,
  side,
  children,
}: {
  readonly label: ReactNode;
  // A literal binding, or the keybindings setting it comes from.
  readonly binding?: string | undefined;
  readonly shortcut?: KeybindingKey | undefined;
  readonly side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span>{label}</span>
        {shortcut ? <ShortcutHint shortcut={shortcut} /> : <KeyHint binding={binding ?? ''} />}
      </TooltipContent>
    </Tooltip>
  );
}

// An icon-only button: the label is its accessible name and its tooltip, with the key if any.
export function IconButton({
  label,
  binding,
  shortcut,
  side,
  variant = 'ghost',
  size = 'icon-sm',
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, 'aria-label'> & {
  readonly label: string;
  readonly binding?: string;
  readonly shortcut?: KeybindingKey;
  readonly side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
}) {
  return (
    <WithTooltip label={label} binding={binding} shortcut={shortcut} side={side}>
      <Button type="button" variant={variant} size={size} aria-label={label} {...props}>
        {children}
      </Button>
    </WithTooltip>
  );
}
