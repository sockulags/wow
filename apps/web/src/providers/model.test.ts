import type { ProviderInstance } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  draftFromInstance,
  draftIssues,
  draftToCommand,
  emptyDraft,
  parseLaunchArgs,
  type InstanceDraft,
} from './model';

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: '/usr/local/bin/claude',
  configDir: '/home/me/.claude-work',
  env: { ANTHROPIC_API_KEY: { secretRef: 'provider:claude-work:env:ANTHROPIC_API_KEY' }, A: 'b' },
  launchArgs: ['--verbose'],
  defaultModel: 'sonnet',
  defaultEffort: null,
  defaultPermissionMode: 'default',
  status: 'ready',
  account: 'me@example.com',
  version: '2.1.316',
  statusMessage: null,
};

describe('provider instance drafts', () => {
  it('names a new instance after its provider, numbered when taken', () => {
    expect(emptyDraft('codex', []).name).toBe('Codex');
    expect(emptyDraft('claude', ['Claude', 'Claude 2']).name).toBe('Claude 3');
  });

  it('keeps one launch argument per line', () => {
    expect(parseLaunchArgs('--flag value\n\n  --other=a b  \r\n')).toEqual([
      '--flag value',
      '--other=a b',
    ]);
  });

  it('reports what blocks saving', () => {
    const draft: InstanceDraft = {
      ...emptyDraft('claude', []),
      name: ' ',
      env: [
        { key: 'TOKEN', value: '', secret: true, stored: undefined },
        { key: 'TOKEN', value: 'x', secret: false, stored: undefined },
        { key: '', value: 'y', secret: false, stored: undefined },
      ],
    };
    expect(draftIssues(draft)).toEqual([
      'Give the instance a name.',
      'Every environment variable needs a name.',
      'Environment variable names must be unique.',
      'Enter a value for the secret TOKEN.',
    ]);
  });

  it('stores new secret values and keeps untouched ones by reference', async () => {
    const stored: [string, string][] = [];
    const draft = draftFromInstance(instance);
    expect(draft.env[0]).toMatchObject({ value: '', secret: true });
    const command = await draftToCommand(
      {
        ...draft,
        env: [
          ...draft.env,
          { key: 'OPENAI_KEY', value: 'sk-new', secret: true, stored: undefined },
        ],
        defaultModel: '',
      },
      instance.id,
      instance,
      (name, value) => {
        stored.push([name, value]);
        return Promise.resolve({ secretRef: name });
      },
    );
    expect(stored).toEqual([['provider:claude-work:env:OPENAI_KEY', 'sk-new']]);
    expect(command).toEqual({
      type: 'providerInstance.update',
      providerInstanceId: 'claude-work',
      name: 'Work',
      binaryPath: '/usr/local/bin/claude',
      configDir: '/home/me/.claude-work',
      env: {
        ANTHROPIC_API_KEY: { secretRef: 'provider:claude-work:env:ANTHROPIC_API_KEY' },
        A: 'b',
        OPENAI_KEY: { secretRef: 'provider:claude-work:env:OPENAI_KEY' },
      },
      launchArgs: ['--verbose'],
      defaultModel: null,
      defaultEffort: null,
      defaultPermissionMode: 'default',
    });
  });

  it('creates a new instance with its kind', async () => {
    const command = await draftToCommand(
      { ...emptyDraft('codex', []), binaryPath: ' /bin/codex ' },
      'codex-1',
      undefined,
      () => Promise.reject(new Error('no secrets here')),
    );
    expect(command).toMatchObject({
      type: 'providerInstance.create',
      providerInstanceId: 'codex-1',
      kind: 'codex',
      name: 'Codex',
      binaryPath: '/bin/codex',
      env: {},
      launchArgs: [],
    });
  });
});
