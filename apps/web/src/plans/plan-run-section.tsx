import type { PlanIntent, PlanRun, Workflow, WorkflowRun } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { PlayIcon, SquareIcon } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WithTooltip } from '@/components/hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import {
  planRunStateLabels,
  planRunStateVariants,
  planRunUnitLabel,
  runReadyUnitsBlocked,
  shownPlanRun,
  unitWorkflows,
} from './model';
import {
  askStopPlanRun,
  cancelStopPlanRun,
  confirmStopPlanRun,
  planRunStore,
  startPlanRun,
} from './plan-run';

const live = (planRun: PlanRun) => planRun.state === 'running' || planRun.state === 'waiting';

function PlanRunCard({
  planRun,
  workflow,
  runs,
}: {
  planRun: PlanRun;
  workflow: Workflow | undefined;
  runs: readonly WorkflowRun[];
}) {
  const { when } = useDateFormat();
  return (
    <div
      role="region"
      aria-label="Plan run"
      data-testid="plan-run"
      data-state={planRun.state}
      className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge data-testid="plan-run-state" variant={planRunStateVariants[planRun.state]}>
          {planRunStateLabels[planRun.state]}
        </Badge>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {workflow?.name ?? 'Workflow'} · started {when(planRun.startedAt)}
          {planRun.endedAt ? ` · ended ${when(planRun.endedAt)}` : ''}
        </span>
        {live(planRun) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => askStopPlanRun(planRun.id)}
          >
            <SquareIcon />
            Stop
          </Button>
        )}
      </div>
      {planRun.message && (
        <p data-testid="plan-run-message" className="text-xs">
          {planRun.message}
        </p>
      )}
      {planRun.state === 'done' && (
        <p data-testid="plan-run-message" className="text-xs text-muted-foreground">
          Every unit is delivered.
        </p>
      )}
      {planRun.waitingFor.length > 0 && (
        <div className="flex flex-col gap-0.5 text-xs">
          <p className="text-muted-foreground">Waits for the hosts to show a change:</p>
          <ul data-testid="plan-run-waiting" className="list-disc pl-5">
            {planRun.waitingFor.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </div>
      )}
      {planRun.units.length > 0 && (
        <ol data-testid="plan-run-units" className="flex flex-col gap-0.5 text-xs">
          {planRun.units.map((unit) => (
            <li
              key={unit.runId}
              data-testid={`plan-run-unit-${unit.unitKey}`}
              className="flex flex-wrap items-baseline gap-2"
            >
              <Link
                to="/workflows/runs/$runId"
                params={{ runId: unit.runId }}
                className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono">{unit.unitKey}</span> {unit.title}
              </Link>
              <span className="text-muted-foreground">
                {planRunUnitLabel(
                  unit,
                  runs.find((run) => run.id === unit.runId),
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// Above a plan's units (review loop spec, Interface "plan run"): "Run ready units" with the
// workflow to use, and the plan's plan run with its state, what it waits for, the unit runs with
// links and Stop.
export function PlanRunSection({ intent }: { intent: PlanIntent }) {
  const send = useDispatch();
  const planRuns = useTopic('planRuns');
  const workflows = useTopic('workflows');
  const runs = useTopic('workflowRuns');
  const view = useStore(planRunStore);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  if (planRuns === undefined || workflows === undefined) return null;
  const planRun = shownPlanRun(planRuns, intent.id);
  const offered = unitWorkflows(workflows);
  const workflow = offered.find((candidate) => candidate.id === chosen) ?? offered[0];
  const blocked = runReadyUnitsBlocked(intent, planRuns, workflows);
  const error = view.error?.planId === intent.id ? view.error.message : undefined;
  const start = async () => {
    if (!workflow) return;
    setBusy(true);
    await startPlanRun(send, intent.id, workflow.id);
    setBusy(false);
  };
  const button = (
    <Button
      type="button"
      size="sm"
      disabled={blocked !== undefined || busy || !workflow}
      onClick={() => void start()}
    >
      <PlayIcon />
      Run ready units
    </Button>
  );
  return (
    <div data-testid="plan-run-section" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {blocked === undefined ? (
          button
        ) : (
          <WithTooltip label={blocked}>
            <span>{button}</span>
          </WithTooltip>
        )}
        {offered.length > 1 && (
          <ChoiceSelect
            label="Workflow for the units"
            size="sm"
            className="w-56"
            value={workflow?.id ?? ''}
            choices={offered.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            onValueChange={setChosen}
          />
        )}
        {offered.length === 1 && workflow && (
          <span className="text-xs text-muted-foreground">with {workflow.name}</span>
        )}
        {blocked !== undefined && !(planRun && live(planRun)) && (
          <span data-testid="plan-run-blocked" className="text-xs text-muted-foreground">
            {blocked}.
          </span>
        )}
      </div>
      {error && (
        <p role="alert" data-testid="plan-run-error" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {planRun && (
        <PlanRunCard
          planRun={planRun}
          workflow={workflows.find((candidate) => candidate.id === planRun.workflowId)}
          runs={runs ?? []}
        />
      )}
      <ConfirmDialog
        open={planRun !== undefined && view.stopping === planRun.id}
        title="Stop this plan run?"
        description="The unit's run that is going stops as a run does: its turn is interrupted and its threads and working copy stay. No further unit starts."
        confirmLabel="Stop"
        onConfirm={() => void confirmStopPlanRun(send, intent.id)}
        onCancel={cancelStopPlanRun}
      />
    </div>
  );
}
