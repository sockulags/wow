import {
  isBuiltInSkillName,
  ownSkillNameProblem,
  type BuiltInSkillValues,
  type DomainEvent,
  type OwnSkill,
  type PromptSkillPart,
  type ProviderKind,
  type SentSkill,
  type ServerCommand,
  type Skill,
  type SkillRef,
  type Thread,
  promptWithSkills,
} from '@wow/contracts';
import { fillBuiltInSkill, invocationsFor, ownSkillDir } from '@wow/skills';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Own skills by command (wow skills spec 5, 6) and how a skill a step or a message names is
// found and sent (spec 9, 10, 15). The skills projection is the list every client shows; the
// skills service writes an own skill's file once its event has committed.

type SkillCommand = Extract<
  ServerCommand,
  { type: 'skill.create' | 'skill.update' | 'skill.delete' }
>;

export const isSkillCommand = (command: ServerCommand): command is SkillCommand =>
  command.type === 'skill.create' ||
  command.type === 'skill.update' ||
  command.type === 'skill.delete';

const isWow = (skill: Skill) => skill.source === 'wow' || skill.source === 'yours';

const ownSkill = (read: ReadModel, name: string): Skill | undefined =>
  read.skills().find((skill) => skill.source === 'yours' && skill.name === name);

function requireOwn(read: ReadModel, name: string): Skill {
  const skill = ownSkill(read, name);
  if (skill) return skill;
  if (read.skills().some((entry) => entry.source === 'wow' && entry.name === name)) {
    throw new CommandRejected(
      'rejected',
      `${name} ships with wow and cannot be changed or deleted`,
    );
  }
  throw new CommandRejected('not_found', `You have no skill named ${name}`);
}

const row = (dir: string, input: OwnSkill): Skill => ({
  id: dir,
  name: input.name,
  description: input.description.trim(),
  dir,
  source: 'yours',
  manualOnly: false,
  invocations: invocationsFor(input.name),
  text: input.text.trim(),
});

export function decideSkill(
  command: SkillCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'skill.create': {
      const { skill } = command;
      const taken = read
        .skills()
        .filter(isWow)
        .map((entry) => entry.name);
      const problem = ownSkillNameProblem(skill.name, taken);
      if (problem) throw new CommandRejected('rejected', problem);
      if (!context.home) {
        throw new CommandRejected(
          'rejected',
          "wow's home folder is not known, so no skill can be saved",
        );
      }
      const saved = row(ownSkillDir(context.home, skill.name), skill);
      return [
        { kind: 'skill.saved', aggregate: 'skills', payload: { skill: saved, previous: null } },
      ];
    }
    case 'skill.update': {
      const previous = requireOwn(read, command.skill.name);
      const saved = row(previous.dir, command.skill);
      if (isDeepStrictEqual(saved, previous)) return [];
      return [{ kind: 'skill.saved', aggregate: 'skills', payload: { skill: saved, previous } }];
    }
    case 'skill.delete': {
      const skill = requireOwn(read, command.name);
      return [{ kind: 'skill.deleted', aggregate: 'skills', payload: { skill } }];
    }
  }
}

// A skill as wow sends it on one provider: a wow skill's text (a built-in one filled in), or a
// folder skill's invocation. Undefined when a wow skill it names is not in the list: deleted,
// or a built-in one switched off.
export type SkillToSend =
  | { readonly kind: 'text'; readonly name: string; readonly source: string; readonly text: string }
  | {
      readonly kind: 'invoke';
      readonly name: string;
      readonly source: string;
      readonly invocation: string;
    };

export function skillToSend(
  skills: readonly Skill[],
  ref: SkillRef,
  provider: ProviderKind,
  values: BuiltInSkillValues,
): SkillToSend | undefined {
  // A built-in skill's name is kept for it, so a step naming one without a source means it.
  const source = ref.source ?? (isBuiltInSkillName(ref.name) ? 'wow' : undefined);
  if (source !== undefined) {
    const skill = skills.find((entry) => entry.source === source && entry.name === ref.name);
    if (!skill) return undefined;
    const text = skill.text ?? '';
    return {
      kind: 'text',
      name: skill.name,
      source,
      text: source === 'wow' ? fillBuiltInSkill(text, values) : text,
    };
  }
  const folder = skills.filter((skill) => !isWow(skill));
  return { kind: 'invoke', ...folderInvocation(folder, ref.name, provider) };
}

