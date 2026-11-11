// Reads the text of intents/<id>/{intent,spec,plan}.md the way agent-os does
// (quality-ratchet/scripts/intent-files.mjs): the same frontmatter, unit line, note, contract and
// built_on rules. Line numbers are kept so a problem can point at its line.

export const intentIdPattern = /^\d{4}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const unitContractFields = [
  'Outcome',
  'Boundaries',
  'Change surface',
  'Acceptance',
  'Ground truth',
  'Dependencies',
  'Evidence and settled decisions',
  'Delivery target',
  'Open risks',
] as const;
export type UnitContractField = (typeof unitContractFields)[number];

const unitLine = /^-\s+\[([A-Za-z0-9][A-Za-z0-9._/-]*)\]\s+(.+)$/;
const dependsNote = /^depends on\s+(.+)$/i;
const blockedNote = /^blocked:\s*(.+)$/i;
const fieldLine = new RegExp(`^(${unitContractFields.join('|')})(?:\\s*\\([^)]*\\))?:\\s*(.*)$`);

// Windows editors and PowerShell often start a file with a byte order mark.
const splitLines = (text: string): string[] =>
  text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');

export interface Frontmatter {
  // Flat `key: value` pairs; values stay strings.
  readonly data: Readonly<Record<string, string>>;
  // The file line each key is on, 1-based.
  readonly lines: Readonly<Record<string, number>>;
  readonly body: string;
  // The file line the body starts on.
  readonly bodyLine: number;
}

export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = splitLines(text);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const data: Record<string, string> = {};
  const at: Record<string, number> = {};
  for (let index = 1; index < end; index += 1) {
    const entry = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(lines[index] ?? '');
    const key = entry?.[1];
    if (key === undefined) continue;
    data[key] = (entry?.[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    at[key] = index + 1;
  }
  return { data, lines: at, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

// A revision is a positive whole number a JavaScript number holds exactly; a longer run of digits
// is not one.
export function parseRev(value: string | undefined): number | null {
  if (!/^[1-9]\d*$/.test(value ?? '')) return null;
  const rev = Number(value);
  return Number.isSafeInteger(rev) ? rev : null;
}

export function parseBuiltOn(value: string | undefined, kind: 'intent' | 'spec'): number | null {
  const prefix = `${kind}@`;
  return value?.startsWith(prefix) ? parseRev(value.slice(prefix.length)) : null;
}

export interface UnitLine {
  readonly key: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly blocked: string | null;
  // The file line the unit is listed on.
  readonly line: number;
}

export interface UnitList {
  // The file line of the `## Units` heading.
  readonly headingLine: number;
  readonly units: readonly UnitLine[];
}

// Unit lines under `## Units`: `- [KEY] title`, optionally ` — depends on A, B` and
// ` — blocked: reason`. Null when the body has no `## Units` section.
export function parseUnits(body: string, bodyLine = 1): UnitList | null {
  const lines = splitLines(body);
  const start = lines.findIndex((line) => /^##\s+Units\s*$/.test(line));
  if (start < 0) return null;
  const units: UnitLine[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^##\s/.test(line)) break;
    const match = unitLine.exec(line.trim());
    const key = match?.[1];
    if (key === undefined) continue;
    const [title = '', ...notes] = (match?.[2] ?? '')
      // One space between words first: splitting on runs of whitespace around the dash takes
      // quadratic time on a line with a long run of spaces.
      .replace(/\s+/g, ' ')
      .split(/ (?:—|--) /);
    const dependsOn: string[] = [];
    let blocked: string | null = null;
    for (const note of notes) {
      const depends = dependsNote.exec(note.trim())?.[1];
      const reason = blockedNote.exec(note.trim())?.[1];
      if (depends !== undefined) {
        dependsOn.push(
          ...depends
            .split(',')
            .map((dependency) => dependency.trim())
            .filter((dependency) => dependency !== ''),
        );
      } else if (reason !== undefined) {
        blocked = reason.trim();
      }
    }
    units.push({ key, title: title.trim(), dependsOn, blocked, line: bodyLine + index });
  }
  return { headingLine: bodyLine + start, units };
}

export interface ContractField {
  readonly name: UnitContractField;
  readonly value: string;
}

// Each `### KEY title` section mapped to the contract fields it has, in the order written. A
// field's value runs until the next field.
export function unitContracts(body: string): Map<string, ContractField[]> {
  const contracts = new Map<string, { name: UnitContractField; value: string }[]>();
  let fields: { name: UnitContractField; value: string }[] | undefined;
  let field: { name: UnitContractField; value: string } | undefined;
  for (const line of splitLines(body)) {
    const heading = /^###\s+(\S+)/.exec(line)?.[1];
    if (heading !== undefined) {
      fields = [];
      field = undefined;
      contracts.set(heading, fields);
      continue;
    }
    if (/^##\s/.test(line)) fields = undefined;
    if (!fields) continue;
    const label = fieldLine.exec(line);
    if (label) {
      field = { name: label[1] as UnitContractField, value: label[2] ?? '' };
      fields.push(field);
    } else if (field) {
      field.value += `\n${line}`;
    }
  }
  for (const section of contracts.values()) {
    for (const entry of section) entry.value = entry.value.trim();
  }
  return contracts;
}

// The first `# ` heading of a body.
export function parseTitle(body: string): string | null {
  for (const line of splitLines(body)) {
    const title = /^#\s+(.+?)\s*$/.exec(line)?.[1];
    if (title !== undefined) return title;
  }
  return null;
}
