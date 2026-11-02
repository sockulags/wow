import type { BacklogItem, BacklogState, TrackerService } from '@wow/contracts';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { CalendarPlusIcon, ListTodoIcon, PlusIcon, SendIcon, Trash2Icon } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useConnectionState } from '@/app/runtime';
import { useCalendarPrefs } from '@/calendar/prefs';
import { isoDate, localDate, formatTime } from '@/calendar/time';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { runStateLabels } from '@/workflows/model';
import {
  allTags,
  backlogStateDotClass,
  backlogStateLabels,
  backlogStates,
  emptyFilter,
  filterItems,
  formatTags,
  parseTags,
  runProblem,
  sortItems,
  type BacklogFilter,
} from './model';
import { PlanDialog } from './plan-dialog';
import { PublishDialog, RemoteLink } from './publish-dialog';

// Which dialog the item view shows; the URL holds it so palette commands can open one.
export type BacklogDialog = 'plan' | TrackerService;

export const validateBacklogItemSearch = (
  search: Record<string, unknown>,
): { dialog?: BacklogDialog } =>
  search['dialog'] === 'plan' || search['dialog'] === 'jira' || search['dialog'] === 'github'
    ? { dialog: search['dialog'] }
    : {};

const textareaClass =
  'min-h-48 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

