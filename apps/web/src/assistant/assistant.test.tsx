import {
  defaultSecretPatterns,
  hiddenText,
  type AssistantChange,
  type AssistantProposal,
  type ThreadItem,
  type TokenGuide,
} from '@wow/contracts';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ReactNode } from 'react';
import type { Connection, ConnectionState } from '@wow/client-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { RuntimeProvider } from '@/app/runtime';
import { Composer, type ComposerHandle } from '@/chat/composer';
import { ConversationItem, type ItemContext } from '@/chat/items';
import { createTestRuntime, renderApp } from '@/test/render';
import { HeldLine } from './assistant-view';
import { SecretFieldCard } from './cards';
import { assistantCommands } from './commands';
import { askOf, askedFields, holdMessage, placeRows, withoutSecret } from './model';
import { ChangeRow, ProposalCard } from './rows';

// The Assistant view (app assistant plan U3). The whole view against a server is in
// e2e/assistant.spec.ts; these cases cover its parts.

const at = '2026-11-10T08:00:00.000Z';
const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

const change = (extra: Partial<AssistantChange> = {}): AssistantChange => ({
  id: 'assistant-c1',
  at,
  commandType: 'setting.set',
  what: 'Work hours',
  from: '08:00–17:00',
  to: '08:00–16:00',
  place: { label: 'Settings → Calendar', path: '/settings/calendar' },
  target: { kind: 'setting', id: 'calendar.workHours:global' },
  state: 'applied',
  undoneAt: null,
  ...extra,
});

const proposal = (extra: Partial<AssistantProposal> = {}): AssistantProposal => ({
  id: 'assistant-p1',
  at,
  commandType: 'setting.set',
  title: 'Turn on scripts in HTML files',
  lines: [{ what: 'Scripts in HTML files', from: 'off', to: 'on' }],
  place: { label: 'Settings → Viewer', path: '/settings/viewer' },
  state: 'pending',
  answeredAt: null,
  reason: null,
  ...extra,
});

let index = 0;
const toolCall = (name: string, input: unknown, output = ''): ThreadItem => ({
  id: `item-${++index}`,
  threadId: 'assistant',
  turnId: 'assistant:turn:0',
  index,
  kind: 'tool_call',
  payload: { name, input, output, status: 'ok' },
  streaming: false,
});
const text = (value: string): ThreadItem => ({
  id: `item-${++index}`,
  threadId: 'assistant',
  turnId: 'assistant:turn:0',
  index,
  kind: 'assistant_text',
  payload: { text: value },
  streaming: false,
});

// The rows link with the router, and the cards read the runtime.
async function show(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/assistant'] }),
  });
  await router.load();
  render(
    <RuntimeProvider runtime={createTestRuntime()}>
      <RouterProvider router={router} />
    </RuntimeProvider>,
  );
  return router;
}

describe('the Assistant section (spec 1)', () => {
  it('sits above Settings and opens from the palette and with its key', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/calendar');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: 'Assistant' }).getAttribute('href')).toBe(
      '/assistant',
    );

    await user.keyboard('{Control>}6{/Control}');
    expect(router.state.location.pathname).toBe('/assistant');
    expect(await screen.findByText('Not connected to the wow server')).toBeTruthy();

    await act(() => router.navigate({ to: '/calendar' }));
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'go to assistant');
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/assistant');
  });
});

