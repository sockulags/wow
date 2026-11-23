import {
  addDays,
  localDate,
  sameDate,
  startOfWeek,
  type LocalDate,
  type Project,
  type Thread,
  type Weekday,
} from '@wow/contracts';
import { groupThreads, type ThreadGroup } from './model';

// The thread list's groups (chat overview spec 9, 10, 12). By state: Needs you, Working, Idle and
// Done, with Idle and Done grouped under Today, Yesterday, This week and Older by when each
// thread was last active, pinned threads first above those. By project: one group per project,
// "Other folders" last. Each group has a key the folded setting names.

export interface ThreadSection {
  readonly key: string;
  readonly title: string;
  // The threads directly in this group, in order.
  readonly threads: readonly Thread[];
  readonly sections: readonly ThreadSection[];
  // Every thread in it, its subgroups' included.
  readonly count: number;
}

export type TimeGroup = 'today' | 'yesterday' | 'week' | 'older';

const timeTitles: Readonly<Record<TimeGroup, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  older: 'Older',
};

const stateKeys: Readonly<Record<ThreadGroup, string>> = {
  'Needs you': 'needs',
  Working: 'working',
  Idle: 'idle',
  Done: 'done',
};

const earlier = (a: LocalDate, b: LocalDate) =>
  a.year !== b.year ? a.year < b.year : a.month !== b.month ? a.month < b.month : a.day < b.day;

export function timeGroupOf(
  updatedAt: string,
  today: LocalDate,
  zone: string,
  firstDay: Weekday,
): TimeGroup {
  const day = localDate(new Date(updatedAt), zone);
  if (sameDate(day, today)) return 'today';
  if (sameDate(day, addDays(today, -1))) return 'yesterday';
  const week = startOfWeek(today, firstDay);
  return earlier(day, week) ? 'older' : 'week';
}

const section = (
  key: string,
  title: string,
  threads: readonly Thread[],
  sections: readonly ThreadSection[] = [],
): ThreadSection => ({
  key,
  title,
  threads,
  sections,
  count: threads.length + sections.reduce((sum, inner) => sum + inner.count, 0),
});

export interface SectionOptions {
  readonly groupBy: 'state' | 'project';
  readonly projects: readonly Project[];
  // The day it is in the user's zone, from the caller's clock.
  readonly today: LocalDate;
  readonly zone: string;
  readonly firstDay: Weekday;
}

function byTime(key: string, threads: readonly Thread[], options: SectionOptions) {
  const pinned = threads.filter((thread) => thread.pinned);
  const groups = new Map<TimeGroup, Thread[]>();
  for (const thread of threads) {
    if (thread.pinned) continue;
    const group = timeGroupOf(thread.updatedAt, options.today, options.zone, options.firstDay);
    groups.set(group, [...(groups.get(group) ?? []), thread]);
  }
  const order: readonly TimeGroup[] = ['today', 'yesterday', 'week', 'older'];
  return {
    pinned,
    sections: order.flatMap((group) => {
      const members = groups.get(group) ?? [];
      return members.length === 0 ? [] : [section(`${key}.${group}`, timeTitles[group], members)];
    }),
  };
}

const stateRank: Readonly<Record<Thread['state'], number>> = {
  needs_you: 0,
  working: 1,
  idle: 2,
  failed: 2,
  done: 3,
};

export function threadSections(
  threads: readonly Thread[],
  options: SectionOptions,
): ThreadSection[] {
  if (options.groupBy === 'project') {
    const names = new Map(options.projects.map((project) => [project.id, project.name]));
    const byProject = new Map<string, Thread[]>();
    for (const thread of threads) {
      const key = thread.projectId !== null && names.has(thread.projectId) ? thread.projectId : '';
      byProject.set(key, [...(byProject.get(key) ?? []), thread]);
    }
    const ordered = (members: readonly Thread[]) =>
      members.toSorted(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          stateRank[a.state] - stateRank[b.state] ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    return [...byProject]
      .toSorted(([a], [b]) =>
        a === '' ? 1 : b === '' ? -1 : (names.get(a) ?? '').localeCompare(names.get(b) ?? ''),
      )
      .map(([id, members]) =>
        section(
          id === '' ? 'project:other' : `project:${id}`,
          id === '' ? 'Other folders' : (names.get(id) ?? id),
          ordered(members),
        ),
      );
  }
  return groupThreads(threads).map(([group, members]) => {
    const key = stateKeys[group];
    if (group === 'Needs you' || group === 'Working') return section(key, group, members);
    const { pinned, sections } = byTime(key, members, options);
    return section(key, group, pinned, sections);
  });
}
