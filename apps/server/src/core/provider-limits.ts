import {
  ChatNotifications,
  type DomainEvent,
  type ProviderLimit,
  type ReportedLimit,
  type ServerCommand,
} from '@wow/contracts';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { resolvedSetting } from './workflows.js';

// Plan limits (chat overview spec 25 to 30). A report replaces the windows it names and keeps the
// others, each with when it was reported; a window that crosses `chat.limitWarnPercent` or is
// reached tells the user once per window and reset. No account detail is kept.

type LimitsCommand = Extract<ServerCommand, { type: 'providerInstance.limitsReported' }>;

export const isLimitsCommand = (command: ServerCommand): command is LimitsCommand =>
  command.type === 'providerInstance.limitsReported';

const keyOf = (limit: Pick<ProviderLimit, 'window' | 'label'>) =>
  `${limit.window}:${limit.label ?? ''}`;

// 0 below the warning, 1 at or above it, 2 reached.
function level(limit: ProviderLimit, warnAt: number): 0 | 1 | 2 {
  if (limit.state === 'reached') return 2;
  if (limit.state === 'warning' || (limit.usedPercent ?? 0) >= warnAt) return 1;
  return 0;
}

const windowWords = (limit: Pick<ProviderLimit, 'window' | 'label'>): string =>
  limit.window === 'fiveHour'
    ? '5-hour limit'
    : limit.window === 'week'
      ? 'weekly limit'
      : limit.window === 'weekModel'
        ? `weekly ${limit.label ?? 'model'} limit`
        : `${limit.label ?? 'plan'} limit`;

export function decideLimits(
  command: LimitsCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const instance = read.providerInstance(command.providerInstanceId);
  if (!instance) {
    throw new CommandRejected('not_found', `No provider instance ${command.providerInstanceId}`);
  }
  if (command.limits.length === 0) return [];
  const before = new Map(
    read.providerLimits(instance.id).map((limit) => [keyOf(limit), limit] as const),
  );
  const after = new Map(before);
  for (const limit of command.limits) {
    after.set(keyOf(limit), { ...limit, reportedAt: context.now });
  }
  const warnAt = Number(resolvedSetting('chat.limitWarnPercent', read, context, undefined));
  const notifications = ChatNotifications.safeParse(
    resolvedSetting('chat.notifications', read, context, undefined),
  );
  const tells = !notifications.success || notifications.data !== 'off';
  const told: DomainEvent[] = [];
  for (const limit of command.limits) {
    const now = level(limit, warnAt);
    const earlier = before.get(keyOf(limit));
    const sameWindow = earlier !== undefined && earlier.resetsAt === limit.resetsAt;
    if (!tells || now === 0 || (sameWindow && level(earlier, warnAt) >= now)) continue;
    const id = `limit:${instance.id}:${keyOf(limit)}:${limit.resetsAt ?? ''}:${now}`;
    const used = limit.usedPercent === null ? '' : ` at ${Math.round(limit.usedPercent)} %`;
    told.push({
      kind: 'notification.sent',
      aggregate: id,
      payload: {
        id,
        at: context.now,
        kind: 'limit',
        title:
          now === 2
            ? `${instance.name}: ${windowWords(limit)} reached`
            : `${instance.name}: ${windowWords(limit)}${used}`,
        body: 'Settings → Providers shows when it resets.',
        path: '/settings/providers',
        calendarItemId: null,
        threadId: null,
        approvalId: null,
      },
    });
  }
  const limits: ReportedLimit[] = [...after.values()];
  return [
    {
      kind: 'providerInstance.limitsReported',
      aggregate: instance.id,
      payload: { providerInstanceId: instance.id, limits },
    },
    ...told,
  ];
}
