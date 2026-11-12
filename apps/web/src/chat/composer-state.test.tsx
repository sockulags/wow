import type { ProviderSlashCommand, Skill, SkillRef } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import type { AppCommand, CommandContext } from '@/app/commands';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { Composer, type ComposerHandle, type ComposerProps } from './composer';
import { createDraftStore } from './draft';
import { readDraft, writeDraft } from './drafts';
import { paletteCommandsStore, publishPaletteCommands } from './slash-commands';

// Agent workbench U3: drafts per thread (spec 49) and the Commands group of the `/` list (spec
// 58 to 61). The queue is the server's; its row is in thread-view.test.tsx.

const skills: Skill[] = [
  {
    id: 'yours/tidy-notes',
    name: 'tidy-notes',
    description: 'Tidy the notes of a run',
    dir: '/skills/tidy-notes',
    source: 'yours',
    manualOnly: false,
    invocations: { claude: '/tidy-notes', codex: '$tidy-notes' },
    text: 'Do tidy-notes.',
  },
  {
    id: 'user-claude/deliver-work',
    name: 'deliver-work',
    description: 'Deliver one unit',
    dir: '/skills/deliver-work',
    source: 'user-claude',
    manualOnly: false,
    invocations: { claude: '/deliver-work', codex: '$deliver-work' },
  },
];

// What Claude Code lists: one name wow has too, one that is a skill, one of its own.
const claudeCommands: ProviderSlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'deliver-work', description: 'Deliver one unit' },
  { name: 'review', description: 'Review the changes', argumentHint: '<branch>' },
];

afterEach(() => {
  paletteCommandsStore.setState({ commands: [], context: undefined });
});

const paletteCommand = (
  id: string,
  run = vi.fn<(context: CommandContext) => void>(),
): AppCommand => ({
  id,
  title: id,
  group: 'Chat',
  run,
});

function setup(props: Partial<ComposerProps> = {}, provider = claudeCommands) {
  const onSend = vi.fn<(text: string, picked?: readonly SkillRef[]) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const request = vi.fn<(method: string) => Promise<unknown>>((method) =>
    Promise.resolve(method === 'provider.listCommands' ? provider : null),
  );
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as unknown as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topic === 'skills' ? skills : []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
  };
  const handle = createRef<ComposerHandle>();
  const view = (more: Partial<ComposerProps> = {}) => (
    <RuntimeProvider runtime={runtime}>
      <Composer
        ref={handle}
        providerKind="claude"
        running={false}
        placeholder="Message"
        onSend={onSend}
        {...props}
        {...more}
      />
    </RuntimeProvider>
  );
  const rendered = render(view());
  return { onSend, request, handle, view, rendered, user: userEvent.setup() };
}

const box = () => screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement;
const chips = () =>
  screen.queryAllByTestId('skill-chip').map((chip) => chip.getAttribute('aria-label'));
const list = () => screen.queryByRole('listbox', { name: 'Skills' });

describe('drafts per thread (agent workbench spec 49)', () => {
  it('keeps text and chips per thread across switching and a restart, and empties on Send', async () => {
    const { user, view, rendered, onSend } = setup({ draftKey: 'thread-a' });
    await user.type(box(), '/tidy');
    await user.keyboard('{Enter}');
    await user.type(box(), 'the kettle notes');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);

    // Thread B is opened: its own (empty) draft, nothing of A.
    rendered.rerender(view({ draftKey: 'thread-b' }));
    expect(box().value).toBe('');
    expect(chips()).toEqual([]);
    await user.type(box(), 'something for b');

    rendered.rerender(view({ draftKey: 'thread-a' }));
    expect(box().value).toBe('the kettle notes');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);

    // A restart of the app: a new composer reads what was stored.
    rendered.unmount();
    const again = setup({ draftKey: 'thread-a' });
    expect(box().value).toBe('the kettle notes');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);
    expect(readDraft('thread-b').text).toBe('something for b');

    await again.user.click(box());
    await again.user.keyboard('{Enter}');
    expect(again.onSend).toHaveBeenCalledWith('the kettle notes', [
      { name: 'tidy-notes', source: 'yours' },
    ]);
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('');
    expect(chips()).toEqual([]);
    expect(readDraft('thread-a')).toEqual({ text: '', skills: [] });
  });

  it('a send that answers after another thread came on screen leaves that thread alone', async () => {
    writeDraft('thread-b', { text: 'draft of b', skills: [] });
    const { user, view, rendered, onSend } = setup({ draftKey: 'thread-a' });
    const answers: Array<() => void> = [];
    onSend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    await user.type(box(), 'sent from a{Enter}');
    expect(onSend).toHaveBeenCalledWith('sent from a');

    rendered.rerender(view({ draftKey: 'thread-b' }));
    expect(box().value).toBe('draft of b');
    await act(async () => {
      answers[0]?.();
      await Promise.resolve();
    });

    expect(box().value).toBe('draft of b');
    expect(readDraft('thread-b').text).toBe('draft of b');
    expect(readDraft('thread-a')).toEqual({ text: '', skills: [] });
  });

  it('keeps nothing without a draft key (the Assistant view)', async () => {
    const { user } = setup({ providerKind: undefined });
    await user.type(box(), 'ghp_not-a-real-token');
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('sends while a turn runs: the server queues it (spec 50)', async () => {
    const { user, onSend } = setup({ running: true, draftKey: 'thread-a' });
    await user.type(box(), 'Then sum it up{Enter}');
    expect(onSend).toHaveBeenCalledWith('Then sum it up');
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
  });

  it('puts a queued message back before what was typed, with its chips (spec 52)', async () => {
    const { user, handle } = setup({ draftKey: 'thread-a' });
    await user.type(box(), 'and more');
    act(() => handle.current?.putBack('Then sum it up', [{ name: 'tidy-notes', source: 'yours' }]));
    expect(box().value).toBe('Then sum it up\n\nand more');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);
  });
});

