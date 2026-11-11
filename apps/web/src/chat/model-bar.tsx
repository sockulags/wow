import {
  nextPermissionMode,
  type PermissionModeTone,
  type ProviderKind,
  type SettingKey,
} from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { CheckIcon, ImageIcon, TriangleAlertIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { eventToBinding, normalizeBinding, type KeyLike } from '@/app/keybindings';
import { useRuntime } from '@/app/runtime';
import { WithTooltip } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useModels } from './data';
import { hideModelBar, showModelBar } from './model-commands';
import { permissionOptions } from './model';
import {
  effortChoices,
  modelChoices,
  type ModelDefaults,
  type ThreadSettingsValue,
} from './thread-settings';

// The composer bar (agent workbench spec 1 to 8, 10): the thread's model, effort and permission
// mode at the composer's bottom edge, each opening a searchable list, with keys while the
// composer has the focus. It only renders and sends what the caller applies; a thread sends
// `thread.configure`, the Assistant view writes its settings.

export interface ModelBarHandle {
  openModels(): void;
  openEfforts(): void;
  // Moves to the next mode of the provider's cycle; false when the mode cannot change here.
  cycleMode(): boolean;
}

export interface ModelBarInstances {
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
  onChange(id: string): void;
}

export interface ModelBarProps {
  readonly ref?: Ref<ModelBarHandle>;
  // How the palette's registry knows this bar (`frontModelBar`).
  readonly id?: string;
  readonly providerInstanceId: string;
  readonly kind: ProviderKind;
  readonly value: ThreadSettingsValue;
  // The instance's defaults, marked "(default)" in the lists.
  readonly defaults?: ModelDefaults | undefined;
  onChange(changes: Partial<ThreadSettingsValue>): void;
  // Shown in place of the mode list when the mode cannot be changed (the assistant's).
  readonly modeLocked?: string | undefined;
  // A provider instance part before the model (the Assistant view's).
  readonly instances?: ModelBarInstances | undefined;
  // Where the focus goes when a list closes: back to the composer.
  returnFocus?(): void;
  readonly disabled?: boolean;
}

const toneClass: Readonly<Record<PermissionModeTone, string>> = {
  plan: 'text-info',
  edits: 'text-state-done',
  danger: 'text-destructive',
};

type Part = 'instance' | 'model' | 'effort' | 'mode';

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  );
}

function BarList({
  label,
  part,
  open,
  onOpenChange,
  trigger,
  tooltip,
  shortcut,
  disabled,
  className,
  returnFocus,
  search,
  children,
}: {
  label: string;
  part: Part;
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactNode;
  tooltip: string;
  shortcut?: 'keybindings.composerModel' | 'keybindings.composerEffort';
  disabled: boolean;
  className?: string | undefined;
  returnFocus: (() => void) | undefined;
  search: string;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <WithTooltip label={tooltip} shortcut={shortcut}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={label}
            data-part={part}
            disabled={disabled}
            className={cn('h-6 max-w-48 min-w-0 gap-1 px-1.5 font-normal', className)}
          >
            {trigger}
          </Button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 p-0"
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          // Back to the composer, unless the user already went on, such as to the next part.
          const active = document.activeElement;
          const content = event.target instanceof Element ? event.target : null;
          if (!active || active === document.body || content?.contains(active)) returnFocus();
        }}
      >
        <Command loop>
          <CommandInput placeholder={search} />
          <CommandList label={label}>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>{children}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const Check = ({ on }: { on: boolean }) => (
  <CheckIcon aria-hidden className={cn('ml-auto size-3.5 shrink-0', on ? '' : 'opacity-0')} />
);

