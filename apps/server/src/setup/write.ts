import {
  SecretRef,
  awaitedProviderKind,
  findSecret,
  setupFileName,
  setupFileVersion,
  type SettingDefinition,
  type SetupFile,
  type SetupSaved,
  type SetupStep,
  type SetupWorkflow,
  type Workflow,
  withoutAddressAccount,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { patternsOf } from '../assistant/changes.js';
import type { DecideContext, ReadModel } from '../core/orchestrator.js';
import { setupText } from './file.js';

// "Save setup to a file" (app assistant spec 21): global settings that differ from their
// default, which include the tracker, host and template settings, and the workflows. Never a
// secret's value (a secret that is set is only named under `toFillIn`), never a project (so no
// project folder), and none of the values a setting marks `personal` (account names, values
// that fit only this computer, what only this person can say). Nothing of the calendar,
// backlog, threads or runs is read. Pure: the secret store is never asked.

const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...stringsIn(inner)]);
  }
  return [];
};

function stepOf(step: Workflow['steps'][number], read: ReadModel): SetupStep | undefined {
  const { id, skillName, providerInstanceId, ...rest } = step;
  // A step still waiting for an instance of its kind goes out as that kind, as it came in.
  const instance = read.providerInstance(providerInstanceId);
  const kind = instance ? instance.kind : awaitedProviderKind(providerInstanceId);
  return kind ? { id, skillName, provider: kind, ...rest } : undefined;
}

function workflowOf(workflow: Workflow, read: ReadModel): SetupWorkflow | undefined {
  const steps = workflow.steps.map((step) => stepOf(step, read));
  if (steps.some((step) => step === undefined)) return undefined;
  return {
    id: workflow.id,
    name: workflow.name,
    ...(workflow.templateKind ? { templateKind: workflow.templateKind } : {}),
    ...(workflow.ownWorkingCopy ? { ownWorkingCopy: true } : {}),
    ...(workflow.forUnits ? { forUnits: true } : {}),
    ...(typeof workflow.maxStepVisits === 'number'
      ? { maxStepVisits: workflow.maxStepVisits }
      : {}),
    steps: steps.filter((step) => step !== undefined),
  };
}

export function writeSetup(
  read: ReadModel,
  context: DecideContext & { readonly version: string },
): SetupSaved {
  const patterns = patternsOf(read, context);
  const looksSecret = (value: unknown) =>
    stringsIn(value).some(
      (text) => findSecret(text, patterns) !== null || withoutAddressAccount(text) !== text,
    );
  const leftOut: { what: string; reason: string }[] = [];
  const settings: Record<string, unknown> = {};
  const toFillIn: string[] = [];

  for (const [key, definition] of Object.entries(context.registry) as [
    string,
    SettingDefinition,
  ][]) {
    const stored = read.setting(key, 'global');
    if (!stored) continue;
    if (definition.secret) {
      if (SecretRef.safeParse(stored.value).success) toFillIn.push(key);
      continue;
    }
    if (definition.personal) continue;
    // A stored value an older wow wrote that no longer passes the schema is not sent on.
    const valid = definition.schema.safeParse(stored.value);
    if (!valid.success || isDeepStrictEqual(valid.data, definition.default)) continue;
    if (looksSecret(valid.data)) {
      leftOut.push({ what: definition.label, reason: 'it looks like a secret' });
      continue;
    }
    settings[key] = valid.data;
  }

  const workflows: SetupWorkflow[] = [];
  for (const workflow of read.workflows()) {
    const entry = workflowOf(workflow, read);
    if (!entry) {
      leftOut.push({
        what: `Workflow "${workflow.name}"`,
        reason: 'a step uses a provider instance that no longer exists',
      });
      continue;
    }
    if (looksSecret(entry)) {
      leftOut.push({
        what: `Workflow "${workflow.name}"`,
        reason: 'it looks like it holds a secret',
      });
      continue;
    }
    workflows.push(entry);
  }

  const file: SetupFile = {
    version: setupFileVersion,
    wow: context.version,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(toFillIn.length > 0 ? { toFillIn } : {}),
    ...(workflows.length > 0 ? { workflows } : {}),
  };
  return { text: setupText(file), fileName: setupFileName(context.now), toFillIn, leftOut };
}
