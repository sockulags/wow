import { fillTemplate, type BuiltInSkillValues, type OwnSkill } from '@wow/contracts';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { skillFileName } from './parse.js';
import type { SkillRoot } from './scan.js';

// wow's own skills (wow skills spec 1 to 6). The built-in ones are files shipped with this
// package and come with the app version; own skills are files under wow's home, one folder per
// skill in the same SKILL.md format as any other skill folder, so a file added there by hand is
// read like the rest.

export const builtInSkillsDir = fileURLToPath(new URL('../builtin', import.meta.url));

export const ownSkillsDir = (wowHome: string): string => path.join(wowHome, 'skills');

export const ownSkillDir = (wowHome: string, name: string): string =>
  path.resolve(ownSkillsDir(wowHome), name);

// The folders of the "wow" and "Yours" groups, in that order of reading.
export const wowSkillRoots = (wowHome: string): SkillRoot[] => [
  { dir: path.resolve(builtInSkillsDir), source: 'wow' },
  { dir: path.resolve(ownSkillsDir(wowHome)), source: 'yours' },
];

// A built-in skill's text for one send: the template filled from the settings and the run. A
// value that is not known for this send leaves its section out (spec 2).
export const fillBuiltInSkill = (template: string, values: BuiltInSkillValues): string =>
  fillTemplate(template, { ...values });

export function ownSkillFile(skill: OwnSkill): string {
  const frontmatter = stringifyYaml({ name: skill.name, description: skill.description }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.text.trim()}\n`;
}

export function writeOwnSkill(dir: string, skill: OwnSkill): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, skillFileName), ownSkillFile(skill), 'utf8');
}

// Removes the skill's file, and its folder when nothing else was put there.
export function removeOwnSkill(dir: string): void {
  rmSync(path.join(dir, skillFileName), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    // The folder holds other files the user put there; they stay.
  }
}
