import type { CommitPlan, HostLinkRules, PullRequestPlan, ThreadDiff } from '@wow/contracts';
import {
  RpcClientError,
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { commitStore, committedLineText } from './commit-dialog';
import { createDraftStore } from './draft';
import { changeRequestLineText, pullRequestStore } from './pull-request-dialog';
import { ThreadChanges } from './thread-changes';

// Commit and pull request from a chat thread's Changes (thread work spec 27 to 34): the dialogs
// against an invented server. All invented.

const diff: ThreadDiff = {
  status: 'ok',
  message: null,
  baseSha: '4e1d2a0',
  files: [],
  omitted: 0,
  patch: null,
  turnPaths: null,
};

const commitPlan = (overrides: Partial<CommitPlan> = {}): CommitPlan => ({
  status: 'ok',
  message: null,
  branch: 'wow/ring-twice-3fa2c1',
  head: '4e1d2a0',
  hooks: ['pre-commit'],
  hooksPath: '.git/hooks',
  files: [
    {
      path: 'readme.md',
      oldPath: null,
      status: 'modified',
      added: 1,
      removed: 0,
      inThread: false,
      staged: true,
    },
    {
      path: 'src/bell.ts',
      oldPath: null,
      status: 'modified',
      added: 1,
      removed: 1,
      inThread: true,
      staged: false,
    },
  ],
  omitted: 0,
  ...overrides,
});

const ref = {
  host: 'github' as const,
  kind: 'changeRequest' as const,
  site: 'https://github.example.test',
  path: 'acme/tea',
  id: '14',
  url: 'https://github.example.test/acme/tea/pull/14',
};

const pullPlan = (overrides: Partial<PullRequestPlan> = {}): PullRequestPlan => ({
  status: 'ok',
  message: null,
  host: 'github',
  hostName: 'github.com',
  repository: 'acme/tea',
  remote: 'origin',
  branch: 'wow/ring-twice-3fa2c1',
  target: 'main',
  branches: ['main', 'release'],
  commits: [{ sha: '5f6a7b8c9d', subject: 'Ring the bell twice', body: 'Two rings.' }],
  title: 'Ring the bell twice',
  body: 'Two rings.',
  draft: false,
  existing: null,
  missing: null,
  ...overrides,
});

type Answer = (params: Record<string, unknown>) => unknown;

function setup(answers: Record<string, Answer>, rules?: Partial<HostLinkRules>, threadId = 'bell') {
  const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    (method, params) => {
      if (method === 'threads.diff') return Promise.resolve(diff);
      if (method === 'hosts.lookup') {
        return Promise.resolve({
          rules: { sites: [], repository: null, jiraKey: null, ...rules },
          item: null,
          read: null,
        });
      }
      const answer = answers[method];
      if (!answer) return Promise.reject(new Error(`unexpected ${method}`));
      try {
        return Promise.resolve(answer(params));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as unknown as Connection['request'],
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
      <ThreadChanges changes={{ threadId, from: `/chat/${threadId}` }} />
    </RuntimeProvider>,
  );
  const asked = (method: string) =>
    request.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
  return { asked };
}

// Lets the answers already given reach the stores: a few turns of the microtask queue.
const settled = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

const refused = (data: unknown) =>
  new RpcClientError({ code: 'rejected', message: 'refused', data });

afterEach(() => {
  commitStore.setState({ question: undefined });
  pullRequestStore.setState({ question: undefined });
});

describe('the commit dialog (spec 27 to 30)', () => {
  it('ticks only the thread’s own file, names the branch and the hooks (spec 27)', async () => {
    const user = userEvent.setup();
    setup({ 'threads.commitPlan': () => commitPlan() });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    const dialog = await screen.findByTestId('commit-dialog');
    expect(await within(dialog).findByTestId('commit-branch')).toHaveProperty(
      'textContent',
      'On wow/ring-twice-3fa2c1 at 4e1d2a0',
    );
    expect(within(dialog).getByTestId('commit-hooks').textContent).toBe(
      "Runs the repository's commit hooks: pre-commit",
    );
    expect(within(dialog).getByRole('checkbox', { name: 'src/bell.ts' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    expect(within(dialog).getByRole('checkbox', { name: 'readme.md' })).toHaveProperty(
      'ariaChecked',
      'false',
    );
  });

  it('says "No commit hooks" when there are none', async () => {
    const user = userEvent.setup();
    setup({ 'threads.commitPlan': () => commitPlan({ hooks: [] }) });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    expect((await screen.findByTestId('commit-hooks')).textContent).toBe('No commit hooks');
  });

  it('fills the message with the proposal for the ticked files, and Cancel stops one (spec 28)', async () => {
    const user = userEvent.setup();
    let answer: ((value: unknown) => void) | undefined;
    const { asked } = setup({
      'threads.commitPlan': () => commitPlan(),
      'threads.propose': () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      'threads.cancelProposal': () => ({ cancelled: true }),
    });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    const dialog = await screen.findByTestId('commit-dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Propose' }));
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).value,
    ).toBe('Writing a message…');
    expect(asked('threads.propose')).toEqual([
      expect.objectContaining({
        threadId: 'bell',
        purpose: 'commitMessage',
        files: ['src/bell.ts'],
      }),
    ]);
    await act(async () => {
      answer?.({ text: 'Ring the bell twice' });
      await settled();
    });
    const message = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    expect(message.value).toBe('Ring the bell twice');

    await user.click(within(dialog).getByRole('button', { name: 'Propose' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the proposal' }));
    expect(asked('threads.cancelProposal')).toHaveLength(1);
    expect(message.value).toBe('Ring the bell twice');
  });

  it('commits exactly the ticked files with Ctrl+Enter and shows a refusing hook’s output (spec 29)', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { asked } = setup({
      'threads.commitPlan': () => commitPlan(),
      'threads.commit': () => {
        if (refuse) {
          refuse = false;
          throw refused({
            reason: 'Nothing was committed: pre-commit refused',
            output: 'Lint failed: the bell rings three times',
          });
        }
        return { sha: '5f6a7b8c9d', subject: 'Ring the bell twice' };
      },
    });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    const dialog = await screen.findByTestId('commit-dialog');
    const commit = within(dialog).getByRole('button', { name: /^Commit/ });
    expect(commit).toHaveProperty('disabled', true);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Message' }),
      'Ring the bell twice',
    );
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await within(dialog).findByTestId('commit-refusal')).toHaveProperty(
      'textContent',
      expect.stringContaining('Lint failed: the bell rings three times'),
    );
    await user.click(within(dialog).getByRole('button', { name: /^Commit/ }));
    await act(settled);
    expect(screen.queryByTestId('commit-dialog')).toBeNull();
    expect(asked('threads.commit')).toEqual([
      { threadId: 'bell', files: ['src/bell.ts'], message: 'Ring the bell twice' },
      { threadId: 'bell', files: ['src/bell.ts'], message: 'Ring the bell twice' },
    ]);
  });

  it('shows why it cannot commit, and asks a new branch for a folder on no branch (spec 30)', async () => {
    const user = userEvent.setup();
    let plan = commitPlan({ status: 'turnRunning', message: 'A turn is running in this thread.' });
    const { asked } = setup({
      'threads.commitPlan': () => plan,
      'threads.commit': () => ({ sha: '5f6a7b8c9d', subject: 'Ring' }),
    });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    expect((await screen.findByTestId('commit-refused')).textContent).toBe(
      'A turn is running in this thread.',
    );
    await user.keyboard('{Escape}');
    plan = commitPlan({ branch: null });
    await user.click(screen.getByRole('button', { name: /Commit…/ }));
    const dialog = await screen.findByTestId('commit-dialog');
    await user.type(await within(dialog).findByRole('textbox', { name: 'Message' }), 'Ring');
    const commit = within(dialog).getByRole('button', { name: /^Commit/ });
    expect(commit).toHaveProperty('disabled', true);
    await user.type(within(dialog).getByRole('textbox', { name: 'New branch' }), 'wow/ring');
    await user.click(commit);
    expect(asked('threads.commit')).toEqual([
      { threadId: 'bell', files: ['src/bell.ts'], message: 'Ring', newBranch: 'wow/ring' },
    ]);
  });
});

describe('the pull request dialog (spec 31 to 34)', () => {
  it('shows where it goes and what it holds, and opens with the edited title (spec 31, 32)', async () => {
    const user = userEvent.setup();
    const { asked } = setup({
      'threads.pullRequestPlan': () => pullPlan(),
      'threads.openPullRequest': () => ({ number: 14, url: ref.url }),
    });
    await user.click(screen.getByRole('button', { name: /Open pull request…/ }));
    const dialog = await screen.findByTestId('pull-request-dialog');
    expect((await within(dialog).findByTestId('pull-request-statement')).textContent).toBe(
      'Pushes wow/ring-twice-3fa2c1 to origin and opens a pull request on github.com in acme/tea',
    );
    expect(within(dialog).getByRole('list', { name: 'Commits' }).textContent).toContain(
      'Ring the bell twice',
    );
    const title = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Title' });
    expect(title.value).toBe('Ring the bell twice');
    await user.click(within(dialog).getByRole('switch', { name: 'Draft' }));
    await user.click(within(dialog).getByRole('button', { name: /Open pull request/ }));
    await act(settled);
    expect(screen.queryByTestId('pull-request-dialog')).toBeNull();
    expect(asked('threads.openPullRequest')).toEqual([
      {
        threadId: 'bell',
        target: 'main',
        title: 'Ring the bell twice',
        body: 'Two rings.',
        draft: true,
      },
    ]);
  });

  it('names a merge request on GitLab', async () => {
    const user = userEvent.setup();
    setup(
      {
        'threads.pullRequestPlan': () =>
          pullPlan({ host: 'gitlab', hostName: 'gitlab.example.test' }),
      },
      { repository: { host: 'gitlab', base: 'https://gitlab.example.test', path: 'tea/field' } },
      'field',
    );
    await user.click(await screen.findByRole('button', { name: /Open merge request…/ }));
    expect((await screen.findByTestId('pull-request-statement')).textContent).toBe(
      'Pushes wow/ring-twice-3fa2c1 to origin and opens a merge request on gitlab.example.test in acme/tea',
    );
  });

  it('names the missing setting and pushes nothing (spec 33)', async () => {
    const user = userEvent.setup();
    const { asked } = setup({
      'threads.pullRequestPlan': () =>
        pullPlan({
          status: 'notSetUp',
          missing: 'trackers.github.token',
          message: 'wow cannot open a pull request for this project: fill in trackers.github.token',
        }),
    });
    await user.click(screen.getByRole('button', { name: /Open pull request…/ }));
    const dialog = await screen.findByTestId('pull-request-dialog');
    expect((await within(dialog).findByTestId('pull-request-refused')).textContent).toContain(
      'trackers.github.token',
    );
    expect(within(dialog).getByRole('button', { name: /Open pull request/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(asked('threads.openPullRequest')).toEqual([]);
  });

  it('offers the open one in the panel and a push of the new commits (spec 33)', async () => {
    const user = userEvent.setup();
    const { asked } = setup({
      'threads.pullRequestPlan': () =>
        pullPlan({
          status: 'existing',
          message: 'Pull request #14 is open for wow/ring-twice-3fa2c1.',
          existing: { number: 14, title: 'Ring the bell twice', url: ref.url, ref, unpushed: 2 },
        }),
      'threads.pushBranch': () => ({ remote: 'origin', branch: 'wow/ring-twice-3fa2c1' }),
    });
    await user.click(screen.getByRole('button', { name: /Open pull request…/ }));
    const dialog = await screen.findByTestId('pull-request-dialog');
    expect(await within(dialog).findByRole('button', { name: 'Open in panel' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /Push the new commits \(2\)/ }));
    expect(asked('threads.pushBranch')).toEqual([{ threadId: 'bell' }]);
  });

  it('shows the host’s refusal and that the branch is pushed, and Open again (spec 34)', async () => {
    const user = userEvent.setup();
    setup({
      'threads.pullRequestPlan': () => pullPlan(),
      'threads.openPullRequest': () => {
        throw refused({
          reason:
            'github.com did not open the pull request: github.com answered 422: Validation Failed. wow/ring-twice-3fa2c1 is pushed; Open can be tried again.',
          output: '',
          pushed: true,
        });
      },
    });
    await user.click(screen.getByRole('button', { name: /Open pull request…/ }));
    const dialog = await screen.findByTestId('pull-request-dialog');
    await user.click(await within(dialog).findByRole('button', { name: /Open pull request/ }));
    expect((await within(dialog).findByTestId('pull-request-refusal')).textContent).toContain(
      'Validation Failed',
    );
    expect(within(dialog).getByRole('button', { name: /Open pull request/ })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

describe('the lines in the conversation (spec 29, 32)', () => {
  it('says what was committed and what was opened', () => {
    expect(
      committedLineText({
        sha: '4e1d2a0aa',
        subject: 'Ring the bell twice',
        files: ['a', 'b', 'c'],
        branch: 'main',
        at: '2026-11-14T08:00:00.000Z',
      }),
    ).toBe('Committed 3 files · 4e1d2a0 Ring the bell twice');
    expect(
      changeRequestLineText({
        ref,
        number: 14,
        title: 'Ring the bell twice',
        url: ref.url,
        at: '2026-11-14T08:00:00.000Z',
      }),
    ).toBe('Opened pull request #14 · Ring the bell twice');
    expect(
      changeRequestLineText({
        ref: { ...ref, host: 'gitlab' },
        number: 7,
        title: 'Weed',
        url: ref.url,
        at: '2026-11-14T08:00:00.000Z',
      }),
    ).toBe('Opened merge request !7 · Weed');
  });
});
