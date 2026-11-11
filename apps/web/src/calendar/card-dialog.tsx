import { isLiveRunState, type CalendarItem, type Command } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { AlertTriangleIcon, InfoIcon, WorkflowIcon } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import {
  useLayout,
  useRuntime,
  useSetting,
  type CardDialog as CardDialogState,
} from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { Combobox } from '@/components/combobox';
import { DateField, TimeField } from '@/components/date-time-fields';
import { FormField } from '@/components/form-field';
import { WithTooltip } from '@/components/hint';
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
import { Textarea } from '@/components/ui/textarea';
import { offerUndo } from '@/lib/feedback';
import { cn } from '@/lib/utils';
import { cardKind as cardKindOf } from './items';
import {
  durationLabel,
  formRange,
  lastUsedProjectId,
  nextFireText,
  repeatDraft,
  repeatRule,
  sameRule,
  triggerSummary,
  type CardFormValues,
  type RepeatDraft,
} from './card-form';
import { useCalendarPrefs } from './prefs';
import { RepeatSection } from './repeat-section';
import {
  clockTime,
  formatShortDay,
  formatZone,
  isoDate,
  localDate,
  minuteOfDay,
  parseIsoDate,
  systemZone,
} from './time';

function initialForm(
  dialog: CardDialogState,
  card: CalendarItem | undefined,
  zone: string,
  projectId: string,
): CardFormValues {
  const start = new Date(dialog.type === 'create' ? dialog.start : (card?.start ?? Date.now()));
  const end = new Date(dialog.type === 'create' ? dialog.end : (card?.end ?? Date.now()));
  return {
    title: card?.title ?? '',
    date: isoDate(localDate(start, zone)),
    start: clockTime(minuteOfDay(start, zone)),
    end: clockTime(minuteOfDay(end, zone)),
    projectId: card ? (card.projectId ?? '') : projectId,
    workflowId: card?.workflowId ?? '',
    backlogItemId: card?.backlogItemId ?? '',
    body: card?.body ?? '',
    repeat: repeatDraft(card?.repeat),
  };
}

// What Delete asks before it deletes (recurring cards spec 12): which part of a repeating card,
// and whether to stop a run that is going.
type Asking = 'which' | 'stopRun' | undefined;

// Undo of a deleted card creates it again with the same id and fields, a series with its rule
// and the days skipped by hand (spec 13).
const recreate = (card: CalendarItem): Command => ({
  type: 'card.create',
  cardId: card.id,
  title: card.title,
  start: card.start,
  end: card.end,
  zone: card.zone,
  ...(card.body ? { body: card.body } : {}),
  ...(card.projectId ? { projectId: card.projectId } : {}),
  ...(card.workflowId ? { workflowId: card.workflowId } : {}),
  ...(card.backlogItemId ? { backlogItemId: card.backlogItemId } : {}),
  ...(card.repeat ? { repeat: card.repeat, skippedDates: card.skippedDates ?? [] } : {}),
});

const dayText = (date: string) => {
  const day = parseIsoDate(date);
  return day ? formatShortDay(day) : date;
};

const orNull = (value: string) => (value === '' ? null : value);

