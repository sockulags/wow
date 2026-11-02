import { XIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Tags as chips (audit D-11): Enter or a comma adds what is typed, Backspace in an empty box
// removes the last one, and tags other items use are offered as you type.
export function TagInput({
  id,
  tags,
  suggestions,
  onChange,
  className,
}: {
  id?: string;
  tags: readonly string[];
  suggestions: readonly string[];
  onChange(tags: string[]): void;
  className?: string;
}) {
  const [text, setText] = useState('');
  const add = (value: string) => {
    const tag = value.trim();
    if (tag !== '' && !tags.includes(tag)) onChange([...tags, tag]);
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      if (text.trim() === '') return;
      event.preventDefault();
      add(text);
    } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };
  const needle = text.trim().toLowerCase();
  const offered = suggestions.filter(
    (tag) => !tags.includes(tag) && (needle === '' || tag.toLowerCase().includes(needle)),
  );
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background dark:bg-input/30">
        {tags.map((tag) => (
          <span
            key={tag}
            data-testid="tag-chip"
            className="inline-flex h-6 items-center gap-1 rounded-md bg-secondary pr-0.5 pl-2 text-xs text-secondary-foreground"
          >
            {tag}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-5"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
            >
              <XIcon />
            </Button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          aria-label="Add a tag"
          placeholder={tags.length === 0 ? 'Add a tag and press Enter' : undefined}
          onChange={(event) => setText(event.target.value.replace(',', ''))}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() !== '' && add(text)}
          className="h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {offered.length > 0 && (
        <div role="group" aria-label="Suggested tags" className="flex flex-wrap gap-1">
          {offered.map((tag) => (
            <Button
              key={tag}
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(tag)}
            >
              + {tag}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
