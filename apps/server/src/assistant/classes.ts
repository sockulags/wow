import {
  isLiveRunState,
  type ServerCommand,
  type SettingDefinition,
  type WorkflowStep,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import type { DecideContext, ReadModel } from '../core/orchestrator.js';
import { runPath } from '../core/workflows.js';
import { resolveStored } from '../settings/service.js';

// The one table that says what the server does with a command the assistant sends (app
// assistant spec 7 to 11): `ordinary` is applied at once and can be undone, `proposal` is held
// until the user says yes, `refused` is never applied. The server reads it, not the model.

export type Classified =
  | { readonly class: 'ordinary' | 'proposal' }
  | { readonly class: 'refused'; readonly reason: string };

type CommandOf<T extends ServerCommand['type']> = Extract<ServerCommand, { type: T }>;

// A plain word or `refused(...)` holds for every command of the type; a function looks at what
// the command says and at the app's state.
type Rule<T extends ServerCommand['type']> =
  | 'ordinary'
  | 'proposal'
  | { readonly refused: string | ((command: CommandOf<T>) => string) }
  | ((command: CommandOf<T>, read: ReadModel, context: DecideContext) => Classified);

const refused = <C>(reason: string | ((command: C) => string)) => ({ refused: reason });

const ordinary: Classified = { class: 'ordinary' };
const proposal: Classified = { class: 'proposal' };

const serverOnly = refused('Only the wow server sends this; it is not something to ask for.');
const usersAnswer = refused(
  'Only the user answers a proposal or presses Undo, in the Assistant view.',
);
const chatOnly = refused(
  'The assistant does not work in chat threads. The chat view is for that: offer to open a new thread there with the text.',
);
const providersByHand = refused(
  'Provider instances are connected and changed by the user in Settings → Providers.',
);

// Only the user answers a gate (spec 11). The reason carries the link to the run.
const gateAnswer = refused(
  (command: { runId: string }) =>
    `Only the user approves, sends back or stops a run. The run is at ${runPath(command.runId)}.`,
);

const turnedOn = (on: unknown) => (next: unknown, current: unknown) =>
  next === on && current !== on;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];

// Settings whose new value lets the app do more on its own (spec 9). Taking a skill off the
// list of skills that always stop is not in the spec's list but is the same kind of change: a
// gate that always waited may then pass by itself.
const moreOnItsOwn: Readonly<Record<string, (next: unknown, current: unknown) => boolean>> = {
  'scheduler.paused': turnedOn(false),
  'scheduler.missedPolicy': turnedOn('run'),
  'hosts.polling': turnedOn(true),
  'triggers.eventsEnabled': turnedOn(true),
  'viewer.htmlScripts': turnedOn(true),
  'workflows.alwaysStopSkills': (next, current) => {
    const kept = new Set(strings(next));
    return strings(current).some((skill) => !kept.has(skill));
  },
};

// The net that hides secret-looking text is the assistant's own guard, so the assistant does
// not change it without a yes.
const guardSettings: ReadonlySet<string> = new Set(['assistant.secretPatterns']);

// Where a tracker's token is sent. Spec 7 calls tracker host settings ordinary, but with the
// token set a new address would send that token to a host the user never chose, so then the
// user is asked. Without a token there is nothing to send and the change is ordinary.
const trackerAddress = /^(trackers\.[^.]+)\.(?:baseUrl|authMode)$/;

// A token stored at any scope counts: a project's own token is sent to the address the project
// resolves, and that can be the global one, so a global change reaches a project's token too.
function sendsStoredToken(key: string, read: ReadModel): boolean {
  const tracker = trackerAddress.exec(key)?.[1];
  if (tracker === undefined) return false;
  return read.settingStored(`${tracker}.token`).some((stored) => (stored.value ?? null) !== null);
}

// A field of a card as an update leaves it: absent keeps what is there, null clears it.
const afterUpdate = <T>(next: T | null | undefined, current: T | null | undefined) =>
  next === undefined ? (current ?? undefined) : (next ?? undefined);

const START_SOON_KEY = 'assistant.startSoonMinutes';

// A card with a workflow and a project starts a run at its time. Put at once or a moment from
// now it is "start a run now" by another name, which waits for a yes (spec 10); a card further
// ahead is scheduling, which the user can see on the calendar and take back.
function startsSoon(
  workflowId: string | undefined,
  projectId: string | undefined,
  start: string | undefined,
  read: ReadModel,
  context: DecideContext,
): Classified {
  if (workflowId === undefined || projectId === undefined || start === undefined) return ordinary;
  const definition = context.registry[START_SOON_KEY];
  const minutes = definition
    ? resolveStored(START_SOON_KEY, definition, {}, (scope) => read.setting(START_SOON_KEY, scope))
        .value
    : 0;
  const soon = Date.parse(context.now) + (typeof minutes === 'number' ? minutes : 0) * 60_000;
  return Date.parse(start) <= soon ? proposal : ordinary;
}