function CardForm({
  dialog,
  card,
  cards,
  zone,
  onDone,
}: {
  dialog: CardDialogState;
  card: CalendarItem | undefined;
  cards: readonly CalendarItem[];
  zone: string;
  onDone: () => void;
}) {
  const dispatch = useDispatch();
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const { firstDayOfWeek } = useCalendarPrefs();
  const snapMinutes = useSetting('calendar.snapMinutes');
  const runs = useTopic('workflowRuns');
  const run = card?.runId ? runs?.find((entry) => entry.id === card.runId) : undefined;
  const liveRun = run && isLiveRunState(run.state) ? run : undefined;
  const repeating = card?.repeat !== null && card?.repeat !== undefined;
  // The occurrence the dialog was opened from, for "This occurrence".
  const occurrenceDate = dialog.type === 'edit' && repeating ? dialog.date : undefined;
  // Deleting a card whose run is live asks first whether to stop the run (spec 13); a repeating
  // card first asks whether to delete one occurrence or the series.
  const [asking, setAsking] = useState<Asking>(() =>
    dialog.type === 'edit' && dialog.deleting ? 'which' : undefined,
  );
  const [form, setForm] = useState(() =>
    initialForm(dialog, card, zone, lastUsedProjectId(cards, projects)),
  );
  const [error, setError] = useState<string>();
  const [titleMissing, setTitleMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (changes: Partial<CardFormValues>) =>
    setForm((current) => ({ ...current, ...changes }));
  const range = formRange(form, zone);
  const repeat = repeatRule(form.repeat, form.date);
  const setRepeat = (changes: Partial<RepeatDraft>) =>
    setForm((current) => ({ ...current, repeat: { ...current.repeat, ...changes } }));
  const title = form.title.trim();
  const workflow = workflows.find((entry) => entry.id === form.workflowId);
  const project = projects.find((entry) => entry.id === form.projectId);
  const summary = triggerSummary({
    workflow,
    project,
    start: range.ok ? range.start : undefined,
    zone,
    run,
  });
  const canRunNow =
    card !== undefined &&
    card.workflowId !== null &&
    card.projectId !== null &&
    (run === undefined || !isLiveRunState(run.state)) &&
    (card.state === 'missed' || card.state === 'failed');
  const blocked = !range.ok
    ? range.message
    : title === ''
      ? 'Give the card a title'
      : !repeat.ok
        ? repeat.message
        : undefined;
  // When the card's trigger fires next is the server's to say; while the form differs from the
  // stored card it is the time as saved.
  const unsaved =
    !card ||
    !range.ok ||
    range.start !== card.start ||
    range.end !== card.end ||
    !repeat.ok ||
    !sameRule(repeat.rule, card.repeat);
  const next =
    card && card.repeat && cardKindOf(card) === 'trigger'
      ? card.nextAt
        ? `Fires next ${nextFireText(card.nextAt, zone)}${unsaved ? ', as saved' : ''}`
        : 'Nothing more fires.'
      : undefined;

  const send = async (command: Command) => {
    setBusy(true);
    setError(undefined);
    try {
      await dispatch(command);
      onDone();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Delete at once and offer Undo (owner decision F-9): Undo creates the card again with the same
  // id and fields. A run it had stays stopped or kept as chosen.
  const remove = async (stopRun?: boolean) => {
    if (dialog.type !== 'edit' || !card) return;
    const deleted = await send({
      type: 'card.delete',
      cardId: dialog.cardId,
      ...(stopRun === undefined ? {} : { stopRun }),
    });
    if (!deleted) return;
    offerUndo({
      message: repeating ? 'Series deleted' : 'Card deleted',
      description: card.title,
      undoneMessage: repeating ? 'Series restored' : 'Card restored',
      undo: () => dispatch(recreate(card)),
    });
  };

  // "The whole series", or a single card: a live run asks first.
  const removeAll = () => {
    if (liveRun) setAsking('stopRun');
    else void remove();
  };

  // "This occurrence": that day is skipped and the rest of the series stays. Undo puts the list
  // of skipped days back as it was.
  const skipOccurrence = async () => {
    if (!card || !occurrenceDate) return;
    const before = card.skippedDates ?? [];
    const skipped = await send({
      type: 'card.skipOccurrence',
      cardId: card.id,
      date: occurrenceDate,
    });
    if (!skipped) return;
    offerUndo({
      message: 'Occurrence skipped',
      description: `${card.title}, ${dayText(occurrenceDate)}`,
      undoneMessage: 'Occurrence restored',
      undo: () => dispatch({ type: 'card.update', cardId: card.id, skippedDates: [...before] }),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title === '') setTitleMissing(true);
    if (!range.ok || title === '') return;
    const times = { start: range.start, end: range.end };
    if (!repeat.ok) return;
    if (dialog.type === 'create') {
      void send({
        type: 'card.create',
        cardId: globalThis.crypto.randomUUID(),
        title,
        ...times,
        zone,
        ...(form.body.trim() ? { body: form.body.trim() } : {}),
        ...(form.projectId ? { projectId: form.projectId } : {}),
        ...(form.workflowId ? { workflowId: form.workflowId } : {}),
        ...(form.backlogItemId ? { backlogItemId: form.backlogItemId } : {}),
        ...(repeat.rule ? { repeat: repeat.rule } : {}),
      });
    } else {
      void send({
        type: 'card.update',
        cardId: dialog.cardId,
        title,
        ...times,
        body: orNull(form.body.trim()),
        projectId: orNull(form.projectId),
        workflowId: orNull(form.workflowId),
        backlogItemId: orNull(form.backlogItemId),
        // Only a changed rule is sent: making a card single again is an edit of its own.
        ...(sameRule(repeat.rule, card?.repeat) ? {} : { repeat: repeat.rule }),
      });
    }
  };

  const submitButton = (
    <Button type="submit" disabled={busy || blocked !== undefined}>
      {dialog.type === 'create' ? 'Create card' : 'Save card'}
    </Button>
  );

  return (
    <form onSubmit={submit} className="grid min-w-0 gap-4" aria-label="Card" noValidate>
      <FormField
        id="card-title"
        label="Title"
        error={titleMissing && title === '' ? 'Give the card a title' : undefined}
      >
        <Input
          autoFocus
          placeholder="What is this time for?"
          value={form.title}
          onBlur={() => setTitleMissing(form.title.trim() === '')}
          onChange={(event) => set({ title: event.target.value })}
        />
      </FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField
          id="card-date"
          label="Date"
          error={!range.ok && range.field === 'date' ? range.message : undefined}
        >
          <DateField
            id="card-date"
            label="Date"
            value={form.date}
            firstDayOfWeek={firstDayOfWeek}
            onValueChange={(date) => set({ date })}
          />
        </FormField>
        <FormField
          id="card-start"
          label="Start"
          error={!range.ok && range.field === 'start' ? range.message : undefined}
        >
          <TimeField
            id="card-start"
            label="Start"
            value={form.start}
            stepMinutes={snapMinutes}
            onValueChange={(start) => set({ start })}
          />
        </FormField>
        <FormField
          id="card-end"
          label="End"
          help={
            range.ok ? (
              <span data-testid="card-duration">{durationLabel(range.minutes)}</span>
            ) : undefined
          }
          error={!range.ok && range.field === 'end' ? range.message : undefined}
        >
          <TimeField
            id="card-end"
            label="End"
            value={form.end}
            stepMinutes={snapMinutes}
            onValueChange={(end) => set({ end })}
          />
        </FormField>
      </div>
      <fieldset className="grid min-w-0 gap-3 rounded-md border border-border p-3">
        <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
          <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden />
          Run a workflow
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <FormField id="card-workflow" label="Workflow">
            <ChoiceSelect
              id="card-workflow"
              value={form.workflowId}
              choices={[
                { value: '', label: 'No workflow' },
                ...workflows.map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
              onValueChange={(workflowId) => set({ workflowId })}
            />
          </FormField>
          <FormField id="card-project" label="Project">
            <ChoiceSelect
              id="card-project"
              value={form.projectId}
              choices={[
                { value: '', label: 'No project' },
                ...projects.map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
              onValueChange={(projectId) => set({ projectId })}
            />
          </FormField>
        </div>
        {summary.tone !== 'none' && (
          <div
            data-testid="trigger-summary"
            role={summary.tone === 'warning' ? 'alert' : 'status'}
            className={cn(
              'flex min-w-0 items-center gap-2 text-xs',
              summary.tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {summary.tone === 'warning' ? (
              <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <InfoIcon className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{summary.text}</span>
            {summary.tone === 'run' && (
              <Button asChild size="xs" variant="outline">
                <Link to="/workflows/runs/$runId" params={{ runId: summary.runId }}>
                  Open run
                </Link>
              </Button>
            )}
            {canRunNow && card && (
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void send({
                    type: 'card.runNow',
                    cardId: card.id,
                    runId: globalThis.crypto.randomUUID(),
                  })
                }
              >
                Run now
              </Button>
            )}
          </div>
        )}
      </fieldset>
      <RepeatSection
        draft={form.repeat}
        result={repeat}
        date={form.date}
        start={range.ok ? range.start : undefined}
        zone={zone}
        firstDayOfWeek={firstDayOfWeek}
        next={next}
        onChange={setRepeat}
      />
      <FormField id="card-backlog" label="Backlog item">
        <Combobox
          id="card-backlog"
          className="w-full"
          value={form.backlogItemId}
          placeholder="No backlog item"
          searchPlaceholder="Search backlog…"
          emptyText="No matching item."
          choices={[
            { value: '', label: 'No backlog item' },
            ...backlog.map((entry) => ({ value: entry.id, label: entry.title })),
          ]}
          onValueChange={(backlogItemId) => set({ backlogItemId })}
        />
      </FormField>
      <FormField id="card-notes" label="Notes">
        <Textarea
          rows={3}
          placeholder="Anything to remember for this time"
          value={form.body}
          onChange={(event) => set({ body: event.target.value })}
        />
      </FormField>
      {zone !== systemZone() && (
        <p className="text-xs text-muted-foreground">Times are in {formatZone(zone)}.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {asking === 'which' && dialog.type === 'edit' && card && (
        <div
          role="alertdialog"
          aria-label={repeating ? 'Delete which?' : 'Delete the card?'}
          className="grid gap-2 rounded-md border border-destructive/50 p-3 text-xs"
        >
          <p>
            {repeating
              ? occurrenceDate
                ? `Delete only ${dayText(occurrenceDate)}, or every occurrence of this card?`
                : 'Delete every occurrence of this card? To leave out one day, open it from the calendar.'
              : 'Delete this card?'}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(undefined)}>
              Cancel
            </Button>
            {occurrenceDate && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void skipOccurrence()}
              >
                This occurrence
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              autoFocus
              onClick={removeAll}
            >
              {repeating ? 'The whole series' : 'Delete card'}
            </Button>
          </div>
        </div>
      )}
      {asking === 'stopRun' && dialog.type === 'edit' && liveRun && (
        <div
          role="alertdialog"
          aria-label="Stop the run?"
          className="grid gap-2 rounded-md border border-destructive/50 p-3 text-xs"
        >
          <p>
            This card's workflow run is{' '}
            {liveRun.state === 'waiting' ? 'waiting for you' : 'running'}. Stop it too? Its threads
            are kept either way.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(undefined)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void remove(false)}
            >
              Keep run and delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void remove(true)}
            >
              Stop run and delete
            </Button>
          </div>
        </div>
      )}
      <DialogFooter>
        {dialog.type === 'edit' && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive hover:text-destructive"
            disabled={busy || asking !== undefined}
            onClick={() => (repeating ? setAsking('which') : removeAll())}
          >
            {repeating ? 'Delete…' : 'Delete card'}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        {blocked ? (
          <WithTooltip label={blocked}>
            <span tabIndex={0} className="inline-flex rounded-md">
              {submitButton}
            </span>
          </WithTooltip>
        ) : (
          submitButton
        )}
      </DialogFooter>
    </form>
  );
}

// Creates and edits local cards. Outlook items never open here: they are read-only.
export function CardDialog({ cards }: { cards: readonly CalendarItem[] }) {
  const { layout } = useRuntime();
  const dialog = useLayout((state) => state.cardDialog);
  const { zone } = useCalendarPrefs();
  const card =
    dialog?.type === 'edit' ? cards.find((candidate) => candidate.id === dialog.cardId) : undefined;
  const close = () => layout.setState({ cardDialog: undefined });
  // An edit dialog for a card that is gone (deleted elsewhere, or not loaded yet) shows nothing.
  const open = dialog !== undefined && (dialog.type === 'create' || card !== undefined);
  // The dialog opens from the grid, a key or the palette, so it has no trigger to give focus
  // back to: it returns to whatever had focus when it opened, such as the card in the grid.
  // It is read while rendering the opening, before the dialog moves focus to its first field.
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && document.activeElement instanceof HTMLElement) {
    returnFocus.current = document.activeElement;
  }
  wasOpen.current = open;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          returnFocus.current = null;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{dialog?.type === 'edit' ? 'Edit card' : 'New card'}</DialogTitle>
          <DialogDescription>Cards stay in wow; they never appear in Outlook.</DialogDescription>
        </DialogHeader>
        {dialog && open && (
          <CardForm
            key={
              dialog.type === 'edit'
                ? `${dialog.cardId}/${dialog.date ?? ''}/${dialog.deleting ? 'delete' : ''}`
                : `${dialog.start}/${dialog.end}`
            }
            dialog={dialog}
            card={card}
            cards={cards}
            zone={zone}
            onDone={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
