import type { Skill } from '@wow/contracts';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invocationsFor } from './invocations.js';
import { splitSkillFile } from './parse.js';
import type { ScanProblem, SkillRoot } from './scan.js';

// Workflows as text (orchestrator threads spec 19 to 21): each `<name>.md` file in wow's own
// workflow folder or a project's `.wow/workflows` is a workflow the main agent follows. They are
// listed beside the skills, so `/` in the composer offers them and a picked one is sent as text.

export const userWorkflowsDir = (wowHome: string): string => path.join(wowHome, 'workflows');

export const projectWorkflowsDir = (projectDir: string): string =>
  path.join(projectDir, '.wow', 'workflows');

// wow's own folder first, then each project's.
export const workflowRoots = (wowHome: string, projectDirs: readonly string[]): SkillRoot[] => [
  { dir: path.resolve(userWorkflowsDir(wowHome)), source: 'workflow' },
  ...projectDirs.map((dir) => ({
    dir: path.resolve(projectWorkflowsDir(dir)),
    source: 'project-workflow' as const,
  })),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

// One workflow file as a skill: its front matter's name (else the file's), its description and
// the whole file as its text.
function workflowOf(file: string, content: string, root: SkillRoot): Skill | ScanProblem {
  const { yaml } = splitSkillFile(content);
  let fields: Record<string, unknown> = {};
  if (yaml !== undefined) {
    try {
      const data: unknown = parseYaml(yaml);
      fields = isRecord(data) ? data : {};
    } catch (error) {
      return { file, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const name = textOf(fields['name']) ?? path.basename(file, '.md');
  return {
    id: file,
    name,
    description: textOf(fields['description']) ?? '',
    dir: root.dir,
    source: root.source,
    // A workflow runs because the user picked it, never by the agent's own choice.
    manualOnly: true,
    invocations: invocationsFor(name),
    text: content.replace(/^﻿/, '').trim(),
  };
}

// Reads every `*.md` in the workflow folders. A missing folder is skipped; a file whose front
// matter cannot be read is reported instead of failing the scan.
export async function scanWorkflows(
  roots: readonly SkillRoot[],
): Promise<{ skills: Skill[]; problems: ScanProblem[] }> {
  const skills: Skill[] = [];
  const problems: ScanProblem[] = [];
  for (const root of roots) {
    const names = await readdir(root.dir).catch(() => [] as string[]);
    // Two files of one folder with one name could not be told apart by /name: the first wins
    // and the other is reported.
    const taken = new Set<string>();
    for (const entry of names.filter((name) => name.toLowerCase().endsWith('.md')).toSorted()) {
      const file = path.join(root.dir, entry);
      const content = await readFile(file, 'utf8').catch(() => undefined);
      if (content === undefined) continue;
      const result = workflowOf(file, content, root);
      if ('message' in result) problems.push(result);
      else if (taken.has(result.name.toLowerCase())) {
        problems.push({
          file,
          message: `Another workflow in ${root.dir} is named ${result.name}; rename one.`,
        });
      } else {
        taken.add(result.name.toLowerCase());
        skills.push(result);
      }
    }
  }
  return { skills, problems };
}
