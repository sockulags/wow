import {
  cardOrder,
  isEmptyReply,
  shownLabel,
  type QuestionOption,
  type QuestionReply,
} from '@wow/contracts';
import { CheckIcon, HelpCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { errorMessage } from './data';
import { showQuestionCard } from './question-store';

// The question card (questions spec 1 to 5): every question in wow, from a provider's agent or
// from the assistant, is drawn here. Each question has its choices and always a last choice
// "Other" that takes typed text; the questions of one ask are answered together. The card only
// shows what the server says about each question; it keeps the picks and the text until sent.

export type QuestionStatus =
  | { readonly kind: 'open' }
  // A question answered before the card has only the text that was sent.
  | { readonly kind: 'answered'; readonly reply: QuestionReply | string }
  | { readonly kind: 'closed' };

export interface CardQuestion {
  readonly key: string;
  readonly question: string;
  readonly header?: string | undefined;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly status: QuestionStatus;
}

// What a check before sending gets to work with while it holds the answer (the Assistant's
// secret check, spec 10).
export interface HoldControls {
  sendAnyway(): void;
  // Changes every typed text, for taking a secret out after it went to its field.
  replaceText(change: (text: string) => string): void;
  dismiss(): void;
}

// A check that holds typed answers before they are sent, and what the card shows while it holds
// them; the Assistant view gives one to every card in its conversation.
export interface QuestionHold<H = unknown> {
  check(replies: ReadonlyMap<string, QuestionReply>): H | null;
  render(held: H, controls: HoldControls): ReactNode;
}

export interface QuestionCardProps<H> {
  readonly id: string;
  readonly questions: readonly CardQuestion[];
  // Why a question that is not answered can no longer be (its turn ended).
  readonly closedReason: string;
  // Why an open question cannot be sent yet, if it cannot.
  readonly waitReason?: string | undefined;
  onSend(replies: ReadonlyMap<string, QuestionReply>): Promise<unknown>;
  check?(replies: ReadonlyMap<string, QuestionReply>): H | null;
  renderHold?(held: H, controls: HoldControls): ReactNode;
}

interface Row {
  readonly question: number;
  // A choice's place in the card's order, or null for "Other".
  readonly choice: number | null;
}

const ordered = (question: CardQuestion) => cardOrder(question.options);

const answerLine = (reply: QuestionReply | string): string =>
  typeof reply === 'string'
    ? reply
    : [...reply.picked.map(shownLabel), reply.text.trim()].filter((part) => part !== '').join(', ');

// A provider may give one label twice; picks are kept by label, so the card shows it once.
const withDistinctLabels = (question: CardQuestion): CardQuestion => ({
  ...question,
  options: question.options.filter(
    (option, index, all) => all.findIndex((other) => other.label === option.label) === index,
  ),
});

export function QuestionCard<H>({
  id,
  questions: given,
  closedReason,
  waitReason,
  onSend,
  check,
  renderHold,
}: QuestionCardProps<H>) {
  const questions = given.map(withDistinctLabels);
  const open = questions.filter((question) => question.status.kind === 'open');
  const rows: Row[] = open.flatMap((question, index) => [
    ...ordered(question).map((_, choice): Row => ({ question: index, choice })),
    { question: index, choice: null },
  ]);
  const [picks, setPicks] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [texts, setTexts] = useState<Readonly<Record<string, string>>>({});
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [held, setHeld] = useState<{ readonly hold: H } | undefined>();
  const elements = useRef<(HTMLElement | null)[]>([]);

  const replyOf = (question: CardQuestion): QuestionReply => ({
    // In the order the asker gave them, which the provider expects.
    picked: question.options
      .map((option) => option.label)
      .filter((label) => picks[question.key]?.includes(label)),
    text: texts[question.key] ?? '',
  });
  const replies = new Map(open.map((question) => [question.key, replyOf(question)]));
  const empty = [...replies.values()].some(isEmptyReply);

  const focusRow = (index: number) => {
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    setActive(bounded);
    elements.current[bounded]?.focus();
  };
  const otherRow = (question: number) =>
    rows.findIndex((row) => row.question === question && row.choice === null);

  const toggle = (question: number, choice: number) => {
    const asked = open[question];
    const label = asked && ordered(asked)[choice]?.label;
    if (!asked || label === undefined) return;
    setError(undefined);
    setPicks((current) => {
      const now = current[asked.key] ?? [];
      const next = now.includes(label)
        ? now.filter((entry) => entry !== label)
        : asked.multiSelect
          ? [...now, label]
          : [label];
      return { ...current, [asked.key]: next };
    });
  };

  const deliver = () => {
    setBusy(true);
    setError(undefined);
    setHeld(undefined);
    onSend(replies).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };

  const send = () => {
    if (busy) return;
    if (waitReason) {
      setError(waitReason);
      return;
    }
    if (empty) {
      setError(
        open.length > 1
          ? 'Answer every question: pick a choice or type an answer.'
          : 'Pick a choice or type an answer.',
      );
      return;
    }
    const hold = check?.(replies) ?? null;
    if (hold !== null) {
      setHeld({ hold });
      return;
    }
    deliver();
  };

  // The palette and the keybinding reach the newest open card through the store; the functions
  // read the card's latest state at call time.
  const latest = useRef({ toggle, send, focusRow, otherRow, active });
  latest.current = { toggle, send, focusRow, otherRow, active };
  const openSignature = open
    .map((question) => `${question.key}:${question.options.map((o) => o.label).join('|')}`)
    .join(',');
  useEffect(() => {
    if (openSignature === '') return undefined;
    return showQuestionCard({
      id,
      questions: open.map((question) => ({
        header: question.header,
        question: question.question,
        labels: ordered(question).map((option) => shownLabel(option.label)),
      })),
      pick: (question, choice) => latest.current.toggle(question, choice),
      write: (question) => latest.current.focusRow(latest.current.otherRow(question)),
      send: () => latest.current.send(),
      focus: () => latest.current.focusRow(latest.current.active),
    });
    // `open` is described by its signature; a new array each render is not a change.
  }, [id, openSignature]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const inText = event.target instanceof HTMLInputElement;
    const row = rows[active];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(active + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    // A focused button (Send, a hold's choices) keeps its own keys.
    if (event.target instanceof HTMLButtonElement) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    if (inText || !row) return;
    if (event.key === ' ') {
      event.preventDefault();
      if (row.choice !== null) toggle(row.question, row.choice);
      return;
    }
    const asked = open[row.question];
    if (/^[1-9]$/.test(event.key) && asked) {
      event.preventDefault();
      const choice = Number(event.key) - 1;
      const count = ordered(asked).length;
      if (choice < count) {
        toggle(row.question, choice);
        setActive(
          rows.findIndex((entry) => entry.question === row.question && entry.choice === choice),
        );
      } else if (choice === count) {
        focusRow(otherRow(row.question));
      }
      return;
    }
    // Typing goes to "Other" of the question the keyboard is on.
    if (event.key.length === 1 && asked) {
      event.preventDefault();
      setTexts((current) => ({
        ...current,
        [asked.key]: `${current[asked.key] ?? ''}${event.key}`,
      }));
      focusRow(otherRow(row.question));
    }
  };

  const controls: HoldControls = {
    sendAnyway: deliver,
    replaceText: (change) =>
      setTexts((current) =>
        Object.fromEntries(Object.entries(current).map(([key, text]) => [key, change(text)])),
      ),
    dismiss: () => setHeld(undefined),
  };

  let rowIndex = 0;
  const state =
    open.length > 0
      ? 'open'
      : questions.some((q) => q.status.kind === 'answered')
        ? 'answered'
        : 'closed';
  return (
    <section
      aria-label={questions.length > 1 ? 'Questions' : 'Question'}
      data-testid="question-card"
      data-state={state}
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-col gap-3 rounded-md border p-3 text-sm',
        state === 'open' ? 'border-state-needs-you/60' : 'border-border',
      )}
    >
      {questions.map((question) => {
        const openIndex = open.indexOf(question);
        const choices = ordered(question);
        return (
          <div key={question.key} data-testid="question" className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <HelpCircleIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-state-needs-you-text"
              />
              <div className="flex min-w-0 flex-col gap-1">
                {question.header && (
                  <Badge variant="secondary" data-testid="question-header">
                    {question.header}
                  </Badge>
                )}
                <p className="font-medium">{question.question}</p>
              </div>
            </div>
            {question.status.kind === 'answered' && (
              <p data-testid="question-answer" className="text-xs text-muted-foreground">
                Answered: {answerLine(question.status.reply)}
              </p>
            )}
            {question.status.kind === 'closed' && (
              <>
                {choices.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Choices: {choices.map((option) => shownLabel(option.label)).join(', ')}
                  </p>
                )}
                <p data-testid="question-closed" className="text-xs text-muted-foreground">
                  Not answered: {closedReason}
                </p>
              </>
            )}
            {question.status.kind === 'open' && (
              <div
                role={question.multiSelect ? 'group' : 'radiogroup'}
                aria-label={question.question}
                className="flex flex-col gap-0.5"
              >
                {choices.map((option, choice) => {
                  const index = rowIndex++;
                  const picked = picks[question.key]?.includes(option.label) ?? false;
                  return (
                    <div
                      key={option.label}
                      ref={(element) => {
                        elements.current[index] = element;
                      }}
                      role={question.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={picked}
                      aria-disabled={busy || undefined}
                      tabIndex={index === active ? 0 : -1}
                      data-recommended={option.recommended || undefined}
                      onFocus={() => setActive(index)}
                      onClick={() => {
                        setActive(index);
                        toggle(openIndex, choice);
                      }}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
                        picked && 'bg-accent',
                      )}
                    >
                      <Kbd aria-hidden>{choice + 1}</Kbd>
                      <span
                        aria-hidden
                        className={cn(
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input',
                          question.multiSelect ? 'rounded-sm' : 'rounded-full',
                          picked && 'border-primary bg-primary text-primary-foreground',
                        )}
                      >
                        {picked && <CheckIcon className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {shownLabel(option.label)}
                          {option.recommended && (
                            <Badge variant="info" data-testid="question-recommended">
                              Recommended
                            </Badge>
                          )}
                        </span>
                        {option.description && (
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
                {(() => {
                  const index = rowIndex++;
                  return (
                    <label className="flex items-center gap-2 px-2 py-1">
                      <Kbd aria-hidden>{choices.length + 1}</Kbd>
                      <span className="shrink-0 text-sm">Other</span>
                      <Input
                        ref={(element) => {
                          elements.current[index] = element;
                        }}
                        aria-label="Other"
                        placeholder={
                          choices.length > 0 ? 'Type your own answer' : 'Type your answer'
                        }
                        value={texts[question.key] ?? ''}
                        disabled={busy}
                        tabIndex={index === active ? 0 : -1}
                        onFocus={() => setActive(index)}
                        onChange={(event) => {
                          setError(undefined);
                          setTexts((current) => ({
                            ...current,
                            [question.key]: event.target.value,
                          }));
                        }}
                        className="h-8 text-sm"
                      />
                    </label>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })}
      {open.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || empty || waitReason !== undefined} onClick={send}>
            {open.length > 1 ? 'Send answers' : 'Send answer'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {waitReason ?? 'Arrows or digits pick, typing goes to Other, Enter sends.'}
          </span>
        </div>
      )}
      {held && renderHold?.(held.hold, controls)}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
