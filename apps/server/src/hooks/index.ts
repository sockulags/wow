import type { DispatchResult, ProviderKind, ServerCommand } from '@wow/contracts';
import type { Logger } from '../logger.js';
import type { OutlookService } from '../outlook/service.js';
import type { SettingsService } from '../settings/service.js';
import type { OutlookMode } from './outlook.js';
import type { ProviderAdapterFactory } from './providers.js';

export { outlookMode, type OutlookMode } from './outlook.js';
export {
  MockProviderAdapter,
  ProviderAdapters,
  mockCodexModels,
  prefersMockProviders,
  type MockScript,
  type ProviderAdapterFactory,
} from './providers.js';

// What a background service gets from the server: it reads settings and changes state only by
// dispatching commands, like any client.
export interface ServiceContext {
  readonly home: string;
  readonly settings: SettingsService;
  readonly logger: Logger;
  dispatch(commandId: string, command: ServerCommand): DispatchResult;
}

// A long-running part of the server (Outlook polling, the scheduler, skill watching) started
// after the store is ready and stopped before it closes.
export interface BackgroundService {
  stop(): Promise<void>;
}

export interface ServerHooks {
  // Provider units register their adapter factory here.
  readonly providers?: Partial<Record<ProviderKind, ProviderAdapterFactory>>;
  // Starts the Outlook service (`startOutlookService`); `mode` says whether to use the mock or the
  // bridge. Without it the calendar shows local cards only and `outlook.*` methods fail.
  readonly outlook?: (mode: OutlookMode, context: ServiceContext) => Promise<OutlookService>;
  // Further services (scheduler, skills watcher) started in order.
  readonly services?: ReadonlyArray<(context: ServiceContext) => Promise<BackgroundService>>;
}
