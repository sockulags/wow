import type { ProviderEvent, ProviderInstance } from '@wow/contracts';
import { ProviderModel, ProviderTestResult } from '@wow/contracts';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';

// Runs against the installed `claude` with the user's own login. Opt in with WOW_REAL_PROVIDERS=1;
// WOW_CLAUDE_BINARY overrides the binary found on PATH and WOW_CLAUDE_CONFIG_DIR the config dir.
const real = process.env['WOW_REAL_PROVIDERS'] === '1';

function findOnPath(name: string): string {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (dir && existsSync(file)) return file;
    }
  }
  throw new Error(`${name} is not on PATH; set WOW_CLAUDE_BINARY`);
}

const instance = (): ProviderInstance => ({
  id: 'claude-smoke',
  kind: 'claude',
  name: 'Smoke',
  binaryPath: process.env['WOW_CLAUDE_BINARY'] ?? findOnPath('claude'),
  configDir: process.env['WOW_CLAUDE_CONFIG_DIR'] ?? '',
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

describe.runIf(real)('Claude adapter against the installed claude', () => {
  const adapter = () =>
    new ClaudeAdapter(instance(), {
      resolveEnv: () => Promise.resolve({}),
      testTimeoutMs: () => 120_000,
    });

  it('passes the test action with a version', { timeout: 180_000 }, async () => {
    const claude = adapter();
    const result = ProviderTestResult.parse(await claude.send({ type: 'test' }));
    await claude.dispose();
    expect(result).toMatchObject({ ok: true, message: null });
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists models through supportedModels()', { timeout: 60_000 }, async () => {
    const claude = adapter();
    const models = ProviderModel.array().parse(await claude.send({ type: 'listModels' }));
    await claude.dispose();
    expect(models.length).toBeGreaterThan(0);
  });

  it('runs one turn with streamed text and usage', { timeout: 180_000 }, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'wow-claude-smoke-'));
    const claude = adapter();
    const events: ProviderEvent[] = [];
    const ended = new Promise<ProviderEvent>((resolve) =>
      claude.onEvent((event) => {
        events.push(event);
        if (event.type === 'turnCompleted' || event.type === 'turnFailed') resolve(event);
      }),
    );
    try {
      await claude.send({
        type: 'startTurn',
        threadId: 'smoke',
        cwd,
        prompt: 'Reply with the single word OK and nothing else.',
        model: 'haiku',
        effort: 'default',
        permissionMode: 'default',
      });
      expect(await ended).toEqual({ type: 'turnCompleted', threadId: 'smoke' });
      const text = events.flatMap((event) => (event.type === 'textDelta' ? [event.delta] : []));
      expect(text.join('')).toMatch(/OK/i);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['session', 'textDelta', 'usage', 'turnCompleted']),
      );
    } finally {
      await claude.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
