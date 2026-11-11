import {
  providerChatOptions,
  type ProviderInstance,
  type SkillRef,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { CircleCheckIcon, PinIcon, RotateCcwIcon, SearchXIcon, Undo2Icon } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSetting } from '@/app/runtime';
import { IconButton, WithTooltip } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { GateBar } from '@/workflows/gate-bar';
import { gateRunForThread } from '@/workflows/model';
import { Composer, type ComposerHandle } from './composer';
import type { QuestionHold } from './question-card';
import { useDispatch, useTopic } from './data';
import {
  ChatQuestions,
  ConversationItem,
  ToolCallGroup,
  WorkingIndicator,
  type ItemContext,
} from './items';
import {
  canMarkDone,
  contextPercent,
  formatTokens,
  lastTurn,
  latestContext,
  permissionOptions,
  runLabel,
  runningTurn,
  threadTitle,
  type ContextUsage,
} from './model';
import { ThreadSettings } from './thread-settings';
import {
  groupQuestions,
  groupToolCalls,
  lastErrorId,
  lastUserSent,
  pendingApproval,
  pendingQuestion,
  providerLabel,
  type ConversationEntry,
} from './view-model';

export const threadStateLabels: Readonly<Record<Thread['state'], string>> = {
  idle: 'Idle',
  working: 'Working',
  needs_you: 'Needs you',
  done: 'Done',
  failed: 'Failed',
};

export const stateDotClass: Readonly<Record<Thread['state'], string>> = {
  idle: 'bg-muted-foreground/50',
  working: 'bg-state-working',
  needs_you: 'bg-state-needs-you',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
};

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

function ThreadHeader({
  thread,
  instance,
  instances,
}: {
  thread: Thread;
  instance: ProviderInstance | undefined;
  instances: readonly ProviderInstance[];
}) {
  const send = useDispatch();
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const run = runLabel(thread, runs, workflows);
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', stateDotClass[thread.state])}
        />
        <h2 className="min-w-0 truncate text-sm font-medium">{threadTitle(thread)}</h2>
        <span className="sr-only">State:</span>
        <span data-testid="thread-state" className="shrink-0 text-xs text-muted-foreground">
          {threadStateLabels[thread.state]}
        </span>
        {run && thread.runId && (
          <Badge asChild variant="outline" className="min-w-0 text-muted-foreground">
            <Link to="/workflows/runs/$runId" params={{ runId: thread.runId }}>
              <span className="truncate">{run}</span>
            </Link>
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
            aria-pressed={thread.pinned}
            onClick={() =>
              void send({ type: 'thread.setPinned', threadId: thread.id, pinned: !thread.pinned })
            }
          >
            <PinIcon className={cn(thread.pinned && 'fill-current')} />
          </IconButton>
          {thread.state === 'done' ? (
            <IconButton
              label="Reopen thread"
              onClick={() =>
                void send({ type: 'thread.setDone', threadId: thread.id, done: false })
              }
            >
              <Undo2Icon />
            </IconButton>
          ) : (
            <IconButton
              label="Mark thread done"
              disabled={!canMarkDone(thread)}
              onClick={() => void send({ type: 'thread.setDone', threadId: thread.id, done: true })}
            >
              <CircleCheckIcon />
            </IconButton>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <WithTooltip label={<span className="font-mono">{thread.cwd}</span>}>
          <span
            tabIndex={0}
            data-testid="thread-project"
            className="max-w-48 truncate rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {project?.name ?? baseName(thread.cwd)}
          </span>
        </WithTooltip>
        <span aria-hidden className="text-xs text-muted-foreground">
          ·
        </span>
        <span data-testid="thread-provider" className="text-xs text-muted-foreground">
          {instance ? providerLabel(instance, instances) : thread.providerInstanceId}
        </span>
        {instance && (
          <ThreadSettings
            providerInstanceId={instance.id}
            kind={instance.kind}
            value={thread}
            onChange={(changes) =>
              void send({ type: 'thread.configure', threadId: thread.id, ...changes })
            }
          />
        )}
      </div>
    </header>
  );
}

function ContextMeter({
  context,
  onCompact,
}: {
  context: ContextUsage;
  onCompact: (() => void) | undefined;
}) {
  const percent = contextPercent(context);
  return (
    <div className="flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 w-24 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full',
            percent >= 90 ? 'bg-state-failed' : percent >= 70 ? 'bg-state-needs-you' : 'bg-ring',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span data-testid="context-meter">
        {`${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)} context (${percent}%)`}
      </span>
      {onCompact && (
        <Button size="xs" variant="ghost" onClick={onCompact}>
          Compact
        </Button>
      )}
    </div>
  );
}

function useStickToBottom(dependency: unknown) {
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = container.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const element = container.current;
    if (!element) return;
    // Following the stream until the user scrolls up to read.
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };
  return { container, onScroll };
}

export function ThreadView({ threadId }: { threadId: string }) {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const thread = threads?.find((candidate) => candidate.id === threadId);

  if (threads && !thread) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="Thread not found"
        description="It may have been removed, or the link is from another wow home."
      />
    );
  }
  if (!thread) return null;
  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader thread={thread} instance={instance} instances={instances} />
      {/* Opening a thread puts the focus where the next message goes (audit A-11). */}
      <ThreadConversation thread={thread} instance={instance} autoFocus />
    </div>
  );
}

