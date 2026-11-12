import {
  ambiguousOwnSkill,
  ownSkillFolder,
  skillGroupLabels,
  type ProviderKind,
  type Skill,
  type SkillRef,
} from '@wow/contracts';
import { ArrowUpIcon, SlashIcon, SquareIcon, TerminalIcon } from 'lucide-react';
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
import { useStore } from 'zustand';
import { useSetting } from '@/app/runtime';
import { WithTooltip } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { showSkillComposer } from './composer-store';
import { errorMessage, useTopic } from './data';
import { readDraft, writeDraft, type ComposerDraft } from './drafts';
import {
  filterSkills,
  skillQuery,
  skillRefOf,
  typedTrigger,
  withoutQuery,
  type SkillQuery,
} from './model';
import { ComposerSkillChip, SkillMark } from './skill-chip';
import {
  paletteCommandsStore,
  providerCommandPicks,
  providerCommandText,
  runPaletteCommand,
  useProviderCommands,
  wowCommandPicks,
  type CommandPick,
  type CommandSource,
} from './slash-commands';
import { skillGroup, skillGroups, skillSourceLabel } from './view-model';

export interface ComposerHandle {
  focus(): void;
  // Puts text in the box (text handed over from elsewhere) and the caret after it.
  setText(text: string): void;
  // Adds a skill as a chip, as a pick from the list does (a starter).
  addSkill(skill: Skill): void;
  // Sends what the box holds now the way Send does (queued by the server while a turn runs, as
  // the answer to a waiting question) without asking `beforeSend`: the Assistant view's "Send
  // anyway".
  sendUnchecked(): void;
  // What the box holds now.
  text(): string;
  // A message taken back off the queue (Edit, agent workbench spec 52): its text before what the
  // box holds, its skills as chips.
  putBack(text: string, skills: readonly SkillRef[]): void;
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
  // The model bar at the box's bottom edge, left of Stop and Send (agent workbench spec 1).
  readonly bar?: ReactNode;
  // Where the text and chips are kept until sent (agent workbench spec 49): one key per thread.
  // Without one nothing is kept (the Assistant view, whose text may hold a secret).
  readonly draftKey?: string | undefined;
  // The open thread's provider and folder: `/` then lists commands above the skills (spec 58 to
  // 60). Without it the list holds skills only.
  readonly commandSource?: CommandSource | undefined;
  // The bar's keys while the box has the focus; true when the key was used.
  onBarKey?(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

// A row of the `/` list: a command (spec 58, 60) or a skill.
type ListPick = CommandPick | { readonly kind: 'skill'; readonly skill: Skill };

const pickValue = (pick: ListPick): string =>
  pick.kind === 'skill'
    ? pick.skill.id
    : pick.kind === 'wow'
      ? `command:${pick.entry.name}`
      : `provider:${pick.command.name}`;

const groupClass =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

const commandRow = (name: string, description: string, icon: ReactNode, hint?: string) => (
  <span className="flex w-full items-baseline gap-2 [&>svg]:size-3 [&>svg]:self-center">
    {icon}
    <span className="font-mono font-medium">/{name}</span>
    {hint && <span className="font-mono text-2xs text-muted-foreground">{hint}</span>}
    <span className="min-w-0 truncate text-xs text-muted-foreground">{description}</span>
  </span>
);

// The skill list (wow skills spec 16) with wow's and the provider's commands above it: a cmdk
// list grouped like every skill list. The focus stays in the text box, so the composer moves the
// selection itself and cmdk only renders it.
function SkillPicker({
  id,
  picks,
  all,
  active,
  kind,
  onPick,
  onHover,
}: {
  id: string;
  picks: readonly ListPick[];
  // Every skill, to tell which own skills share a name.
  all: readonly Skill[];
  active: ListPick | undefined;
  kind: ProviderKind;
  onPick(pick: ListPick): void;
  onHover(pick: ListPick): void;
}) {
  const wow = picks.filter((pick) => pick.kind === 'wow');
  const provider = picks.filter((pick) => pick.kind === 'provider');
  const skills = picks.flatMap((pick) => (pick.kind === 'skill' ? [pick.skill] : []));
  const item = (pick: ListPick, children: ReactNode) => (
    <CommandItem
      key={pickValue(pick)}
      value={pickValue(pick)}
      // Keep the focus in the text box.
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={() => onHover(pick)}
      onSelect={() => onPick(pick)}
      className="flex-col items-start gap-0.5"
    >
      {children}
    </CommandItem>
  );
  return (
    <div className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-md border border-border shadow-md">
      <Command shouldFilter={false} value={active ? pickValue(active) : ''} className={groupClass}>
        <CommandList id={id} label="Skills" className="max-h-72">
          {picks.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No matching skills.</p>
          )}
          {wow.length > 0 && (
            <CommandGroup heading="Commands">
              {wow.map((pick) =>
                item(
                  pick,
                  pick.kind === 'wow' &&
                    commandRow(pick.entry.name, pick.entry.description, <SlashIcon aria-hidden />),
                ),
              )}
            </CommandGroup>
          )}
          {provider.length > 0 && (
            <CommandGroup heading={`${kind === 'claude' ? 'Claude Code' : 'Provider'} commands`}>
              {provider.map((pick) =>
                item(
                  pick,
                  pick.kind === 'provider' &&
                    commandRow(
                      pick.command.name,
                      pick.command.description,
                      <TerminalIcon aria-hidden />,
                      pick.command.argumentHint,
                    ),
                ),
              )}
            </CommandGroup>
          )}
          {skillGroups.map((group) => {
            const members = skills.filter((skill) => skillGroup(skill) === group);
            if (members.length === 0) return null;
            return (
              <CommandGroup key={group} heading={skillGroupLabels[group]}>
                {members.map((skill) =>
                  item(
                    { kind: 'skill', skill },
                    <>
                      <span className="flex w-full items-baseline gap-2 [&>svg]:size-3 [&>svg]:self-center">
                        <SkillMark group={group} />
                        <span className="font-medium">{skill.name}</span>
                        {skill.source === 'yours' &&
                          ambiguousOwnSkill(all, skill.name) !== undefined && (
                            <span className="font-mono text-2xs text-muted-foreground">
                              in {ownSkillFolder(skill)}
                            </span>
                          )}
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
                    </>,
                  ),
                )}
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

const sameRef = (skill: Skill, ref: SkillRef): boolean => {
  const own = skillRefOf(skill);
  return own.name === ref.name && own.source === ref.source;
};

// The text the input event typed, or null for a paste, a drop or a deletion: only a typed
// trigger character opens the list (wow skills spec 19).
function typedText(event: Event): string | null {
  const input = event as Partial<InputEvent>;
  return input.inputType === 'insertText' || input.inputType === 'insertCompositionText'
    ? (input.data ?? null)
    : null;
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
  bar,
  onBarKey,
  draftKey,
  commandSource,
}: ComposerProps) {
  const pickerId = useId();
  const composerId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const chipElements = useRef<(HTMLSpanElement | null)[]>([]);
  // The draft of the thread on screen (agent workbench spec 49), read once per thread.
  const [initial] = useState<ComposerDraft>(() =>
    draftKey === undefined ? { text: '', skills: [] } : readDraft(draftKey),
  );
  const [text, setText] = useState(initial.text);
  // Which draft the text and chips belong to: they are written back only to their own.
  const [draftFor, setDraftFor] = useState(draftKey);
  // A send answers after its own render: the thread on screen then is read from here.
  const onScreen = useRef(draftKey);
  useLayoutEffect(() => {
    onScreen.current = draftKey;
  }, [draftKey]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Where the list was opened by a typed trigger character; undefined while it is closed.
  const [openAt, setOpenAt] = useState<number>();
  const [chips, setChips] = useState<readonly Skill[]>(initial.skills);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [activeDescendant, setActiveDescendant] = useState<string>();
  const pendingCaret = useRef<number>(undefined);
  const skills = useTopic('skills');
  const stopBinding = useSetting('keybindings.stopTurn');
  const trigger = useSetting('chat.skillTrigger');
  const palette = useStore(paletteCommandsStore, (state) => state.commands);
  const takesSkills = providerKind !== undefined;

  const query: SkillQuery | undefined = takesSkills
    ? skillQuery(text, caret, openAt, trigger)
    : undefined;
  const pickerOpen = query !== undefined && providerKind !== undefined;
  const offersCommands = pickerOpen && commandSource !== undefined;
  const providerCommands = useProviderCommands(commandSource, offersCommands);
  const wowPicks = offersCommands && query ? wowCommandPicks(palette, query.query) : [];
  const picks: ListPick[] = query
    ? [
        ...wowPicks,
        ...(offersCommands
          ? providerCommandPicks(providerCommands, wowPicks, skills ?? [], query.query)
          : []),
        ...inPickerOrder(filterSkills(skills ?? [], query.query)).map((skill): ListPick => ({
          kind: 'skill',
          skill,
        })),
      ]
    : [];
  const activeIndex = Math.min(active, Math.max(0, picks.length - 1));
  const activePick = picks[activeIndex];

  // Another thread on screen: its own draft comes in, and nothing of this one goes with it.
  useLayoutEffect(() => {
    if (draftKey === draftFor) return;
    const draft = draftKey === undefined ? { text: '', skills: [] } : readDraft(draftKey);
    setDraftFor(draftKey);
    setText(draft.text);
    setChips(draft.skills);
    setCaret(draft.text.length);
    setOpenAt(undefined);
    setError(undefined);
    pendingCaret.current = draft.text.length;
  }, [draftKey, draftFor]);

  useEffect(() => {
    if (draftKey === undefined || draftFor !== draftKey) return;
    writeDraft(draftKey, { text, skills: chips });
  }, [draftKey, draftFor, text, chips]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === undefined || !textarea.current) return;
    pendingCaret.current = undefined;
    textarea.current.setSelectionRange(at, at);
  }, [text, chips]);

  // cmdk names its options itself; the text box points at the selected one.
  const activeValue = activePick ? pickValue(activePick) : undefined;
  useLayoutEffect(() => {
    if (!pickerOpen) return setActiveDescendant(undefined);
    const selected = document
      .getElementById(pickerId)
      ?.querySelector('[cmdk-item][aria-selected="true"]');
    setActiveDescendant(selected?.id || undefined);
  }, [pickerOpen, pickerId, activeValue, picks.length]);

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

  const deliver = (message: Message) => {
    setSending(true);
    setError(undefined);
    const refs = message.skills.map(skillRefOf);
    const sentFrom = draftFor;
    (refs.length > 0 ? onSend(message.text, refs) : onSend(message.text)).then(
      () => {
        setSending(false);
        // Sent from a thread that is no longer on screen: only its stored draft goes.
        if (sentFrom === onScreen.current) clear();
        else if (sentFrom !== undefined) writeDraft(sentFrom, { text: '', skills: [] });
      },
      (reason: unknown) => {
        setSending(false);
        setError(errorMessage(reason));
      },
    );
  };

  const focusText = (at: number) => {
    pendingCaret.current = at;
    setCaret(at);
    textarea.current?.focus();
    textarea.current?.setSelectionRange(at, at);
  };

  const pickSkill = (skill: Skill) => {
    if (!query || !providerKind) return;
    const next = withoutQuery(text, query, caret);
    pendingCaret.current = next.caret;
    update(next.text, next.caret, undefined);
    setChips((current) => withSkill(current, skill));
    textarea.current?.focus();
  };

  // A wow command runs as its palette command, the typed `/word` taken out of the text; a
  // provider command goes into the text and is sent as typed (spec 58, 60).
  const choose = (pick: ListPick) => {
    if (pick.kind === 'skill') {
      pickSkill(pick.skill);
      return;
    }
    if (!query) return;
    const next = withoutQuery(text, query, caret);
    if (pick.kind === 'provider') {
      const inserted = providerCommandText(pick.command);
      const value = `${next.text.slice(0, next.caret)}${inserted}${next.text.slice(next.caret)}`;
      pendingCaret.current = next.caret + inserted.length;
      update(value, next.caret + inserted.length, undefined);
      textarea.current?.focus();
      return;
    }
    pendingCaret.current = next.caret;
    update(next.text, next.caret, undefined);
    runPaletteCommand(pick.command);
  };

  // From a focused chip the caret goes to the start of the text, next to where the chip was;
  // from its cross or the palette it stays where the writer left it.
  const removeChip = (index: number, fromChip = false) => {
    setChips((current) => current.filter((_, at) => at !== index));
    if (fromChip) focusText(0);
    else textarea.current?.focus();
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

  // A queued message back in the box: its text first, then what was typed since; its skills as
  // chips where they are still listed.
  const putBack = (value: string, refs: readonly SkillRef[]) => {
    const joined = [value, text].filter((part) => part.trim() !== '').join('\n\n');
    pendingCaret.current = value.length;
    update(joined, value.length, undefined);
    if (takesSkills) {
      const found = refs.flatMap((wanted) =>
        (skills ?? []).filter((skill) => sameRef(skill, wanted)),
      );
      setChips((current) => found.reduce(withSkill, [...current]));
    }
    textarea.current?.focus();
  };

  // While a turn runs the server queues the message (agent workbench spec 50).
  const send = (checked = true) => {
    const message = text.trim();
    if ((message === '' && chips.length === 0) || disabled || sending) return;
    if (blockedReason) {
      setError(blockedReason);
      return;
    }
    if (checked && beforeSend && !beforeSend(message)) return;
    deliver({ text: message, skills: chips });
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
    putBack,
  }));

  // The palette reaches the composer on screen that takes skills. It registers once per chip
  // list, not per keystroke, so the palette's commands are not rebuilt while the writer types;
  // the registered actions reach this render's text and caret through a ref.
  const actions = useRef({ openSkills, removeChip, putBack });
  useLayoutEffect(() => {
    actions.current = { openSkills, removeChip, putBack };
  });
  const chipNames = chips.map((chip) => chip.name).join('\n');
  useEffect(() => {
    if (!takesSkills || disabled) return undefined;
    return showSkillComposer({
      id: composerId,
      draftKey,
      chips: chipNames === '' ? [] : chipNames.split('\n'),
      openSkills: () => actions.current.openSkills(),
      removeSkill: (index: number) => actions.current.removeChip(index),
      putBack: (value, refs) => actions.current.putBack(value, refs),
    });
  }, [takesSkills, disabled, composerId, chipNames, draftKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = Math.max(1, picks.length);
        setActive((activeIndex + step + count) % count);
        return;
      }
      if (
        (event.key === 'Enter' || event.key === 'Tab') &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        if (activePick) {
          event.preventDefault();
          choose(activePick);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpenAt(undefined);
        return;
      }
    }
    if (onBarKey?.(event)) return;
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
      removeChip(index, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      focusText(0);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A letter typed on a chip goes into the text, at its start.
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
      <div className="relative rounded-lg border border-input bg-background focus-within:border-ring dark:bg-input/30">
        {pickerOpen && (
          <SkillPicker
            id={pickerId}
            picks={picks}
            all={skills ?? []}
            active={activePick}
            kind={providerKind}
            onPick={choose}
            onHover={(pick) =>
              setActive(
                Math.max(
                  0,
                  picks.findIndex((candidate) => pickValue(candidate) === pickValue(pick)),
                ),
              )
            }
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
        {/* Only the bar's and the buttons' own boxes take the pointer; around them the text box
            does. */}
        <div className="pointer-events-none absolute right-2 bottom-2 left-2 flex items-center gap-1">
          <div className="min-w-0 flex-1">{bar}</div>
          <div className="pointer-events-auto flex items-center gap-1">
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