// A folder skill by name, or a Claude plugin skill by plugin:name. With several of that name
// the plugin's own wins. Unknown skills get the plain forms, so a workflow still runs on a
// machine where the skill lives somewhere wow does not scan.
function folderInvocation(
  skills: readonly Skill[],
  skillName: string,
  provider: ProviderKind,
): { name: string; source: string; invocation: string } {
  const separator = skillName.indexOf(':');
  const plugin = separator > 0 ? skillName.slice(0, separator) : undefined;
  const name = plugin === undefined ? skillName : skillName.slice(separator + 1);
  const expected = invocationsFor(name, plugin);
  const named = skills.filter((skill) => skill.name === name);
  const skill =
    named.find((entry) => isDeepStrictEqual(entry.invocations, expected)) ??
    (plugin === undefined ? named[0] : undefined);
  return {
    name: skillName,
    source: skill?.source ?? 'custom',
    invocation: (skill?.invocations ?? expected)[provider],
  };
}

// The invocation a step's own skill gets in a run stored before wow skills.
export const folderSkillInvocation = (
  skills: readonly Skill[],
  skillName: string,
  provider: ProviderKind,
): string =>
  folderInvocation(
    skills.filter((skill) => !isWow(skill)),
    skillName,
    provider,
  ).invocation;

function settingText(
  key: string,
  read: ReadModel,
  context: DecideContext,
  projectId: string | undefined,
): string {
  const definition = context.registry[key];
  if (!definition) throw new Error(`${key} is missing from the settings registry`);
  const { value } = resolveStored(
    key,
    definition,
    projectId === undefined ? {} : { projectId },
    (scope) => read.setting(key, scope),
  );
  return typeof value === 'string' ? value : '';
}

// What a built-in skill picked in chat is filled with: the project's verdict lines. A chat
// message has no step, so no expected artifacts, and no unit (spec 2).
export function chatSkillValues(
  read: ReadModel,
  context: DecideContext,
  projectId: string | undefined,
): BuiltInSkillValues {
  return {
    approvedLine: settingText('workflows.verdictApprovedLine', read, context, projectId),
    changesRequestedLine: settingText(
      'workflows.verdictChangesRequestedLine',
      read,
      context,
      projectId,
    ),
    blockedLine: settingText('workflows.verdictBlockedLine', read, context, projectId),
    expectedArtifacts: '',
    intentId: '',
    unitKey: '',
    unitTitle: '',
    intentUnitLine: '',
  };
}

export const missingSkillSentence = (name: string): string =>
  `The skill ${name} no longer exists. Pick it again from the list, or make it again.`;

// A chat message with the skills picked for it (spec 10, 14): the prompt the agent gets, with
// each skill before the text, and the skills as the message stores them.
export function messageWithSkills(
  read: ReadModel,
  context: DecideContext,
  thread: Thread,
  refs: readonly SkillRef[],
  text: string,
): { prompt: string; skills: SentSkill[] } {
  const provider = read.providerInstance(thread.providerInstanceId)?.kind;
  if (!provider) {
    throw new CommandRejected('not_found', `No provider instance ${thread.providerInstanceId}`);
  }
  const values = chatSkillValues(read, context, thread.projectId ?? undefined);
  const skills = read.skills();
  const found = refs.map((ref) => {
    const skill = skillToSend(skills, ref, provider, values);
    if (!skill) throw new CommandRejected('rejected', missingSkillSentence(ref.name));
    return skill;
  });
  const parts: PromptSkillPart[] = found.map((skill) =>
    skill.kind === 'text'
      ? { kind: 'text', name: skill.name, text: skill.text }
      : { kind: 'invoke', invocation: skill.invocation },
  );
  return {
    prompt: promptWithSkills(parts, text),
    skills: found.map((skill) => sentSkill(skill)),
  };
}

export const sentSkill = (skill: SkillToSend, reason?: string): SentSkill => ({
  name: skill.name,
  source: skill.source,
  ...(skill.kind === 'text' ? { text: skill.text } : { invocation: skill.invocation }),
  ...(reason === undefined ? {} : { reason }),
});
