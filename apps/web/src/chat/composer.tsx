import { skillGroupLabels, type ProviderKind, type Skill, type SkillRef } from '@wow/contracts';
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
import { WithTooltip } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { showSkillComposer } from './composer-store';
import { errorMessage, useTopic } from './data';
import {
  filterSkills,
  skillQuery,
  skillRefOf,
  typedTrigger,
  withoutQuery,
  type SkillQuery,
} from './model';
import { ComposerSkillChip, SkillMark } from './skill-chip';
import { skillGroup, skillGroups, skillSourceLabel } from './view-model';

export interface ComposerHandle {
  focus(): void;
  // Puts text in the box (text handed over from elsewhere) and the caret after it.
  setText(text: string): void;
  // Adds a skill as a chip, as a pick from the list does (a starter).
  addSkill(skill: Skill): void;
  // Sends what the box holds now the way Send does (queued while a turn runs, as the answer to a
  // waiting question) without asking `beforeSend`: the Assistant view's "Send anyway".
  sendUnchecked(): void;
  // What the box holds now.
  text(): string;
}

export interface ComposerProps {
  readonly ref?: Ref<ComposerHandle>;
  // The provider the message goes to. Without one the composer takes no skills (the assistant's).
  readonly providerKind: ProviderKind | undefined;
  readonly running: boolean;
  readonly disabled?: boolean;
  // Why Send cannot work yet ("Pick a project or a folder first"). Send stays disabled and says so.
  readonly blockedReason?: string | undefined;
  readonly placeholder: string;
  // `skills` is passed only when chips were picked, in their order (wow skills spec 10, 18).
  onSend(text: string, skills?: readonly SkillRef[]): Promise<unknown>;
  onStop?(): void;
  // Context meter and resume action, shown under the text box.
  readonly footer?: ReactNode;
  // Looked at when Send is pressed, before anything is sent or queued; false keeps the text in
  // the box (the Assistant view holds a message that looks like a secret).
  beforeSend?(text: string): boolean;
  // A line above the text box, such as why a message was held.
  readonly notice?: ReactNode;
}

