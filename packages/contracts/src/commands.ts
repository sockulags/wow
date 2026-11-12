import { z } from 'zod';
import { AttachmentId } from './attachments.js';
import { AssistantChange, AssistantProposal } from './assistant.js';
import { OwnSkill, SentSkill, SkillRef } from './skills.js';
import {
  AppNotification,
  Approval,
  BacklogItem,
  BacklogRemote,
  BacklogState,
  CalendarItem,
  CardState,
  CopiedTurn,
  ForkOrigin,
  GoBack,
  OutlookItemState,
  OutlookProfile,
  PlanIntent,
  PlanRun,
  Project,
  ProviderInstance,
  ProviderInstanceStatus,
  Question,
  QueuedMessage,
  ResumePointRef,
  Skill,
  Thread,
  ThreadItem,
  ThreadKind,
  Trigger,
  TriggerEvent,
  Turn,
  TurnState,
  Usage,
  Workflow,
  WorkflowRun,
} from './projections.js';
import { HostItemData, HostItemRead, HostItemRef } from './host-links.js';
import {
  ChangeRequest,
  HostError,
  HostKind,
  HostRead,
  HostReadOutcome,
  PageRead,
  PageReadOutcome,
  TicketRead,
  TicketReadOutcome,
} from './hosts.js';
import {
  ApprovalDecision,
  BackgroundTask,
  ProviderEvent,
  ProviderKind,
  ProviderTestResult,
  ProviderUpdate,
  ThreadState,
} from './provider.js';
import { QuestionReply } from './questions.js';
import { CardOccurrence, LocalDay, RepeatRule } from './repeat.js';
import { MissedTriggerPolicy, SecretRef, SettingScopeRef } from './settings.js';
import { SetupApplication } from './setup.js';
import { FileHash, RunEffect, UnpushedWork, WorkflowStep } from './workflow.js';

// Commands are what clients ask for; events are what the server decided happened. Later units
// add their own members to both unions.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// The server stores tags trimmed, non-empty and unique, in the order given.
const BacklogTags = z.array(z.string());
// A thread's title as the user types it; spaces around it are dropped.
const ThreadTitle = z.string().trim().min(1, 'A thread needs a title');

const WorkflowSteps = z
  .array(WorkflowStep)
  .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
    message: 'Step ids must be unique',
  });

export const CommandId = z.string().min(1).max(200);
export type CommandId = z.infer<typeof CommandId>;

