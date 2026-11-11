import {
  RpcResponse,
  ServerMessage,
  assistantCodexOff,
  assistantThreadId,
  defaultAssistantInstructions,
  settingsRegistry,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderTestResult,
  type ServerCommand,
  type SubscriptionTopic,
  type Thread,
  type ThreadItem,
  type Turn,
  type WorkflowRun,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { events } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';
import { assistantFolder } from './thread.js';

// The assistant thread on the server (app assistant plan U2). The options each real adapter
// sends for such a turn are asserted in the adapters' own tests; here the mock adapter shows
// what the server hands them.

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

let root: string;
let home: string;
let server: RunningServer;
let logLines: string[];
let adapters: Map<string, MockProviderAdapter>;
let testResults: Map<string, ProviderTestResult>;
let ids = 0;

const passed: ProviderTestResult = { ok: true, account: 'ada', version: '1.0.0', message: null };
const signedOut: ProviderTestResult = {
  ok: false,
  account: null,
  version: null,
  message: 'Not signed in',
};

const answer = (command: ProviderCommand): ProviderEvent[] => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  return [
    { type: 'session', threadId, providerSessionId: `session-of-${threadId}` },
    { type: 'textDelta', threadId, itemId: `${threadId}-answer`, delta: 'Done.' },
    { type: 'turnCompleted', threadId },
  ];
};

const factory = (row: { id: string; kind: 'claude' | 'codex' }) => {
  const adapter = new MockProviderAdapter(
    row.kind,
    answer,
    () => testResults.get(row.id) ?? passed,
  );
  adapters.set(row.id, adapter);
  return adapter;
};

async function launch(): Promise<RunningServer> {
  return startServer({
    home,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: (line) => logLines.push(line),
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: { providers: { claude: factory, codex: factory } },
  });
}

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);

function refusal(send: () => unknown): string | undefined {
  try {
    send();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return undefined;
}

const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, { topic, ...(threadId ? { threadId } : {}) }) as T[];
const assistantThread = () => rows<Thread>('assistantThread')[0];

async function instance(
  id: string,
  kind: 'claude' | 'codex',
  name: string,
  configDir = '',
): Promise<void> {
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: id,
    kind,
    name,
    binaryPath: kind,
    configDir,
    env: {},
    launchArgs: [],
    defaultModel: kind === 'claude' ? 'opus' : 'gpt-6.1-sol',
    defaultEffort: 'high',
    defaultPermissionMode: kind === 'claude' ? 'acceptEdits' : 'full-access',
  });
  await server.providerService.test(id);
}

const allowCodex = (value: boolean) =>
  dispatch({ type: 'setting.set', key: 'assistant.allowCodex', scope: 'global', value });

interface Opened {
  readonly thread: Thread | null;
  readonly problem: string | null;
}

// `assistant.open` the way a view asks for it: over the app's own connection.
function open(): Promise<Opened> {
  const socket = new WebSocket(server.url);
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () =>
      socket.send(JSON.stringify({ id: '1', method: 'assistant.open', params: {} })),
    );
    socket.on('message', (raw) => {
      const message = RpcResponse.parse(ServerMessage.parse(JSON.parse(String(raw))));
      socket.close();
      if ('error' in message) reject(new Error(message.error.message));
      else resolve(message.result as Opened);
    });
  });
}

// Resolves when a commit ends a turn of the thread: no sleeping or polling.
function turnEnds(threadId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = server.engine.onCommit((commit) => {
      const ended = commit.events.some(
        ({ event }) => event.kind === 'turn.ended' && event.payload.threadId === threadId,
      );
      if (!ended) return;
      off();
      resolve();
    });
  });
}

async function say(threadId: string, text: string): Promise<void> {
  const ended = turnEnds(threadId);
  dispatch({ type: 'thread.sendMessage', threadId, text });
  await ended;
}

