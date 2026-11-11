import {
  isCardTrigger,
  repeatRuleWords,
  type CalendarItem,
  type CardTrigger,
  type TriggerState,
} from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { PencilIcon, PlayIcon, SearchXIcon } from 'lucide-react';
import { useRuntime, useSetting } from '@/app/runtime';
import { cardKind, cardState, cardStateLabels, timeRange } from '@/calendar/items';
import { cardTitle, runNowCardIds } from '@/calendar/commands';
import { OutlookDetails } from '@/calendar/outlook-details';
import { useCalendarPrefs } from '@/calendar/prefs';
import { formatShortDay, localDate } from '@/calendar/time';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/feedback';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runStateLabels } from '@/workflows/model';
import { FactList, PanelSection, PanelTitle, panelLinkClass } from './details';
import { cardRun } from './model';
import { RunStepThread } from './step-thread';

const stateDot: Readonly<Record<string, string>> = {
  scheduled: 'bg-muted-foreground/50',
  running: 'bg-state-working',
  waiting: 'bg-state-needs-you',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
  stopped: 'bg-muted-foreground/50',
  missed: 'bg-state-failed',
};

function triggerText(trigger: CardTrigger, zone: string): string {
  const when = formatWhen(trigger.runAt, zone);
  const text: Readonly<Record<TriggerState, string>> = {
    scheduled: `Scheduled, ${when}`,
    fired: `Fired, ${when}`,
    missed: trigger.offerRunNow ? `Missed, ${when}. Run now starts it.` : `Missed, ${when}`,
    cancelled: 'Cancelled',
  };
  return text[trigger.state];
}

const when = (item: CalendarItem, zone: string) =>
  item.allDay
    ? `${formatShortDay(localDate(new Date(item.start), zone))}, all day`
    : `${formatShortDay(localDate(new Date(item.start), zone))}, ${timeRange(item, zone)}`;

function CardPanel({ card }: { readonly card: CalendarItem }) {
  const { layout } = useRuntime();
  const dispatch = useDispatch();
  const { zone } = useCalendarPrefs();
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const triggers = useTopic('triggers') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const kind = cardKind(card);
  const state = cardState(card);
  const project = projects.find((candidate) => candidate.id === card.projectId);
  const workflow = workflows.find((candidate) => candidate.id === card.workflowId);
  const trigger = triggers
    .filter(isCardTrigger)
    .find((candidate) => candidate.calendarItemId === card.id);
  const item = backlog.find((candidate) => candidate.id === card.backlogItemId);
  const run = cardRun(card, triggers, runs);
  const runWorkflow = run
    ? workflows.find((candidate) => candidate.id === run.workflowId)
    : undefined;
  const offersRunNow = runNowCardIds([card], triggers).has(card.id);
  const runNow = () =>
    dispatch({ type: 'card.runNow', cardId: card.id, runId: globalThis.crypto.randomUUID() }).catch(
      (error: unknown) =>
        notify.error('The workflow could not start', { description: errorMessage(error) }),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="panel-card">
      <div className="max-h-[45%] shrink-0 overflow-y-auto pb-4">
        <PanelTitle
          title={cardTitle(card)}
          dot={kind === 'trigger' ? stateDot[state] : undefined}
          meta={when(card, zone)}
          actions={
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => layout.setState({ cardDialog: { type: 'edit', cardId: card.id } })}
              >
                <PencilIcon />
                Edit card
              </Button>
              {offersRunNow && (
                <Button size="xs" variant="outline" onClick={() => void runNow()}>
                  <PlayIcon />
                  Run now
                </Button>
              )}
              {run && (
                <Button asChild size="xs" variant="ghost">
                  <Link to="/workflows/runs/$runId" params={{ runId: run.id }}>
                    Open run
                  </Link>
                </Button>
              )}
            </>
          }
        />
        <PanelSection label="Details">
          <FactList
            facts={[
              kind === 'trigger' && {
                label: 'State',
                value: (
                  <span className={cn(state === 'waiting' && 'font-medium')}>
                    {cardStateLabels[state]}
                  </span>
                ),
              },
              {
                label: 'Project',
                value: project?.name ?? (
                  <span className="text-muted-foreground">
                    {kind === 'unrunnable' ? 'None, so the workflow will not run' : 'None'}
                  </span>
                ),
              },
              {
                label: 'Workflow',
                value: workflow ? (
                  <Link
                    to="/workflows/$workflowId"
                    params={{ workflowId: workflow.id }}
                    className={panelLinkClass}
                  >
                    {workflow.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">None, the card is only time</span>
                ),
              },
              card.repeat != null && {
                label: 'Repeats',
                value: repeatRuleWords(card.repeat, { start: card.start, zone: card.zone }),
              },
              trigger !== undefined && { label: 'Trigger', value: triggerText(trigger, zone) },
              run !== undefined && {
                label: 'Run',
                value: `${runWorkflow?.name ?? 'Workflow'}, ${runStateLabels[run.state].toLowerCase()}`,
              },
              item !== undefined && {
                label: 'Backlog',
                value: (
                  <Link
                    to="/backlog/$itemId"
                    params={{ itemId: item.id }}
                    className={panelLinkClass}
                  >
                    {item.title || 'Untitled item'}
                  </Link>
                ),
              },
            ]}
          />
          {card.body && (
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">{card.body}</p>
          )}
        </PanelSection>
      </div>
      {run && <RunStepThread run={run} workflow={runWorkflow} />}
    </div>
  );
}

function MeetingPanel({ item }: { readonly item: CalendarItem }) {
  const { layout } = useRuntime();
  const { zone } = useCalendarPrefs();
  const cardMinutes = useSetting('calendar.cardMinutes');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="panel-meeting">
      <OutlookDetails
        item={item}
        zone={zone}
        cardMinutes={cardMinutes}
        onNewCard={(range) => layout.setState({ cardDialog: { type: 'create', ...range } })}
      />
    </div>
  );
}

export function CalendarPanel({ itemId }: { readonly itemId: string }) {
  const items = useTopic('calendarItems');
  if (items === undefined) return null;
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return (
      <EmptyState
        compact
        icon={SearchXIcon}
        title="Not on the calendar any more"
        description="The card was deleted or the meeting is no longer in Outlook."
      />
    );
  }
  return item.source === 'local' ? (
    <CardPanel key={item.id} card={item} />
  ) : (
    <MeetingPanel key={item.id} item={item} />
  );
}

// The panel header's title for a calendar selection.
export function useCalendarPanelTitle(itemId: string): string {
  const item = useTopic('calendarItems')?.find((candidate) => candidate.id === itemId);
  if (!item) return 'Calendar';
  return item.source === 'local' ? 'Card' : 'Meeting';
}
