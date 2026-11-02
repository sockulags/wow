import { z } from 'zod';
import { Command, CommandId, DispatchResult } from './commands.js';
import {
  Approval,
  BacklogItem,
  BacklogRemote,
  CalendarItem,
  MailItem,
  AppNotification,
  OutlookStatus,
  Project,
  ProviderInstance,
  Question,
  SettingRow,
  Skill,
  Thread,
  ThreadItem,
  TrackerService,
  Trigger,
  Turn,
  Workflow,
  WorkflowRun,
} from './projections.js';
import {
  DetectedProvider,
  DiscoveredProject,
  ProviderModel,
  ProviderTestResult,
} from './provider.js';
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
  notifications: { row: AppNotification, threadScoped: false },
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

// What "Publish to Jira" or "Publish to GitHub" would create, shown before the user confirms
// (behavior 30). `missing` names the tracker settings still empty; `existing` is the issue the
// item was already published as, which the app offers to open instead.
export const TrackerPreview = z.object({
  service: TrackerService,
  // "PROJ" for Jira, "owner/repo" for GitHub, empty while not configured.
  target: z.string(),
  title: z.string(),
  body: z.string(),
  // The Jira issue type, or null for GitHub.
  issueType: z.string().nullable(),
  // GitHub labels; empty for Jira.
  labels: z.array(z.string()),
  missing: z.array(z.string()),
  existing: BacklogRemote.nullable(),
});
export type TrackerPreview = z.infer<typeof TrackerPreview>;

const TrackerParams = z.object({ backlogItemId: z.string().min(1), service: TrackerService });

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
  // Runs the instance's trivial test turn and records status, account and version (spec 31, 32).
  'provider.test': {
    params: z.object({ providerInstanceId: z.string().min(1) }),
    result: ProviderTestResult,
  },
  'provider.listModels': {
    params: z.object({ providerInstanceId: z.string().min(1) }),
    result: z.array(ProviderModel),
  },
  // Looks for each provider's CLI on the server's PATH and its config directory (first run).
  'provider.detect': {
    params: NoParams,
    result: z.array(DetectedProvider),
  },
  // Folders the configured Claude and Codex instances have worked in that are not projects yet
  // ("Import from Claude and Codex"), newest first.
  'projects.discover': {
    params: NoParams,
    result: z.object({ projects: z.array(DiscoveredProject) }),
  },
  'secrets.status': {
    params: NoParams,
    result: z.object({ protection: SecretProtection, names: z.array(z.string()) }),
  },
  // Asks Outlook to show a mail or calendar item (spec 4). Nothing in Outlook changes.
  'outlook.open': {
    params: z.object({ entryId: z.string().min(1) }),
    result: z.object({ opened: z.literal(true) }),
  },
  // Polls Outlook now instead of waiting for the next interval.
  'outlook.refresh': {
    params: NoParams,
    result: z.object({ outcome: z.enum(['synced', 'failed']) }),
  },
  // Scans the skill directories now (behavior 27: refresh) and answers with the skills found.
  'skills.refresh': {
    params: NoParams,
    result: z.object({ skills: z.array(Skill) }),
  },
  // Looks for each started step's expected artifacts in the project folder (behavior 26, run
  // view open) and stores what it finds.
  'workflowRuns.detectArtifacts': {
    params: z.object({ runId: z.string().min(1) }),
    result: WorkflowRun,
  },
  'trackers.preview': {
    params: TrackerParams,
    result: TrackerPreview,
  },
  // Creates the issue and stores its key and URL on the item. Refused when the item already has
  // one or the tracker is not configured.
  'trackers.publish': {
    params: TrackerParams,
    result: BacklogRemote,
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
