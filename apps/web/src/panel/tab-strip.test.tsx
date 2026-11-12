import { hostItemReadId, type HostItemRead, type HostItemRef } from '@wow/contracts';
import type { Connection, ConnectionState } from '@wow/client-runtime';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import type { PanelTabs } from '@/app/runtime';
import { createTestRuntime, renderWithRuntime } from '@/test/render';
import { PanelTabStrip } from './tabs';

// A view's host tabs can belong to different threads; each tab shows its own thread's read.

const issue = (id: string): HostItemRef => ({
  host: 'github',
  kind: 'issue',
  site: 'https://ghe.example.invalid',
  path: 'acme/tea',
  id,
  url: `https://ghe.example.invalid/acme/tea/issues/${id}`,
});

const readIn = (threadId: string, item: HostItemRef): HostItemRead => ({
  id: hostItemReadId(threadId, item),
  scope: 'thread',
  threadId,
  item,
  hostName: 'ghe.example.invalid',
  fetchedAt: '2026-11-12T09:00:00.000Z',
  error: null,
  data: {
    kind: 'issue',
    issue: {
      host: 'github',
      number: Number(item.id),
      title: 'Invented',
      state: 'open',
      author: 'jon',
      labels: [],
      body: '',
      url: item.url,
      comments: [],
    },
  },
});

describe('panel tab strip', () => {
  it('names each host tab from its own thread’s reads', async () => {
    const first = issue('3');
    const second = issue('5');
    const reads: Readonly<Record<string, HostItemRead[]>> = {
      'step-1': [readIn('step-1', first)],
      'step-2': [readIn('step-2', second)],
    };
    const connection: Connection = {
      state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
      request: () => Promise.resolve([]),
      subscribe(topic, params, onData) {
        const threadId = (params as { threadId?: string } | null)?.threadId ?? '';
        onData(topic === 'hostItemReads' ? (reads[threadId] ?? []) : []);
        return () => undefined;
      },
      retry: () => undefined,
      close: () => undefined,
    };
    const tabs: PanelTabs = {
      tabs: [
        { kind: 'host', id: 'a', host: { threadId: 'step-1', item: first, from: '/calendar' } },
        { kind: 'host', id: 'b', host: { threadId: 'step-2', item: second, from: '/calendar' } },
      ],
      selected: 'a',
      history: [],
    };
    renderWithRuntime(<PanelTabStrip route="/calendar" tabs={tabs} baseLabel="Details" />, {
      ...createTestRuntime(),
      connection,
    });
    expect(await screen.findByRole('tab', { name: 'Issue #5' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Issue #3' })).toBeTruthy();
  });
});
