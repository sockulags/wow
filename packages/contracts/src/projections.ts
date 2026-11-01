import { z } from 'zod';
import { ApprovalDecision, ApprovalKind, ProviderKind, ThreadState } from './provider.js';
import { SecretRef } from './settings.js';
import { StepRun, WorkflowStep } from './workflow.js';

// Row shapes of the projection tables in docs/architecture.md, as clients receive them through
// subscriptions. Absent optional columns arrive as null, because that is what SQLite stores.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  cwd: z.string().min(1),
  defaultProviderInstanceId: Id.nullable(),
  defaultModel: z.string().min(1).nullable(),
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const ProviderInstanceStatus = z.enum(['unknown', 'ready', 'error']);
export type ProviderInstanceStatus = z.infer<typeof ProviderInstanceStatus>;

export const ProviderInstance = z.object({
  id: Id,
  kind: ProviderKind,
  name: z.string().min(1),
  binaryPath: z.string(),
  configDir: z.string(),
  // Secret-marked variables hold a reference into the secret store, never the value.
  env: z.record(z.string(), z.union([z.string(), SecretRef])),
  launchArgs: z.array(z.string()),
  defaultModel: z.string().nullable(),
  defaultEffort: z.string().nullable(),
  defaultPermissionMode: z.string().nullable(),
  status: ProviderInstanceStatus,
  account: z.string().nullable(),
});
export type ProviderInstance = z.infer<typeof ProviderInstance>;

export const Thread = z.object({
  id: Id,
  projectId: Id.nullable(),
  cwd: z.string().min(1),
  branch: z.string().nullable(),
  providerInstanceId: Id,
  providerSessionId: z.string().nullable(),
  title: z.string(),
  model: z.string(),
  effort: z.string(),
  permissionMode: z.string(),
  state: ThreadState,
  pinned: z.boolean(),
  runId: Id.nullable(),
  stepId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Thread = z.infer<typeof Thread>;

export const TurnState = z.enum(['running', 'completed', 'failed', 'interrupted']);
export type TurnState = z.infer<typeof TurnState>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const Turn = z.object({
  id: Id,
  threadId: Id,
  index: z.number().int().nonnegative(),
  state: TurnState,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  usage: Usage.nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const ThreadItemKind = z.enum([
  'user',
  'assistant_text',
  'reasoning',
  'tool_call',
  'approval',
  'question',
  'task_list',
  'usage',
  'error',
]);
export type ThreadItemKind = z.infer<typeof ThreadItemKind>;

export const ThreadItem = z.object({
  id: Id,
  threadId: Id,
  turnId: Id,
  index: z.number().int().nonnegative(),
  kind: ThreadItemKind,
  payload: z.unknown(),
  streaming: z.boolean(),
});
export type ThreadItem = z.infer<typeof ThreadItem>;

export const Approval = z.object({
  id: Id,
  threadId: Id,
  itemId: Id,
  kind: ApprovalKind,
  request: z.unknown(),
  decision: ApprovalDecision.nullable(),
  decidedAt: Timestamp.nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const Question = z.object({
  id: Id,
  threadId: Id,
  itemId: Id,
  request: z.unknown(),
  answer: z.string().nullable(),
  answeredAt: Timestamp.nullable(),
});
export type Question = z.infer<typeof Question>;

export const CalendarItemSource = z.enum(['outlook', 'local']);
export type CalendarItemSource = z.infer<typeof CalendarItemSource>;

export const CalendarItem = z.object({
  id: Id,
  source: CalendarItemSource,
  externalId: z.string().nullable(),
  title: z.string(),
  start: Timestamp,
  end: Timestamp,
  zone: z.string().min(1),
  location: z.string().nullable(),
  joinUrl: z.string().nullable(),
  body: z.string().nullable(),
  projectId: Id.nullable(),
  backlogItemId: Id.nullable(),
  workflowId: Id.nullable(),
  runId: Id.nullable(),
  // Card states are decided by the calendar and scheduler units.
  state: z.string().min(1),
  updatedAt: Timestamp,
});
export type CalendarItem = z.infer<typeof CalendarItem>;

export const MailItem = z.object({
  id: Id,
  externalId: z.string().min(1),
  folder: z.string(),
  from: z.string(),
  subject: z.string(),
  receivedAt: Timestamp,
  unread: z.boolean(),
  snippet: z.string(),
});
export type MailItem = z.infer<typeof MailItem>;

export const OutlookStatus = z.object({
  lastSyncAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  bridgeVersion: z.string().nullable(),
});
export type OutlookStatus = z.infer<typeof OutlookStatus>;

// Spec behavior 28.
export const BacklogState = z.enum(['idea', 'planned', 'running', 'done', 'dropped']);
export type BacklogState = z.infer<typeof BacklogState>;

export const BacklogRemote = z.object({
  service: z.enum(['jira', 'github']),
  key: z.string().min(1),
  url: z.string().min(1),
});
export type BacklogRemote = z.infer<typeof BacklogRemote>;

export const BacklogItem = z.object({
  id: Id,
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  state: BacklogState,
  runId: Id.nullable(),
  remote: BacklogRemote.nullable(),
  createdAt: Timestamp,
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const Workflow = z.object({
  id: Id,
  name: z.string().min(1),
  templateKind: z.string().nullable(),
  steps: z.array(WorkflowStep),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Workflow = z.infer<typeof Workflow>;

export const WorkflowRun = z.object({
  id: Id,
  workflowId: Id,
  projectId: Id,
  calendarItemId: Id.nullable(),
  backlogItemId: Id.nullable(),
  // Run states belong to the workflow engine unit.
  state: z.string().min(1),
  currentStep: z.number().int().nonnegative(),
  steps: z.array(StepRun),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

export const TriggerState = z.enum(['scheduled', 'fired', 'missed', 'cancelled']);
export type TriggerState = z.infer<typeof TriggerState>;

export const Trigger = z.object({
  id: Id,
  calendarItemId: Id,
  workflowId: Id,
  runAt: Timestamp,
  zone: z.string().min(1),
  state: TriggerState,
  runId: Id.nullable(),
});
export type Trigger = z.infer<typeof Trigger>;

export const SkillSource = z.enum([
  'user-claude',
  'user-codex',
  'project-claude',
  'project-agents',
  'custom',
]);
export type SkillSource = z.infer<typeof SkillSource>;

export const Skill = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string(),
  dir: z.string().min(1),
  source: SkillSource,
  manualOnly: z.boolean(),
  invocations: z.object({ claude: z.string(), codex: z.string() }),
});
export type Skill = z.infer<typeof Skill>;

export const SettingRow = z.object({
  key: z.string().min(1),
  scope: z.string().min(1),
  value: z.unknown(),
});
export type SettingRow = z.infer<typeof SettingRow>;

export const EventRecord = z.object({
  seq: z.number().int().positive(),
  at: Timestamp,
  kind: z.string().min(1),
  aggregate: z.string().min(1),
  payload: z.unknown(),
});
export type EventRecord = z.infer<typeof EventRecord>;
