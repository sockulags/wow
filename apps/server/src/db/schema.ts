import type {
  AssistantChangeRecord,
  AssistantChangeState,
  AssistantPlace,
  AssistantProposalLine,
  AssistantProposalState,
  AssistantTarget,
  ApprovalDecision,
  ApprovalKind,
  BacklogRemote,
  BacklogState,
  CalendarItemSource,
  ChangeRequestState,
  CheckState,
  Command,
  FileHash,
  HostCheck,
  HostError,
  HostKind,
  HostReadScope,
  NotificationKind,
  OccurrenceOutcome,
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
  RepeatRule,
  ReviewComment,
  RunEvent,
  RunOccurrence,
  RunUnit,
  SecretRef,
  SetupApplicationState,
  SetupFillIn,
  SetupMark,
  SkillSource,
  PageLink,
  PathVisit,
  StepRun,
  ThreadItemKind,
  ThreadKind,
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
    kind: text().$type<ThreadKind>().notNull().default('chat'),
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
    repeat: json<RepeatRule>(),
    skippedDates: json<string[]>().notNull().default([]),
    nextAt: text(),
  },
  (table) => [index('calendar_items_start_idx').on(table.start)],
);

// What happened at each occurrence of a repeating card the scheduler reached. Rows outlive
// their card, as its runs do, so Undo of a delete brings the history back with the card.
export const cardOccurrences = sqliteTable(
  'card_occurrences',
  {
    cardId: text().notNull(),
    date: text().notNull(),
    start: text().notNull(),
    end: text().notNull(),
    outcome: text().$type<OccurrenceOutcome>().notNull(),
    runId: text(),
    reason: text(),
    offerRunNow: bool().notNull().default(false),
    at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.date] })],
);

// A single row; the id only exists so the row can be upserted.
export const outlookStatus = sqliteTable('outlook_status', {
  id: integer().primaryKey(),
  lastSyncAt: text(),
  lastError: text(),
  unavailableSince: text(),
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
  maxStepVisits: integer(),
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
  occurrence: json<RunOccurrence>(),
  path: json<PathVisit[]>(),
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

// What the assistant changed, with the record Undo needs, in the order it happened.
export const assistantChanges = sqliteTable('assistant_changes', {
  id: text().primaryKey(),
  at: text().notNull(),
  commandType: text().notNull(),
  what: text().notNull(),
  from: text(),
  to: text(),
  place: json<AssistantPlace>().notNull(),
  target: json<AssistantTarget>().notNull(),
  expect: json<Record<string, unknown>>(),
  inverse: json<Command[]>().notNull(),
  state: text().$type<AssistantChangeState>().notNull(),
  undoneAt: text(),
});

// Commands of the assistant that wait for the user's yes.
export const assistantProposals = sqliteTable('assistant_proposals', {
  id: text().primaryKey(),
  at: text().notNull(),
  commandType: text().notNull(),
  title: text().notNull(),
  lines: json<AssistantProposalLine[]>().notNull(),
  place: json<AssistantPlace>().notNull(),
  command: json<Command>().notNull(),
  // What the title and lines were written from; an accept is refused once it no longer holds.
  basis: json<Record<string, unknown>>(),
  state: text().$type<AssistantProposalState>().notNull(),
  answeredAt: text(),
  reason: text(),
});

// Setup files applied here (app assistant spec 22), with what Undo puts back, in the order
// applied.
export const setupApplications = sqliteTable('setup_applications', {
  id: text().primaryKey(),
  at: text().notNull(),
  name: text().notNull(),
  added: json<AssistantProposalLine[]>().notNull(),
  replaced: json<AssistantProposalLine[]>().notNull(),
  marked: json<SetupMark[]>().notNull(),
  toFillIn: json<SetupFillIn[]>().notNull(),
  parts: json<AssistantChangeRecord[]>().notNull(),
  state: text().$type<SetupApplicationState>().notNull(),
  undoneAt: text(),
});

// One row while the greeting after the first-start step is owed (app assistant spec 26).
export const assistantGreeting = sqliteTable('assistant_greeting', {
  id: integer().primaryKey(),
  owedAt: text().notNull(),
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

// What was last read about the pages one run's texts link to (`run:<id>`), with the pages.
export const pageReads = sqliteTable('page_reads', {
  id: text().primaryKey(),
  projectId: text().notNull(),
  runId: text().notNull(),
  host: text().$type<HostKind>().notNull(),
  hostName: text().notNull(),
  pages: json<PageLink[]>().notNull(),
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
  fromFork: bool().notNull().default(false),
  units: json<UnitRef[]>().notNull(),
  checkState: text().$type<CheckState>().notNull(),
  checks: json<HostCheck[]>().notNull(),
  comments: json<ReviewComment[]>().notNull(),
  newestCommentId: text(),
  links: json<string[]>().notNull().default([]),
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
