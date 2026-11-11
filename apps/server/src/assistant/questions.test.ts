import {
  assistantThreadId,
  defaultAssistantInstructions,
  type ProviderCommand,
  type ProviderEvent,
  type Question,
  type ServerCommand,
  type SubscriptionTopic,
  type ThreadItem,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';

// The question card on the server (questions-and-models plan U1): an agent's questions in a chat
// thread answered together with picks and text, a question whose turn ended, and the assistant's
// own question tool whose answer is the user's next message. All data is invented.

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

let root: string;
let server: RunningServer;
let adapter: MockProviderAdapter;
let ids = 0;
// What the mock agent answers the next startTurn with.
let script: (command: StartTurn) => ProviderEvent[];

const quiet = ({ threadId }: StartTurn): ProviderEvent[] => [
  { type: 'textDelta', threadId, itemId: `${threadId}-answer`, delta: 'Done.' },
  { type: 'turnCompleted', threadId },
];

const dispatch = (command: ServerCommand) => server.engine.dispatch(`q${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, { topic, ...(threadId ? { threadId } : {}) }) as T[];

function refusal(send: () => unknown): string | undefined {
  try {
    send();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return undefined;
}

// Resolves when a commit holds an event of this kind for the thread: no sleeping or polling.
function committed(kind: string, threadId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = server.engine.onCommit((commit) => {
      const found = commit.events.some(
        ({ event }) =>
          event.kind === kind &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          ('threadId' in event.payload
            ? event.payload.threadId === threadId
            : event.aggregate === threadId),
      );
      if (!found) return;
      off();
      resolve();
    });
  });
}

const sent = () => adapter.sent;
const startTurns = () =>
  adapter.sent.filter((command): command is StartTurn => command.type === 'startTurn');

async function call(name: string, args: Record<string, unknown>) {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Record<string, unknown> };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-questions-'));
  script = quiet;
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      providers: {
        claude: () => {
          adapter = new MockProviderAdapter('claude', (command) => {
            if (command.type === 'startTurn') return script(command);
            if (command.type === 'interrupt') {
              return [{ type: 'turnInterrupted', threadId: command.threadId }];
            }
            return [];
          });
          return adapter;
        },
      },
    },
  });
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
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

// An invented ask with two questions, the first with a recommended choice.
const twoQuestions = (threadId: string): ProviderEvent[] => [
  {
    type: 'questionAsked',
    threadId,
    questionId: 'ask-1:0',
    askId: 'ask-1',
    header: 'Kettle',
    question: 'Which kettle should the tea timer start?',
    options: [
      { label: 'Glass kettle' },
      { label: 'Steel kettle (Recommended)', description: 'Boils faster', recommended: true },
      { label: 'Travel kettle' },
    ],
    multiSelect: false,
  },
  {
    type: 'questionAsked',
    threadId,
    questionId: 'ask-1:1',
    askId: 'ask-1',
    header: 'Teas',
    question: 'Which teas go on the list?',
    options: [{ label: 'Green' }, { label: 'Black' }, { label: 'Oolong' }],
    multiSelect: true,
  },
];

async function chatThread(threadId: string, events: (threadId: string) => ProviderEvent[]) {
  script = ({ threadId: id }) => [
    { type: 'session', threadId: id, providerSessionId: 's' },
    ...events(id),
  ];
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: 'claude-work',
    cwd: root,
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });
  const asked = committed('question.asked', threadId);
  dispatch({ type: 'thread.sendMessage', threadId, text: 'Set up the tea timer' });
  await asked;
}

// Answers the kettle question of the ask in thread 'tea' and says what was refused, if anything.
const answerFirst = (picked: string[], text = '') =>
  refusal(() =>
    dispatch({
      type: 'question.answer',
      answers: [{ questionId: 'tea:ask-1:0', reply: { picked, text } }],
    }),
  );

describe('an agent question in a chat thread (spec 1 to 8)', () => {
  it('keeps the header, the asker and the recommended mark on the item, and answers both questions of an ask together', async () => {
    await chatThread('tea', twoQuestions);
    const items = rows<ThreadItem>('threadItems', 'tea').filter((item) => item.kind === 'question');
    expect(items.map((item) => item.payload)).toEqual([
      expect.objectContaining({ header: 'Kettle', askId: 'ask-1', multiSelect: false }),
      expect.objectContaining({ header: 'Teas', askId: 'ask-1', multiSelect: true }),
    ]);
    expect(rows<{ state: string }>('threads')[0]?.state).toBe('needs_you');

    const resolved = committed('question.answered', 'tea');
    dispatch({
      type: 'question.answer',
      answers: [
        {
          questionId: 'tea:ask-1:0',
          reply: { picked: ['Steel kettle (Recommended)'], text: 'the red one' },
        },
        { questionId: 'tea:ask-1:1', reply: { picked: ['Green', 'Oolong'], text: '' } },
      ],
    });
    await resolved;
    expect(sent().filter((command) => command.type === 'answerQuestion')).toEqual([
      {
        type: 'answerQuestion',
        questionId: 'ask-1:0',
        answer: { picked: ['Steel kettle (Recommended)'], text: 'the red one' },
      },
      {
        type: 'answerQuestion',
        questionId: 'ask-1:1',
        answer: { picked: ['Green', 'Oolong'], text: '' },
      },
    ]);
    // Both answered in one command, so the thread works again at once.
    expect(rows<{ state: string }>('threads')[0]?.state).toBe('working');
    expect(rows<Question>('questions', 'tea').map((row) => row.answer)).toEqual([
      'Steel kettle (Recommended), the red one',
      'Green, Oolong',
    ]);
    const answered = rows<ThreadItem>('threadItems', 'tea').filter(
      (item) => item.kind === 'question',
    );
    expect(answered.map((item) => (item.payload as { reply?: unknown }).reply)).toEqual([
      { picked: ['Steel kettle (Recommended)'], text: 'the red one' },
      { picked: ['Green', 'Oolong'], text: '' },
    ]);
    expect(
      refusal(() =>
        dispatch({
          type: 'question.answer',
          answers: [{ questionId: 'tea:ask-1:0', reply: { picked: [], text: 'again' } }],
        }),
      ),
    ).toMatch(/already answered/);
  });

  it('refuses an empty answer, a choice that is not offered and two picks where one is asked', async () => {
    await chatThread('tea', twoQuestions);
    expect(answerFirst([], '   ')).toBe('Pick a choice or type an answer.');
    expect(answerFirst(['Copper kettle'])).toBe('"Copper kettle" is not one of the choices.');
    expect(answerFirst(['Glass kettle', 'Travel kettle'])).toBe('Only one choice can be picked.');
    expect(sent().some((command) => command.type === 'answerQuestion')).toBe(false);
    // Typed text alone answers a question with choices.
    expect(answerFirst([], 'whichever is clean')).toBeUndefined();
    expect(sent().at(-1)).toEqual({
      type: 'answerQuestion',
      questionId: 'ask-1:0',
      answer: { picked: [], text: 'whichever is clean' },
    });
  });

  it('refuses an answer once the turn that asked was stopped, and the row stays unanswered', async () => {
    await chatThread('tea', twoQuestions);
    const stopped = committed('turn.ended', 'tea');
    dispatch({ type: 'thread.interrupt', threadId: 'tea' });
    await stopped;
    expect(
      refusal(() =>
        dispatch({
          type: 'question.answer',
          answers: [{ questionId: 'tea:ask-1:0', reply: { picked: ['Glass kettle'], text: '' } }],
        }),
      ),
    ).toBe(
      '"Which kettle should the tea timer start?" was not answered before its turn ended, so it can no longer be answered.',
    );
    // Not in the next turn either.
    script = quiet;
    const ended = committed('turn.ended', 'tea');
    dispatch({ type: 'thread.sendMessage', threadId: 'tea', text: 'Never mind' });
    await ended;
    expect(
      refusal(() =>
        dispatch({
          type: 'question.answer',
          answers: [{ questionId: 'tea:ask-1:1', reply: { picked: ['Green'], text: '' } }],
        }),
      ),
    ).toMatch(/can no longer be answered/);
    expect(rows<Question>('questions', 'tea').map((row) => row.answer)).toEqual([null, null]);
  });
});

// The assistant's question tool, called the way the mock agent calls it: the tool's answer is
// what the provider reports as the tool call's output.
async function assistantAsks(input: Record<string, unknown>) {
  const result = await call('ask_questions', input);
  script = ({ threadId }) => [
    { type: 'session', threadId, providerSessionId: 'assistant-session' },
    { type: 'toolCallStarted', threadId, itemId: 'ask', name: 'mcp__wow__ask_questions', input },
    { type: 'toolCallOutput', threadId, itemId: 'ask', output: result.text },
    { type: 'toolCallCompleted', threadId, itemId: 'ask', status: 'ok' },
    { type: 'turnCompleted', threadId },
  ];
  dispatch({ type: 'thread.openAssistant' });
  const ended = committed('turn.ended', assistantThreadId);
  dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text: 'Set up my mornings' });
  await ended;
  script = quiet;
  const item = rows<ThreadItem>('threadItems', assistantThreadId).find(
    (entry) => entry.kind === 'tool_call',
  );
  if (!item) throw new Error('no tool call');
  return { result, item };
}

const morning = {
  questions: [
    {
      question: 'When should the morning brief run?',
      header: 'Brief',
      options: [
        { label: '08:30', description: 'Before stand-up', recommended: true },
        { label: '09:00' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which projects should it read?',
      header: 'Projects',
      options: [{ label: 'Tea timer' }, { label: 'Kettle' }],
      multiSelect: true,
    },
  ],
};

describe("the assistant's question tool (spec 9 to 12)", () => {
  it('asks one to four questions, ends there, and the answer is the next message marked as the answer', async () => {
    const { result, item } = await assistantAsks(morning);
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ outcome: 'asked', questions: 2 });
    expect(String(result.content['note'])).toMatch(/End your turn now/);
    expect(rows<{ state: string }>('turns', assistantThreadId).map((turn) => turn.state)).toEqual([
      'completed',
    ]);

    const ended = committed('turn.ended', assistantThreadId);
    dispatch({
      type: 'thread.answerQuestions',
      threadId: assistantThreadId,
      itemId: item.id,
      replies: [
        { picked: ['08:30'], text: '' },
        { picked: ['Tea timer'], text: 'and the garden plan' },
      ],
    });
    await ended;
    const prompt = startTurns().at(-1)?.prompt ?? '';
    expect(prompt).toContain(
      '[From wow] The user answered your questions (ask_questions) on the card:',
    );
    expect(prompt).toContain('- When should the morning brief run? (Brief): picked 08:30');
    expect(prompt).toContain(
      '- Which projects should it read? (Projects): picked Tea timer; typed "and the garden plan"',
    );
    const user = rows<ThreadItem>('threadItems', assistantThreadId).filter(
      (entry) => entry.kind === 'user',
    );
    expect(user.at(-1)?.payload).toEqual({
      text: 'Brief: 08:30\nProjects: Tea timer, and the garden plan',
      answers: {
        askItemId: item.id,
        replies: [
          { picked: ['08:30'], text: '' },
          { picked: ['Tea timer'], text: 'and the garden plan' },
        ],
      },
    });
    // Answered once: the next message closed it.
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.answerQuestions',
          threadId: assistantThreadId,
          itemId: item.id,
          replies: [
            { picked: ['09:00'], text: '' },
            { picked: [], text: 'none' },
          ],
        }),
      ),
    ).toMatch(/can no longer be answered/);
  });

  it('refuses an answer after the user wrote a message instead, and one that leaves a question out', async () => {
    const { item } = await assistantAsks(morning);
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.answerQuestions',
          threadId: assistantThreadId,
          itemId: item.id,
          replies: [{ picked: ['08:30'], text: '' }],
        }),
      ),
    ).toBe('Answer every question: 2 asked, 1 answered.');
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.answerQuestions',
          threadId: assistantThreadId,
          itemId: item.id,
          replies: [
            { picked: ['08:30', '09:00'], text: '' },
            { picked: [], text: 'x' },
          ],
        }),
      ),
    ).toBe('"When should the morning brief run?": Only one choice can be picked.');
    const ended = committed('turn.ended', assistantThreadId);
    dispatch({ type: 'thread.sendMessage', threadId: assistantThreadId, text: 'Actually, later' });
    await ended;
    expect(
      refusal(() =>
        dispatch({
          type: 'thread.answerQuestions',
          threadId: assistantThreadId,
          itemId: item.id,
          replies: [
            { picked: ['08:30'], text: '' },
            { picked: ['Kettle'], text: '' },
          ],
        }),
      ),
    ).toBe(
      'These questions were not answered before the next message, so they can no longer be answered.',
    );
  });

  it('takes a question with no choices, and refuses five questions and a choice "Other"', async () => {
    const free = await call('ask_questions', {
      questions: [{ question: 'What should the brief be called?', header: 'Name', options: [] }],
    });
    expect(free.content).toMatchObject({ outcome: 'asked', questions: 1 });
    const five = await call('ask_questions', {
      questions: Array.from({ length: 5 }, (_, index) => ({
        question: `Question ${index}?`,
        header: 'Q',
        options: [],
      })),
    });
    expect(five).toMatchObject({ isError: true, content: { outcome: 'invalid input' } });
    const other = await call('ask_questions', {
      questions: [
        {
          question: 'Which day?',
          header: 'Day',
          options: [{ label: 'Monday' }, { label: 'Other' }],
        },
      ],
    });
    expect(other).toMatchObject({ isError: true, content: { outcome: 'refused' } });
  });

  it('refuses a question that asks for a token or a password, pointing to the secret field', async () => {
    const token = await call('ask_questions', {
      questions: [
        {
          question: 'Paste your GitLab token here?',
          header: 'GitLab',
          options: [],
        },
      ],
    });
    expect(token.isError).toBe(true);
    expect(token.content).toEqual({
      outcome: 'refused',
      reason:
        'A question never asks for a secret, and this one says "token". To get a token, password or key, show its field with show_secret_field (or show_secret_variable for a provider instance\'s variable) instead.',
    });
    const password = await call('ask_questions', {
      questions: [
        {
          question: 'How should Jira sign in?',
          header: 'Jira',
          options: [{ label: 'Basic', description: 'User name and password' }, { label: 'Cloud' }],
        },
      ],
    });
    expect(password.content).toMatchObject({ outcome: 'refused' });
    expect(String(password.content['reason'])).toContain('"password"');
    // Whole words only: a keyboard question is fine.
    const keyboard = await call('ask_questions', {
      questions: [{ question: 'Which keyboard layout?', header: 'Keyboard', options: [] }],
    });
    expect(keyboard.content).toMatchObject({ outcome: 'asked' });
    // The words are a setting the owner can change.
    dispatch({
      type: 'setting.set',
      key: 'assistant.askRefusedWords',
      scope: 'global',
      value: ['keyboard'],
    });
    const changed = await call('ask_questions', {
      questions: [{ question: 'Which keyboard layout?', header: 'Keyboard', options: [] }],
    });
    expect(changed.content).toMatchObject({ outcome: 'refused' });
  });

  it('is named in the default instruction text with when to use it', () => {
    expect(defaultAssistantInstructions).toContain('ask with ask_questions');
    expect(defaultAssistantInstructions).toContain(
      'Ask one thing at a time unless the questions belong together',
    );
  });
});
