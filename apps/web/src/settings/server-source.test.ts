import { RpcClientError, type Connection, type ConnectionState } from '@wow/client-runtime';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createServerSettingsSource } from './server-source';

// Spec 33: with a server the settings page shows the stored global values and writes through
// setting.set / setting.reset, so the change reaches the server at once.

function connectionWith(rows: unknown[], fail?: RpcClientError) {
  const requests: unknown[] = [];
  let push: ((data: unknown) => void) | undefined;
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(_method, params) {
      requests.push(params);
      return fail
        ? Promise.reject(fail)
        : Promise.resolve({ commandId: 'c', seqs: [1], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      expect(topic).toBe('settings');
      push = onData;
      onData(rows);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return { connection, requests, push: (data: unknown) => push?.(data) };
}

describe('server settings source', () => {
  it('shows global values only and follows pushes', () => {
    const { connection, push } = connectionWith([
      { key: 'calendar.lookaheadDays', scope: 'global', value: 21 },
      { key: 'providers.testTimeoutMs', scope: 'provider:work', value: 30_000 },
    ]);
    const seen: unknown[] = [];
    createServerSettingsSource(connection).watch((values) => seen.push(values));
    push([]);
    expect(seen).toEqual([{ 'calendar.lookaheadDays': 21 }, {}]);
  });

  it('writes and resets global values with commands', async () => {
    const { connection, requests } = connectionWith([]);
    const source = createServerSettingsSource(connection);
    expect(await source.write('appearance.density', 'compact')).toEqual({ ok: true });
    await source.reset('appearance.density');
    expect(requests).toMatchObject([
      {
        command: {
          type: 'setting.set',
          key: 'appearance.density',
          scope: 'global',
          value: 'compact',
        },
      },
      { command: { type: 'setting.reset', key: 'appearance.density', scope: 'global' } },
    ]);
  });

  it('reports what the server rejected', async () => {
    const { connection } = connectionWith(
      [],
      new RpcClientError({
        code: 'rejected',
        message: 'Invalid value for calendar.lookaheadDays',
        data: [{ message: 'Too big: expected number to be <=90' }],
      }),
    );
    expect(
      await createServerSettingsSource(connection).write('calendar.lookaheadDays', 500),
    ).toEqual({
      ok: false,
      issues: ['Too big: expected number to be <=90'],
    });
  });
});
