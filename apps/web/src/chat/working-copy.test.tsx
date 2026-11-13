import {
  branchIdOf,
  type Project,
  type ProviderInstance,
  type ProviderModel,
  type Thread,
  type UnpushedWork,
  type WorkingCopy,
  type WorkingCopyPlan,
} from '@wow/contracts';
import {
  RpcClientError,
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { firstMessageTitle } from '@/chat/model';
import { renderApp, renderWithRuntime } from '@/test/render';
import {
  askRemoveThreadCopy,
  holdsSummary,
  threadCopyStore,
  workingCopyCommands,
  WorkingCopyDetails,
  RemoveThreadCopyDialog,
} from './working-copy';

// Thread work U2: the draft's switch and line (spec 10), the chip and Details (spec 13, 14) and
// "Remove working copy" (spec 15). Folders, branches and commits are invented.

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Work Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const models: ProviderModel[] = [
  { id: 'kettle-large', label: 'Kettle Large', description: '', efforts: ['low', 'high'] },
];

const mug: Project = {
  id: 'mug',
  name: 'Tea mug',
  cwd: '/work/tea-mug',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

const sha = '4e1d2a09c0ffee00000000000000000000000000';
const plan: WorkingCopyPlan = {
  status: 'ok',
  on: true,
  template: 'wow/{{title}}-{{id}}',
  start: 'head',
  from: 'main',
  sha,
  fetch: false,
};

const copy = (overrides: Partial<WorkingCopy> = {}): WorkingCopy => ({
  path: '/home/me/.wow/workspaces/tea-mug-t1a2b3c4d',
  state: 'ready',
  startSha: sha,
  defaultBranch: 'main',
  note: null,
  unpushed: null,
  error: null,
  branch: 'wow/ring-twice-3fa2c1',
  ...overrides,
});

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: 't1',
  projectId: 'mug',
  cwd: '/home/me/.wow/workspaces/tea-mug-t1a2b3c4d',
  branch: 'wow/ring-twice-3fa2c1',
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Ring twice',
  model: 'kettle-large',
  effort: 'low',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  workingCopy: copy(),
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  ...overrides,
});

const holds = (overrides: Partial<UnpushedWork> = {}): UnpushedWork => ({
  uncommittedFiles: 0,
  ignoredFiles: 0,
  unpushedCommits: 0,
  newestSubject: null,
  branch: 'wow/ring-twice-3fa2c1',
  ...overrides,
});

type Answer = (params: unknown) => Promise<unknown>;

