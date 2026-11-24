import type {
  AssistantChangeRecord,
  ChangeCount,
  ReportedLimit,
  AssistantChangeState,
  AssistantPermissionKind,
  AssistantPlace,
  AssistantProposalLine,
  AssistantProposalState,
  BriefingLine,
  BriefingMoment,
  AssistantTarget,
  ApprovalDecision,
  ApprovalKind,
  BackgroundTask,
  QueuedMessage,
  BacklogRemote,
  BacklogState,
  CalendarItemSource,
  CardThreadMode,
  ChangeRequestState,
  CheckState,
  Command,
  FileHash,
  ForkOrigin,
  GoBack,
  ResumePointRef,
  HostCheck,
  HostError,
  HostItemData,
  HostItemRef,
  HostKind,
  NotificationKind,
  OccurrenceOutcome,
  OutlookProfile,
  PastSeries,
  ProviderInstanceStatus,
  ProviderKind,
  ProviderUpdate,
  ProviderUpdateRun,
  RepeatRule,
  ReviewComment,
  SecretRef,
  SessionTools,
  SetupApplicationState,
  SetupFillIn,
  SetupMark,
  SkillSource,
  StoredSnapshot,
  ThreadItemKind,
  ThreadKind,
  ThreadState,
  ThreadToolsSource,
  Ticket,
  TriggerState,
  TurnSnapshot,
  TurnState,
  UnitRef,
  Usage,
  WorkflowStep,
  WorkingCopy,
} from '@wow/contracts';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
  defaultEffort: text(),
  defaultPermissionMode: text(),
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
    backgroundTasks: json<BackgroundTask[]>().notNull().default([]),
    archived: bool().notNull().default(false),
    seen: bool().notNull().default(true),
    // The newest item's index when the user last saw it (chat overview spec 17).
    seenThrough: integer(),
    queued: json<QueuedMessage>(),
    // Where a chat thread's Changes are measured from (agent workbench spec 34): the commit its
    // folder was on at the first turn, and what already differed then. Null for a thread stored
    // before, or outside git.
    baseSha: text(),
    baseFiles: json<FileHash[]>(),
    // When the thread came to its current state; null for a thread stored before it was kept.
    stateSince: text(),
    // The next turn goes back in the provider's conversation (Edit, Fork); null otherwise. A
    // fork's origin, null for a thread that is not one.
    goBack: json<GoBack>(),
    forkedFrom: json<ForkOrigin>(),
    // A chat thread's own working copy (thread work spec 11); null for a thread in its folder.
    workingCopy: json<WorkingCopy>(),
    // The assistant started it (chief of staff spec 10), and the turns it had to follow it.
    startedBy: text().$type<'assistant' | 'helper'>(),
    // A helper thread's main thread (agent orchestration spec 4).
    parentThreadId: text(),
    followTurns: integer().notNull().default(0),
    // What the thread changed as of its last turn's end (chat overview spec 4); null when not
    // measured.
    changeCount: json<ChangeCount>(),
    // How far its latest task list is (chat overview spec 6).
    tasks: json<{ done: number; total: number }>(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (table) => [index('threads_project_idx').on(table.projectId)],
);

// The plan limits each provider instance last reported, one per window (chat overview spec 26).
export const providerLimits = sqliteTable('provider_limits', {
  providerInstanceId: text().primaryKey(),
  limits: json<ReportedLimit[]>().notNull(),
});

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
    // The changed files' hashes as the turn began, for "This turn only".
    fileMark: json<FileHash[]>(),
    // The provider's point to go back to after this turn (Edit, Fork), and the turn Edit put in
    // its place.
    resumePoint: json<ResumePointRef>(),
    replacedBy: text(),
    // wow's snapshots of the thread's folder as the turn started and ended (thread work spec
    // 19), or why there is none; null in turns stored before and in step threads.
    startSnapshot: json<StoredSnapshot>(),
    endSnapshot: json<StoredSnapshot>(),
  },
  (table) => [index('turns_thread_idx').on(table.threadId, table.index)],
);

