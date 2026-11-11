import {
  assistantThreadId,
  chooseAssistantProvider,
  providerChatOptions,
  type DomainEvent,
  type ProviderInstance,
  type ProviderModel,
  type Thread,
} from '@wow/contracts';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import { CommandRejected, type DecideContext, type ReadModel } from '../core/orchestrator.js';
import { readModel } from '../core/projector.js';
import type { Db } from '../db/database.js';
import { resolveStored } from '../settings/service.js';

// The assistant thread (app assistant spec 1, 2, 27): one per install, run by the provider
// instance the settings name, in a folder of the app that stays empty.

// Not a setting on purpose: a folder someone could point at a project would put that project's
// files beside an agent that must never see any.
const folderName = 'assistant';

export const assistantFolder = (home: string): string => path.join(home, folderName);

// Makes the folder and refuses one that holds anything: an agent started there must find nothing
// to read, and no instruction file a provider would pick up.
export async function prepareAssistantFolder(home: string): Promise<string> {
  const folder = assistantFolder(home);
  await mkdir(folder, { recursive: true });
  const found = await readdir(folder);
  if (found.length > 0) {
    throw new Error(
      `The assistant's folder ${folder} must be empty and holds ${found.length === 1 ? 'a file' : `${found.length} files`} (${found.slice(0, 3).join(', ')}). Move them away; the assistant does not start until then.`,
    );
  }
  return folder;
}

export interface AssistantFallback {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

type Resolved =
  | { readonly problem: string }
  | {
      readonly problem: null;
      readonly instance: ProviderInstance;
      // Undefined when neither the settings, the instance nor the thread name one.
      readonly model: string | undefined;
      readonly effort: string | undefined;
    };

const storedValue = (key: string, read: ReadModel, context: DecideContext): unknown => {
  const definition = context.registry[key];
  if (!definition) return undefined;
  return resolveStored(key, definition, {}, (scope) => read.setting(key, scope)).value;
};

const stored = (key: string, read: ReadModel, context: DecideContext): string => {
  const value = storedValue(key, read, context);
  return typeof value === 'string' ? value.trim() : '';
};

// Who runs the assistant and with which model and effort, from the settings, then the instance's
// own defaults, then what the thread already uses on that instance.
export function resolveAssistant(read: ReadModel, context: DecideContext): Resolved {
  const current = read.thread(assistantThreadId);
  const choice = chooseAssistantProvider(read.providerInstances(), {
    configuredId: stored('assistant.providerInstanceId', read, context),
    currentId: current?.providerInstanceId,
    // Anything but a stored true keeps the assistant off Codex.
    allowCodex: storedValue('assistant.allowCodex', read, context) === true,
  });
  if (choice.problem !== null) return { problem: choice.problem };
  const { instance } = choice;
  const kept = current?.providerInstanceId === instance.id ? current : undefined;
  return {
    problem: null,
    instance,
    model:
      stored('assistant.model', read, context) || instance.defaultModel || kept?.model || undefined,
    effort:
      stored('assistant.effort', read, context) ||
      instance.defaultEffort ||
      kept?.effort ||
      (providerChatOptions[instance.kind].defaultEffort ?? undefined),
  };
}

const missing = (what: 'model' | 'effort', instance: ProviderInstance): string =>
  `The assistant has no ${what} to use on ${instance.name}. Choose one in Settings → Assistant, or give ${instance.name} a default ${what} in Settings → Providers.`;

// The events that make the assistant thread or bring it in line with the settings, and the
// thread as it is after them. Rejects with the reason when no connected instance can run it.
export function assistantThreadEvents(
  read: ReadModel,
  context: DecideContext,
  fallback: AssistantFallback = {},
): { events: DomainEvent[]; thread: Thread } {
  const resolved = resolveAssistant(read, context);
  if (resolved.problem !== null) throw new CommandRejected('rejected', resolved.problem);
  const { instance } = resolved;
  const model = resolved.model ?? fallback.model;
  if (!model) throw new CommandRejected('rejected', missing('model', instance));
  const effort = resolved.effort ?? fallback.effort;
  if (!effort) throw new CommandRejected('rejected', missing('effort', instance));
  if (context.home === undefined) {
    throw new CommandRejected('rejected', 'This server has no folder of its own for the assistant');
  }
  const permissionMode = providerChatOptions[instance.kind].assistantPermissionMode;
  const now = context.now;
  const current = read.thread(assistantThreadId);
  if (!current) {
    const thread: Thread = {
      id: assistantThreadId,
      kind: 'assistant',
      projectId: null,
      cwd: assistantFolder(context.home),
      branch: null,
      providerInstanceId: instance.id,
      providerSessionId: null,
      title: 'Assistant',
      model,
      effort,
      permissionMode,
      state: 'idle',
      pinned: false,
      runId: null,
      stepId: null,
      createdAt: now,
      updatedAt: now,
    };
    return { events: [{ kind: 'thread.created', aggregate: thread.id, payload: thread }], thread };
  }
  if (current.providerInstanceId !== instance.id) {
    // The provider keeps its conversation in its config folder, so only an instance of the same
    // kind on the same folder can go on with it. wow's own record of the conversation stays.
    const before = read.providerInstance(current.providerInstanceId);
    const providerSessionId =
      before?.kind === instance.kind && before.configDir === instance.configDir
        ? current.providerSessionId
        : null;
    const moved = {
      providerInstanceId: instance.id,
      providerSessionId,
      model,
      effort,
      permissionMode,
      updatedAt: now,
    };
    return {
      events: [
        {
          kind: 'thread.providerChanged',
          aggregate: current.id,
          payload: {
            threadId: current.id,
            previousProviderInstanceId: current.providerInstanceId,
            ...moved,
          },
        },
      ],
      thread: { ...current, ...moved },
    };
  }
  const changes = {
    ...(current.model === model ? {} : { model }),
    ...(current.effort === effort ? {} : { effort }),
    ...(current.permissionMode === permissionMode ? {} : { permissionMode }),
  };
  if (Object.keys(changes).length === 0) return { events: [], thread: current };
  return {
    events: [
      {
        kind: 'thread.configured',
        aggregate: current.id,
        payload: {
          threadId: current.id,
          providerInstanceId: instance.id,
          changes,
          updatedAt: now,
        },
      },
    ],
    thread: { ...current, ...changes, updatedAt: now },
  };
}

export interface OpenAssistantDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly registry: DecideContext['registry'];
  listModels(providerInstanceId: string): Promise<ProviderModel[]>;
}

