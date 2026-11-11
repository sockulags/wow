import { ToolCallItemPayload, type ThreadItem, type ToolKind } from '@wow/contracts';
import { formatElapsed } from '../view-model';

// Pure helpers for the tool rows (agent workbench spec 27 to 30, 91): what each row's one line
// says, its time, the last lines of its output and a group's summary. They read only wow's own
// fields; a call stored before tool kinds has none and is drawn as it was.

export type ToolPayload = ToolCallItemPayload;

// A path inside the thread's folder is shown relative to it.
export function shownPath(path: string, cwd: string): string {
  const folder = cwd.replace(/[\\/]+$/, '');
  if (folder !== '' && path.length > folder.length + 1 && path.startsWith(folder)) {
    const separator = path.charAt(folder.length);
    if (separator === '/' || separator === '\\') return path.slice(folder.length + 1);
  }
  return path;
}

const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').replaceAll('\\', '/') === b.replace(/[\\/]+$/, '').replaceAll('\\', '/');

// The folder a command ran in, only when it is not the thread's own.
export const otherFolder = (payload: ToolPayload, cwd: string): string | undefined =>
  payload.cwd !== undefined && !sameFolder(payload.cwd, cwd) ? payload.cwd : undefined;

// "0.3 s", "4.2 s", "42 s", then the clock: "1:32".
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  return formatElapsed(ms);
}

// How long a call took or, while it runs, has taken so far: the provider's measure where it gave
// one, else the server's start and end.
export function toolDuration(payload: ToolPayload, now: number): number | undefined {
  if (payload.durationMs !== undefined) return payload.durationMs;
  if (payload.startedAt === undefined) return undefined;
  const started = Date.parse(payload.startedAt);
  if (payload.endedAt !== undefined) return Date.parse(payload.endedAt) - started;
  return payload.status === 'running' ? now - started : undefined;
}

// What a finished command ended with: its exit code where the provider gives one, else
// "failed" or "done".
export function commandOutcome(payload: ToolPayload): string | undefined {
  if (payload.status === 'running') return undefined;
  if (payload.exitCode !== undefined) return `exit ${payload.exitCode}`;
  return payload.status === 'error' ? 'failed' : 'done';
}

const lineRange = (lines: ToolPayload['lines']): string =>
  lines === undefined
    ? ''
    : lines.to === undefined
      ? ` from line ${lines.from}`
      : ` lines ${lines.from}-${lines.to}`;

// A web address without its scheme, as a row names it: "example.org/tea".
export const shownAddress = (url: string): string =>
  url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');

// The one line of a read, search or web call: "Read README.md lines 1-80", "Search kettle in
// src", "Fetch example.org".
export function oneLine(payload: ToolPayload, cwd: string): string {
  switch (payload.kind) {
    case 'read':
      return `Read ${payload.path === undefined ? payload.name : shownPath(payload.path, cwd)}${lineRange(payload.lines)}`;
    case 'search': {
      const where = payload.path === undefined ? '' : ` in ${shownPath(payload.path, cwd)}`;
      return `Search ${payload.pattern ?? ''}${where}`.trimEnd();
    }
    case 'web':
      return payload.url !== undefined
        ? `Fetch ${shownAddress(payload.url)}`
        : `Search the web for ${payload.query ?? ''}`.trimEnd();
    case 'edit':
      return `Edit ${payload.path === undefined ? '' : shownPath(payload.path, cwd)}`.trimEnd();
    default:
      return payload.name;
  }
}

// An MCP call's arguments as key: value pairs; text stays text, the rest is JSON.
export function argumentList(input: unknown): Array<readonly [string, string]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  return Object.entries(input).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)),
  ]);
}

// The last `count` lines of an output, and how many it has.
export function lastLines(output: string, count: number): { shown: string; total: number } {
  const lines = output.replace(/\n$/, '').split('\n');
  return { shown: lines.slice(-count).join('\n'), total: output === '' ? 0 : lines.length };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type SummaryPart = 'read' | 'search' | 'command' | 'fetch' | 'websearch' | 'edit' | 'tool';

const partOf = (payload: ToolPayload): SummaryPart => {
  const kind: ToolKind | undefined = payload.kind;
  if (kind === 'web') return payload.url !== undefined ? 'fetch' : 'websearch';
  return kind === 'read' || kind === 'search' || kind === 'command' || kind === 'edit'
    ? kind
    : 'tool';
};

const partText: Readonly<Record<SummaryPart, (count: number) => string>> = {
  read: (count) => `read ${plural(count, 'file', 'files')}`,
  search: (count) => `searched ${plural(count, 'time', 'times')}`,
  command: (count) => `ran ${plural(count, 'command', 'commands')}`,
  fetch: (count) => `fetched ${plural(count, 'page', 'pages')}`,
  websearch: (count) => `searched the web ${plural(count, 'time', 'times')}`,
  edit: (count) => `edited ${plural(count, 'file', 'files')}`,
  tool: (count) => `used ${plural(count, 'tool', 'tools')}`,
};

export const payloadOf = (item: ThreadItem): ToolPayload | undefined => {
  const parsed = ToolCallItemPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : undefined;
};

// What a closed group did, in the order it did it: "Read 2 files, ran 1 command".
export function groupSummary(payloads: readonly ToolPayload[]): string {
  const counts = new Map<SummaryPart, number>();
  for (const payload of payloads) {
    const part = partOf(payload);
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const text = [...counts].map(([part, count]) => partText[part](count)).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
