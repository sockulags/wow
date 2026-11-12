import type { Command, WorkflowRun } from '@wow/contracts';
import { createStore } from 'zustand';
import { errorMessage } from '@/chat/data';
import { gateOf, reviewedStep } from './model';

// Send back at a gate (review loop spec 16 to 18). The note being written is view state like an
// open dialog: it lives here so the gate bar, the palette and the keybinding act on the same
// field. Nothing about the run is kept; whether it waits comes from the run row. A note belongs to
// the gate it was written at: once the run waits at another gate, it is not offered there.
export interface SendBackDraft {
  readonly runId: string;
  readonly gate: string;
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

// Which wait of the run this is: where it waits, how far its path has gone, and which result of
// the reviewed step is under review.
function gateKey(run: WorkflowRun): string {
  const gate = gateOf(run);
  const reviewed = reviewedStep(run);
  return [
    gate?.stepIndex,
    gate?.position,
    run.path?.length ?? 0,
    reviewed?.attempt ?? 1,
    reviewed?.endedAt ?? '',
  ].join(':');
}

// The note field of this run, while it is open and the run still waits at the gate it was
// written at.
export const sendBackDraft = (state: GateState, run: WorkflowRun): SendBackDraft | undefined =>
  state.sendBack?.runId === run.id && state.sendBack.gate === gateKey(run) && canSendBack(run)
    ? state.sendBack
    : undefined;

export function openSendBack(run: WorkflowRun): void {
  const gate = gateKey(run);
  gateStore.setState((state) =>
    state.sendBack?.runId === run.id && state.sendBack.gate === gate
      ? state
      : { sendBack: { runId: run.id, gate, note: '', busy: false, error: undefined } },
  );
}

export function setSendBackNote(note: string): void {
  gateStore.setState((state) =>
    state.sendBack ? { sendBack: { ...state.sendBack, note, error: undefined } } : state,
  );
}

// A comment on a diff line in the run's Changes (agent workbench spec 80) goes into the note as
// `src/bell.ts:12 – text`, one per line; the note opens when it is not open yet.
// A removed line's number is the base's, so the note says so; otherwise it reads as today's line.
export const lineComment = (path: string, line: number, text: string, removed = false): string =>
  `${path}:${line}${removed ? ' (removed)' : ''} – ${text}`;

export function addSendBackComment(run: WorkflowRun, comment: string): void {
  if (!canSendBack(run)) return;
  openSendBack(run);
  gateStore.setState((state) => {
    if (!state.sendBack) return state;
    const kept = state.sendBack.note.replace(/\s+$/u, '');
    const note = kept === '' ? comment : `${kept}\n${comment}`;
    return { sendBack: { ...state.sendBack, note, error: undefined } };
  });
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
