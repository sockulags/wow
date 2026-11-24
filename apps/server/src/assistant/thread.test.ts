import {
  assistantThreadId,
  settingsRegistry,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderTestResult,
  type ServerCommand,
  type SubscriptionTopic,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';

// The Assistant thread on the server: an ordinary main thread titled "Assistant" that wow greets
// at first start (orchestrator threads spec 25; app assistant spec 24, 26), and the instructions
// every main thread is told. The options each real adapter sends are asserted in the adapters'
// own tests; here the mock adapter shows what the server hands them.

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

let root: string;
let home: string;
let server: RunningServer;
let logLines: string[];
let adapters: Map<string, MockProviderAdapter>;
let testResults: Map<string, ProviderTestResult>;
let ids = 0;

const passed: ProviderTestResult = { ok: true, account: 'ada', version: '1.0.0', message: null };

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
const listed = (id: string) => rows<Thread>('threads').find((thread) => thread.id === id);

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

describe('the Assistant thread (orchestrator threads spec 25)', () => {
  it('is made by the first-start greeting as a main thread without a project, on the instance a new thread gets, and listed', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await greet();
    expect(listed(assistantThreadId)).toMatchObject({
      kind: 'chat',
      title: 'Assistant',
      projectId: null,
      providerInstanceId: 'claude-work',
      model: 'opus',
      listStatus: expect.any(String),
    });
    const [start] = startTurns('claude-work');
    expect(start?.helperTools).toBeDefined();
    expect(start?.appendInstructions).toBe(settingsRegistry['chat.instructions'].default);
  });

  it('does not hold its instance: removing it is allowed, and the next message goes on where a new thread starts', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await greet();
    await instance('claude-home', 'claude', 'Claude at home');
    expect(
      refusal(() =>
        dispatch({ type: 'providerInstance.delete', providerInstanceId: 'claude-work' }),
      ),
    ).toBeUndefined();
    await say(assistantThreadId, 'Still there?');
    expect(listed(assistantThreadId)).toMatchObject({
      providerInstanceId: 'claude-home',
      title: 'Assistant',
    });
    expect(startTurns('claude-home').map((command) => command.prompt)).toEqual(['Still there?']);
    // The conversation the removed instance kept is not resumed on another.
    expect(startTurns('claude-home')[0]?.resumeId).toBeUndefined();
  });

  it("is not asked for a decision's brief, which it has no tool to write", async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await greet();
    const before = startTurns('claude-work').length;
    const items = rows<ThreadItem>('threadItems', assistantThreadId).length;
    dispatch({
      type: 'assistant.requestBrief',
      decisionId: 'approval:a1',
      summary: 'Kettle wants to run pnpm test',
    });
    expect(startTurns('claude-work')).toHaveLength(before);
    expect(rows<ThreadItem>('threadItems', assistantThreadId)).toHaveLength(items);
  });

  it('keeps its id for wow alone', () => {
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.create',
          threadId: assistantThreadId,
          providerInstanceId: 'claude-work',
          cwd: path.join(root, 'tea'),
          title: 'Mine',
          model: 'opus',
          effort: 'high',
          permissionMode: 'default',
        }),
      ),
    ).toMatch(/is the assistant's/);
  });
});

describe('the instructions every main thread is told (spec 25)', () => {
  it("go after the provider's own in an ordinary thread, and a changed text from the next turn", async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    dispatch({
      type: 'thread.create',
      threadId: 'kettle',
      providerInstanceId: 'claude-work',
      cwd: path.join(root, 'tea'),
      title: 'Kettle',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    await say('kettle', 'Fix the kettle');
    dispatch({
      type: 'setting.set',
      key: 'chat.instructions',
      scope: 'global',
      value: 'Answer in one line.',
    });
    await say('kettle', 'And the bell');
    const [first, second] = startTurns('claude-work');
    expect(first?.appendInstructions).toBe(settingsRegistry['chat.instructions'].default);
    expect(first?.instructions).toBeUndefined();
    expect(second?.appendInstructions).toBe('Answer in one line.');
  });

  it("say how to use wow's app tools and never to ask for a secret", () => {
    const text = settingsRegistry['chat.instructions'].default;
    expect(text).toMatch(/wow's tools/);
    expect(text).toMatch(/Never ask for a token, password, key or any other secret/);
    expect(text).toMatch(/show_secret_field/);
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
      'Greet the person: say what is set up and what a first run still needs, from these lists.',
      '',
      greeting,
    ]);
    // An ordinary main thread's turn: its own folder in wow's home, no tools-only toolset.
    expect(start?.cwd).toBe(path.join(home, 'threads', assistantThreadId));
    expect(start?.toolset).toBeUndefined();
    // The conversation shows only the line, as the user's.
    expect(rows<ThreadItem>('threadItems', assistantThreadId).map((item) => item.payload)).toEqual([
      { text: greeting },
      { text: 'Done.' },
    ]);
  });

  it('keeps the greeting owed from the first-start step until an agent can run it, across a restart', async () => {
    // The step goes up before any instance exists, so nothing can greet yet.
    dispatch({ type: 'thread.greetAssistant' });
    dispatch({ type: 'thread.greetAssistant' });
    await server.stop();
    server = await launch();
    await instance('claude-work', 'claude', 'Claude at work');
    expect(startTurns('claude-work')).toEqual([]);

    // The step passes: wow asks again, and the thread is made and greeted.
    await greet();
    const greetings = startTurns('claude-work');
    expect(greetings).toHaveLength(1);
    expect(greetings[0]?.prompt).toMatch(
      /^\[From wow, not typed by the user\] The first-start step/,
    );
    expect(greetings[0]?.prompt.endsWith(`\n\n${greeting}`)).toBe(true);

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
      'Greet the person: say what is set up and what a first run still needs, from these lists.',
      'Go through the "To fill in" list in order, one thing per answer: a secret through show_secret_field, anything else by asking and then making the change. Move on when the person has answered or says to skip it.',
    ]);
    expect(prompt).not.toContain('invented-jira');

    // Undone, the file asks for nothing any more.
    dispatch({ type: 'setup.undo', applicationId: 'colleague' });
    await greet();
    expect(startTurns('claude-work')[1]?.prompt).not.toContain('To fill in');
  });
  it('tells the assistant at its next turn what a setup file applied from Settings left to fill in', async () => {
    await instance('claude-work', 'claude', 'Claude at work');
    await greet();
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

    const [, , told, after] = startTurns('claude-work').map((command) => command.prompt);
    expect(told?.split('\n')).toEqual([
      '[From wow, not typed by the user] The user applied the setup file later.yaml in Settings.',
      'To fill in after the setup file later.yaml:',
      '- GitLab token (trackers.gitlab.token, Settings → Trackers): a secret; show its field.',
      '- Work hours (calendar.workHours, Settings → Calendar): only this person can say.',
      '- Project folders (Settings → Projects): a setup file holds none, they differ per machine.',
      'Go through the "To fill in" list in order, one thing per answer: a secret through show_secret_field, anything else by asking and then making the change. Move on when the person has answered or says to skip it.',
      '',
      'I loaded a file',
    ]);
    // Told once; the conversation shows only what the user typed.
    expect(after).toBe('And now?');
    expect(
      rows<ThreadItem>('threadItems', assistantThreadId)
        .filter((item) => item.kind === 'user')
        .map((item) => item.payload),
    ).toEqual([
      { text: settingsRegistry['assistant.greeting'].default },
      { text: 'Hello' },
      { text: 'I loaded a file' },
      { text: 'And now?' },
    ]);
  });
});