// The skill list (wow skills spec 16): a cmdk list grouped like every skill list. The focus stays
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
        className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
      >
        <CommandList id={id} label="Skills" className="max-h-72">
          {skills.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching skills.</p>
          )}
          {skillGroups.map((group) => {
            const members = skills.filter((skill) => skillGroup(skill) === group);
            if (members.length === 0) return null;
            return (
              <CommandGroup key={group} heading={skillGroupLabels[group]}>
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
                    <span className="flex w-full items-baseline gap-2 [&>svg]:size-3 [&>svg]:self-center">
                      <SkillMark group={group} />
                      <span className="font-medium">{skill.name}</span>
                      {/* A wow skill goes as its text; only a folder skill has an invocation. */}
                      {skill.text === undefined && (
                        <span className="font-mono text-2xs text-muted-foreground">
                          {skill.invocations[kind]}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
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

// List order: grouped like the list shows them, each group ranked by the filter.
const inPickerOrder = (skills: readonly Skill[]): Skill[] =>
  skillGroups.flatMap((group) => skills.filter((skill) => skillGroup(skill) === group));

const withSkill = (chips: readonly Skill[], skill: Skill): Skill[] =>
  chips.some((chip) => chip.id === skill.id) ? [...chips] : [...chips, skill];

// What a message carries besides its text: the picked skills, as chips.
interface Message {
  readonly text: string;
  readonly skills: readonly Skill[];
}

// The text the input event typed, or null for a paste, a drop or a deletion: only a typed
// trigger character opens the list (wow skills spec 19).
function typedText(event: Event): string | null {
  const input = event as Partial<InputEvent>;
  return input.inputType === 'insertText' ? (input.data ?? null) : null;
}

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
  beforeSend,
  notice,
}: ComposerProps) {
  const pickerId = useId();
  const composerId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const chipElements = useRef<(HTMLSpanElement | null)[]>([]);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Where the list was opened by a typed trigger character; undefined while it is closed.
  const [openAt, setOpenAt] = useState<number>();
  const [chips, setChips] = useState<readonly Skill[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // A message written while a turn runs; it goes when the turn ends (C-09).
  const [queued, setQueued] = useState<Message>();
  const [activeDescendant, setActiveDescendant] = useState<string>();
  const pendingCaret = useRef<number>(undefined);
  const skills = useTopic('skills');
  const stopBinding = useSetting('keybindings.stopTurn');
  const trigger = useSetting('chat.skillTrigger');
  const takesSkills = providerKind !== undefined;

  const query: SkillQuery | undefined = takesSkills
    ? skillQuery(text, caret, openAt, trigger)
    : undefined;
  const matches = query ? inPickerOrder(filterSkills(skills ?? [], query.query)) : [];
  const pickerOpen = query !== undefined && providerKind !== undefined;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const activeSkill = matches[activeIndex];

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === undefined || !textarea.current) return;
    pendingCaret.current = undefined;
    textarea.current.setSelectionRange(at, at);
  }, [text, chips]);

  // cmdk names its options itself; the text box points at the selected one.
  useLayoutEffect(() => {
    if (!pickerOpen) return setActiveDescendant(undefined);
    const selected = document
      .getElementById(pickerId)
      ?.querySelector('[cmdk-item][aria-selected="true"]');
    setActiveDescendant(selected?.id || undefined);
  }, [pickerOpen, pickerId, activeSkill?.id, matches.length]);

  const deliver = (message: Message, onDone?: () => void) => {
    setSending(true);
    setError(undefined);
    const refs = message.skills.map(skillRefOf);
    (refs.length > 0 ? onSend(message.text, refs) : onSend(message.text)).then(
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

  const update = (value: string, at: number, opened = openAt) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setError(undefined);
    // Leaving the word that opened the list closes it; coming back does not open it again.
    setOpenAt(skillQuery(value, at, opened, trigger) ? opened : undefined);
  };

  const clear = () => {
    update('', 0, undefined);
    setChips([]);
  };

  const focusText = (at: number) => {
    pendingCaret.current = at;
    setCaret(at);
    textarea.current?.focus();
    textarea.current?.setSelectionRange(at, at);
  };

  const pick = (skill: Skill) => {
    if (!query || !providerKind) return;
    const next = withoutQuery(text, query, caret);
    pendingCaret.current = next.caret;
    update(next.text, next.caret, undefined);
    setChips((current) => withSkill(current, skill));
    textarea.current?.focus();
  };

  const removeChip = (index: number) => {
    setChips((current) => current.filter((_, at) => at !== index));
    focusText(0);
  };

  // The palette's "Pick a skill": the trigger character at the caret opens the list as typing it
  // would, after a space when the caret is inside a word.
  const openSkills = () => {
    if (!takesSkills || disabled) return;
    const at = textarea.current?.selectionStart ?? caret;
    const spaced = at > 0 && !/\s/u.test(text[at - 1] ?? '');
    const start = at + (spaced ? 1 : 0);
    const value = `${text.slice(0, at)}${spaced ? ' ' : ''}${trigger}${text.slice(at)}`;
    pendingCaret.current = start + trigger.length;
    update(value, start + trigger.length, start);
    textarea.current?.focus();
  };

  const send = (checked = true) => {
    const message = text.trim();
    if ((message === '' && chips.length === 0) || disabled || sending) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (checked && beforeSend && !beforeSend(message)) return;
    if (running) {
      setQueued(
        queued === undefined
          ? { text: message, skills: chips }
          : {
              text: [queued.text, message].filter((part) => part !== '').join('\n\n'),
              skills: chips.reduce(withSkill, [...queued.skills]),
            },
      );
      clear();
      return;
    }
    deliver({ text: message, skills: chips }, clear);
  };

  // Built on every render, so sendUnchecked sends the text and state of this render.
  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setText: (value: string) => {
      pendingCaret.current = value.length;
      update(value, value.length, undefined);
      textarea.current?.focus();
    },
    addSkill: (skill: Skill) => {
      if (!takesSkills) return;
      setChips((current) => withSkill(current, skill));
      textarea.current?.focus();
    },
    sendUnchecked: () => send(false),
    text: () => text,
  }));

  // The palette reaches the composer on screen that takes skills.
  const chipNames = chips.map((chip) => chip.name).join('\n');
  useEffect(() => {
    if (!takesSkills || disabled) return undefined;
    return showSkillComposer({
      id: composerId,
      chips: chipNames === '' ? [] : chipNames.split('\n'),
      openSkills,
      removeSkill: removeChip,
    });
    // openSkills and removeChip read the state of the render that registered them.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [takesSkills, disabled, composerId, chipNames, text, caret]);

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
        setOpenAt(undefined);
        return;
      }
    }
    // The chips stand before the text: at its start, Backspace removes the last chip whole and
    // the left arrow steps onto it (wow skills spec 17).
    const box = event.currentTarget;
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    if (atStart && chips.length > 0 && !event.shiftKey && !event.altKey) {
      if (event.key === 'Backspace') {
        event.preventDefault();
        setChips((current) => current.slice(0, -1));
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        chipElements.current[chips.length - 1]?.focus();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  // On a chip the arrow keys step to the next chip or back into the text; Backspace and Delete
  // remove it.
  const onChipKeyDown = (index: number, event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      chipElements.current[Math.max(0, index - 1)]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = chipElements.current[index + 1];
      if (index + 1 < chips.length && next) next.focus();
      else focusText(0);
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      removeChip(index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      focusText(0);
    }
  };

  const empty = text.trim() === '' && chips.length === 0;
  const sendBlocked = disabled || sending || empty || blockedReason !== undefined;
  const sendButton = (
    <Button
      size="icon-sm"
      aria-label={running ? 'Queue message' : 'Send'}
      aria-disabled={sendBlocked || undefined}
      disabled={disabled || sending || empty}
      className={cn(blockedReason !== undefined && 'opacity-50')}
      onClick={() => send()}
    >
      <ArrowUpIcon />
    </Button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {notice}
      {queued !== undefined && (
        <div
          data-testid="queued-message"
          className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-xs"
        >
          <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Sent when the turn ends: </span>
            {[...queued.skills.map((skill) => `${trigger}${skill.name}`), queued.text]
              .filter((part) => part !== '')
              .join(' ')}
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
              update(queued.text, queued.text.length, undefined);
              setChips(queued.skills);
              pendingCaret.current = queued.text.length;
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
        {takesSkills && chips.length > 0 && (
          <div role="list" aria-label="Picked skills" className="flex flex-wrap gap-1 px-3 pt-2.5">
            {chips.map((chip, index) => (
              <ComposerSkillChip
                key={chip.id}
                ref={(element) => {
                  chipElements.current[index] = element;
                }}
                name={chip.name}
                group={skillGroup(chip)}
                onRemove={() => removeChip(index)}
                onKeyDown={(event) => onChipKeyDown(index, event)}
              />
            ))}
          </div>
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
          onChange={(event) => {
            const value = event.target.value;
            const at = event.target.selectionStart ?? value.length;
            const typed = typedTrigger(value, at, typedText(event.nativeEvent), trigger);
            update(value, at, typed ?? openAt);
          }}
          onSelect={(event) => {
            const at = event.currentTarget.selectionStart ?? 0;
            setCaret(at);
            if (!skillQuery(text, at, openAt, trigger)) setOpenAt(undefined);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'block max-h-64 min-h-20 w-full resize-none bg-transparent px-3 pb-10 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50',
            takesSkills && chips.length > 0 ? 'pt-1.5' : 'pt-2.5',
          )}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {running && onStop && (
            <WithTooltip label="Stop" binding={stopBinding}>
              <Button size="sm" variant="secondary" onClick={onStop} aria-label="Stop">
                <SquareIcon className="size-3 fill-current" />
                Stop
              </Button>
            </WithTooltip>
          )}
          {blockedReason !== undefined && !empty ? (
            <WithTooltip label={blockedReason}>{sendButton}</WithTooltip>
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
