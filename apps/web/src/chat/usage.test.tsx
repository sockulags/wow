import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from './draft';
import { rangeDays, UsageView } from './usage-view';

// The usage view (chat overview spec 39, 40). All invented.

const row = (day: string, model: string, extra: Record<string, unknown> = {}) => ({
  day,
  projectId: 'tea',
  providerInstanceId: 'claude',
  model,
  assistant: false,
  turns: 1,
  inputTokens: 1000,
  outputTokens: 200,
  cachedInputTokens: 0,
  costUsd: 0.5,
  unknownCost: 0,
  noUsage: 0,
  ...extra,
});

function show() {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (() =>
      Promise.resolve({
        rows: [
          row('2026-11-20', 'opus'),
          row('2026-11-21', 'sonnet', { costUsd: 0, unknownCost: 1 }),
        ],
      })) as Connection['request'],
    subscribe(_topic, _params, onData) {
      onData([]);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
      }}
    >
      <UsageView />
    </RuntimeProvider>,
  );
}

describe('the usage view (spec 39, 40)', () => {
  it('covers the days of each range', () => {
    const today = { year: 2026, month: 11, day: 23 };
    expect(rangeDays('week', today)).toEqual({
      from: { year: 2026, month: 11, day: 17 },
      to: { year: 2026, month: 11, day: 24 },
    });
    expect(rangeDays('thisMonth', today).from).toEqual({ year: 2026, month: 11, day: 1 });
  });

  it('sums the days, keeps an unknown cost apart, and narrows to a model', async () => {
    const user = userEvent.setup();
    show();
    expect((await screen.findByTestId('usage-total')).textContent).toBe(
      '2,400 tokens · $0.50 + 1 unknown · 2 turns',
    );
    expect(screen.getAllByTestId('usage-day')).toHaveLength(2);
    const sonnet = screen
      .getAllByTestId('usage-by-model')
      .find((button) => button.textContent?.startsWith('sonnet'));
    await user.click(sonnet as HTMLElement);
    expect(screen.getAllByTestId('usage-day').map((day) => day.textContent)).toEqual([
      '2026-11-211,200 · —',
    ]);
  });
});
