import { SetupFile, setupFileVersion, type SetupProblem } from '@wow/contracts';
import {
  Document,
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
} from 'yaml';
import type { z } from 'zod';

// Reading a setup file's text: YAML into the file's schema, with the line of everything that is
// wrong (app assistant spec 23). Pure; the text never touches the disk here.

export type SetupPath = readonly (string | number)[];

export interface ParsedSetup {
  readonly file: SetupFile;
  // The line (from 1) of the key or item at a path, or of the nearest part of it the file has.
  lineOf(path: SetupPath): number | null;
  // Every string in the file with its line, for the secret check.
  readonly strings: readonly { readonly text: string; readonly line: number | null }[];
}

export type SetupParse =
  | { readonly outcome: 'parsed'; readonly parsed: ParsedSetup }
  | { readonly outcome: 'refused'; readonly problems: SetupProblem[] };

const refused = (problems: SetupProblem[]): SetupParse => ({ outcome: 'refused', problems });

// A file made on another platform may start with a byte order mark and end lines with CRLF;
// neither changes what it says.
const withoutMark = (text: string) => (text.startsWith('﻿') ? text.slice(1) : text);

// The node at a path and the line of its key, or of the last node the path reached.
function locate(document: Document, counter: LineCounter, path: SetupPath): number | null {
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? null : counter.linePos(offset).line;
  let node: unknown = document.contents;
  let line = lineAt((document.contents as Node | null)?.range?.[0]);
  for (const part of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === part);
      if (!pair) return line;
      line = lineAt((pair.key as Node).range?.[0]) ?? line;
      node = pair.value;
    } else if (isSeq(node) && typeof part === 'number') {
      const item = node.items[part];
      if (!item) return line;
      line = lineAt((item as Node).range?.[0]) ?? line;
      node = item;
    } else {
      return line;
    }
  }
  return line;
}

function stringsOf(document: Document, counter: LineCounter): ParsedSetup['strings'] {
  const found: { text: string; line: number | null }[] = [];
  const walk = (node: unknown) => {
    if (isScalar(node)) {
      if (typeof node.value === 'string') {
        const offset = node.range?.[0];
        found.push({
          text: node.value,
          line: offset === undefined ? null : counter.linePos(offset).line,
        });
      }
    } else if (isMap(node)) {
      for (const pair of node.items) {
        walk(pair.key);
        walk(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(document.contents);
  return found;
}

// Where a schema issue is, in words a person finds in the file.
export function whereIn(file: unknown, path: SetupPath): string {
  const [section, at, inner, step] = path;
  if (section === 'settings' && typeof at === 'string') return `Setting ${at}`;
  if (section === 'workflows' && typeof at === 'number') {
    const workflows = (file as { workflows?: unknown }).workflows;
    const entry = Array.isArray(workflows) ? (workflows[at] as { name?: unknown }) : undefined;
    const name =
      typeof entry?.name === 'string' ? `Workflow "${entry.name}"` : `Workflow ${at + 1}`;
    return inner === 'steps' && typeof step === 'number' ? `${name}, step ${step + 1}` : name;
  }
  if (section === 'toFillIn') return 'toFillIn';
  return 'The file';
}

export function issueProblems(
  issues: readonly z.core.$ZodIssue[],
  base: SetupPath,
  value: unknown,
  lineOf: (path: SetupPath) => number | null,
): SetupProblem[] {
  return issues.map((issue) => {
    const path = [...base, ...issue.path.filter((part) => typeof part !== 'symbol')];
    if (issue.code === 'unrecognized_keys') {
      const [key = ''] = issue.keys;
      return {
        line: lineOf([...path, key]),
        reason: `${whereIn(value, path)} has a key wow does not know: "${issue.keys.join('", "')}"`,
      };
    }
    return { line: lineOf(path), reason: `${whereIn(value, path)}: ${issue.message}` };
  });
}

export function parseSetup(text: string): SetupParse {
  const counter = new LineCounter();
  const document = parseDocument(withoutMark(text), {
    lineCounter: counter,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return refused(
      document.errors.map((error) => ({
        line: counter.linePos(error.pos[0]).line,
        reason: `This is not readable YAML: ${error.message.split('\n')[0] ?? error.code}`,
      })),
    );
  }
  const lineOf = (path: SetupPath) => locate(document, counter, path);
  const lineAt = (node: Node | null | undefined) => {
    const offset = node?.range?.[0];
    return offset === undefined ? null : counter.linePos(offset).line;
  };
  // A key "__proto__" does not become a key of the value read, so it would pass unseen.
  const hidden: SetupProblem[] = [];
  visit(document, {
    Pair(_key, pair, path) {
      if (!isScalar(pair.key) || pair.key.value !== '__proto__') return;
      const parent = path.at(-1);
      const inSettings =
        isMap(document.contents) &&
        document.contents.items.some(
          (item) => isScalar(item.key) && item.key.value === 'settings' && item.value === parent,
        );
      hidden.push({
        line: lineAt(pair.key),
        reason: inSettings
          ? 'Unknown setting __proto__'
          : 'The file has a key wow does not know: "__proto__"',
      });
    },
  });
  if (hidden.length > 0) return refused(hidden);
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    // Aliases of aliases can stand for far more than the text holds; the YAML library stops at
    // the count and wow refuses the file rather than read it.
    let first: number | null = null;
    visit(document, {
      Alias(_key, alias) {
        first = lineAt(alias);
        return visit.BREAK;
      },
    });
    return refused([
      {
        line: first,
        reason:
          'The file repeats aliases (*name) more than wow reads; write the values out instead',
      },
    ]);
  }
  if (value === null || value === undefined) {
    return refused([{ line: null, reason: 'The file is empty' }]);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return refused([{ line: lineOf([]), reason: 'This is not a wow setup file' }]);
  }
  // The version comes first: a newer file may well have keys this wow does not know.
  const { version, wow } = value as { version?: unknown; wow?: unknown };
  if (version === undefined) {
    return refused([
      { line: null, reason: 'The file has no version key, so it is not a wow setup file' },
    ]);
  }
  if (typeof version === 'number' && Number.isInteger(version) && version > setupFileVersion) {
    const needs = typeof wow === 'string' && wow !== '' ? `wow ${wow} or newer` : 'a newer wow';
    return refused([
      {
        line: lineOf(['version']),
        reason: `This setup file is version ${version} and needs ${needs}; this wow reads version ${setupFileVersion}. Update wow, then read the file again.`,
      },
    ]);
  }
  const file = SetupFile.safeParse(value);
  if (!file.success) return refused(issueProblems(file.error.issues, [], value, lineOf));
  return {
    outcome: 'parsed',
    parsed: { file: file.data, lineOf, strings: stringsOf(document, counter) },
  };
}

// The file as text: comments that say what it is, then the keys in a fixed order.
export function setupText(file: SetupFile): string {
  const document = new Document(file);
  document.commentBefore = [
    ' A wow setup file. It holds no secret, project folder or account name.',
    ' Read it in Settings → Advanced → Start from a setup file; each key under',
    ' toFillIn is a secret to fill in there afterwards.',
  ].join('\n');
  return document.toString({ lineWidth: 0 });
}
