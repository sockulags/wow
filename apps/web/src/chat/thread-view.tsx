import { providerChatOptions, type ProviderInstance, type Thread } from '@wow/contracts';
import { CircleCheckIcon, PinIcon, PinOffIcon, RotateCcwIcon, Undo2Icon } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useSetting } from '@/app/runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Composer } from './composer';
import { useDispatch, useTopic } from './data';
import { ConversationItem, WorkingIndicator } from './items';
import {
  canMarkDone,
  contextPercent,
  formatTokens,
  lastTurn,
  latestContext,
  runLabel,
  runningTurn,
  threadTitle,
  type ContextUsage,
} from './model';
import { ThreadSettings } from './thread-settings';

const stateLabels: Readonly<Record<Thread['state'], string>> = {
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

function ThreadHeader({
  thread,
  instance,
}: {
  thread: Thread;
  instance: ProviderInstance | undefined;
}) {
  const send = useDispatch();
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const run = runLabel(thread, runs, workflows);
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('size-2 rounded-full', stateDotClass[thread.state])} />
        <h2 className="min-w-0 truncate text-sm font-medium">{threadTitle(thread)}</h2>
        <span className="sr-only">State:</span>
        <span data-testid="thread-state" className="shrink-0 text-xs text-muted-foreground">
          {stateLabels[thread.state]}
        </span>
        {run && (
          <Badge variant="outline" className="text-muted-foreground">
            {run}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
          aria-pressed={thread.pinned}
          onClick={() =>
            void send({ type: 'thread.setPinned', threadId: thread.id, pinned: !thread.pinned })
          }
        >
          {thread.pinned ? <PinOffIcon /> : <PinIcon />}
        </Button>
        {thread.state === 'done' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send({ type: 'thread.setDone', threadId: thread.id, done: false })}
          >
            <Undo2Icon />
            Reopen thread
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canMarkDone(thread)}
            title={
              canMarkDone(thread)
                ? undefined
                : 'Available once the agent stops working and nothing waits for you'
            }
            onClick={() => void send({ type: 'thread.setDone', threadId: thread.id, done: true })}
          >
            <CircleCheckIcon />
            Mark thread done
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="thread-provider"
          className="text-xs text-muted-foreground"
          title={instance ? `${instance.kind} · ${instance.configDir}` : undefined}
        >
          {instance ? `${instance.name} (${instance.kind})` : thread.providerInstanceId}
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
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {thread.cwd}
        </span>
      </div>
    </header>
  );
}

function ContextMeter({
  context,
  onCompact,
}: {
  context: ContextUsage | undefined;
  onCompact: (() => void) | undefined;
}) {
  const percent = context ? contextPercent(context) : 0;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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
        {context
          ? `${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)} context (${percent}%)`
          : 'No context report yet'}
      </span>
      {onCompact && context && (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onCompact}>
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
  const send = useDispatch();
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const turns = useTopic('turns', threadId) ?? [];
  const items = useTopic('threadItems', threadId);
  const approvals = useTopic('approvals', threadId) ?? [];
  const questions = useTopic('questions', threadId) ?? [];
  const showMeter = useSetting('chat.contextMeter');
  const resumePrompt = useSetting('chat.resumePrompt');
  const { container, onScroll } = useStickToBottom(items);

  const thread = threads?.find((candidate) => candidate.id === threadId);
  if (threads && !thread) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Thread not found.
      </div>
    );
  }
  if (!thread) return null;

  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);
  const running = runningTurn(turns) !== undefined;
  const last = lastTurn(turns);
  const canResume = !running && (last?.state === 'failed' || last?.state === 'interrupted');
  const compactPrompt = instance ? providerChatOptions[instance.kind].compactPrompt : null;
  const message = (text: string) => send({ type: 'thread.sendMessage', threadId, text });
  const stop = () => void send({ type: 'thread.interrupt', threadId });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader thread={thread} instance={instance} />
      <div
        ref={container}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="conversation"
      >
        <ol aria-label="Conversation" className="mx-auto flex max-w-3xl flex-col gap-3">
          {(items ?? []).map((item) => (
            <ConversationItem
              key={item.id}
              item={item}
              approvals={approvals}
              questions={questions}
            />
          ))}
        </ol>
        {running && thread.state === 'working' && (
          <div className="mx-auto mt-3 max-w-3xl">
            <WorkingIndicator />
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        <Composer
          providerKind={instance?.kind}
          running={running}
          placeholder={
            running ? 'The agent is working…' : 'Message the agent. Type $ to pick a skill.'
          }
          onSend={message}
          onStop={stop}
          footer={
            <div className="flex min-h-6 flex-wrap items-center gap-3">
              {showMeter && (
                <ContextMeter
                  context={latestContext(items ?? [])}
                  onCompact={
                    compactPrompt !== null && !running
                      ? () => void message(compactPrompt)
                      : undefined
                  }
                />
              )}
              {canResume && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  onClick={() => void message(resumePrompt)}
                >
                  <RotateCcwIcon className="size-3" />
                  Resume
                </Button>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