describe('placing rows in the conversation (spec 7, 13)', () => {
  it('puts each row after the tool call that made it, in either provider form, and the rest at the end', () => {
    const first = toolCall(
      'mcp__wow__set_setting',
      { key: 'calendar.workHours' },
      JSON.stringify({ outcome: 'changed', change: { id: 'assistant-c1' } }),
    );
    const second = toolCall(
      'wow/set_setting',
      { key: 'viewer.htmlScripts' },
      JSON.stringify({ outcome: 'proposed', proposal: { id: 'assistant-p1' } }),
    );
    // Another server's tool with the same answer is not wow's.
    const other = toolCall(
      'mcp__other__set_setting',
      {},
      JSON.stringify({ change: { id: 'assistant-c3' } }),
    );
    const { after, rest } = placeRows(
      [text('On it.'), first, second, other],
      [change(), change({ id: 'assistant-c2' }), change({ id: 'assistant-c3' })],
      [proposal()],
    );
    expect(after.get(first.id)?.changes.map((row) => row.id)).toEqual(['assistant-c1']);
    expect(after.get(second.id)?.proposals.map((row) => row.id)).toEqual(['assistant-p1']);
    expect(after.has(other.id)).toBe(false);
    expect(rest.changes.map((row) => row.id)).toEqual(['assistant-c2', 'assistant-c3']);
  });

  it('reads the cards a tool call asks for from its input, once the server answered it', () => {
    const field = toolCall(
      'mcp__wow__show_secret_field',
      { key: 'trackers.gitlab.token', projectId: 'tea' },
      JSON.stringify({ outcome: 'shown', secret: 'not set' }),
    );
    const work = toolCall(
      'wow/offer_project_work',
      { text: 'Fix the kettle test' },
      JSON.stringify({ outcome: 'offered' }),
    );
    expect(askOf(field)).toEqual({
      kind: 'secretField',
      request: { key: 'trackers.gitlab.token', projectId: 'tea' },
      guide: null,
    });
    expect(askOf(work)).toEqual({ kind: 'projectWork', offer: { text: 'Fix the kettle test' } });
    expect(askOf(toolCall('mcp__wow__read_settings', {}))).toBeNull();
    expect(
      askOf(
        toolCall(
          'show_secret_field',
          { key: 'trackers.gitlab.token' },
          JSON.stringify({ outcome: 'shown' }),
        ),
      ),
    ).toBeNull();
    expect(askedFields([text('x'), field, work])).toEqual([
      { key: 'trackers.gitlab.token', projectId: 'tea' },
    ]);
  });
});

