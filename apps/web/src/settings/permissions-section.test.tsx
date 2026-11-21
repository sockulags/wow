import type { AssistantPermission, Command } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox, type Outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';

// Settings → Assistant → Permissions (chief of staff spec 4), against a fake server. Projects,
// workflows and permissions are invented.

const permissions: AssistantPermission[] = [
  {
    id: 'p1',
    kind: 'startRuns',
    projectIds: ['tea'],
    workflowIds: ['delivery'],
    dailyLimit: 3,
    paused: false,
    addedAt: '2026-11-20T08:00:00.000Z',
  },
];

interface Sent {
  readonly method: string;
  readonly params: unknown;
}

const topics: Record<string, unknown[]> = {
  projects: [
    {
      id: 'tea',
      name: 'Tea',
      cwd: '/home/me/tea',
      defaultProviderInstanceId: null,
      defaultModel: null,
      createdAt: '2026-11-01T08:00:00.000Z',
    },
  ],
  workflows: [
    {
      id: 'delivery',
      name: 'Delivery',
      templateKind: null,
      steps: [],
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:00:00.000Z',
    },
  ],
};

function fake(box: Outbox<Sent>): Runtime {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      box.record({ method, params });
      const { commandId } = params as { commandId: string };
      return Promise.resolve({ commandId, seqs: [box.sent.length], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, {
        'providers.offerSetup': false,
        'assistant.permissions': permissions,
      }),
    ),
  };
}

const commandsSent = (box: Outbox<Sent>): Command[] =>
  box.sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Command }).command);

describe('Permissions', () => {
  it('lists each permission with what it covers, pauses one and adds one', async () => {
    const box = outbox<Sent>();
    await renderApp('/settings/assistant', fake(box));
    const section = within(await screen.findByRole('region', { name: 'Permissions' }));
    const [row] = section.getAllByTestId('assistant-permission');
    expect(row?.textContent).toContain('Start runs');
    expect(row?.textContent).toContain('Tea · Delivery');
    expect(row?.textContent).toContain('3 a day');

    const user = userEvent.setup();
    await user.click(section.getByRole('switch', { name: 'Paused: Start runs' }));
    expect(commandsSent(box).at(-1)).toMatchObject({
      key: 'assistant.permissions',
      value: [{ id: 'p1', paused: true }],
    });

    const add = within(section.getByRole('region', { name: 'Add a permission' }));
    const button = add.getByRole('button', { name: 'Add permission' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(add.getByRole('checkbox', { name: 'Tea' }));
    await user.click(add.getByRole('checkbox', { name: 'Delivery' }));
    await user.click(button);
    const sent = commandsSent(box).at(-1) as Extract<Command, { type: 'setting.set' }>;
    expect((sent.value as AssistantPermission[])[1]).toMatchObject({
      kind: 'planRuns',
      projectIds: ['tea'],
      workflowIds: ['delivery'],
      paused: false,
    });
  });
});
