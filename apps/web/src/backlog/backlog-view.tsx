import type { BacklogItem, BacklogState, TrackerService } from '@wow/contracts';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import {
  CalendarPlusIcon,
  ListTodoIcon,
  PlusIcon,
  SearchXIcon,
  SendIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useConnectionState } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { useCalendarPrefs } from '@/calendar/prefs';
import { isoDate, localDate } from '@/calendar/time';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { FormField } from '@/components/form-field';
import { WithTooltip } from '@/components/hint';
import { DisconnectedState, EmptyState, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { offerUndo } from '@/lib/feedback';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runStateLabels } from '@/workflows/model';
import { MarkdownPreview } from './markdown';
import {
  allTags,
  automaticStateHelp,
  backlogStateDotClass,
  backlogStateLabels,
  backlogStates,
  emptyFilter,
  filterItems,
  isManualState,
  manualStates,
  runProblem,
  sortItems,
  type BacklogFilter,
} from './model';
import { PlanDialog } from './plan-dialog';
import { PublishDialog, RemoteLink } from './publish-dialog';
import { TagInput } from './tag-input';

// Which dialog the item view shows; the URL holds it so palette commands can open one.
export type BacklogDialog = 'plan' | TrackerService;

export const validateBacklogItemSearch = (
  search: Record<string, unknown>,
): { dialog?: BacklogDialog } =>
  search['dialog'] === 'plan' || search['dialog'] === 'jira' || search['dialog'] === 'github'
    ? { dialog: search['dialog'] }
    : {};

function StateDot({ state, className }: { state: BacklogState; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', backlogStateDotClass[state], className)}
    />
  );
}

function Filters({
  filter,
  tags,
  onChange,
}: {
  filter: BacklogFilter;
  tags: readonly string[];
  onChange: (filter: BacklogFilter) => void;
}) {
  return (
    <div role="search" aria-label="Filter backlog" className="grid gap-1.5 px-2 pb-2">
      <Input
        aria-label="Search backlog"
        placeholder="Search"
        className="h-8"
        value={filter.text}
        onChange={(event) => onChange({ ...filter, text: event.target.value })}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <ChoiceSelect
          label="Filter by state"
          size="sm"
          value={filter.state}
          choices={[
            { value: 'open', label: 'Open' },
            { value: '', label: 'All states' },
            ...backlogStates.map((state) => ({ value: state, label: backlogStateLabels[state] })),
          ]}
          onValueChange={(state) => onChange({ ...filter, state: state as BacklogFilter['state'] })}
        />
        <ChoiceSelect
          label="Filter by tag"
          size="sm"
          value={filter.tag}
          choices={[
            { value: '', label: 'All tags' },
            ...tags.map((tag) => ({ value: tag, label: tag })),
          ]}
          onValueChange={(tag) => onChange({ ...filter, tag })}
        />
      </div>
    </div>
  );
}

