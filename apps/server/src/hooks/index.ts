import type { Command, DispatchResult, ProviderKind } from '@wow/contracts';
import type { SettingsService } from '../settings/service.js';
import type { OutlookMode } from './outlook.js';
import type { ProviderAdapterFactory } from './providers.js';

export { outlookMode, type OutlookMode } from './outlook.js';
export {
  MockProviderAdapter,
  ProviderAdapters,
  prefersMockProviders,
  type MockScript,
  type ProviderAdapterFactory,
} from './providers.js';

// What a background service gets from the server: it reads settings and changes state only by
// dispatching commands, like any client.
export interface ServiceContext {
  readonly home: string;
  readonly settings: SettingsService;
  dispatch(commandId: string, command: Command): DispatchResult;
}

// A long-running part of the server (Outlook polling, the scheduler, skill watching) started
// after the store is ready and stopped before it closes.
export interface BackgroundService {
  stop(): Promise<void>;
}

export interface ServerHooks {
  // Provider units register their adapter factory here.
  readonly providers?: Partial<Record<ProviderKind, ProviderAdapterFactory>>;
  // The Outlook unit plugs in its source; `mode` says whether to use the mock or the bridge.
  readonly outlook?: (mode: OutlookMode, context: ServiceContext) => Promise<BackgroundService>;
  // Further services (scheduler, skills watcher) started in order.
  readonly services?: ReadonlyArray<(context: ServiceContext) => Promise<BackgroundService>>;
}
