import {
  AssistantPermission,
  OutlookProfile,
  assistantPermissionLabels,
  atMinute,
  isoDate,
  localDate,
  minuteOfDay,
  parseClockTime,
  resolveCalendarPrefs,
  weekdayOf,
  type AssistantPermissionKind,
  type ServerCommand,
  type SettingDefinition,
} from '@wow/contracts';
import type { DecideContext, ReadModel } from '../core/orchestrator.js';
import { resolveStored } from '../settings/service.js';

// Which standing permission covers a command the class table holds as a proposal (chief of staff
// spec 4 to 8). Only the commands below can be covered, and only for the reason they are
// proposals: a card that starts its run soon, or a run started now. Everything else the table
// holds or refuses stays as it is, whatever permissions are stored.

export type Coverage =
  | { readonly covered: AssistantPermission }
  // A permission would cover it but may not be used now; the proposal says why.
  | { readonly held: string };

export const settingValue = (key: string, read: ReadModel, context: DecideContext): unknown => {
  const definition: SettingDefinition | undefined = Object.hasOwn(context.registry, key)
    ? context.registry[key]
    : undefined;
  if (!definition) return undefined;
  return resolveStored(key, definition, {}, (scope) => read.setting(key, scope)).value;
};

export function storedPermissions(read: ReadModel, context: DecideContext): AssistantPermission[] {
  const value = settingValue('assistant.permissions', read, context);
  const parsed = AssistantPermission.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function calendar(read: ReadModel, context: DecideContext) {
  const profile = OutlookProfile.safeParse(read.outlookStatus()?.profile);
  return resolveCalendarPrefs(
    {
      zone: settingValue('calendar.zone', read, context) as string,
      firstDayOfWeek: settingValue('calendar.firstDayOfWeek', read, context) as never,
      workHours: settingValue('calendar.workHours', read, context) as never,
    },
    profile.success ? profile.data : null,
  );
}

// Inside work hours: the start is on a work day, at or after the start of the day's hours and
// early enough that the card ends by their end.
function inWorkHours(start: string, end: string, read: ReadModel, context: DecideContext): boolean {
  const { zone, workHours } = calendar(read, context);
  const from = new Date(start);
  const day = localDate(from, zone);
  if (!workHours.days.includes(weekdayOf(day))) return false;
  const open = parseClockTime(workHours.start) ?? 0;
  const close = parseClockTime(workHours.end) ?? 24 * 60;
  const startMinute = minuteOfDay(from, zone);
  return startMinute >= open && Date.parse(end) <= atMinute(day, close, zone).getTime();
}

// The start of today in the calendar's zone, for the daily limit and the end date.
function today(read: ReadModel, context: DecideContext): { date: string; since: string } {
  const { zone } = calendar(read, context);
  const day = localDate(new Date(context.now), zone);
  return { date: isoDate(day), since: atMinute(day, 0, zone).toISOString() };
}

interface Wanted {
  readonly kind: AssistantPermissionKind;
  readonly projectId: string;
  readonly workflowId: string;
  // When the run would start and end, for planRuns' work hours.
  readonly span?: { readonly start: string; readonly end: string };
}

function wanted(command: ServerCommand, read: ReadModel): Wanted | undefined {
  switch (command.type) {
    case 'card.create':
      return command.workflowId && command.projectId
        ? {
            kind: 'planRuns',
            projectId: command.projectId,
            workflowId: command.workflowId,
            span: { start: command.start, end: command.end },
          }
        : undefined;
    case 'card.update': {
      const card = read.calendarItem(command.cardId);
      const workflowId =
        command.workflowId === undefined ? card?.workflowId : (command.workflowId ?? undefined);
      const projectId =
        command.projectId === undefined ? card?.projectId : (command.projectId ?? undefined);
      const start = command.start ?? card?.start;
      const end = command.end ?? card?.end;
      return workflowId && projectId && start && end
        ? { kind: 'planRuns', projectId, workflowId, span: { start, end } }
        : undefined;
    }
    case 'backlog.plan':
      return {
        kind: 'planRuns',
        projectId: command.projectId,
        workflowId: command.workflowId,
        span: { start: command.start, end: command.end },
      };
    case 'workflowRun.start':
      return { kind: 'startRuns', projectId: command.projectId, workflowId: command.workflowId };
    case 'card.runNow': {
      const card = read.calendarItem(command.cardId);
      return card?.workflowId && card.projectId
        ? { kind: 'startRuns', projectId: card.projectId, workflowId: card.workflowId }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function coverage(
  command: ServerCommand,
  read: ReadModel,
  context: DecideContext,
): Coverage | undefined {
  const want = wanted(command, read);
  return want ? permitFor(want, read, context) : undefined;
}

// The permission of this kind that lets the assistant act now for this project (and workflow,
// for the kinds that name workflows), or why one that would may not, or nothing.
export function permitFor(
  want: Omit<Wanted, 'workflowId'> & { readonly workflowId?: string },
  read: ReadModel,
  context: DecideContext,
): Coverage | undefined {
  if (settingValue('assistant.delegation', read, context) !== true) return undefined;
  const matching = storedPermissions(read, context).filter(
    (permission) =>
      permission.kind === want.kind &&
      permission.projectIds.includes(want.projectId) &&
      (want.workflowId === undefined || permission.workflowIds.includes(want.workflowId)),
  );
  if (matching.length === 0) return undefined;
  const label = assistantPermissionLabels[want.kind];
  if (want.span && !inWorkHours(want.span.start, want.span.end, read, context)) {
    return { held: `${label} covers work hours only, and this is outside them.` };
  }
  const { date, since } = today(read, context);
  const reasons: string[] = [];
  for (const permission of matching) {
    if (permission.paused) {
      reasons.push(`${label} is paused.`);
    } else if (permission.until !== undefined && permission.until < date) {
      reasons.push(`${label} ended on ${permission.until}.`);
    } else if (
      permission.dailyLimit !== undefined &&
      read.permissionUses(permission.id, since) >= permission.dailyLimit
    ) {
      reasons.push(`${label} was used ${permission.dailyLimit} times today, its limit.`);
    } else {
      return { covered: permission };
    }
  }
  return { held: reasons[0] ?? `${label} does not cover this.` };
}
