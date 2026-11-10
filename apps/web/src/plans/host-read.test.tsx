import type { ChangeRequest, HostRead, PlanIntent, Project } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { planCommands } from './commands';
import { HostLink } from './host-read';

// What the Plans view shows when the host could not be read or answered something it should
// not (review loop spec 31 and 32). The data is invented.

const project: Project = {
  id: 'tea',
  name: 'Tea',
  cwd: '/home/me/tea',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-03T08:00:00.000Z',
};

const intent: PlanIntent = {
  id: 'tea:2026-01-tea-timer',
  projectId: 'tea',
  intentId: '2026-01-tea-timer',
  title: 'Tea timer',
  hasIntent: true,
  status: 'approved',
  rev: 1,
  spec: null,
  plan: null,
  source: 'files',
  units: [
    {
      key: 'U1',
      title: 'Count down',
      line: 3,
      dependsOn: [],
      blocked: null,
      contract: null,
      status: 'claimed',
      statusReason: 'Pull request #14 is open',
      changeRequestId: 'tea:14',
    },
  ],
  problems: [],
  followed: true,
};

const refused: HostRead = {
  id: 'plan:tea:2026-01-tea-timer',
  projectId: 'tea',
  scope: 'plan',
  host: 'github',
  hostName: 'ghe.example.invalid',
  branch: null,
  changeRequestIds: [],
  fetchedAt: null,
  error: {
    kind: 'refused',
    message:
      'ghe.example.invalid refused the GitHub token (401: Bad credentials). Check the GitHub token in Settings → Trackers.',
    setting: 'trackers.github.token',
    at: '2026-11-03T09:00:00.000Z',
  },
};

function runtimeWith(read: HostRead): Runtime {
  const topics: Readonly<Record<string, unknown[]>> = {
    planIntents: [intent],
    projects: [project],
    hostReads: [read],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: () => Promise.resolve([]),
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
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

// The palette command ids for the plan when its unit's pull request has this link.
const ids = (url: string) =>
  planCommands({
    intents: [intent],
    projects: [project],
    openIntent: intent,
    changeRequests: [{ id: 'tea:14', number: 14, url } as ChangeRequest],
  }).map((command) => command.id);

describe('a refused host read', () => {
  it('names the host and links to the setting', async () => {
    await renderApp('/plans/tea/2026-01-tea-timer', runtimeWith(refused));
    const error = await screen.findByTestId('host-error');
    expect(error.textContent).toContain('ghe.example.invalid refused the GitHub token (401');
    const link = within(error).getByRole('link', { name: /^Open .+ in Settings$/ });
    expect(link.getAttribute('href')).toBe('/settings/trackers');
    expect(screen.getByTestId('host-fetched').textContent).not.toBe('');
  });
});

describe('a link the host gave', () => {
  it('is a link only for a web address', () => {
    render(
      <>
        <HostLink href="https://ghe.example.invalid/acme/tea/pull/14">#14</HostLink>
        <HostLink href="javascript:alert(document.domain)">#15</HostLink>
        <HostLink href="file:///C:/Windows/System32/calc.exe">#16</HostLink>
      </>,
    );
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['#14']);
    expect(screen.getByText('#15').closest('a')).toBeNull();
    expect(screen.getByText('#16').closest('a')).toBeNull();
  });

  it('gets no palette command when it is not a web address', () => {
    expect(ids('https://ghe.example.invalid/acme/tea/pull/14')).toContain(
      'plans.unit.U1.changeRequest',
    );
    expect(ids('javascript:alert(document.domain)')).not.toContain('plans.unit.U1.changeRequest');
  });
});
