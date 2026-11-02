import { SecretRef, settingsRegistry, type SettingDefinition } from '@wow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Engine } from '../core/engine.js';
import { openDatabase, type Database } from '../db/database.js';
import { providerInstances } from '../db/schema.js';
import { SettingsService } from './service.js';

const registry = {
  ...settingsRegistry,
  'providers.model': {
    schema: z.string().min(1),
    group: 'providers',
    label: 'Model',
    description: 'Test setting stored per provider instance.',
    default: 'default-model',
    scope: 'provider',
  },
  'trackers.token': {
    schema: SecretRef,
    group: 'trackers',
    label: 'Token',
    description: 'Test secret setting.',
    default: { secretRef: 'tracker' },
    scope: 'global',
    secret: true,
  },
} satisfies Record<string, SettingDefinition>;

let database: Database;
let engine: Engine;
let settings: SettingsService;
let next = 0;
const dispatch = (command: Parameters<Engine['dispatch']>[1]) =>
  engine.dispatch(`c${(next += 1)}`, command);

beforeEach(() => {
  database = openDatabase(':memory:');
  engine = new Engine(database.db, { registry });
  settings = new SettingsService(database.db, engine, registry);
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: '/w' });
  database.db
    .insert(providerInstances)
    .values({
      id: 'claude-work',
      kind: 'claude',
      name: 'Work',
      binaryPath: 'claude',
      configDir: '/c',
      env: {},
      launchArgs: [],
      status: 'unknown',
    })
    .run();
});

afterEach(() => database.close());

describe('SettingsService', () => {
  it('falls back to the registry default', () => {
    expect(settings.resolve('scheduler.tickSeconds')).toEqual({
      key: 'scheduler.tickSeconds',
      value: 30,
      source: 'default',
    });
  });

  it('resolves provider over project over global', () => {
    const at = { projectId: 'p1', providerInstanceId: 'claude-work' };
    dispatch({ type: 'setting.set', key: 'providers.model', scope: 'global', value: 'g' });
    expect(settings.resolve('providers.model', at).value).toBe('g');
    dispatch({ type: 'setting.set', key: 'providers.model', scope: 'project:p1', value: 'p' });
    expect(settings.resolve('providers.model', at)).toMatchObject({
      value: 'p',
      source: 'project:p1',
    });
    dispatch({
      type: 'setting.set',
      key: 'providers.model',
      scope: 'provider:claude-work',
      value: 'v',
    });
    expect(settings.resolve('providers.model', at).source).toBe('provider:claude-work');
    expect(settings.resolve('providers.model', { projectId: 'p1' }).value).toBe('p');
    dispatch({ type: 'setting.reset', key: 'providers.model', scope: 'provider:claude-work' });
    expect(settings.resolve('providers.model', at).value).toBe('p');
  });

  it('takes effect on the next read and tells listeners', () => {
    const changes: string[] = [];
    settings.onChange((key, scope) => changes.push(`${scope} ${key}`));
    dispatch({ type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 60 });
    expect(settings.get('scheduler.tickSeconds')).toBe(60);
    expect(changes).toEqual(['global scheduler.tickSeconds']);
    dispatch({ type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 60 });
    expect(changes).toHaveLength(1);
  });

  it('rejects values that fail the schema, unknown keys and scopes the setting does not allow', () => {
    expect(() =>
      dispatch({ type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 0 }),
    ).toThrow(/Invalid value/);
    expect(() =>
      dispatch({ type: 'setting.set', key: 'nope.key', scope: 'global', value: 1 }),
    ).toThrow(/Unknown setting/);
    expect(() =>
      dispatch({
        type: 'setting.set',
        key: 'scheduler.tickSeconds',
        scope: 'project:p1',
        value: 60,
      }),
    ).toThrow(/only be set at global scope/);
    expect(() =>
      dispatch({ type: 'setting.set', key: 'providers.model', scope: 'project:nope', value: 'x' }),
    ).toThrow(/No project nope/);
    expect(() =>
      dispatch({ type: 'setting.set', key: 'providers.model', scope: 'provider:nope', value: 'x' }),
    ).toThrow(/No provider instance nope/);
  });

  it('stores only a reference for secret settings', () => {
    expect(() =>
      dispatch({ type: 'setting.set', key: 'trackers.token', scope: 'global', value: 'plain' }),
    ).toThrow(/Invalid value/);
    dispatch({
      type: 'setting.set',
      key: 'trackers.token',
      scope: 'global',
      value: { secretRef: 'jira' },
    });
    expect(settings.resolve('trackers.token').value).toEqual({ secretRef: 'jira' });
  });

  it('drops project overrides with the project', () => {
    dispatch({ type: 'setting.set', key: 'providers.model', scope: 'project:p1', value: 'p' });
    dispatch({ type: 'project.delete', projectId: 'p1' });
    expect(settings.resolve('providers.model', { projectId: 'p1' }).source).toBe('default');
  });

  it('resolves every registry key', () => {
    expect(settings.resolveAll().map((setting) => setting.key)).toEqual(
      Object.keys(registry).toSorted(),
    );
  });
});