const source = { providerInstanceId: 'claude', cwd: '/work/kettle', threadId: 'thread-a' };

describe('the Commands group (agent workbench spec 58 to 61)', () => {
  it("lists wow's commands whose palette command exists, above the skills", async () => {
    const context = {} as CommandContext;
    publishPaletteCommands(
      ['modelBar.chooseModel', 'chat.compact', 'chat.clear', 'chat.markDone'].map((id) =>
        paletteCommand(id),
      ),
      context,
    );
    const { user } = setup({ commandSource: source });
    await user.type(box(), '/');
    const opened = list();
    if (!opened) throw new Error('The list did not open');
    const groups = within(opened).getAllByRole('group');
    const commands = within(opened).getByRole('group', { name: 'Commands' });
    expect(
      within(commands)
        .getAllByRole('option')
        .map((option) => option.textContent?.split(' ')[0]),
    ).toEqual(['/modelChoose', '/compactCompact', '/clearStart', '/doneMark']);
    // Commands first, then Claude Code's, then the skills.
    expect(groups.map((group) => within(group).getAllByRole('option').length)).toEqual([
      4, 1, 1, 1,
    ]);
    expect(within(opened).getByRole('group', { name: 'Claude Code commands' })).toBeTruthy();
    // /fork has no palette command for this thread, so it is not listed.
    expect(within(opened).queryByText('/fork')).toBeNull();
  });

  it('runs the palette command and takes the typed word out of the text', async () => {
    const clear = vi.fn<(context: CommandContext) => void>();
    const context = {} as CommandContext;
    publishPaletteCommands([paletteCommand('chat.clear', clear)], context);
    const { user } = setup({ commandSource: source });
    await user.type(box(), 'later /cle');
    await user.keyboard('{Enter}');
    expect(clear).toHaveBeenCalledWith(context);
    expect(box().value).toBe('later ');
    expect(list()).toBeNull();
  });

  it("lists Claude Code's own commands after wow's and a pick goes into the text (spec 60)", async () => {
    publishPaletteCommands([paletteCommand('chat.clear')], {} as CommandContext);
    const { user, request } = setup({ commandSource: source });
    await user.type(box(), '/');
    const opened = list();
    if (!opened) throw new Error('The list did not open');
    const provider = within(opened).getByRole('group', { name: 'Claude Code commands' });
    // /clear is wow's and deliver-work is a skill, so only Claude Code's own /review is here.
    expect(within(provider).getAllByRole('option')).toHaveLength(1);
    expect(within(provider).getByText('/review')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('provider.listCommands', source);
    await user.type(box(), 'rev');
    await user.keyboard('{Enter}');
    expect(box().value).toBe('/review ');
  });

  it('shows no provider commands where the provider reports none (Codex)', async () => {
    publishPaletteCommands([paletteCommand('chat.clear')], {} as CommandContext);
    const { user } = setup({ commandSource: source, providerKind: 'codex' }, []);
    await user.type(box(), '/');
    const opened = list();
    if (!opened) throw new Error('The list did not open');
    expect(within(opened).getByRole('group', { name: 'Commands' })).toBeTruthy();
    // Commands, then the skills' groups Yours and User: no provider group.
    expect(within(opened).getAllByRole('group')).toHaveLength(3);
    expect(
      within(opened).queryByRole('group', { name: /^(Claude Code|Provider) commands$/ }),
    ).toBeNull();
  });

  it('lists no commands without the open thread (a step thread in the panel)', async () => {
    publishPaletteCommands([paletteCommand('chat.clear')], {} as CommandContext);
    const { user } = setup();
    await user.type(box(), '/');
    expect(within(list() as HTMLElement).queryByRole('group', { name: 'Commands' })).toBeNull();
  });

  it('opens no list at all in the Assistant view (spec 61)', async () => {
    publishPaletteCommands([paletteCommand('chat.clear')], {} as CommandContext);
    const { user } = setup({ providerKind: undefined, commandSource: source });
    await user.type(box(), '/');
    expect(list()).toBeNull();
  });
});
