import { AssistantNote } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { BrainIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDateFormat } from '@/lib/format';

// Settings → Assistant → Memory (chief of staff spec 30): the notes the assistant keeps, with
// who wrote each, when, and until when it applies. Adding, editing and removing write the whole
// list as the `assistant.notes` setting, like any setting.

const notesOf = (value: unknown): AssistantNote[] => {
  const parsed = AssistantNote.array().safeParse(value);
  return parsed.success ? parsed.data : [];
};

function NoteRow({
  note,
  onSave,
  onRemove,
}: {
  readonly note: AssistantNote;
  readonly onSave: (text: string) => void;
  readonly onRemove: () => void;
}) {
  const { when } = useDateFormat();
  const [draft, setDraft] = useState(note.text);
  const changed = draft.trim() !== note.text && draft.trim() !== '';
  return (
    <li data-testid="assistant-note" className="flex items-center gap-3 px-3 py-2 text-xs">
      <Input
        aria-label="Note"
        className="h-7 min-w-0 flex-1 text-xs"
        value={draft}
        maxLength={500}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && changed) onSave(draft.trim());
          if (event.key === 'Escape') setDraft(note.text);
        }}
      />
      <span className="shrink-0 text-muted-foreground">
        {note.by === 'assistant' ? 'Kept by the assistant' : 'Added by you'} {when(note.addedAt)}
        {note.until ? ` · until ${note.until}` : ''}
      </span>
      {changed && (
        <Button size="xs" onClick={() => onSave(draft.trim())}>
          Save
        </Button>
      )}
      <Button size="xs" variant="outline" aria-label="Remove the note" onClick={onRemove}>
        <Trash2Icon aria-hidden />
        Remove
      </Button>
    </li>
  );
}

export function MemorySection() {
  const { connection } = useRuntime();
  const notes = notesOf(useSetting('assistant.notes'));
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string>();
  const write = async (next: AssistantNote[]) => {
    if (!connection) return;
    setError(undefined);
    try {
      await dispatch(
        connection,
        next.length === 0
          ? { type: 'setting.reset', key: 'assistant.notes', scope: 'global' }
          : { type: 'setting.set', key: 'assistant.notes', scope: 'global', value: next },
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const add = () => {
    const text = adding.trim();
    if (text === '') return;
    void write([
      ...notes,
      { id: crypto.randomUUID(), text, addedAt: new Date().toISOString(), by: 'you' },
    ]).then(() => setAdding(''));
  };
  return (
    <section aria-label="Memory" className="mt-3 flex flex-col gap-2" data-testid="memory-section">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Memory</h3>
        <p className="text-xs text-muted-foreground">
          What the assistant keeps about how you work. It reads these at the start of every answer.
        </p>
      </div>
      {notes.length === 0 ? (
        <EmptyState compact icon={BrainIcon} title="No notes">
          Tell the assistant how you like to work, or add a note here.
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onSave={(text) =>
                void write(
                  notes.map((entry) => (entry.id === note.id ? { ...entry, text } : entry)),
                )
              }
              onRemove={() => void write(notes.filter((entry) => entry.id !== note.id))}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="New note"
          placeholder="Never plan anything before nine"
          className="h-8 text-xs"
          value={adding}
          maxLength={500}
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <Button size="sm" variant="outline" onClick={add} disabled={adding.trim() === ''}>
          <PlusIcon aria-hidden />
          Add note
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
