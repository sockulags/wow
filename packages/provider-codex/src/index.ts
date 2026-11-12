import type { ProviderAdapterContext, ProviderInstance, ProviderKind } from '@wow/contracts';
import { CodexAdapter, type CodexAdapterOptions, type CodexVersionVerdict } from './adapter.js';
import { CompatibilityCache } from './compat/check.js';

export const providerKind: ProviderKind = 'codex';

export {
  CodexAdapter,
  codexVersionFromUserAgent,
  createCodexAdapter,
  type CodexAdapterOptions,
  type CodexModel,
  type CodexTestResult,
  type CodexVersionVerdict,
} from './adapter.js';
export {
  CompatibilityCache,
  checkInstalledCodex,
  generateJsonSchema,
  type GenerateSchema,
  type InstalledCheck,
} from './compat/check.js';
export {
  compareWithInstalled,
  type CompatibilityReport,
  type ProtocolFingerprint,
} from './compat/schema.js';
export { compareCodexVersions, parseCodexVersion } from './compat/version.js';
export { discoverCodexFolders } from './discover.js';
export { listCodexSessions, type SessionListOptions } from './sessions.js';
export {
  codexNpmPackage,
  codexUpdateOffer,
  detectCodexInstall,
  type CodexInstall,
  type InstallIo,
} from './install.js';
export { CodexConnection, CodexError, systemTimers, type Timers } from './connection.js';
export { codexPermissionModes, type CodexPermissionMode } from './permissions.js';
export {
  runCommand,
  spawnCodexAppServer,
  type CodexLaunch,
  type CodexProcess,
  type CommandRun,
  type RunCommand,
  type SpawnCodex,
} from './process.js';
export { codexProtocolFingerprint } from './protocol/generated/fingerprint.js';
export { codexProtocolVersion } from './protocol/generated/index.js';

// What the server registers under hooks.providers.codex. The timeouts and the secret environment
// come from the server's context; options replace them only in tests. All adapters of one factory
// share the version check cache, so a new adapter for the same binary and version (after an
// instance edit) does not check again.
export const codexAdapterFactory = (
  options: Partial<Omit<CodexAdapterOptions, 'instance'>> = {},
) => {
  const compatibility = new CompatibilityCache<CodexVersionVerdict>();
  return (instance: ProviderInstance, context: ProviderAdapterContext): CodexAdapter =>
    new CodexAdapter({
      requestTimeoutMs: () => context.requestTimeoutMs(),
      testTimeoutMs: () => context.testTimeoutMs(),
      resolveEnv: () => context.resolveEnv(),
      compatibility,
      ...options,
      instance,
    });
};