export interface OpenedAssistant {
  readonly thread: Thread | null;
  readonly problem: string | null;
}

// What `assistant.open` does. The decision itself is the command's; this only asks the provider
// for a model when nothing else names one, which a decision cannot do.
export async function openAssistantThread(deps: OpenAssistantDeps): Promise<OpenedAssistant> {
  const read = readModel(deps.db);
  const now = () => read.thread(assistantThreadId) ?? null;
  const resolved = resolveAssistant(read, { now: '', registry: deps.registry });
  if (resolved.problem !== null) return { thread: now(), problem: resolved.problem };
  let fallback: AssistantFallback = {};
  if (resolved.model === undefined || resolved.effort === undefined) {
    const { instance } = resolved;
    try {
      const models = await deps.listModels(instance.id);
      const model = resolved.model ?? models[0]?.id;
      fallback = {
        model,
        effort: models.find((entry) => entry.id === model)?.efforts[0],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        thread: now(),
        problem: `${instance.name} could not say which models it has (${reason}). Choose a model in Settings → Assistant.`,
      };
    }
  }
  try {
    deps.engine.dispatch(`assistant-open:${randomUUID()}`, {
      type: 'thread.openAssistant',
      ...(fallback.model ? { fallbackModel: fallback.model } : {}),
      ...(fallback.effort ? { fallbackEffort: fallback.effort } : {}),
    });
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    return { thread: now(), problem: error.message };
  }
  return { thread: now(), problem: null };
}
