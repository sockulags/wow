import type {
  ApprovalDecision,
  ApprovalKind,
  BacklogRemote,
  BacklogState,
  CalendarItemSource,
  ChangeRequestState,
  CheckState,
  FileHash,
  HostCheck,
  HostError,
  HostKind,
  HostReadScope,
  NotificationKind,
  OutlookProfile,
  PlanFile,
  PlanProblem,
  PlanRunState,
  PlanRunUnit,
  PlanSource,
  PlanUnit,
  ProviderInstanceStatus,
  ProviderKind,
  ProviderUpdate,
  ProviderUpdateRun,
  ReviewComment,
  RunEvent,
  RunUnit,
  SecretRef,
  SkillSource,
  StepRun,
  ThreadItemKind,
  ThreadState,
  Ticket,
  TicketSource,
  TriggerEvent,
  TriggerKind,
  TriggerState,
  TurnState,
  UnitRef,
  Usage,
  WorkflowRunState,
  WorkflowStep,
  WorkingCopy,
} from '@wow/contracts';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Projection tables from docs/architecture.md. Column names are snake_case in SQLite (the
// `casing` option) and camelCase here. Times are ISO strings.

const json = <T>() => text({ mode: 'json' }).$type<T>();
const bool = () => integer({ mode: 'boolean' });

export const projects = sqliteTable('projects', {
  id: text().primaryKey(),
  name: text().notNull(),
  cwd: text().notNull(),
  defaultProviderInstanceId: text(),
  defaultModel: text(),
  createdAt: text().notNull(),
});

export const providerInstances = sqliteTable('provider_instances', {
  id: text().primaryKey(),
  kind: text().$type<ProviderKind>().notNull(),
  name: text().notNull(),
  binaryPath: text().notNull(),
  configDir: text().notNull(),
  env: json<Record<string, string | SecretRef>>().notNull(),
  launchArgs: json<string[]>().notNull(),
  defaultModel: text(),
  defaultEffort: text(),
  defaultPermissionMode: text(),
  status: text().$type<ProviderInstanceStatus>().notNull(),
  account: text(),
  version: text(),
  statusMessage: text(),
  update: json<ProviderUpdate>(),
  updateRun: json<ProviderUpdateRun>(),
});

export const threads = sqliteTable(
  'threads',
  {
    id: text().primaryKey(),
    projectId: text(),
    cwd: text().notNull(),
    branch: text(),
    providerInstanceId: text().notNull(),
    providerSessionId: text(),
    title: text().notNull(),
    model: text().notNull(),
    effort: text().notNull(),
    permissionMode: text().notNull(),
    state: text().$type<ThreadState>().notNull(),
    pinned: bool().notNull(),
    runId: text(),
    stepId: text(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [index('threads_project_idx').on(table.projectId)],
);

export const turns = sqliteTable(
  'turns',
  {
    id: text().primaryKey(),
    threadId: text().notNull(),
    index: integer().notNull(),
    state: text().$type<TurnState>().notNull(),
    startedAt: text().notNull(),
    endedAt: text(),
    usage: json<Usage>(),
  },
  (table) => [index('turns_thread_idx').on(table.threadId, table.index)],
);

export const threadItems = sqliteTable(
  'thread_items',
  {
    id: text().primaryKey(),
    threadId: text().notNull(),
    turnId: text().notNull(),
    index: integer().notNull(),
    kind: text().$type<ThreadItemKind>().notNull(),
    payload: json<unknown>().notNull(),
    streaming: bool().notNull(),
  },
  (table) => [index('thread_items_thread_idx').on(table.threadId, table.index)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text().primaryKey(),
    threadId: text().notNull(),
    itemId: text().notNull(),
    kind: text().$type<ApprovalKind>().notNull(),
    request: json<unknown>().notNull(),
    decision: text().$type<ApprovalDecision>(),
    decidedAt: text(),
  },
  (table) => [index('approvals_thread_idx').on(table.threadId)],
);

export const questions = sqliteTable(
  'questions',
  {
    id: text().primaryKey(),
    threadId: text().notNull(),
    itemId: text().notNull(),
    request: json<unknown>().notNull(),
    answer: text(),
    answeredAt: text(),
  },
  (table) => [index('questions_thread_idx').on(table.threadId)],
);

export const calendarItems = sqliteTable(
  'calendar_items',
  {
    id: text().primaryKey(),
    source: text().$type<CalendarItemSource>().notNull(),
    externalId: text(),
    title: text().notNull(),
    start: text().notNull(),
    end: text().notNull(),
    zone: text().notNull(),
    allDay: bool().notNull().default(false),
    location: text(),
    joinUrl: text(),
    body: text(),
    organizer: text(),
    projectId: text(),
    backlogItemId: text(),
    workflowId: text(),
    runId: text(),
    state: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [index('calendar_items_start_idx').on(table.start)],
);

export const mailItems = sqliteTable('mail_items', {
  id: text().primaryKey(),
  externalId: text().notNull(),
  folder: text().notNull(),
  from: text().notNull(),
  subject: text().notNull(),
  receivedAt: text().notNull(),
  unread: bool().notNull(),
  snippet: text().notNull(),
});

// A single row; the id only exists so the row can be upserted.
export const outlookStatus = sqliteTable('outlook_status', {
  id: integer().primaryKey(),
  lastSyncAt: text(),
  lastError: text(),
  unavailableSince: text(),
  unreadCount: integer().notNull().default(0),
  bridgeVersion: text(),
  profile: json<OutlookProfile>(),
});

export const backlogItems = sqliteTable('backlog_items', {
  id: text().primaryKey(),
  title: text().notNull(),
  body: text().notNull(),
  tags: json<string[]>().notNull(),
  state: text().$type<BacklogState>().notNull(),
  runId: text(),
  remote: json<BacklogRemote>(),
  createdAt: text().notNull(),
});

export const workflows = sqliteTable('workflows', {
  id: text().primaryKey(),
  name: text().notNull(),
  templateKind: text(),
  steps: json<WorkflowStep[]>().notNull(),
  ownWorkingCopy: bool().notNull().default(false),
  forUnits: bool().notNull().default(false),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text().primaryKey(),
  workflowId: text().notNull(),
  projectId: text().notNull(),
  calendarItemId: text(),
  backlogItemId: text(),
  state: text().$type<WorkflowRunState>().notNull(),
  currentStep: integer().notNull(),
  steps: json<StepRun[]>().notNull(),
  startedAt: text().notNull(),
  endedAt: text(),
  baseSha: text(),
  baseFiles: json<FileHash[]>(),
  workingCopy: json<WorkingCopy>(),
  unit: json<RunUnit>(),
  event: json<RunEvent>(),
});

// Plan runs: one row per "Run ready units", kept after it ended.
export const planRuns = sqliteTable(
  'plan_runs',
  {
    id: text().primaryKey(),
    planId: text().notNull(),
    projectId: text().notNull(),
    intentId: text().notNull(),
    workflowId: text().notNull(),
    state: text().$type<PlanRunState>().notNull(),
    units: json<PlanRunUnit[]>().notNull(),
    waitingFor: json<string[]>().notNull(),
    message: text(),
    startedAt: text().notNull(),
    endedAt: text(),
  },
  (table) => [index('plan_runs_plan_idx').on(table.planId)],
);

// Card triggers and event triggers in one table. The columns of the other kind are null.
export const triggers = sqliteTable(
  'triggers',
  {
    id: text().primaryKey(),
    kind: text().$type<TriggerKind>().notNull().default('card'),
    calendarItemId: text(),
    workflowId: text().notNull(),
    runAt: text(),
    zone: text(),
    state: text().$type<TriggerState>(),
    runId: text(),
    offerRunNow: bool().notNull().default(false),
    projectId: text(),
    event: text().$type<TriggerEvent>(),
    enabled: bool(),
    createdAt: text(),
  },
  (table) => [
    index('triggers_due_idx').on(table.state, table.runAt),
    index('triggers_card_idx').on(table.calendarItemId),
    index('triggers_project_idx').on(table.projectId),
  ],
);

// The events an event trigger has seen, by the id the host gives them, so a repeated poll
// starts nothing (review loop spec 49).
export const triggerEvents = sqliteTable(
  'trigger_events',
  {
    triggerId: text().notNull(),
    eventId: text().notNull(),
    runId: text(),
    at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.eventId] })],
);

export const notifications = sqliteTable('notifications', {
  id: text().primaryKey(),
  at: text().notNull(),
  kind: text().$type<NotificationKind>().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  path: text().notNull(),
  runId: text(),
  calendarItemId: text(),
});

export const skills = sqliteTable('skills', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  dir: text().notNull(),
  source: text().$type<SkillSource>().notNull(),
  manualOnly: bool().notNull(),
  invocations: json<{ claude: string; codex: string }>().notNull(),
});

