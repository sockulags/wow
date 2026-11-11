import {
  assistantThreadId,
  chooseAssistantProvider,
  hideSecrets,
  secretPatterns,
  providerChatOptions,
  providerSetup,
  settingGroupTitles,
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

const storedPatterns = (read: ReadModel, context: DecideContext) => {
  const sources = storedValue('assistant.secretPatterns', read, context);
  return secretPatterns(
    Array.isArray(sources) ? sources.filter((entry) => typeof entry === 'string') : [],
  );
};

// What the user did with the assistant's work since its last turn began (spec 10): the
// proposals they answered, with the reason given with a No, and the changes they undid. It goes
// before the user's message in the prompt; the conversation shows only the message.
export function assistantAnswersNote(read: ReadModel, context: DecideContext): string | null {
  const since = read.lastTurn(assistantThreadId)?.startedAt;
  const { proposals, undone } = read.assistantAnswers(since);
  if (proposals.length === 0 && undone.length === 0) return null;
  const patterns = storedPatterns(read, context);
  const lines = [
    ...proposals.map((proposal) =>
      proposal.state === 'accepted'
        ? `- Yes to "${proposal.title}": it is applied.`
        : `- No to "${proposal.title}": nothing changed.${proposal.reason ? ` Their reason: ${proposal.reason}` : ''}`,
    ),
    ...undone.map((change) => `- Undid "${change.what}" (${change.place.label}).`),
  ];
  return hideSecrets(
    `[From wow, not typed by the user] Since your last turn the user answered:\n${lines.join('\n')}`,
    patterns,
  );
}

// The line wow sends for the user when the first-start step is done (spec 26).
export const storedGreeting = (read: ReadModel, context: DecideContext): string => {
  const value = stored('assistant.greeting', read, context);
  const fallback = context.registry['assistant.greeting']?.default;
  return value || (typeof fallback === 'string' ? fallback : 'Hello');
};

const trackerKinds = ['github', 'gitlab', 'jira', 'confluence'] as const;

const placeOf = (key: string, context: DecideContext): string => {
  const group = context.registry[key]?.group;
  return group ? `Settings → ${settingGroupTitles[group]}` : 'Settings';
};

const names = (rows: readonly { readonly name: string }[]): string =>
  rows.length === 0 ? 'none' : rows.map((row) => row.name).join(', ');

// What the greeting turn tells the agent besides the user's line (spec 24, 26): what is set up,
// what a first run still needs, and, after a setup file, what it left to fill in and what only
// this person can say. Facts only; what to do with them is in `assistant.instructions`.
export function firstStartNote(
  read: ReadModel,
  context: DecideContext,
  providerInstanceId: string,
): string {
  const instance = read.providerInstance(providerInstanceId);
  const ready = read.providerInstances().filter((row) => row.status === 'ready');
  const projects = read.projects();
  const workflows = read.workflows();
  // Only what this install stored: a default address is not a tracker someone set up.
  const isSet = (key: string) => read.setting(key, 'global')?.value != null;
  const trackers = trackerKinds.flatMap((kind) => {
    const address = read.setting(`trackers.${kind}.baseUrl`, 'global')?.value;
    if (typeof address !== 'string' || address === '') return [];
    const label = context.registry[`trackers.${kind}.baseUrl`]?.label ?? kind;
    return [`${label} ${address}, token ${isSet(`trackers.${kind}.token`) ? 'set' : 'not set'}`];
  });
  const setUp = [
    `- Providers: ${ready.length === 0 ? 'none' : ready.map((row) => `${row.name} (${providerSetup[row.kind].label})`).join(', ')}`,
    `- Projects: ${names(projects)}`,
    `- Workflows: ${names(workflows)}`,
    `- Trackers: ${trackers.length === 0 ? 'none' : trackers.join('; ')}`,
  ];
  const needed = [
    ...(projects.length === 0
      ? ['- A project: the folder a run works in (Settings → Projects).']
      : []),
    ...(workflows.length === 0
      ? ['- A workflow: start one from a template (Workflows → New workflow).']
      : []),
  ];
  const application = read.lastSetupApplication();
  const fillIn = application
    ? [
        ...application.toFillIn
          .filter((entry) => !isSet(entry.key))
          .map(
            (entry) =>
              `- ${entry.label} (${entry.key}, ${entry.place.label}): a secret; show its field.`,
          ),
        ...(isSet('calendar.workHours')
          ? []
          : [
              `- Work hours (calendar.workHours, ${placeOf('calendar.workHours', context)}): only this person can say.`,
            ]),
        '- Project folders (Settings → Projects): a setup file holds none, they differ per machine.',
      ]
    : [];
  const lines = [
    `[From wow, not typed by the user] The first-start step just finished: ${instance?.name ?? providerInstanceId} passed its test and runs this conversation.`,
    'Set up:',
    ...setUp,
    'Still needed for a first run:',
    ...(needed.length === 0 ? ['- Nothing.'] : needed),
    ...(application ? [`To fill in after the setup file ${application.name}:`, ...fillIn] : []),
  ];
  return hideSecrets(lines.join('\n'), storedPatterns(read, context));
}
