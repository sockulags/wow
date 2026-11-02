import type { BacklogItem } from '@wow/contracts';
import { useState, type FormEvent } from 'react';
import { useSetting } from '@/app/runtime';
import { resolveZone } from '@/calendar/time';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { DateField, TimeField } from '@/components/date-time-fields';
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
import { nextHour, planRange } from './model';

function PlanForm({ item, onDone }: { item: BacklogItem; onDone: () => void }) {
  const dispatch = useDispatch();
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const zone = resolveZone(useSetting('calendar.zone'));
  const cardMinutes = useSetting('calendar.cardMinutes');
  const firstDayOfWeek = useSetting('calendar.firstDayOfWeek');
  const snapMinutes = useSetting('calendar.snapMinutes');
  const [initial] = useState(() => nextHour(new Date(), zone));
  const [workflowId, setWorkflowId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [date, setDate] = useState(initial.date);
  const [start, setStart] = useState(initial.start);
  const [minutes, setMinutes] = useState(String(cardMinutes));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // A single workflow or project needs no choosing.
  const chosenWorkflow = workflowId || (workflows.length === 1 ? (workflows[0]?.id ?? '') : '');
  const chosenProject = projectId || (projects.length === 1 ? (projects[0]?.id ?? '') : '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (chosenWorkflow === '') return setError('Choose the workflow the card runs');
    if (chosenProject === '') return setError('Choose the project the workflow runs in');
    const range = planRange(date, start, Number(minutes), zone);
    if (typeof range === 'string') return setError(range);
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3" aria-label="Plan">
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="plan-workflow">Workflow</Label>
          <ChoiceSelect
            id="plan-workflow"
            value={chosenWorkflow}
            placeholder="Choose a workflow"
            choices={workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))}
            onValueChange={setWorkflowId}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-project">Project</Label>
          <ChoiceSelect
            id="plan-project"
            value={chosenProject}
            placeholder="Choose a project"
            choices={projects.map((project) => ({ value: project.id, label: project.name }))}
            onValueChange={setProjectId}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="plan-date">Date</Label>
          <DateField
            id="plan-date"
            label="Date"
            value={date}
            firstDayOfWeek={firstDayOfWeek}
            onValueChange={setDate}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-start">Start</Label>
          <TimeField
            id="plan-start"
            label="Start"
            value={start}
            stepMinutes={snapMinutes}
            onValueChange={setStart}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-minutes">Minutes</Label>
          <Input
            id="plan-minutes"
            type="number"
            min={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are in {zone}. The workflow starts at the card&apos;s time.
      </p>
      {workflows.length === 0 && (
        <p className="text-xs text-muted-foreground">Build a workflow first under Workflows.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
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
