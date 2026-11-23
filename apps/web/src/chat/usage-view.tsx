import { localDate, startOfDay, addDays, type LocalDate } from '@wow/contracts';
import { BarChart3Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppCommand } from '@/app/commands';
import { useRuntime } from '@/app/runtime';
import { EmptyState } from '@/components/states';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { errorMessage, useTopic } from './data';
import { LimitList } from './limits';
import { formatCost, formatTokens } from './model';

// Usage (chat overview spec 39 to 41): tokens and cost per day over a range, with totals per
// project, provider instance and model, and the plan limits on top. It reads only: no budget,
// nothing is stopped. A cost the provider did not report shows as "—" and is not summed.

export const USAGE_PATH = '/chat/usage';

type Range = 'today' | 'week' | 'month30' | 'thisMonth';

const rangeTitles: Readonly<Record<Range, string>> = {
  today: 'Today',
  week: '7 days',
  month30: '30 days',
  thisMonth: 'This month',
};

interface Row {
  readonly day: string;
  readonly projectId: string | null;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly assistant: boolean;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
  readonly unknownCost: number;
  readonly noUsage: number;
}

// The first day of the range and the day after its last, in the user's zone.
export function rangeDays(range: Range, today: LocalDate): { from: LocalDate; to: LocalDate } {
  const to = addDays(today, 1);
  switch (range) {
    case 'today':
      return { from: today, to };
    case 'week':
      return { from: addDays(today, -6), to };
    case 'month30':
      return { from: addDays(today, -29), to };
    case 'thisMonth':
      return { from: { ...today, day: 1 }, to };
  }
}

interface Sum {
  readonly tokens: number;
  readonly cost: number;
  readonly unknown: number;
  readonly turns: number;
}

export function sumBy(rows: readonly Row[], key: (row: Row) => string): Map<string, Sum> {
  const sums = new Map<string, Sum>();
  for (const row of rows) {
    const before = sums.get(key(row)) ?? { tokens: 0, cost: 0, unknown: 0, turns: 0 };
    sums.set(key(row), {
      tokens: before.tokens + row.inputTokens + row.outputTokens,
      cost: before.cost + row.costUsd,
      unknown: before.unknown + row.unknownCost,
      turns: before.turns + row.turns,
    });
  }
  return sums;
}

const costText = (sum: Sum) =>
  sum.cost === 0 && sum.unknown > 0
    ? '—'
    : `${formatCost(sum.cost)}${sum.unknown > 0 ? ` + ${sum.unknown} unknown` : ''}`;

type Narrow = { readonly by: 'project' | 'instance' | 'model'; readonly value: string };

