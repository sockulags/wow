import type { ServerMessage } from '@wow/contracts';
import { SecretStore, defaultProtector, type Protector } from '@wow/secrets';
import type { WatchFactory } from '@wow/skills';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine } from './core/engine.js';
import { Subscriptions } from './core/subscriptions.js';
import { openDatabase, type Database } from './db/database.js';
import {
  ProviderAdapters,
  outlookMode,
  type BackgroundService,
  type ServerHooks,
  type ServiceContext,
} from './hooks/index.js';
import { createLogger, type LogSink, type Logger } from './logger.js';
import { detectProviders } from './providers/detect.js';
import { ProviderService } from './providers/service.js';
import { closeConnection, createHandlers, type Connection } from './rpc/handlers.js';
import { route } from './rpc/router.js';
import { SettingsService } from './settings/service.js';
import { SkillsService } from './skills/service.js';
import { detectArtifacts, type ArtifactDetector } from './workflows/artifacts.js';
import { WorkflowRunner } from './workflows/runner.js';

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
  readonly detectArtifacts?: ArtifactDetector;
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
  readonly workflows: WorkflowRunner;
  readonly providerService: ProviderService;
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
  const engine = new Engine(database.db, {
    onListenerError: (error) => logger.error('commit listener failed', error),
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
  });
  const providers = new ProviderAdapters(options.hooks?.providers ?? {}, env);
  const providerService = new ProviderService({
    db: database.db,
    engine,
    adapters: providers,
    settings,
    secrets,
    logger,
  });
  const workflows = new WorkflowRunner({
    db: database.db,
    engine,
    detectArtifacts: options.detectArtifacts ?? detectArtifacts,
    logger,
  });
  // The runner listens first, so a step whose turn recovery fails also fails its run.
  providerService.recover();
  workflows.recover();
  const skills = new SkillsService({
    db: database.db,
    engine,
    settings,
    logger,
    userHome: options.userHome ?? homedir(),
    ...(options.watchSkills ? { watch: options.watchSkills } : {}),
  });
  const handlers = createHandlers({
    engine,
    subscriptions,
    settings,
    secrets,
    db: database.db,
    skills,
    workflows,
    providers: providerService,
    detectProviders: () => detectProviders({ env, platform: options.platform ?? process.platform }),
    info: { version, home },
  });

  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: options.port ?? settings.get('advanced.port'),
    verifyClient: ({ req }, done) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (tokensMatch(expected, url.searchParams.get('token'))) done(true);
      else done(false, 401, 'Unauthorized');
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
  } catch (error) {
    await workflows.stop();
    await providerService.stop();
    database.close();
    throw error;
  }
  const address = wss.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('WebSocket server has no TCP address');
  const port = address.port;

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
    dispatch: (commandId, command) => engine.dispatch(commandId, command),
  };
  const services: BackgroundService[] = [workflows];
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
    const mode = outlookMode(options.platform ?? process.platform, env);
    if (options.hooks?.outlook) services.push(await options.hooks.outlook(mode, context));
    for (const start of options.hooks?.services ?? []) services.push(await start(context));
  } catch (error) {
    await stopServices();
    await providerService.stop();
    wss.close();
    await rm(infoFile, { force: true });
    database.close();
    throw error;
  }

  logger.info('server listening', { port, home, providers: providers.mock ? 'mock' : 'real' });

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      await stopServices();
      await providerService.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
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
    workflows,
    providerService,
    logger,
    stop,
  };
}