const definitionOf = (key: string, context: DecideContext): SettingDefinition | undefined =>
  Object.hasOwn(context.registry, key) ? context.registry[key] : undefined;

function settingClass(
  key: string,
  scope: string,
  next: (definition: SettingDefinition) => unknown,
  read: ReadModel,
  context: DecideContext,
): Classified {
  const definition = definitionOf(key, context);
  // An unknown key is the app's to refuse, with its own reason.
  if (!definition) return ordinary;
  if (definition.secret) {
    return {
      class: 'refused',
      reason: `${definition.label} is a secret. The user types it into its own field; the assistant never sets, clears or sees one.`,
    };
  }
  if (guardSettings.has(key) || sendsStoredToken(key, read)) return proposal;
  const more = moreOnItsOwn[key];
  if (!more) return ordinary;
  const stored = read.setting(key, scope);
  const current = stored ? stored.value : definition.default;
  return more(next(definition), current) ? proposal : ordinary;
}

// The parts of a step that decide how much it does without the user (spec 9): its permission
// mode, the condition that passes its gate and its rules.
const autonomy = (step: WorkflowStep) => ({
  permissionMode: step.permissionMode ?? null,
  gateAfterCondition: step.gateAfterCondition?.length ? step.gateAfterCondition : null,
  rules: step.rules?.length ? step.rules : null,
});

const hasAutonomy = (step: WorkflowStep): boolean =>
  Object.values(autonomy(step)).some((part) => part !== null);

const stops = (steps: readonly WorkflowStep[]): number =>
  steps.reduce((count, step) => count + Number(step.gateBefore) + Number(step.gateAfter), 0);

// What a step with a permission mode or a gate that passes by itself runs. The user's yes to
// those was for this skill and prompt, so changing them under it asks again.
const work = (step: WorkflowStep) => ({
  skillName: step.skillName,
  extraPrompt: step.extraPrompt || null,
  providerInstanceId: step.providerInstanceId ?? null,
  model: step.model ?? null,
});

const actsAlone = (step: WorkflowStep): boolean => {
  const { permissionMode, gateAfterCondition } = autonomy(step);
  return permissionMode !== null || gateAfterCondition !== null;
};

// A step list asks for more when a step gains or changes one of those parts, when a step that
// stays loses a gate, when a step that acts alone gets other work, or when the list as a whole
// stops less often than it did (a step swapped for one without its gate).
function stepsAskForMore(before: readonly WorkflowStep[], after: readonly WorkflowStep[]): boolean {
  const old = new Map(before.map((step) => [step.id, step]));
  if (stops(after) < stops(before)) return true;
  return after.some((step) => {
    const was = old.get(step.id);
    if (!was) return hasAutonomy(step);
    return (
      !isDeepStrictEqual(autonomy(was), autonomy(step)) ||
      (actsAlone(step) && !isDeepStrictEqual(work(was), work(step))) ||
      (was.gateBefore && !step.gateBefore) ||
      (was.gateAfter && !step.gateAfter)
    );
  });
}

