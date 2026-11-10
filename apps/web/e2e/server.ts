import type {
  CalendarItem,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ProviderTestResult,
} from '@wow/contracts';
import { MockOutlookSource, loadFixtures } from '@wow/outlook-bridge';
import {
  MockProviderAdapter,
  createNpmRunner,
  snapshot,
  startOutlookService,
  startServer,
  type MockScript,
} from '@wow/server';
import { existsSync } from 'node:fs';
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
  e2ePanelCardId,
  e2ePanelHome,
  e2ePanelWorkflowId,
  e2ePort,
  e2eProjectId,
  e2eProjectsHome,
  e2eProviderInstanceId,
  e2eTrackerPort,
  e2eWorkflowId,
  e2eWorkspace,
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
// and then waits for stop; "table and a diagram" answers in markdown; "reaches out" answers with
// diagrams that name another host; anything else streams an answer with reasoning, tasks and
// usage.
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

// An invented answer with every kind of markdown the chat renders (review loop spec 1, 2).
const markdownAnswer = [
  '## Review of the login change',
  '',
  'The change touches `login.ts` and is **ready**:',
  '',
  '- Checks',
  '  - unit tests pass',
  '  - lint is clean',
  '- One open question',
  '',
  '| File | Added | Removed |',
  '| --- | ---: | ---: |',
  '| src/login.ts | 12 | 3 |',
  '| src/login.test.ts | 40 | 0 |',
  '',
  'Read more in [the guide](https://docs.example.test/login) or [here](javascript:alert(1)).',
  '',
  '```ts',
  'export const retries = 3;',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Plan --> Build',
  '  Build --> Review',
  '  Review -->|send back| Build',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Plan -->',
  '```',
].join('\n');

