import { z } from 'zod';

// wow skills (wow skills spec 1 to 15): skills that ship with the app ("wow") and skills the user
// writes in wow ("Yours"). Both are a name, a description and a text, and wow sends the text in
// the prompt instead of asking the provider to look the skill up.

export const builtInSkillNames = [
  'wow-verdict',
  'wow-artifacts',
  'wow-pull-request',
  'wow-handover',
] as const;
export const BuiltInSkillName = z.enum(builtInSkillNames);
export type BuiltInSkillName = z.infer<typeof BuiltInSkillName>;

export const isBuiltInSkillName = (name: string): name is BuiltInSkillName =>
  (builtInSkillNames as readonly string[]).includes(name);

// Where a skill is listed. Yours come first in every list (spec 7), then wow's own (spec 1).
export const SkillGroup = z.enum(['yours', 'wow', 'project', 'user', 'plugins', 'other']);
export type SkillGroup = z.infer<typeof SkillGroup>;

export const skillGroupLabels: Readonly<Record<SkillGroup, string>> = {
  yours: 'Yours',
  wow: 'wow',
  project: 'Project',
  user: 'User',
  plugins: 'Plugins',
  other: 'Other',
};

// The sources whose text wow sends itself.
export const WowSkillSource = z.enum(['wow', 'yours']);
export type WowSkillSource = z.infer<typeof WowSkillSource>;

export function skillGroupOf(skill: {
  readonly source: string;
  readonly invocations: { readonly claude: string };
}): SkillGroup {
  if (skill.source === 'yours') return 'yours';
  if (skill.source === 'wow') return 'wow';
  if (skill.invocations.claude.includes(':')) return 'plugins';
  if (skill.source === 'project-claude' || skill.source === 'project-agents') return 'project';
  if (skill.source === 'user-claude' || skill.source === 'user-codex') return 'user';
  return 'other';
}

// Every skill list's order: by group, then by name.
export function inListOrder<
  T extends {
    readonly name: string;
    readonly source: string;
    readonly invocations: { readonly claude: string };
  },
>(skills: readonly T[]): T[] {
  const order = SkillGroup.options;
  return skills.toSorted(
    (a, b) =>
      order.indexOf(skillGroupOf(a)) - order.indexOf(skillGroupOf(b)) ||
      a.name.localeCompare(b.name),
  );
}

// A skill as a step or a message names it. Without `source` it is a skill from a folder (or a
// built-in one by its reserved name), invoked by the provider as before; with it, a wow skill
// whose text wow sends. The source keeps an own skill and a folder skill of the same name apart
// (spec 9).
export const SkillRef = z.object({
  name: z.string().min(1),
  source: WowSkillSource.optional(),
});
export type SkillRef = z.infer<typeof SkillRef>;

const ownNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ownSkillNameMaxLength = 64;

// Why a name cannot be an own skill's (spec 5), or undefined when it can. `taken` is the names
// of the other wow skills.
export function ownSkillNameProblem(name: string, taken: readonly string[]): string | undefined {
  if (name === '') return 'A skill needs a name';
  if (name.length > ownSkillNameMaxLength) {
    return `A skill name has at most ${ownSkillNameMaxLength} characters`;
  }
  if (!ownNamePattern.test(name)) {
    return 'A skill name has only lower case letters, digits and single hyphens between them';
  }
  if (name.startsWith('wow-')) return 'Names starting with wow- are kept for the skills wow ships';
  if (taken.includes(name)) return `There is already a wow skill named ${name}`;
  return undefined;
}

export const OwnSkill = z.object({
  name: z.string().min(1),
  // When to use the skill, as the lists show it.
  description: z.string(),
  // Stored trimmed, so a text of only spaces is no text.
  text: z.string().trim().min(1),
});
export type OwnSkill = z.infer<typeof OwnSkill>;

