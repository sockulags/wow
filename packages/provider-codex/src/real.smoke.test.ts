import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvent, ProviderInstance } from '@wow/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, type CodexTestResult } from './adapter.js';
import { codexProtocolVersion } from './protocol/generated/index.js';

// Runs the installed codex for real. Off by default; turn it on with WOW_REAL_PROVIDERS=1.
// CODEX_BIN names the binary (default "codex"), WOW_CODEX_HOME its config directory (default
// codex's own), and the turn needs that home to be logged in.
const enabled = process.env['WOW_REAL_PROVIDERS'] === '1';
const timeoutMs = 180_000;

const instance: ProviderInstance = {
  id: 'codex-smoke',
  kind: 'codex',
  name: 'Codex smoke',
  binaryPath: process.env['CODEX_BIN'] ?? 'codex',
  configDir: process.env['WOW_CODEX_HOME'] ?? '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
};

describe.skipIf(!enabled)('codex app-server (real)', () => {
  let adapter: CodexAdapter | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    await adapter?.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'starts and speaks the protocol version this package was generated from',
    async () => {
      adapter = new CodexAdapter({ instance, requestTimeoutMs: () => 60_000 });
      await adapter.send({ type: 'listModels' }).catch(() => undefined);
      expect(adapter.serverVersion).toBe(codexProtocolVersion);
    },
    timeoutMs,
  );

  it(
    'passes Test and streams a trivial turn to completion',
    async () => {
      const codex = new CodexAdapter({ instance, requestTimeoutMs: () => 60_000 });
      adapter = codex;
      const result = (await codex.send({ type: 'test' })) as CodexTestResult;
      const model = result.models.find((entry) => entry.isDefault) ?? result.models[0];
      if (!model) throw new Error('codex listed no models');

      const cwd = mkdtempSync(join(tmpdir(), 'wow-codex-smoke-'));
      dirs.push(cwd);
      const events: ProviderEvent[] = [];
      const ended = new Promise<ProviderEvent>((resolve) => {
        codex.onEvent((event) => {
          events.push(event);
          if (['turnCompleted', 'turnFailed', 'turnInterrupted'].includes(event.type))
            resolve(event);
        });
      });
      await codex.send({
        type: 'startTurn',
        threadId: 'smoke',
        cwd,
        prompt: 'Reply with the single word: ok',
        model: model.id,
        effort: model.defaultEffort,
        permissionMode: 'read-only',
      });
      expect(await ended).toEqual({ type: 'turnCompleted', threadId: 'smoke' });
      expect(events.some((event) => event.type === 'textDelta')).toBe(true);
      expect(events.some((event) => event.type === 'usage')).toBe(true);
    },
    timeoutMs,
  );
});
