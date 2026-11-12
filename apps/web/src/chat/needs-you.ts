import type { AssistantProposal, Thread, WorkflowRun } from '@wow/contracts';
import { useEffect, type RefObject } from 'react';
import { createStore, useStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { gateRunForThread, reviewedStep } from '@/workflows/model';
import { threadTitle } from './model';

// "Next that needs you" (agent workbench spec 76): whatever waits for the user, oldest first,
// read from the persisted rows the app already subscribes to. A thread that needs the user holds
// an approval, a question or a plan card; a run waits at a gate; the assistant waits on a
// proposal. The keyboard lands on it once its view is on screen.

export interface NeedsYouTarget {
  // What the waiting element answers to: `thread:<id>`, `run:<id>` or `proposal:<id>`.
  readonly key: string;
  // Since when it waits, as stored by the server.
  readonly at: string;
  readonly title: string;
  readonly path: string;
  readonly open: NeedsYouRoute;
}

export type NeedsYouRoute =
  | { readonly to: '/chat/$threadId'; readonly params: { readonly threadId: string } }
  | { readonly to: '/workflows/runs/$runId'; readonly params: { readonly runId: string } }
  | { readonly to: '/assistant' };

export function needsYouTargets({
  threads,
  runs,
  proposals,
}: {
  threads: readonly Thread[];
  runs: readonly WorkflowRun[];
  proposals: readonly AssistantProposal[];
}): NeedsYouTarget[] {
  const targets: NeedsYouTarget[] = [
    // A thread changes nothing else while it waits, so its last change is when it began to.
    // A step's thread that needs the user because its run waits at the gate after it is the
    // run's gate, listed once below.
    ...threads
      .filter((thread) => thread.state === 'needs_you' && !gateRunForThread(thread, runs))
      .map((thread) => ({
        key: `thread:${thread.id}`,
        at: thread.updatedAt,
        title: threadTitle(thread),
        path: `/chat/${thread.id}`,
        open: { to: '/chat/$threadId' as const, params: { threadId: thread.id } },
      })),
    ...runs
      .filter((run) => run.state === 'waiting')
      .map((run) => ({
        key: `run:${run.id}`,
        at: reviewedStep(run)?.endedAt ?? run.startedAt,
        title: 'Gate',
        path: `/workflows/runs/${run.id}`,
        open: { to: '/workflows/runs/$runId' as const, params: { runId: run.id } },
      })),
    ...proposals
      .filter((proposal) => proposal.state === 'pending')
      .map((proposal) => ({
        key: `proposal:${proposal.id}`,
        at: proposal.at,
        title: proposal.title,
        path: '/assistant',
        open: { to: '/assistant' as const },
      })),
  ];
  return targets.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// The target after the one on screen, so pressing the key again moves on; the oldest otherwise.
export function nextNeedsYou(
  targets: readonly NeedsYouTarget[],
  pathname: string,
  last: string | undefined,
): NeedsYouTarget | undefined {
  const at = targets.findIndex((target) => target.key === last && target.path === pathname);
  return at === -1 ? targets[0] : (targets[at + 1] ?? targets[0]);
}

interface NeedsYouState {
  // The target the keyboard should land on, a count so the same target can be asked again, and
  // whether it took the focus already.
  readonly request:
    { readonly key: string; readonly seq: number; readonly landed: boolean } | undefined;
  // The target the keyboard landed on last, for the next press.
  readonly last: string | undefined;
  // Set by the target that took the focus, so the view around it does not take it back.
  readonly landed: string | undefined;
}

export const needsYouStore = createStore<NeedsYouState>(() => ({
  request: undefined,
  last: undefined,
  landed: undefined,
}));

export function requestNeedsYouFocus(key: string): void {
  needsYouStore.setState((state) => ({
    request: { key, seq: (state.request?.seq ?? 0) + 1, landed: false },
    last: key,
  }));
}

// The request holds until the user does something after it landed: a view that settles after
// the target took the focus (a gate bar moving from the run view into the side panel) remounts
// the target, which then takes the focus again instead of leaving it on the page.
function letGo(): void {
  if (needsYouStore.getState().request?.landed) needsYouStore.setState({ request: undefined });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', letGo, true);
  window.addEventListener('keydown', letGo, true);
}

// True once, right after the target with this key took the focus.
export function takeLanded(key: string): boolean {
  if (needsYouStore.getState().landed !== key) return false;
  needsYouStore.setState({ landed: undefined });
  return true;
}

// The waiting element puts the keyboard on itself when it is the one asked for. It tries again on
// each render until the focus lands: a panel that is still opening takes no focus yet.
export function useNeedsYouFocus(
  key: string | undefined,
  element: RefObject<HTMLElement | null>,
): void {
  const request = useStore(needsYouStore, (state) => state.request);
  useEffect(() => {
    if (key === undefined || request?.key !== key) return;
    const target = element.current;
    if (!target || document.activeElement === target) return;
    // Landed once, it only takes the focus back from the page itself (its first place unmounted).
    if (request.landed && document.activeElement !== document.body) return;
    target.focus();
    if (document.activeElement !== target) return;
    needsYouStore.setState({ request: { ...request, landed: true }, landed: key });
  });
}

export function needsYouCommands(
  targets: readonly NeedsYouTarget[],
  pathname: string,
): AppCommand[] {
  if (targets.length === 0) return [];
  const last = needsYouStore.getState().last;
  const target = nextNeedsYou(targets, pathname, last);
  return [
    {
      id: 'chat.nextNeedsYou',
      title: 'Next that needs you',
      group: 'Actions',
      keywords: ['waiting', 'approval', 'question', 'gate', 'proposal', 'plan'],
      keybinding: 'keybindings.nextNeedsYou',
      ...(target ? { detail: target.title } : {}),
      run: ({ navigate }) => {
        const next = nextNeedsYou(targets, pathname, needsYouStore.getState().last);
        if (!next) return;
        requestNeedsYouFocus(next.key);
        if (pathname !== next.path) void navigate(next.open);
      },
    },
  ];
}
