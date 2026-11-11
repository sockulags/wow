import { Link } from '@tanstack/react-router';
import { SearchXIcon } from 'lucide-react';
import { useCalendarPrefs } from '@/calendar/prefs';
import { isoDate, localDate } from '@/calendar/time';
import { cardTitle } from '@/calendar/commands';
import { useModels, useTopic } from '@/chat/data';
import {
  contextPercent,
  formatCost,
  formatTokens,
  latestContext,
  permissionOptions,
  runLabel,
  threadTitle,
} from '@/chat/model';
import { TaskDetails } from '@/chat/task-pin';
import { stateDotClass, threadStateLabels } from '@/chat/thread-view';
import { effortLabel, providerLabel } from '@/chat/view-model';
import { PathText } from '@/components/path-text';
import { EmptyState } from '@/components/states';
import { formatWhen } from '@/lib/format';
import { runStateLabels } from '@/workflows/model';
import { FactList, PanelSection, PanelTitle, panelLinkClass } from './details';
import { threadUsage } from './model';

// The chat view's panel: the thread's setup, usage and what it belongs to. The conversation
// itself is already the main view, so it is not repeated here.
export function ThreadPanel({ threadId }: { readonly threadId: string }) {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const projects = useTopic('projects') ?? [];
  const turns = useTopic('turns', threadId) ?? [];
  const items = useTopic('threadItems', threadId) ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const cards = useTopic('calendarItems') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const { zone } = useCalendarPrefs();
  const thread = threads?.find((candidate) => candidate.id === threadId);
  const { models } = useModels(thread?.providerInstanceId);
  if (threads === undefined) return null;
  if (!thread) return <EmptyState compact icon={SearchXIcon} title="Thread not found" />;

  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const permission = instance
    ? (permissionOptions(instance.kind, thread.permissionMode).find(
        (option) => option.id === thread.permissionMode,
      )?.label ?? thread.permissionMode)
    : thread.permissionMode;
  const usage = threadUsage(turns);
  const context = latestContext(items);
  const run = thread.runId === null ? undefined : runs.find((r) => r.id === thread.runId);
  const card = run?.calendarItemId
    ? cards.find((candidate) => candidate.id === run.calendarItemId)
    : undefined;
  const item = run?.backlogItemId
    ? backlog.find((candidate) => candidate.id === run.backlogItemId)
    : undefined;
  const label = runLabel(thread, runs, workflows);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4" data-testid="panel-thread">
      <PanelTitle
        title={threadTitle(thread)}
        dot={stateDotClass[thread.state]}
        meta={`${threadStateLabels[thread.state]} · started ${formatWhen(thread.createdAt, zone)}`}
      />
      <PanelSection label="Setup">
        <FactList
          facts={[
            {
              label: 'Provider',
              value: instance ? providerLabel(instance, instances) : thread.providerInstanceId,
            },
            {
              label: 'Model',
              value:
                models.find((model) => model.id === thread.model)?.label ||
                thread.model ||
                'Default',
            },
            { label: 'Effort', value: effortLabel(thread.effort) },
            { label: 'Permissions', value: permission },
            project !== undefined && { label: 'Project', value: project.name },
            { label: 'Folder', value: <PathText path={thread.cwd} copy /> },
            thread.branch !== null && { label: 'Branch', value: thread.branch },
          ]}
        />
      </PanelSection>
      <PanelSection label="Usage">
        {usage.inputTokens + usage.outputTokens === 0 && !context ? (
          <p className="text-xs text-muted-foreground">No usage reported yet.</p>
        ) : (
          <FactList
            facts={[
              { label: 'Turns', value: usage.turns },
              { label: 'Input', value: `${formatTokens(usage.inputTokens)} tokens` },
              { label: 'Output', value: `${formatTokens(usage.outputTokens)} tokens` },
              usage.cachedInputTokens > 0 && {
                label: 'Cached',
                value: `${formatTokens(usage.cachedInputTokens)} tokens`,
              },
              usage.costUsd !== undefined && { label: 'Cost', value: formatCost(usage.costUsd) },
              context !== undefined && {
                label: 'Context',
                value: `${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)} (${contextPercent(context)}%)`,
              },
            ]}
          />
        )}
      </PanelSection>
      <PanelSection label="Tasks">
        <TaskDetails items={items} turns={turns} />
      </PanelSection>
      {(run || card || item) && (
        <PanelSection label="Belongs to">
          <FactList
            facts={[
              run !== undefined && {
                label: 'Run',
                value: (
                  <Link
                    to="/workflows/runs/$runId"
                    params={{ runId: run.id }}
                    className={panelLinkClass}
                  >
                    {label ?? 'Workflow run'} ({runStateLabels[run.state].toLowerCase()})
                  </Link>
                ),
              },
              card !== undefined && {
                label: 'Card',
                value: (
                  <Link
                    to="/calendar"
                    search={{
                      view: 'day',
                      date: isoDate(localDate(new Date(card.start), zone)),
                      item: card.id,
                    }}
                    className={panelLinkClass}
                  >
                    {cardTitle(card)}, {formatWhen(card.start, zone)}
                  </Link>
                ),
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
        </PanelSection>
      )}
    </div>
  );
}