// One row per intent folder of a project, as its files read (packages/agent-os).
export const planIntents = sqliteTable('plan_intents', {
  id: text().primaryKey(),
  projectId: text().notNull(),
  intentId: text().notNull(),
  title: text().notNull(),
  hasIntent: bool().notNull(),
  status: text(),
  rev: integer(),
  spec: json<PlanFile>(),
  plan: json<PlanFile>(),
  source: text().$type<PlanSource>(),
  units: json<PlanUnit[]>().notNull(),
  problems: json<PlanProblem[]>().notNull(),
  followed: bool().notNull().default(false),
});

// What was last read from a host for one followed plan (`plan:<id>`) or one run (`run:<id>`).
export const hostReads = sqliteTable('host_reads', {
  id: text().primaryKey(),
  projectId: text().notNull(),
  scope: text().$type<HostReadScope>().notNull(),
  host: text().$type<HostKind>().notNull(),
  hostName: text().notNull(),
  branch: text(),
  changeRequestIds: json<string[]>().notNull(),
  fetchedAt: text(),
  error: json<HostError>(),
});

// What was last read about one run's ticket (`run:<id>`), with the ticket itself.
export const ticketReads = sqliteTable('ticket_reads', {
  id: text().primaryKey(),
  projectId: text().notNull(),
  runId: text().notNull(),
  host: text().$type<HostKind>().notNull(),
  hostName: text().notNull(),
  key: text(),
  source: text().$type<TicketSource>(),
  ticket: json<Ticket>(),
  fetchedAt: text(),
  error: json<HostError>(),
});

