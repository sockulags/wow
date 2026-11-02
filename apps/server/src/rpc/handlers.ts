import type { DetectedProvider } from '@wow/contracts';
import { OutlookError } from '@wow/outlook-bridge';
import type { SecretStore } from '@wow/secrets';
import type { Engine } from '../core/engine.js';
import type { Push, Subscriptions } from '../core/subscriptions.js';
import type { OutlookService } from '../outlook/service.js';
import type { ProviderService } from '../providers/service.js';
import type { SettingsService } from '../settings/service.js';
import { RpcFault, type Handlers } from './router.js';

// One per WebSocket. Subscriptions it opened end with it.
export interface Connection {
  readonly push: Push;
  readonly subscriptionIds: Set<string>;
}

export interface HandlerDeps {
  readonly engine: Engine;
  readonly subscriptions: Subscriptions;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly providers: ProviderService;
  readonly detectProviders: () => Promise<DetectedProvider[]>;
  // Undefined until the Outlook service has started, or when the server runs without one.
  readonly outlook: () => OutlookService | undefined;
  readonly info: { readonly version: string; readonly home: string };
}

function requireOutlook(deps: HandlerDeps): OutlookService {
  const outlook = deps.outlook();
  if (!outlook) throw new RpcFault('not_found', 'Outlook is not set up on this server');
  return outlook;
}

export function createHandlers(deps: HandlerDeps): Handlers<Connection> {
  return {
    'server.info': () => ({ version: deps.info.version, home: deps.info.home, pid: process.pid }),
    dispatch: ({ commandId, command }) => deps.engine.dispatch(commandId, command),
    subscribe: (params, connection) => {
      const opened = deps.subscriptions.subscribe(params, connection.push);
      connection.subscriptionIds.add(opened.subscriptionId);
      return opened;
    },
    unsubscribe: ({ subscriptionId }, connection) => {
      if (!connection.subscriptionIds.delete(subscriptionId)) return { removed: false };
      return { removed: deps.subscriptions.unsubscribe(subscriptionId) };
    },
    'settings.resolve': (context) => deps.settings.resolveAll(context),
    'provider.test': ({ providerInstanceId }) => deps.providers.test(providerInstanceId),
    'provider.listModels': ({ providerInstanceId }) =>
      deps.providers.listModels(providerInstanceId),
    'provider.detect': () => deps.detectProviders(),
    'secrets.set': ({ name, value }) => deps.secrets.set(name, value),
    'secrets.delete': async ({ name }) => ({ removed: await deps.secrets.delete(name) }),
    'outlook.open': async ({ entryId }) => {
      try {
        await requireOutlook(deps).open(entryId);
      } catch (error) {
        // Outlook closed or not answering is the user's situation, not a server fault.
        if (error instanceof OutlookError) throw new RpcFault('rejected', error.message);
        throw error;
      }
      return { opened: true as const };
    },
    'outlook.refresh': async () => ({ outcome: await requireOutlook(deps).refresh() }),
    'secrets.status': async () => ({
      protection: deps.secrets.protection,
      names: await deps.secrets.names(),
    }),
  };
}

export function closeConnection(connection: Connection, subscriptions: Subscriptions): void {
  for (const subscriptionId of connection.subscriptionIds)
    subscriptions.unsubscribe(subscriptionId);
  connection.subscriptionIds.clear();
}
