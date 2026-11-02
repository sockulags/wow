import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, SearchXIcon } from 'lucide-react';
import { backlogStateDotClass, backlogStateLabels, trackerNames } from '@/backlog/model';
import { timeRange } from '@/calendar/items';
import { useCalendarPrefs } from '@/calendar/prefs';
import { formatShortDay, isoDate, localDate } from '@/calendar/time';
import { useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runStateDotClass, runStateLabels, sortRuns } from '@/workflows/model';
import { FactList, PanelSection, PanelTitle, panelLinkClass } from './details';

const rowClass =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';

// A backlog item's panel: what it is, where it is planned, how its runs went and where it was
// published. Publishing itself stays in the item view.
export function BacklogPanel({ itemId }: { readonly itemId: string }) {
  const items = useTopic('backlogItems');
  const cards = useTopic('calendarItems') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const { zone } = useCalendarPrefs();
  if (items === undefined) return null;
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return <EmptyState compact icon={SearchXIcon} title="Backlog item not found" />;
  const planned = cards
    .filter((card) => card.source === 'local' && card.backlogItemId === item.id)
    .toSorted((a, b) => a.start.localeCompare(b.start));
  const own = sortRuns(
    runs.filter((run) => run.backlogItemId === item.id || run.id === item.runId),
  );
  const workflowName = (id: string | null) =>
    workflows.find((workflow) => workflow.id === id)?.name ?? 'No workflow';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4" data-testid="panel-backlog">
      <PanelTitle
        title={item.title || 'Untitled item'}
        dot={backlogStateDotClass[item.state]}
        meta={`${backlogStateLabels[item.state]} · added ${formatWhen(item.createdAt, zone)}`}
      />
      <PanelSection label="Details">
        <FactList
          facts={[
            item.tags.length > 0 && { label: 'Tags', value: item.tags.join(', ') },
            {
              label: 'Issue',
              value: item.remote ? (
                <a
                  href={item.remote.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="panel-remote"
                  className={cn(panelLinkClass, 'inline-flex items-center gap-1')}
                >
                  <ExternalLinkIcon aria-hidden className="size-3.5" />
                  {item.remote.key} in {trackerNames[item.remote.service]}
                </a>
              ) : (
                <span className="text-muted-foreground">Not published</span>
              ),
            },
          ]}
        />
      </PanelSection>
      <PanelSection label="On the calendar">
        {planned.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not planned. Plan on calendar gives it a time and a workflow.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {planned.map((card) => {
              const day = localDate(new Date(card.start), zone);
              return (
                <li key={card.id}>
                  <Link
                    to="/calendar"
                    search={{ view: 'day', date: isoDate(day), item: card.id }}
                    className={rowClass}
                    data-testid="panel-backlog-card"
                  >
                    <span className="min-w-0 flex-1 truncate tabular-nums">
                      {formatShortDay(day)}, {timeRange(card, zone)}
                    </span>
                    <span className="shrink-0 truncate text-muted-foreground">
                      {workflowName(card.workflowId)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
      <PanelSection label="Runs">
        {own.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {own.map((run) => (
              <li key={run.id}>
                <Link to="/workflows/runs/$runId" params={{ runId: run.id }} className={rowClass}>
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', runStateDotClass[run.state])}
                  />
                  <span className="min-w-0 flex-1 truncate">{workflowName(run.workflowId)}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {runStateLabels[run.state]} · {formatWhen(run.startedAt, zone)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}
