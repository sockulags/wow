import {
  SecretRef,
  type DomainEvent,
  type ProviderInstance,
  type ProviderInstanceChanges,
  type ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type ReadModel } from './orchestrator.js';

// Editing and removing provider instances from Settings → Providers (spec 31, 32).

export type ProviderInstanceCommand = Extract<
  ServerCommand,
  { type: 'providerInstance.update' | 'providerInstance.delete' }
>;

export const isProviderInstanceCommand = (
  command: ServerCommand,
): command is ProviderInstanceCommand =>
  command.type === 'providerInstance.update' || command.type === 'providerInstance.delete';

const editable = [
  'name',
  'binaryPath',
  'configDir',
  'env',
  'launchArgs',
  'defaultModel',
  'defaultEffort',
  'defaultPermissionMode',
] as const;

// Changing any of these changes how the CLI starts, so the last "Test" no longer describes it.
const launchFields = new Set<string>(['binaryPath', 'configDir', 'env', 'launchArgs']);

const secretNames = (env: ProviderInstance['env']): string[] =>
  Object.values(env).flatMap((value) => {
    const ref = SecretRef.safeParse(value);
    return ref.success ? [ref.data.secretRef] : [];
  });

function requireInstance(read: ReadModel, id: string): ProviderInstance {
  const instance = read.providerInstance(id);
  if (!instance) throw new CommandRejected('not_found', `No provider instance ${id}`);
  return instance;
}

export function decideProviderInstance(
  command: ProviderInstanceCommand,
  read: ReadModel,
): DomainEvent[] {
  const instance = requireInstance(read, command.providerInstanceId);
  const usage = read.instanceUsage(command.providerInstanceId);
  if (usage.runningTurns > 0) {
    throw new CommandRejected(
      'rejected',
      `${instance.name} has a turn running. Stop it before changing the instance.`,
    );
  }
  switch (command.type) {
    case 'providerInstance.update': {
      const changes: Record<string, unknown> = {};
      for (const field of editable) {
        const next = command[field];
        if (next !== undefined && !isDeepStrictEqual(next, instance[field])) changes[field] = next;
      }
      if (Object.keys(changes).length === 0) return [];
      if (Object.keys(changes).some((field) => launchFields.has(field))) {
        Object.assign(changes, {
          status: 'unknown',
          account: null,
          version: null,
          statusMessage: null,
          update: null,
        });
      }
      const kept = new Set(secretNames(command.env ?? instance.env));
      return [
        {
          kind: 'providerInstance.updated',
          aggregate: command.providerInstanceId,
          payload: {
            providerInstanceId: command.providerInstanceId,
            // Every key comes from `editable` or the status reset above, all ProviderInstance fields.
            changes: changes as ProviderInstanceChanges,
            releasedSecrets: secretNames(instance.env).filter((name) => !kept.has(name)),
          },
        },
      ];
    }
    case 'providerInstance.delete': {
      if (usage.threads > 0) {
        throw new CommandRejected(
          'rejected',
          `${instance.name} is used by ${usage.threads} thread${usage.threads === 1 ? '' : 's'}, which resume on it. Keep it, or change its settings instead.`,
        );
      }
      return [
        {
          kind: 'providerInstance.deleted',
          aggregate: command.providerInstanceId,
          payload: {
            providerInstanceId: command.providerInstanceId,
            releasedSecrets: secretNames(instance.env),
          },
        },
      ];
    }
  }
}
