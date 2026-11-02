import { isLiveRunState, type CalendarItem, type Command, type WorkflowRun } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  useLayout,
  useRuntime,
  useSetting,
  type CardDialog as CardDialogState,
} from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  minuteOfDay,
  parseClockTime,
  parseIsoDate,
  resolveZone,
} from './time';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

interface Form {
  readonly title: string;
  readonly date: string;
  readonly start: string;
  readonly end: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly backlogItemId: string;
}

function initialForm(dialog: CardDialogState, card: CalendarItem | undefined, zone: string): Form {
  const start = new Date(dialog.type === 'create' ? dialog.start : (card?.start ?? Date.now()));
  const end = new Date(dialog.type === 'create' ? dialog.end : (card?.end ?? Date.now()));
  return {
    title: card?.title ?? '',
    date: isoDate(localDate(start, zone)),
    start: clockTime(minuteOfDay(start, zone)),
    end: clockTime(minuteOfDay(end, zone)),
    projectId: card?.projectId ?? '',
    workflowId: card?.workflowId ?? '',
    backlogItemId: card?.backlogItemId ?? '',
  };
}

// The instants a form describes. An end at or before the start, such as 00:00, ends on the next
// day; a card is never longer than a day from the form.
function formRange(form: Form, zone: string): { start: string; end: string } | string {
  const date = parseIsoDate(form.date);
  const start = parseClockTime(form.start);
  const end = parseClockTime(form.end);
  if (!date || start === undefined || end === undefined) return 'Give a date, a start and an end';
  const startAt = atMinute(date, start, zone);
  const endAt = end > start ? atMinute(date, end, zone) : atMinute(addDays(date, 1), end, zone);
  return { start: startAt.toISOString(), end: endAt.toISOString() };
}

const orNull = (value: string) => (value === '' ? null : value);

const runStateLabels: Readonly<Record<WorkflowRun['state'], string>> = {
  running: 'running',
  waiting: 'waiting for you',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

// The card's workflow run, and what can be done with it from here (spec 12, 13).
function RunStatus({
  card,
  run,
  busy,
  onRunNow,
}: {
  card: CalendarItem;
  run: WorkflowRun | undefined;
  busy: boolean;
  onRunNow: () => void;
}) {
  const canRun =
    card.workflowId !== null &&
    card.projectId !== null &&
    (run === undefined || !isLiveRunState(run.state));
  const offer = canRun && (card.state === 'missed' || card.state === 'failed');
  if (!run && !offer) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
      {run ? (
        <span>
          Workflow run {runStateLabels[run.state]}.{' '}
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: run.id }}
            className="underline underline-offset-2"
          >
            Open run
          </Link>
        </span>
      ) : (
        <span>
          {card.state === 'missed'
            ? 'The trigger was missed.'
            : 'The workflow run could not start.'}
        </span>
      )}
      {offer && (
        <Button type="button" size="sm" className="ml-auto" disabled={busy} onClick={onRunNow}>
          Run now
        </Button>
      )}
    </div>
  );
}

