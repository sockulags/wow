import type { ProviderKind, Skill } from '@wow/contracts';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorMessage, useTopic } from './data';
import { filterSkills, insertSkill, skillQuery, type SkillQuery } from './model';

export interface ComposerProps {
  readonly providerKind: ProviderKind | undefined;
  readonly running: boolean;
  readonly disabled?: boolean;
  readonly placeholder: string;
  onSend(text: string): Promise<unknown>;
  onStop?(): void;
  // Context meter and resume action, shown under the text box.
  readonly footer?: ReactNode;
}

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
  active: number;
  kind: ProviderKind;
  onPick(skill: Skill): void;
  onHover(index: number): void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Skills"
      className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {skills.length === 0 && (
        <li className="px-2 py-1.5 text-xs text-muted-foreground">No matching skills.</li>
      )}
      {skills.map((skill, index) => (
        <li
          key={skill.id}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          // Keep the focus in the text box.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(skill)}
          className={cn(
            'flex cursor-pointer flex-col rounded-sm px-2 py-1.5',
            index === active && 'bg-accent text-accent-foreground',
          )}
        >
          <span className="flex items-baseline gap-2 text-sm">
            <span className="font-medium">{skill.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {skill.invocations[kind]}
            </span>
          </span>
          {skill.description !== '' && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Composer({
  providerKind,
  running,
  disabled = false,
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
  const pendingCaret = useRef<number>(undefined);
  const skills = useTopic('skills');

  const query: SkillQuery | undefined =
    providerKind && dismissedAt !== caret ? skillQuery(text, caret) : undefined;
  const matches = query ? filterSkills(skills ?? [], query.query) : [];
  const pickerOpen = query !== undefined && providerKind !== undefined;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === undefined || !textarea.current) return;
    pendingCaret.current = undefined;
    textarea.current.setSelectionRange(at, at);
  }, [text]);

  const update = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
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
    if (message === '' || running || disabled || sending) return;
    setSending(true);
    setError(undefined);
    onSend(message).then(
      () => {
        setSending(false);
        update('', 0);
      },
      (reason: unknown) => {
        setSending(false);
        setError(errorMessage(reason));
      },
    );
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
        const skill = matches[activeIndex];
        if (skill) {
          event.preventDefault();
          pick(skill);
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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative rounded-lg border border-input bg-background focus-within:border-ring dark:bg-input/30">
        {pickerOpen && (
          <SkillPicker
            id={pickerId}
            skills={matches}
            active={activeIndex}
            kind={providerKind}
            onPick={pick}
            onHover={setActive}
          />
        )}
        <textarea
          ref={textarea}
          aria-label="Message"
          role="combobox"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            pickerOpen && matches.length > 0 ? `${pickerId}-${activeIndex}` : undefined
          }
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
          {running && onStop ? (
            <Button size="sm" variant="secondary" onClick={onStop} aria-label="Stop">
              <SquareIcon className="size-3 fill-current" />
              Stop
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label="Send"
              disabled={disabled || sending || text.trim() === ''}
              onClick={send}
            >
              <ArrowUpIcon />
            </Button>
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
