import { WorkflowRun, type DetectedProvider } from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import type { Push, Subscriptions } from '../core/subscriptions.js';
import type { Db } from '../db/database.js';
import { workflowRuns } from '../db/schema.js';
import type { ProviderService } from '../providers/service.js';
import type { SettingsService } from '../settings/service.js';
import type { SkillsService } from '../skills/service.js';
import type { WorkflowRunner } from '../workflows/runner.js';
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
  readonly db: Db;
  readonly skills: SkillsService;
  readonly workflows: WorkflowRunner;
  readonly providers: ProviderService;
  readonly detectProviders: () => Promise<DetectedProvider[]>;
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
    'provider.detect': () => deps.detectProviders(),
    'secrets.set': ({ name, value }) => deps.secrets.set(name, value),
    'secrets.delete': async ({ name }) => ({ removed: await deps.secrets.delete(name) }),
    'secrets.status': async () => ({
      protection: deps.secrets.protection,
      names: await deps.secrets.names(),
    }),
    'skills.refresh': async () => ({ skills: await deps.skills.refresh() }),
    'workflowRuns.detectArtifacts': async ({ runId }) => {
      await deps.workflows.detectArtifacts(runId);
      const run = deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
      if (!run) throw new RpcFault('not_found', `No run ${runId}`);
      return WorkflowRun.parse(run);
    },
  };
}

export function closeConnection(connection: Connection, subscriptions: Subscriptions): void {
  for (const subscriptionId of connection.subscriptionIds)
    subscriptions.unsubscribe(subscriptionId);
  connection.subscriptionIds.clear();
}
