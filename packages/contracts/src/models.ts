import { z } from 'zod';
import { ProviderKind, providerChatOptions, type ProviderModel } from './provider.js';
import { providerKindLabels } from './setup.js';

// Models for the assistant and for workflow steps (questions and models spec 13 to 20). wow
// learns which models an instance offers from the installed provider (`listModels`) and how to
// choose between them from a guidance text it ships as a setting; nothing comes from the
// internet.

const Id = z.string().min(1);

export const providerRequiresModel = (kind: ProviderKind): boolean =>
  providerChatOptions[kind].requiresModel;

// The efforts a step can name with a model: the model's own levels and the effort that leaves
// the choice to the provider, where it has one.
export function offeredEfforts(kind: ProviderKind, model: ProviderModel | undefined): string[] {
  const fallback = providerChatOptions[kind].defaultEffort;
  return [...new Set([...(fallback === null ? [] : [fallback]), ...(model?.efforts ?? [])])];
}

export interface ModelInstance {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly defaultModel: string | null;
}

// A step on a provider that requires a model, with none named and no default to take: the server
// refuses it with this sentence, and the builder shows the same words beside the step (spec 17,
// 18).
export const missingModelSentence = (skillName: string, instance: ModelInstance): string =>
  `Step ${skillName} runs on ${providerKindLabels[instance.kind]} (${instance.name}), which needs a model on every step, and ${instance.name} has no default model: choose a model for the step.`;

// Why a stored step is marked (spec 19, 20): it has no model and its provider needs one. With a
// default it runs on that default; without one its run fails when the step starts.
export function modelMark(skillName: string, instance: ModelInstance): string {
  const kind = providerKindLabels[instance.kind];
  return instance.defaultModel
    ? `step ${skillName} has no model, which ${kind} needs; it runs with ${instance.name}'s default ${instance.defaultModel} until one is chosen in the workflow`
    : `step ${skillName} has no model, which ${kind} needs; choose one in the workflow, or the step fails when it starts`;
}

// Whether a step with this model on this kind of provider lacks a model the provider needs.
export const lacksRequiredModel = (
  step: { readonly model?: string | undefined },
  kind: ProviderKind | null | undefined,
): boolean => !step.model && kind !== null && kind !== undefined && providerRequiresModel(kind);

// The assistant's tool that reads each instance's models (spec 13).
export const assistantModelsTool = 'read_models';
export const ReadModelsRequest = z.object({ providerInstanceId: Id.optional() }).strict();
export type ReadModelsRequest = z.infer<typeof ReadModelsRequest>;

export const OfferedModel = z.object({
  id: Id,
  label: z.string(),
  description: z.string(),
  // What a step may name as its effort with this model.
  efforts: z.array(Id),
  // The instance's default model.
  isDefault: z.boolean(),
});
export type OfferedModel = z.infer<typeof OfferedModel>;

export const InstanceModels = z.object({
  providerInstanceId: Id,
  name: z.string().min(1),
  kind: ProviderKind,
  // The last test passed and the provider listed its models. Otherwise `models` is empty and
  // `reason` says why.
  connected: z.boolean(),
  reason: z.string().min(1).nullable(),
  requiresModel: z.boolean(),
  defaultModel: z.string().nullable(),
  defaultEffort: z.string().nullable(),
  models: z.array(OfferedModel),
});
export type InstanceModels = z.infer<typeof InstanceModels>;

export const ModelsRead = z.object({
  outcome: z.literal('read'),
  instances: z.array(InstanceModels),
  note: z.string().min(1),
});
export type ModelsRead = z.infer<typeof ModelsRead>;

// The assistant's tool that reads wow's guidance on choosing a model (spec 14).
export const assistantGuidanceTool = 'read_model_guidance';

export const ModelGuidance = z.object({
  outcome: z.literal('read'),
  text: z.string().min(1),
  // The owner changed the shipped text.
  edited: z.boolean(),
  note: z.string().min(1),
});
export type ModelGuidance = z.infer<typeof ModelGuidance>;

// Shipped with wow and editable as `assistant.modelGuidance`. It names kinds of model, never
// model versions, so it stays true while providers release new ones; the assistant matches it
// against what the instance lists.
export const defaultModelGuidance = `How to choose a model and an effort for a workflow step. This names kinds of model, not model versions. Match it against the models and efforts read_models lists for the step's provider instance, and never name a model or an effort it does not list.

Kinds of work
- Planning and specification (capture-intent, shape-work, plan-work, design-work and the like): everything after it builds on this, so mistakes cost the most here. Take the most capable model the instance offers, with a high effort.
- Building (deliver-work and other steps that write code): long work across many files. Take a strong general or coding model with a medium effort; the most capable model with a high effort for hard or risky changes.
- Reviewing (check-work and other review steps): reading and judging what was built. Take a model at least as capable as the one that built, with a high effort, so the review catches what the build missed.
- Mechanical steps (formatting, renaming, release notes, short summaries): short and well defined. Take the fastest and cheapest model offered, with a low effort.

Claude Code
- Its models come in sizes: the largest (Opus class) for planning and reviewing, the middle one (Sonnet class) for most building, the smallest (Haiku class) for mechanical steps.
- The effort "default" leaves the choice to Claude Code. A higher effort takes longer and costs more.

Codex
- Every step needs a model. Its models differ in size and in how much they reason: the most capable one for planning and reviewing, a balanced or coding model for building, the smallest ("mini") one for mechanical steps.
- Reasoning effort: high for planning and reviewing, medium for building, low for mechanical steps.

When two choices differ in a way the person would care about, such as cost against quality, ask them.`;
