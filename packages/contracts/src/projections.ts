import { z } from 'zod';
import {
  ApprovalDecision,
  ApprovalKind,
  ProviderKind,
  QuestionOption,
  TaskStatus,
  ThreadState,
} from './provider.js';
import { SecretRef } from './settings.js';
import { StepRun, WorkflowRunState, WorkflowStep } from './workflow.js';

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
  // Provider version and error text from the last "Test", shown with the status badge.
  version: z.string().nullable(),
  statusMessage: z.string().nullable(),
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

// What `payload` holds per item kind, as the server's thread orchestrator writes it.
export const TextItemPayload = z.object({ text: z.string() });
export type TextItemPayload = z.infer<typeof TextItemPayload>;

export const ToolCallItemPayload = z.object({
  name: z.string(),
  input: z.unknown(),
  output: z.string(),
  status: z.enum(['running', 'ok', 'error']),
});
export type ToolCallItemPayload = z.infer<typeof ToolCallItemPayload>;

export const ApprovalItemPayload = z.object({
  approvalId: Id,
  kind: ApprovalKind,
  summary: z.string(),
});
export type ApprovalItemPayload = z.infer<typeof ApprovalItemPayload>;

export const QuestionItemPayload = z.object({
  questionId: Id,
  question: z.string(),
  options: z.array(QuestionOption),
  multiSelect: z.boolean(),
});
export type QuestionItemPayload = z.infer<typeof QuestionItemPayload>;

export const TaskListItemPayload = z.object({
  tasks: z.array(z.object({ id: z.string(), content: z.string(), status: TaskStatus })),
});
export type TaskListItemPayload = z.infer<typeof TaskListItemPayload>;

// Token usage and the context report arrive separately and merge into one item per turn.
export const UsageItemPayload = Usage.partial().extend({
  context: z
    .object({ usedTokens: z.number().int().nonnegative(), maxTokens: z.number().int().positive() })
    .optional(),
});
export type UsageItemPayload = z.infer<typeof UsageItemPayload>;

export const ErrorItemPayload = z.object({ message: z.string() });
export type ErrorItemPayload = z.infer<typeof ErrorItemPayload>;

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

// What a local card shows as its badge. The calendar creates cards `scheduled`; the scheduler
// moves them through the others. Outlook items are `scheduled` or `cancelled`.
export const CardState = z.enum(['scheduled', 'running', 'waiting', 'done', 'failed', 'missed']);
export type CardState = z.infer<typeof CardState>;

export const OutlookItemState = z.enum(['scheduled', 'cancelled']);
export type OutlookItemState = z.infer<typeof OutlookItemState>;

export const CalendarItem = z.object({
  id: Id,
  source: CalendarItemSource,
  externalId: z.string().nullable(),
  title: z.string(),
  start: Timestamp,
  end: Timestamp,
  zone: z.string().min(1),
  // All-day Outlook items span whole days in `zone` and sit above the time grid.
  allDay: z.boolean(),
  location: z.string().nullable(),
  joinUrl: z.string().nullable(),
  body: z.string().nullable(),
  projectId: Id.nullable(),
  backlogItemId: Id.nullable(),
  workflowId: Id.nullable(),
  runId: Id.nullable(),
  // A CardState for local cards, an OutlookItemState for Outlook items.
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
  // The first failed poll since the last good one: "Outlook unavailable since <time>".
  unavailableSince: Timestamp.nullable(),
  // Unread mail in the configured folders, including messages beyond the rail's limit.
  unreadCount: z.number().int().nonnegative(),
  bridgeVersion: z.string().nullable(),
});
export type OutlookStatus = z.infer<typeof OutlookStatus>;

// Spec behavior 28.
export const BacklogState = z.enum(['idea', 'planned', 'running', 'done', 'dropped']);
export type BacklogState = z.infer<typeof BacklogState>;

export const TrackerService = z.enum(['jira', 'github']);
export type TrackerService = z.infer<typeof TrackerService>;

// The issue an item was published as (behavior 30). Nothing is read back from the tracker.
export const BacklogRemote = z.object({
  service: TrackerService,
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
  state: WorkflowRunState,
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