export function ModelBar({
  ref,
  id: givenId,
  providerInstanceId,
  kind,
  value,
  defaults,
  onChange,
  modeLocked,
  instances,
  returnFocus,
  disabled = false,
}: ModelBarProps) {
  const ownId = useId();
  const id = givenId ?? ownId;
  const [open, setOpen] = useState<Part>();
  const { models, error } = useModels(providerInstanceId);
  const modelList = modelChoices(models, value.model, defaults);
  const effortList = effortChoices(kind, models, value.model, value.effort, defaults);
  const modes = permissionOptions(kind, value.permissionMode);
  const model = modelList.find((choice) => choice.id === value.model);
  const effort = effortList.find((choice) => choice.id === value.effort);
  const mode = modes.find((option) => option.id === value.permissionMode);
  const tone = mode?.tone;

  const pick = (changes: Partial<ThreadSettingsValue>) => {
    setOpen(undefined);
    onChange(changes);
  };
  // The modes sent since the thread last showed one of them: a second Shift+Tab before the first
  // echoes cycles on from what was sent, not from the mode still on screen.
  const pending = useRef<{ readonly from: string; readonly sent: readonly string[] }>(undefined);
  const cycleMode = () => {
    if (modeLocked !== undefined || disabled) return false;
    const shown = value.permissionMode;
    const before = pending.current;
    const last = before?.sent.at(-1);
    const waiting =
      before !== undefined &&
      last !== undefined &&
      last !== shown &&
      (shown === before.from || before.sent.includes(shown));
    const next = nextPermissionMode(kind, waiting ? last : shown);
    pending.current =
      waiting && before
        ? { from: before.from, sent: [...before.sent, next] }
        : { from: shown, sent: [next] };
    onChange({ permissionMode: next });
    return true;
  };

  useImperativeHandle(ref, () => ({
    openModels: () => !disabled && setOpen('model'),
    openEfforts: () => !disabled && setOpen('effort'),
    cycleMode,
  }));

  // The palette reaches this bar; it reads this render's lists and applies through a ref, so a
  // command run after a change applies to what is on screen now.
  const latest = useRef({ onChange, open: setOpen });
  useLayoutEffect(() => {
    latest.current = { onChange, open: setOpen };
  });
  // Keyed on the values, not on the objects callers build each render, so a streamed item does not
  // write the registry (or rebuild the palette) when nothing in the bar changed.
  const { model: shownModel, effort: shownEffort, permissionMode: shownMode } = value;
  const hasDefaults = defaults !== undefined;
  const defaultModel = defaults?.model ?? null;
  const defaultEffort = defaults?.effort ?? null;
  const locked = modeLocked !== undefined;
  useEffect(() => {
    if (disabled) return;
    showModelBar({
      id,
      kind,
      models,
      value: { model: shownModel, effort: shownEffort, permissionMode: shownMode },
      defaults: hasDefaults ? { model: defaultModel, effort: defaultEffort } : undefined,
      modeLocked: locked,
      apply: (changes) => latest.current.onChange(changes),
      openModels: () => latest.current.open('model'),
      openEfforts: () => latest.current.open('effort'),
    });
  }, [
    id,
    kind,
    models,
    shownModel,
    shownEffort,
    shownMode,
    hasDefaults,
    defaultModel,
    defaultEffort,
    locked,
    disabled,
  ]);
  useEffect(() => {
    if (disabled) return undefined;
    return () => hideModelBar(id);
  }, [id, disabled]);

  const toggle = (part: Part) => (next: boolean) => setOpen(next ? part : undefined);
  const instance = instances?.choices.find((choice) => choice.id === instances.value);

  return (
    <div
      role="group"
      aria-label="Composer bar"
      data-testid="model-bar"
      className="pointer-events-auto inline-flex max-w-full min-w-0 items-center gap-0.5 overflow-hidden text-xs"
    >
      {instances && (
        <>
          <BarList
            label="Provider instance"
            part="instance"
            open={open === 'instance'}
            onOpenChange={toggle('instance')}
            tooltip="Provider instance"
            disabled={disabled}
            returnFocus={returnFocus}
            search="Search instances…"
            trigger={<span className="truncate">{instance?.label ?? instances.value}</span>}
          >
            {instances.choices.map((choice) => (
              <CommandItem
                key={choice.id}
                value={choice.id}
                keywords={[choice.label]}
                onSelect={() => {
                  setOpen(undefined);
                  instances.onChange(choice.id);
                }}
              >
                <span className="truncate">{choice.label}</span>
                <Check on={choice.id === instances.value} />
              </CommandItem>
            ))}
          </BarList>
          <Separator />
        </>
      )}
      <BarList
        label="Model"
        part="model"
        open={open === 'model'}
        onOpenChange={toggle('model')}
        tooltip={error ? `Models unavailable: ${error}` : 'Model'}
        shortcut="keybindings.composerModel"
        disabled={disabled}
        returnFocus={returnFocus}
        search="Search models…"
        className={cn(error && 'text-destructive')}
        trigger={<span className="truncate">{model?.label || value.model || 'No model'}</span>}
      >
        {modelList.map((choice) => (
          <CommandItem
            key={choice.id}
            value={choice.id}
            keywords={[choice.label, choice.description]}
            onSelect={() => pick({ model: choice.id })}
            className="items-start"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium">{choice.label}</span>
                {choice.isDefault && <span className="text-muted-foreground">(default)</span>}
                {choice.providerDefault && (
                  <span className="text-muted-foreground">(provider&apos;s default)</span>
                )}
                {choice.imageInput && (
                  <ImageIcon role="img" aria-label="Takes images" className="size-3.5" />
                )}
              </span>
              {choice.description !== '' && (
                <span className="text-muted-foreground">{choice.description}</span>
              )}
            </span>
            <Check on={choice.id === value.model} />
          </CommandItem>
        ))}
      </BarList>
      <Separator />
      <BarList
        label="Effort"
        part="effort"
        open={open === 'effort'}
        onOpenChange={toggle('effort')}
        tooltip="Effort"
        shortcut="keybindings.composerEffort"
        disabled={disabled || effortList.length === 0}
        returnFocus={returnFocus}
        search="Search efforts…"
        trigger={<span className="truncate">{effort?.label ?? (value.effort || 'Effort')}</span>}
      >
        {effortList.map((choice) => (
          <CommandItem
            key={choice.id}
            value={choice.id}
            keywords={[choice.label]}
            onSelect={() => pick({ effort: choice.id })}
          >
            <span>{choice.label}</span>
            {choice.isDefault && <span className="text-muted-foreground">(default)</span>}
            {choice.isModelDefault && (
              <span className="text-muted-foreground">(model&apos;s default)</span>
            )}
            <Check on={choice.id === value.effort} />
          </CommandItem>
        ))}
      </BarList>
      <Separator />
      {modeLocked !== undefined ? (
        <span data-part="mode" className="px-1.5 text-muted-foreground">
          {modeLocked}
        </span>
      ) : (
        <BarList
          label="Permission mode"
          part="mode"
          open={open === 'mode'}
          onOpenChange={toggle('mode')}
          tooltip="Permission mode"
          disabled={disabled}
          returnFocus={returnFocus}
          search="Search modes…"
          className={cn(tone && toneClass[tone])}
          trigger={
            <>
              {tone === 'danger' && <TriangleAlertIcon aria-hidden className="size-3.5" />}
              <span className="truncate" data-tone={tone}>
                {mode?.short ?? mode?.label ?? value.permissionMode}
              </span>
            </>
          }
        >
          {modes.map((option) => (
            <CommandItem
              key={option.id}
              value={option.id}
              keywords={[option.label, option.short ?? '']}
              onSelect={() => pick({ permissionMode: option.id })}
              className={cn(option.tone && toneClass[option.tone])}
            >
              {option.tone === 'danger' && <TriangleAlertIcon aria-hidden className="size-3.5" />}
              <span>{option.label}</span>
              <Check on={option.id === value.permissionMode} />
            </CommandItem>
          ))}
        </BarList>
      )}
    </div>
  );
}

