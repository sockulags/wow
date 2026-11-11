import type { Command, Skill } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox, type Outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';
import { closeSkillEditor, skillCommands } from './skills';

// Settings → Skills, "Your skills" (wow skills spec 3, 5), against a fake server. The skills
// are invented.

const kettle: Skill = {
  id: '/home/me/.wow/skills/kettle-check',
  name: 'kettle-check',
  description: 'Before any tea step.',
  dir: '/home/me/.wow/skills/kettle-check',
  source: 'yours',
  manualOnly: false,
  invocations: { claude: '/kettle-check', codex: '$kettle-check' },
  text: 'Boil first.',
};

const verdict: Skill = {
  id: '/app/builtin/wow-verdict',
  name: 'wow-verdict',
  description: 'End with exactly one verdict line.',
  dir: '/app/builtin/wow-verdict',
  source: 'wow',
  manualOnly: false,
  invocations: { claude: '/wow-verdict', codex: '$wow-verdict' },
  text: 'End with {{approvedLine}} when it is approved.',
};

const folder: Skill = {
  id: '/home/me/.claude/skills/tidy-up',
  name: 'tidy-up',
  description: 'Tidies the imports.',
  dir: '/home/me/.claude/skills/tidy-up',
  source: 'user-claude',
  manualOnly: false,
  invocations: { claude: '/tidy-up', codex: '$tidy-up' },
};

interface Sent {
  readonly method: string;
  readonly params: unknown;
}

function fake(box: Outbox<Sent>, refuse?: string): Runtime {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      box.record({ method, params });
      if (method !== 'dispatch') return Promise.resolve([]);
      if (refuse !== undefined) return Promise.reject(new Error(refuse));
      const { commandId } = params as { commandId: string };
      return Promise.resolve({ commandId, seqs: [box.sent.length], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData(topic === 'skills' ? [kettle, verdict, folder] : []);
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

const commandsSent = (box: Outbox<Sent>): Command[] =>
  box.sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Command }).command);

async function open(refuse?: string) {
  const box = outbox<Sent>();
  await renderApp('/settings/skills', fake(box, refuse));
  const user = userEvent.setup();
  const yours = within(await screen.findByRole('region', { name: 'Your skills' }));
  const sent = (count: number) => act(() => box.until(() => commandsSent(box).length >= count));
  return { box, user, yours, sent };
}

afterEach(closeSkillEditor);

describe('Your skills in Settings → Skills (spec 5)', () => {
  it('lists own skills with Edit and Delete, and built-in skills read-only with their text (spec 3)', async () => {
    const { yours } = await open();
    expect(yours.getAllByTestId('own-skill').map((row) => row.getAttribute('aria-label'))).toEqual([
      'kettle-check',
    ]);
    const builtIn = within(screen.getByRole('region', { name: 'Built-in skills' }));
    const row = within(builtIn.getByRole('listitem', { name: 'wow-verdict' }));
    expect(row.getByText('Read-only')).toBeTruthy();
    expect(row.getByTestId('skill-text').textContent).toBe(
      'End with {{approvedLine}} when it is approved.',
    );
    expect(row.queryByRole('button', { name: /Edit|Delete/ })).toBeNull();
    // A folder skill is neither yours nor built in.
    expect(screen.queryByRole('listitem', { name: 'tidy-up' })).toBeNull();
  });

  it('refuses a name the rule refuses with its reason and sends nothing, then writes a new skill that Undo deletes', async () => {
    const { box, user, yours, sent } = await open();
    await user.click(yours.getByRole('button', { name: 'New skill' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New skill' }));
    await user.type(dialog.getByLabelText('Name'), 'wow-pour');
    await user.type(dialog.getByLabelText('Text'), 'Pour slowly.');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(
      dialog.getByText('Names starting with wow- are kept for the skills wow ships'),
    ).toBeTruthy();
    expect(commandsSent(box)).toEqual([]);

    await user.clear(dialog.getByLabelText('Name'));
    await user.type(dialog.getByLabelText('Name'), 'pour-over');
    await user.type(dialog.getByLabelText('When to use it'), 'When tea is poured.');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await sent(1);
    expect(commandsSent(box)).toEqual([
      {
        type: 'skill.create',
        skill: { name: 'pour-over', description: 'When tea is poured.', text: 'Pour slowly.' },
      },
    ]);
    // The toast's action takes a plain click; jsdom has no pointer capture for a drag.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await sent(2);
    expect(commandsSent(box)[1]).toEqual({ type: 'skill.delete', name: 'pour-over' });
  });

  it("shows the server's refusal in the editor and keeps it open", async () => {
    const { user, yours } = await open('There is already a wow skill named pour-over');
    await user.click(yours.getByRole('button', { name: 'New skill' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New skill' }));
    await user.type(dialog.getByLabelText('Name'), 'pour-over');
    await user.type(dialog.getByLabelText('Text'), 'Pour slowly.');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('There is already a wow skill named pour-over')).toBeTruthy();
  });

  it('edits a skill under its name, and Undo puts the old text back', async () => {
    const { box, user, yours, sent } = await open();
    await user.click(yours.getByRole('button', { name: 'Edit kettle-check' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit kettle-check' }));
    expect((dialog.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    await user.clear(dialog.getByLabelText('Text'));
    await user.type(dialog.getByLabelText('Text'), 'Boil twice.');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await sent(1);
    expect(commandsSent(box)).toEqual([
      {
        type: 'skill.update',
        skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil twice.' },
      },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await sent(2);
    expect(commandsSent(box)[1]).toEqual({
      type: 'skill.update',
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil first.' },
    });
  });

  it('deletes a skill at once, and Undo writes it again', async () => {
    const { box, user, yours, sent } = await open();
    await user.click(yours.getByRole('button', { name: 'Delete kettle-check' }));
    await sent(1);
    expect(commandsSent(box)).toEqual([{ type: 'skill.delete', name: 'kettle-check' }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await sent(2);
    expect(commandsSent(box)[1]).toEqual({
      type: 'skill.create',
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil first.' },
    });
  });
});

describe('palette commands for your skills', () => {
  it('offer New skill, and Edit and Delete for each own skill only', () => {
    expect(skillCommands([kettle, verdict, folder]).map((command) => command.title)).toEqual([
      'New skill',
      'Edit skill: kettle-check',
      'Delete skill: kettle-check',
    ]);
  });
});
