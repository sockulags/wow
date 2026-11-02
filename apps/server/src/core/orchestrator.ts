import {
  SecretRef,
  type Approval,
  type DomainEvent,
  type Project,
  type ProjectChanges,
  type ProviderInstance,
  type Question,
  type RpcErrorCode,
  type ServerCommand,
  type SettingDefinition,
  type SettingScopeRef,
  type Thread,
  type Turn,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { decideProviderInstance, isProviderInstanceCommand } from './provider-instances.js';
import { decideThread, isThreadCommand } from './threads.js';

// The orchestrator decides which events a command produces. It is a pure function of the command,
// a read-only view of the projections and the context; it never writes or performs effects.

export interface ReadModel {
  project(id: string): Project | undefined;
  providerInstanceExists(id: string): boolean;
  providerInstance(id: string): ProviderInstance | undefined;
  // Threads that use the instance, and how many of them have a turn running.
  instanceUsage(id: string): { readonly threads: number; readonly runningTurns: number };
  // Stored value at exactly this scope, or undefined when none is stored.
  setting(key: string, scope: SettingScopeRef): { value: unknown } | undefined;
  thread(id: string): Thread | undefined;
  runningTurn(threadId: string): Turn | undefined;
  turnCount(threadId: string): number;
  // Index the next item of the thread gets.
  nextItemIndex(threadId: string): number;
  itemExists(id: string): boolean;
  approval(id: string): Approval | undefined;
  question(id: string): Question | undefined;
  // Approvals and questions of the thread that are still waiting for an answer.
  openRequests(threadId: string): number;
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

export function decide(
  command: ServerCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (isProviderInstanceCommand(command)) return decideProviderInstance(command, read);
  if (isThreadCommand(command)) return decideThread(command, read, context);
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
