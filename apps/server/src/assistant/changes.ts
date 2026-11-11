import {
  Command,
  RepeatRule,
  SecretPattern,
  gatePartLabels,
  hideSecretsDeep,
  repeatRuleWords,
  ruleConditionText,
  secretPatterns,
  settingGroupTitles,
  settingsRegistry,
  TriggerEvent,
  triggerEventLabel,
  type AssistantChangeRecord,
  type AssistantPlace,
  type AssistantProposalRecord,
  type AssistantProposalLine,
  type AssistantTarget,
  type CalendarItem,
  type WorkflowStep,
} from '@wow/contracts';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { codeHostOf, type DecideContext, type ReadModel } from '../core/orchestrator.js';
import { triggersPath } from '../core/triggers.js';
import { resolveStored } from '../settings/service.js';

// What the server keeps about a command of the assistant: for an ordinary change, what changed,
// from what to what, where it lives and the commands that take it back (spec 7, 8); for a
// proposal, exactly what would change (spec 9, 10). Pure: everything is read from the command
// and the projections.

type Row = Record<string, unknown>;

// An event's label in the words of the project's code host.
const eventLabel = (
  event: TriggerEvent,
  projectId: string,
  read: ReadModel,
  context: DecideContext,
): string => triggerEventLabel(event, codeHostOf(read, context, projectId));

// A row's own bookkeeping, which says nothing about what the user or the assistant changed.
// A card's next fire time follows its trigger, and its past series follow its changes.
const bookkeeping: ReadonlySet<string> = new Set([
  'updatedAt',
  'nextAt',
  'pastSeries',
  'skillFolder',
  'skillFile',
]);

// The patterns of `assistant.secretPatterns` as stored, or the registry's when none is stored.
export function patternsOf(read: ReadModel, context: DecideContext): RegExp[] {
  const stored = z
    .array(SecretPattern)
    .safeParse(read.setting('assistant.secretPatterns', 'global')?.value);
  const fallback = z
    .array(z.string())
    .safeParse(context.registry['assistant.secretPatterns']?.default);
  return secretPatterns(stored.success ? stored.data : fallback.success ? fallback.data : []);
}

const settingTargetId = (key: string, scope: string) => `${key}:${scope}`;

function settingOf(id: string): { key: string; scope: string } {
  const at = id.indexOf(':');
  return { key: id.slice(0, at), scope: id.slice(at + 1) };
}

// The thing an ordinary command changes, or undefined for a command that is never ordinary.
export function targetOf(command: Command): AssistantTarget | undefined {
  switch (command.type) {
    case 'setting.set':
    case 'setting.reset':
      return { kind: 'setting', id: settingTargetId(command.key, command.scope) };
    case 'project.create':
    case 'project.update':
      return { kind: 'project', id: command.projectId };
    case 'card.create':
    case 'card.update':
    case 'card.delete':
    case 'card.skipOccurrence':
      return { kind: 'card', id: command.cardId };
    case 'backlog.create':
    case 'backlog.update':
    case 'backlog.delete':
    case 'backlog.plan':
      return { kind: 'backlogItem', id: command.backlogItemId };
    case 'workflow.create':
    case 'workflow.update':
    case 'workflow.delete':
      return { kind: 'workflow', id: command.workflowId };
    case 'plan.follow':
      return { kind: 'plan', id: command.planId };
    case 'trigger.setEnabled':
    case 'trigger.delete':
      return { kind: 'trigger', id: command.triggerId };
    case 'skill.create':
    case 'skill.update':
      return { kind: 'skill', id: command.skill.name };
    case 'skill.delete':
      return { kind: 'skill', id: command.name };
    default:
      return undefined;
  }
}

// The target as the projections hold it now, or null when it is not there. A setting is "not
// there" while nothing is stored at its scope.
export function snapshot(target: AssistantTarget, read: ReadModel): Row | null {
  const row = ((): object | undefined => {
    switch (target.kind) {
      case 'setting': {
        const { key, scope } = settingOf(target.id);
        return read.setting(key, scope);
      }
      case 'project':
        return read.project(target.id);
      case 'card':
        return read.calendarItem(target.id);
      case 'backlogItem':
        return read.backlogItem(target.id);
      case 'workflow':
        return read.workflow(target.id);
      case 'plan': {
        const plan = read.planIntents().find((intent) => intent.id === target.id);
        return plan && { followed: plan.followed, title: plan.title };
      }
      case 'trigger':
        return read.trigger(target.id);
      case 'skill':
        return ownSkillRow(read, target.id);
    }
  })();
  return row ? { ...row } : null;
}

// An own skill as a change or a proposal holds it: what the user wrote, and, kept only for an
// undo, its folder and the whole file, so a hand-written file comes back exactly.
function ownSkillRow(read: ReadModel, name: string): Row | undefined {
  const skill = read.skills().find((entry) => entry.source === 'yours' && entry.name === name);
  return (
    skill && {
      name: skill.name,
      description: skill.description,
      text: skill.text ?? '',
      ...(skill.file === undefined
        ? {}
        : { skillFolder: path.basename(skill.dir), skillFile: skill.file }),
    }
  );
}

