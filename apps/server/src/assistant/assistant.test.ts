import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Command,
  InternalCommand,
  hiddenText,
  type AssistantChange,
  type AssistantProposal,
  type BacklogItem,
  type CalendarItem,
  type ServerCommand,
  type SettingRow,
  type SubscriptionTopic,
  type Trigger,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { commandReceipts, events, hostReads } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';
import { commandClasses } from './classes.js';
import { changeTools } from './tools.js';
import { readers } from './readers.js';
import { asks } from './asks.js';
import { diagnosisReaders } from './diagnosis.js';
import { guideReaders } from './guides.js';
import { modelReaders } from './models.js';

// The assistant's tools on the server (app assistant plan U1): every acceptance line of the
// unit has a case here that names it.

// Invented values. None of them may ever leave the server.
const storedSecret = 'wow-marked-secret-5d1c9e77';
const threadMarker = 'wow-marked-thread-message-41aa';
const fileMarker = 'wow-marked-file-content-93bc';
const lookalike = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

let root: string;
let server: RunningServer;
let logLines: string[];
let hostRequests: { url: string; authorization: string | null }[];
let ids = 0;

const now = '2026-11-10T08:00:00.000Z';

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const asAssistant = (command: ServerCommand) =>
  server.engine.dispatch(`a${++ids}`, command, 'assistant');

function refusal(send: () => unknown): string | undefined {
  try {
    send();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return undefined;
}

const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
// A time this many minutes after the tests' now.
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const changes = () => rows<AssistantChange>('assistantChanges');
const proposals = () => rows<AssistantProposal>('assistantProposals');
const setting = (key: string, scope = 'global') =>
  rows<SettingRow>('settings').find((row) => row.key === key && row.scope === scope)?.value;
const workflow = (id: string) => rows<Workflow>('workflows').find((row) => row.id === id);
const card = (id: string) => rows<CalendarItem>('calendarItems').find((row) => row.id === id);
const item = (id: string) => rows<BacklogItem>('backlogItems').find((row) => row.id === id);

interface Called {
  readonly isError: boolean;
  readonly text: string;
  readonly content: Record<string, unknown> & {
    outcome?: string;
    reason?: string;
    change?: Pick<AssistantChange, 'id' | 'what' | 'from' | 'to' | 'place'>;
    proposal?: Pick<AssistantProposal, 'id' | 'title' | 'lines' | 'place'>;
  };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Called['content'] };
}

async function list<T = Record<string, unknown>>(name: string, args = {}): Promise<T[]> {
  const result = await server.assistant.tools.call(name, args);
  expect(result.isError).toBe(false);
  return JSON.parse(result.text) as T[];
}

const step = (id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id === 's1' ? 'deliver-work' : 'check-work',
  providerInstanceId: 'claude-work',
  // What the mock provider offers: the assistant's tools refuse any other (questions and
  // models spec 16).
  model: 'mock-model',
  effort: 'high',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
  ...extra,
});

const git = (...args: string[]) =>
  execFileSync('git', ['-C', path.join(root, 'tea'), ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
  });