export const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project.create'),
    projectId: Id,
    // The server refuses a name another project has and a folder that does not exist.
    name: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    defaultProviderInstanceId: Id.optional(),
    defaultModel: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('project.update'),
    projectId: Id,
    name: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    defaultProviderInstanceId: Id.nullable().optional(),
    defaultModel: z.string().min(1).nullable().optional(),
  }),
  // Refused while a run in the project is live. Cards lose the project and their pending trigger;
  // threads keep their folder; finished runs keep the id.
  z.object({ type: z.literal('project.delete'), projectId: Id }),
  z.object({
    type: z.literal('setting.set'),
    key: z.string().min(1),
    scope: SettingScopeRef,
    value: z.unknown(),
  }),
  z.object({ type: z.literal('setting.reset'), key: z.string().min(1), scope: SettingScopeRef }),
  z.object({
    type: z.literal('providerInstance.create'),
    providerInstanceId: Id,
    kind: ProviderKind,
    name: z.string().min(1),
    binaryPath: z.string(),
    configDir: z.string(),
    env: z.record(z.string(), z.union([z.string(), SecretRef])),
    launchArgs: z.array(z.string()),
    defaultModel: z.string().min(1).nullable().optional(),
    defaultEffort: z.string().min(1).nullable().optional(),
    defaultPermissionMode: z.string().min(1).nullable().optional(),
  }),
  // Changes what is given. A change to how the CLI starts clears the last "Test" result.
  z.object({
    type: z.literal('providerInstance.update'),
    providerInstanceId: Id,
    name: z.string().min(1).optional(),
    binaryPath: z.string().optional(),
    configDir: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), SecretRef])).optional(),
    launchArgs: z.array(z.string()).optional(),
    defaultModel: z.string().min(1).nullable().optional(),
    defaultEffort: z.string().min(1).nullable().optional(),
    defaultPermissionMode: z.string().min(1).nullable().optional(),
  }),
  // Refused while a thread uses the instance, so no thread loses the provider it resumes on.
  z.object({ type: z.literal('providerInstance.delete'), providerInstanceId: Id }),
  z.object({
    type: z.literal('thread.create'),
    threadId: Id,
    providerInstanceId: Id,
    projectId: Id.optional(),
    cwd: z.string().min(1),
    branch: z.string().min(1).optional(),
    title: z.string().optional(),
    model: z.string().min(1),
    effort: z.string().min(1),
    permissionMode: z.string().min(1),
    // "Fork from here" (agent workbench spec 71): the new thread holds the conversation of
    // `threadId` up to and including the exchange of the message `turnId` starts with, on the
    // same provider, folder, project and settings, which the server takes from that thread (what
    // the fields above say is not used then). The provider forks its own conversation at the
    // next message. Refused where the provider cannot go back, or the turn gave no point to.
    forkFrom: ForkOrigin.optional(),
  }),
  // Makes the one assistant thread, or brings it in line with the provider instance, model and
  // effort the settings name now (app assistant spec 1). Refused with the reason when no
  // connected instance can run it (spec 27). The fallbacks are what the instance itself offers,
  // used only when neither the settings nor the instance name a model or an effort.
  z.object({
    type: z.literal('thread.openAssistant'),
    fallbackModel: z.string().min(1).optional(),
    fallbackEffort: z.string().min(1).optional(),
  }),
  // The assistant's first turn after the first-start step (app assistant spec 24, 26), sent
  // when the step goes up. The server keeps it owed and greets as soon as the assistant can
  // run: at once when its thread is open on a connected instance, else at the next
  // `thread.openAssistant`. The conversation shows `assistant.greeting` as the user's line; the
  // agent also gets wow's note of what is set up, what a first run still needs and what a setup
  // file left to fill in.
  z.object({ type: z.literal('thread.greetAssistant') }),
  // Starts a turn with the thread's current model, effort and permission mode (spec 14, 17).
  // While a turn runs the message is queued with the server instead (agent workbench spec 50):
  // the thread's `queued` holds it, a second message joins it, and the server sends it when the
  // turn ends. On a provider that takes a message into its running turn (Claude Code) the server
  // hands it over at once and the conversation shows it sent (spec 51).
  // `skills` are the skills picked for the message, in order (wow skills spec 10, 18): a wow
  // skill goes in as its text, a folder skill as its invocation, both before the text. The text
  // may be empty when skills are picked (a message that is only a chip); the server refuses a
  // message with neither.
  z.object({
    type: z.literal('thread.sendMessage'),
    threadId: Id,
    text: z.string(),
    skills: z.array(SkillRef).optional(),
    // Files mentioned with `@` (agent workbench spec 56); the text already names them. Kept on
    // the message so the thread shows them as chips. The assistant takes none.
    files: z.array(z.string().min(1)).optional(),
    // Images given to `attachments.put` for this thread before (agent workbench spec 53, 55), by
    // id. The assistant takes none (spec 61).
    attachments: z
      .array(z.object({ id: AttachmentId, name: z.string().min(1).max(200).optional() }))
      .optional(),
  }),
  // Edit (agent workbench spec 62): the message replaces the last exchange, whose user message
  // `turnId` starts. The conversation goes on from before that message, in wow and in the
  // provider; the replaced exchange stays as the new turn's earlier version. Files stay as they
  // are. Refused while a turn runs, when `turnId` is no longer the last message, and where the
  // provider cannot go back.
  z.object({
    type: z.literal('thread.editLast'),
    threadId: Id,
    turnId: Id,
    text: z.string(),
    skills: z.array(SkillRef).optional(),
    files: z.array(z.string().min(1)).optional(),
    attachments: z
      .array(z.object({ id: AttachmentId, name: z.string().min(1).max(200).optional() }))
      .optional(),
  }),
  // The way out of a go-back the provider keeps refusing (a session file cleaned up, a point it no
  // longer accepts): the thread stops going back, so its next message goes on in the thread's
  // own session, or starts a new conversation where it has none yet (a fork). Edit's replaced
  // exchange stays marked replaced. Refused while a turn runs and when nothing goes back.
  z.object({ type: z.literal('thread.dropGoBack'), threadId: Id }),
  // The user's answer to the questions the assistant asked with its tool (questions spec 9):
  // `itemId` is that tool call, with one reply per question. It is sent as the user's next
  // message, marked as the answer. Only the assistant's thread has such questions.
  z.object({
    type: z.literal('thread.answerQuestions'),
    threadId: Id,
    itemId: Id,
    replies: z.array(QuestionReply).min(1),
  }),
  // Retry in a workflow step's thread: the last message the thread was sent goes again as it
  // was sent (its prompt, text and skills), as a step sends its turn. A chat's Retry sends the
  // message again with `thread.sendMessage` instead.
  z.object({ type: z.literal('thread.retry'), threadId: Id }),
  // Stops the running turn; what it produced so far stays (spec 23).
  z.object({ type: z.literal('thread.interrupt'), threadId: Id }),
  // Stops a task the agent runs in the background (agent workbench spec 90), by its id in the
  // thread's `backgroundTasks`. Refused when the thread lists no such task or its provider
  // cannot stop one.
  z.object({ type: z.literal('thread.stopTask'), threadId: Id, taskId: Id }),
  // Sends the running turn's command or subagent to the background (spec 90): the running call
  // with this item id, or every one that runs when it is absent. Refused without a running turn,
  // for a call that is not a running command or subagent, or where the provider cannot.
  z.object({ type: z.literal('thread.toBackground'), threadId: Id, itemId: Id.optional() }),
  // Takes the queued message off the queue; nothing is sent (agent workbench spec 52). Edit is
  // this too: the app puts the text back in the composer once the server took it off. Refused
  // when nothing waits, so a message already sent is never put back as if it had not gone.
  z.object({ type: z.literal('thread.cancelQueued'), threadId: Id }),
  z.object({
    type: z.literal('thread.configure'),
    threadId: Id,
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
  }),
  // Pinned threads sort above the others in their sidebar group (spec 21).
  z.object({ type: z.literal('thread.setPinned'), threadId: Id, pinned: z.boolean() }),
  // Done threads sit in the sidebar's Done group (spec 21). Refused while the thread works or
  // needs the user; reopening puts it back under Idle, and a new message reopens it too.
  z.object({ type: z.literal('thread.setDone'), threadId: Id, done: z.boolean() }),
  // A new title for a chat thread or a step's thread (agent workbench spec 67).
  z.object({ type: z.literal('thread.rename'), threadId: Id, title: ThreadTitle }),
  // Archive hides a thread from the list; there is no delete (spec 68). A workflow step's thread
  // is refused: it belongs to its run.
  z.object({ type: z.literal('thread.setArchived'), threadId: Id, archived: z.boolean() }),
  // The thread was opened, or the user asked to see it as new again (spec 70).
  z.object({ type: z.literal('thread.markSeen'), threadId: Id }),
  z.object({ type: z.literal('thread.markUnread'), threadId: Id }),
  // `note` goes with a denial (agent workbench spec 37); `permissionMode` starts a plan in that
  // mode (spec 42). `allowAlways` stores the rule the approval offers (spec 38).
  z.object({
    type: z.literal('approval.answer'),
    approvalId: Id,
    decision: ApprovalDecision,
    note: z.string().max(4000).optional(),
    permissionMode: z.string().min(1).optional(),
  }),
  // Answers to an agent's questions, sent together when one ask holds several (questions
  // spec 3). Refused for a question whose turn ended.
  z.object({
    type: z.literal('question.answer'),
    answers: z.array(z.object({ questionId: Id, reply: QuestionReply })).min(1),
  }),
  // A local card (spec 5). Times are instants; `zone` is the zone they were entered in. Cards
  // never reach Outlook.
  z.object({
    type: z.literal('card.create'),
    cardId: Id,
    title: z.string().trim().min(1),
    start: Timestamp,
    end: Timestamp,
    zone: z.string().min(1),
    body: z.string().optional(),
    projectId: Id.optional(),
    backlogItemId: Id.optional(),
    workflowId: Id.optional(),
    // Makes the card repeat (recurring cards spec 1); start and end are the first occurrence.
    repeat: RepeatRule.optional(),
    // Days already skipped by hand, for Undo of a deleted series (spec 13).
    skippedDates: z.array(LocalDay).optional(),
  }),
  // Moving, resizing and editing (spec 6). Outlook items are read-only and refused. On a
  // repeating card it changes every occurrence that has not started (recurring cards spec 10);
  // `repeat: null` makes it a single card again (spec 14).
  z.object({
    type: z.literal('card.update'),
    cardId: Id,
    title: z.string().trim().min(1).optional(),
    start: Timestamp.optional(),
    end: Timestamp.optional(),
    zone: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    projectId: Id.nullable().optional(),
    backlogItemId: Id.nullable().optional(),
    workflowId: Id.nullable().optional(),
    repeat: RepeatRule.nullable().optional(),
    // The whole list of days skipped by hand; Undo of a skip sends the list as it was.
    skippedDates: z.array(LocalDay).optional(),
  }),
  // "This occurrence" (recurring cards spec 12): the day is skipped and the rest of the series
  // is untouched. Refused for a day the rule does not fall on and for one that already started.
  z.object({ type: z.literal('card.skipOccurrence'), cardId: Id, date: LocalDay }),
  // Moving or resizing one occurrence in the calendar (spec 11): the occurrence on `date` gets
  // this start and end, and so does every occurrence that has not started, by its local time
  // and length. An occurrence moves within its day; another day is a change of the rule.
  z.object({
    type: z.literal('card.moveOccurrence'),
    cardId: Id,
    date: LocalDay,
    start: Timestamp,
    end: Timestamp,
  }),
  // A card whose run is running or waiting needs `stopRun`: the app asks whether to stop the run
  // first (spec 13). The run's threads are kept either way.
  z.object({ type: z.literal('card.delete'), cardId: Id, stopRun: z.boolean().optional() }),
  // Starts the card's workflow now, for a missed card's "Run now" (spec 12).
  z.object({ type: z.literal('card.runNow'), cardId: Id, runId: Id }),
  z.object({
    type: z.literal('workflow.create'),
    workflowId: Id,
    name: z.string().min(1),
    templateKind: z.string().min(1).optional(),
    steps: WorkflowSteps,
    ownWorkingCopy: z.boolean().optional(),
    forUnits: z.boolean().optional(),
    maxStepVisits: Workflow.shape.maxStepVisits,
  }),
  z.object({
    type: z.literal('workflow.update'),
    workflowId: Id,
    name: z.string().min(1).optional(),
    templateKind: z.string().min(1).nullable().optional(),
    steps: WorkflowSteps.optional(),
    ownWorkingCopy: z.boolean().optional(),
    forUnits: z.boolean().optional(),
    // Null takes the workflow's own number away, so the setting applies again.
    maxStepVisits: Workflow.shape.maxStepVisits,
  }),
  z.object({ type: z.literal('workflow.delete'), workflowId: Id }),
  // Undo of a delete: puts the row the client still holds back as it was.
  z.object({ type: z.literal('workflow.restore'), workflow: Workflow }),
  // Own skills (wow skills spec 5, 6): a file under wow's home each. Undo of a create is the
  // delete; Undo of an update or a delete is `skill.restore` with the folder and the file the
  // client still holds (`Skill.file`), so a hand-written file comes back exactly as it was, even
  // one whose name or text the editor would refuse.
  z.object({ type: z.literal('skill.create'), skill: OwnSkill }),
  z.object({ type: z.literal('skill.update'), skill: OwnSkill }),
  z.object({ type: z.literal('skill.delete'), name: z.string().min(1) }),
  z.object({ type: z.literal('skill.restore'), folder: z.string().min(1), file: z.string() }),
  z.object({
    type: z.literal('workflowRun.start'),
    runId: Id,
    workflowId: Id,
    projectId: Id,
    calendarItemId: Id.optional(),
    backlogItemId: Id.optional(),
  }),
  // The user's answer at a gate (behaviors 9 to 11).
  z.object({ type: z.literal('workflowRun.continue'), runId: Id }),
  z.object({ type: z.literal('workflowRun.stop'), runId: Id }),
  // The other answer at a gate (review loop spec 16 to 18): the reviewed step runs again in its
  // thread with the note. The server refuses an empty note with a reason, so it is not a schema
  // error.
  z.object({ type: z.literal('workflowRun.sendBack'), runId: Id, note: z.string() }),
  // Backlog items stay in wow until the user publishes one (behavior 28).
  z.object({
    type: z.literal('backlog.create'),
    backlogItemId: Id,
    title: z.string().trim().min(1),
    body: z.string(),
    tags: BacklogTags,
  }),
  z.object({
    type: z.literal('backlog.update'),
    backlogItemId: Id,
    title: z.string().trim().min(1).optional(),
    body: z.string().optional(),
    tags: BacklogTags.optional(),
    state: BacklogState.optional(),
  }),
  // Refused while a run of the item is live; cards that pointed at it lose the link.
  z.object({ type: z.literal('backlog.delete'), backlogItemId: Id }),
  // Undo of a delete: puts the row the client still holds back as it was. Card links the delete
  // removed stay removed.
  z.object({ type: z.literal('backlog.restore'), item: BacklogItem }),
  // "Plan on calendar" (behavior 29): a card with the item, a workflow, a project and a time, and
  // the item becomes planned, in one step.
  z.object({
    type: z.literal('backlog.plan'),
    backlogItemId: Id,
    cardId: Id,
    workflowId: Id,
    projectId: Id,
    start: Timestamp,
    end: Timestamp,
    zone: z.string().min(1),
  }),
  // Follow or stop following a plan (`<projectId>:<intentId>`). A followed plan's pull requests
  // are read from the project's host; unfollowing forgets what was read for it.
  z.object({ type: z.literal('plan.follow'), planId: Id, followed: z.boolean() }),
  // "Run ready units": works through the plan's ready units with a workflow marked "For units",
  // one run per unit and one at a time (review loop spec 40 to 47).
  z.object({ type: z.literal('planRun.start'), planRunId: Id, planId: Id, workflowId: Id }),
  // Stops the live unit run and starts no further unit (spec 45).
  z.object({ type: z.literal('planRun.stop'), planRunId: Id }),
  // An event trigger (review loop spec 48): runs of the workflow start when polling first sees
  // the event on a pull request wow follows in the project. New triggers are on.
  z.object({
    type: z.literal('trigger.create'),
    triggerId: Id,
    projectId: Id,
    event: TriggerEvent,
    workflowId: Id,
  }),
  z.object({ type: z.literal('trigger.setEnabled'), triggerId: Id, enabled: z.boolean() }),
  // Event triggers only; a card's trigger goes with its card.
  z.object({ type: z.literal('trigger.delete'), triggerId: Id }),
  // The user's Yes to a proposal of the assistant (app assistant spec 9, 10): the command the
  // proposal holds is applied. Refused from the assistant's own origin.
  z.object({ type: z.literal('assistant.proposal.accept'), proposalId: Id }),
  // The user's No, with an optional reason for the assistant's next turn.
  z.object({
    type: z.literal('assistant.proposal.decline'),
    proposalId: Id,
    reason: z.string().optional(),
  }),
  // Takes back one change the assistant made (spec 8). Refused when the thing changed again
  // since, with what changed.
  z.object({ type: z.literal('assistant.undo'), changeId: Id }),
  // "Start from a setup file" (app assistant spec 22): the file's text is read again, checked
  // and applied as one step that `setup.undo` takes back. `name` is the file's name as picked.
  z.object({
    type: z.literal('setup.apply'),
    applicationId: Id,
    name: z.string().trim().min(1),
    text: z.string(),
  }),
  // Takes back every change one setup file made, or none when something it set changed since.
  z.object({ type: z.literal('setup.undo'), applicationId: Id }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];

