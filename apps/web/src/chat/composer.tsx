import type { ProviderKind, Skill } from '@wow/contracts';
import { ArrowUpIcon, ClockIcon, SquareIcon, XIcon } from 'lucide-react';
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
} from 'react';
import { useSetting } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { errorMessage, useTopic } from './data';
import { LocalTooltip } from './local-ui';
import { filterSkills, insertSkill, skillQuery, type SkillQuery } from './model';
import { skillGroup, skillGroups, skillSourceLabel } from './view-model';

export interface ComposerHandle {
  focus(): void;
  // Puts text in the box (a starter) and the caret after it.
  setText(text: string): void;
}

export interface ComposerProps {
  readonly ref?: Ref<ComposerHandle>;
  readonly providerKind: ProviderKind | undefined;
  readonly running: boolean;
  readonly disabled?: boolean;
  // Why Send cannot work yet ("Pick a project or a folder first"). Send stays disabled and says so.
  readonly blockedReason?: string | undefined;
  readonly placeholder: string;
  onSend(text: string): Promise<unknown>;
  onStop?(): void;
  // Context meter and resume action, shown under the text box.
  readonly footer?: ReactNode;
}

// The `$` picker (spec 18): a cmdk list grouped by where each skill comes from. The focus stays
// in the text box, so the composer moves the selection itself and cmdk only renders it.
function SkillPicker({
  id,
  skills,
  active,
  kind,
  onPick,
  onHover,
}: {
  id: string;
  skills: readonly Skill[];
  active: Skill | undefined;
  kind: ProviderKind;
  onPick(skill: Skill): void;
  onHover(skill: Skill): void;
}) {
  return (
    <div className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-md border border-border shadow-md">
      <Command
        shouldFilter={false}
        value={active?.id ?? ''}
        className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
      >
        <CommandList id={id} label="Skills" className="max-h-72">
          {skills.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching skills.</p>
          )}
          {skillGroups.map((group) => {
            const members = skills.filter((skill) => skillGroup(skill) === group);
            if (members.length === 0) return null;
            return (
              <CommandGroup key={group} heading={group}>
                {members.map((skill) => (
                  <CommandItem
                    key={skill.id}
                    value={skill.id}
                    // Keep the focus in the text box.
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => onHover(skill)}
                    onSelect={() => onPick(skill)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="font-medium">{skill.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {skill.invocations[kind]}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {skillSourceLabel(skill)}
                      </span>
                    </span>
                    {skill.description !== '' && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </div>
  );
}

// Picker order: grouped like the list shows them, each group ranked by the filter.
const inPickerOrder = (skills: readonly Skill[]): Skill[] =>
  skillGroups.flatMap((group) => skills.filter((skill) => skillGroup(skill) === group));

export function Composer({
  ref,
  providerKind,
  running,
  disabled = false,
  blockedReason,
  placeholder,
  onSend,
  onStop,
  footer,
}: ComposerProps) {
  const pickerId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // A message written while a turn runs; it goes when the turn ends (C-09).
  const [queued, setQueued] = useState<string>();
  const [activeDescendant, setActiveDescendant] = useState<string>();
  const pendingCaret = useRef<number>(undefined);
  const skills = useTopic('skills');
  const stopBinding = useSetting('keybindings.stopTurn');

  const query: SkillQuery | undefined =
    providerKind && dismissedAt !== caret ? skillQuery(text, caret) : undefined;
  const matches = query ? inPickerOrder(filterSkills(skills ?? [], query.query)) : [];
  const pickerOpen = query !== undefined && providerKind !== undefined;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const activeSkill = matches[activeIndex];

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textarea.current?.focus(),
      setText: (value: string) => {
        pendingCaret.current = value.length;
        setText(value);
        setCaret(value.length);
        setError(undefined);
        textarea.current?.focus();
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === undefined || !textarea.current) return;
    pendingCaret.current = undefined;
    textarea.current.setSelectionRange(at, at);
  }, [text]);

  // cmdk names its options itself; the text box points at the selected one.
  useLayoutEffect(() => {
    if (!pickerOpen) return setActiveDescendant(undefined);
    const selected = document
      .getElementById(pickerId)
      ?.querySelector('[cmdk-item][aria-selected="true"]');
    setActiveDescendant(selected?.id || undefined);
  }, [pickerOpen, pickerId, activeSkill?.id, matches.length]);

  const deliver = (message: string, onDone?: () => void) => {
    setSending(true);
    setError(undefined);
    onSend(message).then(
      () => {
        setSending(false);
        onDone?.();
      },
      (reason: unknown) => {
        setSending(false);
        setError(errorMessage(reason));
      },
    );
  };

  // The turn ended: what was queued goes now.
  useEffect(() => {
    if (running || queued === undefined || sending) return;
    const message = queued;
    setQueued(undefined);
    deliver(message);
    // deliver only reads props that change with `running`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [running, queued, sending]);

  const update = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setError(undefined);
  };

  const pick = (skill: Skill) => {
    if (!query || !providerKind) return;
    const next = insertSkill(text, query, caret, skill.invocations[providerKind]);
    pendingCaret.current = next.caret;
    update(next.text, next.caret);
    textarea.current?.focus();
  };

  const send = () => {
    const message = text.trim();
    if (message === '' || disabled || sending) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (running) {
      setQueued(queued === undefined ? message : `${queued}\n\n${message}`);
      update('', 0);
      return;
    }
    deliver(message, () => update('', 0));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = Math.max(1, matches.length);
        setActive((activeIndex + step + count) % count);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        if (activeSkill) {
          event.preventDefault();
          pick(activeSkill);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedAt(caret);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const sendBlocked = disabled || sending || text.trim() === '' || blockedReason !== undefined;
  const sendButton = (
    <Button
      size="icon-sm"
      aria-label={running ? 'Queue message' : 'Send'}
      aria-disabled={sendBlocked || undefined}
      disabled={disabled || sending || text.trim() === ''}
      className={cn(blockedReason !== undefined && 'opacity-50')}
      onClick={send}
    >
      <ArrowUpIcon />
    </Button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {queued !== undefined && (
        <div
          data-testid="queued-message"
          className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-xs"
        >
          <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Sent when the turn ends: </span>
            {queued}
          </span>
          {onStop && (
            <Button size="xs" variant="outline" onClick={onStop}>
              Send now
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel queued message"
            onClick={() => {
              update(queued, queued.length);
              pendingCaret.current = queued.length;
              setQueued(undefined);
              textarea.current?.focus();
            }}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <div className="relative rounded-lg border border-input bg-background focus-within:border-ring dark:bg-input/30">
        {pickerOpen && (
          <SkillPicker
            id={pickerId}
            skills={matches}
            active={activeSkill}
            kind={providerKind}
            onPick={pick}
            onHover={(skill) => setActive(Math.max(0, matches.indexOf(skill)))}
          />
        )}
        <textarea
          ref={textarea}
          aria-label="Message"
          role="combobox"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          rows={3}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) =>
            update(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          className="block max-h-64 min-h-20 w-full resize-none bg-transparent px-3 pt-2.5 pb-10 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {running && onStop && (
            <LocalTooltip label="Stop" binding={stopBinding}>
              <Button size="sm" variant="secondary" onClick={onStop} aria-label="Stop">
                <SquareIcon className="size-3 fill-current" />
                Stop
              </Button>
            </LocalTooltip>
          )}
          {blockedReason !== undefined && text.trim() !== '' ? (
            <LocalTooltip label={blockedReason}>{sendButton}</LocalTooltip>
          ) : (
            sendButton
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {footer}
    </div>
  );
}