function CardForm({
  dialog,
  card,
  zone,
  onDone,
}: {
  dialog: CardDialogState;
  card: CalendarItem | undefined;
  zone: string;
  onDone: () => void;
}) {
  const dispatch = useDispatch();
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const runs = useTopic('workflowRuns');
  const run = card?.runId ? runs?.find((entry) => entry.id === card.runId) : undefined;
  const liveRun = run && isLiveRunState(run.state) ? run : undefined;
  // Deleting a card whose run is live asks first whether to stop the run (spec 13).
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState(() => initialForm(dialog, card, zone));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (changes: Partial<Form>) => setForm((current) => ({ ...current, ...changes }));

  const send = async (command: Command) => {
    setBusy(true);
    setError(undefined);
    try {
      await dispatch(command);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const range = formRange(form, zone);
    if (typeof range === 'string') {
      setError(range);
      return;
    }
    const title = form.title.trim();
    if (title === '') {
      setError('Give the card a title');
      return;
    }
    if (dialog.type === 'create') {
      void send({
        type: 'card.create',
        cardId: globalThis.crypto.randomUUID(),
        title,
        ...range,
        zone,
        ...(form.projectId ? { projectId: form.projectId } : {}),
        ...(form.workflowId ? { workflowId: form.workflowId } : {}),
        ...(form.backlogItemId ? { backlogItemId: form.backlogItemId } : {}),
      });
    } else {
      void send({
        type: 'card.update',
        cardId: dialog.cardId,
        title,
        ...range,
        projectId: orNull(form.projectId),
        workflowId: orNull(form.workflowId),
        backlogItemId: orNull(form.backlogItemId),
      });
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3" aria-label="Card">
      <div className="grid gap-1.5">
        <Label htmlFor="card-title">Title</Label>
        <Input
          id="card-title"
          autoFocus
          value={form.title}
          onChange={(event) => set({ title: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="card-date">Date</Label>
          <Input
            id="card-date"
            type="date"
            value={form.date}
            onChange={(event) => set({ date: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="card-start">Start</Label>
          <Input
            id="card-start"
            type="time"
            value={form.start}
            onChange={(event) => set({ start: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="card-end">End</Label>
          <Input
            id="card-end"
            type="time"
            value={form.end}
            onChange={(event) => set({ end: event.target.value })}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="card-project">Project</Label>
        <select
          id="card-project"
          className={selectClass}
          value={form.projectId}
          onChange={(event) => set({ projectId: event.target.value })}
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="card-workflow">Workflow</Label>
          <select
            id="card-workflow"
            className={selectClass}
            value={form.workflowId}
            onChange={(event) => set({ workflowId: event.target.value })}
          >
            <option value="">No workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="card-backlog">Backlog item</Label>
          <select
            id="card-backlog"
            className={selectClass}
            value={form.backlogItemId}
            onChange={(event) => set({ backlogItemId: event.target.value })}
          >
            <option value="">No backlog item</option>
            {backlog.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Times are in {zone}.</p>
      {card && (
        <RunStatus
          card={card}
          run={run}
          busy={busy}
          onRunNow={() =>
            void send({
              type: 'card.runNow',
              cardId: card.id,
              runId: globalThis.crypto.randomUUID(),
            })
          }
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {confirmDelete && dialog.type === 'edit' && liveRun && (
        <div
          role="alertdialog"
          aria-label="Stop the run?"
          className="grid gap-2 rounded-md border border-destructive/50 p-2 text-xs"
        >
          <p>
            This card's workflow run is {runStateLabels[liveRun.state]}. Stop it too? Its threads
            are kept either way.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void send({ type: 'card.delete', cardId: dialog.cardId, stopRun: true })
              }
            >
              Stop run and delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void send({ type: 'card.delete', cardId: dialog.cardId, stopRun: false })
              }
            >
              Keep run and delete
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep the card
            </Button>
          </div>
        </div>
      )}
      <DialogFooter>
        {dialog.type === 'edit' && (
          <Button
            type="button"
            variant="destructive"
            className="mr-auto"
            disabled={busy || confirmDelete}
            onClick={() =>
              liveRun
                ? setConfirmDelete(true)
                : void send({ type: 'card.delete', cardId: dialog.cardId })
            }
          >
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {dialog.type === 'create' ? 'Create card' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// Creates and edits local cards. Outlook items never open here: they are read-only.
export function CardDialog({ cards }: { cards: readonly CalendarItem[] }) {
  const { layout } = useRuntime();
  const dialog = useLayout((state) => state.cardDialog);
  const zone = resolveZone(useSetting('calendar.zone'));
  const card =
    dialog?.type === 'edit' ? cards.find((candidate) => candidate.id === dialog.cardId) : undefined;
  const close = () => layout.setState({ cardDialog: undefined });
  // An edit dialog for a card that is gone (deleted elsewhere, or not loaded yet) shows nothing.
  const open = dialog !== undefined && (dialog.type === 'create' || card !== undefined);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialog?.type === 'edit' ? 'Edit card' : 'New card'}</DialogTitle>
          <DialogDescription>Cards stay in wow; they never appear in Outlook.</DialogDescription>
        </DialogHeader>
        {dialog && open && (
          <CardForm
            key={dialog.type === 'edit' ? dialog.cardId : `${dialog.start}/${dialog.end}`}
            dialog={dialog}
            card={card}
            zone={zone}
            onDone={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