// Invented diagrams that try to make the app fetch from another host: a picture in a label, a
// link, an image shape, a state diagram's class with a background, and CSS from a directive.
const reachingAnswer = [
  '```mermaid',
  'flowchart LR',
  '  Plan["Plan <img src=https://elsewhere.example.test/label.png>"] --> Build',
  '  click Build href "https://elsewhere.example.test/build"',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Logo@{ img: "https://elsewhere.example.test/shape.png", label: "Logo" } --> Build',
  '```',
  '',
  '```mermaid',
  'stateDiagram-v2',
  '  classDef reaching background-image:url(https://elsewhere.example.test/state.png)',
  '  [*] --> Waiting',
  '  class Waiting reaching',
  '```',
  '',
  '```mermaid',
  '%%{init: {"themeCSS": ".node rect{fill:url(https://elsewhere.example.test/css.png)}"}}%%',
  'flowchart LR',
  '  Plan --> Build',
  '```',
].join('\n');

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
  if (/table and a diagram/i.test(prompt)) {
    return [session, ...finish(threadId, markdownAnswer)];
  }
  if (/reaches out/i.test(prompt)) {
    return [session, ...finish(threadId, reachingAnswer)];
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

// "Update Codex" (settings tests): a Codex instance named "... differs" tests as a compatible
// other version, one named "... incompatible" as incompatible with an npm update until the fake
// npm below has "installed" the tested version (a marker file in the server home).
const codexInstalled = () => path.join(home, 'codex-installed');
const fakeNpm = path.join(home, 'fake-npm.cjs');
function codexTest(instance: ProviderInstance): () => ProviderTestResult {
  return () => {
    if (/differs/i.test(instance.name))
      return {
        ok: true,
        account: 'mock',
        version: '0.164.0',
        message: 'codex 0.164.0 differs from the tested 0.166.0; compatible.',
        update: null,
      };
    if (/incompatible/i.test(instance.name) && !existsSync(codexInstalled()))
      return {
        ok: false,
        account: null,
        version: '0.100.0',
        message:
          'codex 0.100.0 is not compatible with wow, which is tested with codex 0.166.0: model/list result.data[].hidden is missing. Update codex to 0.166.0.',
        update: {
          method: 'npm',
          targetVersion: '0.166.0',
          reason: 'incompatible',
          packageSpec: '@openai/codex@0.166.0',
          prefix: null,
        },
      };
    return { ok: true, account: 'mock', version: 'mock', message: null };
  };
}

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
await writeFile(
  fakeNpm,
  [
    "const fs = require('node:fs');",
    "process.stdout.write('added 1 package in 1s (invented)\\n');",
    `fs.writeFileSync(${JSON.stringify(codexInstalled())}, process.argv.slice(2).join(' '));`,
  ].join('\n'),
);
await mkdir(path.join(home, 'intents', 'demo'), { recursive: true });
await writeFile(path.join(home, 'intents', 'demo', 'intent.md'), '# Demo intent\n');
const server = await startServer({
  home,
  port,
  userHome,
  ...(clockOffsetMs === 0 ? {} : { clock: () => new Date(Date.now() + clockOffsetMs) }),
  runNpm: createNpmRunner({ file: process.execPath, prefixArgs: [fakeNpm] }),
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
      codex: (instance) => new MockProviderAdapter('codex', chatScript, codexTest(instance)),
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
// The projects server: invented Claude and Codex session files in the config directories detection
// reports, read by two instances that use those defaults. `alpha` appears in both, `beta` only in
// Codex, and `gone` no longer exists, so the import offers alpha and beta.
if (home === e2eProjectsHome) {
  for (const name of ['alpha', 'beta']) await mkdir(e2eWorkspace(home, name), { recursive: true });
  const claudeProjects = path.join(e2eClaudeConfigDir(home), 'projects');
  for (const name of ['alpha', 'gone']) {
    const cwd = e2eWorkspace(home, name);
    const dir = path.join(claudeProjects, cwd.replaceAll(/[^A-Za-z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'session-1.jsonl'),
      `${JSON.stringify({ type: 'user', cwd, sessionId: `invented-${name}` })}\n`,
    );
  }
  const codexDay = path.join(e2eCodexHome(home), 'sessions', '2026', '11', '01');
  await mkdir(codexDay, { recursive: true });
  for (const name of ['alpha', 'beta']) {
    await writeFile(
      path.join(codexDay, `rollout-invented-${name}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: name, cwd: e2eWorkspace(home, name) } })}\n`,
    );
  }
  for (const kind of ['claude', 'codex'] as const) {
    server.engine.dispatch(`seed-discovery-${kind}`, {
      type: 'providerInstance.create',
      providerInstanceId: `discovery-${kind}`,
      kind,
      name: `Discovery ${kind === 'claude' ? 'Claude' : 'Codex'}`,
      binaryPath: kind,
      configDir: '',
      env: {},
      launchArgs: [],
    });
  }
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

// The panel server: a one-step workflow that waits for the user after its step, and a card
// tomorrow at 10:00 (this machine's zone) that runs it, started through POST /fire?cardId=….
if (home === e2ePanelHome) {
  server.engine.dispatch('seed-panel-workflow', {
    type: 'workflow.create',
    workflowId: e2ePanelWorkflowId,
    name: 'Panel e2e',
    steps: [
      {
        id: 'review',
        skillName: 'check-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  server.engine.dispatch('seed-panel-card', {
    type: 'card.create',
    cardId: e2ePanelCardId,
    title: 'Review the search panel',
    start: start.toISOString(),
    end: new Date(start.getTime() + 60 * 60_000).toISOString(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    body: 'Invented notes for the panel tests.',
    projectId: e2eProjectId,
    workflowId: e2ePanelWorkflowId,
  });
}

const received: { path: string; authorization: string | undefined; body: unknown }[] = [];
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
};

// What the scheduler does when a card's time comes (U11), for the backlog item's card or a card
// named by its id.
function fire(match: (card: CalendarItem) => boolean): string | undefined {
  const cards = snapshot(server.database.db, { topic: 'calendarItems' }) as CalendarItem[];
  const card = cards.find(match);
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
    const backlogItemId = url.searchParams.get('backlogItemId');
    const cardId = url.searchParams.get('cardId');
    const runId = fire((card) =>
      cardId === null ? card.backlogItemId === backlogItemId : card.id === cardId,
    );
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
