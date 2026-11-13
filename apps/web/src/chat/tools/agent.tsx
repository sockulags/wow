import type { AgentState, ThreadItem } from '@wow/contracts';
import { BotIcon, ChevronRightIcon } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { ConversationItem, type ItemContext } from '../items';
import { openKey, OutputKeyContext, useOpenState } from '../open-state';
import { agentTask, formatDuration, toolDuration, type ToolPayload } from './facts';
import { ToolOutput } from './output';
import { useNow } from './time';

// A subagent call (agent workbench spec 44): "Agent: explore the auth code · 3 tool calls ·
// 1:32". While it works, the calls and notes it made are listed under it, drawn as the thread's
// own; once it is done its answer shows and the list folds away behind the row's line. Where the
// provider sends nothing of the subagent's own work (Codex, so far), the row has its prompt, its
// state and its final message only.

const stateWords: Readonly<Record<AgentState, string>> = {
  starting: 'starting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  missing: 'not found',
};

// Codex finishes the spawn call at once and reports the agent's state on later calls, so the
// agent works while its state says so.
export function agentWorking(payload: ToolPayload, context: ItemContext): boolean {
  if (context.turnEnded) return false;
  if (payload.agentState !== undefined)
    return payload.agentState === 'starting' || payload.agentState === 'running';
  return payload.status === 'running';
}

const nestedCalls = (items: readonly ThreadItem[]): number =>
  items.filter((item) => item.kind === 'tool_call').length;

export function AgentCall({ payload, context }: { payload: ToolPayload; context: ItemContext }) {
  const nested = context.children ?? [];
  const working = agentWorking(payload, context);
  const id = context.itemId;
  const [opened, setOpened] = useOpenState(id === undefined ? undefined : openKey('agent', id));
  const open = working || opened;
  const [promptShown] = useOpenState(id === undefined ? undefined : openKey('prompt', id));
  const now = useNow(working && payload.startedAt !== undefined);
  const count = payload.toolCount ?? nestedCalls(nested);
  const duration = working
    ? payload.startedAt === undefined
      ? undefined
      : now - Date.parse(payload.startedAt)
    : toolDuration(payload, now);
  const failed = payload.status === 'error' || payload.agentState === 'failed';
  const unfinished = !working && payload.status === 'running' && context.turnEnded;
  const answer = payload.answer ?? (working ? undefined : payload.output || undefined);
  const parts = [
    ...(count > 0 ? [`${count} tool call${count === 1 ? '' : 's'}`] : []),
    ...(duration === undefined || unfinished ? [] : [formatDuration(duration)]),
  ];
  return (
    <div
      data-testid="agent-row"
      data-tool-kind="subagent"
      data-working={working || undefined}
      className={cn(
        'rounded-md border text-xs',
        failed ? 'border-state-failed/40' : 'border-border',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={working}
        onClick={() => setOpened(!opened)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <ChevronRightIcon
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-testid="agent-task" className="min-w-0 truncate">
          Agent: {agentTask(payload)}
        </span>
        {payload.agentType && (
          <span className="shrink-0 text-2xs text-muted-foreground">{payload.agentType}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {parts.length > 0 && (
            <span data-testid="agent-facts" className="text-muted-foreground">
              {parts.join(' · ')}
            </span>
          )}
          {(payload.agentState !== undefined || failed || unfinished) && (
            <span
              data-testid="agent-state"
              className={cn(
                failed
                  ? 'text-state-failed'
                  : working
                    ? 'text-state-working'
                    : 'text-muted-foreground',
              )}
            >
              {unfinished
                ? 'not finished'
                : payload.agentState
                  ? stateWords[payload.agentState]
                  : 'failed'}
            </span>
          )}
        </span>
      </button>
      {open && (payload.prompt !== undefined || nested.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          {payload.prompt !== undefined && (
            <p
              data-testid="agent-prompt"
              className={cn(
                'whitespace-pre-wrap text-muted-foreground',
                !promptShown && 'line-clamp-4',
              )}
            >
              {payload.prompt}
            </p>
          )}
          {nested.length > 0 && (
            <ol aria-label="The subagent's work" className="flex flex-col gap-1.5 pl-3">
              {nested.map((item) => (
                <ConversationItem
                  key={item.id}
                  item={item}
                  approvals={[]}
                  questions={[]}
                  context={context.childContext?.(item) ?? context}
                />
              ))}
            </ol>
          )}
        </div>
      )}
      {answer !== undefined && (
        <div data-testid="agent-answer" className="border-t border-border p-2 text-sm">
          {payload.answer !== undefined ? (
            <Markdown text={answer} />
          ) : (
            <OutputKeyContext value={id === undefined ? undefined : openKey('output', id)}>
              <ToolOutput output={answer} lines={context.outputLines} />
            </OutputKeyContext>
          )}
        </div>
      )}
    </div>
  );
}
