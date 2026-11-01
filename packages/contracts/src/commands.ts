import { z } from 'zod';
import { Project } from './projections.js';
import { SettingScopeRef } from './settings.js';

// Commands are what clients ask for; events are what the server decided happened. Later units
// add their own members to both unions.

const Id = z.string().min(1);

export const CommandId = z.string().min(1).max(200);
export type CommandId = z.infer<typeof CommandId>;

export const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project.create'),
    projectId: Id,
    name: z.string().min(1),
    cwd: z.string().min(1),
    defaultProviderInstanceId: Id.optional(),
    defaultModel: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('project.update'),
    projectId: Id,
    name: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    defaultProviderInstanceId: Id.nullable().optional(),
    defaultModel: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal('project.delete'), projectId: Id }),
  z.object({
    type: z.literal('setting.set'),
    key: z.string().min(1),
    scope: SettingScopeRef,
    value: z.unknown(),
  }),
  z.object({ type: z.literal('setting.reset'), key: z.string().min(1), scope: SettingScopeRef }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];

export const ProjectChanges = Project.pick({
  name: true,
  cwd: true,
  defaultProviderInstanceId: true,
  defaultModel: true,
}).partial();
export type ProjectChanges = z.infer<typeof ProjectChanges>;

export const DomainEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project.created'), aggregate: Id, payload: Project }),
  z.object({
    kind: z.literal('project.updated'),
    aggregate: Id,
    payload: z.object({ projectId: Id, changes: ProjectChanges }),
  }),
  z.object({
    kind: z.literal('project.deleted'),
    aggregate: Id,
    payload: z.object({ projectId: Id }),
  }),
  z.object({
    kind: z.literal('setting.changed'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef, value: z.unknown() }),
  }),
  z.object({
    kind: z.literal('setting.reset'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef }),
  }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventKind = DomainEvent['kind'];

export const DispatchResult = z.object({
  commandId: CommandId,
  // Sequence numbers of the events this command appended; empty when it changed nothing.
  seqs: z.array(z.number().int().positive()),
  // True when the command id had already been applied and this is the stored receipt.
  duplicate: z.boolean(),
});
export type DispatchResult = z.infer<typeof DispatchResult>;
