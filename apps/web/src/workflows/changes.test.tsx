import type { Project, RunDiff, RunDiffFile, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import {
  changesStore,
  emptyReason,
  lineChanges,
  parsePatch,
  stepUnderReview,
  validateRunSearch,
  visibleFiles,
} from './changes';
import { workflowCommands } from './commands';

// The Changes tab (review loop spec 11 to 13) against a fake server that answers
// `workflowRuns.diff` with invented files.

const route = '/workflows/runs/run-1';

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: 1,
  baseSha: '1f3c9a7d2b4e6f8091a2b3c4d5e6f708192a3b4c',
  baseFiles: [],
  steps: [
    {
      stepId: 'build',
      state: 'done',
      threadId: 'run-1.build',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      artifactsFound: [],
      fileHashes: [{ path: 'src/timer.ts', hash: 'h1' }],
    },
    {
      stepId: 'review',
      state: 'waiting',
      threadId: 'run-1.review',
      startedAt: '2026-11-02T08:05:00.000Z',
      endedAt: '2026-11-02T08:09:00.000Z',
      artifactsFound: [],
      fileHashes: [
        { path: 'src/timer.ts', hash: 'h1' },
        { path: 'review/notes.md', hash: 'h2' },
      ],
    },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
};

const step = (id: string, skillName: string) => ({
  id,
  skillName,
  providerInstanceId: 'mock',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
});

const workflow: Workflow = {
  id: 'w',
  name: 'Build and review',
  templateKind: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [step('build', 'deliver-work'), step('review', 'check-work')],
};

const file = (path: string, overrides: Partial<RunDiffFile> = {}): RunDiffFile => ({
  path,
  oldPath: null,
  status: 'modified',
  content: 'text',
  added: 2,
  removed: 1,
  size: 300,
  changedBy: [],
  ...overrides,
});

const files: RunDiffFile[] = [
  file('assets/logo.bin', {
    status: 'added',
    content: 'binary',
    added: null,
    removed: null,
    size: 2400,
  }),
  file('data/export.csv', { content: 'tooLarge', added: null, removed: null, size: 3_500_000 }),
  file('docs/guide.md', { status: 'renamed', oldPath: 'docs/howto.md', added: 0, removed: 0 }),
  file('old/legacy.ts', { status: 'deleted', added: 0, removed: 12 }),
  file('review/notes.md', { status: 'added', added: 3, removed: 0, changedBy: ['review'] }),
  file('src/timer.ts', { changedBy: ['build'] }),
];

const diff = (overrides: Partial<RunDiff> = {}): RunDiff => ({
  status: 'ok',
  message: null,
  baseSha: run.baseSha ?? null,
  files,
  omitted: 0,
  patch: null,
  ...overrides,
});

const patches: Readonly<Record<string, string>> = {
  'src/timer.ts':
    '@@ -1,3 +1,4 @@\n const minutes = 3;\n-ring();\n+ringTwice();\n+log();\n done();\n',
  'review/notes.md': '@@ -0,0 +1,3 @@\n+# Notes\n+\n+Rings twice now.\n',
};

function fake(answer: RunDiff = diff(), runRow: WorkflowRun = run) {
  const asked: unknown[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [runRow],
    workflows: [workflow],
    projects: [project],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(runRow);
      if (method === 'files.read') {
        asked.push(params);
        return Promise.resolve({
          kind: 'text',
          absolutePath: '/home/me/demo/src/timer.ts',
          size: 300,
          text: 'const minutes = 3;\n',
        });
      }
      if (method !== 'workflowRuns.diff') return Promise.resolve([]);
      asked.push(params);
      const { path } = params as { path?: string };
      if (path === undefined) return Promise.resolve(answer);
      const found = answer.files.filter((entry) => entry.path === path);
      return Promise.resolve({ ...answer, files: found, patch: patches[path] ?? null });
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime: Runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, {
        'appearance.contextPanel': true,
        // No provider instance is seeded; keep the first-run dialog out of the way.
        'providers.offerSetup': false,
      }),
    ),
  };
  return { runtime, asked };
}

const list = () => screen.findByRole('navigation', { name: 'Changed files' });
const rows = async () =>
  within(await list())
    .getAllByTestId('changed-file')
    .map((row) => row.textContent);

