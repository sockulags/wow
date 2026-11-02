import type { ProviderAdapterContext, ProviderInstance, ProviderKind } from '@wow/contracts';
import { CodexAdapter, type CodexAdapterOptions } from './adapter.js';

export const providerKind: ProviderKind = 'codex';

export {
  CodexAdapter,
  codexVersionFromUserAgent,
  createCodexAdapter,
  type CodexAdapterOptions,
  type CodexModel,
  type CodexTestResult,
} from './adapter.js';
export { CodexConnection, CodexError, systemTimers, type Timers } from './connection.js';
export { codexPermissionModes, type CodexPermissionMode } from './permissions.js';
export {
  spawnCodexAppServer,
  type CodexLaunch,
  type CodexProcess,
  type SpawnCodex,
} from './process.js';
export { codexProtocolVersion } from './protocol/generated/index.js';

// What the server registers under hooks.providers.codex. The request timeout and the secret
// environment come from the server's context; options replace them only in tests.
export const codexAdapterFactory =
  (options: Partial<Omit<CodexAdapterOptions, 'instance'>> = {}) =>
  (instance: ProviderInstance, context: ProviderAdapterContext): CodexAdapter =>
    new CodexAdapter({
      requestTimeoutMs: () => context.requestTimeoutMs(),
      resolveEnv: () => context.resolveEnv(),
      ...options,
      instance,
    });
