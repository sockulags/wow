import {
  SecretRef,
  type Approval,
  type AssistantChangeRecord,
  type AssistantProposalRecord,
  type CommandOrigin,
  type CalendarItem,
  type ChangeRequest,
  type HostRead,
  type TicketRead,
  type PageRead,
  type OutlookStatus,
  type BacklogItem,
  type DomainEvent,
  type EventTrigger,
  type Project,
  type ProviderInstance,
  type Question,
  type RpcErrorCode,
  type ServerCommand,
  type SettingDefinition,
  type SettingScopeRef,
  type PlanIntent,
  type PlanRun,
  type Skill,
  type Thread,
  type Trigger,
  type Turn,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { decideBacklog, isBacklogCommand } from './backlog.js';
import { decideCalendar, isCalendarCommand } from './calendar.js';
import { decideTickets } from './tickets.js';
import { decidePages } from './pages.js';
import { decideHosts, decidePlansSync, isHostCommand } from './hosts.js';
import { decidePlanRun, isPlanRunCommand } from './plan-runs.js';
import { decideProject, isProjectCommand } from './projects.js';
import { decideProviderInstance, isProviderInstanceCommand } from './provider-instances.js';
import { decideThread, isThreadCommand } from './threads.js';
import { decideTrigger, isTriggerCommand } from './triggers.js';
import { decideWorkflow, isWorkflowCommand } from './workflows.js';

// The orchestrator decides which events a command produces. It is a pure function of the command,
// a read-only view of the projections and the context; it never writes or performs effects.

export interface ReadModel {
  project(id: string): Project | undefined;
  projects(): Project[];
  // Local cards linked to the project, and whether one of its runs is running or waiting.
  projectCards(id: string): CalendarItem[];
  projectHasLiveRun(id: string): boolean;
  providerInstanceExists(id: string): boolean;
  providerInstance(id: string): ProviderInstance | undefined;
  // Every instance, in the order they were made.
  providerInstances(): ProviderInstance[];
  // Chat and step threads that use the instance, and how many turns run on it (the assistant's
  // turn included).
  instanceUsage(id: string): { readonly threads: number; readonly runningTurns: number };
  // Stored value at exactly this scope, or undefined when none is stored.
  setting(key: string, scope: SettingScopeRef): { value: unknown } | undefined;
  // Every stored value of the key, whatever its scope.
  settingStored(key: string): readonly { readonly scope: string; readonly value: unknown }[];
  thread(id: string): Thread | undefined;
  runningTurn(threadId: string): Turn | undefined;
  // The thread's turn with the highest index, running or not.
  lastTurn(threadId: string): Turn | undefined;
  turnCount(threadId: string): number;
  // Index the next item of the thread gets.
  nextItemIndex(threadId: string): number;
  itemExists(id: string): boolean;
  approval(id: string): Approval | undefined;
  question(id: string): Question | undefined;
  // Approvals and questions of the thread that are still waiting for an answer.
  openRequests(threadId: string): number;
  calendarItem(id: string): CalendarItem | undefined;
  // Every cached Outlook calendar row.
  outlookCalendarItems(): CalendarItem[];
  outlookStatus(): OutlookStatus | undefined;
  skills(): Skill[];
  planIntents(): PlanIntent[];
  planRun(id: string): PlanRun | undefined;
  // The plan run that is running or waiting on this plan (`<projectId>:<intentId>`), if any.
  livePlanRun(planId: string): PlanRun | undefined;
  // What was last read from the project's host, and the change requests those reads name.
  hostReads(projectId: string): HostRead[];
  changeRequests(projectId: string): ChangeRequest[];
  // What was last read about the tickets of the project's runs.
  ticketReads(projectId: string): TicketRead[];
  // What was last read about the pages the texts of the project's runs link to.
  pageReads(projectId: string): PageRead[];
  workflow(id: string): Workflow | undefined;
  run(id: string): WorkflowRun | undefined;
  // True while a run of this workflow is running or waiting at a gate.
  hasLiveRun(workflowId: string): boolean;
  backlogItem(id: string): BacklogItem | undefined;
  trigger(id: string): Trigger | undefined;
  // The project's event triggers, oldest first.
  eventTriggers(projectId: string): EventTrigger[];
  // Whether the trigger has already seen this event (and started its run, or failed to).
  triggerEventSeen(triggerId: string, eventId: string): boolean;
  // True while a run started for this backlog item is running or waiting at a gate.
  backlogItemHasLiveRun(id: string): boolean;
  assistantChange(id: string): AssistantChangeRecord | undefined;
  assistantProposal(id: string): AssistantProposalRecord | undefined;
  // What the user answered to the assistant after `since` (every answer without it), in the
  // order answered: proposals they said Yes or No to, and changes they undid.
  assistantAnswers(since: string | undefined): {
    readonly proposals: AssistantProposalRecord[];
    readonly undone: AssistantChangeRecord[];
  };
}

export interface DecideContext {
  readonly now: string;
  readonly registry: Readonly<Record<string, SettingDefinition>>;
  // wow's own folder (`WOW_HOME`), where a relative `workspaces.root` is resolved.
  readonly home?: string | undefined;
  // Who sent the command; absent means the user. `decide` itself does not look at it: what the
  // assistant may send is settled in `decideInSteps` (core/assistant.ts) before a command gets here.
  readonly origin?: CommandOrigin | undefined;
}

type AssistantCommand = Extract<ServerCommand, { type: `assistant.${string}` }>;

export const isAssistantCommand = (command: ServerCommand): command is AssistantCommand =>
  command.type.startsWith('assistant.');

export class CommandRejected extends Error {
  constructor(
    readonly code: Extract<RpcErrorCode, 'rejected' | 'not_found' | 'conflict'>,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CommandRejected';
  }
}

export function decide(
  command: ServerCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (isProjectCommand(command)) return decideProject(command, read, context);
  if (isProviderInstanceCommand(command)) return decideProviderInstance(command, read);
  if (isThreadCommand(command)) return decideThread(command, read, context);
  if (isTriggerCommand(command)) return decideTrigger(command, read, context);
  if (isCalendarCommand(command)) return decideCalendar(command, read, context);
  if (isWorkflowCommand(command)) return decideWorkflow(command, read, context);
  if (isBacklogCommand(command)) return decideBacklog(command, read, context);
  if (isHostCommand(command)) return decideHosts(command, read, context);
  if (command.type === 'tickets.sync') return decideTickets(command, read);
  if (command.type === 'pages.sync') return decidePages(command, read);
  if (isPlanRunCommand(command)) return decidePlanRun(command, read, context);
  if (isAssistantCommand(command)) {
    // They apply other commands step by step, each on what the one before left behind.
    throw new Error(`${command.type} is decided in steps; dispatch it through the engine`);
  }
  switch (command.type) {
    case 'setting.set': {
      const definition = settingDefinition(command.key, context);
      checkScope(command.key, definition, command.scope, read);
      const parsed = definition.schema.safeParse(command.value);
      if (!parsed.success) {
        throw new CommandRejected(
          'rejected',
          `Invalid value for ${command.key}`,
          parsed.error.issues,
        );
      }
      if (definition.secret && !SecretRef.safeParse(parsed.data).success) {
        throw new CommandRejected(
          'rejected',
          `${command.key} is secret: store the value with secrets.set and save the reference`,
        );
      }
      const stored = read.setting(command.key, command.scope);
      if (stored && isDeepStrictEqual(stored.value, parsed.data)) return [];
      return [
        {
          kind: 'setting.changed',
          aggregate: settingAggregate(command.key, command.scope),
          payload: { key: command.key, scope: command.scope, value: parsed.data },
        },
      ];
    }
    case 'setting.reset': {
      settingDefinition(command.key, context);
      if (!read.setting(command.key, command.scope)) return [];
      return [
        {
          kind: 'setting.reset',
          aggregate: settingAggregate(command.key, command.scope),
          payload: { key: command.key, scope: command.scope },
        },
      ];
    }
    case 'skills.sync': {
      const current = new Map(read.skills().map((skill) => [skill.id, skill]));
      const next = new Set(command.skills.map((skill) => skill.id));
      if (next.size !== command.skills.length) {
        throw new CommandRejected('rejected', 'Skill ids must be unique');
      }
      const upserted = command.skills.filter(
        (skill) => !isDeepStrictEqual(current.get(skill.id), skill),
      );
      const removed = [...current.keys()].filter((id) => !next.has(id));
      if (upserted.length === 0 && removed.length === 0) return [];
      return [{ kind: 'skills.synced', aggregate: 'skills', payload: { upserted, removed } }];
    }
    case 'plans.sync':
      return decidePlansSync(command.intents, read);
  }
}

const settingAggregate = (key: string, scope: SettingScopeRef) => `setting:${scope}:${key}`;

function settingDefinition(key: string, context: DecideContext): SettingDefinition {
  const definition = Object.hasOwn(context.registry, key) ? context.registry[key] : undefined;
  if (!definition) throw new CommandRejected('not_found', `Unknown setting ${key}`);
  return definition;
}

// A setting's registry scope is the narrowest place it may be stored: 'global' settings only
// globally, 'project' settings also per project, 'provider' settings per project and per provider
// instance as well.
function checkScope(
  key: string,
  definition: SettingDefinition,
  scope: SettingScopeRef,
  read: ReadModel,
): void {
  if (scope === 'global') return;
  const [kind, ...rest] = scope.split(':');
  const id = rest.join(':');
  const allowed =
    kind === 'project'
      ? definition.scope === 'project' || definition.scope === 'provider'
      : definition.scope === 'provider';
  if (!allowed) {
    throw new CommandRejected('rejected', `${key} can only be set at ${definition.scope} scope`);
  }
  if (kind === 'project' && !read.project(id)) {
    throw new CommandRejected('not_found', `No project ${id}`);
  }
  if (kind === 'provider' && !read.providerInstanceExists(id)) {
    throw new CommandRejected('not_found', `No provider instance ${id}`);
  }
}