describe('Changes tab', () => {
  it('lists each changed file with its status and line changes, and marks the step under review', async () => {
    await renderApp(`${route}?tab=changes`, fake().runtime);
    expect(await rows()).toEqual([
      'AAdded:assets/logo.binBinary file · 2.4 KB',
      'MChanged:data/export.csvToo large to show · 3.5 MB',
      'RRenamed:docs/guide.md+0 −0',
      'DDeleted:old/legacy.ts+0 −12',
      'AAdded:review/notes.md+3 −0This step',
      'MChanged:src/timer.ts+2 −1',
    ]);
    expect(screen.getByTestId('changes-summary').textContent).toBe('6 files changed since 1f3c9a7');
    // Only the file the waiting step changed is marked; the earlier step's file is not.
    expect(
      within(await list())
        .getAllByTestId('changed-file')
        .filter((row) => row.dataset['marked'] === 'true')
        .map((row) => row.textContent),
    ).toEqual(['AAdded:review/notes.md+3 −0This step']);
    expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
  });

  it('narrows the list to the step under review with "This step only"', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp(`${route}?tab=changes`, fake().runtime);
    await list();
    await user.click(screen.getByRole('switch', { name: /This step only/ }));
    expect(await rows()).toEqual(['AAdded:review/notes.md+3 −0This step']);
    expect(router.state.location.search).toEqual({ tab: 'changes', stepOnly: true });
    expect(screen.getByText('(check-work, 1)')).toBeTruthy();
    // The one file left is the one whose diff shows.
    const shown = await screen.findByRole('table', { name: 'Diff of review/notes.md' });
    expect(within(shown).getAllByRole('row')).toHaveLength(4);
    await user.click(screen.getByRole('switch', { name: /This step only/ }));
    expect(await rows()).toHaveLength(6);
  });

  it('shows the chosen file as a unified diff with line numbers', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(`${route}?tab=changes`, server.runtime);
    await user.click(within(await list()).getByRole('button', { name: /src\/timer\.ts/ }));
    const shown = await screen.findByRole('table', { name: 'Diff of src/timer.ts' });
    expect(
      within(shown)
        .getAllByRole('row')
        .map((row) => [row.dataset['kind'], row.textContent]),
    ).toEqual([
      ['hunk', '@@ -1,3 +1,4 @@'],
      ['context', '11const minutes = 3;'],
      ['remove', '2−ring();'],
      ['add', '2+ringTwice();'],
      ['add', '3+log();'],
      ['context', '34done();'],
    ]);
    expect(server.asked).toContainEqual({ runId: 'run-1', path: 'src/timer.ts' });
  });

  it('shows a binary or oversize file with its status and size only (spec 12)', async () => {
    const user = userEvent.setup();
    await renderApp(`${route}?tab=changes`, fake().runtime);
    // The first file in the list is the binary one, so it is the one shown.
    const shown = await screen.findByRole('region', { name: 'Changes in assets/logo.bin' });
    expect((await within(shown).findByTestId('diff-unshown')).textContent).toBe(
      'Binary file · 2.4 KB. Its lines are not shown.',
    );
    expect(within(shown).getByText('Added')).toBeTruthy();
    expect(within(shown).queryByRole('table')).toBeNull();
    await user.click(within(await list()).getByRole('button', { name: /data\/export\.csv/ }));
    const large = await screen.findByRole('region', { name: 'Changes in data/export.csv' });
    expect((await within(large).findByTestId('diff-unshown')).textContent).toBe(
      'Too large to show · 3.5 MB. Its lines are not shown.',
    );
  });

  it('opens a changed file in the side panel viewer, but not a deleted one', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(`${route}?tab=changes&file=src/timer.ts`, server.runtime);
    const shown = await screen.findByRole('region', { name: 'Changes in src/timer.ts' });
    await user.click(within(shown).getByRole('button', { name: 'Open file' }));
    const viewer = await screen.findByRole('region', { name: 'File viewer' });
    expect(within(viewer).getByTestId('viewer-path').textContent).toBe('src/timer.ts');
    expect(server.asked).toContainEqual({ runId: 'run-1', path: 'src/timer.ts' });
    // The tab stays where it was next to the viewer.
    expect(screen.getByRole('region', { name: 'Changes in src/timer.ts' })).toBeTruthy();

    await user.click(within(await list()).getByRole('button', { name: /old\/legacy\.ts/ }));
    const deleted = await screen.findByRole('region', { name: 'Changes in old/legacy.ts' });
    expect(within(deleted).queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  it.each([
    ['noRepository', 'Not a Git repository'],
    ['gitUnavailable', 'Git was not found'],
    ['noBase', 'No base recorded'],
  ] as const)(
    'says so when there is nothing to compare (%s), and the run view still works (spec 13)',
    async (status, title) => {
      const user = userEvent.setup();
      await renderApp(
        `${route}?tab=changes`,
        fake(diff({ status, files: [], baseSha: null })).runtime,
      );
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      expect(screen.getAllByRole('region', { name: 'Gate' }).length).toBeGreaterThan(0);
      await user.click(screen.getByRole('tab', { name: 'Steps' }));
      expect(await screen.findByRole('list', { name: 'Run steps' })).toBeTruthy();
    },
  );

  it('says how many files were left out of a long list', async () => {
    await renderApp(`${route}?tab=changes`, fake(diff({ omitted: 40 })).runtime);
    await list();
    expect(screen.getByTestId('changes-summary').textContent).toBe(
      '46 files changed since 1f3c9a7 · 40 not listed',
    );
  });

  it('offers no step filter for a run whose steps stored no hashes', async () => {
    const plain = { ...run, steps: run.steps.map(({ fileHashes: _hashes, ...rest }) => rest) };
    await renderApp(`${route}?tab=changes`, fake(diff(), plain).runtime);
    await list();
    expect(screen.getByRole('switch', { name: 'This step only' })).toHaveProperty('disabled', true);
  });
});