function fakeServer(answers: Record<string, Answer> = {}, rows: Thread[] = []) {
  const sent: unknown[] = [];
  const asked: { method: string; params: unknown }[] = [];
  const topics: Record<string, unknown[]> = {
    providerInstances: [instance],
    projects: [mug],
    threads: rows,
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      asked.push({ method, params });
      const answer = answers[method];
      if (answer) return answer(params);
      if (method === 'threads.workingCopyPlan') return Promise.resolve(plan);
      if (method === 'provider.listModels') return Promise.resolve(models);
      if (method === 'dispatch') {
        sent.push((params as { command: unknown }).command);
        return Promise.resolve({ commandId: 'c', seqs: [], duplicate: false });
      }
      return Promise.resolve([]);
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
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
  return { runtime, sent, asked, connection };
}

const draftCommands = (on: boolean, offered: boolean) =>
  workingCopyCommands({ openThread: undefined, onNewThread: true, draft: { on, offered } }).map(
    (command) => [command.id, command.title],
  );
const threadCommands = (state: Thread['state']) =>
  workingCopyCommands({
    openThread: thread({ state }),
    onNewThread: false,
    draft: { offered: false, on: false },
  }).map((command) => command.id);

afterEach(() => threadCopyStore.setState({ removing: undefined }));

describe('the new thread\'s "Own working copy" (spec 10)', () => {
  it("starts from the project's setting, names the branch from the typed title and creates the thread with it", async () => {
    const user = userEvent.setup();
    const { runtime, sent } = fakeServer();
    runtime.draft.setState({ projectId: 'mug' });
    await renderApp('/chat/new', runtime);
    const own = await screen.findByRole('switch', { name: 'Own working copy' });
    expect(own.getAttribute('aria-checked')).toBe('true');
    const line = screen.getByTestId('draft-working-copy-line');
    expect(line.textContent).toMatch(
      /^New branch wow\/[0-9a-f]{6} from main \(4e1d2a0\)\. Uncommitted changes in the project folder stay there\.$/,
    );

    const id = /wow\/([0-9a-f]{6})/.exec(line.textContent ?? '')?.[1] ?? '';
    await user.type(screen.getByRole('combobox', { name: 'Message' }), 'Ring the bell twice');
    expect(screen.getByTestId('draft-working-copy-line').textContent).toContain(
      `New branch wow/ring-the-bell-twice-${id} from main (4e1d2a0).`,
    );
    await user.keyboard('{Enter}');
    await act(() => Promise.resolve());
    const created = sent.find(
      (command): command is { type: string; threadId: string; ownWorkingCopy?: boolean } =>
        (command as { type: string }).type === 'thread.create',
    );
    expect(created).toMatchObject({ projectId: 'mug', ownWorkingCopy: true });
    expect(branchIdOf(created?.threadId ?? '')).toBe(id);
  });

  it('creates the thread in the project folder once the switch is turned off', async () => {
    const user = userEvent.setup();
    const { runtime, sent } = fakeServer();
    runtime.draft.setState({ projectId: 'mug' });
    await renderApp('/chat/new', runtime);
    await user.click(await screen.findByRole('switch', { name: 'Own working copy' }));
    expect(screen.queryByTestId('draft-working-copy-line')).toBeNull();
    expect(runtime.draft.getState().ownWorkingCopy).toBe(false);
    await user.type(screen.getByRole('combobox', { name: 'Message' }), 'Ring{Enter}');
    await act(() => Promise.resolve());
    const created = sent.find((command) => (command as { type: string }).type === 'thread.create');
    expect(created).not.toHaveProperty('ownWorkingCopy');
  });

  it('shows no switch for a folder without a project or a project not in Git', async () => {
    const plain = fakeServer();
    plain.runtime.draft.setState({ cwd: '/work/loose' });
    const first = await renderApp('/chat/new', plain.runtime);
    await screen.findByTestId('new-thread-folder');
    expect(screen.queryByRole('switch', { name: 'Own working copy' })).toBeNull();
    first.unmount();

    const notGit = fakeServer({
      'threads.workingCopyPlan': () =>
        Promise.resolve({ status: 'unavailable', reason: 'not a Git repository' }),
    });
    notGit.runtime.draft.setState({ projectId: 'mug' });
    await renderApp('/chat/new', notGit.runtime);
    await screen.findByTestId('new-thread-folder');
    await act(() => Promise.resolve());
    expect(screen.queryByRole('switch', { name: 'Own working copy' })).toBeNull();
    expect(notGit.asked.some((entry) => entry.method === 'threads.workingCopyPlan')).toBe(true);
  });

  it('offers the palette command only on the draft that has the switch', () => {
    expect(draftCommands(true, true)).toEqual([
      ['chat.draft.ownWorkingCopy', 'New thread: work in the project folder'],
    ]);
    expect(draftCommands(false, false)).toEqual([]);
  });
});

describe("a thread's chip and Details (spec 13, 14)", () => {
  it('shows the branch and "own working copy" in the header, and what a kept copy holds', async () => {
    const { runtime } = fakeServer({}, [thread()]);
    const { unmount } = await renderApp('/chat/t1', runtime);
    const chip = await screen.findByTestId('working-copy-chip');
    expect(chip.textContent).toBe('wow/ring-twice-3fa2c1·own working copy');
    unmount();

    const kept = fakeServer({}, [
      thread({
        state: 'done',
        workingCopy: copy({
          state: 'kept',
          unpushed: holds({ uncommittedFiles: 2, ignoredFiles: 1, unpushedCommits: 3 }),
        }),
      }),
    ]);
    await renderApp('/chat/t1', kept.runtime);
    expect((await screen.findByTestId('working-copy-chip')).textContent).toBe(
      'wow/ring-twice-3fa2c1·2 uncommitted files, 1 ignored file · 3 commits on wow/ring-twice-3fa2c1',
    );
  });

  it('lists the branch, the folder with Copy path and Open in editor, and where it started', async () => {
    const user = userEvent.setup();
    const { runtime, asked } = fakeServer();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => Promise.resolve(void (copied = text)) },
    });
    renderWithRuntime(
      <WorkingCopyDetails
        thread={thread({ workingCopy: copy({ note: 'Fetching origin failed (invented).' }) })}
      />,
      runtime,
    );
    const details = screen.getByTestId('working-copy-details');
    expect(within(details).getByTestId('fact-Branch').textContent).toBe('wow/ring-twice-3fa2c1');
    expect(within(details).getByTestId('fact-Started from').textContent).toBe('main (4e1d2a0)');
    expect(within(details).getByTestId('working-copy-note').textContent).toBe(
      'Fetching origin failed (invented).',
    );
    await user.click(within(details).getByRole('button', { name: 'Copy path' }));
    expect(copied).toBe('/home/me/.wow/workspaces/tea-mug-t1a2b3c4d');
    await user.click(within(details).getByRole('button', { name: 'Open in editor' }));
    expect(asked.at(-1)).toEqual({
      method: 'files.openInEditor',
      params: { threadId: 't1', path: '.' },
    });
    expect(within(details).getByRole('button', { name: 'Remove working copy' })).toBeTruthy();
  });

  it('words what a copy holds', () => {
    expect(holdsSummary(holds({ uncommittedFiles: 1 }), 'wow/a')).toBe('1 uncommitted file');
    expect(holdsSummary(holds({ unpushedCommits: 1 }), 'wow/a')).toBe('1 commit on wow/a');
    expect(holdsSummary(holds(), 'wow/a')).toBe('Nothing to lose');
    expect(holdsSummary(holds({ unpushedCommits: 3, commitsOnNoBranch: 1 }), 'wow/a')).toBe(
      '1 commit on no branch · 2 commits on wow/a',
    );
  });

  it('names the branch from the title the first message gives, skills and images included', () => {
    expect(firstMessageTitle('Ring twice\nand loud', [], 0)).toBe('Ring twice');
    expect(firstMessageTitle('', ['plan-work', 'review'], 1)).toBe('plan-work review');
    expect(firstMessageTitle('', [], 2)).toBe('Image');
  });
});

