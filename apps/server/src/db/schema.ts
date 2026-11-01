import type {
  ApprovalDecision,
  ApprovalKind,
  BacklogRemote,
  BacklogState,
  CalendarItemSource,
  ProviderInstanceStatus,
  ProviderKind,
  SecretRef,
  SkillSource,
  StepRun,
  ThreadItemKind,
  ThreadState,
  TriggerState,
  TurnState,
  Usage,
  WorkflowStep,
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
    location: text(),
    joinUrl: text(),
    body: text(),
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
  bridgeVersion: text(),
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
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text().primaryKey(),
  workflowId: text().notNull(),
  projectId: text().notNull(),
  calendarItemId: text(),
  backlogItemId: text(),
  state: text().notNull(),
  currentStep: integer().notNull(),
  steps: json<StepRun[]>().notNull(),
  startedAt: text().notNull(),
  endedAt: text(),
});

export const triggers = sqliteTable(
  'triggers',
  {
    id: text().primaryKey(),
    calendarItemId: text().notNull(),
    workflowId: text().notNull(),
    runAt: text().notNull(),
    zone: text().notNull(),
    state: text().$type<TriggerState>().notNull(),
    runId: text(),
  },
  (table) => [index('triggers_due_idx').on(table.state, table.runAt)],
);

export const skills = sqliteTable('skills', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  dir: text().notNull(),
  source: text().$type<SkillSource>().notNull(),
  manualOnly: bool().notNull(),
  invocations: json<{ claude: string; codex: string }>().notNull(),
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