describe('Changes tab model', () => {
  it('reads the run view address', () => {
    expect(validateRunSearch({})).toEqual({});
    expect(validateRunSearch({ tab: 'other', file: 'a' })).toEqual({});
    expect(validateRunSearch({ tab: 'changes', file: 'a/b.ts', stepOnly: true })).toEqual({
      tab: 'changes',
      file: 'a/b.ts',
      stepOnly: true,
    });
    expect(validateRunSearch({ tab: 'changes', file: 3, stepOnly: 'yes' })).toEqual({
      tab: 'changes',
    });
  });

  it('reviews the step at the gate, else the last step that stored its hashes', () => {
    expect(stepUnderReview(run)?.stepId).toBe('review');
    // A gate before the second step: the step before it is the one to review.
    const before = {
      ...run,
      steps: [run.steps[0], { stepId: 'review', state: 'waiting', artifactsFound: [] }],
    } as WorkflowRun;
    expect(stepUnderReview(before)?.stepId).toBe('build');
    expect(stepUnderReview({ ...run, state: 'done' })?.stepId).toBe('review');
    expect(stepUnderReview({ ...run, state: 'running', steps: [] })).toBeUndefined();
    expect(visibleFiles(files, run.steps[0], true).map((entry) => entry.path)).toEqual([
      'src/timer.ts',
    ]);
  });

  it('reads a unified diff into numbered rows', () => {
    expect(parsePatch('')).toEqual([]);
    expect(
      parsePatch(
        '@@ -7 +7,2 @@ function ring()\n-old\n+new\n+more\n\\ No newline at end of file\n',
      ),
    ).toEqual([
      { kind: 'hunk', text: '@@ -7 +7,2 @@ function ring()' },
      { kind: 'remove', text: 'old', oldNumber: 7 },
      { kind: 'add', text: 'new', newNumber: 7 },
      { kind: 'add', text: 'more', newNumber: 8 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('words what stands in for lines and why nothing is compared', () => {
    expect(lineChanges(file('a', { content: 'binary', size: null }))).toBe('Binary file');
    expect(emptyReason('failed', 'fatal: bad object').description).toBe('fatal: bad object');
    expect(emptyReason('baseMissing', null).title).toBe('The starting commit is gone');
    expect(emptyReason('folderMissing', null).title).toBe('Folder missing');
  });
});

const runView = (search: Record<string, unknown>, changedFiles = files) => ({
  runId: 'run-1',
  search,
  changedFiles,
  project,
});

describe('Changes palette commands', () => {
  const data = { workflows: [workflow], runs: [run], templates: [], openRun: run };
  const ids = (search: Record<string, unknown>) =>
    workflowCommands({ ...data, runView: runView(search) })
      .filter((command) => command.id.startsWith('workflowRun.changes'))
      .map((command) => [command.id, command.title, command.keybinding]);

  it('switches between the tabs with one key', () => {
    expect(ids({})).toEqual([
      ['workflowRun.changes', 'Run: show changes', 'keybindings.runChanges'],
    ]);
    expect(workflowCommands(data).some((command) => command.id === 'workflowRun.changes')).toBe(
      false,
    );
  });

  it('narrows, refreshes, picks a file and opens the chosen one while the tab is open', () => {
    const navigate = vi.fn<(options: unknown) => void>();
    const commands = workflowCommands({
      ...data,
      runView: runView({ tab: 'changes', file: 'src/timer.ts' }),
    });
    const command = (id: string) => commands.find((candidate) => candidate.id === id);
    expect(ids({ tab: 'changes', file: 'src/timer.ts' }).slice(0, 3)).toEqual([
      ['workflowRun.changes', 'Run: show steps', 'keybindings.runChanges'],
      ['workflowRun.changes.stepOnly', 'Changes: this step only', 'keybindings.changesStepOnly'],
      ['workflowRun.changes.refresh', 'Refresh changes', undefined],
    ]);
    const context = { navigate } as unknown as Parameters<
      NonNullable<(typeof commands)[0]>['run']
    >[0];
    command('workflowRun.changes.stepOnly')?.run(context);
    expect(navigate).toHaveBeenLastCalledWith({
      to: '/workflows/runs/$runId',
      params: { runId: 'run-1' },
      search: { tab: 'changes', file: 'src/timer.ts', stepOnly: true },
      replace: true,
    });
    command('workflowRun.changes.file.review/notes.md')?.run(context);
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { tab: 'changes', file: 'review/notes.md' } }),
    );
    expect(command('workflowRun.changes.open')?.title).toBe('Open changed file: src/timer.ts');
    const before = changesStore.getState().refresh;
    command('workflowRun.changes.refresh')?.run(context);
    expect(changesStore.getState().refresh).toBe(before + 1);
    // A deleted file has nothing to open.
    expect(
      workflowCommands({
        ...data,
        runView: runView({ tab: 'changes', file: 'old/legacy.ts' }),
      }).some((candidate) => candidate.id === 'workflowRun.changes.open'),
    ).toBe(false);
    expect(ids({ tab: 'changes', stepOnly: true })[1]?.[1]).toBe('Changes: every step');
  });
});
