import {
  Command,
  SecretRef,
  findSecret,
  hideSecretsDeep,
  isBuiltInSkillName,
  settingGroupTitles,
  type AssistantProposalLine,
  providerKindLabels,
  type OwnSkill,
  type ProviderKind,
  type SetupFillIn,
  type SetupLine,
  type SetupMark,
  type SetupPreview,
  type SetupProblem,
  type SetupWorkflow,
  type SkillRef,
  type Workflow,
  type WorkflowStep,
  withoutAddressAccount,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { patternsOf, settingPlace, show } from '../assistant/changes.js';
import { skillInstalled } from '../assistant/readers.js';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import { readableSize } from '../files/read.js';
import { resolveStored } from '../settings/service.js';
import { issueProblems, parseSetup, type ParsedSetup } from './file.js';

// What a setup file would do on this install (app assistant spec 22, 23): the commands that
// apply it, in the order they run, and the preview the user confirms. Pure: it reads the
// projections and decides each command once on them without storing anything, so a command the
// app would refuse refuses the file now, with the line it came from.

export type SetupPlan =
  | {
      readonly outcome: 'ready';
      readonly preview: SetupPreview;
      readonly commands: readonly Command[];
    }
  | { readonly outcome: 'refused'; readonly problems: readonly SetupProblem[] };

const personalReasons = {
  account: 'is an account name, which each person fills in for themselves',
  machine: 'only fits the computer it was set on',
  person: 'is for each person to set for themselves',
} as const;

// The problems as one sentence, for a refused `setup.apply`.
export const problemsText = (problems: readonly SetupProblem[]): string =>
  problems
    .map((problem) =>
      problem.line === null ? problem.reason : `Line ${problem.line}: ${problem.reason}`,
    )
    .join('; ');

// A value as a preview line says it: lists of named things by their names.
function shown(key: string, value: unknown, read: ReadModel): string {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'object' && item !== null && 'name' in item)
  ) {
    return value.map((item) => String((item as { name: unknown }).name)).join(', ');
  }
  return show(key, value, read);
}

// The whole value as the file holds it, for a line whose short text leaves something out.
const fullText = (value: unknown): string =>
  typeof value === 'string' ? value : stringify(value, { lineWidth: 0 }).trimEnd();

const withFull = (line: AssistantProposalLine, value: unknown): SetupLine => {
  const full = fullText(value);
  return full === '' || full === line.to ? line : { ...line, full };
};

const stepsText = (steps: readonly { skillName: string }[]): string =>
  `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}: ${steps.map((step) => step.skillName).join(', ')}`;

interface WorkflowPlan {
  readonly command: Command;
  readonly line: SetupLine;
  readonly replaces: boolean;
  readonly marks: readonly SetupMark[];
}

// The workflow the file entry stands for here: the one with its id, else the only one with its
// name that no other entry took.
function matchOf(
  entry: SetupWorkflow,
  local: readonly Workflow[],
  taken: ReadonlySet<string>,
): Workflow | undefined {
  const byId = local.find((workflow) => workflow.id === entry.id);
  if (byId) return byId;
  const named = local.filter((workflow) => workflow.name === entry.name && !taken.has(workflow.id));
  return named.length === 1 ? named[0] : undefined;
}

// A step's skill is found the way a run finds it (wow skills spec 15): a wow skill only among
// wow skills, a built-in name without a source as the built-in one, anything else in folders.
function refInstalled(ref: SkillRef, read: ReadModel, fileSkills: readonly string[]): boolean {
  const source = ref.source ?? (isBuiltInSkillName(ref.name) ? 'wow' : undefined);
  const listed = read.skills();
  if (source === 'yours' && fileSkills.includes(ref.name)) return true;
  if (source !== undefined) {
    return listed.some((skill) => skill.source === source && skill.name === ref.name);
  }
  const folders = listed.filter((skill) => skill.source !== 'wow' && skill.source !== 'yours');
  return skillInstalled(
    ref.name,
    folders.map((skill) => skill.name),
  );
}