export function UsageView() {
  const { connection } = useRuntime();
  const { zone } = useDateFormat();
  const projects = useTopic('projects') ?? [];
  const instances = useTopic('providerInstances') ?? [];
  const limits = useTopic('providerLimits') ?? [];
  const [range, setRange] = useState<Range>('week');
  const [narrow, setNarrow] = useState<Narrow>();
  const [answer, setAnswer] = useState<{ rows?: readonly Row[]; error?: string }>();
  useEffect(() => {
    if (!connection) return;
    let current = true;
    const days = rangeDays(range, localDate(new Date(), zone));
    connection
      .request('usage.summary', {
        from: startOfDay(days.from, zone).toISOString(),
        to: startOfDay(days.to, zone).toISOString(),
        timeZone: zone,
      })
      .then(
        (result) => current && setAnswer({ rows: (result as { rows: Row[] }).rows }),
        (error: unknown) => current && setAnswer({ error: errorMessage(error) }),
      );
    return () => {
      current = false;
    };
  }, [connection, range, zone]);
  const projectName = (id: string | null) =>
    id === null ? 'No project' : (projects.find((project) => project.id === id)?.name ?? id);
  const instanceName = (id: string) => instances.find((instance) => instance.id === id)?.name ?? id;
  const all = answer?.rows ?? [];
  const keyOf = (row: Row, by: Narrow['by']) =>
    by === 'project'
      ? (row.projectId ?? '')
      : by === 'instance'
        ? row.providerInstanceId
        : row.model;
  const shown = narrow ? all.filter((row) => keyOf(row, narrow.by) === narrow.value) : all;
  const days = [...sumBy(shown, (row) => row.day)];
  const most = Math.max(1, ...days.map(([, sum]) => sum.tokens));
  const total = sumBy(shown, () => 'all').get('all');
  const noUsage = shown.reduce((count, row) => count + row.noUsage, 0);
  const totals = (by: Narrow['by'], name: (key: string) => string, title: string) => (
    <section aria-label={`By ${title.toLowerCase()}`} className="flex flex-col gap-1">
      <h2 className="text-xs font-medium text-muted-foreground">By {title.toLowerCase()}</h2>
      <ul className="flex flex-col gap-0.5">
        {[...sumBy(all, (row) => keyOf(row, by))].map(([key, sum]) => {
          const picked = narrow?.by === by && narrow.value === key;
          return (
            <li key={key}>
              <button
                type="button"
                data-testid={`usage-by-${by}`}
                aria-pressed={picked}
                className={cn(
                  'flex w-full justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted',
                  picked && 'bg-muted',
                )}
                onClick={() => setNarrow(picked ? undefined : { by, value: key })}
              >
                <span className="truncate">{name(key)}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatTokens(sum.tokens)} tokens · {costText(sum)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <section
      aria-label="Usage"
      data-testid="usage-view"
      className="flex h-full min-h-0 flex-col overflow-y-auto"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <BarChart3Icon aria-hidden className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Usage</h1>
        <ToggleGroup
          type="single"
          aria-label="Range"
          value={range}
          onValueChange={(value) => value !== '' && setRange(value as Range)}
          className="ml-auto"
        >
          {(Object.keys(rangeTitles) as Range[]).map((key) => (
            <ToggleGroupItem key={key} value={key} className="h-6 px-2 text-2xs">
              {rangeTitles[key]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>
      <div className="flex flex-col gap-4 p-4">
        <section aria-label="Plan limits" className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">Plan limits</h2>
          {instances.map((instance) => (
            <div key={instance.id} className="flex flex-col gap-1">
              <span className="text-xs">{instance.name}</span>
              <LimitList
                limits={limits.find((row) => row.providerInstanceId === instance.id)?.limits ?? []}
              />
            </div>
          ))}
        </section>
        {answer?.error !== undefined ? (
          <p role="alert" className="text-xs text-destructive">
            {answer.error}
          </p>
        ) : shown.length === 0 ? (
          <EmptyState
            compact
            icon={BarChart3Icon}
            title="No turns in this range"
            description="Tokens and cost show here once a turn ends."
          />
        ) : (
          <>
            {total && (
              <p data-testid="usage-total" className="text-sm tabular-nums">
                {formatTokens(total.tokens)} tokens · {costText(total)} · {total.turns}{' '}
                {total.turns === 1 ? 'turn' : 'turns'}
                {noUsage > 0 && ` (${noUsage} without usage reported)`}
              </p>
            )}
            <ol aria-label="Days" className="flex flex-col gap-1">
              {days.map(([day, sum]) => (
                <li
                  key={day}
                  data-testid="usage-day"
                  className="grid grid-cols-[6rem_1fr_auto] items-center gap-2 text-xs"
                >
                  <span className="tabular-nums">{day}</span>
                  <span aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${(sum.tokens / most) * 100}%` }}
                    />
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatTokens(sum.tokens)} · {costText(sum)}
                  </span>
                </li>
              ))}
            </ol>
            <div className="grid gap-4 md:grid-cols-3">
              {totals('project', (key) => projectName(key === '' ? null : key), 'Project')}
              {totals('instance', instanceName, 'Instance')}
              {totals('model', (key) => key, 'Model')}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export const usageCommands = (): AppCommand[] => [
  {
    id: 'chat.showUsage',
    title: 'Show usage',
    group: 'Chat',
    keywords: ['usage', 'tokens', 'cost', 'spend', 'limits'],
    run: (context) => void context.navigate({ to: USAGE_PATH }),
  },
];
