import type { Command, WorkflowRun } from '@wow/contracts';
import { createStore } from 'zustand';
import { errorMessage } from '@/chat/data';
import { gateOf, reviewedStep } from './model';

// Send back at a gate (review loop spec 16 to 18). The note being written is view state like an
// open dialog: it lives here so the gate bar, the palette and the keybinding act on the same
// field. Nothing about the run is kept; whether it waits comes from the run row.
export interface SendBackDraft {
  readonly runId: string;
  readonly note: string;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export interface GateState {
  readonly sendBack: SendBackDraft | undefined;
}

export const gateStore = createStore<GateState>(() => ({ sendBack: undefined }));

export const emptyNoteMessage = 'Write what should change before you send the step back.';

// A step can be sent back when the run waits and a step has run: before the first step there is
// nothing to do again. At the limit the answers are to run the step once more or to stop
// (workflow branches spec 9).
export function canSendBack(run: WorkflowRun): boolean {
  const gate = gateOf(run);
  return (
    gate !== undefined && gate.limit === undefined && reviewedStep(run)?.threadId !== undefined
  );
}

// The note field of this run, while it is open and the run still waits.
export const sendBackDraft = (state: GateState, run: WorkflowRun): SendBackDraft | undefined =>
  state.sendBack?.runId === run.id && canSendBack(run) ? state.sendBack : undefined;

export function openSendBack(runId: string): void {
  gateStore.setState((state) =>
    state.sendBack?.runId === runId
      ? state
      : { sendBack: { runId, note: '', busy: false, error: undefined } },
  );
}

export function setSendBackNote(note: string): void {
  gateStore.setState((state) =>
    state.sendBack ? { sendBack: { ...state.sendBack, note, error: undefined } } : state,
  );
}

export const cancelSendBack = (): void => gateStore.setState({ sendBack: undefined });

const patch = (runId: string, changes: Partial<SendBackDraft>): void =>
  gateStore.setState((state) =>
    state.sendBack?.runId === runId ? { sendBack: { ...state.sendBack, ...changes } } : state,
  );

// Sends the note. An empty one is refused here with the same sentence the server gives, so
// nothing is sent; the field closes once the server took the command.
export async function confirmSendBack(send: (command: Command) => Promise<unknown>): Promise<void> {
  const draft = gateStore.getState().sendBack;
  if (!draft || draft.busy) return;
  const { runId, note } = draft;
  if (note.trim() === '') {
    patch(runId, { error: emptyNoteMessage });
    return;
  }
  patch(runId, { busy: true, error: undefined });
  try {
    await send({ type: 'workflowRun.sendBack', runId, note });
    gateStore.setState((state) =>
      state.sendBack?.runId === runId ? { sendBack: undefined } : state,
    );
  } catch (failure) {
    patch(runId, { busy: false, error: errorMessage(failure) });
  }
}