function planWorkflow(
  entry: SetupWorkflow,
  match: Workflow | undefined,
  read: ReadModel,
  // Own skills the same file brings, which are there once it is applied.
  fileSkills: readonly string[],
): WorkflowPlan | undefined {
  const instances = read.providerInstances();
  const marks: SetupMark[] = [];
  const missingKinds = new Set<ProviderKind>();
  const steps: WorkflowStep[] = entry.steps.map(({ provider, ...step }) => {
    // The instance the step already uses keeps it, so a file read back where it was written
    // changes nothing; otherwise the first instance of that kind.
    const was = match?.steps.find((old) => old.id === step.id)?.providerInstanceId;
    const kept = was && read.providerInstance(was)?.kind === provider ? was : undefined;
    const first = instances.find((instance) => instance.kind === provider)?.id;
    if (!kept && !first) missingKinds.add(provider);
    return { ...step, providerInstanceId: kept ?? first ?? provider };
  });
  const missingSkills = [
    ...new Set(
      steps
        .flatMap((step): SkillRef[] => [
          { name: step.skillName, ...(step.skillSource ? { source: step.skillSource } : {}) },
          ...(step.alsoFollow ?? []),
        ])
        .filter((ref) => !refInstalled(ref, read, fileSkills))
        .map((ref) => ref.name),
    ),
  ];
  for (const skill of missingSkills) {
    marks.push({ workflow: entry.name, reason: `skill not installed: ${skill}` });
  }
  for (const kind of missingKinds) {
    marks.push({
      workflow: entry.name,
      reason: `no ${providerKindLabels[kind]} instance here yet; choose one for its steps in the workflow`,
    });
  }
  const what = `Workflow "${entry.name}"`;
  if (!match) {
    return {
      command: Command.parse({
        type: 'workflow.create',
        workflowId: entry.id,
        name: entry.name,
        ...(entry.templateKind ? { templateKind: entry.templateKind } : {}),
        steps,
        ...(entry.ownWorkingCopy ? { ownWorkingCopy: true } : {}),
        ...(entry.forUnits ? { forUnits: true } : {}),
        ...(typeof entry.maxStepVisits === 'number' ? { maxStepVisits: entry.maxStepVisits } : {}),
      }),
      line: withFull({ what, from: null, to: stepsText(steps) }, entry),
      replaces: false,
      marks,
    };
  }
  const next = {
    name: entry.name,
    templateKind: entry.templateKind ?? null,
    steps,
    ownWorkingCopy: entry.ownWorkingCopy ?? false,
    forUnits: entry.forUnits ?? false,
    maxStepVisits: entry.maxStepVisits ?? null,
  };
  const now = {
    name: match.name,
    templateKind: match.templateKind,
    steps: match.steps,
    ownWorkingCopy: match.ownWorkingCopy ?? false,
    forUnits: match.forUnits ?? false,
    maxStepVisits: match.maxStepVisits ?? null,
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => !isDeepStrictEqual(next[key], now[key]),
  );
  if (changed.length === 0) return undefined;
  const words = (row: typeof next) =>
    changed
      .map((key) =>
        key === 'steps' ? stepsText(row.steps) : `${key}: ${show(key, row[key], read)}`,
      )
      .join('; ');
  const from = words(now);
  const to = words(next);
  return {
    command: Command.parse({ type: 'workflow.update', workflowId: match.id, ...next }),
    line: withFull(
      {
        what: `Workflow "${match.name}"`,
        from,
        // Steps that differ only in what the count and names do not say.
        to: to === from ? `${to} (the steps' settings differ)` : to,
      },
      entry,
    ),
    replaces: true,
    marks,
  };
}

// An own skill from the file: a new one, or the text of the one with its name put in place.
// The name rule is the app's own, applied when the command is decided below.
function planSkill(
  skill: OwnSkill,
  read: ReadModel,
): { command: Command; line: SetupLine; replaces: boolean } | undefined {
  const what = `Skill "${skill.name}"`;
  const description = skill.description.trim();
  const text = skill.text.trim();
  const own = read.skills().find((entry) => entry.source === 'yours' && entry.name === skill.name);
  const command: Command = {
    type: own ? 'skill.update' : 'skill.create',
    skill: { name: skill.name, description, text },
  };
  // The text is what steers agents, so the preview always keeps all of it.
  const full = (line: AssistantProposalLine): SetupLine => ({ ...line, full: text });
  if (!own) {
    return {
      command,
      line: full({ what, from: null, to: show('description', description, read) }),
      replaces: false,
    };
  }
  if (own.description === description && (own.text ?? '') === text) return undefined;
  const from = show('description', own.description, read);
  const to = show('description', description, read);
  return {
    command,
    // A skill whose description stays says that its text is what changes.
    line: full({ what, from, to: from === to ? `${to} (the text differs)` : to }),
    replaces: true,
  };
}

