import type { ProviderAdapterContext, ProviderInstance } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { codexAdapterFactory, providerKind } from './index.js';
import type { CodexLaunch } from './process.js';
import { FakeCodexProcess, ManualTimers } from './testing.js';

const instance: ProviderInstance = {
  id: 'codex-work',
  kind: 'codex',
  name: 'Codex (work)',
  binaryPath: '/opt/codex/bin/codex',
  configDir: '/home/demo/.codex',
  env: { OPENAI_API_KEY: { secretRef: 'provider:codex-work:OPENAI_API_KEY' } },
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

describe('@wow/provider-codex', () => {
  it('is the codex provider', () => {
    expect(providerKind).toBe('codex');
  });

  it('takes the request timeout and the secret environment from the server context', async () => {
    let wrote: ((method: unknown) => void) | null = null;
    // Silent app-server that tells the test when the adapter wrote to it.
    class Silent extends FakeCodexProcess {
      protected override received(message: Record<string, unknown>): void {
        wrote?.(message['method']);
      }
    }
    const nextWrite = () => new Promise((resolve) => (wrote = resolve));
    const launches: CodexLaunch[] = [];
    const timers = new ManualTimers();
    let timeoutMs = 4321;
    const context: ProviderAdapterContext = {
      resolveEnv: () => Promise.resolve({ OPENAI_API_KEY: 'sk-resolved' }),
      testTimeoutMs: () => 120_000,
      requestTimeoutMs: () => timeoutMs,
    };
    const adapter = codexAdapterFactory({
      baseEnv: {},
      timers,
      spawn: (launch) => {
        launches.push(launch);
        return new Silent();
      },
    })(instance, context);
    expect(adapter.kind).toBe('codex');

    let writing = nextWrite();
    const listing = adapter.send({ type: 'listModels' });
    await expect(writing).resolves.toBe('initialize');
    expect(launches[0]?.env['OPENAI_API_KEY']).toBe('sk-resolved');
    timers.fireAll();
    await expect(listing).rejects.toMatchObject({
      code: 'timeout',
      message: 'codex did not answer "initialize" within 4321 ms',
    });

    // Read again for the next request, so a settings change applies without a restart.
    timeoutMs = 9876;
    writing = nextWrite();
    const retry = adapter.send({ type: 'listModels' });
    await writing;
    timers.fireAll();
    await expect(retry).rejects.toMatchObject({
      code: 'timeout',
      message: 'codex did not answer "initialize" within 9876 ms',
    });
    await adapter.dispose();
  });
});
