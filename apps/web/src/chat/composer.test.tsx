import type { Skill, SkillRef } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { activeSkillComposer, skillComposerStore } from './composer-store';
import { Composer, type ComposerHandle } from './composer';
import { createDraftStore } from './draft';
import { skillComposerCommands } from './skill-commands';

// wow skills U3: the composer's skill list, opened by `chat.skillTrigger`, and picked skills as
// chips (spec 16, 17, 19, 20). The whole flow against the server is in e2e/chat.spec.ts.

const skill = (name: string, source: Skill['source'], description = ''): Skill => ({
  id: `${source}/${name}`,
  name,
  description,
  dir: `/skills/${name}`,
  source,
  manualOnly: false,
  invocations: { claude: `/${name}`, codex: `$${name}` },
  ...(source === 'wow' || source === 'yours' ? { text: `Do ${name}.` } : {}),
});

const skills: Skill[] = [
  skill('tidy-notes', 'yours', 'Tidy the notes of a run'),
  skill('wow-handover', 'wow', 'End with a handover'),
  skill('deliver-work', 'user-claude', 'Deliver one unit'),
  skill('check-work', 'user-claude', 'Review delivered work'),
];

const connection: Connection = {
  state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
  request: () => Promise.resolve(null),
  subscribe(topic, _params, onData) {
    onData(topic === 'skills' ? skills : []);
    return () => undefined;
  },
  retry: () => undefined,
  close: () => undefined,
};

type Send = (text: string, picked?: readonly SkillRef[]) => Promise<void>;

function setup(
  { kind, settings = {} }: { kind: 'claude' | undefined; settings?: SettingValues } = {
    kind: 'claude',
  },
) {
  const onSend = vi.fn<Send>(() => Promise.resolve());
  const handle = createRef<ComposerHandle>();
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, settings)),
      }}
    >
      <Composer
        ref={handle}
        providerKind={kind}
        running={false}
        placeholder="Message"
        onSend={onSend}
      />
    </RuntimeProvider>,
  );
  const box = screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement;
  return { onSend, handle, box, user: userEvent.setup() };
}

const list = () => screen.queryByRole('listbox', { name: 'Skills' });
const chips = () =>
  screen.queryAllByTestId('skill-chip').map((chip) => chip.getAttribute('aria-label'));

async function pickTidy(user: ReturnType<typeof userEvent.setup>, box: HTMLTextAreaElement) {
  await user.click(box);
  await user.type(box, '/tidy');
  await user.keyboard('{Enter}');
}

describe('the skill list opens on the trigger (spec 16)', () => {
  it('opens on / at the start or after a space, grouped, and filters as the user types', async () => {
    const { box, user } = setup();
    await user.type(box, '/');
    const opened = list();
    expect(opened).not.toBeNull();
    if (!opened) return;
    expect(within(opened).getAllByRole('group')).toHaveLength(3);
    expect(within(opened).getByRole('group', { name: 'Yours' })).toBeTruthy();
    expect(within(opened).getByRole('group', { name: 'wow' })).toBeTruthy();
    expect(within(opened).getByRole('group', { name: 'User' })).toBeTruthy();
    await user.type(box, 'deli');
    expect(
      within(opened)
        .getAllByRole('option')
        .map((option) => option.dataset['value']),
    ).toEqual(['user-claude/deliver-work', 'user-claude/check-work']);
    await user.clear(box);
    await user.type(box, 'please /che');
    expect(list()).not.toBeNull();
  });

  it('opens nothing on $ while the trigger is /', async () => {
    const { box, user } = setup();
    await user.type(box, '$');
    expect(list()).toBeNull();
    await user.type(box, 'che');
    expect(list()).toBeNull();
  });

  it('opens on $ and not on / with chat.skillTrigger set to $', async () => {
    const { box, user } = setup({ kind: 'claude', settings: { 'chat.skillTrigger': '$' } });
    await user.type(box, '/');
    expect(list()).toBeNull();
    await user.clear(box);
    await user.type(box, '$che');
    expect(list()).not.toBeNull();
    await user.keyboard('{Enter}');
    expect(chips()).toEqual(['check-work, User skill']);
  });
});

describe('a slash in text opens nothing (spec 19)', () => {
  it('opens no list for src/app or 2026/11/12 typed in a sentence', async () => {
    const { box, user } = setup();
    await user.type(box, 'look at src/app');
    expect(list()).toBeNull();
    await user.type(box, ' before 2026/11/12');
    expect(list()).toBeNull();
    expect(box.value).toBe('look at src/app before 2026/11/12');
    expect(chips()).toEqual([]);
  });

  it('makes no chip and opens no list for pasted text with a slash', async () => {
    const { box, user } = setup();
    await user.click(box);
    await user.paste('/deliver-work now');
    expect(list()).toBeNull();
    await user.keyboard('{Enter}');
    expect(chips()).toEqual([]);
    expect(box.value).toBe('');
  });
});

