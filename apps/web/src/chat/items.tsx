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
  type BackgroundTask,
  type Question,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import {
  BrainIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  HourglassIcon,
  RotateCcwIcon,
  ShieldQuestionIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyButton } from '@/components/copy-button';
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
import { TaskList, TaskMarker } from './task-pin';
import { ToolCall } from './tools/index';
import { useNow } from './tools/time';
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
  // The Assistant view's secret check, for a lone question drawn as an item.
  readonly questionHold?: QuestionHold | undefined;
  // How many last lines of a tool's output an opened row shows (`chat.toolOutputLines`).
  readonly outputLines?: number | undefined;
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
// Copy puts the markdown on the clipboard, Copy text what the message reads as on screen (spec
// 32); both show on hover or focus once the message is complete.
function AssistantText({ payload, streaming }: { payload: TextItemPayload; streaming: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  return (
    <div aria-busy={streaming} className="group/message relative">
      <div ref={body}>
        <Markdown text={payload.text} streaming={streaming} />
      </div>
      {streaming ? (
        <span aria-hidden className="mt-1 block h-3.5 w-1.5 animate-pulse bg-foreground/60" />
      ) : (
        <div
          data-testid="message-copy"
          className="mt-0.5 flex gap-0.5 text-muted-foreground opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100"
        >
          <CopyButton text={payload.text} label="Copy" />
          <CopyButton
            text={() => {
              const element = body.current;
              if (!element) return payload.text;
              // jsdom has no innerText; a browser's keeps the line breaks the reader sees.
              return (element.innerText ?? element.textContent ?? '').trim();
            }}
            label="Copy text"
          />
        </div>
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
      // An update since the agent workbench is a one-line marker; a turn's only list from
      // before is drawn in full, as it was (spec 31, 48).
      return parsed.success ? (
        parsed.data.at === undefined ? (
          <TaskList tasks={parsed.data.tasks} turnEnded={context.turnEnded} />
        ) : (
          <TaskMarker payload={parsed.data} turnEnded={context.turnEnded} />
        )
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

// "Working · 0:42": how long the running turn has taken, from the turn's own start time.
// Between turns: the agent's background work still runs, and it goes on by itself when it ends.
export function BackgroundIndicator({ tasks }: { tasks: readonly BackgroundTask[] }) {
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
      data-testid="background-work"
    >
      <HourglassIcon className="size-3.5 shrink-0" aria-hidden />
      <span>
        Waiting for background work: {tasks.map((task) => task.description || task.id).join(', ')}
      </span>
    </p>
  );
}

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

// The muted end of a turn the user stopped: "Stopped by you · 20:41", with Resume on the last
// one (spec 89).
export function StoppedLine({
  turn,
  formatAt,
  resume,
}: {
  turn: Turn;
  formatAt: (iso: string) => string;
  resume?: { readonly onResume: () => void; readonly prompt: string } | undefined;
}) {
  return (
    <p data-testid="turn-stopped" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        Stopped by you
        {turn.endedAt && (
          <>
            {' · '}
            <time dateTime={turn.endedAt}>{formatAt(turn.endedAt)}</time>
          </>
        )}
      </span>
      {resume && (
        <WithTooltip label={`Sends: ${resume.prompt}`}>
          <Button size="xs" variant="outline" onClick={resume.onResume}>
            <RotateCcwIcon />
            Resume
          </Button>
        </WithTooltip>
      )}
    </p>
  );
}