const startTurns = (instanceId: string) =>
  (adapters.get(instanceId)?.sent ?? []).filter(
    (command): command is StartTurn => command.type === 'startTurn',
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-thread-'));
  home = path.join(root, '.wow');
  logLines = [];
  adapters = new Map();
  testResults = new Map();
  await mkdir(path.join(root, 'tea'));
  await mkdir(path.join(root, 'user', '.claude', 'skills', 'brew'), { recursive: true });
  await writeFile(
    path.join(root, 'user', '.claude', 'skills', 'brew', 'SKILL.md'),
    '---\nname: brew\ndescription: Invented skill\n---\n',
  );
  server = await launch();
  dispatch({ type: 'setting.set', key: 'advanced.logLevel', scope: 'global', value: 'debug' });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('asking for the assistant thread (spec 1)', () => {
  it('makes it once on the first connected instance and finds it again after a restart', async () => {
    // With Codex allowed, as delivered first: a Codex instance can be the first connected one.
    allowCodex(true);
    testResults.set('claude-home', signedOut);
    await instance('claude-home', 'claude', 'Claude at home');
    await instance('codex-work', 'codex', 'Codex at work');
    await instance('claude-work', 'claude', 'Claude at work');

    const first = await open();
    expect(first.problem).toBeNull();
    expect(first.thread).toMatchObject({
      id: assistantThreadId,
      kind: 'assistant',
      projectId: null,
      cwd: assistantFolder(home),
      // The first one that passed its test, not the first one made.
      providerInstanceId: 'codex-work',
      model: 'gpt-6.1-sol',
      effort: 'high',
      // Never the instance's own default mode (full access here).
      permissionMode: 'read-only',
      title: 'Assistant',
    });
    const second = await open();
    expect(second).toEqual(first);
    expect(rows<Thread>('assistantThread')).toHaveLength(1);

    await say(assistantThreadId, 'Which projects do I have?');
    await server.stop();
    server = await launch();
    const again = await open();
    expect(again.problem).toBeNull();
    expect(again.thread).toMatchObject({
      id: assistantThreadId,
      createdAt: first.thread?.createdAt,
      providerInstanceId: 'codex-work',
      providerSessionId: `session-of-${assistantThreadId}`,
    });
    expect(rows<Thread>('assistantThread')).toHaveLength(1);
    // The conversation is still there, and the next turn goes on with the provider's session.
    const texts = rows<ThreadItem>('threadItems', assistantThreadId).map((item) => item.payload);
    expect(texts).toEqual([{ text: 'Which projects do I have?' }, { text: 'Done.' }]);
    await say(assistantThreadId, 'And workflows?');
    expect(startTurns('codex-work').at(-1)).toMatchObject({
      resumeId: `session-of-${assistantThreadId}`,
    });
  });

  it('uses assistant.providerInstanceId, assistant.model and assistant.effort when they are set, and follows a change', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await instance('codex-work', 'codex', 'Codex at work');
    allowCodex(true);
    const set = (key: string, value: string) =>
      dispatch({ type: 'setting.set', key, scope: 'global', value });
    set('assistant.providerInstanceId', 'codex-work');
    set('assistant.model', 'gpt-6.1-luna');
    set('assistant.effort', 'low');
    expect((await open()).thread).toMatchObject({
      providerInstanceId: 'codex-work',
      model: 'gpt-6.1-luna',
      effort: 'low',
    });
    await say(assistantThreadId, 'Hello');

    set('assistant.providerInstanceId', 'claude-work');
    dispatch({ type: 'setting.reset', key: 'assistant.model', scope: 'global' });
    dispatch({ type: 'setting.reset', key: 'assistant.effort', scope: 'global' });
    // The next message already goes to the instance named now, without asking for the thread.
    await say(assistantThreadId, 'Hello again');
    expect(startTurns('claude-work')).toHaveLength(1);
    expect(startTurns('claude-work')[0]).toMatchObject({ model: 'opus', effort: 'high' });
    // Codex's session means nothing to Claude Code.
    expect(startTurns('claude-work')[0]?.resumeId).toBeUndefined();
    expect(assistantThread()).toMatchObject({
      providerInstanceId: 'claude-work',
      permissionMode: 'dontAsk',
    });
    expect(rows<Turn>('turns', assistantThreadId)).toHaveLength(2);
  });

  it('cannot be made, configured or opened as an ordinary thread', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.create',
          threadId: assistantThreadId,
          providerInstanceId: 'claude-work',
          cwd: path.join(root, 'tea'),
          model: 'opus',
          effort: 'high',
          permissionMode: 'bypassPermissions',
        }),
      ),
    ).toBe("The id assistant is the assistant's");
    await open();
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.configure',
          threadId: assistantThreadId,
          permissionMode: 'bypassPermissions',
        }),
      ),
    ).toBe("The assistant's model and effort are set in Settings → Assistant");
    expect(
      refusal(() =>
        server.engine.dispatch('from-assistant', { type: 'thread.openAssistant' }, 'assistant'),
      ),
    ).toBe('The assistant thread is opened by the user, in the Assistant view.');
  });
});

