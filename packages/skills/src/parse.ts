import { parse as parseYaml } from 'yaml';

export const skillFileName = 'SKILL.md';
export const codexPolicyFile = ['agents', 'openai.yaml'] as const;

export interface SkillFrontmatter {
  readonly name: string | undefined;
  readonly description: string;
  readonly disableModelInvocation: boolean;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

// Reads the YAML frontmatter of a SKILL.md. A file without frontmatter is still a skill; invalid
// YAML throws so the caller can report the file.
export function parseSkillFile(content: string): SkillFrontmatter {
  const match = FRONTMATTER.exec(content);
  const data: unknown = match ? parseYaml(match[1] ?? '') : {};
  const fields = isRecord(data) ? data : {};
  return {
    name: text(fields['name']),
    description: text(fields['description']) ?? '',
    disableModelInvocation: fields['disable-model-invocation'] === true,
  };
}

// `agents/openai.yaml` next to a SKILL.md: `policy.allow_implicit_invocation: false` keeps Codex
// from choosing the skill on its own. Returns undefined when the file does not say.
export function parseCodexPolicy(content: string): boolean | undefined {
  const data: unknown = parseYaml(content);
  if (!isRecord(data) || !isRecord(data['policy'])) return undefined;
  const allow = data['policy']['allow_implicit_invocation'];
  return typeof allow === 'boolean' ? allow : undefined;
}
