import type { ReportedLimit } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen } from '@testing-library/react';
import { createStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from './draft';
import { isStale, LimitChip, LimitList, limitName, topLimit } from './limits';

// Plan limits in the composer bar and the lists (chat overview spec 26 to 28). All invented.

const hour = 3_600_000;
const limit = (overrides: Partial<ReportedLimit>): ReportedLimit => ({
  window: 'fiveHour',
  label: null,
  usedPercent: 40,
  resetsAt: new Date(Date.now() + hour).toISOString(),
  state: 'ok',
  reportedAt: new Date().toISOString(),
  ...overrides,
});

function show(limits: ReportedLimit[], node: 'chip' | 'list') {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (() => Promise.resolve(undefined)) as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topic === 'providerLimits' ? [{ providerInstanceId: 'claude', limits }] : []);
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
      {node === 'chip' ? <LimitChip providerInstanceId="claude" /> : <LimitList limits={limits} />}
    </RuntimeProvider>,
  );
}

describe('plan limits (spec 26 to 28)', () => {
  it('names windows and finds the highest current one', () => {
    expect(limitName({ window: 'weekModel', label: 'Opus' })).toBe('Week, Opus');
    const old = limit({ usedPercent: 99, resetsAt: new Date(Date.now() - hour).toISOString() });
    expect(isStale(old, Date.now())).toBe(true);
    const week = limit({ window: 'week', usedPercent: 60 });
    expect(topLimit([old, limit({}), week], Date.now())).toBe(week);
  });

  it('shows the chip only from the warning on', () => {
    show([limit({ usedPercent: 50 })], 'chip');
    expect(screen.queryByTestId('limit-chip')).toBeNull();
  });

  it('shows the highest window at the warning', () => {
    show([limit({ usedPercent: 84 })], 'chip');
    expect(screen.getByTestId('limit-chip').textContent).toMatch(/^5 h: 84 % · resets /);
  });

  it('says a window that reset was not reported since', () => {
    show([limit({ resetsAt: new Date(Date.now() - hour).toISOString() })], 'list');
    expect(screen.getByTestId('limit-list').textContent).toContain('not reported since');
  });
});
