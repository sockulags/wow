import { createStore } from 'zustand';
import { errorMessage } from '@/chat/data';

// View state of a plan's "Run ready units" and Stop (review loop spec 40 and 45): which plan
// run's Stop question is open, and what the server said to a start or stop that it refused. It
// lives here so the buttons, the palette commands and the dialog act on the same thing. What a
// plan run is comes from its row alone.
export interface PlanRunView {
  // The plan run whose "Stop?" question is on screen.
  readonly stopping: string | undefined;
  // The server's answer to the last start or stop that failed, by plan.
  readonly error: { readonly planId: string; readonly message: string } | undefined;
}

export const planRunStore = createStore<PlanRunView>(() => ({
  stopping: undefined,
  error: undefined,
}));

export const askStopPlanRun = (planRunId: string): void =>
  planRunStore.setState({ stopping: planRunId });

export const cancelStopPlanRun = (): void => planRunStore.setState({ stopping: undefined });

type Send = (
  command:
    | { type: 'planRun.start'; planRunId: string; planId: string; workflowId: string }
    | { type: 'planRun.stop'; planRunId: string },
) => Promise<unknown>;

const attempt = async (planId: string, work: () => Promise<unknown>): Promise<void> => {
  planRunStore.setState({ error: undefined });
  try {
    await work();
  } catch (failure) {
    planRunStore.setState({ error: { planId, message: errorMessage(failure) } });
  }
};

// "Run ready units": asks the server to start a plan run with this workflow. A refusal (a stale
// plan, a plan run already going) stays to be read above the units.
export const startPlanRun = (send: Send, planId: string, workflowId: string): Promise<void> =>
  attempt(planId, () =>
    send({
      type: 'planRun.start',
      planRunId: globalThis.crypto.randomUUID(),
      planId,
      workflowId,
    }),
  );

// Stops the plan run the question is about, after the user confirmed.
export async function confirmStopPlanRun(send: Send, planId: string): Promise<void> {
  const planRunId = planRunStore.getState().stopping;
  if (planRunId === undefined) return;
  planRunStore.setState({ stopping: undefined });
  await attempt(planId, () => send({ type: 'planRun.stop', planRunId }));
}
