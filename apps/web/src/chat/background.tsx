import {
  providerChatOptions,
  ToolCallItemPayload,
  type BackgroundTask,
  type ProviderKind,
  type ThreadItem,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { BotIcon, HourglassIcon, SquareIcon, TerminalIcon } from 'lucide-react';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { notify } from '@/lib/feedback';
import { errorMessage, useDispatch } from './data';
import { agentTask } from './tools/facts';
import { useNow } from './tools/time';
import { formatElapsed } from './view-model';

// Background work (agent workbench spec 90): the tasks the agent runs in the background are chips
// that count up from when the server first heard of them, open to the latest output the provider
// reported, and have Stop where the provider can stop one. Ctrl+B sends the running command or
// subagent to the background where the provider can. The open thread's view registers what it
// shows here, so the palette and the key act on it.

export interface BackgroundTarget {
  // The running call's item id and what it is ("`pnpm dev`", "Agent: explore the auth code").
  readonly itemId: string;
  readonly title: string;
}

interface BackgroundState {
  readonly threadId: string | undefined;
  readonly tasks: readonly BackgroundTask[];
  readonly target: BackgroundTarget | undefined;
  readonly stops: boolean;
  // The chip opened by hand or from the palette.
  readonly open: string | undefined;
}

export const backgroundStore = createStore<BackgroundState>(() => ({
  threadId: undefined,
  tasks: [],
  target: undefined,
  stops: false,
  open: undefined,
}));

export const openBackgroundTask = (taskId: string | undefined): void =>
  backgroundStore.setState({ open: taskId });

// The call Ctrl+B sends: the newest running command or subagent of the running turn that is the
// thread's own (a subagent's command is not a task of the thread's agent).
export function backgroundTarget(
  items: readonly ThreadItem[],
  turnId: string | undefined,
): BackgroundTarget | undefined {
  if (turnId === undefined) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.turnId !== turnId || item.kind !== 'tool_call') continue;
    const parsed = ToolCallItemPayload.safeParse(item.payload);
    if (!parsed.success || parsed.data.status !== 'running') continue;
    if (parsed.data.parentItemId !== undefined) continue;
    if (parsed.data.kind === 'command')
      return { itemId: item.id, title: `\`${parsed.data.command ?? parsed.data.name}\`` };
    if (parsed.data.kind === 'subagent')
      return { itemId: item.id, title: `Agent: ${agentTask(parsed.data)}` };
  }
  return undefined;
}

// The open conversation tells the palette what it shows; the side panel's step thread does not.
export function useBackgroundShown(
  threadId: string,
  shown: boolean,
  tasks: readonly BackgroundTask[],
  target: BackgroundTarget | undefined,
  kind: ProviderKind | undefined,
): void {
  const options = kind ? providerChatOptions[kind] : undefined;
  const sends = options?.sendsToBackground ?? false;
  const stops = options?.stopsTasks ?? false;
  const offered = sends ? target : undefined;
  const key = JSON.stringify([tasks, offered]);
  useEffect(() => {
    if (!shown) return undefined;
    const parsed = JSON.parse(key) as [BackgroundTask[], BackgroundTarget | null];
    backgroundStore.setState((state) => ({
      threadId,
      tasks: parsed[0],
      target: parsed[1] ?? undefined,
      stops,
      open: state.threadId === threadId ? state.open : undefined,
    }));
    return () =>
      backgroundStore.setState((state) =>
        state.threadId === threadId
          ? { threadId: undefined, tasks: [], target: undefined, stops: false, open: undefined }
          : state,
      );
  }, [shown, threadId, key, stops]);
}

const taskTitle = (task: BackgroundTask) => task.description || task.id;

