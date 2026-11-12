import type { ToolFacts } from '@wow/contracts';
import { inputDiff } from './diff.js';

// What wow draws for a Claude Code tool call (agent workbench spec 27 to 29): the kind and the
// facts read from the tool's input. Claude Code's Bash result has no exit code and no duration,
// so a command carries neither; the server measures the time.

const text = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const count = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
};

const defined = (facts: ToolFacts): ToolFacts =>
  Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) as ToolFacts;

// Read's offset is the first line (1-based) and limit how many lines it reads.
function readLines(input: Record<string, unknown>): ToolFacts['lines'] {
  const offset = count(input, 'offset');
  const limit = count(input, 'limit');
  if (offset === undefined && limit === undefined) return undefined;
  const from = Math.max(1, offset ?? 1);
  return limit === undefined || limit === 0 ? { from } : { from, to: from + limit - 1 };
}

export function claudeToolFacts(name: string, input: unknown): ToolFacts {
  const fields: Record<string, unknown> =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp?.[1] && mcp[2]) return { kind: 'mcp', server: mcp[1], tool: mcp[2] };
  switch (name) {
    case 'Bash':
      return defined({ kind: 'command', command: text(fields, 'command') });
    case 'Read':
      return defined({ kind: 'read', path: text(fields, 'file_path'), lines: readLines(fields) });
    case 'NotebookRead':
      return defined({ kind: 'read', path: text(fields, 'notebook_path') });
    case 'Grep':
    case 'Glob':
      return defined({
        kind: 'search',
        pattern: text(fields, 'pattern'),
        path: text(fields, 'path'),
      });
    case 'WebFetch':
      return defined({ kind: 'web', url: text(fields, 'url') });
    case 'WebSearch':
      return defined({ kind: 'web', query: text(fields, 'query') });
    case 'Edit':
    case 'MultiEdit':
      return defined({
        kind: 'edit',
        path: text(fields, 'file_path'),
        diff: inputDiff(name, input) || undefined,
      });
    case 'Write': {
      // Before it runs only the new content is known, whether or not the file exists.
      const diff = inputDiff(name, input) || undefined;
      return defined({
        kind: 'edit',
        path: text(fields, 'file_path'),
        diff,
        diffWithoutFile: diff === undefined ? undefined : true,
      });
    }
    case 'NotebookEdit':
      return defined({ kind: 'edit', path: text(fields, 'notebook_path') });
    default:
      return { kind: 'other' };
  }
}
