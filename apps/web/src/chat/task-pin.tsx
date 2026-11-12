import { TaskListItemPayload, type TaskStatus, type ThreadItem, type Turn } from '@wow/contracts';
import { CheckIcon, ChevronRightIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from 'lucide-react';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { cn } from '@/lib/utils';

// The task list (agent workbench spec 31): the latest list of the running or last turn pinned
// above the composer as one line that opens to the list (Ctrl+T), a one-line marker in the
// conversation for each update, and the list in Details.

export interface Task {
  readonly id: string;
  readonly content: string;
  readonly status: TaskStatus;
}

// "3/7" and the task being worked on: the one in progress, else the next one, else the last.
export function taskProgress(tasks: readonly Task[]): {
  readonly done: number;
  readonly total: number;
  readonly current: string | undefined;
} {
  const current =
    tasks.find((task) => task.status === 'in_progress') ??
    tasks.find((task) => task.status === 'pending') ??
    tasks.at(-1);
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    current: current?.content,
  };
}

// The latest list of the running turn, or of the last turn when none runs.
export function latestTaskList(
  items: readonly ThreadItem[],
  turns: readonly Turn[],
): { readonly tasks: readonly Task[]; readonly turnEnded: boolean } | undefined {
  const turn =
    turns.find((candidate) => candidate.state === 'running') ??
    turns.reduce<Turn | undefined>(
      (last, candidate) => (last === undefined || candidate.index > last.index ? candidate : last),
      undefined,
    );
  if (!turn) return undefined;
  const item = items.findLast(
    (candidate) => candidate.kind === 'task_list' && candidate.turnId === turn.id,
  );
  const parsed = TaskListItemPayload.safeParse(item?.payload);
  if (!parsed.success || parsed.data.tasks.length === 0) return undefined;
  return { tasks: parsed.data.tasks, turnEnded: turn.state !== 'running' };
}

const taskIcons = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CheckIcon,
} as const;

export function TaskList({
  tasks,
  turnEnded,
  label = 'Tasks',
  heading = true,
}: {
  tasks: readonly Task[];
  turnEnded: boolean;
  label?: string;
  heading?: boolean;
}) {
  return (
    <section aria-label={label} className="rounded-md border border-border p-2 text-xs">
      {heading && <h4 className="mb-1 px-1 text-2xs font-medium text-muted-foreground">Tasks</h4>}
      <ul className="flex flex-col gap-0.5">
        {tasks.map((task) => {
          // A turn that ended leaves unfinished tasks unfinished; they no longer show as running.
          const unfinished = turnEnded && task.status !== 'completed';
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

// One update of the list in the conversation: "Updated tasks (3/7)", opening to the list.
export function TaskMarker({
  payload,
  turnEnded,
}: {
  payload: TaskListItemPayload;
  turnEnded: boolean;
}) {
  const { done, total } = taskProgress(payload.tasks);
  return (
    <details className="group text-xs text-muted-foreground">
      <summary
        data-testid="task-marker"
        className="flex cursor-pointer list-none items-center gap-1.5 select-none"
      >
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
        <ListTodoIcon className="size-3.5" />
        Updated tasks ({done}/{total})
      </summary>
      <div className="mt-1">
        <TaskList tasks={payload.tasks} turnEnded={turnEnded} heading={false} />
      </div>
    </details>
  );
}

// Which thread's pin the keybinding and the palette act on (the newest shown), and which pins
// are open. Open is this window's state, kept per thread.
interface TaskPinState {
  readonly shown: readonly string[];
  readonly open: Readonly<Record<string, boolean>>;
}

export const taskPinStore = createStore<TaskPinState>(() => ({ shown: [], open: {} }));

export function toggleTaskPin(threadId: string): void {
  taskPinStore.setState((state) => ({
    open: { ...state.open, [threadId]: !state.open[threadId] },
  }));
}

export const activeTaskPin = (state: TaskPinState): string | undefined => state.shown.at(-1);

function useShownPin(threadId: string, shown: boolean) {
  useEffect(() => {
    if (!shown) return undefined;
    taskPinStore.setState((state) => ({
      shown: [...state.shown.filter((id) => id !== threadId), threadId],
    }));
    return () =>
      taskPinStore.setState((state) => ({
        shown: state.shown.filter((id) => id !== threadId),
      }));
  }, [threadId, shown]);
}

export function taskPinCommands(threadId: string | undefined, open: boolean): AppCommand[] {
  if (threadId === undefined) return [];
  return [
    {
      id: 'chat.toggleTasks',
      title: open ? 'Hide task list' : 'Show task list',
      group: 'Chat',
      keywords: ['tasks', 'todo', 'plan', 'progress'],
      keybinding: 'keybindings.toggleTasks',
      run: () => toggleTaskPin(threadId),
    },
  ];
}

// "3/7 · Running the tests" above the composer; it opens to the whole list.
export function TaskPin({
  threadId,
  items,
  turns,
}: {
  threadId: string;
  items: readonly ThreadItem[];
  turns: readonly Turn[];
}) {
  const latest = latestTaskList(items, turns);
  useShownPin(threadId, latest !== undefined);
  const open = useStore(taskPinStore, (state) => state.open[threadId] ?? false);
  if (!latest) return null;
  const { done, total, current } = taskProgress(latest.tasks);
  return (
    <div data-testid="task-pin" className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Task list"
        onClick={() => toggleTaskPin(threadId)}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <ListTodoIcon className="size-3.5 shrink-0" />
        <span data-testid="task-pin-line" className="min-w-0 truncate">
          {done}/{total}
          {current !== undefined && ` · ${current}`}
        </span>
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto">
          <TaskList tasks={latest.tasks} turnEnded={latest.turnEnded} label="Pinned tasks" />
        </div>
      )}
    </div>
  );
}

// The same list for the thread's Details in the panel.
export function TaskDetails({
  items,
  turns,
}: {
  items: readonly ThreadItem[];
  turns: readonly Turn[];
}) {
  const latest = latestTaskList(items, turns);
  if (!latest) return <p className="text-xs text-muted-foreground">No task list yet.</p>;
  return (
    <TaskList
      tasks={latest.tasks}
      turnEnded={latest.turnEnded}
      label="Thread tasks"
      heading={false}
    />
  );
}