export function backgroundCommands(state: BackgroundState): AppCommand[] {
  const { threadId, target } = state;
  if (threadId === undefined) return [];
  const commands: AppCommand[] = [];
  if (target) {
    commands.push({
      id: 'chat.toBackground',
      title: 'Send to the background',
      detail: target.title,
      group: 'Chat',
      keywords: ['background', 'detach', 'continue', 'ctrl+b'],
      keybinding: 'keybindings.toBackground',
      run: ({ connection }) => {
        if (!connection) return;
        dispatch(connection, {
          type: 'thread.toBackground',
          threadId,
          itemId: target.itemId,
        }).catch((error: unknown) => notify.error(errorMessage(error)));
      },
    });
  }
  for (const task of state.tasks) {
    commands.push({
      id: `chat.background.show.${task.id}`,
      title: `Show background task: ${taskTitle(task)}`,
      group: 'Chat',
      keywords: ['background', 'task', 'output'],
      run: () => openBackgroundTask(task.id),
    });
    if (state.stops) {
      commands.push({
        id: `chat.background.stop.${task.id}`,
        title: `Stop background task: ${taskTitle(task)}`,
        group: 'Chat',
        keywords: ['background', 'task', 'stop', 'kill'],
        run: ({ connection }) => {
          if (!connection) return;
          dispatch(connection, { type: 'thread.stopTask', threadId, taskId: task.id }).catch(
            (error: unknown) => notify.error(errorMessage(error)),
          );
        },
      });
    }
  }
  return commands;
}

// One chip: what runs and for how long; open, the latest output and Stop.
function TaskChip({
  task,
  threadId,
  stops,
}: {
  task: BackgroundTask;
  threadId: string;
  stops: boolean;
}) {
  const send = useDispatch();
  const now = useNow(task.startedAt !== undefined);
  const open = useStore(backgroundStore, (state) => state.open === task.id);
  const Icon =
    task.kind === 'command'
      ? TerminalIcon
      : task.agent || task.kind === 'agent'
        ? BotIcon
        : HourglassIcon;
  const elapsed =
    task.startedAt === undefined ? undefined : formatElapsed(now - Date.parse(task.startedAt));
  const stop = () =>
    void send({ type: 'thread.stopTask', threadId, taskId: task.id }).catch((error: unknown) =>
      notify.error(errorMessage(error)),
    );
  return (
    <Popover open={open} onOpenChange={(next) => openBackgroundTask(next ? task.id : undefined)}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          data-testid="background-chip"
          data-task-id={task.id}
          className="max-w-full font-normal"
        >
          <Icon aria-hidden />
          <span className="min-w-0 truncate">{taskTitle(task)}</span>
          {elapsed !== undefined && (
            <span data-testid="background-elapsed" className="tabular-nums text-muted-foreground">
              {elapsed}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-96 max-w-[90vw] flex-col gap-2 text-xs">
        <p className="font-medium">{taskTitle(task)}</p>
        <p className="text-muted-foreground">
          {task.kind === 'command'
            ? 'A command running in the background'
            : task.agent || task.kind === 'agent'
              ? 'A subagent working in the background'
              : 'Work running in the background'}
          {elapsed !== undefined && ` · ${elapsed}`}
        </p>
        <div>
          <p className="mb-1 text-muted-foreground">Latest output</p>
          <pre
            data-testid="background-output"
            className="max-h-48 overflow-auto rounded-sm bg-muted p-2 font-mono text-2xs whitespace-pre-wrap"
          >
            {task.lastOutput ?? 'Nothing reported yet.'}
          </pre>
        </div>
        {stops && (
          <Button size="xs" variant="outline" className="self-start" onClick={stop}>
            <SquareIcon />
            Stop
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// The chips under the conversation. Between turns the line says the agent waits for them, as it
// goes on by itself when they end.
export function BackgroundTasks({
  tasks,
  threadId,
  kind,
  waiting,
}: {
  tasks: readonly BackgroundTask[];
  threadId: string;
  kind: ProviderKind | undefined;
  waiting: boolean;
}) {
  const stops = kind ? providerChatOptions[kind].stopsTasks : false;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
      data-testid="background-work"
      role="group"
      aria-label="Background tasks"
    >
      <HourglassIcon className="size-3.5 shrink-0" aria-hidden />
      <span data-testid="background-label">
        {waiting ? 'Waiting for background work' : 'In the background'}
      </span>
      {tasks.map((task) => (
        <TaskChip key={task.id} task={task} threadId={threadId} stops={stops} />
      ))}
    </div>
  );
}
