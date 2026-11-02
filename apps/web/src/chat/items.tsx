import {
  ApprovalItemPayload,
  ErrorItemPayload,
  QuestionItemPayload,
  TaskListItemPayload,
  TextItemPayload,
  ToolCallItemPayload,
  UsageItemPayload,
  type Approval,
  type ApprovalDecision,
  type Question,
  type ThreadItem,
} from '@wow/contracts';
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  HelpCircleIcon,
  RotateCcwIcon,
  ShieldQuestionIcon,
  WrenchIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WithTooltip } from '@/components/hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { errorMessage, useDispatch } from './data';
import { formatCost, formatTokens } from './model';
import { formatElapsed } from './view-model';

// What a row needs to know about the thread and the turn around it.
export interface ItemContext {
  readonly cwd: string;
  readonly permissionLabel: string;
  // The turn of this item has ended (completed, failed or stopped).
  readonly turnEnded: boolean;
  // When the item's turn started, for the time shown on hover.
  readonly at: string | undefined;
  // A request in this thread waits for an approval, so a running tool waits for it too.
  readonly awaitingApproval: boolean;
  // Present on the last error of a thread that can be retried or resumed.
  readonly recovery?:
    | {
        readonly onRetry?: () => void;
        readonly onResume: () => void;
        readonly resumePrompt: string;
      }
    | undefined;
  readonly formatAt: (iso: string) => string;
}

// One row per thread item. Rows skip layout and paint while off screen, so a long conversation
// with large tool outputs stays responsive without a virtual list.
function Row({ item, children }: { item: ThreadItem; children: ReactNode }) {
  return (
    <li
      data-testid={`item-${item.kind}`}
      data-item-id={item.id}
      className="[contain-intrinsic-size:auto_2.5rem] [content-visibility:auto]"
    >
      {children}
    </li>
  );
}

function Unreadable({ item }: { item: ThreadItem }) {
  return <p className="text-xs text-muted-foreground">Unreadable {item.kind} item.</p>;
}

function UserMessage({ payload, context }: { payload: TextItemPayload; context: ItemContext }) {
  return (
    <div className="group flex flex-col items-end gap-0.5">
      <div className="w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
        {payload.text}
      </div>
      {context.at && (
        <time
          dateTime={context.at}
          className="text-2xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {context.formatAt(context.at)}
        </time>
      )}
    </div>
  );
}

function AssistantText({ payload, streaming }: { payload: TextItemPayload; streaming: boolean }) {
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap" aria-busy={streaming}>
      {payload.text}
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/60 align-middle"
        />
      )}
    </div>
  );
}

// Collapsed by default (the reasoning is there when wanted, not in the way).
function Reasoning({ payload, streaming }: { payload: TextItemPayload; streaming: boolean }) {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
        <BrainIcon className="size-3.5" />
        {streaming ? 'Thinking…' : 'Reasoning'}
      </summary>
      <div className="mt-1 border-l border-border pl-3 whitespace-pre-wrap">{payload.text}</div>
    </details>
  );
}

function inputSummary(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const first = Object.values(input).find((value) => typeof value === 'string');
  return typeof first === 'string' ? first : '';
}

const toolStatus = {
  running: { label: 'running', className: 'text-state-working' },
  ok: { label: 'done', className: 'text-muted-foreground' },
  error: { label: 'error', className: 'text-state-failed' },
} as const;

function ToolCall({ payload, context }: { payload: ToolCallItemPayload; context: ItemContext }) {
  // Input and output render only while open, so long outputs cost nothing when collapsed.
  const [open, setOpen] = useState(false);
  const status =
    payload.status === 'running' && context.awaitingApproval
      ? { label: 'waiting for approval', className: 'text-state-needs-you' }
      : payload.status === 'running' && context.turnEnded
        ? { label: 'not finished', className: 'text-muted-foreground' }
        : toolStatus[payload.status];
  const summary = inputSummary(payload.input);
  return (
    <details
      className="group rounded-md border border-border text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium">{payload.name}</span>
        {summary !== '' && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
        )}
        <span className={cn('ml-auto shrink-0', status.className)}>{status.label}</span>
      </summary>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          <section aria-label="Tool input">
            <h4 className="mb-1 text-2xs text-muted-foreground">Input</h4>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
              {JSON.stringify(payload.input, null, 2)}
            </pre>
          </section>
          <section aria-label="Tool output">
            <h4 className="mb-1 text-2xs text-muted-foreground">Output</h4>
            <pre className="max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
              {payload.output === '' ? '(no output)' : payload.output}
            </pre>
          </section>
        </div>
      )}
    </details>
  );
}

const decisionLabels: Readonly<Record<ApprovalDecision, string>> = {
  allowOnce: 'Allowed once',
  allowSession: 'Allowed for this session',
  deny: 'Denied',
};

const approvalKindLabels = { command: 'Command', fileChange: 'File change', tool: 'Tool' } as const;

