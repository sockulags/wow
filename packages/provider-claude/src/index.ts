import type { ProviderKind } from '@wow/contracts';

export const providerKind: ProviderKind = 'claude';

export { ClaudeAdapter, createClaudeAdapter, type ClaudeAdapterOptions } from './adapter.js';
export { decodeClaudeProjectName, discoverClaudeFolders } from './discover.js';
export { AsyncQueue } from './queue.js';
export { extraArgs, type ClaudeQuery, type QueryFunction } from './sdk.js';
