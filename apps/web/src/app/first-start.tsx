import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import { useTopic } from '@/chat/data';
import { ConnectAgentStep } from '@/providers/connect-step';
import { useRuntime, useSetting } from './runtime';

// The first-start gate (app assistant spec 25, 26; spec Decisions: it reuses the provider
// onboarding and stands in front of the app only while no provider is connected).
//
// It is up while `providers.offerSetup` is on and no provider instance has passed its test. An
// instance the server has not tested yet is tested at start (ProviderDialogs), so the gate waits
// for that answer instead of showing for a moment. Once it is up it stays until an instance
// passes, even while a Test it started runs. When one passes, the setting is turned off, so a
// provider removed later leaves the app usable (spec 27), and the assistant opens to greet.

export interface FirstStartState {
  // The gate went up in this window.
  readonly up: boolean;
  // The first-start step just finished; the Assistant view sends the greeting once it is open.
  readonly greet: boolean;
}

export const firstStartStore = createStore<FirstStartState>(() => ({ up: false, greet: false }));

export function useFirstStart(): boolean {
  const { connection, settings } = useRuntime();
  const navigate = useNavigate();
  const settingsReady = useStore(settings, (state) => state.ready);
  const offer = useSetting('providers.offerSetup');
  const instances = useTopic('providerInstances');
  const up = useStore(firstStartStore, (state) => state.up);
  const passed = instances?.some((instance) => instance.status === 'ready') ?? false;
  const untested = instances?.some((instance) => instance.status === 'unknown') ?? false;
  const gated =
    connection !== undefined &&
    settingsReady &&
    offer &&
    instances !== undefined &&
    !passed &&
    (up || !untested);

  useEffect(() => {
    if (gated && !up) firstStartStore.setState({ up: true });
  }, [gated, up]);

  useEffect(() => {
    if (!passed || !settingsReady) return;
    if (offer) void settings.write('providers.offerSetup', false);
    if (up) {
      firstStartStore.setState({ up: false, greet: true });
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
