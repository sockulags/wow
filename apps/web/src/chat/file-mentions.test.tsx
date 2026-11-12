import type { ProviderInstance, Thread } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from './draft';
import { mentionLine, withMentions, withoutMentionLines, withoutMentions } from './mentions';
import { ThreadConversation } from './thread-view';

// Agent workbench spec 56: `@` typed at the start of a word lists the thread folder's files; a
// pick is a chip, and the message names the path in its text.

const thread: Thread = {
  id: 'tea',
  projectId: null,
  cwd: '/work/tea',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Tea timer',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

function setup({
  assistant = false,
  shown = thread,
}: { assistant?: boolean; shown?: Thread } = {}) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) =>
    Promise.resolve(
      method === 'files.list'
        ? {
            files: ['README.md', 'src/timer.ts', 'src/timer.test.ts', 'docs/timing.md'],
            source: 'git',
            truncated: false,
          }
        : { commandId: 'c', seqs: [], duplicate: false },
    ),
  );
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
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
      <ThreadConversation
        thread={shown}
        instance={instance}
        {...(assistant ? { extras: { placeholder: 'Message' } } : {})}
      />
    </RuntimeProvider>,
  );
  const sent = () =>
    request.mock.calls
      .filter(([method]) => method === 'dispatch')
      .map(([, params]) => (params as { command: unknown }).command);
  const listed = () => request.mock.calls.filter(([method]) => method === 'files.list');
  return {
    box: screen.getByRole('combobox', { name: /message/i }),
    sent,
    listed,
    user: userEvent.setup(),
  };
}

const files = () => screen.queryByRole('listbox', { name: 'Files' });

describe('@ in the composer @agent-workbench-56', () => {
  it('lists the folder’s files for a typed @, filtered, and sends a pick as a chip and the path', async () => {
    const { box, sent, listed, user } = setup();
    await user.type(box, '@ti');
    const list = await screen.findByRole('listbox', { name: 'Files' });
    expect(listed()).toEqual([['files.list', { threadId: 'tea' }]]);
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['timer.tssrc', 'timing.mddocs', 'timer.test.tssrc']);
    await user.keyboard('{Enter}');
    expect(files()).toBeNull();
    const chips = screen.getByRole('list', { name: 'Mentioned files' });
    expect(within(chips).getByTestId('composer-file-chip').textContent).toBe('@timer.ts');
    expect((box as HTMLTextAreaElement).value).toBe('');
    await user.type(box, 'what does it ring?{Enter}');
    expect(sent()).toEqual([
      {
        type: 'thread.sendMessage',
        threadId: 'tea',
        text: '@src/timer.ts\n\nwhat does it ring?',
        files: ['src/timer.ts'],
      },
    ]);
    expect(screen.queryByRole('list', { name: 'Mentioned files' })).toBeNull();
  });

  it('opens nothing for pasted text, nor for @ inside a word', async () => {
    const { box, listed, user } = setup();
    box.focus();
    await user.paste('@ti');
    expect(files()).toBeNull();
    await user.clear(box);
    await user.type(box, 'me@ti');
    expect(files()).toBeNull();
    expect(listed()).toEqual([]);
  });

  it('removes a chip with Backspace at the start of the text', async () => {
    const { box, user } = setup();
    await user.type(box, '@read');
    await screen.findByRole('option', { name: /README\.md/ });
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('composer-file-chip')).toBeTruthy();
    await user.keyboard('{Backspace}');
    expect(screen.queryByTestId('composer-file-chip')).toBeNull();
  });

  it('puts a queued message back on Edit with its files as chips, not as a line of text', async () => {
    const { box, sent, user } = setup({
      shown: {
        ...thread,
        queued: {
          id: 'turn-1:queued:1',
          text: '@src/timer.ts\n\nwhat does it ring?\n\n@README.md @src/timer.ts\n\nand the readme?',
          files: ['src/timer.ts', 'README.md'],
          queuedAt: '2026-11-02T08:01:00.000Z',
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect((box as HTMLTextAreaElement).value).toBe('what does it ring?\n\nand the readme?');
    const chips = screen.getByRole('list', { name: 'Mentioned files' });
    expect(
      within(chips)
        .getAllByTestId('composer-file-chip')
        .map((chip) => chip.textContent),
    ).toEqual(['@timer.ts', '@README.md']);
    await user.type(box, '{Enter}');
    expect(sent()).toContainEqual({
      type: 'thread.sendMessage',
      threadId: 'tea',
      text: '@src/timer.ts @README.md\n\nwhat does it ring?\n\nand the readme?',
      files: ['src/timer.ts', 'README.md'],
    });
  });

  it('offers no file list in the Assistant view', async () => {
    const { box, listed, user } = setup({ assistant: true });
    await user.type(box, '@ti');
    expect(files()).toBeNull();
    expect(listed()).toEqual([]);
  });
});

describe('mention text', () => {
  it('names each file on the first line, and the thread shows the text without it', () => {
    expect(mentionLine(['a.ts', 'src/b.ts'])).toBe('@a.ts @src/b.ts');
    expect(withMentions('hi', ['a.ts'])).toBe('@a.ts\n\nhi');
    expect(withMentions('', ['a.ts'])).toBe('@a.ts');
    expect(withMentions('hi', [])).toBe('hi');
    expect(withoutMentions('@a.ts\n\nhi', ['a.ts'])).toBe('hi');
    expect(withoutMentions('@a.ts', ['a.ts'])).toBe('');
    expect(withoutMentions('written otherwise', ['a.ts'])).toBe('written otherwise');
    expect(
      withoutMentionLines('@a.ts\n\nhi\n\n@src/b.ts @a.ts\n\nthere', ['a.ts', 'src/b.ts']),
    ).toBe('hi\n\nthere');
    expect(withoutMentionLines('@a.ts and more\n\nhi', ['a.ts'])).toBe('@a.ts and more\n\nhi');
  });
});
