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
  RotateCcwIcon,
  ShieldQuestionIcon,
  WrenchIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CodeBlock } from '@/components/code-block';
import { WithTooltip } from '@/components/hint';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorMessage, useDispatch } from './data';
import {
  QuestionCard,
  type CardQuestion,
  type QuestionHold,
  type QuestionStatus,
} from './question-card';
import { formatCost, formatTokens } from './model';
import { SentSkillChip } from './skill-chip';
import { failedToolCalls, formatElapsed } from './view-model';

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
  // The Assistant view's secret check, for a lone question drawn as an item.
  readonly questionHold?: QuestionHold | undefined;
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
  // The answer to the assistant's questions shows on their card; here only that it was sent.
  if (payload.answers) {
    return (
      <p data-testid="answered-note" className="text-right text-xs text-muted-foreground">
        Answered the questions above.
      </p>
    );
  }
  // The skills it was sent with are chips; a message stored before them shows its text as it was
  // (wow skills spec 14, 18).
  const skills = payload.skills ?? [];
  return (
    <div className="group flex flex-col items-end gap-0.5">
      {skills.length > 0 && (
        <div
          role="list"
          aria-label="Sent with skills"
          className="flex max-w-[85%] flex-wrap justify-end gap-1"
        >
          {skills.map((skill, index) => (
            <span role="listitem" key={`${skill.source}:${skill.name}:${index}`}>
              <SentSkillChip skill={skill} />
            </span>
          ))}
        </div>
      )}
      {payload.text.trim() !== '' && (
        <div className="w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
          {payload.text}
        </div>
      )}
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

// Assistant text through the shared markdown renderer. While it streams, an unfinished table or
// fence stays plain text until it is complete.
function AssistantText({ payload, streaming }: { payload: TextItemPayload; streaming: boolean }) {
  return (
    <div aria-busy={streaming}>
      <Markdown text={payload.text} streaming={streaming} />
      {streaming && (
        <span aria-hidden className="mt-1 block h-3.5 w-1.5 animate-pulse bg-foreground/60" />
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

function toolCallStatus(payload: ToolCallItemPayload, context: ItemContext) {
  return payload.status === 'running' && context.awaitingApproval
    ? { label: 'waiting for approval', className: 'text-state-needs-you' }
    : payload.status === 'running' && context.turnEnded
      ? { label: 'not finished', className: 'text-muted-foreground' }
      : toolStatus[payload.status];
}

// The line a tool call is drawn as: its name, the first text of its input and its status.
function ToolCallLine({
  payload,
  context,
  extra,
}: {
  payload: ToolCallItemPayload;
  context: ItemContext;
  extra?: ReactNode;
}) {
  const status = toolCallStatus(payload, context);
  const summary = inputSummary(payload.input);
  return (
    <>
      <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono font-medium">{payload.name}</span>
      {summary !== '' && (
        <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {extra}
        <span className={status.className}>{status.label}</span>
      </span>
    </>
  );
}

function ToolCall({ payload, context }: { payload: ToolCallItemPayload; context: ItemContext }) {
  // Input and output render only while open, so long outputs cost nothing when collapsed.
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-md border border-border text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <ToolCallLine payload={payload} context={context} />
      </summary>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          <section aria-label="Tool input">
            <h4 className="mb-1 text-2xs text-muted-foreground">Input</h4>
            <CodeBlock
              code={JSON.stringify(payload.input, null, 2)}
              language="json"
              className="max-h-64 text-2xs"
            />
          </section>
          <section aria-label="Tool output">
            <h4 className="mb-1 text-2xs text-muted-foreground">Output</h4>
            {payload.output === '' ? (
              <p className="text-2xs text-muted-foreground">No output.</p>
            ) : (
              <CodeBlock code={payload.output} className="max-h-96 text-2xs" />
            )}
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

// An agent's questions in a chat thread or a step: one card for the questions of one ask
// (questions spec 3, 6). A question whose turn ended without an answer is closed (spec 5).
export function ChatQuestions({
  items,
  questions,
  turnEnded,
  hold,
}: {
  items: readonly ThreadItem[];
  questions: readonly Question[];
  turnEnded: boolean;
  hold?: QuestionHold | undefined;
}) {
  const send = useDispatch();
  const asked = items.flatMap((item) => {
    const parsed = QuestionItemPayload.safeParse(item.payload);
    return parsed.success ? [{ item, payload: parsed.data }] : [];
  });
  const first = asked[0];
  if (!first) return null;
  const cardQuestions: CardQuestion[] = asked.map(({ payload }) => {
    const row = questions.find((entry) => entry.id === payload.questionId);
    const status: QuestionStatus =
      row && row.answer !== null
        ? { kind: 'answered', reply: payload.reply ?? row.answer }
        : row && !turnEnded
          ? { kind: 'open' }
          : { kind: 'closed' };
    return {
      key: payload.questionId,
      question: payload.question,
      header: payload.header,
      options: payload.options,
      multiSelect: payload.multiSelect,
      status,
    };
  });
  return (
    <QuestionCard
      id={first.item.id}
      questions={cardQuestions}
      closedReason="the turn ended before an answer was sent."
      onSend={(replies) =>
        send({
          type: 'question.answer',
          answers: [...replies].map(([questionId, reply]) => ({ questionId, reply })),
        })
      }
      {...(hold ? { check: hold.check, renderHold: hold.render } : {})}
    />
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
      return (
        <ChatQuestions
          items={[item]}
          questions={questions}
          turnEnded={context.turnEnded}
          hold={context.questionHold}
        />
      );
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

// A run of tool calls as one row (`chat.groupToolCalls`): the latest call as a single row draws
// it, how many there are, and how many failed, so a failure shows without opening the row. Open,
// it lists every call, each opening to its input and output. The open state is this window's.
export function ToolCallGroup({
  items,
  contextOf,
}: {
  items: readonly ThreadItem[];
  contextOf: (item: ThreadItem) => ItemContext;
}) {
  const [open, setOpen] = useState(false);
  const first = items[0];
  const latest = items.at(-1);
  if (first === undefined || latest === undefined) return null;
  const parsed = ToolCallItemPayload.safeParse(latest.payload);
  const failed = failedToolCalls(items);
  const extra = (
    <>
      <span data-testid="tool-group-count" className="text-muted-foreground">
        {items.length} tool calls
      </span>
      {failed > 0 && (
        <span data-testid="tool-group-failed" className="text-state-failed">
          {failed} failed
        </span>
      )}
    </>
  );
  return (
    <li
      data-testid="item-tool_group"
      data-item-id={first.id}
      data-failed={failed > 0 || undefined}
      className="[contain-intrinsic-size:auto_2.5rem] [content-visibility:auto]"
    >
      <details
        className={cn(
          'group/tools rounded-md border text-xs',
          failed > 0 ? 'border-state-failed/50' : 'border-border',
        )}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/tools:rotate-90" />
          {parsed.success ? (
            <ToolCallLine payload={parsed.data} context={contextOf(latest)} extra={extra} />
          ) : (
            <span className="ml-auto">{extra}</span>
          )}
        </summary>
        {open && (
          <ol aria-label="Tool calls" className="flex flex-col gap-1 border-t border-border p-2">
            {items.map((item) => (
              <ConversationItem
                key={item.id}
                item={item}
                approvals={[]}
                questions={[]}
                context={contextOf(item)}
              />
            ))}
          </ol>
        )}
      </details>
    </li>
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