function StateDot({ state }: { state: BacklogState }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', backlogStateDotClass[state])}
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
  const items = useTopic('backlogItems') ?? [];
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
        <h3 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
          Items<span className="ml-1 opacity-70">{shown.length}</span>
        </h3>
        <ul aria-label="Backlog items" className="flex flex-col gap-0.5">
          {shown.map((item) => (
            <li key={item.id} data-testid="backlog-item">
              <Link
                to="/backlog/$itemId"
                params={{ itemId: item.id }}
                className="flex flex-col rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
                activeProps={{ className: 'bg-sidebar-accent', 'aria-current': 'page' }}
              >
                <span className="flex items-center gap-2">
                  <StateDot state={item.state} />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span
                    data-testid="backlog-item-state"
                    className="shrink-0 text-[11px] text-muted-foreground"
                  >
                    {backlogStateLabels[item.state]}
                  </span>
                </span>
                {(item.tags.length > 0 || item.remote) && (
                  <span className="truncate pl-3.5 text-[11px] text-muted-foreground">
                    {[item.remote?.key, ...item.tags].filter(Boolean).join(' · ')}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
        {items.length > 0 && shown.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">No item matches the filter.</p>
        )}
      </div>
    </nav>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <ListTodoIcon className="size-6 text-muted-foreground" aria-hidden />
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="max-w-sm text-xs text-muted-foreground">{children}</div>
    </section>
  );
}

export function BacklogLayout() {
  const { configured } = useConnectionState();
  if (!configured) {
    return (
      <Empty title="Backlog is empty">
        Ideas that are not tickets yet will appear here once the app is connected to the wow server.
      </Empty>
    );
  }
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
  return (
    <Empty title={items && items.length > 0 ? 'Pick an item' : 'Backlog is empty'}>
      <p>
        Ideas that are not tickets yet. Give one a workflow and a time with Plan on calendar, or
        publish it to Jira or GitHub. Nothing leaves wow until you do.
      </p>
      <Button asChild size="sm" variant="outline" className="mt-3">
        <Link to="/backlog/new">
          <PlusIcon />
          New item
        </Link>
      </Button>
    </Empty>
  );
}

interface Fields {
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly state: BacklogState;
}

function ItemFields({
  fields,
  onChange,
  withState,
}: {
  fields: Fields;
  onChange: (changes: Partial<Fields>) => void;
  withState: boolean;
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="backlog-title">Title</Label>
        <Input
          id="backlog-title"
          value={fields.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="backlog-body">Body (markdown)</Label>
        <textarea
          id="backlog-body"
          className={textareaClass}
          value={fields.body}
          onChange={(event) => onChange({ body: event.target.value })}
        />
      </div>
      <div className={cn('grid gap-2', withState && 'grid-cols-[1fr_12rem]')}>
        <div className="grid gap-1.5">
          <Label htmlFor="backlog-tags">Tags (comma separated)</Label>
          <Input
            id="backlog-tags"
            value={fields.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
          />
        </div>
        {withState && (
          <div className="grid gap-1.5">
            <Label htmlFor="backlog-state">State</Label>
            <ChoiceSelect
              id="backlog-state"
              value={fields.state}
              choices={backlogStates.map((state) => ({
                value: state,
                label: backlogStateLabels[state],
              }))}
              onValueChange={(state) => onChange({ state: state as BacklogState })}
            />
          </div>
        )}
      </div>
    </>
  );
}

export function NewItemView() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [fields, setFields] = useState<Fields>({ title: '', body: '', tags: '', state: 'idea' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = fields.title.trim();
    if (title === '') return setError('Give the item a title');
    const backlogItemId = globalThis.crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    try {
      await dispatch({
        type: 'backlog.create',
        backlogItemId,
        title,
        body: fields.body,
        tags: parseTags(fields.tags),
      });
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
      className="mx-auto flex max-w-3xl flex-col gap-3 p-6"
    >
      <h2 className="text-base font-semibold">New backlog item</h2>
      <ItemFields
        fields={fields}
        onChange={(changes) => setFields((current) => ({ ...current, ...changes }))}
        withState={false}
      />
      <p className="text-xs text-muted-foreground">The item stays in wow; nothing is sent.</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button asChild type="button" variant="outline">
          <Link to="/backlog">Cancel</Link>
        </Button>
        <Button type="submit" disabled={busy}>
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
  return (
    <section
      aria-label="Plan and publishing"
      className="grid gap-1.5 rounded-md border border-border bg-card p-3 text-xs"
    >
      {cards.map((card) => {
        const start = new Date(card.start);
        const date = isoDate(localDate(start, zone));
        return (
          <p key={card.id} data-testid="backlog-card" className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">On the calendar:</span>
            <Link
              to="/calendar"
              search={{ view: 'day', date }}
              className="underline-offset-2 hover:underline"
            >
              {date} {formatTime(start, zone)}
            </Link>
            <span className="text-muted-foreground">with {workflowName(card.workflowId)}</span>
          </p>
        );
      })}
      {run && (
        <p data-testid="backlog-run" className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Last run:</span>
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: run.id }}
            className="underline-offset-2 hover:underline"
          >
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

// Edits are kept as changes over the server's row, so a field the user has not touched follows
// the server (for example the state while the item's run moves on).
function ItemEditor({ item }: { item: BacklogItem }) {
  const dispatch = useDispatch();
  const [changes, setChanges] = useState<Partial<Fields>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fields: Fields = {
    title: changes.title ?? item.title,
    body: changes.body ?? item.body,
    tags: changes.tags ?? formatTags(item.tags),
    state: changes.state ?? item.state,
  };
  const dirty = Object.keys(changes).length > 0;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = fields.title.trim();
    if (title === '') return setError('Give the item a title');
    setBusy(true);
    setError(undefined);
    try {
      await dispatch({
        type: 'backlog.update',
        backlogItemId: item.id,
        ...(changes.title === undefined ? {} : { title }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.tags === undefined ? {} : { tags: parseTags(changes.tags) }),
        ...(changes.state === undefined ? {} : { state: changes.state }),
      });
      setChanges({});
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form aria-label="Backlog item" onSubmit={(event) => void save(event)} className="grid gap-3">
      <ItemFields
        fields={fields}
        onChange={(next) => setChanges((current) => ({ ...current, ...next }))}
        withState
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {dirty && (
          <Button type="button" variant="outline" onClick={() => setChanges({})}>
            Discard
          </Button>
        )}
        <Button type="submit" disabled={!dirty || busy}>
          Save
        </Button>
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
  if (!items) return null;
  if (!item) {
    return (
      <Empty title="No such item">
        <Link to="/backlog" className="underline">
          Back to the backlog
        </Link>
      </Empty>
    );
  }

  const open = (next: BacklogDialog | undefined) =>
    void navigate({
      to: '/backlog/$itemId',
      params: { itemId },
      search: next ? { dialog: next } : {},
      replace: true,
    });

  const remove = async () => {
    setError(undefined);
    try {
      await dispatch({ type: 'backlog.delete', backlogItemId: item.id });
      void navigate({ to: '/backlog' });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <header className="flex flex-wrap items-center gap-2">
          <StateDot state={item.state} />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{item.title}</h2>
          <span data-testid="backlog-state" className="text-xs text-muted-foreground">
            {backlogStateLabels[item.state]}
          </span>
        </header>
        <div role="toolbar" aria-label="Item actions" className="flex flex-wrap gap-2">
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
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
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
        <ItemEditor key={item.id} item={item} />
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
