import type { Skill } from '@wow/contracts';

export type SkillInvocations = Skill['invocations'];

// How each provider invokes a skill by name: Claude as a slash command, plugin skills as
// /plugin:name; Codex as $name.
export const invocationsFor = (name: string, plugin?: string): SkillInvocations => ({
  claude: plugin ? `/${plugin}:${name}` : `/${name}`,
  codex: `$${name}`,
});