describe("the assistant's turn (spec 2)", () => {
  it("is handed wow's tools, the instruction text and the app's empty folder", async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await say(assistantThreadId, 'Set my work hours to 8 to 4');
    expect(startTurns('claude-work')).toEqual([
      {
        type: 'startTurn',
        threadId: assistantThreadId,
        cwd: assistantFolder(home),
        prompt: 'Set my work hours to 8 to 4',
        model: 'opus',
        effort: 'high',
        permissionMode: 'dontAsk',
        toolset: { name: 'wow', url: server.assistant.url, token: server.assistant.token },
        instructions: defaultAssistantInstructions,
      },
    ]);
    expect(assistantFolder(home)).toBe(path.join(home, 'assistant'));
    expect(await readdir(assistantFolder(home))).toEqual([]);
  });

  it('keeps the token out of the event history and the log', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await say(assistantThreadId, 'Set my work hours to 8 to 4');
    const history = JSON.stringify(server.database.db.select().from(events).all());
    expect(history).toContain('Set my work hours to 8 to 4');
    expect(history).not.toContain(server.assistant.token);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(server.assistant.token);
  });

  it('fails the turn with the reason when its folder is not empty, and starts nothing there', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await mkdir(assistantFolder(home), { recursive: true });
    await writeFile(path.join(assistantFolder(home), 'CLAUDE.md'), 'Invented instructions\n');
    await say(assistantThreadId, 'Hello');
    expect(startTurns('claude-work')).toEqual([]);
    expect(rows<Turn>('turns', assistantThreadId).map((turn) => turn.state)).toEqual(['failed']);
    const shown = JSON.stringify(rows<ThreadItem>('threadItems', assistantThreadId));
    expect(shown).toContain('must be empty and holds a file (CLAUDE.md)');
  });

  it('leaves the turn of an ordinary thread and of a workflow step exactly as before', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    dispatch({
      type: 'project.create',
      projectId: 'tea',
      name: 'Tea',
      cwd: path.join(root, 'tea'),
    });
    await server.skills.refresh();
    dispatch({
      type: 'thread.create',
      threadId: 'chat-1',
      providerInstanceId: 'claude-work',
      projectId: 'tea',
      cwd: path.join(root, 'tea'),
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'acceptEdits',
    });
    await say('chat-1', 'Add a timer for green tea');
    expect(startTurns('claude-work')).toEqual([
      {
        type: 'startTurn',
        threadId: 'chat-1',
        cwd: path.join(root, 'tea'),
        prompt: 'Add a timer for green tea',
        model: 'sonnet',
        effort: 'low',
        permissionMode: 'acceptEdits',
      },
    ]);

    dispatch({
      type: 'workflow.create',
      workflowId: 'brewing',
      name: 'Brewing',
      steps: [
        {
          id: 'brew',
          skillName: 'brew',
          providerInstanceId: 'claude-work',
          gateBefore: false,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
    const ended = turnEnds('r1.brew');
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'brewing', projectId: 'tea' });
    await ended;
    expect(rows<WorkflowRun>('workflowRuns').map((run) => run.id)).toEqual(['r1']);
    const step = startTurns('claude-work').at(-1);
    expect(step).toMatchObject({ threadId: 'r1.brew', cwd: path.join(root, 'tea') });
    expect(Object.keys(step ?? {}).toSorted()).toEqual([
      'cwd',
      'effort',
      'model',
      'permissionMode',
      'prompt',
      'threadId',
      'type',
    ]);
  });
});