// The server's whole record of a change the assistant made. Beside what the conversation shows
// it keeps what Undo needs: the values the change left behind (null when it removed the thing)
// and the commands that take it back. Undo is refused when the thing no longer holds `expect`.
// These hold real values, so they stay on the server and are not part of the topic's rows.
export const AssistantChangeRecord = AssistantChange.extend({
  expect: z.record(z.string(), z.unknown()).nullable(),
  inverse: z.array(Command),
});
export type AssistantChangeRecord = z.infer<typeof AssistantChangeRecord>;

// The server's whole record of a proposal: the command the assistant sent, kept as it was, and
// the state its title and lines were written from. Nothing of the command is applied until
// `assistant.proposal.accept` arrives with the user's origin, and then only while the state
// still is `basis`: a yes is for what the card said. Null in a row from before it was recorded.
export const AssistantProposalRecord = AssistantProposal.extend({
  command: Command,
  basis: z.record(z.string(), z.unknown()).nullable(),
});
export type AssistantProposalRecord = z.infer<typeof AssistantProposalRecord>;

// The server's whole record of an applied setup file: beside what Settings shows, one change
// record per thing it set, each with the values it left and the commands that take it back.
// Undo is refused while any of them no longer holds; it then takes back every one, newest
// first. These hold real values, so they are not part of the topic's rows.
export const SetupApplicationRecord = SetupApplication.extend({
  parts: z.array(AssistantChangeRecord),
});
export type SetupApplicationRecord = z.infer<typeof SetupApplicationRecord>;

