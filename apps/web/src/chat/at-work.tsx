import type { Decision, Project, Thread, ThreadActivity, WorkflowRun } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { Link, useNavigate } from '@tanstack/react-router';
import { ActivityIcon, PlusIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import type { AppCommand } from '@/app/commands';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { useRuntime } from '@/app/runtime';
import { ShortcutHint } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { openThreadTab } from '@/panel/viewer';
import { useTopic } from './data';
import { nestHelpers } from './helpers';
import { WorkingIndicator } from './items';
import { runningToolLabel } from './view-model';

// Threads at work (parallel threads spec 11 to 14): every thread that needs the user, works, or
// ended a turn the user has not seen, with what each does now, waits for or last said. Read from
// the server's `threadActivity` and `decisions` topics; the view keeps nothing of its own.

export const AT_WORK_PATH = '/chat/work';

type Group = 'needs' | 'working' | 'finished';

export interface AtWorkRow {
  readonly thread: Thread;
  readonly activity: ThreadActivity;
  readonly group: Group;
  // What the thread waits for, from the decision queue (spec 12).
  readonly waitsFor: string | undefined;
  // A helper under its main thread is one step in; one listed alone names its main thread
  // (agent orchestration spec 11).
  readonly depth: 0 | 1;
  readonly helperOf: string | undefined;
}

const groupTitles: Record<Group, string> = {
  needs: 'Needs you',
  working: 'Working',
  finished: 'Finished, not read',
};

// The rows in group order, each group oldest first by when the thread came to its state (spec 11).
export function atWorkRows(
  threads: readonly Thread[],
  activity: readonly ThreadActivity[],
  decisions: readonly Decision[],
): AtWorkRow[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rows = activity.flatMap((entry): AtWorkRow[] => {
    const thread = byId.get(entry.threadId);
    if (!thread) return [];
    const waits = decisions.find((decision) => decision.threadId === thread.id);
    const group: Group =
      thread.state === 'needs_you' || waits !== undefined
        ? 'needs'
        : thread.state === 'working'
          ? 'working'
          : 'finished';
    return [
      { thread, activity: entry, group, waitsFor: waits?.title, depth: 0, helperOf: undefined },
    ];
  });
  const since = (row: AtWorkRow) => row.thread.stateSince ?? row.thread.updatedAt;
  const order: readonly Group[] = ['needs', 'working', 'finished'];
  // Within a group, each helper right after its main thread when both are there.
  return order.flatMap((group) =>
    nestHelpers(
      rows
        .filter((row) => row.group === group)
        .toSorted((a, b) => since(a).localeCompare(since(b))),
      (row) => row.thread,
      threads,
    ).map(({ entry, depth, helperOf }) => ({ ...entry, depth, helperOf })),
  );
}

// The project, the unit a plan run's step thread works on (agent orchestration spec 15), and the
// branch or folder.
export function where(
  thread: Thread,
  projects: readonly Project[],
  runs: readonly WorkflowRun[] = [],
): string {
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const unit = runs.find((run) => run.id === thread.runId)?.unit;
  const place = thread.branch ?? thread.cwd.split(/[\\/]/).findLast((part) => part !== '') ?? '';
  return [project?.name, unit ? `Unit ${unit.unitKey}` : undefined, place]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
}

function RowLine({ row }: { readonly row: AtWorkRow }) {
  const { relative } = useDateFormat();
  const { activity, thread } = row;
  if (row.group === 'needs') {
    return (
      <p className="truncate text-xs text-state-needs-you-text">
        {row.waitsFor ?? 'Waits for you'}
      </p>
    );
  }
  if (row.group === 'working') {
    return (
      <WorkingIndicator
        startedAt={activity.startedAt ?? undefined}
        facts={{
          tool:
            activity.runningTool === null
              ? undefined
              : runningToolLabel(activity.runningTool, thread.cwd),
          toolCalls: activity.toolCalls,
          tokens: undefined,
        }}
      />
    );
  }
  return (
    <p className="truncate text-xs text-muted-foreground">
      {activity.lastText ?? (activity.turnState === 'failed' ? 'The turn failed' : 'Ended')}
      {activity.endedAt && <span> · {relative(activity.endedAt)}</span>}
    </p>
  );
}

const rowSelector = '[data-at-work-row]';

export function ThreadsAtWork() {
  const { settings, layout } = useRuntime();
  const navigate = useNavigate();
  const threads = useTopic('threads');
  const activity = useTopic('threadActivity');
  const decisions = useTopic('decisions') ?? [];
  const projects = useTopic('projects') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const list = useRef<HTMLDivElement>(null);
  if (threads === undefined || activity === undefined) return null;
  const rows = atWorkRows(threads, activity, decisions);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ActivityIcon}
        title="Nothing at work"
        description="No thread works, waits for you or has a turn you have not read."
        action={
          <Button asChild size="sm">
            <Link to="/chat/new">
              <PlusIcon />
              New thread
              <ShortcutHint shortcut="keybindings.newThread" />
            </Link>
          </Button>
        }
      />
    );
  }
  const focusable = () => [...(list.current?.querySelectorAll<HTMLElement>(rowSelector) ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: AtWorkRow) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      const all = focusable();
      const at = all.indexOf(event.currentTarget);
      all[
        Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))
      ]?.focus();
      return;
    }
    const pressed = eventToBinding(event);
    const binding = settingValue(settings.getState().values, 'keybindings.threadToPanel');
    if (pressed && typeof binding === 'string' && binding !== '') {
      if (normalizeBinding(binding) === pressed) {
        event.preventDefault();
        openThreadTab(
          { settings, layout },
          { threadId: row.thread.id, title: row.thread.title, from: AT_WORK_PATH },
        );
      }
    }
  };
  let shownGroup: Group | undefined;
  return (
    <section
      aria-label="Threads at work"
      data-testid="threads-at-work"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <ActivityIcon aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Threads at work</h1>
        <span className="ml-auto text-2xs text-muted-foreground">
          Enter opens · <ShortcutHint shortcut="keybindings.threadToPanel" /> in the panel
        </span>
      </header>
      <div ref={list} className="flex flex-col gap-1 p-3">
        {rows.map((row) => {
          const heading = row.group !== shownGroup ? groupTitles[row.group] : undefined;
          shownGroup = row.group;
          return (
            <div key={row.thread.id} className="flex flex-col gap-1">
              {heading && (
                <h2
                  data-testid="at-work-group"
                  className="px-2 pt-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {heading}
                </h2>
              )}
              <button
                type="button"
                data-at-work-row=""
                data-testid="at-work-row"
                data-group={row.group}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  row.thread.seen === false && 'font-semibold',
                  row.depth === 1 && 'ml-6 border-l border-border',
                )}
                onClick={() =>
                  void navigate({ to: '/chat/$threadId', params: { threadId: row.thread.id } })
                }
                onKeyDown={(event) => onKeyDown(event, row)}
              >
                <span className="truncate text-sm">{row.thread.title}</span>
                <span className="truncate text-2xs font-normal text-muted-foreground">
                  {[
                    row.helperOf === undefined ? undefined : `Helper of ${row.helperOf}`,
                    where(row.thread, projects, runs),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="font-normal">
                  <RowLine row={row} />
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// "Show threads at work" and "Open thread in panel…" (spec 11, 15), and one search-only entry per
// thread, "In panel: <title>", that the second opens the palette on.
export function atWorkCommands({
  threads,
  openThreadId,
  route,
}: {
  readonly threads: readonly Thread[];
  readonly openThreadId: string | undefined;
  // The route of the view on screen, whose panel the thread opens in.
  readonly route: string;
}): AppCommand[] {
  return [
    {
      id: 'chat.threadsAtWork',
      title: 'Show threads at work',
      group: 'Chat',
      keywords: ['overview', 'running', 'working', 'agents', 'all threads', 'at work'],
      keybinding: 'keybindings.threadsAtWork',
      run: (context) => void context.navigate({ to: AT_WORK_PATH }),
    },
    {
      id: 'chat.openThreadInPanel',
      title: 'Open thread in panel…',
      group: 'Chat',
      keywords: ['panel', 'side by side', 'beside', 'second thread'],
      keybinding: 'keybindings.openThreadInPanel',
      run: (context) => context.layout.setState({ paletteOpen: true, paletteSearch: 'In panel: ' }),
    },
    ...threads
      .filter((thread) => thread.id !== openThreadId && thread.kind !== 'assistant')
      .map((thread): AppCommand => ({
        id: `panel-thread.${thread.id}`,
        title: `In panel: ${thread.title}`,
        group: 'Threads',
        searchOnly: true,
        keywords: ['panel', 'beside'],
        run: (context) =>
          openThreadTab(context, { threadId: thread.id, title: thread.title, from: route }),
      })),
  ];
}
