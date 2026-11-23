import { ruleConditionText, type WorkflowStep } from '@wow/contracts';
import { userWorkflowsDir } from '@wow/skills';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Db } from '../db/database.js';
import { providerInstances, workflows } from '../db/schema.js';
import type { Logger } from '../logger.js';

// Workflows as text (orchestrator threads spec 22): the workflows stored before are written out
// once as files the main agent follows, one per workflow in wow's own workflow folder. Steps,
// gates and step settings become lines; rules between steps become text under the step. A file
// that is there is never overwritten: the workflow then gets `<name>-1.md`, `-2`, and so on.

type StoredWorkflow = typeof workflows.$inferSelect;

// Marks the export as done in wow's home, outside the workflow folder, so a second start writes
// nothing even after files were deleted.
const exportedMark = (home: string): string => path.join(home, 'workflows-exported');

// A file name from a workflow's name: what Windows and Git take, never empty.
export const workflowFileBase = (name: string): string =>
  name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '') || 'workflow';

// A stored workflow as the text of its file.
export function workflowFileText(
  workflow: Pick<StoredWorkflow, 'name' | 'templateKind' | 'steps' | 'ownWorkingCopy'>,
  instanceName: (id: string) => string,
): string {
  const titles = new Map(workflow.steps.map((step) => [step.id, step.skillName]));
  const front = stringifyYaml({
    name: workflow.name,
    description: `Written from the workflow ${workflow.name} stored in wow before workflows were files.`,
  }).trimEnd();
  const steps = workflow.steps.map((step: WorkflowStep, index) => {
    const lines = [`## ${step.skillName}`, ''];
    if (index === 0 && step.gateBefore) lines.push('Ask the person before this step starts.', '');
    lines.push(`skill: ${step.skillName}`, `instance: ${instanceName(step.providerInstanceId)}`);
    if (step.model) lines.push(`model: ${step.model}`);
    if (step.effort) lines.push(`effort: ${step.effort}`);
    if (workflow.ownWorkingCopy) lines.push('isolation: copy');
    // A gate before the next step is a gate after this one.
    const next = workflow.steps[index + 1];
    if (step.gateAfter || next?.gateBefore) lines.push('gate: after');
    if (step.extraPrompt?.trim()) lines.push('', step.extraPrompt.trim());
    if (step.expectedArtifacts.length > 0) {
      lines.push('', `Files this step should leave: ${step.expectedArtifacts.join(', ')}.`);
    }
    for (const rule of step.rules ?? []) {
      const target =
        rule.goTo.type === 'end'
          ? 'finish'
          : `go to the step "${titles.get(rule.goTo.stepId) ?? rule.goTo.stepId}"`;
      lines.push('', `After this step, on ${ruleConditionText(rule.when)}: ${target}.`);
    }
    return lines.join('\n');
  });
  return `---\n${front}\n---\n\n${steps.join('\n\n')}\n`;
}

// Writes every stored workflow out once (spec 22). Answers the files written.
export async function exportStoredWorkflows(deps: {
  readonly db: Db;
  readonly home: string;
  readonly logger: Logger;
}): Promise<string[]> {
  const mark = exportedMark(deps.home);
  if (existsSync(mark)) return [];
  const stored = deps.db.select().from(workflows).all();
  const names = new Map(
    deps.db
      .select({ id: providerInstances.id, name: providerInstances.name })
      .from(providerInstances)
      .all()
      .map((row) => [row.id, row.name]),
  );
  const folder = userWorkflowsDir(deps.home);
  const written: string[] = [];
  if (stored.length > 0) await mkdir(folder, { recursive: true });
  for (const workflow of stored) {
    const base = workflowFileBase(workflow.name);
    let file = path.join(folder, `${base}.md`);
    for (let n = 1; existsSync(file); n += 1) file = path.join(folder, `${base}-${n}.md`);
    await writeFile(
      file,
      workflowFileText(workflow, (id) => names.get(id) ?? id),
      { encoding: 'utf8', flag: 'wx' },
    );
    written.push(file);
  }
  await mkdir(deps.home, { recursive: true });
  await writeFile(mark, `${new Date().toISOString()}\n`, 'utf8');
  if (written.length > 0) deps.logger.info('workflows written as files', { count: written.length });
  return written;
}