// The folder just before and just after a restore (thread work spec 24), by its line's item id:
// Undo puts `before` back, and `after` is what the next check for changes made outside the
// thread compares with.
export const restorePoints = sqliteTable(
  'restore_points',
  {
    itemId: text().primaryKey(),
    threadId: text().notNull(),
    before: json<TurnSnapshot>(),
    after: json<TurnSnapshot>(),
    at: text().notNull(),
  },
  (table) => [index('restore_points_thread_idx').on(table.threadId)],
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
    answeredBecause: text(),
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
    workflowName: text(),
    threadMode: text().$type<CardThreadMode>().notNull().default('new'),
    threadId: text(),
    state: text().notNull(),
    updatedAt: text().notNull(),
    focus: bool().notNull().default(false),
    repeat: json<RepeatRule>(),
    skippedDates: json<string[]>().notNull().default([]),
    nextAt: text(),
    pastSeries: json<PastSeries[]>().notNull().default([]),
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
    threadId: text(),
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

// One trigger per local card with a workflow.
export const triggers = sqliteTable(
  'triggers',
  {
    id: text().primaryKey(),
    calendarItemId: text().notNull(),
    workflowId: text().notNull(),
    runAt: text().notNull(),
    zone: text().notNull(),
    state: text().$type<TriggerState>().notNull(),
    offerRunNow: bool().notNull().default(false),
  },
  (table) => [
    index('triggers_due_idx').on(table.state, table.runAt),
    index('triggers_card_idx').on(table.calendarItemId),
  ],
);

export const notifications = sqliteTable('notifications', {
  id: text().primaryKey(),
  at: text().notNull(),
  kind: text().$type<NotificationKind>().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  path: text().notNull(),
  calendarItemId: text(),
  threadId: text(),
  approvalId: text(),
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

// What the assistant did under a standing permission (chief of staff spec 5), in the order it
// happened; the daily limit counts these.
export const assistantPermissionUses = sqliteTable(
  'assistant_permission_uses',
  {
    id: text().primaryKey(),
    at: text().notNull(),
    permissionId: text().notNull(),
    kind: text().$type<AssistantPermissionKind>().notNull(),
    commandType: text().notNull(),
    what: text().notNull(),
    place: json<AssistantPlace>().notNull(),
  },
  (table) => [index('assistant_permission_uses_at_idx').on(table.permissionId, table.at)],
);

// The assistant's brief of a decision (chief of staff spec 18): asked once, written once.
export const decisionBriefs = sqliteTable('decision_briefs', {
  decisionId: text().primaryKey(),
  requestedAt: text().notNull(),
  text: text(),
  recommendation: text(),
  writtenAt: text(),
});

// The assistant's briefings (chief of staff spec 20 to 23), newest last.
export const briefings = sqliteTable('briefings', {
  id: text().primaryKey(),
  at: text().notNull(),
  moment: text().$type<BriefingMoment>().notNull(),
  since: text().notNull(),
  lines: json<BriefingLine[]>().notNull(),
  summary: text(),
  summaryPending: bool().notNull().default(false),
  notified: bool().notNull().default(false),
});

// Decisions that got their one reminder (spec 26).
export const decisionReminders = sqliteTable('decision_reminders', {
  decisionId: text().primaryKey(),
  at: text().notNull(),
});

// Failed runs and missed cards the user is done with: they leave the decision queue.
export const decisionDismissals = sqliteTable('decision_dismissals', {
  decisionId: text().primaryKey(),
  at: text().notNull(),
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
  // A wow skill's text (built-in template or own text); null for skills from other folders.
  text: text(),
  // An own skill's SKILL.md as it is on disk; null for other skills.
  file: text(),
});

// What was last read about one item a chat thread links to (agent workbench spec 22), read only
// when its tab opens and on Refresh now.
export const hostItemReads = sqliteTable(
  'host_item_reads',
  {
    id: text().primaryKey(),
    scope: text().$type<'thread'>().notNull(),
    threadId: text().notNull(),
    item: json<HostItemRef>().notNull(),
    hostName: text().notNull(),
    data: json<HostItemData>(),
    fetchedAt: text(),
    error: json<HostError>(),
  },
  (table) => [index('host_item_reads_thread_idx').on(table.threadId)],
);

// What a chat thread's session last reported it can use (thread work spec 38), one row per thread
// once it has reported. `live` says the session that reported it is still open in its adapter.
export const threadTools = sqliteTable('thread_tools', {
  threadId: text().primaryKey(),
  tools: json<SessionTools>().notNull(),
  source: text().$type<ThreadToolsSource>().notNull(),
  live: bool().notNull(),
  reportedAt: text().notNull(),
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

// The thread's own agent's text, not a subagent's (agent workbench spec 44): what a turn ended
// with is what the agent said, not what one of its subagents told it.
export const ownText = sql`json_extract(${threadItems.payload}, '$.parentItemId') is null`;
