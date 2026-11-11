import { fillTemplate, type BuiltInSkillValues, type OwnSkill } from '@wow/contracts';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, isMap, parseDocument, stringify as stringifyYaml } from 'yaml';
import { parseSkillFile, skillBody, skillFileName, splitSkillFile } from './parse.js';
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

// An own skill's file with the name, description and text changed to the skill's, and
// everything else as it was: other frontmatter keys in their order, and the file untouched
// where those three already hold.
export function changedOwnSkillFile(file: string, skill: OwnSkill): string {
  const { yaml, rest } = splitSkillFile(file);
  const before = parseSkillFile(file);
  const description = skill.description.trim();
  const text = skill.text.trim();
  const parsed = yaml === undefined ? undefined : parseDocument(yaml);
  const doc = parsed && isMap(parsed.contents) ? parsed : new Document({});
  let frontmatterChanged = false;
  if (before.name !== skill.name) {
    doc.set('name', skill.name);
    frontmatterChanged = true;
  }
  if (before.description !== description) {
    doc.set('description', description);
    frontmatterChanged = true;
  }
  const bodyChanged = skillBody(file) !== text;
  if (!frontmatterChanged && !bodyChanged) return file;
  const header = file.slice(0, file.length - rest.length);
  const head = frontmatterChanged ? `---\n${doc.toString().trimEnd()}\n---\n` : header;
  const body = bodyChanged ? `${head.trim() === '' ? '' : '\n'}${text}\n` : rest;
  return head + body;
}

export function writeOwnSkill(dir: string, skill: OwnSkill): void {
  writeOwnSkillFile(dir, ownSkillFile(skill));
}

// Writes the file as given, byte for byte.
export function writeOwnSkillFile(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, skillFileName), file, 'utf8');
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
