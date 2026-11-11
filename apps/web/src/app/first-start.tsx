import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import { useDispatch, useTopic } from '@/chat/data';
import { ConnectAgentStep } from '@/providers/connect-step';
import { useRuntime, useSetting } from './runtime';

// The first-start gate (app assistant spec 25, 26; spec Decisions: it reuses the provider
// onboarding and stands in front of the app only while no provider is connected).
//
// It goes up only for an install without any provider instance, while `providers.offerSetup`
// is on. An install that has an instance, whatever its status (an upgrade whose instance fails
// its test today), is never gated: the Assistant view's own connect step covers a provider that
// does not work. Once it is up it stays until an instance passes, even while the instances its
// Test buttons create fail. When one passes, the setting is turned off, so a provider removed
// later leaves the app usable (spec 27), and the assistant opens to greet. The server owns the
// greeting: it is asked for when the gate goes up, kept owed, and sent once the assistant can
// run, so a reload anywhere in between does not lose it.

export interface FirstStartState {
  // The gate went up in this window.
  readonly up: boolean;
}

export const firstStartStore = createStore<FirstStartState>(() => ({ up: false }));

export function useFirstStart(): boolean {
  const { connection, settings } = useRuntime();
  const navigate = useNavigate();
  const send = useDispatch();
  const settingsReady = useStore(settings, (state) => state.ready);
  const offer = useSetting('providers.offerSetup');
  const instances = useTopic('providerInstances');
  const up = useStore(firstStartStore, (state) => state.up);
  const passed = instances?.some((instance) => instance.status === 'ready') ?? false;
  const gated =
    connection !== undefined &&
    settingsReady &&
    offer &&
    instances !== undefined &&
    !passed &&
    (up || instances.length === 0);

  useEffect(() => {
    if (!gated || up) return;
    firstStartStore.setState({ up: true });
    // Asked again at the next start while the gate is still up, so a failure here is not lost.
    send({ type: 'thread.greetAssistant' }).catch(() => undefined);
  }, [gated, up, send]);

  useEffect(() => {
    if (!passed || !settingsReady) return;
    if (offer) void settings.write('providers.offerSetup', false);
    if (up) {
      firstStartStore.setState({ up: false });
      void navigate({ to: '/assistant' });
    }
  }, [passed, settingsReady, offer, up, settings, navigate]);

  return gated;
}

// The whole window while the gate is up: the one step, nothing else of the app.
export function FirstStart() {
  return (
    <div
      data-testid="first-start"
      className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-6 py-12"
    >
      <ConnectAgentStep />
    </div>
  );
}