function checkSecrets(parsed: ParsedSetup, patterns: readonly RegExp[]): SetupProblem[] {
  const problems: SetupProblem[] = [];
  for (const { text, line } of parsed.strings) {
    const found = findSecret(text, patterns);
    if (found) {
      problems.push({
        line,
        reason: `This looks like a secret (${found.kind}); a setup file never holds one. Put the value in its field in Settings instead`,
      });
    } else if (withoutAddressAccount(text) !== text) {
      problems.push({
        line,
        reason:
          'This address has a user name or password written into it; a setup file never holds one. Write the address without it and put the token in its field in Settings',
      });
    }
  }
  return problems;
}

const trackerAddress = /^trackers\.(jira|github|gitlab|confluence)\.baseUrl$/;

const hostOf = (address: unknown): string | null => {
  if (typeof address !== 'string' || address.trim() === '') return null;
  try {
    return new URL(address.trim()).host.toLowerCase();
  } catch {
    return null;
  }
};

// What a global value from the file lets go further than before (spec 22): a stored token that
// would be sent to another host, globally or for a project that keeps its own token but takes
// the global address, and scripts in HTML files turned on.
function warningsOf(
  key: string,
  value: unknown,
  read: ReadModel,
  context: DecideContext,
): string[] {
  if (key === 'viewer.htmlScripts') {
    return value === true
      ? [
          `"${context.registry[key]?.label ?? key}" is turned on: an HTML file opened in the viewer runs its scripts.`,
        ]
      : [];
  }
  const service = trackerAddress.exec(key)?.[1];
  const host = hostOf(value);
  if (service === undefined || host === null) return [];
  const label = context.registry[key]?.label ?? key;
  const tokenKey = `trackers.${service}.token`;
  const tokenAt = (scope: string) =>
    SecretRef.safeParse(read.setting(tokenKey, scope)?.value).success;
  const globalAddress = read.setting(key, 'global')?.value ?? context.registry[key]?.default;
  const found: string[] = [];
  if (tokenAt('global') && hostOf(globalAddress) !== host) {
    found.push(`${label} changes to ${host}: the token stored here will be sent to ${host}.`);
  }
  for (const project of read.projects()) {
    const scope = `project:${project.id}`;
    if (!tokenAt(scope) || read.setting(key, scope) !== undefined) continue;
    if (hostOf(globalAddress) === host) continue;
    found.push(
      `${label} changes to ${host} for project ${project.name}, which takes the global address: the token stored for it will be sent to ${host}.`,
    );
  }
  return found;
}

const MAX_BYTES_KEY = 'advanced.setupFileMaxBytes';

// A file past `advanced.setupFileMaxBytes` is refused before the YAML is read.
function sizeProblem(text: string, read: ReadModel, context: DecideContext): SetupProblem | null {
  const definition = context.registry[MAX_BYTES_KEY];
  if (!definition) return null;
  const { value } = resolveStored(MAX_BYTES_KEY, definition, {}, (scope) =>
    read.setting(MAX_BYTES_KEY, scope),
  );
  const size = Buffer.byteLength(text, 'utf8');
  if (typeof value !== 'number' || size <= value) return null;
  return {
    line: null,
    reason: `The file is ${readableSize(size)}; a setup file may be at most ${readableSize(value)} (Settings → ${settingGroupTitles[definition.group]} → ${definition.label}).`,
  };
}

