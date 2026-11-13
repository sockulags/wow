import { assistantThreadId, type ServerCommand, type ThreadTools } from '@wow/contracts';
import { SecretStore, plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';
import {
  MockProviderAdapter,
  ProviderAdapters,
  mockClaudeSessionTools,
} from '../hooks/providers.js';
import { createLogger } from '../logger.js';
import { SettingsService } from '../settings/service.js';
import { ProviderService } from './service.js';

// What the session can use (thread work spec 37 to 43, U5): reported at a turn's start, stored
// only when it changed, asked again only of a live session, never for the assistant.

let dir: string;
let database: Database;
let engine: Engine;
let settings: SettingsService;
let secrets: SecretStore;
let adapter: MockProviderAdapter;
let service: ProviderService;
let next = 0;
let tick = 0;

const clock = () => new Date(Date.UTC(2026, 10, 12, 20, 41, (tick += 1)));
const dispatch = (command: ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);

const makeService = () =>
  new ProviderService({
    db: database.db,
    engine,
    adapters: new ProviderAdapters({ claude: () => adapter }, {}),
    settings,
    secrets,
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
  });

const stored = (threadId = 't1') =>
  snapshot(database.db, { topic: 'threadTools', threadId }) as ThreadTools[];

// How many lists were stored for the thread, by the event log.
const reports = () =>
  (
    database.sqlite
      .prepare("SELECT count(*) AS n FROM events WHERE kind = 'thread.toolsReported'")
      .get() as { n: number }
  ).n;

const described = () => adapter.sent.filter((command) => command.type === 'describeSession');

// Resolves once a turn of the thread has ended.
const turnEnded = () =>
  new Promise<void>((resolve) => {
    const off = engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === 'turn.ended')) {
        off();
        resolve();
      }
    });
  });

const sendTurn = async (text: string) => {
  const ended = turnEnded();
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text });
  await ended;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-tools-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock, home: dir });
  settings = new SettingsService(database.db, engine);
  secrets = new SecretStore({ dir, protector: plainProtector });
  adapter = new MockProviderAdapter('claude');
  service = makeService();
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude',
    kind: 'claude',
    name: 'Claude Code',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
  });
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'claude',
    cwd: '/work/tea',
    model: 'mock-model',
    effort: 'high',
    permissionMode: 'default',
  });
});

