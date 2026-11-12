import { settingsRegistry, type HostKind, type ServerMessage } from '@wow/contracts';
import { discoverClaudeFolders } from '@wow/provider-claude';
import { discoverCodexFolders } from '@wow/provider-codex';
import { SecretStore, defaultProtector, type Protector } from '@wow/secrets';
import type { WatchFactory } from '@wow/skills';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { assistantMcpPath, createMcpHandler, type AssistantEndpoint } from './assistant/mcp.js';
import { AssistantTools } from './assistant/tools.js';
import { Engine } from './core/engine.js';
import { Subscriptions } from './core/subscriptions.js';
import { openDatabase, type Database } from './db/database.js';
import { projects, providerInstances } from './db/schema.js';
import { eq } from 'drizzle-orm';
import {
  ProviderAdapters,
  outlookMode,
  type BackgroundService,
  type ServerHooks,
  type ServiceContext,
} from './hooks/index.js';
import { ImageStore } from './files/images.js';
import { HostLookup } from './hosts/lookup.js';
import { HostPoller } from './hosts/poller.js';
import { createLogger, type LogSink, type Logger } from './logger.js';
import type { OutlookService } from './outlook/service.js';
import { discoverProjects } from './projects/discover.js';
import { readCurrentBranch, readHeadCommit } from './projects/git.js';
import { defaultConfigDir, detectProviders } from './providers/detect.js';
import { ProviderService } from './providers/service.js';
import { ProviderUpdates, createNpmRunner, type RunNpm } from './providers/update.js';
import { closeConnection, createHandlers, type Connection } from './rpc/handlers.js';
import { route } from './rpc/router.js';
import { Scheduler, type SchedulerTimers } from './scheduler/service.js';
import { SettingsService } from './settings/service.js';
import { PlansService } from './plans/service.js';
import { readIntentTexts } from './hosts/intent-texts.js';
import { PlanRuns } from './plans/plan-runs.js';
import type { PlansWatchFactory } from './plans/watch.js';
import { SkillsService } from './skills/service.js';
import { TrackerService } from './trackers/service.js';
import { detectArtifacts, type ArtifactDetector } from './workflows/artifacts.js';
import { changesOptions, readRunBase, snapshotChanges } from './workflows/changes.js';
import { WorkflowRunner } from './workflows/runner.js';
import { Workspaces } from './workspaces/service.js';

export const serverInfoFileName = 'server.json';
export const databaseFileName = 'wow.sqlite';

