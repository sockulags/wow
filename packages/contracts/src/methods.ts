import { z } from 'zod';
import { Command, CommandId, DispatchResult } from './commands.js';
import {
  Approval,
  BacklogItem,
  CalendarItem,
  MailItem,
  OutlookStatus,
  Project,
  ProviderInstance,
  Question,
  SettingRow,
  Skill,
  Thread,
  ThreadItem,
  Trigger,
  Turn,
  Workflow,
  WorkflowRun,
} from './projections.js';
import { SecretRef } from './settings.js';

// Subscription topics: one per projection. Thread-scoped topics need a threadId so a client
// never receives every item of every thread.
export const subscriptionTopics = {
  projects: { row: Project, threadScoped: false },
  providerInstances: { row: ProviderInstance, threadScoped: false },
  threads: { row: Thread, threadScoped: false },
  turns: { row: Turn, threadScoped: true },
  threadItems: { row: ThreadItem, threadScoped: true },
  approvals: { row: Approval, threadScoped: true },
  questions: { row: Question, threadScoped: true },
  calendarItems: { row: CalendarItem, threadScoped: false },
  mailItems: { row: MailItem, threadScoped: false },
  outlookStatus: { row: OutlookStatus, threadScoped: false },
  backlogItems: { row: BacklogItem, threadScoped: false },
  workflows: { row: Workflow, threadScoped: false },
  workflowRuns: { row: WorkflowRun, threadScoped: false },
  triggers: { row: Trigger, threadScoped: false },
  skills: { row: Skill, threadScoped: false },
  settings: { row: SettingRow, threadScoped: false },
} as const;

export type SubscriptionTopic = keyof typeof subscriptionTopics;
export const SubscriptionTopic = z.enum(
  Object.keys(subscriptionTopics) as [SubscriptionTopic, ...SubscriptionTopic[]],
);

export type TopicRow<T extends SubscriptionTopic> = z.output<(typeof subscriptionTopics)[T]['row']>;

export const SubscribeParams = z
  .object({ topic: SubscriptionTopic, threadId: z.string().min(1).optional() })
  .refine((params) => !subscriptionTopics[params.topic].threadScoped || params.threadId, {
    message: 'This topic needs a threadId',
    path: ['threadId'],
  });
export type SubscribeParams = z.infer<typeof SubscribeParams>;

export const ResolvedSetting = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  // The scope the value came from, or 'default' when nothing is stored.
  source: z.string().min(1),
});
export type ResolvedSetting = z.infer<typeof ResolvedSetting>;

export const SecretProtection = z.enum(['dpapi', 'none']);
export type SecretProtection = z.infer<typeof SecretProtection>;

const NoParams = z.object({}).strict();

// Every method the server answers. A request's params and the response's result are validated
// against these on the server, and the client runtime can use the same schemas.
export const rpcMethods = {
  'server.info': {
    params: NoParams,
    result: z.object({ version: z.string(), home: z.string(), pid: z.number().int() }),
  },
  dispatch: {
    params: z.object({ commandId: CommandId, command: Command }),
    result: DispatchResult,
  },
  subscribe: {
    params: SubscribeParams,
    result: z.object({ subscriptionId: z.string().min(1), data: z.array(z.unknown()) }),
  },
  unsubscribe: {
    params: z.object({ subscriptionId: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
  'settings.resolve': {
    params: z.object({
      projectId: z.string().min(1).optional(),
      providerInstanceId: z.string().min(1).optional(),
    }),
    result: z.array(ResolvedSetting),
  },
  'secrets.set': {
    params: z.object({ name: z.string().min(1), value: z.string() }),
    result: SecretRef,
  },
  'secrets.delete': {
    params: z.object({ name: z.string().min(1) }),
    result: z.object({ removed: z.boolean() }),
  },
  'secrets.status': {
    params: NoParams,
    result: z.object({ protection: SecretProtection, names: z.array(z.string()) }),
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type RpcMethod = keyof typeof rpcMethods;
export type RpcParams<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['result']>;

export const isRpcMethod = (method: string): method is RpcMethod =>
  Object.hasOwn(rpcMethods, method);

export const RpcErrorCode = z.enum([
  'parse_error',
  'invalid_request',
  'unknown_method',
  'invalid_params',
  'rejected',
  'conflict',
  'not_found',
  'internal',
]);
export type RpcErrorCode = z.infer<typeof RpcErrorCode>;
