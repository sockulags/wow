import {
  WorkflowRun,
  inListOrder,
  runFolder,
  settingsRegistry,
  type Command,
  type DetectedProvider,
  type DiscoveredProject,
} from '@wow/contracts';
import { OutlookError } from '@wow/outlook-bridge';
import type { SecretStore } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { openAssistantThread } from '../assistant/thread.js';
import type { Engine } from '../core/engine.js';
import { readModel } from '../core/projector.js';
import { readCalendarRange } from '../core/series.js';
import { searchThreads } from '../core/thread-search.js';
import type { Push, Subscriptions } from '../core/subscriptions.js';
import type { Db } from '../db/database.js';
import { projects, workflowRuns } from '../db/schema.js';
import { readViewerFile } from '../files/read.js';
import type { HostPoller } from '../hosts/poller.js';
import type { OutlookService } from '../outlook/service.js';
import type { ProviderService } from '../providers/service.js';
import type { ProviderUpdates } from '../providers/update.js';
import type { SettingsService } from '../settings/service.js';
import type { PlansService } from '../plans/service.js';
import type { SkillsService } from '../skills/service.js';
import { TrackerError } from '../trackers/http.js';
import type { TrackerService } from '../trackers/service.js';
import { detectArtifacts } from '../workflows/artifacts.js';
import { changesOptions, readRunDiff } from '../workflows/changes.js';
import type { WorkflowRunner } from '../workflows/runner.js';
import { WorkspaceRefused, type Workspaces } from '../workspaces/service.js';
import { planSetup } from '../setup/plan.js';
import { writeSetup } from '../setup/write.js';
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
  readonly plans: PlansService;
  readonly workflows: WorkflowRunner;
  readonly workspaces: Workspaces;
  readonly providers: ProviderService;
  readonly providerUpdates: ProviderUpdates;
  readonly trackers: TrackerService;
  readonly hosts: HostPoller;
  readonly detectProviders: () => Promise<DetectedProvider[]>;
  readonly discoverProjects: () => Promise<DiscoveredProject[]>;
  // Undefined until the Outlook service has started, or when the server runs without one.
  readonly outlook: () => OutlookService | undefined;
  readonly info: { readonly version: string; readonly home: string };
  readonly clock: () => Date;
}

function requireOutlook(deps: HandlerDeps): OutlookService {
  const outlook = deps.outlook();
  if (!outlook) throw new RpcFault('not_found', 'Outlook is not set up on this server');
  return outlook;
}

// A project's folder is where its threads and runs work, so it has to be one that exists. The
// orchestrator does no I/O, so the check happens here, before the command is decided.
export async function checkProjectFolder(command: Command): Promise<void> {
  if (command.type !== 'project.create' && command.type !== 'project.update') return;
  if (command.cwd === undefined) return;
  if (!path.isAbsolute(command.cwd)) {
    throw new RpcFault('rejected', `Use a full folder path, not ${command.cwd}`);
  }
  const found = await stat(command.cwd).catch(() => undefined);
  if (!found?.isDirectory()) throw new RpcFault('rejected', `No folder ${command.cwd}`);
}

// The commands a setup file or an accepted proposal makes the engine decide, so the checks that
// need the disk see them too; whatever else is wrong with them the engine answers.
function innerCommands(command: Command, deps: HandlerDeps): Command[] {
  if (command.type === 'assistant.proposal.accept') {
    const proposal = readModel(deps.db).assistantProposal(command.proposalId);
    return proposal?.state === 'pending' ? [proposal.command] : [];
  }
  if (command.type === 'setup.apply') {
    const plan = planSetup(command.text, readModel(deps.db), {
      now: deps.clock().toISOString(),
      registry: settingsRegistry,
      home: deps.info.home,
    });
    return plan.outcome === 'ready' ? [...plan.commands] : [];
  }
  return [];
}