function BacklogList() {
  const { rows, status } = useTopicState('backlogItems');
  const items = rows ?? [];
  const [filter, setFilter] = useState<BacklogFilter>(emptyFilter);
  const shown = sortItems(filterItems(items, filter));
  return (
    <nav
      aria-label="Backlog"
      className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar/50"
    >
      <div className="flex h-10 shrink-0 items-center px-2">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/backlog/new">
            <PlusIcon />
            New item
          </Link>
        </Button>
      </div>
      <Filters filter={filter} tags={allTags(items)} onChange={setFilter} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows === undefined ? (
          <TopicPlaceholder status={status} compact rows={4} />
        ) : (
          <>
            <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
              Items<span className="ml-1 tabular-nums opacity-70">{shown.length}</span>
            </h3>
            <ul aria-label="Backlog items" className="flex flex-col gap-0.5">
              {shown.map((item) => (
                <li key={item.id} data-testid="backlog-item">
                  <Link
                    to="/backlog/$itemId"
                    params={{ itemId: item.id }}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
                    activeProps={{ className: 'bg-sidebar-accent', 'aria-current': 'page' }}
                  >
                    <span className="flex items-start gap-2">
                      <WithTooltip label={backlogStateLabels[item.state]}>
                        <span className="mt-1.5 flex">
                          <StateDot state={item.state} />
                        </span>
                      </WithTooltip>
                      <span className="sr-only" data-testid="backlog-item-state">
                        {backlogStateLabels[item.state]}
                      </span>
                      <span className="line-clamp-2 min-w-0 flex-1">{item.title}</span>
                    </span>
                    {(item.tags.length > 0 || item.remote) && (
                      <span className="truncate pl-3.5 text-2xs text-muted-foreground">
                        {[item.remote?.key, ...item.tags].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            {items.length === 0 ? (
              <EmptyState
                compact
                icon={ListTodoIcon}
                title="Backlog is empty"
                description="Ideas that are not tickets yet."
              />
            ) : (
              shown.length === 0 && (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No item matches the filter.
                </p>
              )
            )}
          </>
        )}
      </div>
    </nav>
  );
}

export function BacklogLayout() {
  const { configured } = useConnectionState();
  if (!configured) return <DisconnectedState offline />;
  return (
    <div className="flex h-full min-h-0">
      <BacklogList />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export function BacklogHome() {
  const items = useTopic('backlogItems');
  const any = items !== undefined && items.length > 0;
  return (
    <EmptyState
      icon={ListTodoIcon}
      title={any ? 'Pick an item' : 'Backlog is empty'}
      description="Ideas that are not tickets yet. Give one a workflow and a time with Plan on calendar, or publish it to Jira or GitHub. Nothing leaves wow until you do."
      action={
        <Button asChild size="sm">
          <Link to="/backlog/new">
            <PlusIcon />
            New item
          </Link>
        </Button>
      }
    />
  );
}

// Markdown with a Write / Preview switch (audit D-12).
function BodyField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (body: string) => void;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm leading-none font-medium">
          Body (markdown)
        </label>
        <div role="tablist" aria-label="Body view" className="ml-auto flex gap-0.5">
          {(['write', 'preview'] as const).map((tab) => (
            <Button
              key={tab}
              type="button"
              role="tab"
              size="xs"
              variant={mode === tab ? 'secondary' : 'ghost'}
              aria-selected={mode === tab}
              onClick={() => setMode(tab)}
            >
              {tab === 'write' ? 'Write' : 'Preview'}
            </Button>
          ))}
        </div>
      </div>
      {mode === 'write' ? (
        <Textarea
          id={id}
          className="min-h-48 font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div
          role="tabpanel"
          className="min-h-48 rounded-md border border-border bg-muted/30 px-3 py-2"
        >
          <MarkdownPreview markdown={value} />
        </div>
      )}
    </div>
  );
}

export function NewItemView() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const items = useTopic('backlogItems') ?? [];
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return setError('Give the item a title');
    const backlogItemId = globalThis.crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    try {
      await dispatch({ type: 'backlog.create', backlogItemId, title: trimmed, body, tags });
      void navigate({ to: '/backlog/$itemId', params: { itemId: backlogItemId } });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="New backlog item"
      onSubmit={(event) => void submit(event)}
      className="mx-auto flex max-w-3xl flex-col gap-4 p-6"
    >
      <h2 className="text-base font-semibold">New backlog item</h2>
      <FormField id="backlog-title" label="Title" error={error}>
        <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </FormField>
      <BodyField id="backlog-body" value={body} onChange={setBody} />
      <FormField id="backlog-tags" label="Tags">
        <TagInput tags={tags} suggestions={allTags(items)} onChange={setTags} />
      </FormField>
      <p className="text-xs text-muted-foreground">The item stays in wow; nothing is sent.</p>
      <div className="flex justify-end gap-2">
        <Button asChild type="button" variant="outline">
          <Link to="/backlog">Cancel</Link>
        </Button>
        <Button type="submit" disabled={busy || title.trim() === ''}>
          Add item
        </Button>
      </div>
    </form>
  );
}

function PlanStatus({ item }: { item: BacklogItem }) {
  const cards = (useTopic('calendarItems') ?? []).filter(
    (card) => card.source === 'local' && card.backlogItemId === item.id,
  );
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const { zone } = useCalendarPrefs();
  const run = runs.find((candidate) => candidate.id === item.runId);
  const problem = runProblem(run);
  if (cards.length === 0 && !run && !item.remote) return null;
  const workflowName = (id: string | null) =>
    workflows.find((workflow) => workflow.id === id)?.name ?? 'no workflow';
  const linkClass =
    'rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <section
      aria-label="Plan and publishing"
      className="grid gap-1.5 rounded-md border border-border bg-card p-3 text-xs"
    >
      {cards.map((card) => {
        const date = isoDate(localDate(new Date(card.start), zone));
        return (
          <p key={card.id} data-testid="backlog-card" className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">On the calendar:</span>
            <Link to="/calendar" search={{ view: 'day', date }} className={linkClass}>
              {formatWhen(card.start, zone)}
            </Link>
            <span className="text-muted-foreground">with {workflowName(card.workflowId)}</span>
          </p>
        );
      })}
      {run && (
        <p data-testid="backlog-run" className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Last run:</span>
          <Link to="/workflows/runs/$runId" params={{ runId: run.id }} className={linkClass}>
            {workflowName(run.workflowId)} ({runStateLabels[run.state].toLowerCase()})
          </Link>
        </p>
      )}
      {problem && (
        <p role="alert" data-testid="backlog-run-problem" className="text-destructive">
          {problem}
        </p>
      )}
      {item.remote && (
        <p data-testid="backlog-remote" className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            Published to {item.remote.service === 'jira' ? 'Jira' : 'GitHub'} as {item.remote.key}:
          </span>
          <RemoteLink remote={item.remote} />
        </p>
      )}
    </section>
  );
}

interface Changes {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly state?: BacklogState;
}

// The title is edited in the heading itself (audit D-11): a text box styled as the heading.
function TitleField({ value, onChange }: { value: string; onChange: (title: string) => void }) {
  return (
    <input
      aria-label="Title"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-base font-semibold text-foreground outline-none hover:border-input focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    />
  );
}

// Edits are kept as changes over the server's row, so a field the user has not touched follows
// the server (for example the state while the item's run moves on). Ctrl+S saves.
function ItemEditor({ item, items }: { item: BacklogItem; items: readonly BacklogItem[] }) {
  const dispatch = useDispatch();
  const [changes, setChanges] = useState<Changes>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const title = changes.title ?? item.title;
  const body = changes.body ?? item.body;
  const tags = changes.tags ?? item.tags;
  const state = changes.state ?? item.state;
  const dirty = Object.keys(changes).length > 0;
  const change = (next: Changes) => setChanges((current) => ({ ...current, ...next }));

  const save = async () => {
    const trimmed = title.trim();
    if (trimmed === '') return setError('Give the item a title');
    if (!dirty) return;
    setBusy(true);
    setError(undefined);
    try {
      await dispatch({
        type: 'backlog.update',
        backlogItemId: item.id,
        ...(changes.title === undefined ? {} : { title: trimmed }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.tags === undefined ? {} : { tags: [...changes.tags] }),
        ...(changes.state === undefined ? {} : { state: changes.state }),
      });
      setChanges({});
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form
      aria-label="Backlog item"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="grid gap-4"
    >
      <div className="flex items-center gap-2">
        <StateDot state={state} className="size-2" />
        <TitleField value={title} onChange={(next) => change({ title: next })} />
      </div>
      <BodyField id="backlog-body" value={body} onChange={(next) => change({ body: next })} />
      <div className="grid grid-cols-[1fr_12rem] gap-4">
        <FormField id="backlog-tags" label="Tags">
          <TagInput
            tags={tags}
            suggestions={allTags(items)}
            onChange={(next) => change({ tags: next })}
          />
        </FormField>
        <FormField
          id="backlog-state"
          label="State"
          help={isManualState(state) ? undefined : automaticStateHelp[state]}
        >
          {isManualState(item.state) ? (
            <ChoiceSelect
              value={state}
              choices={manualStates.map((candidate) => ({
                value: candidate,
                label: backlogStateLabels[candidate],
              }))}
              onValueChange={(next) => change({ state: next as BacklogState })}
            />
          ) : (
            <p data-testid="backlog-state-readonly" className="flex h-9 items-center gap-2 text-sm">
              <StateDot state={state} />
              {backlogStateLabels[state]}
            </p>
          )}
        </FormField>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button type="button" variant="outline" onClick={() => setChanges({})}>
            Discard
          </Button>
        )}
        <WithTooltip label="Save" binding="Mod+S">
          <Button type="submit" disabled={!dirty || busy}>
            Save
          </Button>
        </WithTooltip>
      </div>
    </form>
  );
}

export function ItemView({
  itemId,
  dialog,
}: {
  itemId: string;
  dialog: BacklogDialog | undefined;
}) {
  const items = useTopic('backlogItems');
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const item = items?.find((candidate) => candidate.id === itemId);
  useEffect(() => setError(undefined), [itemId]);
  if (!items) return null;
  if (!item) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="No such item"
        description="It may have been deleted."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/backlog">Back to the backlog</Link>
          </Button>
        }
      />
    );
  }

  const open = (next: BacklogDialog | undefined) =>
    void navigate({
      to: '/backlog/$itemId',
      params: { itemId },
      search: next ? { dialog: next } : {},
      replace: true,
    });

  // Deleted at once; Undo puts the same row back (owner decision F-9).
  const remove = async () => {
    setError(undefined);
    try {
      await dispatch({ type: 'backlog.delete', backlogItemId: item.id });
      offerUndo({
        message: `${item.title} deleted`,
        undoneMessage: `${item.title} restored`,
        undo: () => dispatch({ type: 'backlog.restore', item }),
      });
      void navigate({ to: '/backlog' });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <div role="toolbar" aria-label="Item actions" className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => open('plan')}>
            <CalendarPlusIcon />
            Plan on calendar
          </Button>
          <Button size="sm" variant="outline" onClick={() => open('jira')}>
            <SendIcon />
            Publish to Jira
          </Button>
          <Button size="sm" variant="outline" onClick={() => open('github')}>
            <SendIcon />
            Publish to GitHub
          </Button>
          <span data-testid="backlog-state" className="sr-only">
            {backlogStateLabels[item.state]}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            onClick={() => void remove()}
          >
            <Trash2Icon />
            Delete
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <PlanStatus item={item} />
        <ItemEditor key={item.id} item={item} items={items} />
      </div>
      <PlanDialog item={item} open={dialog === 'plan'} onClose={() => open(undefined)} />
      <PublishDialog
        item={item}
        service={dialog === 'jira' || dialog === 'github' ? dialog : undefined}
        onClose={() => open(undefined)}
      />
    </div>
  );
}