// One Outlook calendar row as the sync delivers it; the server fills in the local-only fields.
export const OutlookCalendarRow = CalendarItem.pick({
  id: true,
  title: true,
  start: true,
  end: true,
  zone: true,
  allDay: true,
  location: true,
  joinUrl: true,
  body: true,
  organizer: true,
}).extend({ externalId: z.string().min(1), state: OutlookItemState });
export type OutlookCalendarRow = z.infer<typeof OutlookCalendarRow>;

export const ProviderUpdateProgress = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('started'),
    command: z.string().min(1),
    targetVersion: z.string().min(1),
    at: Timestamp,
  }),
  z.object({ phase: z.literal('output'), text: z.string().min(1) }),
  z.object({
    phase: z.literal('finished'),
    ok: z.boolean(),
    message: z.string().nullable(),
    at: Timestamp,
  }),
]);
export type ProviderUpdateProgress = z.infer<typeof ProviderUpdateProgress>;

// Commands only the server issues: what provider adapters report, and test results. They go
// through the same pipeline as client commands but are not accepted over RPC.
export const InternalCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('provider.events'),
    threadId: Id,
    events: z.array(ProviderEvent).min(1),
  }),
  z.object({
    type: z.literal('providerInstance.recordTest'),
    providerInstanceId: Id,
    result: ProviderTestResult,
  }),
  // What a running `provider.update` reports: its start, output as it arrives, and its end.
  z.object({
    type: z.literal('providerInstance.recordUpdate'),
    providerInstanceId: Id,
    progress: ProviderUpdateProgress,
  }),
  // A good Outlook poll: everything Outlook returned for the window. The orchestrator compares it
  // with the stored rows, so only changes become events.
  z.object({
    type: z.literal('outlook.sync'),
    at: Timestamp,
    window: z.object({ from: Timestamp, to: Timestamp }),
    calendar: z.array(OutlookCalendarRow),
    bridgeVersion: z.string(),
    // Null when Outlook could not say this poll; the stored profile is then kept.
    profile: OutlookProfile.nullable(),
  }),
  // A failed poll. The cached rows stay; only the status changes.
  z.object({
    type: z.literal('outlook.fail'),
    at: Timestamp,
    code: z.string().min(1),
    message: z.string(),
    unavailableSince: Timestamp,
  }),
  // Replaces the skills projection with a fresh scan; the server's skills watcher sends it.
  z.object({ type: z.literal('skills.sync'), skills: z.array(Skill) }),
  // A workflow step's turn: the prompt the engine made, sent as it is, with the text the thread
  // shows and the skills it was made with (wow skills spec 14).
  z.object({
    type: z.literal('thread.sendPrepared'),
    threadId: Id,
    text: z.string().min(1),
    prompt: z.string().min(1),
    skills: z.array(SentSkill),
  }),
  // The provider service, when a turn ended: the queued message `queuedId` goes as the next
  // turn. Nothing happens when another message waits by then or a turn runs again.
  z.object({ type: z.literal('thread.sendQueued'), threadId: Id, queuedId: Id }),
  // The provider took the queued message `queuedId` into its running turn: it leaves the queue
  // and the conversation shows it as a user message of that turn. `offered` is what the provider
  // got, so a message joined or cancelled meanwhile still shows it and keeps only the rest.
  z.object({
    type: z.literal('thread.handedOver'),
    threadId: Id,
    queuedId: Id,
    offered: z
      .object({
        text: z.string(),
        skills: z.array(SkillRef).optional(),
        files: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  }),
  // The provider service, before a chat thread's turn is sent: the commit its folder is on and
  // what already differed from it (first turn only), and the changed files' hashes as the turn
  // begins (agent workbench spec 34). Null where git could not say.
  z.object({
    type: z.literal('thread.changesMarked'),
    threadId: Id,
    turnId: Id,
    base: z.object({ sha: z.string().min(1), files: z.array(FileHash) }).nullable(),
    mark: z.array(FileHash).nullable(),
  }),
  // Replaces the plans projection with a fresh read of every project's intents folder; the
  // server's plans service sends it.
  z.object({ type: z.literal('plans.sync'), intents: z.array(PlanIntent) }),
  // What the host poller read for one project: every scope it asked about (a followed plan or a
  // run) with its outcome, and the change requests it read. The orchestrator stores what
  // changed and works out the unit statuses of the project's followed plans again.
  z.object({
    type: z.literal('hosts.sync'),
    projectId: Id,
    at: Timestamp,
    host: HostKind,
    hostName: z.string(),
    reads: z.array(HostReadOutcome),
    changeRequests: z.array(ChangeRequest),
  }),
  // What the host poller read about the tickets of one project's runs (review loop spec 33).
  z.object({
    type: z.literal('tickets.sync'),
    projectId: Id,
    at: Timestamp,
    hostName: z.string(),
    reads: z.array(TicketReadOutcome),
  }),
  // What the host poller read about the pages the texts of one project's runs link to (review
  // loop spec 35).
  z.object({
    type: z.literal('pages.sync'),
    projectId: Id,
    at: Timestamp,
    hostName: z.string(),
    reads: z.array(PageReadOutcome),
  }),
  // What the host lookup read about one item a chat thread links to (agent workbench spec 22).
  z.object({
    type: z.literal('hosts.itemRead'),
    threadId: Id,
    at: Timestamp,
    item: HostItemRef,
    hostName: z.string(),
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), data: HostItemData }),
      z.object({ ok: z.literal(false), error: HostError.omit({ at: true }) }),
    ]),
  }),
  // Something a plan run depends on changed (its unit's run ended, or the plan's unit statuses
  // did): decide again what it does next. The plan runs service sends it.
  z.object({ type: z.literal('planRun.advance'), planRunId: Id }),
  // What the workflow runner reports after a step's turn ended.
  z.object({
    type: z.literal('workflowRun.stepCompleted'),
    runId: Id,
    stepId: Id,
    finalMessage: z.string(),
    artifactsFound: z.array(z.string()),
    // The step's expected artifact globs that matched no file.
    artifactsMissing: z.array(z.string()).optional(),
    fileHashes: z.array(FileHash).optional(),
    // The commit the run's folder is on, for a gate that waits for that commit's checks.
    headSha: z.string().optional(),
  }),
  // Look again at a gate that waits for its pull request's checks: the host poller sends it when
  // `workflows.gateChecksTimeoutMinutes` has passed since the step ended.
  z.object({ type: z.literal('workflowRun.checkGate'), runId: Id, stepId: Id }),
  // The commit the run's folder was on when its first step began, and what already differed.
  z.object({
    type: z.literal('workflowRun.baseRecorded'),
    runId: Id,
    baseSha: z.string().min(1),
    files: z.array(FileHash),
  }),
  z.object({
    type: z.literal('workflowRun.stepFailed'),
    runId: Id,
    stepId: Id,
    error: z.string(),
    // The user interrupted the step's turn. Such a step follows no rule.
    stopped: z.boolean().optional(),
  }),
  // A turn ended in the thread of a step whose own turn was held for it: send the held one.
  z.object({ type: z.literal('workflowRun.sendHeldTurn'), runId: Id, stepId: Id }),
  z.object({
    type: z.literal('workflowRun.artifactsFound'),
    runId: Id,
    found: z.array(z.object({ stepId: Id, paths: z.array(z.string()) })),
  }),
  // The run's working copy exists: the commit it was made at, the default branch that commit
  // was read from, and a note when that is not the fetched tip.
  z.object({
    type: z.literal('workflowRun.workingCopyReady'),
    runId: Id,
    startSha: z.string().min(1),
    defaultBranch: z.string().nullable(),
    note: z.string().nullable(),
  }),
  // The working copy could not be made. The run fails before its first step (review loop
  // spec 38).
  z.object({ type: z.literal('workflowRun.workingCopyFailed'), runId: Id, error: z.string() }),
  // What became of the working copy after the run ended, or after "Remove working copy".
  z.object({
    type: z.literal('workflowRun.workingCopySettled'),
    runId: Id,
    state: z.enum(['kept', 'removed']),
    unpushed: UnpushedWork.nullable(),
    error: z.string().nullable(),
  }),
  // The scheduler's tick found the trigger due (spec 8). `runAt` is the time it saw, so a card
  // moved in the meantime does not fire.
  z.object({ type: z.literal('trigger.fire'), triggerId: Id, runAt: Timestamp, runId: Id }),
  // A trigger whose time passed while the server was down or the scheduler paused (spec 12).
  z.object({
    type: z.literal('trigger.applyMissed'),
    triggerId: Id,
    runAt: Timestamp,
    policy: MissedTriggerPolicy,
    runId: Id,
  }),
  // The tracker service created the issue; the item keeps its key and URL (behavior 30).
  z.object({
    type: z.literal('backlog.published'),
    backlogItemId: Id,
    remote: BacklogRemote,
  }),
]);
export type InternalCommand = z.infer<typeof InternalCommand>;

