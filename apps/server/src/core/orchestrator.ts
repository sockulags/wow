import {
  SecretRef,
  type BacklogItem,
  type Command,
  type DomainEvent,
  type Project,
  type ProjectChanges,
  type ProviderInstance,
  type RpcErrorCode,
  type SettingDefinition,
  type SettingScopeRef,
  type Skill,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { decideWorkflow } from './workflows.js';

// The orchestrator decides which events a command produces. It is a pure function of the command,
// a read-only view of the projections and the context; it never writes or performs effects.

export interface ReadModel {
  project(id: string): Project | undefined;
  providerInstanceExists(id: string): boolean;
  // Stored value at exactly this scope, or undefined when none is stored.
  setting(key: string, scope: SettingScopeRef): { value: unknown } | undefined;
  providerInstance(id: string): ProviderInstance | undefined;
  skills(): Skill[];
  workflow(id: string): Workflow | undefined;
  run(id: string): WorkflowRun | undefined;
  // True while a run of this workflow is running or waiting at a gate.
  hasLiveRun(workflowId: string): boolean;
  threadExists(id: string): boolean;
  backlogItem(id: string): BacklogItem | undefined;
}

export interface DecideContext {
  readonly now: string;
  readonly registry: Readonly<Record<string, SettingDefinition>>;
}

export class CommandRejected extends Error {
  constructor(
    readonly code: Extract<RpcErrorCode, 'rejected' | 'not_found' | 'conflict'>,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CommandRejected';
  }
}

export function decide(command: Command, read: ReadModel, context: DecideContext): DomainEvent[] {
  switch (command.type) {
    case 'project.create': {
      if (read.project(command.projectId)) {
        throw new CommandRejected('conflict', `Project ${command.projectId} already exists`);
      }
      return [
        {
          kind: 'project.created',
          aggregate: command.projectId,
          payload: {
            id: command.projectId,
            name: command.name,
            cwd: command.cwd,
            defaultProviderInstanceId: command.defaultProviderInstanceId ?? null,
            defaultModel: command.defaultModel ?? null,
            createdAt: context.now,
          },
        },
      ];
    }
    case 'project.update': {
      const project = read.project(command.projectId);
      if (!project) throw new CommandRejected('not_found', `No project ${command.projectId}`);
      const changes: ProjectChanges = {};
      if (command.name !== undefined && command.name !== project.name) changes.name = command.name;
      if (command.cwd !== undefined && command.cwd !== project.cwd) changes.cwd = command.cwd;
      if (
        command.defaultProviderInstanceId !== undefined &&
        command.defaultProviderInstanceId !== project.defaultProviderInstanceId
      ) {
        changes.defaultProviderInstanceId = command.defaultProviderInstanceId;
      }
      if (command.defaultModel !== undefined && command.defaultModel !== project.defaultModel) {
        changes.defaultModel = command.defaultModel;
      }
      if (Object.keys(changes).length === 0) return [];
      return [
        {
          kind: 'project.updated',
          aggregate: command.projectId,
          payload: { projectId: command.projectId, changes },
        },
      ];
    }
    case 'project.delete': {
      if (!read.project(command.projectId)) {
        throw new CommandRejected('not_found', `No project ${command.projectId}`);
      }
      return [
        {
          kind: 'project.deleted',
          aggregate: command.projectId,
          payload: { projectId: command.projectId },
        },
      ];
    }
    case 'setting.set': {
      const definition = settingDefinition(command.key, context);
      checkScope(command.key, definition, command.scope, read);
      const parsed = definition.schema.safeParse(command.value);
      if (!parsed.success) {
        throw new CommandRejected(
          'rejected',
          `Invalid value for ${command.key}`,
          parsed.error.issues,
        );
      }
      if (definition.secret && !SecretRef.safeParse(parsed.data).success) {
        throw new CommandRejected(
          'rejected',
          `${command.key} is secret: store the value with secrets.set and save the reference`,
        );
      }
      const stored = read.setting(command.key, command.scope);
      if (stored && isDeepStrictEqual(stored.value, parsed.data)) return [];
      return [
        {
          kind: 'setting.changed',
          aggregate: settingAggregate(command.key, command.scope),
          payload: { key: command.key, scope: command.scope, value: parsed.data },
        },
      ];
    }
    case 'setting.reset': {
      settingDefinition(command.key, context);
      if (!read.setting(command.key, command.scope)) return [];
      return [
        {
          kind: 'setting.reset',
          aggregate: settingAggregate(command.key, command.scope),
          payload: { key: command.key, scope: command.scope },
        },
      ];
    }
    case 'skills.sync': {
      const current = new Map(read.skills().map((skill) => [skill.id, skill]));
      const next = new Set(command.skills.map((skill) => skill.id));
      if (next.size !== command.skills.length) {
        throw new CommandRejected('rejected', 'Skill ids must be unique');
      }
      const upserted = command.skills.filter(
        (skill) => !isDeepStrictEqual(current.get(skill.id), skill),
      );
      const removed = [...current.keys()].filter((id) => !next.has(id));
      if (upserted.length === 0 && removed.length === 0) return [];
      return [{ kind: 'skills.synced', aggregate: 'skills', payload: { upserted, removed } }];
    }
    case 'workflow.create':
    case 'workflow.update':
    case 'workflow.delete':
    case 'workflowRun.start':
    case 'workflowRun.continue':
    case 'workflowRun.stop':
    case 'workflowRun.stepCompleted':
    case 'workflowRun.stepFailed':
    case 'workflowRun.artifactsFound':
      return decideWorkflow(command, read, context);
  }
}

const settingAggregate = (key: string, scope: SettingScopeRef) => `setting:${scope}:${key}`;

function settingDefinition(key: string, context: DecideContext): SettingDefinition {
  const definition = Object.hasOwn(context.registry, key) ? context.registry[key] : undefined;
  if (!definition) throw new CommandRejected('not_found', `Unknown setting ${key}`);
  return definition;
}

// A setting's registry scope is the narrowest place it may be stored: 'global' settings only
// globally, 'project' settings also per project, 'provider' settings per project and per provider
// instance as well.
function checkScope(
  key: string,
  definition: SettingDefinition,
  scope: SettingScopeRef,
  read: ReadModel,
): void {
  if (scope === 'global') return;
  const [kind, ...rest] = scope.split(':');
  const id = rest.join(':');
  const allowed =
    kind === 'project'
      ? definition.scope === 'project' || definition.scope === 'provider'
      : definition.scope === 'provider';
  if (!allowed) {
    throw new CommandRejected('rejected', `${key} can only be set at ${definition.scope} scope`);
  }
  if (kind === 'project' && !read.project(id)) {
    throw new CommandRejected('not_found', `No project ${id}`);
  }
  if (kind === 'provider' && !read.providerInstanceExists(id)) {
    throw new CommandRejected('not_found', `No provider instance ${id}`);
  }
}
