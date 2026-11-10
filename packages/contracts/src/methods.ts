import { z } from 'zod';
import { Command, CommandId, DispatchResult } from './commands.js';
import { RunDiff, RunDiffParams } from './diff.js';
import { FileReadParams, FileReadResult } from './files.js';
import { ChangeRequest, HostRead, HostRefreshParams, TicketRead } from './hosts.js';
import {
  Approval,
  BacklogItem,
  BacklogRemote,
  CalendarItem,
  MailItem,
  AppNotification,
  OutlookStatus,
  PlanIntent,
  PlanRun,
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
import { ProjectGit, ProjectTrackers, PublishProject, TrackerValueSource } from './trackers.js';

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
  planIntents: { row: PlanIntent, threadScoped: false },
  planRuns: { row: PlanRun, threadScoped: false },
  changeRequests: { row: ChangeRequest, threadScoped: false },
  hostReads: { row: HostRead, threadScoped: false },
  ticketReads: { row: TicketRead, threadScoped: false },
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
  // The project whose tracker settings apply, or null for the defaults in Settings → Trackers.
  project: PublishProject.nullable(),
  // True when the item has no project of its own and none was chosen while projects exist: the
  // dialog asks which project the issue is for before showing the rest (owner decision F-4).
  needsProject: z.boolean(),
  // Where the repository or Jira project key came from, and the host it is on ("github.com", an
  // Enterprise host, or the Jira site), or null while not set up.
  targetSource: TrackerValueSource,
  targetHost: z.string().nullable(),
});
export type TrackerPreview = z.infer<typeof TrackerPreview>;

// "Test connection" in Settings → Trackers: signs in with the stored settings and says as whom
// (audit E-08). `missing` names settings still empty; nothing is sent while any are.
export const TrackerTestResult = z.object({
  service: TrackerService,
  ok: z.boolean(),
  // The signed-in account: Jira display name and email, or the GitHub login.
  account: z.string().nullable(),
  message: z.string(),
  missing: z.array(z.string()),
});
export type TrackerTestResult = z.infer<typeof TrackerTestResult>;

// `projectId` picks whose tracker settings apply: left out, the item's card or run decides; null
// means the defaults in Settings → Trackers.
const TrackerParams = z.object({
  backlogItemId: z.string().min(1),
  service: TrackerService,
  projectId: z.string().min(1).nullable().optional(),
});

// What the user changed in the preview before creating: the title, and the item's tags chosen as
// labels (added to the GitHub labels setting; Jira labels cannot hold spaces, so they become
// dashes there).
const TrackerPublishParams = TrackerParams.extend({
  title: z.string().trim().min(1).optional(),
  labels: z.array(z.string().trim().min(1)).optional(),
});

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
  // Runs the npm update the instance's last test offered (`update`, method npm) as a server
  // subprocess and answers once it started with the command it runs. Progress and output arrive
  // as the instance's `updateRun`; after a good install the server tests the instance again.
  'provider.update': {
    params: z.object({ providerInstanceId: z.string().min(1) }),
    result: z.object({ command: z.string().min(1) }),
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
  // Reads every project's intents folder now and answers with the intents found. Files only; no
  // host is asked.
  'plans.refresh': {
    params: NoParams,
    result: z.object({ intents: z.array(PlanIntent) }),
  },
  // "Refresh now" (review loop spec 30): asks the host once about one followed plan, one run, or
  // everything wow follows, whatever the polling settings say, and answers with what is stored
  // for them afterwards. A host that fails is an answer (the read's `error`), not an RPC error.
  'hosts.refresh': {
    params: HostRefreshParams,
    result: z.object({ reads: z.array(HostRead) }),
  },
  // Looks for each started step's expected artifacts in the project folder (behavior 26, run
  // view open) and stores what it finds.
  'workflowRuns.detectArtifacts': {
    params: z.object({ runId: z.string().min(1) }),
    result: WorkflowRun,
  },
  // What the run changed in its working folder since its base commit: the changed files, or one
  // file's diff when `path` is given. Read only; git runs with hooks off.
  'workflowRuns.diff': {
    params: RunDiffParams,
    result: RunDiff,
  },
  // "Remove working copy" (review loop spec 37): deletes a kept working copy of a run that has
  // ended, with whatever is uncommitted or unpushed in it. The app asks before it calls this.
  'workflowRuns.removeWorkingCopy': {
    params: z.object({ runId: z.string().min(1) }),
    result: WorkflowRun,
  },
  // Files in a project folder that expected artifact globs match, for the builder's "Matches 2
  // files in Demo" line. Read only; nothing is stored.
  'workflows.matchArtifacts': {
    params: z.object({ projectId: z.string().min(1), globs: z.array(z.string().min(1)) }),
    result: z.object({ files: z.array(z.string()) }),
  },
  // Reads one file of a run for the viewer. Only files inside the run's working folder or the
  // project folder are read; anything else is answered as `refused` with the reason.
  'files.read': {
    params: FileReadParams,
    result: FileReadResult,
  },
  // Each project folder's git status and remotes, for the rows in Settings → Projects. Read only.
  'projects.git': {
    params: NoParams,
    result: z.object({ projects: z.array(ProjectGit) }),
  },
  // One project's tracker settings with where each value came from, and suggestions to confirm.
  'trackers.project': {
    params: z.object({ projectId: z.string().min(1) }),
    result: ProjectTrackers,
  },
  'trackers.preview': {
    params: TrackerParams,
    result: TrackerPreview,
  },
  // Signs in with the settings as they apply to the project, or the defaults without one.
  'trackers.test': {
    params: z.object({ service: TrackerService, projectId: z.string().min(1).optional() }),
    result: TrackerTestResult,
  },
  // Creates the issue and stores its key and URL on the item. Refused when the item already has
  // one or the tracker is not configured.
  'trackers.publish': {
    params: TrackerPublishParams,
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
