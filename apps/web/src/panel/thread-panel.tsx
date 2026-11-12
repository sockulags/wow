import {
  TextItemPayload,
  type HostItemRef,
  type HostLinkRules,
  type ThreadItem,
} from '@wow/contracts';
import { Link, useRouterState } from '@tanstack/react-router';
import { FileIcon, SearchXIcon } from 'lucide-react';
import { useRuntime } from '@/app/runtime';
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
import { stateDotClass, threadStateLabels } from '@/chat/thread-view';
import { effortLabel, providerLabel } from '@/chat/view-model';
import {
  hostChipText,
  hostItemIcon,
  hostItemKeyOf,
  hostItemsIn,
  readOf,
  useHostLinkRules,
} from '@/chat/host-links';
import { isFilePath } from '@/components/file-links';
import { PathText } from '@/components/path-text';
import { EmptyState } from '@/components/states';
import { formatWhen } from '@/lib/format';
import { runStateLabels } from '@/workflows/model';
import { FactList, PanelSection, PanelTitle, panelLinkClass } from './details';
import { threadUsage } from './model';
import { fullPathOf, openFile, openHostItem } from './viewer';

// What a thread's messages mention (agent workbench spec 19): the file paths (inline code, a
// relative link target, an `@` mention) and the host items (links on the thread's sites, bare
// references of its project), each once, in the order first written.
export function threadMentions(
  items: readonly ThreadItem[],
  rules: HostLinkRules,
): { readonly files: string[]; readonly links: HostItemRef[] } {
  const files = new Set<string>();
  const links = new Map<string, HostItemRef>();
  for (const item of items) {
    if (item.kind !== 'user' && item.kind !== 'assistant_text') continue;
    const payload = TextItemPayload.safeParse(item.payload);
    if (!payload.success) continue;
    const { text } = payload.data;
    for (const file of payload.data.files ?? []) files.add(file);
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const code = match[1] ?? '';
      if (isFilePath(code)) files.add(code);
    }
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? '';
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && isFilePath(target)) files.add(target);
    }
    for (const link of hostItemsIn(text, rules)) {
      const key = hostItemKeyOf(link);
      if (!links.has(key)) links.set(key, link);
    }
  }
  return { files: [...files], links: [...links.values()] };
}

const mentionClass =
  'flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';

function Mentioned({
  threadId,
  cwd,
  items,
}: {
  readonly threadId: string;
  readonly cwd: string;
  readonly items: readonly ThreadItem[];
}) {
  const { settings, layout } = useRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const rules = useHostLinkRules(threadId);
  const reads = useTopic('hostItemReads', threadId) ?? [];
  const { files, links } = threadMentions(items, rules);
  if (files.length === 0 && links.length === 0) return null;
  return (
    <PanelSection label="Mentioned">
      <ul aria-label="Mentioned" className="flex flex-col gap-0.5">
        {files.map((file) => (
          <li key={`file:${file}`}>
            <button
              type="button"
              data-testid="mentioned-file"
              className={mentionClass}
              onClick={() =>
                openFile(
                  { settings, layout },
                  {
                    scope: { threadId },
                    path: file,
                    fullPath: fullPathOf(cwd, file),
                    from: pathname,
                  },
                )
              }
            >
              <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{file}</span>
            </button>
          </li>
        ))}
        {links.map((link) => {
          const Icon = hostItemIcon(link, readOf(reads, threadId, link)?.data);
          return (
            <li key={`host:${hostItemKeyOf(link)}`}>
              <button
                type="button"
                data-testid="mentioned-link"
                title={link.url}
                className={mentionClass}
                onClick={() =>
                  openHostItem({ settings, layout }, { threadId, item: link, from: pathname })
                }
              >
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {hostChipText(link, readOf(reads, threadId, link))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </PanelSection>
  );
}

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
      {thread.kind !== 'assistant' && (
        <Mentioned threadId={thread.id} cwd={thread.cwd} items={items} />
      )}
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