describe('the instruction text (spec 3)', () => {
  it('says the assistant operates wow only, never asks for a secret and sends other work to the chat view', () => {
    expect(defaultAssistantInstructions).toMatch(/You operate wow only\./);
    expect(defaultAssistantInstructions).toMatch(
      /Never ask for a token, password, key or any other secret/,
    );
    expect(defaultAssistantInstructions).toMatch(
      /say that the chat view is for that and offer to open a new thread there with their text/,
    );
    expect(server.settings.get('assistant.instructions')).toBe(defaultAssistantInstructions);
  });

  it('is a setting: the next turn carries the text stored there', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    dispatch({
      type: 'setting.set',
      key: 'assistant.instructions',
      scope: 'global',
      value: 'You operate wow only. Answer in one line.',
    });
    await say(assistantThreadId, 'Hello');
    expect(startTurns('claude-work')[0]?.instructions).toBe(
      'You operate wow only. Answer in one line.',
    );
  });
});

const noTurn = () => {
  expect(rows<Turn>('turns', assistantThreadId)).toHaveLength(1);
  expect(startTurns('claude-work')).toHaveLength(1);
};

describe('without a provider that can run it (spec 27)', () => {
  it('says that no provider is connected and makes no thread', async () => {
    const none =
      'No provider is connected, so the assistant cannot run. Connect Claude Code or Codex in Settings → Providers.';
    expect(await open()).toEqual({ thread: null, problem: none });
    testResults.set('claude-work', signedOut);
    await instance('claude-work', 'claude', 'Claude at work');
    expect(await open()).toEqual({ thread: null, problem: none });
    expect(rows<Thread>('assistantThread')).toEqual([]);
  });

  it('says so and starts no turn when the test of its instance fails', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await say(assistantThreadId, 'Hello');
    testResults.set('claude-work', signedOut);
    await server.providerService.test('claude-work');

    const problem =
      'The assistant runs on Claude at work, and its last test failed (Not signed in). Test it in Settings → Providers.';
    const opened = await open();
    expect(opened.problem).toBe(problem);
    // The conversation it had is still shown.
    expect(opened.thread).toMatchObject({ id: assistantThreadId, state: 'idle' });
    expect(
      refusal(() =>
        dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text: 'Hello?' }),
      ),
    ).toBe(problem);
    noTurn();
  });

  it('says so and starts no turn when its instance is removed', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await say(assistantThreadId, 'Hello');
    // The assistant thread does not keep the instance from being removed.
    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'claude-work' });

    const problem =
      'The provider instance the assistant ran on was removed and no other is connected. Connect Claude Code or Codex in Settings → Providers.';
    expect((await open()).problem).toBe(problem);
    expect(
      refusal(() =>
        dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text: 'Hello?' }),
      ),
    ).toBe(problem);
    noTurn();

    // With another instance connected it goes on there.
    await instance('claude-home', 'claude', 'Claude at home', path.join(root, 'claude-home'));
    expect(await open()).toMatchObject({
      problem: null,
      thread: { providerInstanceId: 'claude-home', providerSessionId: null },
    });
  });

  it('says so when the instance named in the settings was removed, even with another connected', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await instance('codex-work', 'codex', 'Codex at work');
    dispatch({
      type: 'setting.set',
      key: 'assistant.providerInstanceId',
      scope: 'global',
      value: 'claude-work',
    });
    await open();
    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'claude-work' });
    expect((await open()).problem).toMatch(
      /^The provider instance chosen for the assistant was removed\./,
    );
    expect(assistantThread()).toMatchObject({ providerInstanceId: 'claude-work' });
  });
});