// Pull requests as last read, one row per project and number.
export const changeRequests = sqliteTable('change_requests', {
  id: text().primaryKey(),
  projectId: text().notNull(),
  host: text().$type<HostKind>().notNull(),
  number: integer().notNull(),
  title: text().notNull(),
  url: text().notNull(),
  state: text().$type<ChangeRequestState>().notNull(),
  draft: bool().notNull(),
  mergedAt: text(),
  headBranch: text().notNull(),
  headSha: text().notNull(),
  units: json<UnitRef[]>().notNull(),
  checkState: text().$type<CheckState>().notNull(),
  checks: json<HostCheck[]>().notNull(),
  comments: json<ReviewComment[]>().notNull(),
  newestCommentId: text(),
});

export const settings = sqliteTable(
  'settings',
  {
    key: text().notNull(),
    scope: text().notNull(),
    value: json<unknown>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.scope] })],
);

// The history. Projections can be rebuilt from it.
export const events = sqliteTable('events', {
  seq: integer().primaryKey({ autoIncrement: true }),
  at: text().notNull(),
  kind: text().notNull(),
  aggregate: text().notNull(),
  payload: json<unknown>().notNull(),
});

// One row per applied command, so a retried command id returns the first outcome instead of
// appending its events again.
export const commandReceipts = sqliteTable('command_receipts', {
  commandId: text().primaryKey(),
  commandType: text().notNull(),
  // Canonical JSON of the command, to tell a retry from a different command reusing the id.
  fingerprint: text().notNull(),
  seqs: json<number[]>().notNull(),
  at: text().notNull(),
});
