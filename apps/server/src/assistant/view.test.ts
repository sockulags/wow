import {
  assistantThreadId,
  hiddenText,
  type AssistantChange,
  type AssistantProposal,
  type ProviderCommand,
  type ProviderEvent,
  type ServerCommand,
  type SubscriptionTopic,
  type ThreadItem,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { commandReceipts, events } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';

// What the Assistant view relies on from the server (app assistant plan U3): the secret field
// tool, the offer to take project work to the chat view, the net over what the agent reports,
// and the note that tells the agent what the user answered.

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

// Invented values. The saved secret may never leave the secret store.
const savedSecret = 'wow-marked-field-value-7f3a21';
const lookalike = 'glpat-abcdefghijklmnopqrstuvwxyz0123';

let root: string;
let server: RunningServer;
let adapter: MockProviderAdapter;
let logLines: string[];
let hostHeaders: string[];
let ids = 0;
// The server's clock; a case moves it on instead of waiting.
let clock = Date.parse('2026-11-10T08:00:00.000Z');
const tick = () => {
  clock += 1000;
};
// What the mock agent answers the next startTurn with.
let script: (threadId: string) => ProviderEvent[];

const quiet = (threadId: string): ProviderEvent[] => [
  { type: 'textDelta', threadId, itemId: `${threadId}-answer`, delta: 'Done.' },
  { type: 'turnCompleted', threadId },
];

const dispatch = (command: ServerCommand) => server.engine.dispatch(`v${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, { topic, ...(threadId ? { threadId } : {}) }) as T[];

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Record<string, unknown> };
}

// Resolves when a commit ends a turn of the assistant thread: no sleeping or polling.
function turnEnds(): Promise<void> {
  return new Promise((resolve) => {
    const off = server.engine.onCommit((commit) => {
      const ended = commit.events.some(
        ({ event }) => event.kind === 'turn.ended' && event.payload.threadId === assistantThreadId,
      );
      if (!ended) return;
      off();
      resolve();
    });
  });
}

async function say(text: string): Promise<void> {
  const ended = turnEnds();
  dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text });
  await ended;
}

const prompts = () =>
  adapter.sent
    .filter((command): command is StartTurn => command.type === 'startTurn')
    .map((command) => command.prompt);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-view-'));
  logLines = [];
  hostHeaders = [];
  script = quiet;
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: (line) => logLines.push(line),
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(clock),
    fetch: (input, init) => {
      hostHeaders.push(JSON.stringify([...new Request(input, init).headers]));
      return Promise.resolve(Response.json({ id: 7, username: 'ada', name: 'Ada' }));
    },
    hooks: {
      providers: {
        claude: () => {
          adapter = new MockProviderAdapter('claude', (command) =>
            command.type === 'startTurn' ? script(command.threadId) : [],
          );
          return adapter;
        },
      },
    },
  });
  dispatch({ type: 'setting.set', key: 'advanced.logLevel', scope: 'global', value: 'debug' });
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Claude at work',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  await server.providerService.test('claude-work');
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
  dispatch({ type: 'thread.openAssistant' });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the secret field tool (spec 14, 16)', () => {
  it('shows the field for a secret setting and its target, says only set or not set, and refuses anything else', async () => {
    const shown = await call('show_secret_field', { key: 'trackers.gitlab.token' });
    expect(shown).toMatchObject({
      isError: false,
      content: {
        outcome: 'shown',
        setting: { key: 'trackers.gitlab.token', label: 'GitLab token' },
        target: 'Settings → Trackers, for every project',
        secret: 'not set',
      },
    });
    const own = await call('show_secret_field', { key: 'trackers.gitlab.token', projectId: 'tea' });
    expect(own.content).toMatchObject({ target: 'Settings → Projects → Tea', secret: 'not set' });

    for (const args of [
      { key: 'trackers.gitlab.baseUrl' },
      { key: 'no.such.setting' },
      { key: 'trackers.gitlab.token', projectId: 'gone' },
    ]) {
      expect(await call('show_secret_field', args)).toMatchObject({
        isError: true,
        content: { outcome: 'refused' },
      });
    }
    expect(
      await call('show_secret_field', { key: 'trackers.gitlab.token', value: 'x' }),
    ).toMatchObject({ isError: true, content: { outcome: 'invalid input' } });
  });

  it("shows a field for a provider instance's secret environment variable (spec 14), says only set or not set, and refuses anything else", async () => {
    const shown = await call('show_secret_variable', {
      providerInstanceId: 'claude-work',
      variable: 'ANTHROPIC_API_KEY',
    });
    expect(shown).toMatchObject({
      isError: false,
      content: {
        outcome: 'shown',
        variable: { providerInstanceId: 'claude-work', name: 'ANTHROPIC_API_KEY' },
        target: 'Settings → Providers → Claude at work',
        secret: 'not set',
      },
    });
    // What the card does: the value goes to the secret store, the instance holds its reference.
    const ref = await server.secrets.set('provider:claude-work:env:ANTHROPIC_API_KEY', savedSecret);
    dispatch({
      type: 'providerInstance.update',
      providerInstanceId: 'claude-work',
      env: { ANTHROPIC_API_KEY: ref },
    });
    const set = await call('show_secret_variable', {
      providerInstanceId: 'claude-work',
      variable: 'ANTHROPIC_API_KEY',
    });
    expect(set.content).toMatchObject({ secret: 'set' });
    expect(set.text).not.toContain(savedSecret);

    for (const args of [
      { providerInstanceId: 'gone', variable: 'ANTHROPIC_API_KEY' },
      { providerInstanceId: 'claude-work', variable: 'not a name' },
    ]) {
      expect(await call('show_secret_variable', args)).toMatchObject({ isError: true });
    }
    expect(
      await call('show_secret_variable', {
        providerInstanceId: 'claude-work',
        variable: 'ANTHROPIC_API_KEY',
        value: 'x',
      }),
    ).toMatchObject({ isError: true, content: { outcome: 'invalid input' } });
  });

  it('a value saved in the field reaches no message, tool result, stored event or log line; the agent learns set and the test result', async () => {
    dispatch({
      type: 'setting.set',
      key: 'trackers.gitlab.baseUrl',
      scope: 'global',
      value: 'https://gitlab.example.test',
    });
    // What the field does: the value goes to the secret store, the setting holds its reference.
    dispatch({
      type: 'setting.set',
      key: 'trackers.gitlab.token',
      scope: 'global',
      value: await server.secrets.set('setting:trackers.gitlab.token', savedSecret),
    });
    const texts = [
      (await call('show_secret_field', { key: 'trackers.gitlab.token' })).text,
      (await call('read_settings', { group: 'trackers' })).text,
    ];
    const tested = await call('test_connection', { service: 'gitlab' });
    texts.push(tested.text);
    expect(tested.content).toMatchObject({ passed: true, account: 'Ada @ada' });
    expect(JSON.parse(texts[0] ?? '{}')).toMatchObject({ secret: 'set' });
    // The host did get it, so the search below is not passing for want of a secret.
    expect(hostHeaders.some((value) => value?.includes(savedSecret))).toBe(true);

    script = (threadId) => [
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'field',
        name: 'mcp__wow__show_secret_field',
        input: { key: 'trackers.gitlab.token' },
      },
      { type: 'toolCallOutput', threadId, itemId: 'field', output: texts[0] ?? '' },
      { type: 'toolCallCompleted', threadId, itemId: 'field', status: 'ok' },
      ...quiet(threadId),
    ];
    await say('Set up GitLab for me');

    const stored = [
      ...server.database.db.select().from(events).all(),
      ...server.database.db.select().from(commandReceipts).all(),
      ...rows<ThreadItem>('threadItems', assistantThreadId),
    ].map((row) => JSON.stringify(row));
    for (const text of [...texts, ...stored, ...logLines, ...prompts()]) {
      expect(text).not.toContain(savedSecret);
    }
  });
});

describe('the offer to take project work to the chat view (spec 3)', () => {
  it('answers that the button is shown and changes nothing', async () => {
    const offered = await call('offer_project_work', { text: 'Fix the failing kettle test' });
    expect(offered).toMatchObject({ isError: false, content: { outcome: 'offered' } });
    expect(rows('assistantChanges')).toEqual([]);
    expect(rows('assistantProposals')).toEqual([]);
    expect(await call('offer_project_work', {})).toMatchObject({ isError: true });
  });
});

describe("the net over the agent's own reports (spec 18)", () => {
  it('stores a tool result, tool input and text that look like a secret as [hidden]', async () => {
    script = (threadId) => [
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'tool',
        name: 'mcp__wow__read_settings',
        input: { note: `token ${lookalike}` },
      },
      { type: 'toolCallOutput', threadId, itemId: 'tool', output: `{"value":"${lookalike}"}` },
      { type: 'toolCallCompleted', threadId, itemId: 'tool', status: 'ok' },
      { type: 'textDelta', threadId, itemId: 'text', delta: `It is ${lookalike}.` },
      { type: 'turnCompleted', threadId },
    ];
    await say('What is in my settings?');

    const items = rows<ThreadItem>('threadItems', assistantThreadId);
    const tool = items.find((entry) => entry.kind === 'tool_call');
    expect(tool?.payload).toMatchObject({
      input: { note: `token ${hiddenText}` },
      output: `{"value":"${hiddenText}"}`,
    });
    expect(items.find((entry) => entry.kind === 'assistant_text')?.payload).toEqual({
      text: `It is ${hiddenText}.`,
    });
    const stored = server.database.db
      .select()
      .from(events)
      .all()
      .map((row) => JSON.stringify(row));
    for (const text of stored) expect(text).not.toContain(lookalike);
  });

  it('hides a lookalike split across two text pieces, and a task that looks like a secret', async () => {
    const half = lookalike.length / 2;
    script = (threadId) => [
      { type: 'textDelta', threadId, itemId: 'text', delta: `It is ${lookalike.slice(0, half)}` },
      { type: 'textDelta', threadId, itemId: 'text', delta: `${lookalike.slice(half)} now.` },
      {
        type: 'taskListUpdated',
        threadId,
        tasks: [{ id: 't1', content: `Store ${lookalike}`, status: 'pending' }],
      },
      { type: 'turnCompleted', threadId },
    ];
    await say('What is in my settings?');

    const items = rows<ThreadItem>('threadItems', assistantThreadId);
    expect(items.find((entry) => entry.kind === 'assistant_text')?.payload).toEqual({
      text: `It is ${hiddenText} now.`,
    });
    expect(items.find((entry) => entry.kind === 'task_list')?.payload).toEqual({
      tasks: [{ id: 't1', content: `Store ${hiddenText}`, status: 'pending' }],
      at: expect.any(String),
    });
    const stored = server.database.db
      .select()
      .from(events)
      .all()
      .map((row) => JSON.stringify(row));
    for (const text of stored) {
      expect(text).not.toContain(lookalike);
      expect(text).not.toContain(lookalike.slice(half));
    }
  });

  it('leaves an ordinary thread as the agent reported it', async () => {
    dispatch({
      type: 'thread.create',
      threadId: 'chat-1',
      providerInstanceId: 'claude-work',
      cwd: root,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    script = (threadId) => [
      { type: 'textDelta', threadId, itemId: 'text', delta: lookalike },
      { type: 'turnCompleted', threadId },
    ];
    const ended = new Promise<void>((resolve) => {
      const off = server.engine.onCommit((commit) => {
        if (!commit.events.some(({ event }) => event.kind === 'turn.ended')) return;
        off();
        resolve();
      });
    });
    dispatch({ type: 'thread.sendMessage', threadId: 'chat-1', text: 'Hello' });
    await ended;
    expect(
      rows<ThreadItem>('threadItems', 'chat-1').find((entry) => entry.kind === 'assistant_text')
        ?.payload,
    ).toEqual({ text: lookalike });
  });
});

describe("the user's answers in the agent's next turn (spec 8, 10)", () => {
  it('refuses a No whose reason looks like a secret with the held sentence, and keeps nothing of it', async () => {
    await call('set_setting', { key: 'viewer.htmlScripts', scope: 'global', value: true });
    const [proposal] = rows<AssistantProposal>('assistantProposals');
    expect(() =>
      dispatch({
        type: 'assistant.proposal.decline',
        proposalId: proposal?.id ?? '',
        reason: `Not now, use ${lookalike}`,
      }),
    ).toThrow(
      'Not sent: this looks like a GitLab token. Secrets go in their field, where the assistant never sees them.',
    );
    expect(rows<AssistantProposal>('assistantProposals')[0]?.state).toBe('pending');
    const stored = JSON.stringify([
      server.database.db.select().from(events).all(),
      server.database.db.select().from(commandReceipts).all(),
    ]);
    expect(stored).not.toContain(lookalike);
  });

  it('a Yes, a No with its reason and an Undo reach the next prompt once, and the message shows alone', async () => {
    const changed = await call('set_setting', {
      key: 'calendar.showWeekends',
      scope: 'global',
      value: false,
    });
    expect(changed.content['outcome']).toBe('changed');
    await call('set_setting', { key: 'viewer.htmlScripts', scope: 'global', value: true });
    await call('set_setting', { key: 'scheduler.missedPolicy', scope: 'global', value: 'run' });
    const [yes, no] = rows<AssistantProposal>('assistantProposals');
    const [change] = rows<AssistantChange>('assistantChanges');

    await say('Hello');
    expect(prompts()).toEqual(['Hello']);

    tick();
    dispatch({ type: 'assistant.proposal.accept', proposalId: yes?.id ?? '' });
    dispatch({
      type: 'assistant.proposal.decline',
      proposalId: no?.id ?? '',
      reason: 'Not now, https://reader:hunter2pass@gitlab.example.invalid is the host',
    });
    dispatch({ type: 'assistant.undo', changeId: change?.id ?? '' });
    tick();
    await say('What now?');
    tick();
    await say('And now?');

    const [, second, third] = prompts();
    expect(second).toContain(`Yes to "${yes?.title}": it is applied.`);
    expect(second).toContain(
      `No to "${no?.title}": nothing changed. Their reason: Not now, https://gitlab.example.invalid is the host`,
    );
    expect(second).toContain(`Undid "${change?.what}" (Settings → Calendar).`);
    expect(second?.endsWith('\n\nWhat now?')).toBe(true);
    expect(second).not.toContain(lookalike);
    expect(third).toBe('And now?');
    const users = rows<ThreadItem>('threadItems', assistantThreadId)
      .filter((entry) => entry.kind === 'user')
      .map((entry) => entry.payload);
    expect(users).toEqual([{ text: 'Hello' }, { text: 'What now?' }, { text: 'And now?' }]);
  });
});