describe("the chat view's thread list", () => {
  it('does not have the assistant thread, which has a topic of its own', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    dispatch({
      type: 'thread.create',
      threadId: 'chat-1',
      providerInstanceId: 'claude-work',
      cwd: path.join(root, 'tea'),
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'default',
    });
    await say(assistantThreadId, 'Hello');
    expect(rows<Thread>('threads').map((thread) => thread.id)).toEqual(['chat-1']);
    expect(rows<Thread>('assistantThread').map((thread) => thread.id)).toEqual([assistantThreadId]);
  });
});

describe('on Codex (setting assistant.allowCodex)', () => {
  it('is off by default: with only Codex connected the assistant says why and nothing reaches codex', async () => {
    await instance('codex-work', 'codex', 'Codex at work');
    expect(server.settings.get('assistant.allowCodex')).toBe(false);
    expect(await open()).toEqual({ thread: null, problem: assistantCodexOff });
    expect(rows<Thread>('assistantThread')).toEqual([]);
    // Naming the Codex instance does not get around it.
    dispatch({
      type: 'setting.set',
      key: 'assistant.providerInstanceId',
      scope: 'global',
      value: 'codex-work',
    });
    expect(await open()).toEqual({ thread: null, problem: assistantCodexOff });
    expect(assistantCodexOff).toMatch(
      /read files on this computer, including ones that hold secrets/,
    );
    expect(startTurns('codex-work')).toEqual([]);
  });

  it('rejects a message with the same sentence once the setting is turned off, and sends codex nothing', async () => {
    await instance('codex-work', 'codex', 'Codex at work');
    allowCodex(true);
    await open();
    await say(assistantThreadId, 'Hello');
    expect(startTurns('codex-work')).toHaveLength(1);

    allowCodex(false);
    const opened = await open();
    expect(opened.problem).toBe(assistantCodexOff);
    // The conversation it had is still shown.
    expect(opened.thread).toMatchObject({
      id: assistantThreadId,
      providerInstanceId: 'codex-work',
    });
    const sent = adapters.get('codex-work')?.sent.length;
    expect(
      refusal(() =>
        dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text: 'Hello?' }),
      ),
    ).toBe(assistantCodexOff);
    expect(adapters.get('codex-work')?.sent.length).toBe(sent);
    expect(rows<Turn>('turns', assistantThreadId)).toHaveLength(1);
  });

  it('takes Claude Code even when a Codex instance was connected first', async () => {
    await instance('codex-work', 'codex', 'Codex at work');
    await instance('claude-work', 'claude', 'Claude at work');
    expect(await open()).toMatchObject({
      problem: null,
      thread: { providerInstanceId: 'claude-work', permissionMode: 'dontAsk' },
    });
    await say(assistantThreadId, 'Hello');
    expect(startTurns('claude-work')).toHaveLength(1);
    expect(startTurns('codex-work')).toEqual([]);
  });

  it('moves a thread that ran on Codex to Claude Code when the setting is off', async () => {
    await instance('codex-work', 'codex', 'Codex at work');
    allowCodex(true);
    await open();
    await say(assistantThreadId, 'Hello');
    await instance('claude-work', 'claude', 'Claude at work');
    allowCodex(false);
    await say(assistantThreadId, 'Hello again');
    expect(startTurns('codex-work')).toHaveLength(1);
    expect(startTurns('claude-work')).toHaveLength(1);
    expect(startTurns('claude-work')[0]?.resumeId).toBeUndefined();
  });

  it("is changed by the assistant's own tools only as a proposal, either way", async () => {
    const outcome = async (value: boolean) =>
      (
        JSON.parse(
          (
            await server.assistant.tools.call('set_setting', {
              key: 'assistant.allowCodex',
              scope: 'global',
              value,
            })
          ).text,
        ) as { outcome: string }
      ).outcome;
    expect(await outcome(true)).toBe('proposed');
    expect(server.settings.get('assistant.allowCodex')).toBe(false);
    allowCodex(true);
    expect(await outcome(false)).toBe('proposed');
    expect(server.settings.get('assistant.allowCodex')).toBe(true);
  });
});