// Stands in for every host: answers "who am I" and records what it was sent.
const hostFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  hostRequests.push({ url: request.url, authorization: request.headers.get('authorization') });
  return Promise.resolve(Response.json({ login: 'ada', name: 'Ada', username: 'ada' }));
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-'));
  logLines = [];
  hostRequests = [];
  await mkdir(path.join(root, 'tea'));
  await writeFile(path.join(root, 'tea', 'notes.md'), `# Notes\n\n${fileMarker}\n`);
  git('init', '--quiet');
  git('remote', 'add', 'origin', 'https://ada:hunter2hunter2@git.example/tea/pot.git');
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: (line) => logLines.push(line),
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
    fetch: hostFetch,
  });
  asUser({ type: 'setting.set', key: 'advanced.logLevel', scope: 'global', value: 'debug' });
  asUser({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Claude at work',
    binaryPath: 'claude',
    configDir: '',
    env: {
      PLAIN_KEY: lookalike,
      ANTHROPIC_API_KEY: await server.secrets.set('provider:claude-work:env:KEY', storedSecret),
    },
    launchArgs: [],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  // The assistant writes steps only on an instance that passed its test (models spec 16).
  await server.providerService.test('claude-work');
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  asUser({
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    steps: [step('s1'), step('s2')],
  });
  asUser({
    type: 'setting.set',
    key: 'trackers.github.token',
    scope: 'global',
    value: await server.secrets.set('setting:trackers.github.token', storedSecret),
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const endpoint = (token: string | null, body: unknown = {}, method = 'POST') =>
  fetch(server.assistant.url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });

async function connect(): Promise<Client> {
  const client = new Client({ name: 'assistant-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.assistant.url), {
      requestInit: { headers: { authorization: `Bearer ${server.assistant.token}` } },
    }),
  );
  return client;
}

describe('the assistant endpoint', () => {
  it("refuses every request without the assistant's token (spec 2)", async () => {
    const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect((await endpoint(null, listTools, method)).status).toBe(401);
      expect((await endpoint('wrong', listTools, method)).status).toBe(401);
      // The token of the app's own connection opens nothing here.
      expect((await endpoint(server.token, listTools, method)).status).toBe(401);
    }
    const query = await fetch(`${server.assistant.url}?token=${server.assistant.token}`, {
      method: 'POST',
      body: JSON.stringify(listTools),
    });
    expect(query.status).toBe(401);
    expect(changes()).toEqual([]);

    // And the assistant's token does not open the app's connection.
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.assistant.token}`);
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('open', () => resolve(undefined));
      socket.once('error', () => undefined);
    });
    expect(status).toBe(401);
  });

  it('lists and runs the tools over MCP with the token', async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(
        [
          ...Object.keys(readers),
          ...Object.keys(guideReaders),
          ...Object.keys(diagnosisReaders),
          ...Object.keys(modelReaders),
          ...Object.keys(asks),
          ...Object.keys(changeTools),
        ].toSorted(),
      );
      expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
      const result = await client.callTool({ name: 'read_projects', arguments: {} });
      const [content] = result.content as { type: string; text: string }[];
      expect(result.isError).toBe(false);
      expect(JSON.parse(content?.text ?? '')).toMatchObject([{ id: 'tea', name: 'Tea' }]);

      const changed = await client.callTool({
        name: 'set_setting',
        arguments: { key: 'calendar.showWeekends', scope: 'global', value: true },
      });
      expect(changed.isError).toBe(false);
      expect(setting('calendar.showWeekends')).toBe(true);
      expect(changes()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

describe('read tools', () => {
  it('return settings, projects, providers, workflows, templates, skills, the calendar, the backlog, runs, triggers, notifications and connection tests (spec 4)', async () => {
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      body: 'Private notes on the card',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    asUser({
      type: 'outlook.sync',
      at: now,
      window: { from: now, to: '2026-11-20T00:00:00.000Z' },
      calendar: [
        {
          id: 'outlook:1',
          externalId: '1',
          title: 'Tea council',
          start: '2026-11-11T09:00:00.000Z',
          end: '2026-11-11T10:00:00.000Z',
          zone: 'Europe/Stockholm',
          allDay: false,
          location: 'The round room',
          joinUrl: 'https://meet.example/tea',
          body: 'Agenda nobody else should read',
          organizer: 'Grace',
          state: 'scheduled',
        },
      ],
      bridgeVersion: 'test',
      profile: null,
    });
    asUser({
      type: 'backlog.create',
      backlogItemId: 'b1',
      title: 'A quieter kettle',
      body: 'It whistles too loudly.',
      tags: ['kettle'],
    });
    asUser({
      type: 'skills.sync',
      skills: [
        {
          id: 'skill-1',
          name: 'deliver-work',
          description: 'Delivers one unit.',
          dir: path.join(root, 'skills', 'deliver-work'),
          source: 'custom',
          manualOnly: false,
          invocations: { claude: '/deliver-work', codex: '$deliver-work' },
        },
      ],
    });
    asUser({
      type: 'trigger.create',
      triggerId: 'on-merge',
      projectId: 'tea',
      event: 'merged',
      workflowId: 'delivery',
    });
    asUser({
      type: 'workflow.create',
      workflowId: 'gated',
      name: 'Gated',
      steps: [step('s1', { gateBefore: true })],
    });
    asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'gated', projectId: 'tea' });
    asUser({ type: 'workflowRun.stop', runId: 'run-1' });
    asUser({
      type: 'providerInstance.recordTest',
      providerInstanceId: 'claude-work',
      result: { ok: true, account: 'ada@example.com', version: '2.1.0', message: null },
    } as ServerCommand);

    const settings = await list('read_settings', { group: 'calendar' });
    expect(settings.find((entry) => entry['key'] === 'calendar.showWeekends')).toMatchObject({
      label: 'Weekends in week view',
      description: expect.stringContaining('Saturday') as string,
      source: 'default',
      storedAt: 'global',
    });
    asUser({ type: 'setting.set', key: 'calendar.showWeekends', scope: 'global', value: true });
    expect(
      (await list('read_settings')).find((entry) => entry['key'] === 'calendar.showWeekends'),
    ).toMatchObject({ value: true, source: 'global' });

    expect(await list('read_projects')).toEqual([
      {
        id: 'tea',
        name: 'Tea',
        folder: path.join(root, 'tea'),
        defaultProviderInstanceId: null,
        defaultModel: null,
        git: expect.objectContaining({ status: 'ok' }) as unknown,
        // The address without the account and password written into it.
        remote: { name: 'origin', url: 'https://git.example/tea/pot.git', path: 'tea/pot' },
        host: 'git.example',
      },
    ]);
    expect(await list('read_providers')).toMatchObject([
      {
        id: 'claude-work',
        kind: 'claude',
        signedIn: true,
        account: 'ada@example.com',
        environment: [
          { name: 'PLAIN_KEY', value: 'not shown' },
          { name: 'ANTHROPIC_API_KEY', value: 'set' },
        ],
      },
    ]);
    expect(await list('read_workflows')).toMatchObject([
      {
        id: 'delivery',
        name: 'Delivery',
        steps: [
          { skillName: 'deliver-work', skillInstalled: true, gateAfter: true },
          { skillName: 'check-work', skillInstalled: false },
        ],
      },
      { id: 'gated', name: 'Gated' },
    ]);
    expect((await list('read_templates')).length).toBeGreaterThan(0);
    expect(await list('read_skills')).toEqual([
      {
        id: 'skill-1',
        name: 'deliver-work',
        description: 'Delivers one unit.',
        source: 'custom',
        manualOnly: false,
      },
    ]);
    const calendar = (await call('read_calendar')).content;
    expect(calendar['cards']).toMatchObject([
      {
        id: 'card-1',
        title: 'Brew the plan',
        start: '2026-11-11T12:00:00.000Z',
        workflowId: 'delivery',
      },
    ]);
    // A meeting is its time and title, nothing else of it.
    expect(calendar['meetings']).toEqual([
      {
        title: 'Tea council',
        start: '2026-11-11T09:00:00.000Z',
        end: '2026-11-11T10:00:00.000Z',
        zone: 'Europe/Stockholm',
        allDay: false,
        state: 'scheduled',
      },
    ]);
    expect(await list('read_backlog')).toMatchObject([
      { id: 'b1', title: 'A quieter kettle', state: 'idea', tags: ['kettle'] },
    ]);
    const runs = (await call('read_runs')).content;
    expect(runs['runs']).toMatchObject([
      { id: 'run-1', workflow: 'Gated', state: 'stopped', path: '/workflows/runs/run-1' },
    ]);
    expect(runs['planRuns']).toEqual([]);
    expect((await call('read_runs', { live: true })).content['runs']).toEqual([]);
    expect(await list('read_triggers')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'card',
          cardId: 'card-1',
          card: 'Brew the plan',
          state: 'scheduled',
        }),
        expect.objectContaining({ id: 'on-merge', kind: 'event', event: 'merged', enabled: true }),
      ]),
    );
    expect((await list('read_notifications')).length).toBeGreaterThan(0);
    expect((await call('read_connections')).content['providers']).toEqual([
      {
        id: 'claude-work',
        name: 'Claude at work',
        tested: true,
        ok: true,
        account: 'ada@example.com',
        message: null,
      },
    ]);
    expect((await call('test_connection', { service: 'github' })).content).toMatchObject({
      service: 'github',
      passed: true,
      account: 'ada',
    });
    expect((await call('test_connection', { service: 'jira' })).content).toMatchObject({
      passed: false,
      missing: expect.arrayContaining(['trackers.jira.baseUrl']) as string[],
    });
  });

  it('never carry a stored secret: no result, stored event or log line contains it, and a secret shows only set or not set (spec 5, 18)', async () => {
    // The host did get the token, so the search below is not passing for want of a secret.
    const texts: string[] = [];
    for (const name of Object.keys(readers)) {
      if (name === 'test_connection') {
        for (const service of ['jira', 'github', 'gitlab', 'confluence']) {
          texts.push((await call(name, { service })).text);
          texts.push((await call(name, { service, projectId: 'tea' })).text);
        }
      } else {
        texts.push((await call(name)).text);
        if (name === 'read_settings') texts.push((await call(name, { projectId: 'tea' })).text);
      }
    }
    // The guides and the diagnosis (U4) too; the diagnosis runs the sign-in tests itself.
    for (const service of ['jira', 'github', 'gitlab', 'confluence']) {
      texts.push((await call('read_token_guide', { service })).text);
      texts.push((await call('read_token_guide', { service, projectId: 'tea' })).text);
    }
    texts.push((await call('diagnose_setup')).text);
    expect(hostRequests.some((request) => request.authorization?.includes(storedSecret))).toBe(
      true,
    );
    // Changes next to the secrets leave it alone too.
    await call('set_setting', { key: 'trackers.github.owner', scope: 'global', value: 'acme' });
    await call('set_setting', {
      key: 'trackers.github.token',
      scope: 'global',
      value: storedSecret,
    });
    await call('reset_setting', { key: 'trackers.github.token', scope: 'global' });

    const stored = [
      ...server.database.db.select().from(events).all(),
      ...server.database.db.select().from(commandReceipts).all(),
      ...changes(),
      ...proposals(),
    ].map((row) => JSON.stringify(row));
    expect(texts.length).toBeGreaterThan(Object.keys(readers).length);
    expect(logLines.some((line) => line.includes('assistant tool'))).toBe(true);
    for (const text of [...texts, ...stored, ...logLines]) {
      expect(text).not.toContain(storedSecret);
      expect(text).not.toContain('hunter2hunter2');
    }

    const settings = await list('read_settings', { group: 'trackers' });
    const secret = (key: string) => settings.find((entry) => entry['key'] === key);
    expect(secret('trackers.github.token')).toMatchObject({ secret: 'set' });
    expect(secret('trackers.github.token')).not.toHaveProperty('value');
    expect(secret('trackers.github.token')).not.toHaveProperty('default');
    expect(secret('trackers.jira.token')).toMatchObject({ secret: 'not set' });
    expect((await list('read_providers'))[0]).toMatchObject({
      environment: [
        { name: 'PLAIN_KEY', value: 'not shown' },
        { name: 'ANTHROPIC_API_KEY', value: 'set' },
      ],
    });
  });

  it('hide a value that looks like a secret wherever it reached a result or a change row (spec 18)', async () => {
    // A token typed into an ordinary field by mistake.
    asUser({ type: 'setting.set', key: 'trackers.jira.email', scope: 'global', value: lookalike });
    const read = await call('read_settings', { group: 'trackers' });
    expect(read.text).not.toContain(lookalike);
    expect(
      (read.content as unknown as Record<string, unknown>[]).find(
        (entry) => entry['key'] === 'trackers.jira.email',
      ),
    ).toMatchObject({ value: hiddenText });

    const changed = await call('set_setting', {
      key: 'trackers.jira.email',
      scope: 'global',
      value: 'ada@example.com',
    });
    expect(changed.text).not.toContain(lookalike);
    expect(changed.content.change).toMatchObject({ from: hiddenText, to: 'ada@example.com' });
    const [row] = changes();
    expect([row?.what, row?.from, row?.to].join(' ')).not.toContain(lookalike);
    for (const line of logLines) expect(line).not.toContain(lookalike);
    // The topic's row is what a client gets: it leaves out the record Undo keeps.
    expect(JSON.stringify(changes())).not.toContain(lookalike);
    expect(row).not.toHaveProperty('inverse');
    expect(row).not.toHaveProperty('expect');
    // A tool name is something the caller wrote, so the log does not repeat one it does not know.
    const unknown = await call(`unknown ${lookalike}`);
    expect(unknown).toMatchObject({ isError: true, content: { outcome: 'unknown tool' } });
    expect(unknown.text).not.toContain(lookalike);
    for (const line of logLines) expect(line).not.toContain(lookalike);
    // Undo still puts the value back: the server's own record is not what the assistant sees.
    asUser({ type: 'assistant.undo', changeId: row?.id ?? '' });
    expect(setting('trackers.jira.email')).toBe(lookalike);
  });

  it("offer no tool that returns a thread's messages or a file's content (spec 6)", async () => {
    asUser({
      type: 'thread.create',
      threadId: 'thread-1',
      providerInstanceId: 'claude-work',
      projectId: 'tea',
      cwd: path.join(root, 'tea'),
      title: 'About the kettle',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    asUser({ type: 'thread.sendMessage', threadId: 'thread-1', text: threadMarker });
    asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'delivery', projectId: 'tea' });
    const run = rows<WorkflowRun>('workflowRuns')[0];
    asUser({
      type: 'workflowRun.stepCompleted',
      runId: 'run-1',
      stepId: run?.steps[0]?.stepId ?? '',
      finalMessage: `The agent wrote: ${threadMarker}`,
      artifactsFound: [],
    });
    expect(JSON.stringify(rows('workflowRuns'))).toContain(threadMarker);

    const names = server.assistant.tools.list().map((tool) => tool.name);
    expect(names.filter((name) => /thread|message|file|content|chat/i.test(name))).toEqual([]);
    for (const name of [
      ...Object.keys(readers),
      ...Object.keys(guideReaders),
      ...Object.keys(diagnosisReaders),
    ]) {
      const needsService = name === 'test_connection' || name === 'read_token_guide';
      const { text } = await call(name, needsService ? { service: 'github' } : {});
      expect(text).not.toContain(threadMarker);
      expect(text).not.toContain(fileMarker);
    }
    // Nor does a tool exist under the name of the app's own file and thread methods.
    for (const name of ['files.read', 'read_file', 'read_thread', 'read_threads', 'subscribe']) {
      expect(await call(name)).toMatchObject({
        isError: true,
        content: { outcome: 'unknown tool' },
      });
    }
  });
});

describe('ordinary changes', () => {
  it('apply the command a view sends and store the change with what changed, from what to what, and its place: a calendar setting, a card, a backlog item, a tracker host (spec 7, 13, 20)', async () => {
    const hours = { start: '08:00', end: '16:00', days: ['monday', 'tuesday'] };
    const first = await call('set_setting', {
      key: 'calendar.workHours',
      scope: 'global',
      value: hours,
    });
    expect(first).toMatchObject({ isError: false, content: { outcome: 'changed' } });
    expect(setting('calendar.workHours')).toEqual(hours);

    const made = await call('create_card', {
      title: 'Taste the new blend',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
    });
    const cardId = String(made.content['cardId']);
    expect(card(cardId)).toMatchObject({ title: 'Taste the new blend', projectId: 'tea' });
    await call('update_card', {
      cardId,
      start: '2026-11-11T14:00:00.000Z',
      end: '2026-11-11T15:00:00.000Z',
    });
    expect(card(cardId)).toMatchObject({ start: '2026-11-11T14:00:00.000Z' });

    const idea = await call('create_backlog_item', {
      title: 'A lid that fits',
      body: '',
      tags: [],
    });
    const backlogItemId = String(idea.content['backlogItemId']);
    await call('update_backlog_item', { backlogItemId, title: 'A lid that fits the pot' });
    expect(item(backlogItemId)).toMatchObject({ title: 'A lid that fits the pot' });

    await call('set_setting', {
      key: 'trackers.gitlab.baseUrl',
      scope: 'project:tea',
      value: 'https://gitlab.example',
    });
    expect(setting('trackers.gitlab.baseUrl', 'project:tea')).toBe('https://gitlab.example');

    // One row per change, in the order they were made (spec 13).
    expect(
      changes().map(({ commandType, what, from, to, place, state }) => ({
        commandType,
        what,
        from,
        to,
        place,
        state,
      })),
    ).toEqual([
      {
        commandType: 'setting.set',
        what: 'Work hours',
        from: 'outlook (default)',
        to: '08:00–16:00 (monday, tuesday)',
        place: { label: 'Settings → Calendar', path: '/settings/calendar' },
        state: 'applied',
      },
      {
        commandType: 'card.create',
        what: 'Card "Taste the new blend"',
        from: null,
        to: 'title: Taste the new blend; start: 2026-11-11T12:00:00.000Z; end: 2026-11-11T13:00:00.000Z; projectId: Tea',
        place: { label: 'Calendar', path: `/calendar?item=${cardId}` },
        state: 'applied',
      },
      {
        commandType: 'card.update',
        what: 'Card "Taste the new blend"',
        from: 'start: 2026-11-11T12:00:00.000Z; end: 2026-11-11T13:00:00.000Z',
        to: 'start: 2026-11-11T14:00:00.000Z; end: 2026-11-11T15:00:00.000Z',
        place: { label: 'Calendar', path: `/calendar?item=${cardId}` },
        state: 'applied',
      },
      {
        commandType: 'backlog.create',
        what: 'Backlog item "A lid that fits"',
        from: null,
        to: 'A lid that fits',
        place: { label: 'Backlog', path: `/backlog/${backlogItemId}` },
        state: 'applied',
      },
      {
        commandType: 'backlog.update',
        what: 'Backlog item "A lid that fits the pot": title',
        from: 'A lid that fits',
        to: 'A lid that fits the pot',
        place: { label: 'Backlog', path: `/backlog/${backlogItemId}` },
        state: 'applied',
      },
      {
        commandType: 'setting.set',
        what: 'GitLab URL (Tea)',
        from: 'none (default)',
        to: 'https://gitlab.example',
        place: { label: 'Settings → Projects', path: '/settings/projects' },
        state: 'applied',
      },
    ]);
    // The tool tells the assistant the same row, so it can say where the change lives.
    expect(first.content.change).toEqual({
      id: changes()[0]?.id,
      what: 'Work hours',
      from: 'outlook (default)',
      to: '08:00–16:00 (monday, tuesday)',
      place: { label: 'Settings → Calendar', path: '/settings/calendar' },
    });
    // The events are the ones a view's command leaves, plus the record.
    const kinds = server.database.db
      .select()
      .from(events)
      .all()
      .map((event) => event.kind);
    expect(kinds.slice(-2)).toEqual(['setting.changed', 'assistant.changed']);
  });

  it('store nothing when the command changes nothing', async () => {
    asUser({ type: 'setting.set', key: 'calendar.showWeekends', scope: 'global', value: true });
    expect(
      (await call('set_setting', { key: 'calendar.showWeekends', scope: 'global', value: true }))
        .content,
    ).toMatchObject({ outcome: 'unchanged' });
    expect(changes()).toEqual([]);
  });
});

describe('undo', () => {
  it('applies the inverse and marks the change undone (spec 8)', async () => {
    asUser({ type: 'setting.set', key: 'calendar.snapMinutes', scope: 'global', value: 15 });
    await call('set_setting', { key: 'calendar.snapMinutes', scope: 'global', value: 30 });
    await call('set_setting', { key: 'calendar.showWeekends', scope: 'global', value: true });
    const made = await call('create_card', {
      title: 'Taste the new blend',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
    });
    const cardId = String(made.content['cardId']);
    await call('update_card', { cardId, title: 'Taste both blends' });
    await call('delete_workflow', { workflowId: 'delivery' });
    const idea = await call('create_backlog_item', {
      title: 'A lid that fits',
      body: '',
      tags: [],
    });
    const backlogItemId = String(idea.content['backlogItemId']);
    await call('plan_backlog_item', {
      backlogItemId,
      workflowId: 'delivery',
      projectId: 'tea',
      start: '2026-11-12T12:00:00.000Z',
      end: '2026-11-12T13:00:00.000Z',
      zone: 'Europe/Stockholm',
    });
    expect(workflow('delivery')).toBeUndefined();

    const [snap, weekends, created, renamed, deleted, , planned] = changes();
    // The plan was refused (its workflow is gone), so it left no row.
    expect(planned).toBeUndefined();
    asUser({ type: 'assistant.undo', changeId: snap?.id ?? '' });
    expect(setting('calendar.snapMinutes')).toBe(15);
    asUser({ type: 'assistant.undo', changeId: weekends?.id ?? '' });
    expect(setting('calendar.showWeekends')).toBeUndefined();
    asUser({ type: 'assistant.undo', changeId: renamed?.id ?? '' });
    expect(card(cardId)).toMatchObject({ title: 'Taste the new blend' });
    asUser({ type: 'assistant.undo', changeId: created?.id ?? '' });
    expect(card(cardId)).toBeUndefined();
    asUser({ type: 'assistant.undo', changeId: deleted?.id ?? '' });
    expect(workflow('delivery')).toMatchObject({
      name: 'Delivery',
      steps: [step('s1'), step('s2')],
    });

    expect(changes().map((change) => [change.state, change.undoneAt])).toEqual([
      ['undone', now],
      ['undone', now],
      ['undone', now],
      ['undone', now],
      ['undone', now],
      ['applied', null],
    ]);
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: snap?.id ?? '' }))).toBe(
      'Snap to was already undone',
    );
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: 'nope' }))).toBe(
      'No change nope',
    );
  });

  it('takes back "plan on calendar" as one step: the card goes and the item is an idea again', async () => {
    const idea = await call('create_backlog_item', {
      title: 'A lid that fits',
      body: '',
      tags: [],
    });
    const backlogItemId = String(idea.content['backlogItemId']);
    const planned = await call('plan_backlog_item', {
      backlogItemId,
      workflowId: 'delivery',
      projectId: 'tea',
      start: '2026-11-12T12:00:00.000Z',
      end: '2026-11-12T13:00:00.000Z',
      zone: 'Europe/Stockholm',
    });
    const cardId = String(planned.content['cardId']);
    expect(item(backlogItemId)).toMatchObject({ state: 'planned' });
    expect(planned.content.change).toMatchObject({
      what: 'Backlog item "A lid that fits": state',
      from: 'idea',
      to: 'planned',
      place: { label: 'Calendar', path: `/calendar?item=${cardId}` },
    });
    asUser({ type: 'assistant.undo', changeId: planned.content.change?.id ?? '' });
    expect(card(cardId)).toBeUndefined();
    expect(item(backlogItemId)).toMatchObject({ state: 'idea' });
  });

  it('puts back a deleted card, a deleted trigger that was off, a deleted backlog item and a renamed project', async () => {
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      body: 'Bring the good cups',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    asUser({
      type: 'trigger.create',
      triggerId: 'on-merge',
      projectId: 'tea',
      event: 'merged',
      workflowId: 'delivery',
    });
    asUser({ type: 'trigger.setEnabled', triggerId: 'on-merge', enabled: false });
    asUser({
      type: 'backlog.create',
      backlogItemId: 'b1',
      title: 'A quieter kettle',
      body: 'It whistles too loudly.',
      tags: ['kettle'],
    });
    const kept = {
      card: card('card-1'),
      trigger: rows<Trigger>('triggers').find((row) => row.id === 'on-merge'),
      item: item('b1'),
    };

    await call('delete_card', { cardId: 'card-1' });
    await call('delete_trigger', { triggerId: 'on-merge' });
    await call('delete_backlog_item', { backlogItemId: 'b1' });
    await call('update_project', { projectId: 'tea', name: 'Tea house', defaultModel: 'opus' });
    expect(card('card-1')).toBeUndefined();
    expect(rows<Trigger>('triggers').filter((row) => row.kind === 'event')).toEqual([]);
    expect(item('b1')).toBeUndefined();
    expect(changes().map(({ what, from, to }) => ({ what, from, to }))).toEqual([
      {
        what: 'Card "Brew the plan"',
        from: 'title: Brew the plan; start: 2026-11-11T12:00:00.000Z; end: 2026-11-11T13:00:00.000Z; projectId: Tea; workflowId: Delivery',
        to: null,
      },
      {
        what: 'Trigger "Pull request merged"',
        from: 'event: merged; workflowId: Delivery; projectId: Tea',
        to: null,
      },
      { what: 'Backlog item "A quieter kettle"', from: 'A quieter kettle', to: null },
      {
        what: 'Project "Tea house"',
        from: 'name: Tea; defaultModel: none',
        to: 'name: Tea house; defaultModel: opus',
      },
    ]);

    for (const change of changes()) asUser({ type: 'assistant.undo', changeId: change.id });
    expect(card('card-1')).toEqual(kept.card);
    expect(rows<Trigger>('triggers').find((row) => row.id === 'on-merge')).toEqual(kept.trigger);
    expect(rows<Trigger>('triggers').some((row) => row.id === 'card-1:trigger')).toBe(true);
    expect(item('b1')).toEqual(kept.item);
    expect(await list('read_projects')).toMatchObject([{ name: 'Tea', defaultModel: null }]);
  });

  it('is refused with what changed when the thing changed again since (spec 8)', async () => {
    await call('set_setting', { key: 'calendar.snapMinutes', scope: 'global', value: 30 });
    const made = await call('create_card', {
      title: 'Taste the new blend',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
    });
    const cardId = String(made.content['cardId']);
    await call('update_card', { cardId, title: 'Taste both blends' });
    const [snap, created, renamed] = changes();

    asUser({ type: 'setting.set', key: 'calendar.snapMinutes', scope: 'global', value: 10 });
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: snap?.id ?? '' }))).toBe(
      'Snap to cannot be undone: it changed again since (it is now 10).',
    );
    expect(setting('calendar.snapMinutes')).toBe(10);

    asUser({ type: 'card.update', cardId, title: 'Taste three blends' });
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: renamed?.id ?? '' }))).toBe(
      'Card "Taste both blends": title cannot be undone: it changed again since (title is now Taste three blends).',
    );
    // The card's creation is refused too: it is no longer the card that was made.
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: created?.id ?? '' }))).toBe(
      'Card "Taste the new blend" cannot be undone: it changed again since (title is now Taste three blends).',
    );
    asUser({ type: 'card.delete', cardId });
    expect(refusal(() => asUser({ type: 'assistant.undo', changeId: renamed?.id ?? '' }))).toBe(
      'Card "Taste both blends": title cannot be undone: it is no longer there.',
    );
    expect(changes().every((change) => change.state === 'applied')).toBe(true);

    // A change by the assistant itself counts as "changed again" for the earlier row.
    await call('set_setting', { key: 'calendar.snapMinutes', scope: 'global', value: 5 });
    asUser({ type: 'setting.reset', key: 'calendar.snapMinutes', scope: 'global' });
    expect(
      refusal(() => asUser({ type: 'assistant.undo', changeId: changes().at(-1)?.id ?? '' })),
    ).toBe('Snap to cannot be undone: it was reset since.');
  });

  it("is the user's: the assistant cannot undo, and no tool offers it", async () => {
    await call('set_setting', { key: 'scheduler.paused', scope: 'global', value: true });
    const [paused] = changes();
    // Undoing this one would turn the scheduler back on, which the assistant may only propose.
    expect(refusal(() => asAssistant({ type: 'assistant.undo', changeId: paused?.id ?? '' }))).toBe(
      'Only the user answers a proposal or presses Undo, in the Assistant view.',
    );
    expect(setting('scheduler.paused')).toBe(true);
    expect(server.assistant.tools.list().some((tool) => /undo/i.test(tool.name))).toBe(false);
    asUser({ type: 'assistant.undo', changeId: paused?.id ?? '' });
    expect(setting('scheduler.paused')).toBeUndefined();
  });
});

const before = () => JSON.stringify([rows('workflows'), rows('settings'), rows('triggers')]);

describe('proposals', () => {
  it("change nothing until the user's yes: a permission mode, a gate condition, step rules, an event trigger, for units, own working copy and the settings of spec 9", async () => {
    asUser({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: true });
    asUser({ type: 'setting.set', key: 'hosts.polling', scope: 'global', value: false });
    asUser({ type: 'setting.set', key: 'triggers.eventsEnabled', scope: 'global', value: false });
    asUser({
      type: 'trigger.create',
      triggerId: 'on-comment',
      projectId: 'tea',
      event: 'commentAdded',
      workflowId: 'delivery',
    });
    asUser({ type: 'trigger.setEnabled', triggerId: 'on-comment', enabled: false });
    const untouched = before();

    const steps = (extra: Partial<WorkflowStep>) => [step('s1'), step('s2', extra)];
    const asked: [string, Record<string, unknown>][] = [
      [
        'update_workflow',
        { workflowId: 'delivery', steps: steps({ permissionMode: 'bypassPermissions' }) },
      ],
      [
        'update_workflow',
        { workflowId: 'delivery', steps: steps({ gateAfterCondition: ['verdict'] }) },
      ],
      [
        'update_workflow',
        {
          workflowId: 'delivery',
          steps: steps({
            rules: [
              {
                when: { fact: 'verdict', is: 'changesRequested' },
                goTo: { type: 'step', stepId: 's1' },
              },
            ],
          }),
        },
      ],
      ['update_workflow', { workflowId: 'delivery', steps: steps({ gateAfter: false }) }],
      ['create_trigger', { projectId: 'tea', event: 'merged', workflowId: 'delivery' }],
      ['set_trigger_enabled', { triggerId: 'on-comment', enabled: true }],
      ['update_workflow', { workflowId: 'delivery', forUnits: true }],
      ['update_workflow', { workflowId: 'delivery', ownWorkingCopy: true }],
      [
        'create_workflow',
        { name: 'Bold', steps: [step('s1', { permissionMode: 'bypassPermissions' })] },
      ],
      ['set_setting', { key: 'scheduler.paused', scope: 'global', value: false }],
      ['reset_setting', { key: 'scheduler.paused', scope: 'global' }],
      ['set_setting', { key: 'scheduler.missedPolicy', scope: 'global', value: 'run' }],
      ['set_setting', { key: 'hosts.polling', scope: 'global', value: true }],
      ['set_setting', { key: 'triggers.eventsEnabled', scope: 'global', value: true }],
      ['set_setting', { key: 'viewer.htmlScripts', scope: 'global', value: true }],
      [
        'set_setting',
        { key: 'assistant.secretPatterns', scope: 'global', value: ['never-matches-x'] },
      ],
      // Fewer skills that always stop.
      ['set_setting', { key: 'workflows.alwaysStopSkills', scope: 'global', value: [] }],
      // The GitHub token is set, and this is where it would be sent.
      [
        'set_setting',
        { key: 'trackers.github.baseUrl', scope: 'global', value: 'https://collector.example' },
      ],
      [
        'set_setting',
        {
          key: 'trackers.github.baseUrl',
          scope: 'project:tea',
          value: 'https://collector.example',
        },
      ],
    ];
    for (const [name, args] of asked) {
      const result = await call(name, args);
      expect([name, result.isError, result.content.outcome]).toEqual([name, false, 'proposed']);
      expect(before()).toBe(untouched);
    }
    expect(changes()).toEqual([]);
    expect(proposals()).toHaveLength(asked.length);
    expect(proposals().every((proposal) => proposal.state === 'pending')).toBe(true);
    expect(
      proposals()
        .map(({ title, lines }) => ({ title, lines }))
        .slice(0, 5),
    ).toEqual([
      {
        title: 'Change workflow "Delivery"',
        lines: [
          {
            what: 'Step 2 (check-work) permission mode',
            from: "the provider's default",
            to: 'bypassPermissions',
          },
        ],
      },
      {
        title: 'Change workflow "Delivery"',
        lines: [
          {
            what: 'Step 2 (check-work) gate passes by itself when',
            from: 'never; it waits for you',
            to: 'Approved verdict',
          },
        ],
      },
      {
        title: 'Change workflow "Delivery"',
        lines: [
          {
            what: 'Step 2 (check-work) rules',
            from: 'none',
            to: 'verdict changes requested → step 1 (deliver-work)',
          },
        ],
      },
      {
        title: 'Change workflow "Delivery"',
        lines: [{ what: 'Step 2 (check-work) gate after', from: 'stops', to: 'does not stop' }],
      },
      {
        title: 'New event trigger in Tea',
        lines: [{ what: 'When "Pull request merged"', from: null, to: 'start Delivery' }],
      },
    ]);
    expect(proposals().at(9)).toMatchObject({
      title: 'Change Paused',
      lines: [{ what: 'Paused', from: 'on', to: 'off' }],
      place: { label: 'Settings → Scheduler', path: '/settings/scheduler' },
    });

    // The same changes in the direction that asks for less are ordinary.
    asUser({ type: 'setting.set', key: 'viewer.htmlScripts', scope: 'global', value: true });
    for (const [name, args] of [
      ['set_setting', { key: 'viewer.htmlScripts', scope: 'global', value: false }],
      ['set_setting', { key: 'scheduler.missedPolicy', scope: 'global', value: 'skip' }],
      ['update_workflow', { workflowId: 'delivery', name: 'Delivery, slowly' }],
      [
        'update_workflow',
        { workflowId: 'delivery', steps: [step('s1', { gateBefore: true }), step('s2')] },
      ],
      [
        'set_setting',
        {
          key: 'workflows.alwaysStopSkills',
          scope: 'global',
          value: ['capture-intent', 'plan-work', 'design-work', 'shape-work', 'check-work'],
        },
      ],
      // No Jira token is stored, so there is nothing a new address could be sent.
      [
        'set_setting',
        { key: 'trackers.jira.baseUrl', scope: 'global', value: 'https://jira.example' },
      ],
    ] as const) {
      expect([name, (await call(name, args)).content.outcome]).toEqual([name, 'changed']);
    }
    expect(hostRequests.some((request) => request.url.includes('collector.example'))).toBe(false);
  });

  it('carry the whole of a value their line has to shorten, so nothing is accepted unseen', async () => {
    const patterns = Array.from({ length: 12 }, (_, n) => `never-matches-${n}-kettle-lid`);
    const result = await call('set_setting', {
      key: 'assistant.secretPatterns',
      scope: 'global',
      value: patterns,
    });
    expect(result.content.outcome).toBe('proposed');
    const [line] = proposals().at(-1)?.lines ?? [];
    const whole = patterns.join(', ');
    expect(whole.length).toBeGreaterThan(160);
    expect(line?.to).toBe(`${whole.slice(0, 159)}…`);
    expect(line?.toFull).toBe(whole);
    // A short value needs no second copy.
    await call('set_setting', { key: 'viewer.htmlScripts', scope: 'global', value: true });
    expect(Object.keys(proposals().at(-1)?.lines[0] ?? {})).toEqual(['what', 'from', 'to']);
  });

  it('shorten values to assistant.valueLength characters', async () => {
    asUser({ type: 'setting.set', key: 'assistant.valueLength', scope: 'global', value: 20 });
    const patterns = ['never-matches-kettle-lid-0', 'never-matches-kettle-lid-1'];
    await call('set_setting', {
      key: 'assistant.secretPatterns',
      scope: 'global',
      value: patterns,
    });
    const [line] = proposals().at(-1)?.lines ?? [];
    expect(line?.to).toBe(`${patterns.join(', ').slice(0, 19)}…`);
    await call('set_setting', {
      key: 'workflows.handoverTemplate',
      scope: 'global',
      value: 'A handover longer than twenty characters.',
    });
    expect(changes().at(-1)?.to).toBe('A handover longer t…');
  });

  it('ask before a tracker address changes at any scope while a project holds its own token: the token is never sent to the new host first', async () => {
    // The shared token is gone; only the project has one, and the address it resolves is global.
    asUser({ type: 'setting.reset', key: 'trackers.github.token', scope: 'global' });
    asUser({
      type: 'setting.set',
      key: 'trackers.github.token',
      scope: 'project:tea',
      value: await server.secrets.set('setting:project:tea:trackers.github.token', storedSecret),
    });
    hostRequests = [];
    for (const args of [
      {
        key: 'trackers.github.baseUrl',
        scope: 'global',
        value: 'https://collector.example/api/v3',
      },
      { key: 'trackers.github.baseUrl', scope: 'project:tea', value: 'https://collector.example' },
    ]) {
      const result = await call('set_setting', args);
      expect([args.scope, result.content.outcome]).toEqual([args.scope, 'proposed']);
    }
    expect(
      (await call('reset_setting', { key: 'trackers.github.baseUrl', scope: 'global' })).content
        .outcome,
    ).not.toBe('changed');
    await call('test_connection', { service: 'github', projectId: 'tea' });
    expect(hostRequests.some((request) => request.url.includes('collector.example'))).toBe(false);
  });

  it("ask before a fork's pull requests may start runs or may no longer, at any scope", async () => {
    asUser({ type: 'setting.set', key: 'triggers.forkPullRequests', scope: 'global', value: true });
    const untouched = before();
    for (const args of [
      { key: 'triggers.forkPullRequests', scope: 'global', value: false },
      { key: 'triggers.forkPullRequests', scope: 'project:tea', value: true },
      { key: 'triggers.forkPullRequests', scope: 'project:tea', value: false },
    ]) {
      const result = await call('set_setting', args);
      expect([args.scope, args.value, result.content.outcome]).toEqual([
        args.scope,
        args.value,
        'proposed',
      ]);
    }
    const reset = await call('reset_setting', {
      key: 'triggers.forkPullRequests',
      scope: 'global',
    });
    expect(reset.content.outcome).toBe('proposed');
    expect(before()).toBe(untouched);
    expect(changes()).toEqual([]);
  });

  it('ask before a project moves to another folder, and before a card with a workflow that starts now or within assistant.startSoonMinutes', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const moved = await call('update_project', { projectId: 'tea', cwd: elsewhere });
    expect(moved.content.outcome).toBe('proposed');
    expect(
      rows<{ id: string; cwd: string }>('projects').find((row) => row.id === 'tea')?.cwd,
    ).not.toBe(elsewhere);
    // A new name is still an ordinary change.
    expect(
      (await call('update_project', { projectId: 'tea', name: 'Tea pot' })).content.outcome,
    ).toBe('changed');

    const lid = (start: number) => ({
      title: 'Deliver the lid',
      start: at(start),
      end: at(start + 30),
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    expect((await call('create_card', lid(0))).content.outcome).toBe('proposed');
    expect((await call('create_card', lid(10))).content.outcome).toBe('proposed');
    expect(rows('workflowRuns')).toEqual([]);
    // Further ahead it is scheduling: made at once, and it can be undone.
    const later = await call('create_card', lid(120));
    expect(later.content.outcome).toBe('changed');
    // Moving that card to now asks.
    expect(
      (
        await call('update_card', {
          cardId: String(later.content['cardId']),
          start: at(1),
          end: at(31),
        })
      ).content.outcome,
    ).toBe('proposed');
    // A card without a workflow starts nothing, whenever it is.
    const { workflowId: _none, ...plain } = lid(0);
    expect((await call('create_card', plain)).content.outcome).toBe('changed');
  });

  it('ask again when a step that already bypasses permissions or passes its gate by itself gets another skill, prompt, provider or model', async () => {
    asUser({
      type: 'workflow.update',
      workflowId: 'delivery',
      steps: [
        step('s1', { permissionMode: 'bypassPermissions', gateAfter: false }),
        step('s2', { gateAfterCondition: ['verdict'] }),
      ],
    });
    const bold = { permissionMode: 'bypassPermissions', gateAfter: false };
    const passes: Partial<WorkflowStep> = { gateAfterCondition: ['verdict'] };
    for (const steps of [
      [step('s1', { ...bold, skillName: 'check-work' }), step('s2', passes)],
      [step('s1', { ...bold, extraPrompt: 'Also tidy the shelf.' }), step('s2', passes)],
      [step('s1', { ...bold, model: 'mock-model-large' }), step('s2', passes)],
      [step('s1', bold), step('s2', { ...passes, extraPrompt: 'Approve it.' })],
    ]) {
      const result = await call('update_workflow', { workflowId: 'delivery', steps });
      expect(result.content.outcome).toBe('proposed');
    }
    expect(proposals()[0]).toMatchObject({
      lines: [{ what: 'Step 1 (check-work) skill', from: 'deliver-work', to: 'check-work' }],
    });
    expect(changes()).toEqual([]);
    expect(workflow('delivery')?.steps[0]).toMatchObject({ skillName: 'deliver-work' });
  });

  it("are applied by the user's accept and refused from the assistant's origin (spec 9)", async () => {
    const proposed = await call('update_workflow', {
      workflowId: 'delivery',
      steps: [step('s1', { permissionMode: 'bypassPermissions' }), step('s2')],
    });
    const proposalId = proposed.content.proposal?.id ?? '';
    expect(proposed.content.proposal).toMatchObject({ title: 'Change workflow "Delivery"' });

    expect(refusal(() => asAssistant({ type: 'assistant.proposal.accept', proposalId }))).toBe(
      'Only the user answers a proposal or presses Undo, in the Assistant view.',
    );
    expect(refusal(() => asAssistant({ type: 'assistant.proposal.decline', proposalId }))).toBe(
      'Only the user answers a proposal or presses Undo, in the Assistant view.',
    );
    expect(workflow('delivery')?.steps[0]).not.toHaveProperty('permissionMode');
    expect(proposals()[0]).toMatchObject({ state: 'pending' });
    expect(
      server.assistant.tools.list().some((tool) => /accept|decline|proposal/i.test(tool.name)),
    ).toBe(false);

    asUser({ type: 'assistant.proposal.accept', proposalId });
    expect(workflow('delivery')?.steps[0]).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(proposals()[0]).toMatchObject({ state: 'accepted', answeredAt: now, reason: null });
    expect(refusal(() => asUser({ type: 'assistant.proposal.accept', proposalId }))).toBe(
      '"Change workflow "Delivery"" was already accepted',
    );
  });

  it('are left alone by a No, which keeps its reason for the assistant', async () => {
    const proposed = await call('set_setting', {
      key: 'viewer.htmlScripts',
      scope: 'global',
      value: true,
    });
    const proposalId = proposed.content.proposal?.id ?? '';
    // A reason that looks like a secret is refused, as a held message is not sent.
    expect(
      refusal(() =>
        asUser({
          type: 'assistant.proposal.decline',
          proposalId,
          reason: ` Not on this machine ${lookalike} `,
        }),
      ),
    ).toMatch(/^Not sent: this looks like /);
    expect(proposals()[0]).toMatchObject({ state: 'pending' });
    asUser({ type: 'assistant.proposal.decline', proposalId, reason: ' Not on this machine ' });
    expect(proposals()[0]).toMatchObject({ state: 'declined', reason: 'Not on this machine' });
    expect(setting('viewer.htmlScripts')).toBeUndefined();
    expect(refusal(() => asUser({ type: 'assistant.proposal.accept', proposalId }))).toContain(
      'was already declined',
    );
  });

  it('word a trigger of a GitLab project as a merge request', async () => {
    server.database.db
      .insert(hostReads)
      .values({
        id: 'plan:tea:kettle',
        projectId: 'tea',
        scope: 'plan',
        host: 'gitlab',
        hostName: 'gitlab.example.invalid',
        branch: null,
        changeRequestIds: [],
        fetchedAt: '2026-11-10T08:00:00.000Z',
        error: null,
      })
      .run();
    await call('create_trigger', { projectId: 'tea', event: 'merged', workflowId: 'delivery' });
    asUser({
      type: 'trigger.create',
      triggerId: 'on-merge',
      projectId: 'tea',
      event: 'merged',
      workflowId: 'delivery',
    });
    asUser({ type: 'trigger.setEnabled', triggerId: 'on-merge', enabled: false });
    await call('set_trigger_enabled', { triggerId: 'on-merge', enabled: true });
    expect(proposals().map(({ title, lines }) => ({ title, what: lines[0]?.what }))).toEqual([
      { title: 'New event trigger in Tea', what: 'When "Merge request merged"' },
      { title: 'Turn on the trigger "Merge request merged"', what: 'Start Delivery in Tea' },
    ]);
    await call('delete_trigger', { triggerId: 'on-merge' });
    expect(changes().map(({ what }) => what)).toEqual(['Trigger "Merge request merged"']);
  });

  it("fail at Yes with the app's reason when the app refuses the command by then, and stay open", async () => {
    const proposed = await call('create_trigger', {
      projectId: 'tea',
      event: 'merged',
      workflowId: 'delivery',
    });
    const triggerId = String(proposed.content['triggerId']);
    asUser({
      type: 'trigger.create',
      triggerId,
      projectId: 'tea',
      event: 'checksFailed',
      workflowId: 'delivery',
    });
    expect(
      refusal(() =>
        asUser({
          type: 'assistant.proposal.accept',
          proposalId: proposed.content.proposal?.id ?? '',
        }),
      ),
    ).toBe(`Trigger ${triggerId} already exists`);
    expect(proposals()[0]).toMatchObject({ state: 'pending' });
  });

  it('are refused at Yes when what the card was written for changed since: the assistant cannot point a pending start somewhere else (spec 9, 10)', async () => {
    asUser({
      type: 'workflow.create',
      workflowId: 'other',
      name: 'Other',
      steps: [step('s1', { permissionMode: 'bypassPermissions' })],
    });
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    const proposed = await call('start_card_run', { cardId: 'card-1' });
    const proposalId = proposed.content.proposal?.id ?? '';
    expect(proposed.content.proposal).toMatchObject({ title: 'Start Delivery in Tea' });

    // An ordinary change of the assistant's own.
    expect(
      (await call('update_card', { cardId: 'card-1', workflowId: 'other' })).content.outcome,
    ).toBe('changed');
    expect(refusal(() => asUser({ type: 'assistant.proposal.accept', proposalId }))).toBe(
      '"Start Delivery in Tea" was proposed for how things were then, and the card and the workflow changed since. Say No to it and ask again.',
    );
    expect(rows('workflowRuns')).toEqual([]);
    expect(proposals()[0]).toMatchObject({ title: 'Start Delivery in Tea', state: 'pending' });

    // Back as it was, the card is what the proposal says again.
    asUser({ type: 'card.update', cardId: 'card-1', workflowId: 'delivery' });
    asUser({ type: 'assistant.proposal.accept', proposalId });
    expect(rows<WorkflowRun>('workflowRuns')).toMatchObject([
      { workflowId: 'delivery', projectId: 'tea' },
    ]);

    // The same for a start by name, a trigger and a setting.
    const start = await call('start_run', { workflowId: 'delivery', projectId: 'tea' });
    const trigger = await call('create_trigger', {
      projectId: 'tea',
      event: 'merged',
      workflowId: 'other',
    });
    const scripts = await call('set_setting', {
      key: 'viewer.htmlScripts',
      scope: 'global',
      value: true,
    });
    await call('update_workflow', { workflowId: 'delivery', name: 'Delivery, quickly' });
    asUser({ type: 'workflow.update', workflowId: 'other', name: 'Another' });
    asUser({ type: 'setting.set', key: 'viewer.htmlScripts', scope: 'global', value: false });
    for (const [result, changed] of [
      [start, 'workflow'],
      [trigger, 'workflow'],
      [scripts, 'setting'],
    ] as const) {
      expect(
        refusal(() =>
          asUser({
            type: 'assistant.proposal.accept',
            proposalId: result.content.proposal?.id ?? '',
          }),
        ),
      ).toContain(`and the ${changed} changed since`);
    }
    expect(rows('workflowRuns')).toHaveLength(1);
    expect(setting('viewer.htmlScripts')).toBe(false);
  });

  it("are refused at Yes when the user changed the workflow by hand since: a held step list does not overwrite the user's edits", async () => {
    const proposed = await call('update_workflow', {
      workflowId: 'delivery',
      steps: [step('s1', { permissionMode: 'bypassPermissions' }), step('s2')],
    });
    const proposalId = proposed.content.proposal?.id ?? '';
    expect(proposed.content.proposal?.lines).toHaveLength(1);

    const byHand = [
      step('s1', { extraPrompt: 'Mind the lid.' }),
      step('s2'),
      { ...step('s3'), skillName: 'review-work' },
    ];
    asUser({ type: 'workflow.update', workflowId: 'delivery', steps: byHand });
    expect(refusal(() => asUser({ type: 'assistant.proposal.accept', proposalId }))).toBe(
      '"Change workflow "Delivery"" was proposed for how things were then, and the workflow changed since. Say No to it and ask again.',
    );
    expect(workflow('delivery')?.steps).toEqual(byHand);
    expect(proposals()[0]).toMatchObject({ state: 'pending' });
    // What a client gets of a proposal is its card: not the held command, not what it was for.
    expect(proposals()[0]).not.toHaveProperty('command');
    expect(proposals()[0]).not.toHaveProperty('basis');
    asUser({ type: 'assistant.proposal.decline', proposalId });
    expect(proposals()[0]).toMatchObject({ state: 'declined' });
  });

  it('for the start-run tool say "Start <workflow> in <project>", and the run starts only on the user\'s accept (spec 10)', async () => {
    const proposed = await call('start_run', { workflowId: 'delivery', projectId: 'tea' });
    expect(proposed.content).toMatchObject({
      outcome: 'proposed',
      proposal: { title: 'Start Delivery in Tea' },
    });
    const runId = String(proposed.content['runId']);
    expect(rows('workflowRuns')).toEqual([]);

    expect(
      refusal(() =>
        asAssistant({
          type: 'workflowRun.start',
          runId: 'direct',
          workflowId: 'delivery',
          projectId: 'tea',
        }),
      ),
    ).toBeUndefined();
    // Sent straight to the engine as the assistant, it is held all the same.
    expect(rows('workflowRuns')).toEqual([]);
    expect(proposals()).toHaveLength(2);

    asUser({ type: 'assistant.proposal.accept', proposalId: proposed.content.proposal?.id ?? '' });
    expect(rows<WorkflowRun>('workflowRuns')).toMatchObject([
      { id: runId, workflowId: 'delivery', projectId: 'tea', state: 'running' },
    ]);
  });

  it("hold a card's run, a plan run and an event trigger the same way", async () => {
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    expect((await call('start_card_run', { cardId: 'card-1' })).content).toMatchObject({
      outcome: 'proposed',
      proposal: {
        title: 'Start Delivery in Tea',
        lines: [{ what: 'Card', from: null, to: 'Brew the plan' }],
      },
    });
    const trigger = await call('create_trigger', {
      projectId: 'tea',
      event: 'merged',
      workflowId: 'delivery',
    });
    expect(rows<Trigger>('triggers').filter((row) => row.kind === 'event')).toEqual([]);
    asUser({ type: 'assistant.proposal.accept', proposalId: trigger.content.proposal?.id ?? '' });
    expect(rows<Trigger>('triggers').filter((row) => row.kind === 'event')).toMatchObject([
      { id: trigger.content['triggerId'], event: 'merged', enabled: true },
    ]);
    expect(rows('workflowRuns')).toEqual([]);
  });
});

const waiting = () => rows<WorkflowRun>('workflowRuns')[0]?.state;

describe('what the assistant may not do', () => {
  it('answer a gate: continue, send back and stop are refused from its origin, and no tool offers them (spec 11)', async () => {
    asUser({
      type: 'workflow.create',
      workflowId: 'gated',
      name: 'Gated',
      steps: [step('s1', { gateBefore: true })],
    });
    asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'gated', projectId: 'tea' });
    expect(waiting()).toBe('waiting');

    const link =
      'Only the user approves, sends back or stops a run. The run is at /workflows/runs/run-1.';
    expect(refusal(() => asAssistant({ type: 'workflowRun.continue', runId: 'run-1' }))).toBe(link);
    expect(
      refusal(() => asAssistant({ type: 'workflowRun.sendBack', runId: 'run-1', note: 'Again' })),
    ).toBe(link);
    expect(refusal(() => asAssistant({ type: 'workflowRun.stop', runId: 'run-1' }))).toBe(link);
    expect(waiting()).toBe('waiting');
    expect(proposals()).toEqual([]);

    const offered = new Set<string>(Object.values(changeTools).map((tool) => tool.type));
    for (const type of [
      'workflowRun.continue',
      'workflowRun.sendBack',
      'workflowRun.stop',
      'planRun.stop',
    ]) {
      expect(offered.has(type)).toBe(false);
    }
    expect(
      server.assistant.tools
        .list()
        .filter((tool) => /continue|approve|send_?back|stop/i.test(tool.name)),
    ).toEqual([]);

    // A card whose run is live cannot be removed by the assistant either: that would stop it.
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'gated',
    });
    asUser({ type: 'card.runNow', cardId: 'card-1', runId: 'run-2' });
    expect(await call('delete_card', { cardId: 'card-1' })).toMatchObject({
      isError: true,
      content: {
        outcome: 'refused',
        reason:
          "The card's run is live and only the user stops a run. The run is at /workflows/runs/run-2.",
      },
    });
    expect(await call('delete_card', { cardId: 'card-1', stopRun: true })).toMatchObject({
      isError: true,
      content: { outcome: 'invalid input' },
    });
    expect(
      refusal(() => asAssistant({ type: 'card.delete', cardId: 'card-1', stopRun: true })),
    ).toContain('only the user stops a run');
    expect(card('card-1')).toBeDefined();

    // The user still can.
    asUser({ type: 'workflowRun.continue', runId: 'run-1' });
    expect(waiting()).not.toBe('waiting');
  });

  it('set or clear a secret, work in threads, change providers or send what only the server sends', async () => {
    expect(
      await call('set_setting', {
        key: 'trackers.jira.token',
        scope: 'global',
        value: { secretRef: 'x' },
      }),
    ).toMatchObject({
      isError: true,
      content: {
        outcome: 'refused',
        reason:
          'Jira token is a secret. The user types it into its own field; the assistant never sets, clears or sees one.',
      },
    });
    expect(
      refusal(() =>
        asAssistant({ type: 'thread.sendMessage', threadId: 'thread-1', text: 'Fix the kettle' }),
      ),
    ).toContain('The chat view is for that');
    expect(
      refusal(() =>
        asAssistant({ type: 'providerInstance.delete', providerInstanceId: 'claude-work' }),
      ),
    ).toContain('Settings → Providers');
    expect(refusal(() => asAssistant({ type: 'skills.sync', skills: [] }))).toContain(
      'Only the wow server sends this',
    );
    expect(refusal(() => asAssistant({ type: 'project.delete', projectId: 'tea' }))).toContain(
      'cannot be undone',
    );
    expect(await list('read_projects')).toHaveLength(1);
  });
});

describe('a command the app refuses', () => {
  it("reaches the assistant with the app's reason (spec 12)", async () => {
    const made = await call('create_card', {
      title: 'Taste the new blend',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
    });
    const cardId = String(made.content['cardId']);
    const refusedWith = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result).toMatchObject({ isError: true, content: { outcome: 'refused' } });
      return result.content.reason;
    };
    // An end before the start.
    expect(await refusedWith('update_card', { cardId, end: '2026-11-11T11:00:00.000Z' })).toBe(
      'A card must end after it starts',
    );
    // An unknown step in a rule.
    expect(
      await refusedWith('update_workflow', {
        workflowId: 'delivery',
        steps: [
          step('s1', {
            rules: [{ when: { fact: 'stepFailed' }, goTo: { type: 'step', stepId: 'nowhere' } }],
          }),
          step('s2'),
        ],
      }),
    ).toContain('goes to a step that no longer exists');
    // A live run.
    asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'delivery', projectId: 'tea' });
    expect(await refusedWith('delete_workflow', { workflowId: 'delivery' })).toBe(
      'Workflow Delivery has a run in progress; stop it first',
    );
    // Something that is not there, for a change and for a proposal.
    expect(await refusedWith('update_backlog_item', { backlogItemId: 'nope', title: 'x' })).toBe(
      'No backlog item nope',
    );
    expect(await refusedWith('start_run', { workflowId: 'nope', projectId: 'tea' })).toBe(
      'No workflow nope',
    );
    // A folder that does not exist, which the app checks before the command.
    expect(
      await refusedWith('create_project', { name: 'Cups', cwd: path.join(root, 'cups') }),
    ).toBe(`No folder ${path.join(root, 'cups')}`);
    expect(
      await refusedWith('set_setting', {
        key: 'calendar.snapMinutes',
        scope: 'global',
        value: 'soon',
      }),
    ).toBe('Invalid value for calendar.snapMinutes');
    expect(proposals()).toEqual([]);
    expect(changes()).toHaveLength(1);
  });
});

describe('the class table', () => {
  it('names every server command type ordinary, proposal or refused, and fails when a new command has no class', () => {
    const types = [...Command.options, ...InternalCommand.options].map(
      (option) => option.shape.type.value,
    );
    expect(types.length).toBeGreaterThan(60);
    expect(Object.keys(commandClasses).toSorted()).toEqual(types.toSorted());
    // A command type the table does not know is refused rather than applied.
    expect(refusal(() => asAssistant({ type: 'kettle.boil' } as unknown as ServerCommand))).toBe(
      'kettle.boil is not something the assistant does.',
    );
  });

  it('gives every command a tool can send a class that is not always refused, and every internal command a refusal', () => {
    for (const tool of Object.values(changeTools)) {
      expect(typeof commandClasses[tool.type] === 'object').toBe(false);
    }
    for (const option of InternalCommand.options) {
      expect(commandClasses[option.shape.type.value]).toEqual({
        refused: 'Only the wow server sends this; it is not something to ask for.',
      });
    }
  });

  it("leaves the user's commands as they were: no origin means the user", () => {
    asUser({ type: 'setting.set', key: 'viewer.htmlScripts', scope: 'global', value: true });
    expect(setting('viewer.htmlScripts')).toBe(true);
    expect(changes()).toEqual([]);
    expect(proposals()).toEqual([]);
    // A retry of the same command id is still the stored receipt.
    const first = server.engine.dispatch('same', {
      type: 'setting.reset',
      key: 'viewer.htmlScripts',
      scope: 'global',
    });
    const again = server.engine.dispatch('same', {
      type: 'setting.reset',
      key: 'viewer.htmlScripts',
      scope: 'global',
    });
    expect(again).toEqual({ ...first, duplicate: true });
  });
});
