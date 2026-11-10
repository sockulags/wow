import { triggerEventLabels, TriggerEvent } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { PlusIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { useStore } from 'zustand';
import { useSetting } from '@/app/runtime';
import { useDispatch, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
import { FormField } from '@/components/form-field';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  cancelNewTrigger,
  chosenDraft,
  confirmNewTrigger,
  editNewTrigger,
  openNewTrigger,
  removeTrigger,
  setTriggerEnabled,
  triggerGroups,
  triggersHeld,
  triggersStore,
  triggerTitle,
  type TriggerRow,
} from './triggers';

const eventChoices = TriggerEvent.options.map((event) => ({
  value: event,
  label: triggerEventLabels[event],
}));

// "New trigger": project, event and workflow (review loop spec, Interface).
function NewTriggerDialog() {
  const dispatch = useDispatch();
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const draft = useStore(triggersStore, (state) => state.draft);
  const error = useStore(triggersStore, (state) => state.draftError);
  const busy = useStore(triggersStore, (state) => state.busy);
  const chosen = draft ? chosenDraft(draft, projects, workflows) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void confirmNewTrigger(dispatch, projects, workflows);
  };
  return (
    <Dialog open={draft !== undefined} onOpenChange={(next) => !next && cancelNewTrigger()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New trigger</DialogTitle>
          <DialogDescription>
            Starts a run of the workflow when wow first sees the event on a pull request of a
            followed plan or of one of its own runs in the project.
          </DialogDescription>
        </DialogHeader>
        {chosen && (
          <form onSubmit={submit} className="grid gap-4" aria-label="New trigger">
            <FormField
              id="trigger-project"
              label="Project"
              help={projects.length === 0 ? 'Add a project first under Projects.' : undefined}
            >
              <ChoiceSelect
                label="Project"
                value={chosen.projectId}
                placeholder="Choose a project"
                choices={projects.map((project) => ({ value: project.id, label: project.name }))}
                onValueChange={(projectId) => editNewTrigger({ projectId })}
              />
            </FormField>
            <FormField id="trigger-event" label="Event">
              <ChoiceSelect
                label="Event"
                value={chosen.event}
                placeholder="Choose an event"
                choices={eventChoices}
                onValueChange={(event) =>
                  editNewTrigger({ event: TriggerEvent.safeParse(event).data ?? '' })
                }
              />
            </FormField>
            <FormField
              id="trigger-workflow"
              label="Workflow"
              help={
                workflows.length === 0
                  ? 'Build a workflow first.'
                  : 'Its run works in the pull request’s working copy, or in a new one on its branch.'
              }
            >
              <ChoiceSelect
                label="Workflow"
                value={chosen.workflowId}
                placeholder="Choose a workflow"
                choices={workflows.map((workflow) => ({
                  value: workflow.id,
                  label: workflow.name,
                }))}
                onValueChange={(workflowId) => editNewTrigger({ workflowId })}
              />
            </FormField>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={cancelNewTrigger}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create trigger
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TriggerItem({ row }: { readonly row: TriggerRow }) {
  const dispatch = useDispatch();
  const { trigger } = row;
  const title = triggerTitle(row);
  return (
    <li
      data-testid={`trigger-${trigger.event}`}
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
    >
      <Switch
        aria-label={`${title}: on`}
        checked={trigger.enabled}
        onCheckedChange={(enabled) => void setTriggerEnabled(dispatch, trigger, enabled)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {row.event}
          <span className="text-muted-foreground"> starts </span>
          {row.workflow === undefined ? (
            <span className="text-destructive">a workflow that is gone</span>
          ) : (
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId: trigger.workflowId }}
              className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.workflow}
            </Link>
          )}
        </span>
        <span data-testid="trigger-last-run" className="text-2xs text-muted-foreground">
          {trigger.enabled ? 'On' : 'Off'}
          {' · '}
          {trigger.runId === null ? (
            'No run started yet'
          ) : (
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: trigger.runId }}
              className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Last run it started
            </Link>
          )}
        </span>
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete trigger: ${title}`}
        onClick={() => void removeTrigger(dispatch, row)}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

// The Triggers tab of the Workflows view (review loop spec 48, Interface): the event triggers
// of every project with their switch, and "New trigger".
export function TriggersTab() {
  const triggers = useTopic('triggers');
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const eventsEnabled = useSetting('triggers.eventsEnabled');
  const schedulerPaused = useSetting('scheduler.paused');
  const error = useStore(triggersStore, (state) => state.error);
  const groups = triggerGroups(triggers ?? [], projects, workflows);
  const held = triggersHeld(eventsEnabled, schedulerPaused);
  const newTrigger = (
    <Button type="button" size="sm" onClick={openNewTrigger}>
      <PlusIcon />
      New trigger
    </Button>
  );
  return (
    <div role="tabpanel" aria-label="Triggers" className="flex h-full min-h-0 flex-col">
      {groups.length === 0 ? (
        <EmptyState
          icon={ZapIcon}
          title="No event triggers yet"
          description="An event trigger starts a workflow run when a pull request wow follows is merged, its checks fail or a review comment arrives."
          action={newTrigger}
        />
      ) : (
        <>
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <h2 className="text-sm font-medium">Event triggers</h2>
              <p className="text-xs text-muted-foreground">
                A run starts when wow first sees the event on a pull request of a followed plan or
                of one of its own runs. Each event starts one run per trigger.
              </p>
            </div>
            {newTrigger}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {held !== undefined && (
              <p data-testid="triggers-held" className="pb-3 text-xs text-warning">
                {held}
              </p>
            )}
            {error && (
              <p role="alert" className="pb-3 text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex max-w-2xl flex-col gap-4">
              {groups.map((group) => (
                <section key={group.projectId} aria-label={group.project}>
                  <h3 className="pb-1.5 text-2xs font-medium text-muted-foreground">
                    {group.project}
                    <span className="ml-1 opacity-70">{group.rows.length}</span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {group.rows.map((row) => (
                      <TriggerItem key={row.trigger.id} row={row} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </>
      )}
      <NewTriggerDialog />
    </div>
  );
}