afterEach(async () => {
  await service.stop();
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('session tools', () => {
  it('stores what the session reported as its turn started, with the server time', async () => {
    expect(stored()).toEqual([]);
    await sendTurn('Brew the tea');
    const [row] = stored();
    expect(row).toMatchObject({ threadId: 't1', source: 'turn', live: true });
    expect(row?.tools.reportedAt).toMatch(/^2026-11-12T20:41:/);
    expect(row?.tools.mcpServers.map((server) => [server.name, server.state])).toEqual([
      ['tea-docs', 'connected'],
      ['tea-tracker', 'failed'],
      ['tea-cloud', 'needsAuth'],
    ]);
    expect(row?.tools.mcpServers[1]?.error).toBe('spawn tea-tracker ENOENT');
  });

  it('stores a report only when the list changed', async () => {
    await sendTurn('Brew the tea');
    expect(reports()).toBe(1);
    await sendTurn('Brew it again');
    expect(reports()).toBe(1);
    adapter.sessionTools = () => ({ ...mockClaudeSessionTools(), skills: [] });
    await sendTurn('And once more');
    expect(reports()).toBe(2);
    expect(stored()[0]?.tools.skills).toEqual([]);
  });

  it('asks the live session again on Refresh and stores only a changed list', async () => {
    await sendTurn('Brew the tea');
    await expect(service.refreshTools('t1')).resolves.toBe('unchanged');
    expect(described()).toEqual([{ type: 'describeSession', threadId: 't1' }]);
    expect(reports()).toBe(1);

    adapter.sessionTools = () => ({ ...mockClaudeSessionTools(), agents: [] });
    await expect(service.refreshTools('t1')).resolves.toBe('changed');
    expect(stored()[0]).toMatchObject({ source: 'refresh', live: true });
    expect(stored()[0]?.tools.agents).toEqual([]);
    expect(reports()).toBe(2);
  });

  it('asks nothing without a live session', async () => {
    await expect(service.refreshTools('t1')).resolves.toBe('noSession');
    expect(adapter.sent).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('keeps the list over a restart without a live session, and asks nothing for it', async () => {
    await sendTurn('Brew the tea');
    await service.stop();
    adapter = new MockProviderAdapter('claude');
    service = makeService();
    service.recover();
    expect(stored()[0]).toMatchObject({ live: false });
    expect(stored()[0]?.tools.mcpServers).toHaveLength(3);
    await expect(service.refreshTools('t1')).resolves.toBe('noSession');
    expect(adapter.sent).toEqual([]);
  });

  it('marks the list not live when the session the adapter held is gone', async () => {
    await sendTurn('Brew the tea');
    adapter.sessionTools = null;
    await expect(service.refreshTools('t1')).resolves.toBe('noSession');
    expect(stored()[0]).toMatchObject({ live: false });
    expect(described()).toHaveLength(1);
    await expect(service.refreshTools('t1')).resolves.toBe('noSession');
    expect(described()).toHaveLength(1);
  });

  it('stores no configuration, environment, header or argument an adapter let through', async () => {
    await sendTurn('Brew the tea');
    const leaky = {
      ...mockClaudeSessionTools(),
      skills: [],
      mcpServers: mockClaudeSessionTools().mcpServers.map((server) => ({
        ...server,
        error: 'spawn npx -y @tea/server --api-key=sk-tea-0123456789abcdefghij ENOENT',
        config: { url: 'https://docs.tea.example/v1?key=sk-secret', headers: { A: 'Bearer x' } },
        env: { TOKEN: 'sk-secret' },
        args: ['--token=sk-secret'],
      })),
    };
    const kept = new Promise<void>((resolve) => {
      const off = engine.onCommit((commit) => {
        if (commit.events.some(({ event }) => event.kind === 'thread.toolsReported')) {
          off();
          resolve();
        }
      });
    });
    adapter.emit([{ type: 'sessionTools', threadId: 't1', tools: leaky }]);
    await kept;
    const raw = database.sqlite.prepare('SELECT tools FROM thread_tools').all();
    const history = database.sqlite
      .prepare("SELECT payload FROM events WHERE kind = 'thread.toolsReported'")
      .all();
    for (const text of [JSON.stringify(raw), JSON.stringify(history)]) {
      expect(text).not.toContain('sk-secret');
      expect(text).not.toContain('Bearer');
      expect(text).not.toContain('sk-tea-0123456789abcdefghij');
    }
  });

  it('runs the secret net over every free text of a report, not only failures', async () => {
    await sendTurn('Brew the tea');
    const key = 'sk-tea-0123456789abcdefghij';
    const base = mockClaudeSessionTools();
    const leaky = {
      ...base,
      mcpServers: base.mcpServers.map((server) => ({
        ...server,
        stateWord: `failed ${key}`,
        version: `1.0 ${key}`,
        source: `user ${key}`,
        tools: server.tools.map((tool) => ({ ...tool, description: `Uses ${key}` })),
      })),
      skills: [{ name: 'brew-guide', description: `Brews with ${key}` }],
      commands: [{ name: 'steep', description: `Steeps ${key}`, argumentHint: `<${key}>` }],
      agents: [{ name: 'Explore', description: `Explores ${key}`, model: `haiku ${key}` }],
      plugins: [{ name: 'tea-kit', version: `0.1 ${key}`, loaded: true, errors: [] }],
      instructionFiles: [`/work/tea/${key}/AGENTS.md`],
    };
    const kept = new Promise<void>((resolve) => {
      const off = engine.onCommit((commit) => {
        if (commit.events.some(({ event }) => event.kind === 'thread.toolsReported')) {
          off();
          resolve();
        }
      });
    });
    adapter.emit([{ type: 'sessionTools', threadId: 't1', tools: leaky }]);
    await kept;
    const raw = JSON.stringify(database.sqlite.prepare('SELECT tools FROM thread_tools').all());
    expect(raw).not.toContain(key);
    expect(stored()[0]?.tools.skills).toEqual([
      { name: 'brew-guide', description: 'Brews with [hidden]' },
    ]);
  });

  it('refuses the assistant', () => {
    dispatch({
      type: 'setting.set',
      key: 'assistant.providerInstanceId',
      scope: 'global',
      value: 'claude',
    });
    dispatch({
      type: 'providerInstance.recordTest',
      providerInstanceId: 'claude',
      result: { ok: true, account: 'mock', version: 'mock', message: null },
    });
    dispatch({ type: 'thread.openAssistant', fallbackModel: 'mock-model', fallbackEffort: 'low' });
    expect(() =>
      dispatch({
        type: 'thread.toolsReported',
        threadId: assistantThreadId,
        tools: mockClaudeSessionTools(),
        source: 'turn',
      }),
    ).toThrow('The assistant has no Tools tab');
    return expect(service.refreshTools(assistantThreadId)).rejects.toThrow(
      'The assistant has no Tools tab',
    );
  });
});
