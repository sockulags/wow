import type { ProviderCommand, ProviderEvent } from '@wow/contracts';
import { MockProviderAdapter, startServer, type MockScript } from '@wow/server';
import { rm } from 'node:fs/promises';
import { e2eHome, e2ePort, e2eProjectId, e2eProviderInstanceId } from './env';

// Starts the wow server for the chat tests with a scripted mock provider. The prompt picks the
// scenario: "approve" asks for an approval, "question" asks a question, "wait" streams a little
// and then waits for stop; anything else streams an answer with reasoning, tasks and usage.
// Approval and question ids carry the thread id, because the answer only carries the id.

const separator = '|';

const words = (text: string) => text.split(/(?<= )/);

function finish(threadId: string, text: string, prefix = 'reply'): ProviderEvent[] {
  return [
    ...words(text).map((delta): ProviderEvent => ({
      type: 'textDelta',
      threadId,
      itemId: prefix,
      delta,
    })),
    {
      type: 'usage',
      threadId,
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
      costUsd: 0.0123,
    },
    { type: 'contextUsage', threadId, usedTokens: 50_000, maxTokens: 200_000 },
    { type: 'turnCompleted', threadId },
  ];
}

function startTurn(command: Extract<ProviderCommand, { type: 'startTurn' }>): ProviderEvent[] {
  const { threadId, prompt } = command;
  const session: ProviderEvent = {
    type: 'session',
    threadId,
    providerSessionId: command.resumeId ?? `mock-session-${threadId.slice(0, 8)}`,
  };
  const resumed = command.resumeId === undefined ? '' : `Resumed ${command.resumeId}. `;
  if (/approve/i.test(prompt)) {
    return [
      session,
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'tool-1',
        name: 'Bash',
        input: { command: 'pnpm test' },
      },
      {
        type: 'approvalRequested',
        threadId,
        approvalId: `${threadId}${separator}approval`,
        kind: 'command',
        summary: 'pnpm test',
        request: { command: 'pnpm test', cwd: '/work/demo' },
      },
    ];
  }
  if (/question/i.test(prompt)) {
    return [
      session,
      {
        type: 'questionAsked',
        threadId,
        questionId: `${threadId}${separator}question`,
        question: 'Which color should the button be?',
        options: [
          { label: 'Red', description: 'Warm and loud' },
          { label: 'Blue', description: 'Calm' },
        ],
        multiSelect: false,
      },
    ];
  }
  if (/wait/i.test(prompt)) {
    return [session, { type: 'textDelta', threadId, itemId: 'partial', delta: 'Working on it' }];
  }
  return [
    session,
    { type: 'reasoningDelta', threadId, itemId: 'thinking', delta: 'The user said hello.' },
    {
      type: 'taskListUpdated',
      threadId,
      tasks: [
        { id: '1', content: 'Read the message', status: 'completed' },
        { id: '2', content: 'Answer it', status: 'in_progress' },
      ],
    },
    ...finish(threadId, `${resumed}You said: ${prompt}`),
  ];
}

const threadOf = (id: string) => id.split(separator)[0] ?? id;

const chatScript: MockScript = (command) => {
  switch (command.type) {
    case 'startTurn':
      return startTurn(command);
    case 'answerApproval': {
      const threadId = threadOf(command.approvalId);
      const allowed = command.decision !== 'deny';
      return [
        { type: 'toolCallOutput', threadId, itemId: 'tool-1', output: 'All 12 tests passed\n' },
        { type: 'toolCallCompleted', threadId, itemId: 'tool-1', status: allowed ? 'ok' : 'error' },
        ...finish(threadId, allowed ? 'The command ran.' : 'The command was denied.', 'after'),
      ];
    }
    case 'answerQuestion':
      return finish(threadOf(command.questionId), `You chose ${command.answer}.`, 'after');
    case 'interrupt':
      return [{ type: 'turnInterrupted', threadId: command.threadId }];
    default:
      return [];
  }
};

await rm(e2eHome, { recursive: true, force: true });
const server = await startServer({
  home: e2eHome,
  port: e2ePort,
  env: { ...process.env, WOW_PROVIDERS: '' },
  hooks: {
    providers: {
      claude: () => new MockProviderAdapter('claude', chatScript),
      codex: () => new MockProviderAdapter('codex', chatScript),
    },
  },
});

server.engine.dispatch('seed-instance', {
  type: 'providerInstance.create',
  providerInstanceId: e2eProviderInstanceId,
  kind: 'claude',
  name: 'Mock Claude',
  binaryPath: 'claude',
  configDir: '/home/me/.claude',
  env: {},
  launchArgs: [],
  defaultPermissionMode: 'default',
});
server.engine.dispatch('seed-project', {
  type: 'project.create',
  projectId: e2eProjectId,
  name: 'Demo',
  cwd: e2eHome,
});

// No command writes skills yet (skills discovery lands separately), so the fixtures go straight
// into the projection the skills topic reads.
const insertSkill = server.database.sqlite.prepare(
  'INSERT INTO skills (id, name, description, dir, source, manual_only, invocations) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
for (const [name, description] of [
  ['deliver-work', 'Deliver one unit of planned work end to end.'],
  ['capture-intent', 'Turn a rough idea into an intent and a spec.'],
  ['check-work', 'Review delivered work against its contract.'],
] as const) {
  insertSkill.run(
    `user-claude:${name}`,
    name,
    description,
    `/home/me/.claude/skills/${name}`,
    'user-claude',
    0,
    JSON.stringify({ claude: `/${name}`, codex: `$${name}` }),
  );
}

const stop = () => void server.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