const skillsPlace: AssistantPlace = { label: 'Settings → Skills', path: '/settings/skills' };

const VALUE_LENGTH_KEY = 'assistant.valueLength';

const valueLength = (read: ReadModel): number =>
  z
    .number()
    .catch(settingsRegistry[VALUE_LENGTH_KEY].default)
    .parse(
      resolveStored(VALUE_LENGTH_KEY, settingsRegistry[VALUE_LENGTH_KEY], {}, (scope) =>
        read.setting(VALUE_LENGTH_KEY, scope),
      ).value,
    );

const clip = (text: string, read: ReadModel): string => {
  const length = valueLength(read);
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

// A proposal line with its values shortened to what the card shows and the whole of each kept
// beside it, so nothing is accepted unseen. The secret net has run on the whole values first,
// so a value cut short cannot leave half a secret behind.
function shortened(line: AssistantProposalLine, read: ReadModel): AssistantProposalLine {
  const { what, from, to } = line;
  const next: AssistantProposalLine = {
    what,
    from: from === null ? null : clip(from, read),
    to: to === null ? null : clip(to, read),
  };
  return {
    ...next,
    ...(from !== null && next.from !== from ? { fromFull: from } : {}),
    ...(to !== null && next.to !== to ? { toFull: to } : {}),
  };
}

const stepNames = (steps: readonly WorkflowStep[]): string =>
  steps.map((step) => step.skillName).join(', ');

// One value in words. Ids of things the user named are shown by their names. A setup preview
// says its values the same way.
// A step list is not cut short: the row says every step's instance, model and effort
// (questions and models spec 15).
export const show = (key: string, value: unknown, read: ReadModel): string =>
  key === 'steps' ? showWhole(key, value, read) : clip(showWhole(key, value, read), read);

// "deliver-work (Codex at work, gpt-x, high)": what a step runs on.
function stepWords(step: WorkflowStep, read: ReadModel): string {
  const instance = read.providerInstance(step.providerInstanceId)?.name ?? step.providerInstanceId;
  return `${step.skillName} (${instance}, ${step.model ?? 'no model'}, ${step.effort ?? 'default effort'})`;
}

// The same words as `show`, not shortened: for a proposal, which keeps the whole value.
function showWhole(key: string, value: unknown, read: ReadModel): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (key === 'projectId') return read.project(value)?.name ?? value;
    if (key === 'workflowId') return read.workflow(value)?.name ?? value;
    if (key === 'backlogItemId') return read.backlogItem(value)?.title ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (key === 'steps') {
      const steps = value as WorkflowStep[];
      return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}: ${steps.map((step) => stepWords(step, read)).join(', ')}`;
    }
    if (value.every((item) => typeof item === 'string')) return value.join(', ');
  }
  if (typeof value === 'object' && 'start' in value && 'end' in value) {
    const { start, end, days } = value as { start: unknown; end: unknown; days?: unknown };
    if (typeof start === 'string' && typeof end === 'string') {
      return Array.isArray(days) ? `${start}–${end} (${days.join(', ')})` : `${start}–${end}`;
    }
  }
  return JSON.stringify(value);
}

// A card's rule is said in words with its time (recurring cards spec 18); the other fields as
// `show` says them.
function showField(row: Row, key: string, read: ReadModel): string {
  if (key === 'repeat') {
    const rule = RepeatRule.safeParse(row['repeat']);
    if (!rule.success) return 'does not repeat';
    const start = row['start'];
    const zone = row['zone'];
    return clip(
      repeatRuleWords(
        rule.data,
        typeof start === 'string' && typeof zone === 'string' ? { start, zone } : undefined,
      ),
      read,
    );
  }
  if (key === 'skippedDates' && Array.isArray(row[key]) && row[key].length === 0) return 'none';
  return show(key, row[key], read);
}

function fields(row: Row, keys: readonly string[], read: ReadModel): string {
  const [only] = keys;
  if (keys.length === 1 && only !== undefined) return showField(row, only, read);
  return keys.map((key) => `${key}: ${showField(row, key, read)}`).join('; ');
}

// The fields that say what a new or removed thing is.
const identity: Readonly<Record<AssistantTarget['kind'], readonly string[]>> = {
  setting: ['value'],
  project: ['name', 'cwd'],
  card: ['title', 'start', 'end', 'projectId', 'workflowId', 'repeat'],
  backlogItem: ['title'],
  workflow: ['name', 'steps'],
  plan: ['followed'],
  trigger: ['event', 'workflowId', 'projectId'],
  skill: ['description', 'text'],
};

function nameOf(
  target: AssistantTarget,
  row: Row,
  read: ReadModel,
  context: DecideContext,
): string {
  const text = (key: string) => String(row[key] ?? target.id);
  switch (target.kind) {
    case 'setting': {
      const { key, scope } = settingOf(target.id);
      const label = context.registry[key]?.label ?? key;
      if (scope === 'global') return label;
      const [kind, ...rest] = scope.split(':');
      const id = rest.join(':');
      const owner = kind === 'project' ? read.project(id)?.name : read.providerInstance(id)?.name;
      return `${label} (${owner ?? id})`;
    }
    case 'project':
      return `Project "${text('name')}"`;
    case 'card':
      return `Card "${text('title')}"`;
    case 'backlogItem':
      return `Backlog item "${text('title')}"`;
    case 'workflow':
      return `Workflow "${text('name')}"`;
    case 'plan':
      return `Plan "${text('title')}"`;
    case 'trigger': {
      const event = TriggerEvent.safeParse(row['event']);
      const projectId = String(row['projectId'] ?? '');
      return `Trigger "${event.success ? eventLabel(event.data, projectId, read, context) : target.id}"`;
    }
    case 'skill':
      return `Skill "${target.id}"`;
  }
}

export function settingPlace(key: string, scope: string, context: DecideContext): AssistantPlace {
  if (scope.startsWith('project:'))
    return { label: 'Settings → Projects', path: '/settings/projects' };
  if (scope.startsWith('provider:')) {
    return { label: 'Settings → Providers', path: '/settings/providers' };
  }
  const group = context.registry[key]?.group;
  return group
    ? { label: `Settings → ${settingGroupTitles[group]}`, path: `/settings/${group}` }
    : { label: 'Settings', path: '/settings' };
}

const workflowPlace = (id: string, name: string | undefined, exists: boolean): AssistantPlace =>
  exists
    ? { label: `Workflows → ${name ?? id}`, path: `/workflows/${encodeURIComponent(id)}` }
    : { label: 'Workflows', path: '/workflows' };

const cardPlace = (id: string, exists: boolean): AssistantPlace => ({
  label: 'Calendar',
  path: exists ? `/calendar?item=${encodeURIComponent(id)}` : '/calendar',
});

function placeOf(
  command: Command,
  target: AssistantTarget,
  after: Row | null,
  context: DecideContext,
): AssistantPlace {
  switch (target.kind) {
    case 'setting': {
      const { key, scope } = settingOf(target.id);
      return settingPlace(key, scope, context);
    }
    case 'project':
      return { label: 'Settings → Projects', path: '/settings/projects' };
    case 'card':
      return cardPlace(target.id, after !== null);
    case 'backlogItem':
      // "Plan on calendar" leaves a card; that is where the change is seen.
      if (command.type === 'backlog.plan') return cardPlace(command.cardId, true);
      return {
        label: 'Backlog',
        path: after ? `/backlog/${encodeURIComponent(target.id)}` : '/backlog',
      };
    case 'workflow':
      return workflowPlace(target.id, after ? String(after['name']) : undefined, after !== null);
    case 'plan': {
      const at = target.id.indexOf(':');
      const projectId = encodeURIComponent(target.id.slice(0, at));
      const intentId = encodeURIComponent(target.id.slice(at + 1));
      return { label: 'Plans', path: `/plans/${projectId}/${intentId}` };
    }
    case 'trigger':
      return { label: 'Workflows → Triggers', path: triggersPath };
    case 'skill':
      return skillsPlace;
  }
}

const changedKeys = (before: Row, after: Row): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !bookkeeping.has(key) && !isDeepStrictEqual(before[key] ?? null, after[key] ?? null),
  );

const without = (row: Row, keys: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.has(key)));

const pick = (row: Row, keys: readonly string[]): Row =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));

// The commands that take a change back, from the row as it was before. A changed row gets back
// only the fields the command named and that did change.
function inverseOf(command: Command, before: Row | null, changed: readonly string[]): Command[] {
  const named = (keys: readonly string[], fallback: Readonly<Row> = {}): Row =>
    Object.fromEntries(
      keys
        .filter((key) => key in command && changed.includes(key))
        .map((key) => [key, before?.[key] ?? fallback[key] ?? null]),
    );
  const raw = ((): unknown[] => {
    switch (command.type) {
      case 'setting.set':
      case 'setting.reset':
        return before
          ? [
              {
                type: 'setting.set',
                key: command.key,
                scope: command.scope,
                value: before['value'],
              },
            ]
          : [{ type: 'setting.reset', key: command.key, scope: command.scope }];
      case 'project.create':
        return [{ type: 'project.delete', projectId: command.projectId }];
      case 'project.update':
        return [
          {
            type: 'project.update',
            projectId: command.projectId,
            ...named(['name', 'cwd', 'defaultProviderInstanceId', 'defaultModel']),
          },
        ];
      case 'card.create':
        return [{ type: 'card.delete', cardId: command.cardId }];
      case 'card.update':
        return [
          {
            type: 'card.update',
            cardId: command.cardId,
            ...named(
              [
                'title',
                'start',
                'end',
                'zone',
                'body',
                'projectId',
                'backlogItemId',
                'workflowId',
                'repeat',
                'skippedDates',
              ],
              { skippedDates: [] },
            ),
          },
        ];
      // The day goes back into the series.
      case 'card.skipOccurrence':
        return [
          { type: 'card.update', cardId: command.cardId, skippedDates: before?.['skippedDates'] },
        ];
      // The whole series comes back, with its rule and the days skipped by hand (recurring
      // cards spec 13); what its occurrences did is still kept.
      case 'card.delete':
        return [
          {
            type: 'card.create',
            cardId: command.cardId,
            ...without(
              pick(before ?? {}, [
                'title',
                'start',
                'end',
                'zone',
                'body',
                'projectId',
                'backlogItemId',
                'workflowId',
                'repeat',
                'skippedDates',
              ]),
              new Set(
                [
                  'body',
                  'projectId',
                  'backlogItemId',
                  'workflowId',
                  'repeat',
                  'skippedDates',
                ].filter((key) => {
                  const value = before?.[key] ?? null;
                  return value === null || (Array.isArray(value) && value.length === 0);
                }),
              ),
            ),
          },
        ];
      case 'workflow.create':
        return [{ type: 'workflow.delete', workflowId: command.workflowId }];
      case 'workflow.update':
        return [
          {
            type: 'workflow.update',
            workflowId: command.workflowId,
            ...named(
              ['name', 'templateKind', 'steps', 'ownWorkingCopy', 'forUnits', 'maxStepVisits'],
              { ownWorkingCopy: false, forUnits: false },
            ),
          },
        ];
      case 'workflow.delete':
        return [{ type: 'workflow.restore', workflow: before }];
      case 'backlog.create':
        return [{ type: 'backlog.delete', backlogItemId: command.backlogItemId }];
      case 'backlog.update':
        return [
          {
            type: 'backlog.update',
            backlogItemId: command.backlogItemId,
            ...named(['title', 'body', 'tags', 'state']),
          },
        ];
      case 'backlog.delete':
        return [{ type: 'backlog.restore', item: before }];
      case 'backlog.plan':
        return [
          { type: 'card.delete', cardId: command.cardId },
          ...(changed.includes('state')
            ? [
                {
                  type: 'backlog.update',
                  backlogItemId: command.backlogItemId,
                  state: before?.['state'],
                },
              ]
            : []),
        ];
      case 'plan.follow':
        return [{ type: 'plan.follow', planId: command.planId, followed: before?.['followed'] }];
      case 'trigger.setEnabled':
        return [
          {
            type: 'trigger.setEnabled',
            triggerId: command.triggerId,
            enabled: before?.['enabled'],
          },
        ];
      case 'trigger.delete':
        return [
          {
            type: 'trigger.create',
            triggerId: command.triggerId,
            projectId: before?.['projectId'],
            event: before?.['event'],
            workflowId: before?.['workflowId'],
          },
          ...(before?.['enabled'] === false
            ? [{ type: 'trigger.setEnabled', triggerId: command.triggerId, enabled: false }]
            : []),
        ];
      case 'skill.create':
        return [{ type: 'skill.delete', name: command.skill.name }];
      // The whole skill as it was: the file itself when it is known, else every field of it.
      case 'skill.update':
      case 'skill.delete':
        return [
          typeof before?.['skillFile'] === 'string'
            ? { type: 'skill.restore', folder: before['skillFolder'], file: before['skillFile'] }
            : {
                type: command.type === 'skill.update' ? 'skill.update' : 'skill.create',
                skill: pick(before ?? {}, ['name', 'description', 'text']),
              },
        ];
      default:
        throw new Error(`${command.type} has no inverse`);
    }
  })();
  // An inverse that is not a command the views could send would be a path of its own into the
  // store; fail the change rather than keep one.
  return z.array(Command).parse(raw);
}

// The record of an ordinary change, from the target before and after it. Undefined when the
// command left the target as it was.
export function changeOf(
  id: string,
  command: Command,
  target: AssistantTarget,
  before: Row | null,
  after: Row | null,
  read: ReadModel,
  context: DecideContext,
): AssistantChangeRecord | undefined {
  if (before === null && after === null) return undefined;
  const changed = before && after ? changedKeys(before, after) : [];
  if (before && after && changed.length === 0) return undefined;
  const name = nameOf(target, after ?? before ?? {}, read, context);
  const one = changed.length === 1 && target.kind !== 'setting' && target.kind !== 'plan';
  const followed = (row: Row) => (row['followed'] ? 'followed' : 'not followed');
  const settingValue = (row: Row | null): string => {
    if (row) return show('value', row['value'], read);
    const { key } = settingOf(target.id);
    return `${show('value', context.registry[key]?.default, read)} (default)`;
  };
  const words = ((): { from: string | null; to: string | null } => {
    if (target.kind === 'setting') return { from: settingValue(before), to: settingValue(after) };
    if (target.kind === 'plan') {
      return { from: before && followed(before), to: after && followed(after) };
    }
    if (before && after) {
      return { from: fields(before, changed, read), to: fields(after, changed, read) };
    }
    const keys = identity[target.kind].filter((key) => ((after ?? before)?.[key] ?? null) !== null);
    return {
      from: before && fields(before, keys, read),
      to: after && fields(after, keys, read),
    };
  })();
  const shown = hideSecretsDeep(
    {
      what: one ? `${name}: ${changed[0]}` : name,
      ...words,
      place: placeOf(command, target, after, context),
    },
    patternsOf(read, context),
  ) as Pick<AssistantChangeRecord, 'what' | 'from' | 'to' | 'place'>;
  return {
    id,
    at: context.now,
    commandType: command.type,
    ...shown,
    target,
    expect: expectOf(before, after, changed),
    inverse: inverseOf(command, before, changed),
    state: 'applied',
    undoneAt: null,
  };
}

// What the target holds right after the change, for undoRefusal. An own skill's Undo puts its
// whole file back, so the file the change left is held too: a hand edit of any other line since
// refuses the Undo.
function expectOf(before: Row | null, after: Row | null, changed: readonly string[]): Row | null {
  if (after === null) return null;
  const held = before === null ? without(after, bookkeeping) : pick(after, changed);
  return typeof after['skillFile'] === 'string' ? { ...held, skillFile: after['skillFile'] } : held;
}

// Why a change cannot be undone any more: the thing no longer holds what the change left
// (spec 8). Undefined while it does.
export function undoRefusal(
  change: AssistantChangeRecord,
  read: ReadModel,
  context: DecideContext,
): string | undefined {
  const current = snapshot(change.target, read);
  const { expect } = change;
  const refusal = ((): string | undefined => {
    if (expect === null) return current === null ? undefined : 'it is there again';
    if (current === null) {
      return change.target.kind === 'setting' ? 'it was reset since' : 'it is no longer there';
    }
    const moved = Object.keys(expect).filter(
      (key) => !isDeepStrictEqual(current[key] ?? null, expect[key] ?? null),
    );
    if (moved.length === 0) return undefined;
    const now = moved.map((key) =>
      key === 'value'
        ? `it is now ${show(key, current[key], read)}`
        : key === 'skillFile'
          ? 'its SKILL.md is not the file this change left'
          : `${key} is now ${show(key, current[key], read)}`,
    );
    return `it changed again since (${now.join('; ')})`;
  })();
  if (refusal === undefined) return undefined;
  return String(
    hideSecretsDeep(`${change.what} cannot be undone: ${refusal}.`, patternsOf(read, context)),
  );
}

const stepFieldLabels: Readonly<Record<string, string>> = {
  skillName: 'skill',
  providerInstanceId: 'provider',
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission mode',
  gateBefore: 'gate before',
  gateAfter: 'gate after',
  gateAfterCondition: 'gate passes by itself when',
  extraPrompt: 'extra prompt',
  expectedArtifacts: 'expected artifacts',
  rules: 'rules',
  skillSource: 'skill from',
  alsoFollow: 'also follows',
  leaveOut: 'leaves out',
};

function showStepField(
  key: string,
  value: unknown,
  steps: readonly WorkflowStep[],
  read: ReadModel,
): string {
  const step = { [key]: value } as Partial<WorkflowStep>;
  if (key === 'gateBefore' || key === 'gateAfter') return value ? 'stops' : 'does not stop';
  if (key === 'permissionMode') return step.permissionMode ?? "the provider's default";
  if (key === 'gateAfterCondition') {
    return step.gateAfterCondition?.length
      ? step.gateAfterCondition.map((part) => gatePartLabels[part]).join(', ')
      : 'never; it waits for you';
  }
  if (key === 'rules') {
    if (!step.rules?.length) return 'none';
    const name = (stepId: string) => {
      const at = steps.findIndex((other) => other.id === stepId);
      return at < 0 ? stepId : `step ${at + 1} (${steps[at]?.skillName})`;
    };
    return step.rules
      .map(
        ({ when, goTo }) =>
          `${ruleConditionText(when)} → ${goTo.type === 'end' ? 'the end' : name(goTo.stepId)}`,
      )
      .join('; ');
  }
  if (key === 'skillSource') return step.skillSource ?? 'a skill folder';
  if (key === 'alsoFollow') {
    return step.alsoFollow?.length
      ? step.alsoFollow.map((skill) => skill.name).join(', ')
      : 'nothing';
  }
  if (key === 'leaveOut') return step.leaveOut?.length ? step.leaveOut.join(', ') : 'nothing';
  if (key === 'providerInstanceId' && typeof value === 'string') {
    return read.providerInstance(value)?.name ?? value;
  }
  return showWhole(key, value, read);
}

const order = (steps: readonly WorkflowStep[], ids: ReadonlySet<string>) =>
  steps.filter((step) => ids.has(step.id)).map((step) => step.id);

// One line per thing that differs between two step lists, so a proposal says exactly what a
// workflow would do differently.
function stepLines(
  before: readonly WorkflowStep[],
  after: readonly WorkflowStep[],
  read: ReadModel,
): AssistantProposalLine[] {
  const old = new Map(before.map((step) => [step.id, step]));
  const kept = new Set(after.map((step) => step.id));
  const lines: AssistantProposalLine[] = [];
  after.forEach((step, index) => {
    const label = `Step ${index + 1} (${step.skillName})`;
    const was = old.get(step.id);
    const fresh: Row = { ...step };
    const stale: Row = was ? { ...was } : {};
    if (!was) lines.push({ what: label, from: null, to: 'new step' });
    for (const key of Object.keys(stepFieldLabels)) {
      // A new step says its skill in its own line already.
      if (!was && (key === 'skillName' || (fresh[key] ?? null) === null)) continue;
      if (was && isDeepStrictEqual(stale[key] ?? null, fresh[key] ?? null)) continue;
      lines.push({
        what: `${label} ${stepFieldLabels[key]}`,
        from: was ? showStepField(key, stale[key], before, read) : null,
        to: showStepField(key, fresh[key], after, read),
      });
    }
  });
  for (const step of before) {
    if (!kept.has(step.id)) {
      lines.push({ what: `Step (${step.skillName})`, from: 'in the workflow', to: null });
    }
  }
  if (!isDeepStrictEqual(order(before, kept), order(after, new Set(old.keys())))) {
    lines.push({ what: 'Step order', from: stepNames(before), to: stepNames(after) });
  }
  return lines;
}

const whole = (row: object | undefined): Row | null =>
  row ? without({ ...row }, bookkeeping) : null;

// The state a proposal's title and lines are written from, under the words a refusal names it
// by. A yes is for what the card said (spec 9, 10), so an accept is refused once this no longer
// holds: the assistant cannot point a pending yes somewhere else with an ordinary change, and a
// held step list does not overwrite what the user changed by hand since. A start holds the
// whole workflow, because the yes is for starting it as it was.
export function basisOf(command: Command, read: ReadModel): Row {
  const workflow = (id: string | null | undefined) => whole(id ? read.workflow(id) : undefined);
  const project = (id: string | null | undefined) =>
    (id ? read.project(id)?.name : undefined) ?? null;
  const basis = ((): Row => {
    switch (command.type) {
      case 'setting.set':
      case 'setting.reset': {
        const stored = read.setting(command.key, command.scope);
        return { setting: stored ? { value: stored.value } : null };
      }
      case 'workflow.update':
        return { workflow: workflow(command.workflowId) };
      case 'workflowRun.start':
        return {
          workflow: workflow(command.workflowId),
          project: project(command.projectId),
          'backlog item':
            (command.backlogItemId ? read.backlogItem(command.backlogItemId)?.title : null) ?? null,
        };
      case 'card.runNow': {
        const card = read.calendarItem(command.cardId);
        return {
          card: card
            ? pick({ ...card }, ['title', 'workflowId', 'projectId', 'backlogItemId'])
            : null,
          workflow: workflow(card?.workflowId),
          project: project(card?.projectId),
        };
      }
      case 'planRun.start': {
        const plan = read.planIntents().find((intent) => intent.id === command.planId);
        return {
          plan: plan ? { title: plan.title, projectId: plan.projectId } : null,
          workflow: workflow(command.workflowId),
          project: project(plan?.projectId),
        };
      }
      // The yes is for this project as it is: its folder is where agents work.
      case 'project.update': {
        const current = read.project(command.projectId);
        return {
          project: current
            ? pick({ ...current }, ['name', 'cwd', 'defaultProviderInstanceId', 'defaultModel'])
            : null,
        };
      }
      // A card that starts a run at once: the yes is for this workflow in this project.
      case 'card.create':
      case 'backlog.plan':
        return { workflow: workflow(command.workflowId), project: project(command.projectId) };
      case 'card.update': {
        const card = read.calendarItem(command.cardId);
        const workflowId = command.workflowId === undefined ? card?.workflowId : command.workflowId;
        const projectId = command.projectId === undefined ? card?.projectId : command.projectId;
        return {
          card: card
            ? pick({ ...card }, [
                'title',
                'start',
                'workflowId',
                'projectId',
                'backlogItemId',
                'repeat',
              ])
            : null,
          workflow: workflow(workflowId),
          project: project(projectId),
        };
      }
      case 'trigger.create':
        return {
          workflow: read.workflow(command.workflowId)?.name ?? null,
          project: project(command.projectId),
        };
      case 'trigger.setEnabled': {
        const trigger = read.trigger(command.triggerId);
        return {
          trigger: trigger
            ? pick({ ...trigger }, ['event', 'workflowId', 'projectId', 'enabled'])
            : null,
          workflow: (trigger?.workflowId ? read.workflow(trigger.workflowId)?.name : null) ?? null,
          project: project(trigger?.projectId),
        };
      }
      // The yes is for the skill as it is: one written since by hand or in Settings asks again.
      case 'skill.create':
      case 'skill.update':
        return { skill: ownSkillRow(read, command.skill.name) ?? null };
      case 'skill.delete':
        return { skill: ownSkillRow(read, command.name) ?? null };
      default:
        return {};
    }
  })();
  // As it reads back from its column, so the two compare.
  return JSON.parse(JSON.stringify(basis)) as Row;
}

// Why a proposal cannot be accepted any more: what it was shown for changed since. Undefined
// while it holds.
export function acceptRefusal(
  proposal: AssistantProposalRecord,
  read: ReadModel,
): string | undefined {
  const now = basisOf(proposal.command, read);
  const was = proposal.basis ?? {};
  const moved =
    proposal.basis === null
      ? ['state']
      : Object.keys(now).filter((key) => !isDeepStrictEqual(now[key], was[key] ?? null));
  if (moved.length === 0) return undefined;
  return `"${proposal.title}" was proposed for how things were then, and the ${moved.join(' and the ')} changed since. Say No to it and ask again.`;
}

const onOff = (value: boolean | undefined): string => (value ? 'on' : 'off');

// The rule of a card a held update would leave, in words, when the update touches it or the
// card repeats.
function repeatLines(
  card: CalendarItem | undefined,
  command: Extract<Command, { type: 'card.update' }>,
): AssistantProposalLine[] {
  const was = card?.repeat ?? null;
  const next = command.repeat === undefined ? was : command.repeat;
  if (was === null && next === null) return [];
  const start = command.start ?? card?.start;
  const zone = command.zone ?? card?.zone;
  const words = (rule: RepeatRule | null, at: string | undefined) =>
    rule === null
      ? 'does not repeat'
      : repeatRuleWords(rule, at && zone ? { start: at, zone } : undefined);
  const from = words(was, card?.start);
  const to = words(next, start);
  return from === to ? [{ what: 'Repeats', from: null, to }] : [{ what: 'Repeats', from, to }];
}

// What a held command would change, in the words the proposal card shows. The command has
// already passed the app's own checks, so what it names exists.
export function proposalOf(
  id: string,
  command: Command,
  read: ReadModel,
  context: DecideContext,
): AssistantProposalRecord {
  const workflowName = (workflowId: string) => read.workflow(workflowId)?.name ?? workflowId;
  const projectName = (projectId: string) => read.project(projectId)?.name ?? projectId;
  const card = ((): Pick<AssistantProposalRecord, 'title' | 'lines' | 'place'> => {
    switch (command.type) {
      case 'setting.set':
      case 'setting.reset': {
        const definition = context.registry[command.key];
        const stored = read.setting(command.key, command.scope);
        const next = command.type === 'setting.set' ? command.value : definition?.default;
        const label = definition?.label ?? command.key;
        return {
          title: `Change ${label}`,
          lines: [
            {
              what: label,
              from: showWhole('value', stored ? stored.value : definition?.default, read),
              to: showWhole('value', next, read),
            },
          ],
          place: settingPlace(command.key, command.scope, context),
        };
      }
      case 'workflow.create':
        return {
          title: `Create workflow "${command.name}"`,
          lines: [
            ...stepLines([], command.steps, read),
            ...(command.forUnits ? [{ what: 'For units', from: null, to: 'on' }] : []),
            ...(command.ownWorkingCopy ? [{ what: 'Own working copy', from: null, to: 'on' }] : []),
          ],
          place: { label: 'Workflows', path: '/workflows' },
        };
      case 'workflow.update': {
        const workflow = read.workflow(command.workflowId);
        const lines: AssistantProposalLine[] = [];
        if (command.name !== undefined && command.name !== workflow?.name) {
          lines.push({ what: 'Name', from: workflow?.name ?? null, to: command.name });
        }
        if (command.steps) lines.push(...stepLines(workflow?.steps ?? [], command.steps, read));
        const switches = [
          ['For units', workflow?.forUnits, command.forUnits],
          ['Own working copy', workflow?.ownWorkingCopy, command.ownWorkingCopy],
        ] as const;
        for (const [what, was, next] of switches) {
          if (next !== undefined && next !== (was ?? false)) {
            lines.push({ what, from: onOff(was), to: onOff(next) });
          }
        }
        if (
          command.maxStepVisits !== undefined &&
          command.maxStepVisits !== (workflow?.maxStepVisits ?? null)
        ) {
          lines.push({
            what: 'Most starts of one step',
            from: showWhole('maxStepVisits', workflow?.maxStepVisits, read),
            to: showWhole('maxStepVisits', command.maxStepVisits, read),
          });
        }
        if (
          command.templateKind !== undefined &&
          command.templateKind !== (workflow?.templateKind ?? null)
        ) {
          lines.push({
            what: 'Template kind',
            from: showWhole('templateKind', workflow?.templateKind, read),
            to: showWhole('templateKind', command.templateKind, read),
          });
        }
        return {
          title: `Change workflow "${workflow?.name ?? command.workflowId}"`,
          lines,
          place: workflowPlace(command.workflowId, workflow?.name, true),
        };
      }
      case 'workflowRun.start': {
        const item = command.backlogItemId ? read.backlogItem(command.backlogItemId) : undefined;
        return {
          title: `Start ${workflowName(command.workflowId)} in ${projectName(command.projectId)}`,
          lines: item ? [{ what: 'Backlog item', from: null, to: item.title }] : [],
          place: workflowPlace(command.workflowId, workflowName(command.workflowId), true),
        };
      }
      case 'card.runNow': {
        const item = read.calendarItem(command.cardId);
        return {
          title: `Start ${workflowName(item?.workflowId ?? '')} in ${projectName(item?.projectId ?? '')}`,
          lines: [{ what: 'Card', from: null, to: item?.title ?? command.cardId }],
          place: cardPlace(command.cardId, true),
        };
      }
      case 'planRun.start': {
        const plan = read.planIntents().find((intent) => intent.id === command.planId);
        return {
          title: `Run the ready units of "${plan?.title ?? command.planId}" with ${workflowName(command.workflowId)}`,
          lines: [
            {
              what: 'Project',
              from: null,
              to: plan ? projectName(plan.projectId) : command.planId,
            },
          ],
          place: placeOf(command, { kind: 'plan', id: command.planId }, {}, context),
        };
      }
      case 'trigger.create':
        return {
          title: `New event trigger in ${projectName(command.projectId)}`,
          lines: [
            {
              what: `When "${eventLabel(command.event, command.projectId, read, context)}"`,
              from: null,
              to: `start ${workflowName(command.workflowId)}`,
            },
          ],
          place: { label: 'Workflows → Triggers', path: triggersPath },
        };
      case 'trigger.setEnabled': {
        const trigger = read.trigger(command.triggerId);
        const event = trigger?.event
          ? eventLabel(trigger.event, trigger.projectId ?? '', read, context)
          : command.triggerId;
        return {
          title: `Turn on the trigger "${event}"`,
          lines: [
            {
              what: `Start ${workflowName(trigger?.workflowId ?? '')} in ${projectName(trigger?.projectId ?? '')}`,
              from: onOff(trigger?.enabled ?? false),
              to: onOff(command.enabled),
            },
          ],
          place: { label: 'Workflows → Triggers', path: triggersPath },
        };
      }
      case 'project.update': {
        const current = read.project(command.projectId);
        return {
          title: `Move project "${current?.name ?? command.projectId}" to another folder`,
          lines: [
            { what: 'Folder', from: current?.cwd ?? null, to: command.cwd ?? null },
            ...(command.name !== undefined && command.name !== current?.name
              ? [{ what: 'Name', from: current?.name ?? null, to: command.name }]
              : []),
          ],
          place: { label: 'Settings → Projects', path: '/settings/projects' },
        };
      }
      case 'card.create':
      case 'backlog.plan': {
        const title =
          command.type === 'card.create'
            ? command.title
            : (read.backlogItem(command.backlogItemId)?.title ?? command.backlogItemId);
        const rule = command.type === 'card.create' ? command.repeat : undefined;
        const lines: AssistantProposalLine[] = [{ what: 'Card', from: null, to: title }];
        if (rule) {
          lines.push({
            what: 'Repeats',
            from: null,
            to: repeatRuleWords(rule, { start: command.start, zone: command.zone }),
          });
        }
        return {
          title: rule
            ? `Start ${workflowName(command.workflowId ?? '')} in ${projectName(command.projectId ?? '')} from a repeating card, first at ${command.start}`
            : `Start ${workflowName(command.workflowId ?? '')} in ${projectName(command.projectId ?? '')} from a card at ${command.start}`,
          lines,
          place: cardPlace(command.cardId, false),
        };
      }
      case 'card.update': {
        const moved = read.calendarItem(command.cardId);
        const workflowId =
          (command.workflowId === undefined ? moved?.workflowId : command.workflowId) ?? '';
        const projectId =
          (command.projectId === undefined ? moved?.projectId : command.projectId) ?? '';
        const start = command.start ?? moved?.start ?? '';
        return {
          title: `Start ${workflowName(workflowId)} in ${projectName(projectId)} from a card at ${start}`,
          lines: [
            { what: 'Card', from: null, to: command.title ?? moved?.title ?? command.cardId },
            ...(command.start !== undefined && command.start !== moved?.start
              ? [{ what: 'Starts', from: moved?.start ?? null, to: command.start }]
              : []),
            ...repeatLines(moved, command),
          ],
          place: cardPlace(command.cardId, moved !== undefined),
        };
      }
      // The whole text is kept with the line (spec 22): the card shows the start and the rest on
      // request.
      case 'skill.create': {
        const { name, description, text } = command.skill;
        return {
          title: `Write the skill "${name}"`,
          lines: [
            { what: 'When to use it', from: null, to: showWhole('description', description, read) },
            { what: 'Text', from: null, to: text.trim() },
          ],
          place: skillsPlace,
        };
      }
      case 'skill.update': {
        const was = ownSkillRow(read, command.skill.name);
        const lines: AssistantProposalLine[] = [];
        const description = command.skill.description.trim();
        if (description !== was?.['description']) {
          lines.push({
            what: 'When to use it',
            from: showWhole('description', was?.['description'], read),
            to: showWhole('description', description, read),
          });
        }
        if (command.skill.text.trim() !== was?.['text']) {
          lines.push({
            what: 'Text',
            from: String(was?.['text'] ?? ''),
            to: command.skill.text.trim(),
          });
        }
        return {
          title: `Change your skill "${command.skill.name}"`,
          lines,
          place: skillsPlace,
        };
      }
      case 'skill.delete': {
        const was = ownSkillRow(read, command.name);
        return {
          title: `Remove your skill "${command.name}"`,
          lines: [{ what: 'Text', from: String(was?.['text'] ?? ''), to: null }],
          place: skillsPlace,
        };
      }
      default:
        throw new Error(`${command.type} cannot be proposed`);
    }
  })();
  const hidden = hideSecretsDeep(card, patternsOf(read, context)) as typeof card;
  const shown = { ...hidden, lines: hidden.lines.map((line) => shortened(line, read)) };
  return {
    id,
    at: context.now,
    commandType: command.type,
    ...shown,
    command,
    basis: basisOf(command, read),
    state: 'pending',
    answeredAt: null,
    reason: null,
  };
}
