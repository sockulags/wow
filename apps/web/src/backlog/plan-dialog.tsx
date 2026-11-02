import type { BacklogItem } from '@wow/contracts';
import { TriangleAlertIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSetting } from '@/app/runtime';
import { formatTime, resolveZone } from '@/calendar/time';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { DateField, TimeField } from '@/components/date-time-fields';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { busyTimes, lastPlanningWorkflow, nextFreeSlot, overlaps, planRange } from './model';

function PlanForm({ item, onDone }: { item: BacklogItem; onDone: () => void }) {
  const dispatch = useDispatch();
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const calendar = useTopic('calendarItems') ?? [];
  const zone = resolveZone(useSetting('calendar.zone'));
  const cardMinutes = useSetting('calendar.cardMinutes');
  const firstDayOfWeek = useSetting('calendar.firstDayOfWeek');
  const snapMinutes = useSetting('calendar.snapMinutes');
  const workHours = useSetting('calendar.workHours');
  const lookaheadDays = useSetting('calendar.lookaheadDays');
  const busy = busyTimes(calendar);
  // The next free slot in work hours, around what Outlook and the cards already hold.
  const [initial] = useState(() =>
    nextFreeSlot({
      now: new Date(),
      zone,
      workHours,
      busy,
      minutes: cardMinutes,
      snapMinutes,
      days: lookaheadDays,
    }),
  );
  const lastWorkflow = lastPlanningWorkflow(calendar);
  const [workflowId, setWorkflowId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [date, setDate] = useState(initial.date);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // A single workflow or project needs no choosing; otherwise the one planned with last.
  const chosenWorkflow =
    workflowId ||
    (workflows.length === 1
      ? (workflows[0]?.id ?? '')
      : workflows.some((workflow) => workflow.id === lastWorkflow)
        ? (lastWorkflow ?? '')
        : '');
  const chosenProject = projectId || (projects.length === 1 ? (projects[0]?.id ?? '') : '');
  const range = planRange(date, start, end, zone);
  const collisions =
    typeof range === 'string'
      ? []
      : overlaps(busy, new Date(range.start).getTime(), new Date(range.end).getTime());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (chosenWorkflow === '') return setError('Choose the workflow the card runs');
    if (chosenProject === '') return setError('Choose the project the workflow runs in');
    if (typeof range === 'string') return setError(range);
    setSending(true);
    setError(undefined);
    try {
      await dispatch({
        type: 'backlog.plan',
        backlogItemId: item.id,
        cardId: globalThis.crypto.randomUUID(),
        workflowId: chosenWorkflow,
        projectId: chosenProject,
        ...range,
        zone,
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4" aria-label="Plan">
      <div className="grid grid-cols-2 gap-4">
        <FormField
          id="plan-workflow"
          label="Workflow"
          source={
            chosenWorkflow !== '' && chosenWorkflow === lastWorkflow && !workflowId
              ? 'Last used'
              : undefined
          }
          help={workflows.length === 0 ? 'Build a workflow first under Workflows.' : undefined}
        >
          <ChoiceSelect
            label="Workflow"
            value={chosenWorkflow}
            placeholder="Choose a workflow"
            choices={workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))}
            onValueChange={setWorkflowId}
          />
        </FormField>
        <FormField id="plan-project" label="Project">
          <ChoiceSelect
            label="Project"
            value={chosenProject}
            placeholder="Choose a project"
            choices={projects.map((project) => ({ value: project.id, label: project.name }))}
            onValueChange={setProjectId}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <FormField id="plan-date" label="Date">
          <DateField
            id="plan-date"
            label="Date"
            value={date}
            firstDayOfWeek={firstDayOfWeek}
            onValueChange={setDate}
          />
        </FormField>
        <FormField id="plan-start" label="Start">
          <TimeField
            id="plan-start"
            label="Start"
            value={start}
            stepMinutes={snapMinutes}
            onValueChange={setStart}
          />
        </FormField>
        <FormField id="plan-end" label="End">
          <TimeField
            id="plan-end"
            label="End"
            value={end}
            stepMinutes={snapMinutes}
            onValueChange={setEnd}
          />
        </FormField>
      </div>
      {collisions.length > 0 && (
        <p data-testid="plan-overlap" className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Overlaps{' '}
          {collisions
            .map(
              (entry) =>
                `${entry.title} ${formatTime(new Date(entry.start), zone)}–${formatTime(new Date(entry.end), zone)}`,
            )
            .join(', ')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The workflow starts at the card&apos;s time. Suggested: the next free slot in your work
        hours.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={sending}>
          Plan
        </Button>
      </DialogFooter>
    </form>
  );
}

// "Plan on calendar" (behavior 29): a card with the item, a workflow and a time.
export function PlanDialog({
  item,
  open,
  onClose,
}: {
  item: BacklogItem;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plan on calendar</DialogTitle>
          <DialogDescription>
            Puts a card for &ldquo;{item.title}&rdquo; on the calendar with the workflow to run.
          </DialogDescription>
        </DialogHeader>
        {open && <PlanForm item={item} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
