import {
  ReadModelsRequest,
  offeredEfforts,
  providerRequiresModel,
  type Command,
  type InstanceModels,
  type ModelGuidance,
  type ModelsRead,
  type ProviderModel,
  type WorkflowStep,
} from '@wow/contracts';
import { asc } from 'drizzle-orm';
import { z } from 'zod';
import { CommandRejected } from '../core/orchestrator.js';
import * as t from '../db/schema.js';
import type { Reader, ReaderDeps } from './readers.js';

// The assistant's model tools (questions and models spec 13 to 16): what each provider instance
// offers, read from the installed provider, and wow's guidance on choosing, read from its
// setting. The assistant recommends from these and not from memory, and a workflow it writes
// names only what an instance offers.

const GUIDANCE_KEY = 'assistant.modelGuidance';

type InstanceRow = typeof t.providerInstances.$inferSelect;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'it did not say why';

// Why an instance whose last test did not pass is not connected; null when it passed. Both the
// reader and the step check use it, so they agree on which instances can be written.
const notReadyReason = (instance: InstanceRow): string | null =>
  instance.status === 'ready'
    ? null
    : instance.status === 'error'
      ? `Its last test failed${instance.statusMessage ? ` (${instance.statusMessage})` : ''}. Test it in Settings → Providers.`
      : 'It has not passed a test yet. Test it in Settings → Providers.';

// An instance is connected when its last test passed and its provider lists its models. One that
// is signed out or fails to list them is "not connected", with the reason (open risk of U2).
async function modelsOf(instance: InstanceRow, deps: ReaderDeps): Promise<InstanceModels> {
  const base = {
    providerInstanceId: instance.id,
    name: instance.name,
    kind: instance.kind,
    requiresModel: providerRequiresModel(instance.kind),
    defaultModel: instance.defaultModel,
    defaultEffort: instance.defaultEffort,
  };
  const notConnected = (reason: string): InstanceModels => ({
    ...base,
    connected: false,
    reason,
    models: [],
  });
  const notReady = notReadyReason(instance);
  if (notReady !== null) return notConnected(notReady);
  let models: ProviderModel[];
  try {
    models = await deps.listModels(instance.id);
  } catch (error) {
    return notConnected(`wow could not read the models it offers: ${describe(error)}`);
  }
  return {
    ...base,
    connected: true,
    reason: null,
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      efforts: offeredEfforts(instance.kind, model),
      isDefault: model.id === instance.defaultModel,
    })),
  };
}

export const modelReaders = {
  read_models: {
    description:
      "The models each provider instance offers, the efforts each model takes, the instance's default model and effort, and whether its provider requires a model on a workflow step (Codex does). An instance that is not connected is listed with no models and the reason. Read this before you write a workflow step's model and effort.",
    input: ReadModelsRequest,
    read: async ({ providerInstanceId }, deps): Promise<ModelsRead> => {
      const rows = deps.db
        .select()
        .from(t.providerInstances)
        .orderBy(asc(t.providerInstances.name))
        .all()
        .filter((row) => providerInstanceId === undefined || row.id === providerInstanceId);
      if (providerInstanceId !== undefined && rows.length === 0) {
        throw new CommandRejected('not_found', `No provider instance ${providerInstanceId}`);
      }
      const instances: InstanceModels[] = [];
      for (const row of rows) instances.push(await modelsOf(row, deps));
      return {
        outcome: 'read',
        instances,
        note: "A workflow step names an instance, one of its models and one of that model's efforts. wow refuses a model or effort that is not listed here. Choose with read_model_guidance and say why in a sentence.",
      };
    },
  } satisfies Reader<typeof ReadModelsRequest>,
  read_model_guidance: {
    description:
      "wow's guidance on choosing a model and an effort per kind of work (planning and specification, building, reviewing, mechanical steps) on each provider. It names kinds of model; match it against what read_models lists. The owner can edit it in Settings → Assistant.",
    input: z.object({}).strict(),
    read: (_args, deps): ModelGuidance => {
      const resolved = deps.settings.resolve(GUIDANCE_KEY);
      const fallback = deps.registry[GUIDANCE_KEY]?.default;
      const value = typeof resolved.value === 'string' ? resolved.value : fallback;
      return {
        outcome: 'read',
        text: typeof value === 'string' ? value : '',
        edited: resolved.source !== 'default',
        note: 'Recommend from this and from read_models, never from memory.',
      };
    },
  } satisfies Reader<z.ZodObject<Record<string, never>>>,
} as const;

const refuse = (reason: string): never => {
  throw new CommandRejected('rejected', reason);
};

const listed = (values: readonly string[]): string =>
  values.length === 0 ? 'nothing' : values.join(', ');

// Every step the assistant writes names an instance, a model and an effort that instance offers
// (spec 15, 16). The models are read from the provider at the moment of the change, so the
// refusal lists what it offers now.
export async function checkStepModels(command: Command, deps: ReaderDeps): Promise<void> {
  if (command.type !== 'workflow.create' && command.type !== 'workflow.update') return;
  if (!command.steps) return;
  const offered = new Map<string, ProviderModel[]>();
  for (const [index, step] of command.steps.entries()) {
    await checkStep(step, index, deps, offered);
  }
}

async function checkStep(
  step: WorkflowStep,
  index: number,
  deps: ReaderDeps,
  offered: Map<string, ProviderModel[]>,
): Promise<void> {
  const label = `Step ${index + 1} (${step.skillName})`;
  const instance = deps.db
    .select()
    .from(t.providerInstances)
    .all()
    .find((row) => row.id === step.providerInstanceId);
  if (!instance) {
    return refuse(
      `${label} names provider instance ${step.providerInstanceId}, which does not exist. read_models lists the instances.`,
    );
  }
  const notReady = notReadyReason(instance);
  if (notReady !== null) {
    return refuse(`${instance.name} is not connected, so wow cannot check ${label}: ${notReady}`);
  }
  let models = offered.get(instance.id);
  if (!models) {
    try {
      models = await deps.listModels(instance.id);
    } catch (error) {
      return refuse(
        `wow cannot read the models ${instance.name} offers (${describe(error)}), so it cannot check ${label}. Tell the person to test ${instance.name} in Settings → Providers.`,
      );
    }
    offered.set(instance.id, models);
  }
  const ids = models.map((model) => model.id);
  if (!step.model) {
    return refuse(`${label} names no model. ${instance.name} offers: ${listed(ids)}.`);
  }
  const model = models.find((candidate) => candidate.id === step.model);
  if (!model) {
    return refuse(
      `${instance.name} does not offer the model ${step.model} (${label}). It offers: ${listed(ids)}.`,
    );
  }
  const efforts = offeredEfforts(instance.kind, model);
  if (efforts.length === 0) return;
  if (!step.effort) {
    return refuse(
      `${label} names no effort. ${model.id} on ${instance.name} takes: ${listed(efforts)}.`,
    );
  }
  if (!efforts.includes(step.effort)) {
    return refuse(
      `${model.id} on ${instance.name} does not take the effort ${step.effort} (${label}). It takes: ${listed(efforts)}.`,
    );
  }
}