const use = (value: string) =>
  dispatch({ type: 'setting.set', key: 'assistant.providerInstanceId', scope: 'global', value });
const sentTo = (id: string) =>
  (adapters.get(id)?.sent ?? []).filter((command) => command.type !== 'test');

describe('moving between instances', () => {
  it("closes the old instance's session, so coming back starts fresh", async () => {
    await instance('claude-a', 'claude', 'Claude A', path.join(root, 'claude-a'));
    await instance('claude-b', 'claude', 'Claude B', path.join(root, 'claude-b'));
    use('claude-a');
    await open();
    await say(assistantThreadId, 'One');
    use('claude-b');
    await say(assistantThreadId, 'Two');
    use('claude-a');
    await say(assistantThreadId, 'Three');

    const close = { type: 'closeThread', threadId: assistantThreadId };
    expect(sentTo('claude-a').map((command) => command.type)).toEqual([
      'startTurn',
      'closeThread',
      'startTurn',
    ]);
    expect(sentTo('claude-a')[1]).toEqual(close);
    expect(sentTo('claude-b').map((command) => command.type)).toEqual(['startTurn', 'closeThread']);
    // Each instance keeps its conversation in its own folder, so none is resumed.
    expect(startTurns('claude-a').map((command) => command.resumeId)).toEqual([
      undefined,
      undefined,
    ]);
    expect(startTurns('claude-b')[0]?.resumeId).toBeUndefined();
  });
});

async function greet() {
  const ended = turnEnds(assistantThreadId);
  dispatch({ type: 'thread.greetAssistant' });
  await ended;
}