export interface ServerInfoFile {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export function wowHome(env: Record<string, string | undefined> = process.env): string {
  const override = env['WOW_HOME'];
  return override && override.length > 0 ? path.resolve(override) : path.join(homedir(), '.wow');
}

export async function readServerInfo(home: string): Promise<ServerInfoFile> {
  return JSON.parse(await readFile(path.join(home, serverInfoFileName), 'utf8')) as ServerInfoFile;
}

export interface StartOptions {
  readonly home?: string;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  // Overrides the advanced.port setting, for tests and the desktop app.
  readonly port?: number;
  readonly hooks?: ServerHooks;
  readonly protector?: Protector;
  readonly logSink?: LogSink;
  // The folder "~" means in skills.directories. Defaults to the user's home folder.
  readonly userHome?: string;
  // Replaces the chokidar watcher on the skill folders, for tests.
  readonly watchSkills?: WatchFactory;
  // Replaces the chokidar watcher on the projects' intents folders, for tests.
  readonly watchPlans?: PlansWatchFactory;
  readonly detectArtifacts?: ArtifactDetector;
  // The time the engine stamps and the scheduler compares triggers with, for tests.
  readonly clock?: () => Date;
  // Replaces the scheduler's timer, for tests that call `scheduler.tick()` themselves.
  readonly schedulerTimers?: SchedulerTimers;
  // Replaces the host poller's timer, for tests that call `hosts.poll()` themselves.
  readonly hostTimers?: SchedulerTimers;
  // Replaces the global fetch the tracker clients and the host poller use, for tests.
  readonly fetch?: typeof fetch;
  // Runs npm for "Update Codex" (`provider.update`); tests and the e2e server pass a fake one.
  readonly runNpm?: RunNpm;
}

export interface RunningServer {
  readonly home: string;
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly database: Database;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly subscriptions: Subscriptions;
  readonly secrets: SecretStore;
  readonly providers: ProviderAdapters;
  readonly skills: SkillsService;
  readonly plans: PlansService;
  readonly workflows: WorkflowRunner;
  readonly workspaces: Workspaces;
  readonly providerService: ProviderService;
  readonly providerUpdates: ProviderUpdates;
  readonly scheduler: Scheduler;
  readonly trackers: TrackerService;
  readonly hosts: HostPoller;
  // Reads the items chat threads link to, when asked (agent workbench spec 22).
  readonly hostLookup: HostLookup;
  // Where the assistant's tools are reached and the token that opens them (see "Assistant").
  readonly assistant: AssistantEndpoint;
  readonly logger: Logger;
  stop(): Promise<void>;
}

const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function writePrivateFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

const tokensMatch = (expected: Buffer, given: string | null): boolean => {
  if (given === null) return false;
  const candidate = Buffer.from(given);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const home = options.home ?? wowHome(env);
  await mkdir(home, { recursive: true, mode: 0o700 });

  const database = openDatabase(path.join(home, databaseFileName));
  // Assigned right below; the engine needs a logger before the settings service exists.
  let logger: Logger = createLogger(() => 'info', options.logSink);
  // Assigned once the tracker service exists; it caches each project's code host.
  let codeHost: ((projectId: string) => HostKind | undefined) | undefined;
  const engine = new Engine(database.db, {
    onListenerError: (error) => logger.error('commit listener failed', error),
    home,
    codeHost: (projectId) => codeHost?.(projectId),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const settings = new SettingsService(database.db, engine);
  logger = createLogger(() => settings.get('advanced.logLevel'), options.logSink);
  const subscriptions = new Subscriptions(database.db, engine);
  const secrets = new SecretStore({
    dir: home,
    protector:
      options.protector ??
      defaultProtector(options.platform ?? process.platform, {
        timeoutMs: () => settings.get('advanced.secretsTimeoutMs'),
      }),
    replaceWaitMs: () => settings.get('advanced.secretsTimeoutMs'),
  });
  const providers = new ProviderAdapters(options.hooks?.providers ?? {}, env);
  // Known once the server listens; the assistant's turn asks for it when it starts.
  let assistantAccess: { url: string; token: string } | undefined;
  const folderChanges = {
    base: (folder: string) => readRunBase(folder, changesOptions(settings)),
    head: async (folder: string) => {
      const head = await readHeadCommit(folder, changesOptions(settings).git);
      return head.status === 'ok' ? head.sha : undefined;
    },
    snapshot: (folder: string, baseSha: string) =>
      snapshotChanges(folder, baseSha, changesOptions(settings)),
  };
  const providerService = new ProviderService({
    db: database.db,
    engine,
    adapters: providers,
    settings,
    secrets,
    logger,
    home,
    assistant: () => assistantAccess,
    changes: folderChanges,
  });
  const workspaces = new Workspaces({ db: database.db, engine, settings, logger });
  const workflows = new WorkflowRunner({
    db: database.db,
    engine,
    detectArtifacts: options.detectArtifacts ?? detectArtifacts,
    changes: folderChanges,
    prepare: (runId) => workspaces.prepare(runId),
    logger,
  });
  const providerUpdates = new ProviderUpdates({
    db: database.db,
    engine,
    providers: providerService,
    settings,
    logger,
    env,
    runNpm: options.runNpm ?? createNpmRunner({ platform: options.platform ?? process.platform }),
  });
  providerUpdates.recover();
  // The runner listens first, so a step whose turn recovery fails also fails its run.
  providerService.recover();
  // Set once the Outlook hook has started, which happens after the socket listens.
  let outlook: OutlookService | undefined;
  // First, so a run whose working copy was being made fails with that reason.
  workspaces.recover();
  workflows.recover();
  const skills = new SkillsService({
    db: database.db,
    engine,
    settings,
    logger,
    userHome: options.userHome ?? homedir(),
    wowHome: home,
    ...(options.watchSkills ? { watch: options.watchSkills } : {}),
  });
  const plans = new PlansService({
    db: database.db,
    engine,
    settings,
    logger,
    ...(options.watchPlans ? { watch: options.watchPlans } : {}),
  });
  const trackers = new TrackerService({
    db: database.db,
    engine,
    settings,
    secrets,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  codeHost = (projectId) => trackers.codeHost(projectId);
  const hosts = new HostPoller({
    db: database.db,
    engine,
    settings,
    logger,
    resolve: (projectId) => trackers.githubHost(projectId),
    resolveGitLab: (projectId) => trackers.gitlabHost(projectId),
    resolveJira: (projectId) => trackers.jiraHost(projectId),
    resolveConfluence: (projectId) => trackers.confluenceHost(projectId),
    intentTexts: async (projectId, intentId) => {
      const project = database.db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) return [];
      const setting = settings.get('plans.intentsDirectory', { projectId });
      return readIntentTexts(project, setting, intentId);
    },
    workingCopyBranch: (folder) =>
      readCurrentBranch(folder, { timeoutMs: settings.get('trackers.gitTimeoutMs') }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hostTimers ? { timers: options.hostTimers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const hostLookup = new HostLookup({
    db: database.db,
    engine,
    settings,
    logger,
    linkHosts: (projectId, tokens) => trackers.linkHosts(projectId, tokens),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const planRuns = new PlanRuns({
    db: database.db,
    engine,
    logger,
    readPlan: (planId) => hosts.readPlan(planId),
  });
  const images = new ImageStore({
    db: database.db,
    home,
    maxBytes: () => settings.get('chat.imageMaxBytes'),
    listModels: (providerInstanceId) => providerService.listModels(providerInstanceId),
  });
  const handlers = createHandlers({
    engine,
    subscriptions,
    settings,
    secrets,
    db: database.db,
    skills,
    plans,
    workflows,
    workspaces,
    providers: providerService,
    providerUpdates,
    trackers,
    hosts,
    hostLookup,
    images,
    detectProviders: () => detectProviders({ env, platform: options.platform ?? process.platform }),
    discoverProjects: () =>
      discoverProjects({
        instances: database.db.select().from(providerInstances).all(),
        projects: database.db.select().from(projects).all(),
        defaultConfigDir: (kind) => defaultConfigDir(kind, env),
        discover: { claude: discoverClaudeFolders, codex: discoverCodexFolders },
        platform: options.platform ?? process.platform,
      }),
    outlook: () => outlook,
    info: { version, home },
    clock: options.clock ?? (() => new Date()),
  });

  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  // A token of its own: what opens the assistant's tools does not open the app's connection,
  // and the other way round.
  const assistantToken = randomBytes(32).toString('base64url');
  const assistantTools = new AssistantTools({
    db: database.db,
    engine,
    settings,
    secrets,
    trackers,
    logger,
    clock: options.clock ?? (() => new Date()),
    registry: settingsRegistry,
    listModels: (providerInstanceId) => providerService.listModels(providerInstanceId),
  });
  const mcp = createMcpHandler({ tools: assistantTools, token: assistantToken, version, logger });
  // One port for both: the WebSocket upgrade for the app, and plain HTTP for the assistant's
  // tools only.
  const http = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (pathname === assistantMcpPath) {
      void mcp(request, response);
      return;
    }
    response.writeHead(426, { 'content-type': 'text/plain' });
    response.end('Upgrade Required');
  });
  const wss = new WebSocketServer({
    server: http,
    verifyClient: ({ req }, done) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (tokensMatch(expected, url.searchParams.get('token'))) done(true);
      else done(false, 401, 'Unauthorized');
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('listening', resolve);
      http.once('error', reject);
      http.listen(options.port ?? settings.get('advanced.port'), '127.0.0.1');
    });
  } catch (error) {
    await workflows.stop();
    await workspaces.stop();
    await providerService.stop();
    database.close();
    throw error;
  }
  const address = http.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('WebSocket server has no TCP address');
  const port = address.port;
  assistantAccess = { url: `http://127.0.0.1:${port}${assistantMcpPath}`, token: assistantToken };

  wss.on('connection', (socket: WebSocket) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const connection: Connection = {
      push: (subscription, data) => send({ subscription, data }),
      subscriptionIds: new Set(),
    };
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw as ArrayBuffer).toString('utf8');
      void route(text, handlers, connection, (error, method) =>
        logger.error(`${method} failed`, error),
      ).then(send);
    });
    socket.on('close', () => closeConnection(connection, subscriptions));
    socket.on('error', (error) => logger.warn('socket error', error));
  });

  const infoFile = path.join(home, serverInfoFileName);
  const info: ServerInfoFile = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writePrivateFile(infoFile, `${JSON.stringify(info, null, 2)}\n`);

  const context: ServiceContext = {
    home,
    settings,
    logger,
    dispatch: (commandId, command) => engine.dispatch(commandId, command),
  };
  const scheduler = new Scheduler({
    db: database.db,
    engine,
    settings,
    logger,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.schedulerTimers ? { timers: options.schedulerTimers } : {}),
  });
  const services: BackgroundService[] = [workspaces, workflows];
  const stopServices = async () => {
    for (const service of services.splice(0).toReversed()) {
      try {
        await service.stop();
      } catch (error) {
        logger.error('service failed to stop', error);
      }
    }
  };
  try {
    services.push(skills);
    // A folder that cannot be read must not keep the server from starting.
    await skills.start().catch((error: unknown) => logger.error('skill scan failed', error));
    services.push(plans);
    await plans.start().catch((error: unknown) => logger.error('plan read failed', error));
    // After the plans are read and the runs recovered, so a plan run sees both as they are now.
    services.push(planRuns);
    planRuns.recover();
    const mode = outlookMode(options.platform ?? process.platform, env);
    if (options.hooks?.outlook) {
      outlook = await options.hooks.outlook(mode, context);
      services.push(outlook);
    }
    for (const start of options.hooks?.services ?? []) services.push(await start(context));
    // The host poller runs beside the scheduler and stops right after it.
    services.push(hosts);
    hosts.start();
    // Last, so it stops first: no trigger fires into services that are already gone.
    services.push(scheduler);
    scheduler.start();
  } catch (error) {
    await stopServices();
    await providerService.stop();
    wss.close();
    http.close();
    await rm(infoFile, { force: true });
    database.close();
    throw error;
  }

  logger.info('server listening', { port, home, providers: providers.mock ? 'mock' : 'real' });

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      await stopServices();
      await providerUpdates.stop();
      await providerService.stop();
      await trackers.idle();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      // Leave the file alone if another server instance has replaced it meanwhile.
      const current = await readServerInfo(home).catch(() => undefined);
      if (current?.token === token) await rm(infoFile, { force: true });
      database.close();
    })());

  return {
    home,
    port,
    token,
    url: `ws://127.0.0.1:${port}/?token=${token}`,
    database,
    engine,
    settings,
    subscriptions,
    secrets,
    providers,
    skills,
    plans,
    workflows,
    workspaces,
    providerService,
    providerUpdates,
    scheduler,
    trackers,
    hosts,
    hostLookup,
    assistant: { ...assistantAccess, tools: assistantTools },
    logger,
    stop,
  };
}
