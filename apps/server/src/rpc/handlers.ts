import type { SecretStore } from '@wow/secrets';
import type { Engine } from '../core/engine.js';
import type { Push, Subscriptions } from '../core/subscriptions.js';
import type { ProviderService } from '../providers/service.js';
import type { SettingsService } from '../settings/service.js';
import type { Handlers } from './router.js';

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
  readonly info: { readonly version: string; readonly home: string };
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
    'secrets.set': ({ name, value }) => deps.secrets.set(name, value),
    'secrets.delete': async ({ name }) => ({ removed: await deps.secrets.delete(name) }),
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
