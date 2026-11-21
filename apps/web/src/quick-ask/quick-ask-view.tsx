import { TextItemPayload, assistantThreadId } from '@wow/contracts';
import { SparklesIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

// The quick ask (chief of staff spec 31): the small window the global key opens over any other.
// Enter sends the text to the assistant's conversation and the answer shows as it streams;
// Escape hides the window; "Open in wow" shows the conversation in the main window.

function hide(): void {
  const bridge = window.wowDesktop?.hideQuickAsk;
  if (bridge) void bridge();
  else window.close();
}

export function QuickAskView() {
  const send = useDispatch();
  const navigate = useNavigate();
  const items = useTopic('threadItems', assistantThreadId);
  const [text, setText] = useState('');
  const [sentAfter, setSentAfter] = useState<number>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);

  // The agent's text that came after the message sent from here, as it streams.
  const answer =
    sentAfter === undefined
      ? undefined
      : (items ?? [])
          .filter((item) => item.kind === 'assistant_text' && item.index > sentAfter)
          .map((item) => TextItemPayload.safeParse(item.payload))
          .flatMap((parsed) => (parsed.success ? [parsed.data.text] : []))
          .join('\n\n');

  const submit = () => {
    const message = text.trim();
    if (message === '') return;
    setError(undefined);
    setSentAfter(Math.max(-1, ...(items ?? []).map((item) => item.index)));
    send({ type: 'thread.sendMessage', threadId: assistantThreadId, text: message })
      .then(() => setText(''))
      .catch((caught: unknown) => {
        setSentAfter(undefined);
        setError(`${errorMessage(caught)} Open the Assistant in wow once to set it up.`);
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const openInWow = () => {
    const bridge = window.wowDesktop?.openInMain;
    if (bridge) void bridge('/assistant');
    else void navigate({ to: '/assistant' });
  };
  return (
    <main
      aria-label="Ask the assistant"
      className="flex h-screen flex-col gap-2 bg-background p-3 text-foreground"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <SparklesIcon aria-hidden className="size-4 text-muted-foreground" />
        Ask the assistant
        <Button size="xs" variant="ghost" className="ml-auto" onClick={openInWow}>
          Open in wow
        </Button>
      </div>
      <Textarea
        ref={box}
        aria-label="Message to the assistant"
        placeholder="Plan the triage after lunch, or ask what waits for you"
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {answer !== undefined && (
        <div
          data-testid="quick-ask-answer"
          className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm"
        >
          {answer === '' ? (
            <span className="text-muted-foreground italic">The assistant is answering…</span>
          ) : (
            answer
          )}
        </div>
      )}
      <p className="text-2xs text-muted-foreground">Enter sends · Escape hides</p>
    </main>
  );
}
