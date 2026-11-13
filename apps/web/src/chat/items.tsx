import {
  ApprovalItemPayload,
  CompactionItemPayload,
  ErrorItemPayload,
  FilesRestoredItemPayload,
  ReasoningItemPayload,
  SettingsChangeItemPayload,
  QuestionItemPayload,
  TaskListItemPayload,
  TextItemPayload,
  ToolCallItemPayload,
  UsageItemPayload,
  type Approval,
  type Question,
  type QueuedMessage,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import {
  BrainIcon,
  ChevronRightIcon,
  FoldVerticalIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ClockIcon,
  GitForkIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatBinding } from '@/app/keybindings';
import { CopyButton, copyText } from '@/components/copy-button';
import { useRowActions } from '@/lib/row-actions';
import { WithTooltip } from '@/components/hint';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ApprovalCard } from './approval-card';
import { FilesRestoredLine } from './restore';
import { errorMessage, useDispatch } from './data';
import {
  QuestionCard,
  type CardQuestion,
  type QuestionHold,
  type QuestionStatus,
} from './question-card';
import { formatCost, formatTokens, shortTokens } from './model';
import { FileChip } from '@/panel/open-file-button';
import { withoutMentions } from './mentions';
import { SentImages } from './image-chip';
import { SentSkillChip } from './skill-chip';
import { openKey, useOpenState } from './open-state';
import { TaskList, TaskMarker } from './task-pin';
import { ToolCall } from './tools/index';
import { useNow } from './tools/time';
import { effortLabel, formatElapsed, type WorkingFacts } from './view-model';

export interface StopGoingBack {
  readonly title: string;
  readonly detail: string;
  readonly run: () => void;
}

// What a row needs to know about the thread and the turn around it.
export interface ItemContext {
  // The item the row draws, whose open state the conversation keeps; absent outside one.
  readonly itemId?: string | undefined;
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
        // A go-back the provider refused: stop going back (`thread.dropGoBack`).
        readonly goOn?: StopGoingBack | undefined;
      }
    | undefined;
  readonly formatAt: (iso: string) => string;
  // The Assistant view's secret check, for a lone question drawn as an item.
  readonly questionHold?: QuestionHold | undefined;
  // How many last lines of a tool's output an opened row shows (`chat.toolOutputLines`).
  readonly outputLines?: number | undefined;
  // Opens an edited file (an edit row's and an approval card's Open file); absent where nothing
  // can open it.
  readonly openFile?: ((path: string) => void) | undefined;
  // The thread's first pending approval, which the keys and the palette answer, and whether the
  // thread is the context panel's (a step's), which yields to the open thread's. Absent, a
  // pending card answers them itself.
  readonly keyedApproval?: { readonly id: string; readonly side: boolean } | undefined;
  // The provider's label for a model or a mode id, for the dividers and usage rows (spec 9).
  readonly modelLabel?: ((id: string) => string) | undefined;
  readonly modeLabel?: ((id: string) => string) | undefined;
  // When the item's turn ended, on the turn's last answer only (spec 75).
  readonly endedAt?: string | undefined;
  // Reasoning: whether it is complete, and whether it opens (spec 88). `reasoningKey` changes
  // when Ctrl+O opens or closes all of it, so a row opened by hand follows too.
  readonly reasoningDone?: boolean | undefined;
  readonly reasoningOpen?: boolean | undefined;
  readonly reasoningKey?: number | undefined;
  // A subagent call's own calls and notes, drawn under it, and their context (spec 44).
  readonly children?: readonly ThreadItem[] | undefined;
  readonly childContext?: ((item: ThreadItem) => ItemContext) | undefined;
  // A tool call the view names in words instead of by the tool's name.
  readonly toolWords?: string | undefined;
  // Edit (the last message only) and "Fork from here" on a user message (agent workbench spec
  // 62, 71); absent where they are not offered.
  readonly onEdit?: (() => void) | undefined;
  readonly onFork?: (() => void) | undefined;
  // "Restore files to here" on a user message whose turn kept a snapshot (thread work spec 20).
  readonly onRestore?: (() => void) | undefined;
  // A restore line: the message it went back to, and Undo while it is offered (spec 24).
  readonly restoreLine?:
    { readonly messageText: string; readonly onUndo?: (() => void) | undefined } | undefined;
  // The exchanges Edit replaced with this message, oldest first ("Earlier version", spec 62).
  readonly earlier?: readonly EarlierExchange[] | undefined;
}

// A replaced exchange as "Earlier version" shows it: the message and what answered it.
export interface EarlierExchange {
  readonly turnId: string;
  readonly text: string;
  readonly answers: readonly string[];
  readonly toolCalls: number;
}