export type ServerCommand = Command | InternalCommand;

export const ProjectChanges = Project.pick({
  name: true,
  cwd: true,
  defaultProviderInstanceId: true,
  defaultModel: true,
}).partial();
export type ProjectChanges = z.infer<typeof ProjectChanges>;

export const ProviderInstanceChanges = ProviderInstance.pick({
  name: true,
  binaryPath: true,
  configDir: true,
  env: true,
  launchArgs: true,
  defaultModel: true,
  defaultEffort: true,
  defaultPermissionMode: true,
  status: true,
  account: true,
  version: true,
  statusMessage: true,
  update: true,
}).partial();
export type ProviderInstanceChanges = z.infer<typeof ProviderInstanceChanges>;

export const CardChanges = CalendarItem.pick({
  title: true,
  start: true,
  end: true,
  zone: true,
  body: true,
  projectId: true,
  backlogItemId: true,
  workflowId: true,
  repeat: true,
  skippedDates: true,
  pastSeries: true,
}).partial();
export type CardChanges = z.infer<typeof CardChanges>;

export const BacklogChanges = BacklogItem.pick({
  title: true,
  body: true,
  tags: true,
  state: true,
  runId: true,
}).partial();
export type BacklogChanges = z.infer<typeof BacklogChanges>;

export const ThreadChanges = Thread.pick({
  model: true,
  effort: true,
  permissionMode: true,
}).partial();
export type ThreadChanges = z.infer<typeof ThreadChanges>;

