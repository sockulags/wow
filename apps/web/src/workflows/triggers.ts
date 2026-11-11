import {
  isEventTrigger,
  projectCodeHost,
  TriggerEvent as TriggerEvents,
  triggerEventLabel,
  type EventTrigger,
  type HostKind,
  type HostRead,
  type Project,
  type Trigger,
  type TriggerEvent,
  type Workflow,
} from '@wow/contracts';
import { createStore } from 'zustand';
import { errorMessage } from '@/chat/data';
import { offerUndo } from '@/lib/feedback';

// View state of the Triggers tab (review loop spec 48): whether "New trigger" is open and what
// it holds so far, and what the server said to the last command it refused. It lives here so the
// buttons, the dialog and the palette commands act on the same thing. What a trigger is comes
// from its row alone.
export interface TriggerDraft {
  readonly projectId: string;
  readonly event: TriggerEvent | '';
  readonly workflowId: string;
}

export interface TriggersView {
  readonly draft: TriggerDraft | undefined;
  // The server's answer to the last create that failed; shown in the dialog.
  readonly draftError: string | undefined;
  // The server's answer to the last switch or delete that failed; shown above the list.
  readonly error: string | undefined;
  readonly busy: boolean;
}

export const triggersStore = createStore<TriggersView>(() => ({
  draft: undefined,
  draftError: undefined,
  error: undefined,
  busy: false,
}));

export const triggersPath = '/workflows/triggers';

const emptyDraft: TriggerDraft = { projectId: '', event: '', workflowId: '' };

export const openNewTrigger = (): void =>
  triggersStore.setState({ draft: emptyDraft, draftError: undefined });

export const cancelNewTrigger = (): void =>
  triggersStore.setState({ draft: undefined, draftError: undefined, busy: false });

export const editNewTrigger = (changes: Partial<TriggerDraft>): void =>
  triggersStore.setState(({ draft }) => (draft ? { draft: { ...draft, ...changes } } : {}));

type Send = (
  command:
    | {
        type: 'trigger.create';
        triggerId: string;
        projectId: string;
        event: TriggerEvent;
        workflowId: string;
      }
    | { type: 'trigger.setEnabled'; triggerId: string; enabled: boolean }
    | { type: 'trigger.delete'; triggerId: string },
) => Promise<unknown>;

// A single project or workflow needs no choosing.
export function chosenDraft(
  draft: TriggerDraft,
  projects: readonly Project[],
  workflows: readonly Workflow[],
): TriggerDraft {
  return {
    projectId: draft.projectId || (projects.length === 1 ? (projects[0]?.id ?? '') : ''),
    event: draft.event,
    workflowId: draft.workflowId || (workflows.length === 1 ? (workflows[0]?.id ?? '') : ''),
  };
}

// Creates the trigger the dialog describes. A choice that is missing, or a refusal from the
// server (the same trigger exists already), stays in the dialog to be read.
export async function confirmNewTrigger(
  send: Send,
  projects: readonly Project[],
  workflows: readonly Workflow[],
): Promise<void> {
  const { draft } = triggersStore.getState();
  if (!draft) return;
  const { projectId, event, workflowId } = chosenDraft(draft, projects, workflows);
  const missing =
    projectId === ''
      ? 'Choose the project whose pull requests the trigger listens to'
      : event === ''
        ? 'Choose the event that starts the run'
        : workflowId === ''
          ? 'Choose the workflow to run'
          : undefined;
  if (missing !== undefined || event === '') {
    triggersStore.setState({ draftError: missing });
    return;
  }
  triggersStore.setState({ busy: true, draftError: undefined });
  try {
    await send({
      type: 'trigger.create',
      triggerId: globalThis.crypto.randomUUID(),
      projectId,
      event,
      workflowId,
    });
    triggersStore.setState({ draft: undefined, busy: false });
  } catch (failure) {
    triggersStore.setState({ draftError: errorMessage(failure), busy: false });
  }
}

const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
  triggersStore.setState({ error: undefined });
  try {
    await work();
    return true;
  } catch (failure) {
    triggersStore.setState({ error: errorMessage(failure) });
    return false;
  }
};

export const setTriggerEnabled = (
  send: Send,
  trigger: EventTrigger,
  enabled: boolean,
): Promise<boolean> =>
  attempt(() => send({ type: 'trigger.setEnabled', triggerId: trigger.id, enabled }));

export const deleteTrigger = (send: Send, trigger: EventTrigger): Promise<boolean> =>
  attempt(() => send({ type: 'trigger.delete', triggerId: trigger.id }));

// Puts a deleted trigger back, as it was switched. The events it had seen are forgotten, which
// only matters for an event the host shows a second time.
export async function restoreTrigger(send: Send, trigger: EventTrigger): Promise<void> {
  const { id: triggerId, projectId, event, workflowId } = trigger;
  await send({ type: 'trigger.create', triggerId, projectId, event, workflowId });
  if (!trigger.enabled) await send({ type: 'trigger.setEnabled', triggerId, enabled: false });
}

// Deletes at once and offers Undo, like every delete that can be put back.
export async function removeTrigger(send: Send, row: TriggerRow): Promise<void> {
  if (!(await deleteTrigger(send, row.trigger))) return;
  offerUndo({
    message: 'Trigger deleted',
    description: triggerTitle(row),
    undoneMessage: 'Trigger restored',
    undo: () => restoreTrigger(send, row.trigger),
  });
}

export interface TriggerRow {
  readonly trigger: EventTrigger;
  readonly event: string;
  // The workflow's name, or undefined when the workflow is gone.
  readonly workflow: string | undefined;
}

export interface TriggerGroup {
  readonly projectId: string;
  readonly project: string;
  readonly rows: readonly TriggerRow[];
}

export const eventTriggers = (triggers: readonly Trigger[]): EventTrigger[] =>
  triggers.filter(isEventTrigger);

// The events a trigger can listen to, in the words of the project's host.
export const eventChoices = (host: HostKind) =>
  TriggerEvents.options.map((event) => ({ value: event, label: triggerEventLabel(event, host) }));

// The event triggers by project, projects by name and triggers in the order they were made.
export function triggerGroups(
  triggers: readonly Trigger[],
  projects: readonly Project[],
  workflows: readonly Workflow[],
  reads: readonly HostRead[] = [],
): TriggerGroup[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const workflowNames = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const groups = new Map<string, TriggerRow[]>();
  for (const trigger of eventTriggers(triggers).toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    const rows = groups.get(trigger.projectId) ?? [];
    groups.set(trigger.projectId, rows);
    rows.push({
      trigger,
      event: triggerEventLabel(trigger.event, projectCodeHost(reads, trigger.projectId)),
      workflow: workflowNames.get(trigger.workflowId),
    });
  }
  return [...groups]
    .map(([projectId, rows]) => ({
      projectId,
      project: projectNames.get(projectId) ?? projectId,
      rows,
    }))
    .toSorted((a, b) => a.project.localeCompare(b.project));
}

// "Pull request merged → Fix it", as rows and palette commands name a trigger.
export const triggerTitle = (row: TriggerRow): string =>
  `${row.event} → ${row.workflow ?? 'a workflow that is gone'}`;

// Why event triggers start nothing right now, if so (review loop spec 52).
export function triggersHeld(eventsEnabled: boolean, schedulerPaused: boolean): string | undefined {
  if (!eventsEnabled) {
    return 'Event triggers are switched off in Settings → Event triggers. Events seen meanwhile start nothing, also not later.';
  }
  if (schedulerPaused) {
    return 'The scheduler is paused. Events seen meanwhile start nothing, also not later.';
  }
  return undefined;
}
