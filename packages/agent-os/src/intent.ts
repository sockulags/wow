import {
  intentIdPattern,
  parseBuiltOn,
  parseFrontmatter,
  parseRev,
  parseTitle,
  parseUnits,
  unitContracts,
  type ContractField,
  type Frontmatter,
} from './parse.js';

export type IntentFileKind = 'intent' | 'spec' | 'plan';
export const intentFileKinds = ['intent', 'spec', 'plan'] as const;
export const intentFileName = (kind: IntentFileKind): string => `${kind}.md`;

export type PlanSource = 'files' | 'issues';

// The text of each file an intent folder has.
export interface IntentTexts {
  readonly id: string;
  readonly intent?: string | undefined;
  readonly spec?: string | undefined;
  readonly plan?: string | undefined;
}

export interface IntentProblem {
  readonly file: IntentFileKind;
  readonly line: number;
  readonly message: string;
}

// Built on an older revision than its source file is at now.
export interface Staleness {
  readonly builtOn: number;
  readonly current: number;
}

export interface DerivedFile {
  readonly rev: number | null;
  readonly status: string | null;
  readonly stale: Staleness | null;
}

export interface PlanUnit {
  readonly key: string;
  readonly title: string;
  readonly line: number;
  readonly dependsOn: readonly string[];
  readonly blocked: string | null;
  // The fields of the unit's `### KEY` section; null when the plan keeps contracts in issues or
  // has no section for the unit.
  readonly contract: readonly ContractField[] | null;
}

export interface IntentDocument {
  readonly id: string;
  readonly title: string;
  readonly hasIntent: boolean;
  readonly status: string | null;
  readonly rev: number | null;
  readonly spec: DerivedFile | null;
  readonly plan: DerivedFile | null;
  readonly source: PlanSource | null;
  readonly units: readonly PlanUnit[];
  readonly problems: readonly IntentProblem[];
}

const upstream = { spec: 'intent', plan: 'spec' } as const;

// Reads one intent folder's files. Nothing throws: what cannot be read becomes a problem with the
// line it is on, and everything that can be read is still returned.
export function readIntent(texts: IntentTexts): IntentDocument {
  const problems: IntentProblem[] = [];
  const front: Partial<Record<IntentFileKind, Frontmatter | null>> = {};
  for (const kind of intentFileKinds) {
    const text = texts[kind];
    if (text === undefined) continue;
    const parsed = parseFrontmatter(text);
    front[kind] = parsed;
    if (!parsed) {
      problems.push({ file: kind, line: 1, message: 'Missing frontmatter between --- lines' });
    } else if (parseRev(parsed.data['rev']) === null) {
      problems.push({
        file: kind,
        line: parsed.lines['rev'] ?? 1,
        message: 'rev must be a positive whole number',
      });
    }
  }
  if (!intentIdPattern.test(texts.id)) {
    problems.push({
      file: texts.intent === undefined ? (texts.spec === undefined ? 'plan' : 'spec') : 'intent',
      line: 1,
      message: 'Folder name must be <YYYY-MM>-<slug> in lowercase kebab-case',
    });
  }

  const derived = (kind: 'spec' | 'plan'): DerivedFile | null => {
    if (texts[kind] === undefined) return null;
    const file = front[kind];
    if (!file) return { rev: null, status: null, stale: null };
    const source = upstream[kind];
    const builtOn = parseBuiltOn(file.data['built_on'], source);
    const current = parseRev(front[source]?.data['rev']);
    if (builtOn === null) {
      problems.push({
        file: kind,
        line: file.lines['built_on'] ?? 1,
        message: `built_on must look like ${source}@<rev>`,
      });
    }
    return {
      rev: parseRev(file.data['rev']),
      status: file.data['status'] ?? null,
      stale:
        builtOn !== null && current !== null && builtOn < current ? { builtOn, current } : null,
    };
  };

  const spec = derived('spec');
  const plan = derived('plan');
  const { source, units } = readPlan(front.plan, problems);
  const intent = front.intent;
  const title =
    [intent, front.spec, front.plan]
      .map((file) => (file ? parseTitle(file.body) : null))
      .find((found) => found !== null) ?? texts.id;
  return {
    id: texts.id,
    title,
    hasIntent: texts.intent !== undefined,
    status: intent?.data['status'] ?? null,
    rev: parseRev(intent?.data['rev']),
    spec,
    plan,
    source,
    units,
    problems,
  };
}

function readPlan(
  file: Frontmatter | null | undefined,
  problems: IntentProblem[],
): { source: PlanSource | null; units: PlanUnit[] } {
  if (!file) return { source: null, units: [] };
  const problem = (line: number, message: string) => problems.push({ file: 'plan', line, message });
  const declared = file.data['source'];
  const source = declared === 'files' || declared === 'issues' ? declared : null;
  if (!source) problem(file.lines['source'] ?? 1, 'source must be files or issues');

  const list = parseUnits(file.body, file.bodyLine);
  if (!list) {
    problem(file.bodyLine, 'Needs a "## Units" section with at least one "- [KEY] title" line');
    return { source, units: [] };
  }
  if (list.units.length === 0) {
    problem(list.headingLine, '"## Units" has no "- [KEY] title" lines');
    return { source, units: [] };
  }
  const keys = new Set<string>();
  for (const unit of list.units) {
    if (keys.has(unit.key)) problem(unit.line, `Unit key ${unit.key} appears twice`);
    keys.add(unit.key);
  }
  // With `source: issues` the issue tracker holds dependencies and contracts, so the plan file
  // says key and title only. A `blocked:` note on the line is still kept: it decides the unit's
  // status, and dropping it would report a blocked unit as unknown.
  if (source !== 'files') {
    return {
      source,
      units: list.units.map(({ key, title, line, blocked }) => ({
        key,
        title,
        line,
        dependsOn: [],
        blocked,
        contract: null,
      })),
    };
  }
  const contracts = unitContracts(file.body);
  const units = list.units.map((unit) => {
    for (const dependency of unit.dependsOn) {
      if (!keys.has(dependency)) {
        problem(unit.line, `Unit ${unit.key} depends on unknown unit ${dependency}`);
      }
    }
    const contract = contracts.get(unit.key) ?? null;
    if (!contract) {
      problem(unit.line, `Unit ${unit.key} needs a "### ${unit.key} <title>" section`);
    }
    return { ...unit, contract };
  });
  return { source, units };
}

// What the files alone say about a unit: blocked when its line has a `blocked:` note, otherwise
// nothing is known without a host.
export const fileStatus = (unit: Pick<PlanUnit, 'blocked'>): 'blocked' | 'unknown' =>
  unit.blocked === null ? 'unknown' : 'blocked';
