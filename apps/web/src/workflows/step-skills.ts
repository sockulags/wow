import {
  automaticSkills,
  isBuiltInSkillName,
  sharedOwnSkillFolders,
  skillGroupLabels,
  skillGroupOf,
  type BuiltInSkillName,
  type Skill,
  type SkillRef,
  type WowSkillSource,
} from '@wow/contracts';
import type { ComboboxChoice } from '@/components/combobox';
import { parseGlobs, type DraftStep } from './model';

// The skills of a step in the builder (wow skills spec 10 to 12): the one it runs, the skills it
// also follows, and the built-in skills wow attaches by itself, with the reason and a way to
// leave each out. Pure; the builder and the palette share them.

// The value a step stores for a folder skill: its name, or plugin:name for a Claude plugin's.
export const folderSkillName = (skill: Skill): string =>
  skill.invocations.claude.replace(/^\//, '');

const wowSource = (skill: Skill): WowSkillSource | undefined =>
  skill.source === 'wow' || skill.source === 'yours' ? skill.source : undefined;

// A skill as a step names it: a wow skill with its source, so an own skill and a folder skill of
// the same name stay apart (spec 9).
export function refOf(skill: Skill): SkillRef {
  const source = wowSource(skill);
  return source ? { name: skill.name, source } : { name: folderSkillName(skill) };
}

// One key per skill a step can name. A folder skill's name never holds a slash.
export const refKey = (ref: SkillRef): string =>
  ref.source ? `${ref.source}/${ref.name}` : ref.name;

// The step's own skill as a ref: a built-in name without a source means the built-in one.
export function stepSkillRef(step: Pick<DraftStep, 'skillName' | 'skillSource'>): SkillRef {
  if (step.skillSource) return { name: step.skillName, source: step.skillSource };
  return isBuiltInSkillName(step.skillName)
    ? { name: step.skillName, source: 'wow' }
    : { name: step.skillName };
}

export const sameRef = (a: SkillRef, b: SkillRef): boolean => refKey(a) === refKey(b);

export interface SkillChoice extends ComboboxChoice {
  readonly ref: SkillRef;
  readonly description: string;
}

// Own skills whose name two folders share are one choice here; it names every folder, and the
// server refuses to run either until one is renamed.
function sharedFolders(skills: readonly Skill[], skill: Skill): string {
  if (skill.source !== 'yours') return '';
  const folders = sharedOwnSkillFolders(skills, skill.name);
  return folders.length > 1 ? `In ${folders.join(', ')}: rename one` : '';
}

// Every skill a step can name, in list order (Yours first), each once, with its group.
export function skillChoices(skills: readonly Skill[]): SkillChoice[] {
  const seen = new Set<string>();
  const choices: SkillChoice[] = [];
  for (const skill of skills) {
    const ref = refOf(skill);
    const value = refKey(ref);
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      ref,
      description: skill.description,
      label: ref.name,
      detail: [
        skillGroupLabels[skillGroupOf(skill)],
        skill.manualOnly ? 'Manual only' : '',
        sharedFolders(skills, skill),
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return choices;
}

// The fields a step gets when its own skill is picked.
export function withStepSkill(ref: SkillRef): Pick<DraftStep, 'skillName' | 'skillSource'> {
  return { skillName: ref.name, skillSource: ref.source };
}

export function withAlsoFollow(step: DraftStep, ref: SkillRef): Pick<DraftStep, 'alsoFollow'> {
  const current = step.alsoFollow ?? [];
  if (current.some((entry) => sameRef(entry, ref))) return { alsoFollow: [...current] };
  return { alsoFollow: [...current, ref] };
}

export function withoutAlsoFollow(step: DraftStep, ref: SkillRef): Pick<DraftStep, 'alsoFollow'> {
  const left = (step.alsoFollow ?? []).filter((entry) => !sameRef(entry, ref));
  // A step that follows nothing more is saved as it was before "Also follow" existed.
  return { alsoFollow: left.length > 0 ? left : undefined };
}

export function toggledLeaveOut(
  step: DraftStep,
  name: BuiltInSkillName,
): Pick<DraftStep, 'leaveOut'> {
  const current = step.leaveOut ?? [];
  const next = current.includes(name)
    ? current.filter((entry) => entry !== name)
    : [...current, name];
  return { leaveOut: next.length > 0 ? next : undefined };
}

export interface AttachedSkill {
  readonly name: BuiltInSkillName;
  readonly reason: string;
  readonly left: boolean;
}

// The built-in skills wow would attach to this step by itself, as the builder shows them (spec
// 12): not when the setting is off, not one that is switched off (it is in no list), not one the
// step already names. A run for a unit is only known when the run starts, so a workflow for
// units says when wow-pull-request comes.
export function attachedSkills(
  step: DraftStep,
  options: {
    readonly on: boolean;
    readonly forUnits: boolean;
    readonly skills: readonly Skill[];
  },
): AttachedSkill[] {
  if (!options.on) return [];
  const named = [stepSkillRef(step), ...(step.alsoFollow ?? [])];
  const shipped = new Set(
    options.skills.filter((skill) => skill.source === 'wow').map((skill) => skill.name),
  );
  return automaticSkills(
    { ...step, expectedArtifacts: parseGlobs(step.artifactsText) },
    options.forUnits ? { intentId: '', unitKey: '' } : null,
  )
    .filter(({ name }) => shipped.has(name))
    .filter(({ name }) => !named.some((ref) => sameRef(ref, { name, source: 'wow' })))
    .map(({ name, reason }) => ({
      name,
      reason:
        name === 'wow-pull-request' ? 'a plan run delivers a unit with this workflow' : reason,
      left: step.leaveOut?.includes(name) ?? false,
    }));
}
