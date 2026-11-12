import type { Thread } from '@wow/contracts';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Input } from '@/components/ui/input';
import { notify } from '@/lib/feedback';
import { errorMessage, useDispatch } from './data';
import { threadTitle } from './model';
import { isArchived, startRename, threadListStore } from './thread-commands';

const stop = () => threadListStore.setState({ renaming: undefined });

// The header's title (agent workbench spec 67): click it, press F2 or run "Rename thread" to
// edit it; Enter keeps the new title and Escape the old one.
export function ThreadTitle({ thread }: { thread: Thread }) {
  const renaming = useStore(threadListStore, (state) => state.renaming === thread.id);
  const send = useDispatch();
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setText(thread.title);
    input.current?.focus();
    input.current?.select();
    // Only when editing starts; a title arriving meanwhile must not replace what is typed.
  }, [renaming]);

  const save = () => {
    stop();
    const title = text.trim();
    if (title === '' || title === thread.title) return;
    void send({ type: 'thread.rename', threadId: thread.id, title }).catch((error: unknown) =>
      notify.error(errorMessage(error)),
    );
  };

  if (renaming) {
    return (
      <Input
        ref={input}
        aria-label="Thread title"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            stop();
          }
        }}
        className="h-7 min-w-0 max-w-96 flex-1 text-sm font-medium"
      />
    );
  }
  return (
    <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
      <button
        type="button"
        title="Rename thread"
        onClick={() => startRename(thread.id)}
        className="min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {threadTitle(thread)}
      </button>
      {isArchived(thread) && (
        <span
          data-testid="thread-archived"
          className="shrink-0 text-xs font-normal text-muted-foreground"
        >
          Archived
        </span>
      )}
    </h2>
  );
}