// What the Assistant view adds to a conversation without a copy of it: rows after an item and
// at the end, and its own composer text, check and notice. Skills are not offered there.
export interface ConversationExtras {
  after?(item: ThreadItem): ReactNode;
  readonly end?: ReactNode;
  readonly composerRef?: RefObject<ComposerHandle | null>;
  readonly placeholder?: string;
  readonly blockedReason?: string | undefined;
  beforeSend?(text: string): boolean;
  // The same check for what is typed on an agent's question card.
  readonly questionHold?: QuestionHold;
  readonly notice?: ReactNode;
}

// A thread's conversation, its gate bar and its composer: the chat view's thread and, narrower,
// the context panel's step thread (owner decision F-1), so both answer the same way.
export function ThreadConversation({
  thread,
  instance,
  autoFocus = false,
  compact = false,
  extras,
}: {
  thread: Thread;
  instance: ProviderInstance | undefined;
  autoFocus?: boolean;
  // The context panel: no centered column, tighter padding.
  compact?: boolean;
  extras?: ConversationExtras;
}) {
  const threadId = thread.id;
  const send = useDispatch();
  const turns = useTopic('turns', threadId) ?? [];
  const items = useTopic('threadItems', threadId);
  const approvals = useTopic('approvals', threadId) ?? [];
  const questions = useTopic('questions', threadId) ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const showMeter = useSetting('chat.contextMeter');
  const resumePrompt = useSetting('chat.resumePrompt');
  const groupTools = useSetting('chat.groupToolCalls');
  const skillTrigger = useSetting('chat.skillTrigger');
  const { when } = useDateFormat();
  const { container, onScroll } = useStickToBottom(items);
  const ownComposer = useRef<ComposerHandle>(null);
  const composer = extras?.composerRef ?? ownComposer;

  useEffect(() => {
    if (autoFocus) composer.current?.focus();
  }, [autoFocus, threadId, composer]);

  const running = runningTurn(turns);
  const last = lastTurn(turns);
  const canResume = !running && (last?.state === 'failed' || last?.state === 'interrupted');
  const compactPrompt = instance ? providerChatOptions[instance.kind].compactPrompt : null;
  const message = (text: string, skills?: readonly SkillRef[]) =>
    send({
      type: 'thread.sendMessage',
      threadId,
      text,
      ...(skills ? { skills: [...skills] } : {}),
    });
  const stop = () => void send({ type: 'thread.interrupt', threadId });
  const approval = pendingApproval(approvals);
  const question = pendingQuestion(questions, items ?? [], running);
  const gateRun = gateRunForThread(thread, runs);
  const context = latestContext(items ?? []);
  const retry = lastUserSent(items ?? []);
  const errorId = canResume ? lastErrorId(items ?? []) : undefined;
  const permissionLabel = instance
    ? (permissionOptions(instance.kind, thread.permissionMode).find(
        (option) => option.id === thread.permissionMode,
      )?.label ?? thread.permissionMode)
    : thread.permissionMode;
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const itemContext = (turnId: string, itemId: string): ItemContext => {
    const turn = turnById.get(turnId);
    return {
      cwd: thread.cwd,
      permissionLabel,
      turnEnded: turn !== undefined && turn.state !== 'running',
      at: turn?.startedAt,
      awaitingApproval: approval !== undefined,
      formatAt: when,
      questionHold: extras?.questionHold,
      recovery:
        itemId === errorId
          ? {
              ...(retry
                ? {
                    onRetry: () =>
                      void message(retry.text, retry.skills.length > 0 ? retry.skills : undefined),
                  }
                : {}),
              onResume: () => void message(resumePrompt),
              resumePrompt,
            }
          : undefined,
    };
  };

  const afters = new Map((items ?? []).map((item) => [item.id, extras?.after?.(item)]));
  const entries: ConversationEntry[] = groupQuestions(
    groupTools
      ? groupToolCalls(items ?? [], (item) => Boolean(afters.get(item.id)))
      : (items ?? []).map((item) => ({ kind: 'item', item })),
  );

  // While a question waits, the composer answers it with typed text, as its card's "Other" does;
  // while an approval waits, the buttons above answer it and the composer only queues the next
  // message (audit C-04).
  const answerQuestion = question
    ? (text: string, skills?: readonly SkillRef[]) =>
        skills
          ? Promise.reject(
              new Error('An answer takes no skills. Remove the chip, or answer on the card.'),
            )
          : send({
              type: 'question.answer',
              answers: [{ questionId: question.id, reply: { picked: [], text } }],
            })
    : undefined;
  const placeholder = question
    ? 'Type your answer, or answer on the card above'
    : approval
      ? 'Answer the request above'
      : running
        ? 'Write the next message; it is sent when the turn ends'
        : (extras?.placeholder ?? `Message the agent. Type ${skillTrigger} to pick a skill.`);

  const column = compact ? 'w-full px-3' : 'mx-auto w-full max-w-3xl px-4';
  return (
    <>
      <div
        ref={container}
        onScroll={onScroll}
        className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'py-3' : 'py-4')}
        data-testid="conversation"
      >
        <div className={column}>
          <ol aria-label="Conversation" className="flex flex-col gap-3">
            {entries.map((entry) => {
              const tail = entry.kind === 'item' ? entry.item : entry.items.at(-1);
              const after = tail && afters.get(tail.id);
              return (
                <Fragment key={entry.kind === 'item' ? entry.item.id : entry.id}>
                  {entry.kind === 'item' ? (
                    <ConversationItem
                      item={entry.item}
                      approvals={approvals}
                      questions={questions}
                      context={itemContext(entry.item.turnId, entry.item.id)}
                    />
                  ) : entry.kind === 'questions' ? (
                    <li data-testid="item-question" data-item-id={entry.id}>
                      <ChatQuestions
                        items={entry.items}
                        questions={questions}
                        turnEnded={itemContext(entry.items[0]?.turnId ?? '', entry.id).turnEnded}
                        hold={extras?.questionHold}
                      />
                    </li>
                  ) : (
                    <ToolCallGroup
                      items={entry.items}
                      contextOf={(item) => itemContext(item.turnId, item.id)}
                    />
                  )}
                  {after && <li>{after}</li>}
                </Fragment>
              );
            })}
            {extras?.end && <li>{extras.end}</li>}
          </ol>
          {running && thread.state === 'working' && (
            <div className="mt-3">
              <WorkingIndicator startedAt={running.startedAt} />
            </div>
          )}
        </div>
      </div>
      <div className={cn('flex shrink-0 flex-col gap-2', column, compact ? 'pb-3' : 'pb-4')}>
        {gateRun && (
          <GateBar
            run={gateRun}
            workflow={workflows.find((candidate) => candidate.id === gateRun.workflowId)}
            project={projects.find((candidate) => candidate.id === gateRun.projectId)}
            review={false}
          />
        )}
        <Composer
          ref={composer}
          providerKind={extras ? undefined : instance?.kind}
          running={running !== undefined && !question}
          placeholder={placeholder}
          blockedReason={extras?.blockedReason}
          onSend={answerQuestion ?? message}
          onStop={stop}
          notice={extras?.notice}
          {...(extras?.beforeSend ? { beforeSend: extras.beforeSend } : {})}
          footer={
            (showMeter && context) || (canResume && !errorId) ? (
              <div className="flex min-h-6 flex-wrap items-center gap-3">
                {showMeter && context && (
                  <ContextMeter
                    context={context}
                    onCompact={
                      compactPrompt !== null && !running
                        ? () => void message(compactPrompt)
                        : undefined
                    }
                  />
                )}
                {canResume && !errorId && (
                  // A stopped turn has no error row to carry Resume, so it sits here.
                  <WithTooltip label={`Sends: ${resumePrompt}`}>
                    <Button
                      size="xs"
                      variant="outline"
                      className="ml-auto"
                      onClick={() => void message(resumePrompt)}
                    >
                      <RotateCcwIcon />
                      Resume
                    </Button>
                  </WithTooltip>
                )}
              </div>
            ) : undefined
          }
        />
      </div>
    </>
  );
}
