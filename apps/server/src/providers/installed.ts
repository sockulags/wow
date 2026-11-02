import type { ProviderKind } from '@wow/contracts';
import { createClaudeAdapter } from '@wow/provider-claude';
import { codexAdapterFactory } from '@wow/provider-codex';
import type { ProviderAdapterFactory } from '../hooks/index.js';

// The adapters `main.ts` registers, and so the ones the desktop app's server bundle ships.
export const installedProviders = {
  claude: createClaudeAdapter,
  codex: codexAdapterFactory(),
} as const satisfies Record<ProviderKind, ProviderAdapterFactory>;