// A skill a message or a step was sent with (spec 14). A wow skill carries the text that was
// sent, filled in; a folder skill the invocation the provider got. `reason` is set for a
// built-in skill wow attached by itself (spec 12).
export const SentSkill = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  text: z.string().optional(),
  invocation: z.string().optional(),
  reason: z.string().optional(),
});
export type SentSkill = z.infer<typeof SentSkill>;

// What a built-in skill's text can name (spec 2). An empty value leaves its section out.
export interface BuiltInSkillValues {
  readonly approvedLine: string;
  readonly changesRequestedLine: string;
  readonly blockedLine: string;
  // The step's expected artifacts as a list, one per line.
  readonly expectedArtifacts: string;
  readonly intentId: string;
  readonly unitKey: string;
  readonly unitTitle: string;
  // `Intent-Unit: <intent>/<unit>` for a run of a unit.
  readonly intentUnitLine: string;
}

export const intentUnitLine = (intentId: string, unitKey: string): string =>
  `Intent-Unit: ${intentId}/${unitKey}`;

// One part of a prompt made with skills: a wow skill's text, or a folder skill's invocation.
export type PromptSkillPart =
  | { readonly kind: 'text'; readonly name: string; readonly text: string }
  | { readonly kind: 'invoke'; readonly invocation: string };

// A wow skill's text in a prompt, marked with its name (spec 10).
export const skillTextBlock = (name: string, text: string): string =>
  `<skill name="${name}">\n${text.trim()}\n</skill>`;

// The skills in their order, then `tail` (a step's extra prompt, a chat message). A wow skill's
// text is a block of its own; invocations and the tail that follow each other share a line, as
// a step's invocation and its extra prompt always did.
export function promptWithSkills(parts: readonly PromptSkillPart[], tail: string): string {
  const blocks: string[] = [];
  let line: string[] = [];
  const endLine = () => {
    if (line.length > 0) blocks.push(line.join(' '));
    line = [];
  };
  for (const part of parts) {
    if (part.kind === 'text') {
      endLine();
      blocks.push(skillTextBlock(part.name, part.text));
    } else {
      line.push(part.invocation);
    }
  }
  if (tail.trim() !== '') line.push(tail.trim());
  endLine();
  return blocks.join('\n\n');
}

// The prompt as the thread shows it: invocations and the tail, without the wow skills' texts,
// which are reachable from the message's skills instead (spec 14).
export const promptShown = (parts: readonly PromptSkillPart[], tail: string): string =>
  promptWithSkills(
    parts.filter((part) => part.kind === 'invoke'),
    tail,
  );

// A built-in skill wow attaches to a step by itself, and why (spec 12).
export interface AutomaticSkill {
  readonly name: BuiltInSkillName;
  readonly reason: string;
}

export interface AutomaticSkillStep {
  readonly gateAfter: boolean;
  readonly gateAfterCondition?: readonly string[] | undefined;
  readonly rules?: readonly { readonly when: { readonly fact: string } }[] | undefined;
  readonly expectedArtifacts: readonly string[];
}

// The built-in skills a step gets because the workflow depends on them, before the step's own
// choices (left out, already named) are applied. `unit` is the unit of the run, if any.
export function automaticSkills(
  step: AutomaticSkillStep,
  unit: { readonly intentId: string; readonly unitKey: string } | null | undefined,
): AutomaticSkill[] {
  const found: AutomaticSkill[] = [];
  if (step.gateAfter && step.gateAfterCondition?.includes('verdict')) {
    found.push({ name: 'wow-verdict', reason: 'the gate after this step reads the verdict' });
  } else if ((step.rules ?? []).some((rule) => rule.when.fact === 'verdict')) {
    found.push({ name: 'wow-verdict', reason: 'a rule of this step reads the verdict' });
  }
  if (step.expectedArtifacts.length > 0) {
    found.push({ name: 'wow-artifacts', reason: 'this step expects artifacts' });
  }
  if (unit) {
    found.push({
      name: 'wow-pull-request',
      reason: `this run delivers unit ${unit.unitKey} of ${unit.intentId}`,
    });
  }
  return found;
}
