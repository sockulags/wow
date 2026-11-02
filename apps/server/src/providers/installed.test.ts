import { ProviderKind, type ProviderInstance } from '@wow/contracts';
import { ClaudeAdapter } from '@wow/provider-claude';
import { CodexAdapter } from '@wow/provider-codex';
import { describe, expect, it } from 'vitest';
import { ProviderAdapters } from '../hooks/index.js';
import { installedProviders } from './installed.js';

const instance = (kind: ProviderKind): ProviderInstance => ({
  id: `${kind}-1`,
  kind,
  name: kind,
  binaryPath: kind,
  configDir: `/home/demo/.${kind}`,
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
});

const context = {
  resolveEnv: () => Promise.resolve({}),
  testTimeoutMs: () => 120_000,
  requestTimeoutMs: () => 60_000,
};

describe('installed providers', () => {
  it('registers an adapter for every provider kind, Codex included', () => {
    expect(Object.keys(installedProviders).toSorted()).toEqual(ProviderKind.options.toSorted());
    const adapters = new ProviderAdapters(installedProviders, {});
    // Adapters start their CLI on the first command, so creating them spawns nothing.
    expect(adapters.create(instance('claude'), context)).toBeInstanceOf(ClaudeAdapter);
    const codex = adapters.create(instance('codex'), context);
    expect(codex).toBeInstanceOf(CodexAdapter);
    expect(codex.kind).toBe('codex');
  });
});
