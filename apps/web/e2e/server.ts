import type { CalendarItem, ProviderCommand, ProviderEvent } from '@wow/contracts';
import { MockOutlookSource, loadFixtures } from '@wow/outlook-bridge';
import {
  MockProviderAdapter,
  snapshot,
  startOutlookService,
  startServer,
  type MockScript,
} from '@wow/server';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import {
  e2eBinDir,
  e2eBinary,
  e2eClaudeConfigDir,
  e2eCodexHome,
  e2eCodexInstanceId,
  e2eHome,
  e2eOutlookControlPort,
  e2ePort,
  e2eProjectId,
  e2eProviderInstanceId,
  e2eTrackerPort,
  e2eWorkflowId,
} from './env';

// WOW_E2E_HOME and WOW_E2E_PORT start a second copy for the settings tests (playwright.config.ts).
const home = process.env['WOW_E2E_HOME'] ?? e2eHome;
const port = Number(process.env['WOW_E2E_PORT'] ?? e2ePort);
const outlookControlPort = Number(
  process.env['WOW_E2E_OUTLOOK_CONTROL_PORT'] ?? e2eOutlookControlPort,
);
const trackerPort = Number(process.env['WOW_E2E_TRACKER_PORT'] ?? e2eTrackerPort);
// The trigger tests restart the server on the same home (WOW_E2E_KEEP_HOME) with its clock moved
// ahead (WOW_E2E_CLOCK_OFFSET_SECONDS), so a trigger's time passes while it is down without
// the test waiting for it.
const keepHome = process.env['WOW_E2E_KEEP_HOME'] === '1';
const clockOffsetMs = Number(process.env['WOW_E2E_CLOCK_OFFSET_SECONDS'] ?? '0') * 1000;

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
  if (/break the build/i.test(prompt)) {
    return [session, { type: 'turnFailed', threadId, error: 'The build broke' }];
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

// The invented Outlook fixtures, placed relative to today. The calendar tests make it fail and
// come back through the control port below.
const outlook = new MockOutlookSource({ fixtures: await loadFixtures() });

if (!keepHome) await rm(home, { recursive: true, force: true });
// Provider detection looks at the server's PATH; the mock adapters never run these files.
await mkdir(e2eBinDir(home), { recursive: true });
for (const name of ['claude', 'codex']) {
  await writeFile(e2eBinary(home, name), '', { mode: 0o755 });
}
// Skills discovery reads "~/.claude/skills"; "~" is a folder inside the server's home, so the tests
// never see the real user's skills.
const userHome = path.join(home, 'user-home');
for (const [name, description] of [
  ['deliver-work', 'Deliver one unit of planned work end to end.'],
  ['capture-intent', 'Turn a rough idea into an intent and a spec.'],
  ['plan-work', 'Split a spec into ordered units of work.'],
  ['check-work', 'Review delivered work against its contract.'],
] as const) {
  const dir = path.join(userHome, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInvented fixture skill.\n`,
  );
}
// The seeded project's folder is the server home; an intent there is what the Feature template's
// first step expects, so the workflow tests see a found artifact.
await mkdir(path.join(home, 'intents', 'demo'), { recursive: true });
await writeFile(path.join(home, 'intents', 'demo', 'intent.md'), '# Demo intent\n');
const server = await startServer({
  home,
  port,
  userHome,
  ...(clockOffsetMs === 0 ? {} : { clock: () => new Date(Date.now() + clockOffsetMs) }),
  env: {
    ...process.env,
    WOW_PROVIDERS: '',
    PATH: e2eBinDir(home),
    CLAUDE_CONFIG_DIR: e2eClaudeConfigDir(home),
    CODEX_HOME: e2eCodexHome(home),
  },
  hooks: {
    providers: {
      claude: () => new MockProviderAdapter('claude', chatScript),
      codex: () => new MockProviderAdapter('codex', chatScript),
    },
    outlook: (mode, context) => {
      if (mode !== 'mock') throw new Error('The e2e server runs with WOW_OUTLOOK=mock');
      return startOutlookService(mode, context, { source: outlook });
    },
  },
});

const control = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/unavailable' && request.method === 'PUT') {
    outlook.setUnavailable(url.searchParams.get('message') ?? 'Outlook is not running');
  } else if (url.pathname === '/unavailable' && request.method === 'DELETE') {
    outlook.setUnavailable(null);
  } else if (url.pathname === '/opened' && request.method === 'GET') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(outlook.opened));
    return;
  } else {
    response.statusCode = 404;
  }
  response.end();
});
await new Promise<void>((resolve) => control.listen(outlookControlPort, '127.0.0.1', resolve));

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
// Only the chat server gets a Codex instance; the settings tests count and add instances themselves.
if (home === e2eHome) {
  server.engine.dispatch('seed-codex-instance', {
    type: 'providerInstance.create',
    providerInstanceId: e2eCodexInstanceId,
    kind: 'codex',
    name: 'Mock Codex',
    binaryPath: 'codex',
    configDir: '/home/me/.codex',
    env: {},
    launchArgs: [],
  });
}
server.engine.dispatch('seed-project', {
  type: 'project.create',
  projectId: e2eProjectId,
  name: 'Demo',
  cwd: home,
});

// Settings for the mock trackers below: Jira fully set up, GitHub without its token, which the
// backlog tests enter on the settings page.
const trackerUrl = `http://127.0.0.1:${trackerPort}`;
const seedSettings: Record<string, unknown> = {
  'trackers.jira.baseUrl': `${trackerUrl}/jira`,
  'trackers.jira.email': 'me@example.invalid',
  'trackers.jira.projectKey': 'DEMO',
  'trackers.jira.token': await server.secrets.set('setting:trackers.jira.token', 'jira-e2e-token'),
  'trackers.github.baseUrl': `${trackerUrl}/github`,
  'trackers.github.owner': 'acme',
  'trackers.github.repo': 'demo',
};
for (const [key, value] of Object.entries(seedSettings)) {
  server.engine.dispatch(`seed-${key}`, { type: 'setting.set', key, scope: 'global', value });
}
// A one-step workflow for "Plan on calendar"; the mock provider finishes its turn.
server.engine.dispatch('seed-workflow', {
  type: 'workflow.create',
  workflowId: e2eWorkflowId,
  name: 'Backlog e2e',
  steps: [
    {
      id: 'deliver',
      skillName: 'deliver-work',
      providerInstanceId: e2eProviderInstanceId,
      model: 'mock-model',
      effort: 'default',
      permissionMode: 'default',
      gateBefore: false,
      gateAfter: false,
      expectedArtifacts: [],
    },
  ],
});

const received: { path: string; authorization: string | undefined; body: unknown }[] = [];
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
};

// What the scheduler does when a card's time comes (U11), for the backlog item's card.
function fire(backlogItemId: string): string | undefined {
  const cards = snapshot(server.database.db, { topic: 'calendarItems' }) as CalendarItem[];
  const card = cards.find((candidate) => candidate.backlogItemId === backlogItemId);
  if (!card?.workflowId || !card.projectId) return undefined;
  const runId = `run-${card.id}`;
  server.engine.dispatch(`fire-${card.id}`, {
    type: 'workflowRun.start',
    runId,
    workflowId: card.workflowId,
    projectId: card.projectId,
    calendarItemId: card.id,
    ...(card.backlogItemId ? { backlogItemId: card.backlogItemId } : {}),
  });
  return runId;
}

const trackers = createServer((request, response) => {
  const url = new URL(request.url ?? '/', trackerUrl);
  const json = (status: number, body: unknown) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && url.pathname === '/requests') return json(200, received);
  if (request.method === 'POST' && url.pathname === '/fire') {
    const runId = fire(url.searchParams.get('backlogItemId') ?? '');
    return runId ? json(200, { runId }) : json(404, { error: 'No such card' });
  }
  if (request.method !== 'POST') return json(404, {});
  void readBody(request).then((body) => {
    received.push({ path: url.pathname, authorization: request.headers.authorization, body });
    const number = received.length;
    if (url.pathname === '/jira/rest/api/2/issue') {
      return json(201, { id: String(10_000 + number), key: `DEMO-${number}`, self: url.href });
    }
    const github = /^\/github\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    if (github) {
      return json(201, {
        number,
        html_url: `${trackerUrl}/${github[1]}/${github[2]}/issues/${number}`,
      });
    }
    return json(404, { message: 'Not Found' });
  });
  return undefined;
});
await new Promise<void>((resolve) => trackers.listen(trackerPort, '127.0.0.1', resolve));
// Seeding again after a restart repeats the same command ids, which the server answers as
// duplicates. The trigger tests wait for this line.
process.stdout.write('wow e2e server ready\n');

const stop = () => {
  control.close();
  trackers.close();
  void server.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
