import { z } from 'zod';
import type { HostKind } from './hosts.js';
import {
  ApprovalDecision,
  ApprovalKind,
  ProviderKind,
  ProviderUpdate,
  ProviderUpdateRun,
  QuestionOption,
  TaskStatus,
  ThreadState,
} from './provider.js';
import { CardOccurrence, LocalDay, RepeatRule } from './repeat.js';
import { SecretRef, Weekday, WorkHours } from './settings.js';
import {
  FileHash,
  PathVisit,
  StepRun,
  WorkflowRunState,
  WorkflowStep,
  WorkingCopy,
} from './workflow.js';

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
  // How to bring the CLI to the tested version, from the last "Test", and the last update wow ran.
  update: ProviderUpdate.nullable(),
  updateRun: ProviderUpdateRun.nullable(),
});
export type ProviderInstance = z.infer<typeof ProviderInstance>;

// The assistant thread is the one conversation that operates wow itself (app assistant spec 1).
// Absent means an ordinary chat thread, as every thread stored before the assistant is.
export const ThreadKind = z.enum(['chat', 'assistant']);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const Thread = z.object({
  id: Id,
  kind: ThreadKind.optional(),
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
// and the card's workflow run move them through the others (`waiting` is "needs you", `stopped`
// is a run the user stopped). Outlook items are `scheduled` or `cancelled`.
export const CardState = z.enum([
  'scheduled',
  'running',
  'waiting',
  'done',
  'failed',
  'stopped',
  'missed',
]);
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
  // A card's notes; for an Outlook item the start of its body as plain text.
  body: z.string().nullable(),
  // Who organizes an Outlook meeting, as Outlook names them; null for cards. Defaults to null so
  // events stored before it existed still replay.
  organizer: z.string().nullable().default(null),
  projectId: Id.nullable(),
  backlogItemId: Id.nullable(),
  workflowId: Id.nullable(),
  runId: Id.nullable(),
  // A CardState for local cards, an OutlookItemState for Outlook items.
  state: z.string().min(1),
  updatedAt: Timestamp,
  // A repeating card's rule (recurring cards spec 1). Absent or null for a card that happens
  // once, and for every card stored before rules existed.
  repeat: RepeatRule.nullable().optional(),
  // The days skipped by hand ("This occurrence"), in the card's zone.
  skippedDates: z.array(LocalDay).optional(),
  // When the card's trigger fires next; null when nothing is scheduled.
  nextAt: Timestamp.nullable().optional(),
  // What happened at each occurrence the scheduler reached, oldest first. Topic rows carry it;
  // the stored row does not.
  occurrences: z.array(CardOccurrence).optional(),
});
export type CalendarItem = z.infer<typeof CalendarItem>;

// Calendar preferences read from Outlook (F-8). Each part is null when Outlook does not say. The
// calendar settings default to these and fall back to the system's when they are null.
export const OutlookProfile = z.object({
  // IANA zone of Outlook's calendar.
  zone: z.string().min(1).nullable(),
  workHours: WorkHours.nullable(),
  firstDayOfWeek: Weekday.nullable(),
  // The signed-in user's SMTP address, so meetings they organize can say "You".
  address: z.string().min(1).nullable(),
});
export type OutlookProfile = z.infer<typeof OutlookProfile>;