describe('the greeting after the first-start step (spec 24, 26)', () => {
  const greeting = settingsRegistry['assistant.greeting'].default;

  it('says what is set up and what a first run still needs, after the user line', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    expect(
      refusal(() =>
        server.engine.dispatch('greet-assistant', { type: 'thread.greetAssistant' }, 'assistant'),
      ),
    ).toBe('The greeting is sent by wow when the user finishes the first-start step.');
    await greet();

    const [start] = startTurns('claude-work');
    expect(start?.prompt.split('\n')).toEqual([
      '[From wow, not typed by the user] The first-start step just finished: Claude at work passed its test and runs this conversation.',
      'Set up:',
      '- Providers: Claude at work (Claude)',
      '- Projects: none',
      '- Workflows: none',
      '- Trackers: none',
      'Still needed for a first run:',
      '- A project: the folder a run works in (Settings → Projects).',
      '- A workflow: start one from a template (Workflows → New workflow).',
      '',
      greeting,
    ]);
    expect(start).toMatchObject({ cwd: assistantFolder(home), toolset: { name: 'wow' } });
    // The conversation shows only the line, as the user's.
    expect(rows<ThreadItem>('threadItems', assistantThreadId).map((item) => item.payload)).toEqual([
      { text: greeting },
      { text: 'Done.' },
    ]);
  });

  it('keeps the greeting owed from the first-start step until the assistant opens, across a restart', async () => {
    // The step goes up before any instance exists, so nothing can greet yet.
    dispatch({ type: 'thread.greetAssistant' });
    dispatch({ type: 'thread.greetAssistant' });
    await server.stop();
    server = await launch();
    await instance('claude-work', 'claude', 'Claude at work');
    expect(startTurns('claude-work')).toEqual([]);

    const ended = turnEnds(assistantThreadId);
    await open();
    await ended;
    const greetings = startTurns('claude-work');
    expect(greetings).toHaveLength(1);
    expect(greetings[0]?.prompt).toMatch(
      /^\[From wow, not typed by the user\] The first-start step/,
    );
    expect(greetings[0]?.prompt.endsWith(`\n\n${greeting}`)).toBe(true);

    // Sent once: opening again greets no more.
    await open();
    await say(assistantThreadId, 'Hello');
    expect(startTurns('claude-work').map((command) => command.prompt)).toEqual([
      greetings[0]?.prompt,
      'Hello',
    ]);
  });

  it('names a tracker by its address without the user name and password written into it', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    dispatch({
      type: 'setting.set',
      key: 'trackers.gitlab.baseUrl',
      scope: 'global',
      value: 'https://reader:hunter2pass@gitlab.example.invalid',
    });
    await open();
    await greet();
    const prompt = startTurns('claude-work')[0]?.prompt ?? '';
    expect(prompt).toContain(
      '- Trackers: GitLab URL https://gitlab.example.invalid, token not set',
    );
    expect(prompt).not.toMatch(/reader|hunter2pass/);
  });

  it('lists what a setup file left to fill in, and leaves out what was filled since', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    dispatch({
      type: 'project.create',
      projectId: 'tea',
      name: 'Tea',
      cwd: path.join(root, 'tea'),
    });
    const text = [
      'version: 1',
      'settings:',
      '  trackers.gitlab.baseUrl: https://gitlab.example.invalid',
      'toFillIn:',
      '  - trackers.gitlab.token',
      '  - trackers.jira.token',
      '',
    ].join('\n');
    dispatch({ type: 'setup.apply', applicationId: 'colleague', name: 'colleague.yaml', text });
    const reference = await server.secrets.set('setting:trackers.jira.token', 'invented-jira');
    dispatch({
      type: 'setting.set',
      key: 'trackers.jira.token',
      scope: 'global',
      value: reference,
    });
    await open();
    await greet();

    const prompt = startTurns('claude-work')[0]?.prompt ?? '';
    expect(prompt).toContain('- Projects: Tea\n');
    expect(prompt).toContain(
      '- Trackers: GitLab URL https://gitlab.example.invalid, token not set\n',
    );
    expect(prompt).toContain('Still needed for a first run:\n- A workflow');
    const fillIn = prompt.slice(prompt.indexOf('To fill in'), prompt.lastIndexOf('\n\n'));
    expect(fillIn.split('\n')).toEqual([
      'To fill in after the setup file colleague.yaml:',
      '- GitLab token (trackers.gitlab.token, Settings → Trackers): a secret; show its field.',
      '- Work hours (calendar.workHours, Settings → Calendar): only this person can say.',
      '- Project folders (Settings → Projects): a setup file holds none, they differ per machine.',
    ]);
    expect(prompt).not.toContain('invented-jira');

    // Undone, the file asks for nothing any more.
    dispatch({ type: 'setup.undo', applicationId: 'colleague' });
    await greet();
    expect(startTurns('claude-work')[1]?.prompt).not.toContain('To fill in');
  });
  it('tells the assistant at its next turn what a setup file applied from Settings left to fill in', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await open();
    await say(assistantThreadId, 'Hello');
    const text = [
      'version: 1',
      'settings:',
      '  trackers.gitlab.baseUrl: https://gitlab.example.invalid',
      'toFillIn:',
      '  - trackers.gitlab.token',
      '',
    ].join('\n');
    dispatch({ type: 'setup.apply', applicationId: 'later', name: 'later.yaml', text });
    await say(assistantThreadId, 'I loaded a file');
    await say(assistantThreadId, 'And now?');

    const [, told, after] = startTurns('claude-work').map((command) => command.prompt);
    expect(told?.split('\n')).toEqual([
      '[From wow, not typed by the user] The user applied the setup file later.yaml in Settings.',
      'To fill in after the setup file later.yaml:',
      '- GitLab token (trackers.gitlab.token, Settings → Trackers): a secret; show its field.',
      '- Work hours (calendar.workHours, Settings → Calendar): only this person can say.',
      '- Project folders (Settings → Projects): a setup file holds none, they differ per machine.',
      '',
      'I loaded a file',
    ]);
    // Told once; the conversation shows only what the user typed.
    expect(after).toBe('And now?');
    expect(
      rows<ThreadItem>('threadItems', assistantThreadId)
        .filter((item) => item.kind === 'user')
        .map((item) => item.payload),
    ).toEqual([{ text: 'Hello' }, { text: 'I loaded a file' }, { text: 'And now?' }]);
  });
});