describe('a change row (spec 7, 8, 20)', () => {
  it('shows what changed, from what to what and its place, with Undo; after Undo it says Undone', async () => {
    const undo = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const router = await show(<ChangeRow change={change()} onUndo={undo} />);
    const row = screen.getByRole('region', { name: 'Change: Work hours' });
    expect(row.textContent).toContain(
      'Work hours: 08:00–17:00 → 08:00–16:00 · Settings → Calendar',
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    await userEvent.click(within(row).getByRole('link', { name: 'Settings → Calendar' }));
    expect(router.state.location.pathname).toBe('/settings/calendar');
  });

  it('is greyed and marked Undone once the server says so, without Undo', async () => {
    await show(
      <ChangeRow
        change={change({ state: 'undone', undoneAt: at })}
        onUndo={vi.fn<() => Promise<void>>()}
      />,
    );
    const row = screen.getByRole('region', { name: 'Change: Work hours' });
    expect(within(row).getByText('Undone')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('shows the reason when Undo is refused', async () => {
    const reason = 'Work hours changed since: it is 09:00–17:00 now.';
    await show(<ChangeRow change={change()} onUndo={() => Promise.reject(new Error(reason))} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((await screen.findByRole('alert')).textContent).toBe(reason);
  });
});

describe('a proposal card (spec 9, 10)', () => {
  it('lists the exact changes; Yes applies it', async () => {
    const yes = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await show(
      <ProposalCard
        secretPatterns={defaultSecretPatterns}
        proposal={proposal()}
        onYes={yes}
        onNo={vi.fn<(reason: string | undefined) => Promise<void>>()}
      />,
    );
    const card = screen.getByRole('region', { name: 'Proposal: Turn on scripts in HTML files' });
    expect(within(card).getByRole('list', { name: 'What would change' }).textContent).toBe(
      'Scripts in HTML files: off → on',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Yes' }));
    expect(yes).toHaveBeenCalledOnce();
  });

  it('shows the whole of a value its line had to shorten, on request', async () => {
    const long = `${'Answer in rhyme and mind the kettle. '.repeat(6)}The end.`;
    render(
      <ProposalCard
        proposal={proposal({
          lines: [
            {
              what: 'Instruction text',
              from: 'the default',
              to: `${long.slice(0, 159)}…`,
              toFull: long,
            },
          ],
        })}
        secretPatterns={defaultSecretPatterns}
        onYes={() => Promise.resolve()}
        onNo={() => Promise.resolve()}
      />,
    );
    const [full] = screen.getAllByTestId('assistant-proposal-full');
    expect(screen.getAllByTestId('assistant-proposal-full')).toHaveLength(1);
    expect(full?.closest('details')?.open).toBe(false);
    await userEvent.click(screen.getByText('Becomes: show all of it'));
    expect(full?.closest('details')?.open).toBe(true);
    expect(full?.textContent).toBe(long);
  });

  it('No takes an optional reason', async () => {
    const no = vi.fn<(reason: string | undefined) => Promise<void>>(() => Promise.resolve());
    await show(
      <ProposalCard
        proposal={proposal()}
        secretPatterns={defaultSecretPatterns}
        onYes={vi.fn<() => Promise<void>>()}
        onNo={no}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reason for no (optional)' }),
      'Not on this machine',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Say no' }));
    expect(no).toHaveBeenCalledWith('Not on this machine');

    no.mockClear();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Reason for no (optional)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Say no' }));
    expect(no).toHaveBeenCalledWith(undefined);
  });

  it('does not send a reason that looks like a secret and says why', async () => {
    const no = vi.fn<(reason: string | undefined) => Promise<void>>(() => Promise.resolve());
    await show(
      <ProposalCard
        proposal={proposal()}
        secretPatterns={defaultSecretPatterns}
        onYes={vi.fn<() => Promise<void>>()}
        onNo={no}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reason for no (optional)' }),
      'Use glpat-abcdefghijklmnopqrstuvwxyz0123 instead',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Say no' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not sent: this looks like a GitLab token. Secrets go in their field, where the assistant never sees them.',
    );
    expect(no).not.toHaveBeenCalled();
  });

  it('a refused Yes shows the reason and still offers No', async () => {
    const reason = '"Turn on scripts in HTML files" was proposed for how things were then.';
    await show(
      <ProposalCard
        secretPatterns={defaultSecretPatterns}
        proposal={proposal()}
        onYes={() => Promise.reject(new Error(reason))}
        onNo={vi.fn<(reason: string | undefined) => Promise<void>>()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect((await screen.findByRole('alert')).textContent).toBe(reason);
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
  });

  it('says how it was answered, with the reason of a No', async () => {
    await show(
      <ProposalCard
        secretPatterns={defaultSecretPatterns}
        proposal={proposal({ state: 'declined', answeredAt: at, reason: 'Not now' })}
        onYes={vi.fn<() => Promise<void>>()}
        onNo={vi.fn<(reason: string | undefined) => Promise<void>>()}
      />,
    );
    expect(screen.getByTestId('assistant-proposal-answer').textContent).toBe(
      'No: nothing changed (Not now)',
    );
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
  });
});

describe('a secret field card (spec 14)', () => {
  it("shows the setting's name, where the value goes, a password field, Save and Test connection", async () => {
    await show(<SecretFieldCard request={{ key: 'trackers.gitlab.token' }} />);
    const card = screen.getByRole('region', { name: 'Secret field: GitLab token' });
    expect(within(card).getByTestId('assistant-secret-target').textContent).toContain(
      'Settings → Trackers, for every project',
    );
    expect(within(card).getByLabelText('GitLab token').getAttribute('type')).toBe('password');
    expect(within(card).getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Test connection' })).toBeTruthy();
    expect(within(card).getByTestId('assistant-secret-state').textContent).toBe('Not set');
  });

  it('draws nothing for a setting that is not secret', async () => {
    await show(<SecretFieldCard request={{ key: 'trackers.gitlab.baseUrl' }} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

const gitlabGuide: TokenGuide = {
  service: 'gitlab',
  host: 'GitLab',
  writtenFor: 'GitLab 16.9 and later, self-managed and gitlab.com',
  tokenSetting: 'trackers.gitlab.token',
  address: 'https://gitlab.example.invalid',
  addressNeeded: null,
  steps: [
    {
      text: 'Open Access tokens under your avatar → Edit profile.',
      link: 'https://gitlab.example.invalid/-/user_settings/personal_access_tokens?name=wow&scopes=read_api',
    },
    { text: 'Press Create personal access token.', link: null },
  ],
  rights: ['read_api: wow reads merge requests.'],
  copy: 'The token GitLab shows once after Create, starting with glpat-.',
};

describe('a card only for a call the server answered', () => {
  const refused = JSON.stringify({
    outcome: 'refused',
    reason: 'calendar.workHours is not a secret setting',
  });

  it('draws no secret field or project work card for a refused, failed or running call', () => {
    for (const status of ['ok', 'error', 'running'] as const) {
      const field = {
        ...toolCall('mcp__wow__show_secret_field', { key: 'calendar.workHours' }, refused),
      };
      const work = toolCall('mcp__wow__offer_project_work', { text: 'Fix it' }, refused);
      for (const item of [field, work]) {
        const payload = { ...(item.payload as Record<string, unknown>), status };
        expect(askOf({ ...item, payload })).toBeNull();
      }
    }
    const shown = JSON.stringify({ outcome: 'shown', secret: 'not set' });
    const running = toolCall(
      'mcp__wow__show_secret_field',
      { key: 'trackers.gitlab.token' },
      shown,
    );
    expect(
      askOf({ ...running, payload: { ...(running.payload as object), status: 'running' } }),
    ).toBeNull();
    expect(askOf(running)).toMatchObject({ kind: 'secretField' });
    expect(
      askedFields([
        running,
        toolCall('mcp__wow__show_secret_field', { key: 'trackers.jira.token' }, refused),
      ]),
    ).toEqual([{ key: 'trackers.gitlab.token' }]);
  });
});

describe('the token guide on a secret field card (spec 15)', () => {
  it('is read from what the secret field tool answered', () => {
    const field = toolCall(
      'mcp__wow__show_secret_field',
      { key: 'trackers.gitlab.token' },
      JSON.stringify({ outcome: 'shown', secret: 'not set', guide: gitlabGuide }),
    );
    expect(askOf(field)).toEqual({
      kind: 'secretField',
      request: { key: 'trackers.gitlab.token' },
      guide: gitlabGuide,
    });
    const unparsed = toolCall(
      'mcp__wow__show_secret_field',
      { key: 'trackers.gitlab.token' },
      JSON.stringify({ outcome: 'shown', secret: 'not set', guide: { steps: 'none' } }),
    );
    expect(askOf(unparsed)).toMatchObject({ guide: null });
    expect(
      askOf(toolCall('mcp__wow__show_secret_field', { key: 'trackers.gitlab.token' }, '{')),
    ).toBeNull();
  });

  it("shows the steps with links to the user's host, the rights, what to copy and the versions, above the field", async () => {
    await show(<SecretFieldCard request={{ key: 'trackers.gitlab.token' }} guide={gitlabGuide} />);
    const card = screen.getByRole('region', { name: 'Secret field: GitLab token' });
    const guide = within(card).getByRole('group', { name: 'Token guide for GitLab' });
    expect(guide.textContent).toContain(
      'GitLab · written for GitLab 16.9 and later, self-managed and gitlab.com',
    );
    expect(
      within(guide)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Open Access tokens') as string,
      'Press Create personal access token.',
      'read_api: wow reads merge requests.',
    ]);
    expect(within(guide).getByRole('link').getAttribute('href')).toBe(
      'https://gitlab.example.invalid/-/user_settings/personal_access_tokens?name=wow&scopes=read_api',
    );
    expect(guide.textContent).toContain('What to copy: The token GitLab shows once');
    const field = within(card).getByLabelText('GitLab token');
    expect(guide.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says which address to fill in first, with a link to its place', async () => {
    await show(
      <SecretFieldCard
        request={{ key: 'trackers.gitlab.token' }}
        guide={{
          ...gitlabGuide,
          address: null,
          addressNeeded: {
            key: 'trackers.gitlab.baseUrl',
            label: 'GitLab URL',
            place: { label: 'Settings → Trackers', path: '/settings/trackers' },
          },
          steps: [{ text: 'Fill in GitLab URL in Settings → Trackers first.', link: null }],
        }}
      />,
    );
    const guide = screen.getByRole('group', { name: 'Token guide for GitLab' });
    expect(
      within(guide).getByRole('link', { name: 'Settings → Trackers' }).getAttribute('href'),
    ).toBe('/settings/trackers');
  });
});

describe('a message that looks like a secret (spec 17)', () => {
  it('is held with its kind and the field it belongs in', () => {
    const held = holdMessage(`Here it is: ${githubToken}`, defaultSecretPatterns, []);
    expect(held).toMatchObject({
      match: { kind: 'a GitHub token', value: githubToken },
      field: { key: 'trackers.github.token', label: 'GitHub token' },
    });
    expect(held && withoutSecret(held)).toBe('Here it is:');
    expect(holdMessage('Make work hours end at four', defaultSecretPatterns, [])).toBeNull();
  });

  it("goes to the field the assistant asked for: the project's own, or the last one asked", () => {
    const asked = [
      { key: 'trackers.github.token', projectId: 'tea' },
      { key: 'trackers.confluence.token' },
    ];
    expect(holdMessage(githubToken, defaultSecretPatterns, asked)?.field).toEqual({
      key: 'trackers.github.token',
      projectId: 'tea',
      label: 'GitHub token',
    });
    const password = 'password: Zq81mXp0Lw3vKe7RtY2uBn5s';
    expect(holdMessage(password, defaultSecretPatterns, asked)).toMatchObject({
      match: { kind: 'a token or password' },
      field: { key: 'trackers.confluence.token', label: 'Confluence token' },
    });
    expect(holdMessage(password, defaultSecretPatterns, [])?.field).toBeNull();
  });

  it('is not sent while the check holds it, and the text stays in the box', async () => {
    const onSend = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    render(
      <RuntimeProvider runtime={createTestRuntime()}>
        <Composer
          providerKind={undefined}
          running={false}
          placeholder="Message"
          onSend={onSend}
          beforeSend={(value) => !value.includes('ghp_')}
          notice={<p>Held</p>}
        />
      </RuntimeProvider>,
    );
    const box = screen.getByRole('combobox', { name: 'Message' });
    await userEvent.type(box, `${githubToken}{Enter}`);
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe(githubToken);
    expect(screen.getByText('Held')).toBeTruthy();
    await userEvent.clear(box);
    await userEvent.type(box, 'Hello{Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello');
  });
});

describe('Send anyway on a held message (spec 17)', () => {
  it("goes through the composer's own send path with the text as it is now", async () => {
    const onSend = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const handle = createRef<ComposerHandle>();
    const runtime = createTestRuntime();
    const view = (running: boolean) => (
      <RuntimeProvider runtime={runtime}>
        <Composer
          ref={handle}
          providerKind={undefined}
          running={running}
          placeholder="Message"
          onSend={onSend}
          beforeSend={(value) => !value.includes('ghp_')}
        />
      </RuntimeProvider>
    );
    const { rerender } = render(view(true));
    const box = screen.getByRole('combobox', { name: 'Message' });
    await userEvent.type(box, `${githubToken}{Enter}`);
    await userEvent.type(box, ' for the bot');
    act(() => handle.current?.sendUnchecked());
    // A turn is running: the message waits in the queue like any other, and as edited.
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('queued-message').textContent).toContain(
      `${githubToken} for the bot`,
    );
    rerender(view(false));
    expect(onSend).toHaveBeenCalledWith(`${githubToken} for the bot`);
  });
});

const runtimeWithSettings = (rows: unknown[]) => {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: () => Promise.resolve(null),
    subscribe(topic, _params, onData) {
      onData(topic === 'settings' ? rows : []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return { ...createTestRuntime(), connection };
};
const held = () => {
  const found = holdMessage(githubToken, defaultSecretPatterns, []);
  if (!found) throw new Error('not held');
  return found;
};

const line = (
  rows: unknown[],
  onPut = vi.fn<(replaces: boolean) => Promise<void>>(() => Promise.resolve()),
) => {
  render(
    <RuntimeProvider runtime={runtimeWithSettings(rows)}>
      <HeldLine held={held()} onPut={onPut} onSend={() => undefined} onDismiss={() => undefined} />
    </RuntimeProvider>,
  );
  return onPut;
};

describe('Put it in <field> on a held message (spec 17)', () => {
  it('says that it replaces the value the field already holds', async () => {
    const onPut = line([
      {
        key: 'trackers.github.token',
        scope: 'global',
        value: { secretRef: 'setting:trackers.github.token' },
      },
    ]);
    expect(screen.getByTestId('held-replaces').textContent).toBe(
      'GitHub token already holds a value; putting this one there replaces it.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Put it in GitHub token' }));
    expect(onPut).toHaveBeenCalledWith(true);
  });

  it('says nothing of replacing for an empty field, or one set only for a project', () => {
    line([
      {
        key: 'trackers.github.token',
        scope: 'project:tea',
        value: { secretRef: 'setting:project:tea:trackers.github.token' },
      },
    ]);
    expect(screen.getByRole('button', { name: 'Put it in GitHub token' })).toBeTruthy();
    expect(screen.queryByTestId('held-replaces')).toBeNull();
  });
});

describe('a stored tool result the net caught (spec 18)', () => {
  it('shows [hidden] where the value was', async () => {
    const context: ItemContext = {
      cwd: '/home/me/.wow/assistant',
      permissionLabel: 'Tools only',
      turnEnded: true,
      at: undefined,
      awaitingApproval: false,
      formatAt: (iso) => iso,
    };
    render(
      <ul>
        <ConversationItem
          item={toolCall('mcp__wow__read_settings', {}, `{"value":"${hiddenText}"}`)}
          approvals={[]}
          questions={[]}
          context={context}
        />
      </ul>,
    );
    await userEvent.click(screen.getByText('mcp__wow__read_settings'));
    expect(screen.getByRole('region', { name: 'Tool output' }).textContent).toContain(
      `{"value":"${hiddenText}"}`,
    );
  });
});

describe('palette commands for the assistant (spec 8, 9)', () => {
  it('offer Yes and No for a waiting proposal and Undo for an applied change', () => {
    const commands = assistantCommands({
      changes: [change({ id: 'old' }), change(), change({ id: 'gone', state: 'undone' })],
      proposals: [proposal(), proposal({ id: 'answered', state: 'accepted' })],
    });
    expect(
      commands.map((command) => [command.title, command.needsYou ?? false, command.searchOnly]),
    ).toEqual([
      ['Yes: Turn on scripts in HTML files', true, undefined],
      ['No: Turn on scripts in HTML files', false, undefined],
      ['Undo: Work hours', false, true],
      ['Undo: Work hours', false, false],
    ]);
  });
});