function EarlierVersions({ versions }: { versions: readonly EarlierExchange[] }) {
  return (
    <details data-testid="earlier-version" className="group w-full max-w-[85%] text-xs">
      <summary className="ml-auto flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {versions.length === 1 ? 'Earlier version' : `${versions.length} earlier versions`}
      </summary>
      <ol aria-label="Earlier versions" className="mt-1 flex flex-col gap-2">
        {versions.map((version) => (
          <li
            key={version.turnId}
            data-testid="earlier-exchange"
            className="flex flex-col gap-1 rounded-md border border-dashed border-border px-3 py-2"
          >
            <p className="self-end whitespace-pre-wrap text-muted-foreground">{version.text}</p>
            {version.toolCalls > 0 && (
              <p className="text-muted-foreground">
                Used {version.toolCalls} tool{version.toolCalls === 1 ? '' : 's'}
              </p>
            )}
            {version.answers.map((answer, index) => (
              <div key={index} className="text-foreground/80">
                <Markdown text={answer} streaming={false} />
              </div>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

// One row per thread item. Rows skip layout and paint while off screen, so a long conversation
// with large tool outputs stays responsive without a virtual list.
// A message takes the keyboard from Alt+Up and Alt+Down (spec 74), so it can be read and copied.
function Row({ item, children }: { item: ThreadItem; children: ReactNode }) {
  const message = item.kind === 'user' || item.kind === 'assistant_text';
  return (
    <li
      data-testid={`item-${item.kind}`}
      data-item-id={item.id}
      data-message={message || undefined}
      tabIndex={message ? -1 : undefined}
      className={cn(
        '[contain-intrinsic-size:auto_2.5rem] [content-visibility:auto]',
        message &&
          'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      {children}
    </li>
  );
}

function Unreadable({ item }: { item: ThreadItem }) {
  return <p className="text-xs text-muted-foreground">Unreadable {item.kind} item.</p>;
}

const queuedMarks: Readonly<Record<NonNullable<TextItemPayload['queued']>, string>> = {
  duringTurn: 'Sent during the turn',
  afterTurn: 'Sent when the turn ended',
};

// The message the server holds until the turn ends (agent workbench spec 50, 52), after the
// conversation's rows. Edit and Cancel go while it waits; once sent it is a user message.
export function QueuedMessageItem({
  queued,
  onEdit,
  onCancel,
}: {
  queued: QueuedMessage;
  onEdit(): Promise<unknown>;
  onCancel(): Promise<unknown>;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };
  const skills = queued.skills ?? [];
  return (
    <li data-testid="queued-message" className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1 text-2xs text-muted-foreground">
        <ClockIcon aria-hidden className="size-3" />
        Queued · sent when the turn ends
      </span>
      {skills.length > 0 && (
        <div
          role="list"
          aria-label="Queued with skills"
          className="flex max-w-[85%] flex-wrap justify-end gap-1"
        >
          {skills.map((skill) => (
            <Badge
              role="listitem"
              key={`${skill.source ?? 'folder'}:${skill.name}`}
              variant="outline"
              className="font-mono"
            >
              {skill.name}
            </Badge>
          ))}
        </div>
      )}
      {queued.text.trim() !== '' && (
        <div className="w-fit max-w-[85%] rounded-lg border border-dashed border-border px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground">
          {queued.text}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(onEdit)}>
          Edit
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(onCancel)}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function UserMessage({
  threadId,
  payload,
  context,
}: {
  threadId: string;
  payload: TextItemPayload;
  context: ItemContext;
}) {
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
  const files = payload.files ?? [];
  const images = payload.images ?? [];
  const text = withoutMentions(payload.text, files);
  return (
    <div className="group flex flex-col items-end gap-0.5">
      {images.length > 0 && <SentImages threadId={threadId} images={images} />}
      {files.length > 0 && (
        <div
          role="list"
          aria-label="Sent with files"
          className="flex max-w-[85%] flex-wrap justify-end gap-1"
        >
          {files.map((file) => (
            <span role="listitem" key={file}>
              <FileChip path={file} />
            </span>
          ))}
        </div>
      )}
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
      {text.trim() !== '' && (
        <div className="w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
          {text}
        </div>
      )}
      {payload.queued && (
        <span data-testid="sent-from-queue" className="text-2xs text-muted-foreground">
          {queuedMarks[payload.queued]}
        </span>
      )}
      <div className="flex items-center gap-1">
        {(context.onEdit || context.onFork || context.onRestore) && (
          <div
            data-testid="message-go-back"
            className="flex gap-0.5 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          >
            {context.onEdit && (
              <Button size="xs" variant="ghost" onClick={context.onEdit}>
                <PencilIcon />
                Edit
              </Button>
            )}
            {context.onFork && (
              <Button size="xs" variant="ghost" onClick={context.onFork}>
                <GitForkIcon />
                Fork from here
              </Button>
            )}
            {context.onRestore && (
              <Button size="xs" variant="ghost" onClick={context.onRestore}>
                <HistoryIcon />
                Restore files to here
              </Button>
            )}
          </div>
        )}
        {context.at && (
          <time
            data-testid="message-time"
            dateTime={context.at}
            className="text-2xs text-muted-foreground tabular-nums"
          >
            {context.formatAt(context.at)}
          </time>
        )}
      </div>
      {context.earlier && context.earlier.length > 0 && (
        <EarlierVersions versions={context.earlier} />
      )}
    </div>
  );
}

// Assistant text through the shared markdown renderer. While it streams, an unfinished table or
// fence stays plain text until it is complete.
// Copy puts the markdown on the clipboard, Copy text what the message reads as on screen (spec
// 32); both show on hover or focus once the message is complete.
function AssistantText({
  payload,
  streaming,
  context,
}: {
  payload: TextItemPayload;
  streaming: boolean;
  context: ItemContext;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shownText = () => {
    const element = body.current;
    if (!element) return payload.text;
    // jsdom has no innerText; a browser's keeps the line breaks the reader sees.
    return (element.innerText ?? element.textContent ?? '').trim();
  };
  const actions = useRowActions(
    streaming
      ? []
      : [
          {
            id: 'copy',
            title: 'Copy message',
            keywords: ['copy', 'markdown', 'clipboard'],
            run: () => copyText(payload.text),
          },
          {
            id: 'copyText',
            title: 'Copy message text',
            keywords: ['copy', 'plain', 'clipboard'],
            run: () => copyText(shownText()),
          },
        ],
  );
  return (
    <div aria-busy={streaming} className="group/message relative" {...actions}>
      <div ref={body}>
        <Markdown text={payload.text} streaming={streaming} />
      </div>
      {streaming ? (
        <span aria-hidden className="mt-1 block h-3.5 w-1.5 animate-pulse bg-foreground/60" />
      ) : (
        <div className="mt-0.5 flex items-center gap-1">
          <div
            data-testid="message-copy"
            className="flex gap-0.5 text-muted-foreground opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100"
          >
            <CopyButton text={payload.text} label="Copy" />
            <CopyButton text={shownText} label="Copy text" />
          </div>
          {context.endedAt && (
            <time
              data-testid="message-time"
              dateTime={context.endedAt}
              className="ml-auto text-2xs text-muted-foreground tabular-nums"
            >
              {context.formatAt(context.endedAt)}
            </time>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsed unless the setting or Ctrl+O opens it. While it streams, its last line shows beside
// "Thinking…"; once done it reads "Thought for 12 s" (spec 88). Reasoning stored before its
// times were kept reads "Reasoning", as it did.
const thoughtFor = (payload: ReasoningItemPayload): string => {
  if (payload.startedAt === undefined || payload.endedAt === undefined) return 'Reasoning';
  const seconds = Math.max(
    1,
    Math.round((Date.parse(payload.endedAt) - Date.parse(payload.startedAt)) / 1000),
  );
  return `Thought for ${seconds} s`;
};

// Find opens it too (thread work spec 4); Ctrl+O afterwards opens or closes it with the rest.
function Reasoning({ payload, context }: { payload: ReasoningItemPayload; context: ItemContext }) {
  const done = context.reasoningDone ?? true;
  const lastLine = payload.text.trimEnd().split('\n').at(-1) ?? '';
  const id = context.itemId;
  const [found, setFound] = useOpenState(id === undefined ? undefined : openKey('reasoning', id));
  const allKey = context.reasoningKey ?? 0;
  const seenKey = useRef(allKey);
  useEffect(() => {
    if (seenKey.current === allKey) return;
    seenKey.current = allKey;
    if (found) setFound(false);
  }, [allKey, found, setFound]);
  return (
    <details
      key={`${allKey}:${found}`}
      open={found || context.reasoningOpen}
      onToggle={(event) => {
        if (!event.currentTarget.open && found) setFound(false);
      }}
      className="group text-xs text-muted-foreground"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <BrainIcon className="size-3.5 shrink-0" />
        <span data-testid="reasoning-label" className="shrink-0">
          {done ? thoughtFor(payload) : 'Thinking…'}
        </span>
        {!done && lastLine !== '' && (
          <span
            data-testid="reasoning-last-line"
            className="min-w-0 truncate text-muted-foreground/70 group-open:hidden"
          >
            {lastLine}
          </span>
        )}
      </summary>
      <div className="mt-1 border-l border-border pl-3 whitespace-pre-wrap">{payload.text}</div>
    </details>
  );
}

// A thin line across the conversation with a few words in it.
function Divider({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      role="separator"
      data-testid={testId}
      className="flex items-center gap-2 text-2xs text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5 text-center">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

// "Model: Opus → Sonnet · Mode: Accept edits" before the message whose turn runs on them (spec 9).
export function settingsChangeText(
  payload: SettingsChangeItemPayload,
  modelLabel: (id: string) => string = (id) => id,
  modeLabel: (id: string) => string = (id) => id,
): string {
  return [
    payload.model && `Model: ${modelLabel(payload.model.from)} → ${modelLabel(payload.model.to)}`,
    payload.effort &&
      `Effort: ${effortLabel(payload.effort.from)} → ${effortLabel(payload.effort.to)}`,
    payload.permissionMode && `Mode: ${modeLabel(payload.permissionMode.to)}`,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ');
}

// "Conversation compacted (auto) · 152k → 18k", with the counts the provider gave (spec 46).
export function compactionText(payload: CompactionItemPayload): string {
  const counts =
    payload.preTokens === undefined
      ? undefined
      : payload.postTokens === undefined
        ? `${shortTokens(payload.preTokens)} before`
        : `${shortTokens(payload.preTokens)} → ${shortTokens(payload.postTokens)}`;
  return [`Conversation compacted (${payload.trigger})`, counts].filter(Boolean).join(' · ');
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
      needsYouKey={`thread:${first.item.threadId}`}
    />
  );
}

function UsageRow({ payload, context }: { payload: UsageItemPayload; context: ItemContext }) {
  if (payload.inputTokens === undefined && payload.outputTokens === undefined) return null;
  const parts = [
    ...(payload.model === undefined ? [] : [(context.modelLabel ?? String)(payload.model)]),
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
          {recovery.goOn && (
            <WithTooltip label={recovery.goOn.detail}>
              <Button size="xs" variant="outline" onClick={recovery.goOn.run}>
                {recovery.goOn.title}
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
        <UserMessage threadId={item.threadId} payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'assistant_text': {
      const parsed = TextItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <AssistantText payload={parsed.data} streaming={item.streaming} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'reasoning': {
      const parsed = ReasoningItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <Reasoning payload={parsed.data} context={context} />
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
      return <ApprovalCard payload={parsed.data} approval={approval} context={context} />;
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
          <TaskMarker
            payload={parsed.data}
            turnEnded={context.turnEnded}
            openKey={context.itemId === undefined ? undefined : openKey('tasks', context.itemId)}
          />
        )
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'usage': {
      const parsed = UsageItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <UsageRow payload={parsed.data} context={context} />
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'settings_change': {
      const parsed = SettingsChangeItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <Divider testId="settings-divider">
          {settingsChangeText(parsed.data, context.modelLabel, context.modeLabel)}
        </Divider>
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'compaction': {
      const parsed = CompactionItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <Divider testId="compaction-divider">
          <FoldVerticalIcon aria-hidden className="size-3 shrink-0" />
          {compactionText(parsed.data)}
        </Divider>
      ) : (
        <Unreadable item={item} />
      );
    }
    case 'files_restored': {
      const parsed = FilesRestoredItemPayload.safeParse(item.payload);
      return parsed.success ? (
        <FilesRestoredLine
          payload={parsed.data}
          messageText={context.restoreLine?.messageText ?? ''}
          onUndo={context.restoreLine?.onUndo}
        />
      ) : (
        <Unreadable item={item} />
      );
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
// "Running pnpm test · 0:42 · 6 tool calls · ↑12k ↓1.3k · Ctrl+. to stop" (spec 45): the
// call that runs now, the turn's time from its stored start, its calls, its tokens where the
// provider counts them during the turn, and the stop key.
export function WorkingIndicator({
  startedAt,
  facts,
  stopKey,
}: {
  startedAt: string | undefined;
  facts?: WorkingFacts | undefined;
  stopKey?: string | undefined;
}) {
  const now = useNow(startedAt !== undefined);
  const parts = [
    ...(startedAt ? [formatElapsed(now - new Date(startedAt).getTime())] : []),
    ...(facts && facts.toolCalls > 0
      ? [`${facts.toolCalls} tool call${facts.toolCalls === 1 ? '' : 's'}`]
      : []),
    ...(facts?.tokens
      ? [`↑${shortTokens(facts.tokens.input)} ↓${shortTokens(facts.tokens.output)}`]
      : []),
    ...(stopKey ? [`${formatBinding(stopKey)} to stop`] : []),
  ];
  return (
    <p
      data-testid="working-line"
      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <CircleDashedIcon className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 truncate">
        {facts?.tool === undefined ? (
          'Working'
        ) : (
          <>
            Running <span className="font-mono text-foreground">{facts.tool}</span>
          </>
        )}
        {parts.length > 0 && (
          <span data-testid="turn-elapsed" className="tabular-nums" aria-hidden>
            {' · '}
            {parts.join(' · ')}
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