describe('Remove working copy (spec 15)', () => {
  it('names what would be lost, removes only on "Remove and lose them", and asks again with the new counts', async () => {
    const user = userEvent.setup();
    const removals: unknown[] = [];
    const { runtime, connection } = fakeServer({
      'threads.workingCopyStatus': () => Promise.resolve(holds({ uncommittedFiles: 1 })),
      'threads.removeWorkingCopy': (params) => {
        removals.push(params);
        if (removals.length === 1) {
          return Promise.reject(
            new RpcClientError({
              code: 'conflict',
              message: 'The working copy holds more than you were shown: 2 uncommitted files.',
              data: holds({ uncommittedFiles: 2 }),
            }),
          );
        }
        return Promise.resolve(thread({ workingCopy: copy({ state: 'removed' }) }));
      },
    });
    renderWithRuntime(<RemoveThreadCopyDialog thread={thread()} />, runtime);
    await act(() => askRemoveThreadCopy(connection, 't1'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('working-copy-loses').textContent).toBe(
      'It holds 1 uncommitted file. They are lost with the folder. Commits stay on wow/ring-twice-3fa2c1.',
    );
    expect(within(dialog).queryByRole('button', { name: 'Remove' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Remove and lose them' }));
    expect(removals).toEqual([{ threadId: 't1', expect: holds({ uncommittedFiles: 1 }) }]);
    expect(within(dialog).getByTestId('working-copy-loses').textContent).toMatch(
      /^It changed since. It holds 2 uncommitted files\./,
    );

    await user.click(within(dialog).getByRole('button', { name: 'Remove and lose them' }));
    expect(removals.at(-1)).toEqual({ threadId: 't1', expect: holds({ uncommittedFiles: 2 }) });
    expect(threadCopyStore.getState().removing).toBeUndefined();
  });

  it('removes with a plain Remove when nothing would be lost, and shows a refusal', async () => {
    const user = userEvent.setup();
    const { runtime, connection } = fakeServer({
      'threads.workingCopyStatus': () => Promise.resolve(holds({ unpushedCommits: 2 })),
      'threads.removeWorkingCopy': () =>
        Promise.reject(
          new RpcClientError({
            code: 'rejected',
            message: 'A turn runs in this thread. Stop it, then remove the working copy.',
          }),
        ),
    });
    renderWithRuntime(<RemoveThreadCopyDialog thread={thread()} />, runtime);
    await act(() => askRemoveThreadCopy(connection, 't1'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByTestId('working-copy-loses').textContent).toBe(
      'Nothing in it would be lost. Commits stay on wow/ring-twice-3fa2c1.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'A turn runs in this thread. Stop it, then remove the working copy.',
    );
  });

  it('offers Remove and Copy path in the palette for the open thread, not while it works', () => {
    expect(threadCommands('idle')).toEqual(['chat.copyWorkingCopyPath', 'chat.removeWorkingCopy']);
    expect(threadCommands('working')).toEqual(['chat.copyWorkingCopyPath']);
  });
});
