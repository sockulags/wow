import { z } from 'zod';
import { CalendarRange, CalendarRangeParams } from './repeat.js';
import { AssistantChange, AssistantProposal } from './assistant.js';
import {
  AttachmentPutParams,
  AttachmentPutResult,
  AttachmentReadParams,
  AttachmentReadResult,
} from './attachments.js';
import { Command, CommandId, DispatchResult } from './commands.js';
import { RunDiff, RunDiffParams, ThreadDiff, ThreadDiffParams } from './diff.js';
import { FileListParams, FileListResult, FileReadParams, FileReadResult } from './files.js';
import { HostItemRead, HostLookupParams, HostLookupResult } from './host-links.js';
import { ChangeRequest, HostRead, HostRefreshParams, PageRead, TicketRead } from './hosts.js';
import {
  Approval,
  BacklogItem,
  BacklogRemote,
  CalendarItem,
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
  ProviderSlashCommand,
  ProviderTestResult,
} from './provider.js';
import { SecretRef } from './settings.js';
import { SetupApplication, SetupRead, SetupSaved } from './setup.js';
import {
  ProjectGit,
  ProjectTrackers,
  PublishProject,
  TrackerConnection,
  TrackerValueSource,
} from './trackers.js';

// Subscription topics: one per projection. Thread-scoped topics need a threadId so a client
// never receives every item of every thread.
export const subscriptionTopics = {
  projects: { row: Project, threadScoped: false },
  providerInstances: { row: ProviderInstance, threadScoped: false },
  // Chat threads and the threads of workflow steps; never the assistant thread.
  threads: { row: Thread, threadScoped: false },
  // The assistant thread: no row before it was first opened, one row after.
  assistantThread: { row: Thread, threadScoped: false },
  turns: { row: Turn, threadScoped: true },
  threadItems: { row: ThreadItem, threadScoped: true },
  approvals: { row: Approval, threadScoped: true },
  questions: { row: Question, threadScoped: true },
  calendarItems: { row: CalendarItem, threadScoped: false },
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
  pageReads: { row: PageRead, threadScoped: false },
  // What was read about the items a chat thread links to (agent workbench spec 22).
  hostItemReads: { row: HostItemRead, threadScoped: true },
  settings: { row: SettingRow, threadScoped: false },
  assistantChanges: { row: AssistantChange, threadScoped: false },
  assistantProposals: { row: AssistantProposal, threadScoped: false },
  // Setup files applied here, in the order applied, with their Undo state.
  setupApplications: { row: SetupApplication, threadScoped: false },
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
  service: TrackerConnection,
  ok: z.boolean(),
  // The signed-in account: Jira display name and email, the GitHub login or the GitLab user.
  account: z.string().nullable(),
  // The host's version where it says one (GitLab), so the user knows which API wow talks to.
  version: z.string().nullable(),
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
  // The provider's own slash commands for a thread's folder (agent workbench spec 60); empty for
  // a provider that reports none (Codex).
  'provider.listCommands': {
    params: z.object({
      providerInstanceId: z.string().min(1),
      cwd: z.string().min(1),
      threadId: z.string().min(1).optional(),
    }),
    result: z.array(ProviderSlashCommand),
  },
  // Asks for the assistant thread (app assistant spec 1, 27): makes it when it is not there yet,
  // moves it when the settings name another provider instance, model or effort, and answers the
  // thread as it is now. When no connected instance can run it, `problem` says why in words and
  // nothing was changed; a thread made earlier is still answered, so its conversation shows.
  'assistant.open': {
    params: NoParams,
    result: z.object({ thread: Thread.nullable(), problem: z.string().nullable() }),
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
  // The threads whose title, project name or message text hold every word of the query
  // (agent workbench spec 66, 69), archived ones included, newest first. Never the assistant's.
  'threads.search': {
    params: z.object({ query: z.string() }),
    result: z.object({ threadIds: z.array(z.string()) }),
  },
  // The occurrences of the local cards in a range (recurring cards spec 15, 17): every
  // occurrence of a repeating card, at most `calendar.maxOccurrences` of one card, and a card
  // without a rule as its one occurrence. Worked out by the server in each card's zone.
  'calendar.occurrences': {
    params: CalendarRangeParams,
    result: CalendarRange,
  },
  // Asks Outlook to show a meeting (spec 1). Nothing in Outlook changes.
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
  // A chat thread's links (agent workbench spec 20 to 25): the sites and references wow may read
  // for the thread, the item a link or reference names, and its read. Reads only when asked
  // (`read`), never on a timer. A host that fails is an answer (the read's `error`).
  'hosts.lookup': {
    params: HostLookupParams,
    result: HostLookupResult,
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
  // What a chat thread changed in its folder since its first turn (agent workbench spec 34).
  'threads.diff': {
    params: ThreadDiffParams,
    result: ThreadDiff,
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
  // Reads one file for the viewer, of a run, a thread or a project. Only files inside the scope's
  // folders are read; anything else is answered as `refused` with the reason.
  'files.read': {
    params: FileReadParams,
    result: FileReadResult,
  },
  // Lists the files of a thread's, run's or project's folder for "Open file…" and `@`.
  'files.list': {
    params: FileListParams,
    result: FileListResult,
  },
  // Stores one image for a thread's next message (agent workbench spec 53 to 55). Refused, as
  // `rejected` with the reason, when it is too large, not a PNG, JPEG, GIF or WebP, or for a
  // model the provider says takes no images, and for the assistant's thread (spec 61).
  'attachments.put': {
    params: AttachmentPutParams,
    result: AttachmentPutResult,
  },
  // One stored image of a thread, for its chip and its message.
  'attachments.read': {
    params: AttachmentReadParams,
    result: AttachmentReadResult,
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
    params: z.object({ service: TrackerConnection, projectId: z.string().min(1).optional() }),
    result: TrackerTestResult,
  },
  // Creates the issue and stores its key and URL on the item. Refused when the item already has
  // one or the tracker is not configured.
  'trackers.publish': {
    params: TrackerPublishParams,
    result: BacklogRemote,
  },
  // "Save setup to a file" (app assistant spec 21): the setup as YAML. Nothing is written on
  // the server; the app hands the text to the user as a file.
  'setup.save': {
    params: NoParams,
    result: SetupSaved,
  },
  // Reads a setup file and says what applying it would add and replace, or why it is refused
  // (spec 22, 23). Nothing is stored; `setup.apply` reads the text again.
  'setup.preview': {
    params: z.object({ text: z.string() }),
    result: SetupRead,
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