function approvalDetails(approval: Approval | undefined): unknown {
  const request = approval?.request;
  if (typeof request !== 'object' || request === null || !('details' in request)) return null;
  return request.details;
}

// The folder the request runs in: the provider's own report when it sends one, else the thread's.
function requestFolder(details: unknown, fallback: string): string {
  if (typeof details === 'object' && details !== null && 'cwd' in details) {
    const cwd = (details as { cwd: unknown }).cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return fallback;
}

function ApprovalRow({
  payload,
  approval,
  context,
}: {
  payload: ApprovalItemPayload;
  approval: Approval | undefined;
  context: ItemContext;
}) {
  const send = useDispatch();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const decision = approval?.decision ?? null;
  const details = approvalDetails(approval);
  const pending = decision === null && approval !== undefined;
  // A new request takes the focus, so its keys (A, S, D) work at once (audit A-11).
  useEffect(() => {
    if (pending) section.current?.focus();
  }, [pending]);
  const answer = (choice: ApprovalDecision) => {
    setBusy(true);
    setError(undefined);
    send({ type: 'approval.answer', approvalId: payload.approvalId, decision: choice }).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Approval request"
      data-pending={pending || undefined}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        decision === null ? 'border-state-needs-you/60' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldQuestionIcon className="size-4 shrink-0 text-state-needs-you" />
        <Badge variant="outline">{approvalKindLabels[payload.kind]}</Badge>
        <span className="min-w-0 font-mono text-xs break-all">{payload.summary}</span>
      </div>
      <p data-testid="approval-context" className="text-xs text-muted-foreground">
        In <span className="font-mono">{requestFolder(details, context.cwd)}</span> ·{' '}
        {context.permissionLabel}
      </p>
      {details !== null && details !== undefined && (
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Details
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
            {JSON.stringify(details, null, 2)}
          </pre>
        </details>
      )}
      {decision === null ? (
        <div className="flex flex-wrap gap-2">
          <WithTooltip label="Allow once" shortcut="keybindings.approvalAllowOnce">
            <Button size="sm" disabled={busy || !approval} onClick={() => answer('allowOnce')}>
              Allow once
            </Button>
          </WithTooltip>
          <WithTooltip label="Allow for this session" shortcut="keybindings.approvalAllowSession">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !approval}
              onClick={() => answer('allowSession')}
            >
              Allow for this session
            </Button>
          </WithTooltip>
          <WithTooltip label="Deny" shortcut="keybindings.approvalDeny">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !approval}
              onClick={() => answer('deny')}
            >
              Deny
            </Button>
          </WithTooltip>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{decisionLabels[decision]}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function QuestionRow({
  payload,
  question,
}: {
  payload: QuestionItemPayload;
  question: Question | undefined;
}) {
  const send = useDispatch();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const answered = question?.answer ?? null;
  const submit = (answer: string) => {
    if (answer.trim() === '') return;
    setBusy(true);
    setError(undefined);
    send({ type: 'question.answer', questionId: payload.questionId, answer }).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };
  const disabled = busy || !question;
  return (
    <section
      aria-label="Question"
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm',
        answered === null ? 'border-state-needs-you/60' : 'border-border',
      )}
    >
      <div className="flex items-start gap-2">
        <HelpCircleIcon className="mt-0.5 size-4 shrink-0 text-state-needs-you" />
        <p className="font-medium">{payload.question}</p>
      </div>
      {answered !== null ? (
        <p className="text-xs text-muted-foreground">Answered: {answered}</p>
      ) : (
        <>
          {payload.multiSelect ? (
            <div role="group" aria-label="Options" className="flex flex-col gap-1.5">
              {payload.options.map((option) => (
                <label key={option.label} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={chosen.includes(option.label)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      setChosen((current) =>
                        checked === true
                          ? [...current, option.label]
                          : current.filter((label) => label !== option.label),
                      )
                    }
                  />
                  <span>
                    {option.label}
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <Button
                size="sm"
                className="w-fit"
                disabled={disabled || chosen.length === 0}
                onClick={() => submit(chosen.join(', '))}
              >
                Answer
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {payload.options.map((option) => (
                <Button
                  key={option.label}
                  size="sm"
                  variant="outline"
                  title={option.description}
                  disabled={disabled}
                  onClick={() => submit(option.label)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit(text);
            }}
          >
            <Input
              aria-label="Your answer"
              placeholder="Or type an answer"
              value={text}
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
              className="h-8 text-sm"
            />
            <Button size="sm" type="submit" variant="secondary" disabled={disabled || !text.trim()}>
              Send
            </Button>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

const taskIcons = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckIcon,
} as const;

function TaskList({ payload, context }: { payload: TaskListItemPayload; context: ItemContext }) {
  return (
    <section aria-label="Tasks" className="rounded-md border border-border p-2 text-xs">
      <h4 className="mb-1 px-1 text-2xs font-medium text-muted-foreground">Tasks</h4>
      <ul className="flex flex-col gap-0.5">
        {payload.tasks.map((task) => {
          // A turn that ended leaves unfinished tasks unfinished; they no longer show as running.
          const unfinished = context.turnEnded && task.status !== 'completed';
          const Icon = unfinished ? CircleIcon : taskIcons[task.status];
          return (
            <li
              key={task.id}
              data-status={task.status}
              className={cn(
                'flex items-start gap-2 px-1',
                task.status === 'completed' && 'text-muted-foreground line-through',
              )}
            >
              <Icon
                aria-label={unfinished ? 'not finished' : task.status.replace('_', ' ')}
                className={cn(
                  'mt-0.5 size-3.5 shrink-0',
                  task.status === 'in_progress' && !unfinished && 'text-state-working',
                )}
              />
              <span className="min-w-0 flex-1">{task.content}</span>
              {unfinished && (
                <span className="shrink-0 text-2xs text-muted-foreground">not finished</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function UsageRow({ payload }: { payload: UsageItemPayload }) {
  if (payload.inputTokens === undefined && payload.outputTokens === undefined) return null;
  const parts = [
    `${formatTokens(payload.inputTokens ?? 0)} in`,
    `${formatTokens(payload.outputTokens ?? 0)} out`,
    `${formatTokens(payload.cachedInputTokens ?? 0)} cached`,
    ...(payload.costUsd === undefined ? [] : [formatCost(payload.costUsd)]),
  ];
  return (
    <p aria-label="Turn usage" className="text-2xs text-muted-foreground tabular-nums">
      {parts.join(' · ')}
    </p>
  );
}

function ErrorRow({ payload, context }: { payload: ErrorItemPayload; context: ItemContext }) {
  const { recovery } = context;
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md border border-state-failed/50 p-2 text-xs">
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-state-failed" />
      <p role="alert" className="min-w-0 flex-1 text-state-failed">
        {payload.message}
        {context.at && (
          <time dateTime={context.at} className="ml-2 text-muted-foreground">
            {context.formatAt(context.at)}
          </time>
        )}
      </p>
      {recovery && (
        <div className="flex shrink-0 items-center gap-1.5">
          {recovery.onRetry && (
            <WithTooltip label="Send your last message again">
              <Button size="xs" variant="outline" onClick={recovery.onRetry}>
                <RotateCcwIcon />
                Retry
              </Button>
            </WithTooltip>
          )}
          <WithTooltip label={`Sends: ${recovery.resumePrompt}`}>
            <Button size="xs" variant="ghost" onClick={recovery.onResume}>
              Resume
            </Button>
          </WithTooltip>
        </div>
      )}
    </div>
  );
}

function ItemBody({
  item,
  approvals,
  questions,
  context,
}: {
  item: ThreadItem;
  approvals: readonly Approval[];
  questions: readonly Question[];
  context: ItemContext;
}) {
  switch (item.kind) {
    case 'user': {
      const parsed = TextItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <UserMessage payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'assistant_text': {
      const parsed = TextItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <AssistantText payload={parsed.data} streaming={item.streaming} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'reasoning': {
      const parsed = TextItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <Reasoning payload={parsed.data} streaming={item.streaming} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'tool_call': {
      const parsed = ToolCallItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <ToolCall payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'approval': {
      const parsed = ApprovalItemPayload.safeParse(item.payload);
      if (!parsed.success) return <Unreadable item={item} />;
      const approval = approvals.find((row) => row.id === parsed.data.approvalId);
      return <ApprovalRow payload={parsed.data} approval={approval} context={context} />;
    }
    case 'question': {
      const parsed = QuestionItemPayload.safeParse(item.payload);
      if (!parsed.success) return <Unreadable item={item} />;
      const question = questions.find((row) => row.id === parsed.data.questionId);
      return <QuestionRow payload={parsed.data} question={question} />;
    }
    case 'task_list': {
      const parsed = TaskListItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <TaskList payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'usage': {
      const parsed = UsageItemPayload.safeParse(item.payload);
      return parsed.success ? <UsageRow payload={parsed.data} /> : <Unreadable item={item} />;
    }
    case 'error': {
      const parsed = ErrorItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <ErrorRow payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
  }
}

export function ConversationItem(props: {
  item: ThreadItem;
  approvals: readonly Approval[];
  questions: readonly Question[];
  context: ItemContext;
}) {
  return (
    <Row item={props.item}>
      <ItemBody {...props} />
    </Row>
  );
}

// One redraw a second while a turn runs, for its clock.
const second = 1000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), second);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// "Working · 0:42": how long the running turn has taken, from the turn's own start time.
export function WorkingIndicator({ startedAt }: { startedAt: string | undefined }) {
  const now = useNow(startedAt !== undefined);
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <CircleDashedIcon className="size-3.5 animate-spin" />
      <span>
        Working
        {startedAt && (
          <span data-testid="turn-elapsed" className="tabular-nums" aria-hidden>
            {' '}
            · {formatElapsed(now - new Date(startedAt).getTime())}
          </span>
        )}
      </span>
    </p>
  );
}