export const WorkflowChanges = Workflow.pick({
  name: true,
  templateKind: true,
  steps: true,
  ownWorkingCopy: true,
  forUnits: true,
  maxStepVisits: true,
})
  .partial()
  .extend({ updatedAt: Workflow.shape.updatedAt });
export type WorkflowChanges = z.infer<typeof WorkflowChanges>;

export const DomainEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project.created'), aggregate: Id, payload: Project }),
  z.object({
    kind: z.literal('project.updated'),
    aggregate: Id,
    payload: z.object({ projectId: Id, changes: ProjectChanges }),
  }),
  z.object({
    kind: z.literal('project.deleted'),
    aggregate: Id,
    payload: z.object({ projectId: Id }),
  }),
  z.object({
    kind: z.literal('setting.changed'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef, value: z.unknown() }),
  }),
  z.object({
    kind: z.literal('setting.reset'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef }),
  }),
  z.object({
    kind: z.literal('providerInstance.created'),
    aggregate: Id,
    payload: ProviderInstance,
  }),
  z.object({
    kind: z.literal('providerInstance.updated'),
    aggregate: Id,
    payload: z.object({
      providerInstanceId: Id,
      changes: ProviderInstanceChanges,
      // Secret store entries the instance no longer references; the server deletes them.
      releasedSecrets: z.array(z.string().min(1)),
    }),
  }),
  z.object({
    kind: z.literal('providerInstance.deleted'),
    aggregate: Id,
    payload: z.object({ providerInstanceId: Id, releasedSecrets: z.array(z.string().min(1)) }),
  }),
  z.object({
    kind: z.literal('providerInstance.tested'),
    aggregate: Id,
    payload: z.object({
      providerInstanceId: Id,
      status: ProviderInstanceStatus,
      account: z.string().nullable(),
      version: z.string().nullable(),
      statusMessage: z.string().nullable(),
      update: ProviderUpdate.nullable(),
    }),
  }),
  z.object({
    kind: z.literal('providerInstance.updateProgressed'),
    aggregate: Id,
    payload: z.object({ providerInstanceId: Id, progress: ProviderUpdateProgress }),
  }),
  // An own skill written or removed by command. The skills service writes or removes its file.
  z.object({
    kind: z.literal('skill.saved'),
    aggregate: z.literal('skills'),
    payload: z.object({ skill: Skill, previous: Skill.nullable() }),
  }),
  z.object({
    kind: z.literal('skill.deleted'),
    aggregate: z.literal('skills'),
    payload: z.object({ skill: Skill }),
  }),
  z.object({
    kind: z.literal('skills.synced'),
    aggregate: z.literal('skills'),
    payload: z.object({ upserted: z.array(Skill), removed: z.array(Id) }),
  }),
  z.object({
    kind: z.literal('plans.synced'),
    aggregate: z.literal('plans'),
    payload: z.object({ upserted: z.array(PlanIntent), removed: z.array(Id) }),
  }),
  // Host rows as they now are, and the ones that went (an unfollowed plan, a change request no
  // read names any more).
  z.object({
    kind: z.literal('hosts.synced'),
    aggregate: Id,
    payload: z.object({
      projectId: Id,
      reads: z.array(HostRead),
      removedReads: z.array(Id),
      changeRequests: z.array(ChangeRequest),
      removedChangeRequests: z.array(Id),
    }),
  }),
  // A chat thread's read of one linked item as it now is.
  z.object({
    kind: z.literal('hosts.itemRead'),
    aggregate: Id,
    payload: z.object({ read: HostItemRead }),
  }),
  // Ticket reads as they now are.
  z.object({
    kind: z.literal('tickets.synced'),
    aggregate: Id,
    payload: z.object({ projectId: Id, reads: z.array(TicketRead) }),
  }),
  // Page reads as they now are. `fetched` names the reads whose host answered the same as last
  // time: only their times move (touchPageRead), so unchanged page bodies are not written into
  // the history again every round. Absent on events from before.
  z.object({
    kind: z.literal('pages.synced'),
    aggregate: Id,
    payload: z.object({
      projectId: Id,
      reads: z.array(PageRead),
      fetched: z.object({ at: Timestamp, ids: z.array(Id).min(1) }).optional(),
    }),
  }),
  z.object({
    kind: z.literal('planRun.changed'),
    aggregate: Id,
    payload: z.object({ cause: z.string().min(1), planRun: PlanRun }),
  }),
  z.object({ kind: z.literal('workflow.created'), aggregate: Id, payload: Workflow }),
  z.object({
    kind: z.literal('workflow.updated'),
    aggregate: Id,
    payload: z.object({ workflowId: Id, changes: WorkflowChanges }),
  }),
  z.object({
    kind: z.literal('workflow.deleted'),
    aggregate: Id,
    payload: z.object({ workflowId: Id }),
  }),
  // One per run transition: the run as it now is, what caused it, and the effects the server
  // performs after commit.
  z.object({
    kind: z.literal('workflowRun.changed'),
    aggregate: Id,
    payload: z.object({ cause: z.string().min(1), run: WorkflowRun, effects: z.array(RunEffect) }),
  }),
  z.object({ kind: z.literal('thread.created'), aggregate: Id, payload: Thread }),
  z.object({
    kind: z.literal('thread.configured'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      providerInstanceId: Id,
      changes: ThreadChanges,
      updatedAt: Timestamp,
    }),
  }),
  // The assistant thread moved to another provider instance. The provider's own session stays
  // behind with the old instance unless the new one reads the same config folder.
  z.object({
    kind: z.literal('thread.providerChanged'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      // The instance it left, whose live session for the thread is closed. Absent in events
      // stored before it was recorded.
      previousProviderInstanceId: Id.optional(),
      providerInstanceId: Id,
      providerSessionId: z.string().min(1).nullable(),
      model: z.string().min(1),
      effort: z.string().min(1),
      permissionMode: z.string().min(1),
      updatedAt: Timestamp,
    }),
  }),
  z.object({
    kind: z.literal('thread.sessionStarted'),
    aggregate: Id,
    payload: z.object({ threadId: Id, providerSessionId: z.string().min(1), updatedAt: Timestamp }),
  }),
  z.object({
    kind: z.literal('thread.pinned'),
    aggregate: Id,
    payload: z.object({ threadId: Id, pinned: z.boolean() }),
  }),
  z.object({
    kind: z.literal('thread.changesMarked'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      turnId: Id,
      base: z.object({ sha: z.string().min(1), files: z.array(FileHash) }).nullable(),
      mark: z.array(FileHash).nullable(),
    }),
  }),
  // The thread's queued message changed: queued, joined, sent or cancelled (null). `handOver`
  // is set when the provider may take it into the running turn: the provider service offers it
  // the prompt, and answers `thread.handedOver` when it did.
  z.object({
    kind: z.literal('thread.queueChanged'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      queued: QueuedMessage.nullable(),
      handOver: z.object({ providerInstanceId: Id, prompt: z.string().min(1) }).optional(),
    }),
  }),
  z.object({
    kind: z.literal('thread.stateChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, state: ThreadState, updatedAt: Timestamp }),
  }),
  z.object({
    kind: z.literal('thread.renamed'),
    aggregate: Id,
    payload: z.object({ threadId: Id, title: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('thread.archived'),
    aggregate: Id,
    payload: z.object({ threadId: Id, archived: z.boolean() }),
  }),
  z.object({
    kind: z.literal('thread.seenChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, seen: z.boolean() }),
  }),
  z.object({
    kind: z.literal('turn.started'),
    aggregate: Id,
    payload: z.object({
      turn: Turn,
      item: ThreadItem,
      // The divider before the message when the model, effort or mode changed since the turn
      // before (agent workbench spec 9); its index is the one before the message's.
      settingsItem: ThreadItem.optional(),
      providerInstanceId: Id,
      // What the provider gets, so the effect does not read the projection again.
      start: z.object({
        cwd: z.string().min(1),
        prompt: z.string(),
        model: z.string().min(1),
        effort: z.string().min(1),
        permissionMode: z.string().min(1),
        resumeId: z.string().min(1).nullable(),
        // The thread goes back in the conversation first (`ProviderCommand` startTurn.goBack).
        goBack: z.object({ at: z.string().min(1).nullable(), fork: z.boolean() }).optional(),
        // The message's images by id; the provider service hands their files to the adapter.
        images: z.array(AttachmentId).optional(),
        // Set for the assistant thread: the provider service then hands the turn wow's tools,
        // the instruction text and the app's empty folder. The token is never stored here.
        kind: ThreadKind.optional(),
      }),
    }),
  }),
  // A turn the provider started by itself, so there is no user message and nothing to send.
  z.object({
    kind: z.literal('turn.startedByProvider'),
    aggregate: Id,
    payload: z.object({ turn: Turn }),
  }),
  z.object({
    kind: z.literal('thread.backgroundChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, tasks: z.array(BackgroundTask), updatedAt: Timestamp }),
  }),
  z.object({
    kind: z.literal('turn.interruptRequested'),
    aggregate: Id,
    payload: z.object({ threadId: Id, turnId: Id, providerInstanceId: Id }),
  }),
  // What the provider service sends on (spec 90); the provider's answer arrives as its
  // `backgroundTasks` and tool events. `toolUseId` is the provider's id of the call.
  z.object({
    kind: z.literal('thread.taskStopRequested'),
    aggregate: Id,
    payload: z.object({ threadId: Id, taskId: Id, providerInstanceId: Id }),
  }),
  z.object({
    kind: z.literal('thread.backgroundRequested'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      turnId: Id,
      providerInstanceId: Id,
      toolUseId: Id.optional(),
    }),
  }),
  z.object({
    kind: z.literal('turn.usageRecorded'),
    aggregate: Id,
    payload: z.object({ turnId: Id, usage: Usage }),
  }),
  z.object({
    kind: z.literal('turn.ended'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      turnId: Id,
      state: TurnState.exclude(['running']),
      threadState: ThreadState,
      endedAt: Timestamp,
      // The provider's point after this turn (`ProviderEvent` turnCompleted.resumePoint), in the
      // session the thread had then.
      resumePoint: ResumePointRef.optional(),
    }),
  }),
  // Edit put `by` in the place of `turnId` (agent workbench spec 62).
  z.object({
    kind: z.literal('turn.replaced'),
    aggregate: Id,
    payload: z.object({ threadId: Id, turnId: Id, by: Id }),
  }),
  z.object({
    kind: z.literal('thread.goBackChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, goBack: GoBack.nullable() }),
  }),
  // A fork's conversation copied from its origin (spec 71), right after its `thread.created`:
  // the turns and items with the new thread's ids.
  z.object({
    kind: z.literal('thread.historyCopied'),
    aggregate: Id,
    payload: z.object({ threadId: Id, turns: z.array(CopiedTurn), items: z.array(ThreadItem) }),
  }),
  z.object({ kind: z.literal('threadItem.added'), aggregate: Id, payload: ThreadItem }),
  // Streaming text grows by appending, so the history does not store every intermediate text.
  z.object({
    kind: z.literal('threadItem.appended'),
    aggregate: Id,
    payload: z.object({
      itemId: Id,
      field: z.enum(['text', 'output']),
      delta: z.string(),
      // When the part arrived, kept as the item's `endedAt` (reasoning's "Thought for n s").
      at: Timestamp.optional(),
    }),
  }),
  // Shallow-merges into the item's payload.
  z.object({
    kind: z.literal('threadItem.patched'),
    aggregate: Id,
    payload: z.object({
      itemId: Id,
      patch: z.record(z.string(), z.unknown()),
      streaming: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('approval.requested'),
    aggregate: Id,
    payload: z.object({ approval: Approval, item: ThreadItem }),
  }),
  z.object({
    kind: z.literal('approval.answered'),
    aggregate: Id,
    payload: z.object({
      approvalId: Id,
      threadId: Id,
      providerInstanceId: Id,
      providerApprovalId: Id,
      decision: ApprovalDecision,
      decidedAt: Timestamp,
      note: z.string().min(1).optional(),
      permissionMode: z.string().min(1).optional(),
      // A stored rule answered it, not the user.
      byRule: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('question.asked'),
    aggregate: Id,
    payload: z.object({ question: Question, item: ThreadItem }),
  }),
  z.object({
    kind: z.literal('question.answered'),
    aggregate: Id,
    payload: z.object({
      questionId: Id,
      threadId: Id,
      providerInstanceId: Id,
      providerQuestionId: Id,
      // The answer as one line; events from before the card hold only this.
      answer: z.string(),
      reply: QuestionReply.optional(),
      answeredAt: Timestamp,
    }),
  }),
  z.object({ kind: z.literal('card.created'), aggregate: Id, payload: CalendarItem }),
  z.object({
    kind: z.literal('card.updated'),
    aggregate: Id,
    payload: z.object({ cardId: Id, changes: CardChanges, updatedAt: Timestamp }),
  }),
  z.object({ kind: z.literal('card.deleted'), aggregate: Id, payload: z.object({ cardId: Id }) }),
  // A repeating card reached an occurrence: what happened there (recurring cards spec 5 to 8).
  // Kept when the card is deleted, so Undo brings the card back with its history.
  z.object({
    kind: z.literal('card.occurrenceRecorded'),
    aggregate: Id,
    payload: z.object({ cardId: Id, occurrence: CardOccurrence }),
  }),
  // The card follows its trigger and its run.
  z.object({
    kind: z.literal('card.stateChanged'),
    aggregate: Id,
    payload: z.object({
      cardId: Id,
      state: CardState,
      runId: Id.nullable(),
      updatedAt: Timestamp,
    }),
  }),
  // The trigger row as it now is.
  z.object({ kind: z.literal('trigger.set'), aggregate: Id, payload: Trigger }),
  z.object({
    kind: z.literal('trigger.deleted'),
    aggregate: Id,
    payload: z.object({ triggerId: Id }),
  }),
  // An event trigger saw its event. Stored so the same event never fires the trigger again;
  // `runId` is null when the run could not start.
  z.object({
    kind: z.literal('trigger.eventSeen'),
    aggregate: Id,
    payload: z.object({ triggerId: Id, eventId: Id, runId: Id.nullable(), at: Timestamp }),
  }),
  z.object({ kind: z.literal('notification.sent'), aggregate: Id, payload: AppNotification }),
  // An ordinary change the assistant made, stored in the same commit as the change itself.
  z.object({ kind: z.literal('assistant.changed'), aggregate: Id, payload: AssistantChangeRecord }),
  // The greeting after the first-start step waits until the assistant can run it.
  z.object({
    kind: z.literal('assistant.greetingOwed'),
    aggregate: Id,
    payload: z.object({ at: Timestamp }),
  }),
  z.object({
    kind: z.literal('assistant.greetingSent'),
    aggregate: Id,
    payload: z.object({ at: Timestamp }),
  }),
  z.object({ kind: z.literal('setup.applied'), aggregate: Id, payload: SetupApplicationRecord }),
  z.object({
    kind: z.literal('setup.undone'),
    aggregate: Id,
    payload: z.object({ applicationId: Id, at: Timestamp }),
  }),
  z.object({
    kind: z.literal('assistant.changeUndone'),
    aggregate: Id,
    payload: z.object({ changeId: Id, at: Timestamp }),
  }),
  // A command of the assistant that waits for the user's yes; nothing else was changed.
  z.object({
    kind: z.literal('assistant.proposed'),
    aggregate: Id,
    payload: AssistantProposalRecord,
  }),
  z.object({
    kind: z.literal('assistant.proposalAnswered'),
    aggregate: Id,
    payload: z.object({
      proposalId: Id,
      state: z.enum(['accepted', 'declined']),
      reason: z.string().nullable(),
      at: Timestamp,
    }),
  }),
  z.object({ kind: z.literal('backlog.created'), aggregate: Id, payload: BacklogItem }),
  // Edits by the user, "Plan on calendar", and the item following its run (behavior 29).
  z.object({
    kind: z.literal('backlog.updated'),
    aggregate: Id,
    payload: z.object({ backlogItemId: Id, changes: BacklogChanges }),
  }),
  z.object({
    kind: z.literal('backlog.deleted'),
    aggregate: Id,
    payload: z.object({ backlogItemId: Id }),
  }),
  z.object({
    kind: z.literal('backlog.published'),
    aggregate: Id,
    payload: z.object({ backlogItemId: Id, remote: BacklogRemote }),
  }),
  // Only what changed since the stored rows; `at` is the poll time.
  z.object({
    kind: z.literal('outlook.synced'),
    aggregate: Id,
    payload: z.object({
      at: Timestamp,
      calendarUpsert: z.array(CalendarItem),
      calendarRemove: z.array(Id),
      bridgeVersion: z.string(),
      // Absent in events stored before Outlook profiles were read.
      profile: OutlookProfile.nullable().optional(),
    }),
  }),
  z.object({
    kind: z.literal('outlook.failed'),
    aggregate: Id,
    payload: z.object({ lastError: z.string(), unavailableSince: Timestamp }),
  }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventKind = DomainEvent['kind'];

export const DispatchResult = z.object({
  commandId: CommandId,
  // Sequence numbers of the events this command appended; empty when it changed nothing.
  seqs: z.array(z.number().int().positive()),
  // True when the command id had already been applied and this is the stored receipt.
  duplicate: z.boolean(),
});
export type DispatchResult = z.infer<typeof DispatchResult>;