export function createHandlers(deps: HandlerDeps): Handlers<Connection> {
  return {
    'server.info': () => ({ version: deps.info.version, home: deps.info.home, pid: process.pid }),
    dispatch: async ({ commandId, command }) => {
      await checkProjectFolder(command);
      for (const checked of [command, ...innerCommands(command, deps)]) {
        const refused = await deps.skills.refusal(checked);
        if (refused !== undefined) throw new RpcFault('rejected', refused);
      }
      const result = deps.engine.dispatch(commandId, command);
      // The command committed but its file could not be written; a scan puts the list back.
      const failed = deps.skills.writeFailure(commandId);
      if (failed !== undefined) throw new RpcFault('rejected', failed);
      return result;
    },
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
    'threads.search': ({ query }) => ({
      threadIds: searchThreads(deps.db, query, deps.settings.get('chat.threadSearchMaxLength')),
    }),
    'calendar.occurrences': (range) =>
      readCalendarRange(deps.db, range, deps.settings.get('calendar.maxOccurrences')),
    'provider.test': ({ providerInstanceId }) => deps.providers.test(providerInstanceId),
    'provider.update': ({ providerInstanceId }) => deps.providerUpdates.start(providerInstanceId),
    'provider.listModels': ({ providerInstanceId }) =>
      deps.providers.listModels(providerInstanceId),
    'provider.detect': () => deps.detectProviders(),
    'assistant.open': () =>
      openAssistantThread({
        db: deps.db,
        engine: deps.engine,
        registry: settingsRegistry,
        listModels: (providerInstanceId) => deps.providers.listModels(providerInstanceId),
      }),
    'projects.discover': async () => ({ projects: await deps.discoverProjects() }),
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
    'skills.refresh': async () => ({ skills: inListOrder(await deps.skills.refresh()) }),
    'plans.refresh': async () => ({ intents: await deps.plans.refresh() }),
    'hosts.refresh': async (params) => ({ reads: await deps.hosts.refresh(params) }),
    'projects.git': async () => ({ projects: await deps.trackers.projectsGit() }),
    'trackers.project': ({ projectId }) => deps.trackers.projectTrackers(projectId),
    'trackers.preview': ({ backlogItemId, service, projectId }) =>
      deps.trackers.preview(backlogItemId, service, projectId),
    'trackers.test': ({ service, projectId }) => deps.trackers.test(service, projectId),
    'trackers.publish': async ({ backlogItemId, service, title, labels, projectId }) => {
      try {
        return await deps.trackers.publish(backlogItemId, service, { title, labels, projectId });
      } catch (error) {
        // A tracker that refuses the issue or cannot be reached is the user's to fix.
        if (error instanceof TrackerError) throw new RpcFault('rejected', error.message);
        throw error;
      }
    },
    'workflows.matchArtifacts': async ({ projectId, globs }) => {
      const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new RpcFault('not_found', `No project ${projectId}`);
      return { files: await detectArtifacts(project.cwd, globs) };
    },
    'files.read': async ({ runId, path: requested }) => {
      const run = deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
      if (!run) throw new RpcFault('not_found', `No run ${runId}`);
      const project = deps.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
      if (!project) throw new RpcFault('not_found', `No project ${run.projectId}`);
      // A run with its own working copy reads from there first; the project folder stays allowed.
      return readViewerFile({
        roots: run.workingCopy ? [run.workingCopy.path, project.cwd] : [project.cwd],
        path: requested,
        maxBytes: deps.settings.get('viewer.maxFileBytes'),
      });
    },
    'workflowRuns.diff': async ({ runId, path: asked }) => {
      const run = deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
      if (!run) throw new RpcFault('not_found', `No run ${runId}`);
      const project = deps.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
      if (!project) throw new RpcFault('not_found', `No project ${run.projectId}`);
      return readRunDiff({
        folder: runFolder(run, project.cwd),
        run,
        path: asked,
        options: changesOptions(deps.settings),
      });
    },
    'workflowRuns.removeWorkingCopy': async ({ runId }) => {
      if (!deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()) {
        throw new RpcFault('not_found', `No run ${runId}`);
      }
      try {
        await deps.workspaces.remove(runId);
      } catch (error) {
        if (error instanceof WorkspaceRefused) throw new RpcFault('rejected', error.message);
        throw error;
      }
      const run = deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
      if (!run) throw new RpcFault('not_found', `No run ${runId}`);
      return WorkflowRun.parse(run);
    },
    'setup.save': () =>
      writeSetup(readModel(deps.db), {
        now: deps.clock().toISOString(),
        registry: settingsRegistry,
        version: deps.info.version,
      }),
    // The same reading `setup.apply` does, without storing anything.
    'setup.preview': ({ text }) => {
      const plan = planSetup(text, readModel(deps.db), {
        now: deps.clock().toISOString(),
        registry: settingsRegistry,
        home: deps.info.home,
        keepStepsWithoutModel: true,
      });
      return plan.outcome === 'ready'
        ? { outcome: 'ready', preview: plan.preview }
        : { outcome: 'refused', problems: [...plan.problems] };
    },
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
