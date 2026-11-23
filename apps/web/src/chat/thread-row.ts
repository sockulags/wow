import type { Project, Thread, ThreadActivity, ThreadRowPart } from '@wow/contracts';
import { runningToolLabel } from './view-model';

// A thread row's second line (chat overview spec 6 to 8): what the thread does or waits for, how
// far its task list is, what it changed, its branch or project, and when it was last active,
// each part only where it has something to say and the setting `chat.threadRowDetail` keeps it.
// Everything is read from what the server stored; nothing counts on its own.

export interface ThreadRowFacts {
  readonly thread: Thread;
  // The thread's row of the `threadActivity` topic, while it works, waits or is unread.
  readonly activity: ThreadActivity | undefined;
  // What it waits for, from the decision queue.
  readonly waitsFor: string | undefined;
  readonly projects: readonly Project[];
  readonly relative: (iso: string) => string;
}

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

function activityText({ thread, activity, waitsFor }: ThreadRowFacts): string | undefined {
  if (waitsFor !== undefined) return waitsFor;
  if (thread.state === 'needs_you') return 'Waits for you';
  if (thread.state !== 'working') return undefined;
  const tool = activity?.runningTool;
  return tool ? `Running ${runningToolLabel(tool, thread.cwd)}` : 'Working';
}

const partText: Readonly<Record<ThreadRowPart, (facts: ThreadRowFacts) => string | undefined>> = {
  activity: activityText,
  tasks: ({ thread }) =>
    thread.tasks && thread.tasks.done < thread.tasks.total
      ? `${thread.tasks.done}/${thread.tasks.total}`
      : undefined,
  changes: ({ thread }) =>
    thread.changeCount && thread.changeCount.files > 0
      ? `+${thread.changeCount.added} −${thread.changeCount.removed}`
      : undefined,
  place: ({ thread, projects }) =>
    thread.workingCopy && thread.branch
      ? thread.branch
      : (projects.find((project) => project.id === thread.projectId)?.name ?? baseName(thread.cwd)),
  time: ({ thread, relative }) => relative(thread.updatedAt),
};

// The parts in the order of spec 6, whatever order the setting lists them in.
const order: readonly ThreadRowPart[] = ['activity', 'tasks', 'changes', 'place', 'time'];

export function threadRowParts(
  facts: ThreadRowFacts,
  shown: readonly ThreadRowPart[],
): { readonly part: ThreadRowPart; readonly text: string }[] {
  return order.flatMap((part) => {
    if (!shown.includes(part)) return [];
    const text = partText[part](facts);
    return text === undefined || text === '' ? [] : [{ part, text }];
  });
}