export type BarKey = 'model' | 'effort' | 'mode' | 'leave';

export interface BarBindings {
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
  readonly leave: string;
}

// Which of the bar's keys an event in the composer is, by the keybindings settings.
export function barKeyOf(event: KeyLike, bindings: BarBindings, mac?: boolean): BarKey | undefined {
  const pressed = eventToBinding(event, mac);
  if (!pressed) return undefined;
  return (Object.keys(bindings) as BarKey[]).find((key) => {
    const binding = bindings[key];
    return binding !== '' && normalizeBinding(binding, mac) === pressed;
  });
}

const tabbable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

// What Shift+Tab would focus from `element` (the composer's way out, since Shift+Tab changes the
// mode there): the focusable element before it in document order.
export function focusBefore(element: HTMLElement): boolean {
  const all = [...element.ownerDocument.querySelectorAll<HTMLElement>(tabbable)].filter(
    (candidate) => candidate.tabIndex >= 0 && !candidate.closest('[inert], [hidden]'),
  );
  // A candidate that is hidden by style cannot take the focus; try the one before it.
  for (let at = all.indexOf(element) - 1; at >= 0; at -= 1) {
    const before = all[at];
    if (!before) continue;
    before.focus();
    if (element.ownerDocument.activeElement === before) return true;
  }
  return false;
}

// The composer's handler for the bar's keys: true when the key was the bar's and was used.
export function useModelBarKeys(
  bar: RefObject<ModelBarHandle | null>,
): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const { settings } = useRuntime();
  return (event) => {
    if (event.nativeEvent.isComposing) return false;
    const { values } = settings.getState();
    const binding = (key: SettingKey): string => {
      const stored = settingValue(values, key);
      return typeof stored === 'string' ? stored : '';
    };
    const key = barKeyOf(event, {
      model: binding('keybindings.composerModel'),
      effort: binding('keybindings.composerEffort'),
      mode: binding('keybindings.composerModeCycle'),
      leave: binding('keybindings.composerLeave'),
    });
    const handle = bar.current;
    if (!key) return false;
    if (key === 'leave') {
      if (!focusBefore(event.currentTarget)) return false;
    } else if (!handle) {
      return false;
    } else if (key === 'model') handle.openModels();
    else if (key === 'effort') handle.openEfforts();
    else if (!handle.cycleMode()) return false;
    event.preventDefault();
    return true;
  };
}
