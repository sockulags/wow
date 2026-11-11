import type { AppCommand, CommandGroup } from './commands';

// How the palette lists and ranks commands (audit C-13). Pure, so it is tested without a DOM.

// "Calendar: today" reads "Today" under the Calendar heading; the group says the rest.
export function displayTitle(command: Pick<AppCommand, 'title' | 'group'>): string {
  const prefix = `${command.group}: `;
  if (!command.title.startsWith(prefix)) return command.title;
  const rest = command.title.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

// A title match ranks above a match in the group, detail or keywords, and a match at the start
// of the title above one in the middle. Every typed word has to appear somewhere.
export function paletteScore(command: AppCommand, query: string): number {
  const typed = words(query);
  if (typed.length === 0) return 1;
  const title = displayTitle(command).toLowerCase();
  const full = [
    command.title,
    command.value ?? '',
    command.group,
    command.detail ?? '',
    ...(command.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase();
  const needle = typed.join(' ');
  if (title.startsWith(needle)) return 1;
  if (title.split(/\s+/).some((word) => word.startsWith(needle))) return 0.9;
  if (title.includes(needle)) return 0.8;
  if (typed.every((word) => title.includes(word))) return 0.7;
  if (typed.every((word) => full.includes(word))) {
    // More of the typed words in the title is the better match.
    const inTitle = typed.filter((word) => title.includes(word)).length;
    return 0.3 + (0.3 * inTitle) / typed.length;
  }
  return 0;
}

const viewGroups: Readonly<Record<string, readonly CommandGroup[]>> = {
  Calendar: ['Calendar'],
  Chat: ['Chat'],
  Workflows: ['Workflows'],
  Plans: ['Plans'],
  Backlog: ['Backlog'],
  Assistant: ['Assistant'],
  Settings: ['Settings'],
};

// What the palette lists before anything is typed: what needs the user, what they touched last,
// the open view's actions, and the views to go to. Lists of things (threads, cards, items) and
// commands marked search-only wait for a query.
export function startList(
  commands: readonly AppCommand[],
  viewTitle: string | undefined,
  recentCount: number,
): ReadonlyArray<readonly [string, readonly AppCommand[]]> {
  const needsYou = commands.filter((command) => command.needsYou);
  const taken = new Set(needsYou.map((command) => command.id));
  const recent = commands
    .filter((command) => command.recentAt !== undefined && !taken.has(command.id))
    .toSorted((a, b) => (b.recentAt ?? '').localeCompare(a.recentAt ?? ''))
    .slice(0, recentCount);
  for (const command of recent) taken.add(command.id);
  const groups = viewTitle ? (viewGroups[viewTitle] ?? []) : [];
  const actions = commands.filter(
    (command) =>
      !taken.has(command.id) &&
      !command.searchOnly &&
      command.recentAt === undefined &&
      groups.includes(command.group),
  );
  const navigation = commands.filter((command) => command.group === 'Navigation');
  return [
    ['Needs you', needsYou],
    ['Recent', recent],
    [viewTitle ? `In ${viewTitle}` : 'Actions', actions],
    ['Go to', navigation],
  ];
}