export function planSetup(text: string, read: ReadModel, context: DecideContext): SetupPlan {
  const tooLarge = sizeProblem(text, read, context);
  if (tooLarge) return { outcome: 'refused', problems: [tooLarge] };
  const reading = parseSetup(text);
  if (reading.outcome === 'refused') return reading;
  const { parsed } = reading;
  const { file } = parsed;
  const patterns = patternsOf(read, context);
  const problems: SetupProblem[] = checkSecrets(parsed, patterns);
  const added: SetupLine[] = [];
  const replaced: SetupLine[] = [];
  const warnings: string[] = [];
  const marked: SetupMark[] = [];
  const planned: { command: Command; line: number | null }[] = [];

  for (const [key, value] of Object.entries(file.settings ?? {})) {
    const line = parsed.lineOf(['settings', key]);
    const definition = Object.hasOwn(context.registry, key) ? context.registry[key] : undefined;
    if (!definition) {
      problems.push({ line, reason: `Unknown setting ${key}` });
      continue;
    }
    if (definition.secret) {
      problems.push({
        line,
        reason: `${key} is a secret; a setup file names it under toFillIn and never holds its value`,
      });
      continue;
    }
    if (definition.personal) {
      problems.push({ line, reason: `${key} ${personalReasons[definition.personal]}` });
      continue;
    }
    const valid = definition.schema.safeParse(value);
    if (!valid.success) {
      problems.push(...issueProblems(valid.error.issues, ['settings', key], file, parsed.lineOf));
      continue;
    }
    const stored = read.setting(key, 'global');
    const current = stored ? stored.value : definition.default;
    if (isDeepStrictEqual(current, valid.data)) continue;
    const change = {
      // The page names it too: several pages have an "Interval".
      what: `${definition.label} (${settingGroupTitles[definition.group]})`,
      from: stored
        ? shown(key, stored.value, read)
        : `${shown(key, definition.default, read)} (default)`,
      to: shown(key, valid.data, read),
    };
    (stored ? replaced : added).push(withFull(change, valid.data));
    warnings.push(...warningsOf(key, valid.data, read, context));
    planned.push({
      command: { type: 'setting.set', key, scope: 'global', value: valid.data },
      line,
    });
  }

  const toFillIn: SetupFillIn[] = [];
  (file.toFillIn ?? []).forEach((key, index) => {
    const definition = Object.hasOwn(context.registry, key) ? context.registry[key] : undefined;
    if (!definition?.secret) {
      problems.push({
        line: parsed.lineOf(['toFillIn', index]),
        reason: `toFillIn names ${key}, which is not a secret setting`,
      });
      return;
    }
    // A secret this install already has is not left to fill in.
    if (read.setting(key, 'global')) return;
    toFillIn.push({ key, label: definition.label, place: settingPlace(key, 'global', context) });
  });

  // Own skills before the workflows, so a step that follows one finds it (wow skills spec 8).
  const skillNames = new Set<string>();
  (file.skills ?? []).forEach((skill, index) => {
    const line = parsed.lineOf(['skills', index]);
    if (skillNames.has(skill.name)) {
      problems.push({ line, reason: `Skill ${skill.name} is in the file twice` });
      return;
    }
    skillNames.add(skill.name);
    const plan = planSkill(skill, read);
    if (!plan) return;
    (plan.replaces ? replaced : added).push(plan.line);
    planned.push({ command: plan.command, line });
  });

  const local = read.workflows();
  const taken = new Set<string>();
  const ids = new Set<string>();
  (file.workflows ?? []).forEach((entry, index) => {
    const line = parsed.lineOf(['workflows', index]);
    if (ids.has(entry.id)) {
      problems.push({ line, reason: `Workflow id ${entry.id} is in the file twice` });
      return;
    }
    ids.add(entry.id);
    const match = matchOf(entry, local, taken);
    if (match) taken.add(match.id);
    const plan = planWorkflow(entry, match, read, [...skillNames]);
    if (!plan) return;
    (plan.replaces ? replaced : added).push(plan.line);
    marked.push(...plan.marks);
    planned.push({ command: plan.command, line });
  });

  // Each command is decided once on the projections as they are. The commands touch different
  // things, so what one would leave does not change what another decides.
  for (const { command, line } of planned) {
    try {
      decide(command, read, context);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      problems.push({ line, reason: error.message });
    }
  }

  if (problems.length > 0) {
    return {
      outcome: 'refused',
      problems: problems.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    };
  }
  const preview = hideSecretsDeep(
    { added, replaced, marked, toFillIn, warnings },
    patterns,
  ) as SetupPreview;
  return { outcome: 'ready', preview, commands: planned.map(({ command }) => command) };
}