export const commandClasses: { readonly [T in ServerCommand['type']]: Rule<T> } = {
  'project.create': 'ordinary',
  // The folder decides where agents work and, through its git remote, which host a project's own
  // token is sent to, so another folder waits for a yes. A name or a default does not.
  'project.update': (command, read) =>
    command.cwd !== undefined && command.cwd !== read.project(command.projectId)?.cwd
      ? proposal
      : ordinary,
  'project.delete': refused(
    'Deleting a project cannot be undone, so the user does it in Settings → Projects.',
  ),
  'setting.set': (command, read, context) =>
    settingClass(command.key, command.scope, () => command.value, read, context),
  'setting.reset': (command, read, context) =>
    settingClass(command.key, command.scope, (definition) => definition.default, read, context),
  'providerInstance.create': providersByHand,
  'providerInstance.update': providersByHand,
  'providerInstance.delete': providersByHand,
  'thread.create': chatOnly,
  'thread.sendMessage': chatOnly,
  'thread.interrupt': chatOnly,
  'thread.configure': chatOnly,
  'thread.setPinned': chatOnly,
  'thread.setDone': chatOnly,
  'approval.answer': refused("Only the user answers an agent's request for approval."),
  'question.answer': refused("Only the user answers an agent's question."),
  'card.create': (command, read, context) =>
    startsSoon(command.workflowId, command.projectId, command.start, read, context),
  'card.update': (command, read, context) => {
    const card = read.calendarItem(command.cardId);
    return startsSoon(
      afterUpdate(command.workflowId, card?.workflowId),
      afterUpdate(command.projectId, card?.projectId),
      command.start ?? card?.start,
      read,
      context,
    );
  },
  'card.delete': (command, read) => {
    const card = read.calendarItem(command.cardId);
    const run = card?.runId ? read.run(card.runId) : undefined;
    if (command.stopRun !== undefined || (run && isLiveRunState(run.state))) {
      return {
        class: 'refused',
        reason: run
          ? `The card's run is live and only the user stops a run. The run is at ${runPath(run.id)}.`
          : 'Only the user decides whether a run stops.',
      };
    }
    return ordinary;
  },
  'card.runNow': 'proposal',
  'workflow.create': (command) =>
    command.steps.some(hasAutonomy) || command.ownWorkingCopy || command.forUnits
      ? proposal
      : ordinary,
  'workflow.update': (command, read) => {
    const workflow = read.workflow(command.workflowId);
    if (!workflow) return ordinary;
    const more =
      (command.steps !== undefined && stepsAskForMore(workflow.steps, command.steps)) ||
      (command.ownWorkingCopy !== undefined &&
        command.ownWorkingCopy !== (workflow.ownWorkingCopy ?? false)) ||
      (command.forUnits !== undefined && command.forUnits !== (workflow.forUnits ?? false));
    return more ? proposal : ordinary;
  },
  'workflow.delete': 'ordinary',
  'workflow.restore': refused(
    'A deleted workflow comes back through Undo, which the user presses.',
  ),
  'workflowRun.start': 'proposal',
  'workflowRun.continue': gateAnswer,
  'workflowRun.stop': gateAnswer,
  'workflowRun.sendBack': gateAnswer,
  'backlog.create': 'ordinary',
  'backlog.update': 'ordinary',
  'backlog.delete': 'ordinary',
  'backlog.restore': refused(
    'A deleted backlog item comes back through Undo, which the user presses.',
  ),
  'backlog.plan': (command, read, context) =>
    startsSoon(command.workflowId, command.projectId, command.start, read, context),
  'plan.follow': 'ordinary',
  'planRun.start': 'proposal',
  'planRun.stop': refused('Only the user stops a plan run, on the plan in the Plans view.'),
  'trigger.create': 'proposal',
  'trigger.setEnabled': (command) => (command.enabled ? proposal : ordinary),
  'trigger.delete': 'ordinary',
  'assistant.proposal.accept': usersAnswer,
  'assistant.proposal.decline': usersAnswer,
  'assistant.undo': usersAnswer,
  'provider.events': serverOnly,
  'providerInstance.recordTest': serverOnly,
  'providerInstance.recordUpdate': serverOnly,
  'outlook.sync': serverOnly,
  'outlook.fail': serverOnly,
  'skills.sync': serverOnly,
  'plans.sync': serverOnly,
  'hosts.sync': serverOnly,
  'tickets.sync': serverOnly,
  'pages.sync': serverOnly,
  'planRun.advance': serverOnly,
  'workflowRun.stepCompleted': serverOnly,
  'workflowRun.checkGate': serverOnly,
  'workflowRun.baseRecorded': serverOnly,
  'workflowRun.stepFailed': serverOnly,
  'workflowRun.artifactsFound': serverOnly,
  'workflowRun.workingCopyReady': serverOnly,
  'workflowRun.workingCopyFailed': serverOnly,
  'workflowRun.workingCopySettled': serverOnly,
  'trigger.fire': serverOnly,
  'trigger.applyMissed': serverOnly,
  'backlog.published': serverOnly,
};

export function classOf(
  command: ServerCommand,
  read: ReadModel,
  context: DecideContext,
): Classified {
  const rule = Object.hasOwn(commandClasses, command.type)
    ? (commandClasses[command.type] as Rule<ServerCommand['type']>)
    : undefined;
  // A command the table does not name is never the assistant's to send.
  if (rule === undefined) {
    return { class: 'refused', reason: `${command.type} is not something the assistant does.` };
  }
  if (typeof rule === 'function') return rule(command, read, context);
  if (typeof rule === 'object') {
    const reason = typeof rule.refused === 'function' ? rule.refused(command) : rule.refused;
    return { class: 'refused', reason };
  }
  return { class: rule };
}

// The class of a command type when it does not depend on what the command says, for the tool
// list: a type that is always refused gets no tool.
export function alwaysRefused(type: ServerCommand['type']): boolean {
  const rule: unknown = commandClasses[type];
  return typeof rule === 'object' && rule !== null;
}
