import type { Command, ProviderInstance } from '@wow/contracts';
import { SecretStore, plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';
import { MockProviderAdapter, ProviderAdapters } from '../hooks/providers.js';
import { createLogger } from '../logger.js';
import { SettingsService } from '../settings/service.js';
import { ProviderService } from './service.js';

// Settings → Providers edits and removes instances (spec 31, 32).

let dir: string;
let database: Database;
let engine: Engine;
let secrets: SecretStore;
let service: ProviderService;
let created: ProviderInstance[];
let next = 0;

const dispatch = (command: Command) => engine.dispatch(`c${(next += 1)}`, command);
const instances = () => snapshot(database.db, { topic: 'providerInstances' }) as ProviderInstance[];
// Secret deletes run after commit on the store's own queue; a later queued write waits for them.
const secretNames = async () => {
  await secrets.delete('flush');
  return secrets.names();
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-instances-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db);
  const settings = new SettingsService(database.db, engine);
  secrets = new SecretStore({ dir, protector: plainProtector });
  created = [];
  const adapters = new ProviderAdapters(
    {
      claude: (instance) => {
        created.push(instance);
        return new MockProviderAdapter('claude', () => []);
      },
    },
    {},
  );
  service = new ProviderService({
    db: database.db,
    engine,
    adapters,
    settings,
    secrets,
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
  });
  const key = await secrets.set('provider:work:env:ANTHROPIC_API_KEY', 'sk-old');
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'work',
    kind: 'claude',
    name: 'Work',
    binaryPath: '/usr/local/bin/claude',
    configDir: '/home/me/.claude-work',
    env: { ANTHROPIC_API_KEY: key, PLAIN: 'yes' },
    launchArgs: [],
  });
});

afterEach(async () => {
  await service.stop();
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('provider instances', () => {
  it('renames without forgetting the last test', async () => {
    await service.test('work');
    expect(instances()[0]).toMatchObject({ status: 'ready', account: 'mock' });

    dispatch({ type: 'providerInstance.update', providerInstanceId: 'work', name: 'Work account' });
    expect(instances()[0]).toMatchObject({ name: 'Work account', status: 'ready' });

    // The same values again change nothing.
    expect(
      dispatch({
        type: 'providerInstance.update',
        providerInstanceId: 'work',
        name: 'Work account',
      }).seqs,
    ).toEqual([]);
  });

  it('clears the test result and restarts the adapter when the launch changes', async () => {
    await service.test('work');
    expect(created).toHaveLength(1);

    dispatch({
      type: 'providerInstance.update',
      providerInstanceId: 'work',
      configDir: '/home/me/.claude-other',
      launchArgs: ['--verbose'],
      defaultModel: 'sonnet',
    });
    expect(instances()[0]).toMatchObject({
      configDir: '/home/me/.claude-other',
      launchArgs: ['--verbose'],
      defaultModel: 'sonnet',
      status: 'unknown',
      account: null,
      version: null,
    });

    await service.test('work');
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ configDir: '/home/me/.claude-other' });
  });

  it('deletes a secret the environment no longer references', async () => {
    dispatch({
      type: 'providerInstance.update',
      providerInstanceId: 'work',
      env: { PLAIN: 'yes' },
    });
    expect(instances()[0]?.env).toEqual({ PLAIN: 'yes' });
    expect(await secretNames()).toEqual([]);
  });

  it('removes an instance with its provider settings, project defaults and secrets', async () => {
    dispatch({
      type: 'project.create',
      projectId: 'demo',
      name: 'Demo',
      cwd: '/work/demo',
      defaultProviderInstanceId: 'work',
    });
    dispatch({
      type: 'setting.set',
      key: 'providers.testTimeoutMs',
      scope: 'provider:work',
      value: 30_000,
    });

    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'work' });
    expect(instances()).toEqual([]);
    expect(snapshot(database.db, { topic: 'settings' })).toEqual([]);
    expect(snapshot(database.db, { topic: 'projects' })).toMatchObject([
      { id: 'demo', defaultProviderInstanceId: null },
    ]);
    expect(await secretNames()).toEqual([]);
  });

  it('keeps an instance that threads resume on, and one with a running turn', () => {
    dispatch({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'work',
      cwd: '/work/demo',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(() => dispatch({ type: 'providerInstance.delete', providerInstanceId: 'work' })).toThrow(
      /used by 1 thread/,
    );

    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });
    expect(() =>
      dispatch({ type: 'providerInstance.update', providerInstanceId: 'work', configDir: '/x' }),
    ).toThrow(/turn running/);
    expect(instances()[0]?.configDir).toBe('/home/me/.claude-work');
  });

  it('changes and removes an instance while another one runs a turn', () => {
    dispatch({
      type: 'providerInstance.create',
      providerInstanceId: 'other',
      kind: 'claude',
      name: 'Other',
      binaryPath: '',
      configDir: '',
      env: {},
      launchArgs: [],
    });
    dispatch({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'work',
      cwd: '/work/demo',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });

    dispatch({ type: 'providerInstance.update', providerInstanceId: 'other', configDir: '/x' });
    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'other' });
    expect(instances().map((instance) => instance.id)).toEqual(['work']);
  });

  it('refuses an unknown instance', () => {
    expect(() =>
      dispatch({ type: 'providerInstance.update', providerInstanceId: 'nope', name: 'X' }),
    ).toThrow(/No provider instance nope/);
  });
});