export const OutlookStatus = z.object({
  lastSyncAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  // The first failed poll since the last good one: "Outlook unavailable since <time>".
  unavailableSince: Timestamp.nullable(),
  bridgeVersion: z.string().nullable(),
  // The last profile Outlook returned; kept while Outlook is unavailable.
  profile: OutlookProfile.nullable(),
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
  // "Own working copy": each run works in a Git worktree of its own instead of the project
  // folder (review loop spec 36, 39). Absent means off.
  ownWorkingCopy: z.boolean().optional(),
  // "For units": a plan run may run this workflow once per unit of a plan (review loop spec 40).
  // Absent means off.
  forUnits: z.boolean().optional(),
  // How often one step may start in a run before the run waits for the user (workflow branches
  // spec 9). Absent or null: the `workflows.maxStepVisits` setting.
  maxStepVisits: z.number().int().min(1).max(50).nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Workflow = z.infer<typeof Workflow>;

// The unit a run delivers, for a run that a plan run started (review loop spec 40). Every step's
// prompt names it, and the plan run is told when the run ends.
export const RunUnit = z.object({
  planRunId: Id,
  // `<projectId>:<intentId>`, the plan's row.
  planId: Id,
  intentId: z.string().min(1),
  unitKey: z.string().min(1),
  title: z.string(),
});
export type RunUnit = z.infer<typeof RunUnit>;

// A card trigger fires at the card's start; an event trigger fires when polling first sees
// something happen on a pull request wow follows (review loop spec 48).
export const TriggerKind = z.enum(['card', 'event']);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const TriggerEvent = z.enum(['merged', 'checksFailed', 'commentAdded']);
export type TriggerEvent = z.infer<typeof TriggerEvent>;

export const triggerEventLabels: Readonly<Record<TriggerEvent, string>> = {
  merged: 'Pull request merged',
  checksFailed: 'Checks failed',
  commentAdded: 'Review comment added',
};

// What started a run that an event trigger started (review loop spec 48, 51). Every step's
// handover names the pull request and the event. A review comment is carried as its link and
// author only: text someone else wrote never becomes part of a prompt wow writes.
export const RunEvent = z.object({
  triggerId: Id,
  event: TriggerEvent,
  changeRequestId: Id,
  number: z.number().int().positive(),
  url: z.string().min(1),
  branch: z.string(),
  // The pull request's head commit when the event was seen, and the ref of the base repository
  // it is fetched from (`refs/pull/<n>/head`, `refs/merge-requests/<n>/head`). The run's working
  // copy starts there, never at a branch name that a fork may share. Absent on runs from before.
  headSha: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  // The pull request comes from a fork. Absent on runs from before wow asked.
  fromFork: z.boolean().optional(),
  commentUrl: z.string().min(1).nullable(),
  commentAuthor: z.string().nullable(),
});
export type RunEvent = z.infer<typeof RunEvent>;

// The host a run's event came from, by the ref its head is fetched from: GitLab's merge
// requests are `refs/merge-requests/<n>/head`. GitHub for runs from before refs were kept.
export const runEventHost = (event: Pick<RunEvent, 'headRef'>): HostKind =>
  event.headRef?.startsWith('refs/merge-requests/') ? 'gitlab' : 'github';

// An event's label in the host's own words: a GitLab merge request is merged, not a pull request.
export const triggerEventLabel = (event: TriggerEvent, host: HostKind): string =>
  event === 'merged' && host === 'gitlab' ? 'Merge request merged' : triggerEventLabels[event];

export const RunOccurrence = z.object({ date: LocalDay, start: Timestamp });
export type RunOccurrence = z.infer<typeof RunOccurrence>;

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
  // The commit the working folder was on when the run's first step began (review loop spec 10).
  // Null for a run from before bases were recorded, and for a folder that was not a repository.
  baseSha: z.string().min(1).nullable().optional(),
  // The files that already differed from the base at that moment, so the first step is not
  // credited with changes that were there before it.
  baseFiles: z.array(FileHash).nullable().optional(),
  // The run's own working copy; absent or null for a run that works in the project folder.
  workingCopy: WorkingCopy.nullable().optional(),
  // Absent or null for a run nobody started for a unit.
  unit: RunUnit.nullable().optional(),
  // Absent or null for a run no event trigger started.
  event: RunEvent.nullable().optional(),
  // The occurrence of a repeating card the run was started for, which names the run by its
  // day (recurring cards spec 5). Absent or null otherwise.
  occurrence: RunOccurrence.nullable().optional(),
  // Every step visit in the order it happened, with why the run went where it went next
  // (workflow branches spec 18). Absent or null for a run from before paths were kept.
  path: z.array(PathVisit).nullable().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

// The folder a run works in: its own working copy when it has one, else the project folder.
export const runFolder = (run: Pick<WorkflowRun, 'workingCopy'>, projectFolder: string): string =>
  run.workingCopy?.path ?? projectFolder;

export const TriggerState = z.enum(['scheduled', 'fired', 'missed', 'cancelled']);
export type TriggerState = z.infer<typeof TriggerState>;

// One table for both kinds. The fields of the other kind are null, because that is what SQLite
// stores; `isCardTrigger` and `isEventTrigger` narrow a row to the fields its kind has.
export const Trigger = z.object({
  id: Id,
  kind: TriggerKind,
  workflowId: Id,
  // Card: the run the trigger started. Event: the last run it started.
  runId: Id.nullable(),
  // Card triggers only.
  calendarItemId: Id.nullable(),
  runAt: Timestamp.nullable(),
  zone: z.string().min(1).nullable(),
  state: TriggerState.nullable(),
  // A missed trigger the card offers a one-click "Run now" for (missed policy `mark`).
  offerRunNow: z.boolean(),
  // Event triggers only: the project whose pull requests it listens to, what it listens for,
  // and whether it is on.
  projectId: Id.nullable(),
  event: TriggerEvent.nullable(),
  enabled: z.boolean().nullable(),
  createdAt: Timestamp.nullable(),
});
export type Trigger = z.infer<typeof Trigger>;

export type CardTrigger = Trigger & {
  kind: 'card';
  calendarItemId: string;
  runAt: string;
  zone: string;
  state: TriggerState;
};

export type EventTrigger = Trigger & {
  kind: 'event';
  projectId: string;
  event: TriggerEvent;
  enabled: boolean;
  createdAt: string;
};

export const isCardTrigger = (trigger: Trigger): trigger is CardTrigger =>
  trigger.kind === 'card' &&
  trigger.calendarItemId !== null &&
  trigger.runAt !== null &&
  trigger.zone !== null &&
  trigger.state !== null;

export const isEventTrigger = (trigger: Trigger): trigger is EventTrigger =>
  trigger.kind === 'event' &&
  trigger.projectId !== null &&
  trigger.event !== null &&
  trigger.enabled !== null &&
  trigger.createdAt !== null;

// What the server tells the user about without being asked: a run started by a trigger, a run
// waiting at a gate, a failed run or trigger. The desktop app shows them as system notifications,
// the web app as toasts. Only stored while `scheduler.notifications` is on.
export const NotificationKind = z.enum(['started', 'waiting', 'failed']);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const AppNotification = z.object({
  id: Id,
  at: Timestamp,
  kind: NotificationKind,
  title: z.string().min(1),
  body: z.string(),
  // Where the app goes when the notification is clicked.
  path: z.string().min(1),
  runId: Id.nullable(),
  calendarItemId: Id.nullable(),
});
export type AppNotification = z.infer<typeof AppNotification>;

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

// Plans: what the files of one intent folder say (intents/<id>/{intent,spec,plan}.md), read by
// the server's plans service. Only a unit's status and the change request it links to can come
// from a host, and only for a followed plan.
export const PlanFileKind = z.enum(['intent', 'spec', 'plan']);
export type PlanFileKind = z.infer<typeof PlanFileKind>;

export const PlanProblem = z.object({
  file: PlanFileKind,
  line: z.number().int().positive(),
  message: z.string().min(1),
});
export type PlanProblem = z.infer<typeof PlanProblem>;

// A spec or plan file. `stale` is set when it was built on an older revision than its source
// file (the intent for a spec, the spec for a plan) is at now.
export const PlanFile = z.object({
  rev: z.number().int().positive().nullable(),
  status: z.string().nullable(),
  stale: z
    .object({ builtOn: z.number().int().positive(), current: z.number().int().positive() })
    .nullable(),
});
export type PlanFile = z.infer<typeof PlanFile>;

export const PlanSource = z.enum(['files', 'issues']);
export type PlanSource = z.infer<typeof PlanSource>;

// A unit's status (review loop spec 23 and 24). From the pull requests of a followed plan:
// delivered, claimed, blocked, ready or waiting. From the files alone: blocked or unknown.
export const PlanUnitStatus = z.enum([
  'delivered',
  'claimed',
  'blocked',
  'ready',
  'waiting',
  'unknown',
]);
export type PlanUnitStatus = z.infer<typeof PlanUnitStatus>;

export const PlanUnit = z.object({
  key: z.string().min(1),
  title: z.string(),
  line: z.number().int().positive(),
  dependsOn: z.array(z.string().min(1)),
  blocked: z.string().nullable(),
  // Every agent-os contract field with what the unit's `### KEY` section says for it, null for a
  // field the section does not have. The whole list is null for `source: issues` and for a unit
  // without a section.
  contract: z.array(z.object({ name: z.string().min(1), value: z.string().nullable() })).nullable(),
  status: PlanUnitStatus,
  // Why the status is what it is, in words the view shows as they are.
  statusReason: z.string(),
  // The change request that delivered or claims the unit (a `changeRequests` row), if any.
  changeRequestId: Id.nullable().default(null),
});
export type PlanUnit = z.infer<typeof PlanUnit>;

export const PlanIntent = z.object({
  // `<projectId>:<intentId>`.
  id: Id,
  projectId: Id,
  intentId: z.string().min(1),
  title: z.string().min(1),
  hasIntent: z.boolean(),
  status: z.string().nullable(),
  rev: z.number().int().positive().nullable(),
  spec: PlanFile.nullable(),
  plan: PlanFile.nullable(),
  source: PlanSource.nullable(),
  units: z.array(PlanUnit),
  problems: z.array(PlanProblem),
  // The user follows this plan: wow asks the host about its pull requests (spec 27 and 29).
  followed: z.boolean().default(false),
});
export type PlanIntent = z.infer<typeof PlanIntent>;

// A plan run works through a plan's ready units, one ordinary run per unit and one at a time
// (review loop spec 40 to 47). `running` while a unit's run is live, `waiting` while units remain
// and none is ready, `done` when every unit is delivered, `failed` when a unit's run failed or
// was stopped and `workflows.planRunOnFailure` is `stop`, `stopped` by the user.
export const PlanRunState = z.enum(['running', 'waiting', 'done', 'failed', 'stopped']);
export type PlanRunState = z.infer<typeof PlanRunState>;

export const isLivePlanRunState = (state: PlanRunState): boolean =>
  state === 'running' || state === 'waiting';

// One unit the plan run started a run for, in the order they started. A unit is started at most
// once in a plan run, whatever became of its run.
export const PlanRunUnit = z.object({
  unitKey: z.string().min(1),
  title: z.string(),
  runId: Id,
  outcome: z.enum(['running', 'done', 'failed', 'stopped']),
});
export type PlanRunUnit = z.infer<typeof PlanRunUnit>;

export const PlanRun = z.object({
  id: Id,
  // `<projectId>:<intentId>`, the plan's row.
  planId: Id,
  projectId: Id,
  intentId: z.string().min(1),
  workflowId: Id,
  state: PlanRunState,
  units: z.array(PlanRunUnit),
  // While waiting: one sentence per unit that is not delivered, such as "U2 waits for U1 to
  // merge" (spec 41). Empty otherwise.
  waitingFor: z.array(z.string()),
  // Why it ended as failed, or what a start that could not happen said.
  message: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type PlanRun = z.infer<typeof PlanRun>;

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
