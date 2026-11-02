import type { BacklogItem } from '@wow/contracts';
import { useState, type FormEvent } from 'react';
import { useSetting } from '@/app/runtime';
import { resolveZone } from '@/calendar/time';
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
import { nextHour, planRange } from './model';

export const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

function PlanForm({ item, onDone }: { item: BacklogItem; onDone: () => void }) {
  const dispatch = useDispatch();
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const zone = resolveZone(useSetting('calendar.zone'));
  const cardMinutes = useSetting('calendar.cardMinutes');
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
          <select
            id="plan-workflow"
            className={selectClass}
            value={chosenWorkflow}
            onChange={(event) => setWorkflowId(event.target.value)}
          >
            <option value="">Choose a workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-project">Project</Label>
          <select
            id="plan-project"
            className={selectClass}
            value={chosenProject}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Choose a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="plan-date">Date</Label>
          <Input
            id="plan-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="plan-start">Start</Label>
          <Input
            id="plan-start"
            type="time"
            value={start}
            onChange={(event) => setStart(event.target.value)}
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
