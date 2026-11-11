import type { Project, ProjectGit, SettingRow } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderWithRuntime } from '@/test/render';
import { useProjectsGit } from './project-git';

// The palette and the Triggers tab word a project's events by the code host its git data names.
// That host depends on the stored GitLab site, so storing one asks the server again. Invented data.

const project: Project = {
  id: 'kettle',
  name: 'Kettle',
  cwd: '/work/kettle',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

const site = 'https://gitlab.example.invalid';

function fake() {
  let settingRows: SettingRow[] = [];
  const listeners = new Set<(rows: unknown) => void>();
  const asked: string[] = [];
  const git = (): ProjectGit => ({
    projectId: project.id,
    status: 'ok',
    remotes: [],
    primary: 'origin',
    branch: 'main',
    message: null,
    codeHost: settingRows.some((row) => row.value === site) ? 'gitlab' : 'github',
  });
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method) {
      asked.push(method);
      if (method === 'projects.git') return Promise.resolve({ projects: [git()] });
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      if (topic !== 'settings') {
        onData([]);
        return () => undefined;
      }
      listeners.add(onData);
      onData(settingRows);
      return () => listeners.delete(onData);
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime: Runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(createMemorySettingsSource()),
  };
  const store = (rows: SettingRow[]) => {
    settingRows = rows;
    for (const listener of listeners) listener(rows);
  };
  return { runtime, asked, store };
}

function CodeHost({ projects }: { projects: readonly Project[] }) {
  const git = useProjectsGit(projects);
  return <p>Code host: {git?.get(project.id)?.codeHost ?? 'not read'}</p>;
}

const projects = [project];

describe('useProjectsGit', () => {
  it('asks again when the GitLab site is stored, so the wording follows without a reload', async () => {
    const { runtime, asked, store } = fake();
    renderWithRuntime(<CodeHost projects={projects} />, runtime);
    expect(await screen.findByText('Code host: github')).toBeTruthy();
    await act(async () => {
      store([{ key: 'trackers.gitlab.baseUrl', scope: `project:${project.id}`, value: site }]);
      await Promise.resolve();
    });
    expect(await screen.findByText('Code host: gitlab')).toBeTruthy();
    const before = asked.length;
    await act(async () => {
      store([
        { key: 'trackers.gitlab.baseUrl', scope: `project:${project.id}`, value: site },
        { key: 'appearance.theme', scope: 'global', value: 'light' },
      ]);
      await Promise.resolve();
    });
    expect(asked.length).toBe(before);
  });
});
