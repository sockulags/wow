import {
  WorkflowRun,
  inListOrder,
  runFolder,
  settingsRegistry,
  type Command,
  type DetectedProvider,
  type DiscoveredProject,
  type TerminalSession,
  type FileScope,
} from '@wow/contracts';
import { OutlookError } from '@wow/outlook-bridge';
import type { SecretStore } from '@wow/secrets';
import { desc, eq } from 'drizzle-orm';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { openAssistantThread } from '../assistant/thread.js';
import type { Engine } from '../core/engine.js';
import { readModel } from '../core/projector.js';
import { readCalendarRange } from '../core/series.js';
import { searchThreads } from '../core/thread-search.js';
import type { Push, Subscriptions } from '../core/subscriptions.js';
import type { Db } from '../db/database.js';
import { projects, threads, turns, workflowRuns } from '../db/schema.js';
import { ImageRefused, type ImageStore } from '../files/images.js';
import { listFolderFiles } from '../files/list.js';
import {
  EditorRefused,
  findEditorPath,
  planEditor,
  startEditor,
  type Spawn,
} from '../files/editor.js';
import { readViewerFile } from '../files/read.js';
import type { HostLookup } from '../hosts/lookup.js';
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
import { changesOptions, readRunDiff, readThreadDiff } from '../workflows/changes.js';
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
  readonly hostLookup: HostLookup;
  readonly images: ImageStore;
  readonly detectProviders: () => Promise<DetectedProvider[]>;
  readonly discoverProjects: () => Promise<DiscoveredProject[]>;
  readonly listSessions: (providerInstanceId?: string) => Promise<TerminalSession[]>;
  // Undefined until the Outlook service has started, or when the server runs without one.
  readonly outlook: () => OutlookService | undefined;
  readonly info: { readonly version: string; readonly home: string };
  readonly clock: () => Date;
  // How "Open in editor" starts its program; tests pass a stand-in and another platform.
  readonly editor?: {
    readonly spawn?: Spawn;
    readonly platform?: NodeJS.Platform;
    readonly env?: Record<string, string | undefined>;
  };
}

// The folders a file of a run, thread or project may come from, first folder first, and how a
// refusal names them (agent workbench Interface). The assistant's thread has none: its folder is
// wow's own, and its view takes no files.
function fileScope(
  deps: HandlerDeps,
  scope: FileScope,
): { readonly roots: string[]; readonly place: string } {
  const projectFolder = (projectId: string) => {
    const project = deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new RpcFault('not_found', `No project ${projectId}`);
    return project.cwd;
  };
  if ('runId' in scope) {
    const run = deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, scope.runId)).get();
    if (!run) throw new RpcFault('not_found', `No run ${scope.runId}`);
    const cwd = projectFolder(run.projectId);
    // A run with its own working copy reads from there first; the project folder stays allowed.
    return {
      roots: run.workingCopy ? [run.workingCopy.path, cwd] : [cwd],
      place: "the run's working folder and the project folder",
    };
  }
  if ('threadId' in scope) {
    const thread = deps.db.select().from(threads).where(eq(threads.id, scope.threadId)).get();
    if (!thread) throw new RpcFault('not_found', `No thread ${scope.threadId}`);
    if (thread.kind === 'assistant') {
      throw new RpcFault('rejected', "The assistant's thread has no files to open");
    }
    if (thread.projectId === null) return { roots: [thread.cwd], place: "the thread's folder" };
    return {
      roots: [...new Set([thread.cwd, projectFolder(thread.projectId)])],
      place: "the thread's folder and the project folder",
    };
  }
  return { roots: [projectFolder(scope.projectId)], place: 'the project folder' };
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

// A refused image is the user's to fix, so it answers `rejected` with the sentence.
async function imageCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ImageRefused) throw new RpcFault('rejected', error.message);
    throw error;
  }
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
      if (
        (command.type === 'thread.sendMessage' || command.type === 'thread.editLast') &&
        (command.attachments ?? []).length > 0
      ) {
        const missing = await deps.images.refusal(command);
        if (missing !== undefined) throw new RpcFault('rejected', missing);
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
    'provider.listCommands': ({ providerInstanceId, cwd, threadId }) =>
      deps.providers.listCommands(providerInstanceId, cwd, threadId),
    'provider.detect': () => deps.detectProviders(),
    'assistant.open': () =>
      openAssistantThread({
        db: deps.db,
        engine: deps.engine,
        registry: settingsRegistry,
        listModels: (providerInstanceId) => deps.providers.listModels(providerInstanceId),
      }),
    'projects.discover': async () => ({ projects: await deps.discoverProjects() }),
    'provider.listSessions': async ({ providerInstanceId }) => ({
      sessions: await deps.listSessions(providerInstanceId),
    }),
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
    'hosts.lookup': (params) => deps.hostLookup.lookup(params),
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
    'files.read': async (params) => {
      const scope = fileScope(deps, params);
      return readViewerFile({
        roots: scope.roots,
        path: params.path,
        maxBytes: deps.settings.get('viewer.maxFileBytes'),
        place: scope.place,
      });
    },
    'attachments.put': (params) => imageCall(() => deps.images.put(params)),
    'attachments.read': (params) => imageCall(() => deps.images.read(params)),
    'files.list': async (params) => {
      const [folder] = fileScope(deps, params).roots;
      if (folder === undefined) throw new RpcFault('not_found', 'No folder to list');
      return listFolderFiles({
        folder,
        limit: deps.settings.get('viewer.fileListLimit'),
        git: {
          timeoutMs: deps.settings.get('trackers.gitTimeoutMs'),
          stopWaitMs: deps.settings.get('advanced.gitStopWaitMs'),
        },
      });
    },
    'files.openInEditor': async (params) => {
      const scope = fileScope(deps, params);
      const found = await findEditorPath(scope.roots, params.path, scope.place);
      if ('refused' in found) throw new RpcFault('rejected', found.message);
      try {
        const launch = await planEditor({
          command: deps.settings.get('viewer.editorCommand'),
          shell: deps.settings.get('viewer.editorShell'),
          target: { path: found.found, line: params.line ?? 1 },
          platform: deps.editor?.platform ?? process.platform,
          env: deps.editor?.env ?? process.env,
        });
        await startEditor(launch, deps.editor?.spawn);
      } catch (failure) {
        if (failure instanceof EditorRefused) throw new RpcFault('rejected', failure.message);
        const reason = failure instanceof Error ? failure.message : String(failure);
        throw new RpcFault(
          'rejected',
          `The editor command did not start (${reason}). Check the "Editor command" setting.`,
        );
      }
      return { path: found.found };
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
    'threads.refreshTools': async ({ threadId }) => ({
      outcome: await deps.providers.refreshTools(threadId),
    }),
    'threads.diff': async ({ threadId, path: asked }) => {
      const thread = deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
      if (!thread) throw new RpcFault('not_found', `No thread ${threadId}`);
      if (thread.runId !== null || thread.kind !== 'chat') {
        throw new RpcFault('rejected', "A step's changes are its run's Changes tab.");
      }
      const last = deps.db
        .select({ fileMark: turns.fileMark })
        .from(turns)
        .where(eq(turns.threadId, threadId))
        .orderBy(desc(turns.index))
        .get();
      return readThreadDiff({
        folder: thread.cwd,
        baseSha: thread.baseSha,
        baseFiles: thread.baseFiles,
        mark: last?.fileMark ?? null,
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