describe('a picked skill is a chip (spec 17)', () => {
  it('turns a pick into a chip with its group mark and takes the query out of the text', async () => {
    const { box, user } = setup();
    await user.type(box, 'please ');
    await user.type(box, '/tidy');
    await user.keyboard('{Enter}');
    expect(list()).toBeNull();
    expect(chips()).toEqual(['tidy-notes, Yours skill']);
    expect(screen.getByTestId('skill-chip').querySelector('[data-group="yours"]')).not.toBeNull();
    expect(box.value).toBe('please ');
  });

  it('removes the chip whole with Backspace directly after it', async () => {
    const { box, user } = setup();
    await pickTidy(user, box);
    await user.type(box, '/deli');
    await user.keyboard('{Enter}');
    expect(chips()).toEqual(['tidy-notes, Yours skill', 'deliver-work, User skill']);
    await user.type(box, 'ab');
    await user.keyboard('{Backspace}{Backspace}');
    expect(chips()).toHaveLength(2);
    await user.keyboard('{Backspace}');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);
    expect(box.value).toBe('');
  });

  it('steps over chips with the arrow keys and back into the text', async () => {
    const { box, user } = setup();
    await pickTidy(user, box);
    await user.type(box, '/deli');
    await user.keyboard('{Enter}');
    await user.type(box, 'go');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    const [first, second] = screen.getAllByTestId('skill-chip');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(second);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    // On a chip, Backspace removes that chip.
    await user.keyboard('{ArrowLeft}{ArrowLeft}{Backspace}');
    expect(chips()).toEqual(['deliver-work, User skill']);
    expect(box.value).toBe('go');
  });

  it('removes a chip with a click', async () => {
    const { box, user } = setup();
    await pickTidy(user, box);
    await user.click(screen.getByRole('button', { name: 'Remove tidy-notes' }));
    expect(chips()).toEqual([]);
  });

  it('adds a starter as a chip', () => {
    const { handle } = setup();
    const starter = skills[2];
    if (starter) act(() => handle.current?.addSkill(starter));
    expect(chips()).toEqual(['deliver-work, User skill']);
  });
});

describe('a message with chips (spec 18)', () => {
  it('sends the text and the picked skills as structured parts', async () => {
    const { box, user, onSend } = setup();
    await pickTidy(user, box);
    await user.type(box, '/hand');
    await user.keyboard('{Enter}');
    await user.type(box, '/deli');
    await user.keyboard('{Enter}');
    await user.type(box, 'the login fix{Enter}');
    expect(onSend).toHaveBeenCalledWith('the login fix', [
      { name: 'tidy-notes', source: 'yours' },
      { name: 'wow-handover', source: 'wow' },
      { name: 'deliver-work' },
    ]);
    expect(chips()).toEqual([]);
    expect(box.value).toBe('');
  });

  it('sends a message that is only a chip, and a message without chips as before', async () => {
    const { box, user, onSend } = setup();
    await pickTidy(user, box);
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenLastCalledWith('', [{ name: 'tidy-notes', source: 'yours' }]);
    await user.type(box, 'Hello{Enter}');
    expect(onSend).toHaveBeenLastCalledWith('Hello');
  });
});

const open = () => skillComposerCommands(activeSkillComposer(skillComposerStore.getState()));

describe('the palette reaches the composer (spec 16, 17)', () => {
  it('opens the list with "Pick a skill" and removes a chip by name', async () => {
    const { box, user } = setup();
    await user.type(box, 'go');
    const pickCommand = open().find((command) => command.id === 'composer.pickSkill');
    expect(pickCommand?.title).toBe('Pick a skill for the message');
    act(() => pickCommand?.run({} as never));
    expect(box.value).toBe('go /');
    expect(list()).not.toBeNull();
    await user.type(box, 'tidy');
    await user.keyboard('{Enter}');
    expect(chips()).toEqual(['tidy-notes, Yours skill']);
    const remove = open().find(
      (command) => command.title === 'Remove skill tidy-notes from the message',
    );
    act(() => remove?.run({} as never));
    expect(chips()).toEqual([]);
  });
});

describe("the assistant's composer (spec 20)", () => {
  it('opens no skill list and offers no palette command', async () => {
    const { box, user } = setup({ kind: undefined });
    await user.type(box, '/tidy');
    expect(list()).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(chips()).toEqual([]);
    expect(activeSkillComposer(skillComposerStore.getState())).toBeUndefined();
  });
});
