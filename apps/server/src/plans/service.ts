import {
  fileStatus,
  intentFileKinds,
  intentFileName,
  readIntent,
  unitContractFields,
} from '@wow/agent-os';
import { PlanIntent, type Project } from '@wow/contracts';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { projects } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import {
  chokidarPlansWatch,
  type PlansWatcher,
  type PlansWatchFactory,
  type PlansWatchTarget,
} from './watch.js';

export interface PlansServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly watch?: PlansWatchFactory;
}

// Shown on every unit that is not blocked while no host can say more (spec 24).
export const noHostReason = 'No host is set up for this project, so only the plan files are read';

// The project's intents folder, or undefined when the setting would leave the project folder.
export function intentsDirectory(
  project: Pick<Project, 'cwd'>,
  setting: string,
): string | undefined {
  const dir = path.resolve(project.cwd, setting);
  return isInside(project.cwd, dir) ? dir : undefined;
}

// Whether `target` is a folder below `root`, not `root` itself.
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export interface ProjectIntentsFolder {
  // The folder to read, when it exists and is inside the project.
  readonly dir?: string;
  // What to watch: the folder itself, or while it does not exist the nearest folder above it
  // that does, for the next part of the path appearing.
  readonly watch?: PlansWatchTarget;
  // Why nothing is read although the setting is fine.
  readonly refused?: string;
}

// Where a project's intents are and what to watch for them. The setting is a path inside the
// project, but a part of it can be a link (a junction on Windows) to somewhere else, so the
// folder is only read when its real location is still inside the project's real folder.
export async function locateIntents(
  project: Pick<Project, 'cwd'>,
  setting: string,
): Promise<ProjectIntentsFolder> {
  const dir = intentsDirectory(project, setting);
  if (!dir) return { refused: 'plans.intentsDirectory leaves the project folder' };
  const root = await realpath(project.cwd).catch(() => undefined);
  if (root === undefined) return {};
  const real = await realpath(dir).catch(() => undefined);
  if (real !== undefined) {
    if (!isInside(root, real)) return { refused: `${dir} is a link out of the project folder` };
    const found = await stat(real).catch(() => undefined);
    if (found?.isDirectory()) return { dir, watch: { dir, only: null } };
  }
  let missing = dir;
  let parent = path.dirname(missing);
  while (parent !== project.cwd && !(await stat(parent).catch(() => undefined))?.isDirectory()) {
    missing = parent;
    parent = path.dirname(missing);
  }
  return { watch: { dir: parent, only: path.basename(missing) } };
}

// An intent as the contract allows it. One that does not fit would make every snapshot of the
// topic fail, for every project, so it is replaced by a row that only says what is wrong with it.
export function presentable(intent: PlanIntent): PlanIntent | undefined {
  const parsed = PlanIntent.safeParse(intent);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const fallback = PlanIntent.safeParse({
    id: intent.id,
    projectId: intent.projectId,
    intentId: intent.intentId,
    title: intent.intentId,
    hasIntent: intent.hasIntent,
    status: null,
    rev: null,
    spec: null,
    plan: null,
    source: null,
    units: [],
    problems: [
      {
        file: intent.hasIntent ? 'intent' : intent.spec ? 'spec' : 'plan',
        line: 1,
        message: `Cannot be shown: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'not a plan row'}`,
      },
    ],
  } satisfies PlanIntent);
  return fallback.success ? fallback.data : undefined;
}

// Reads one project's intent folders. Links in the folder are not followed, so an intent folder
// or file that points outside the project is left out (locateIntents checks the folder itself).
// A folder that is missing or unreadable has no intents.
export async function readProjectIntents(
  project: Pick<Project, 'id'>,
  dir: string,
): Promise<PlanIntent[]> {
  const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const intents: PlanIntent[] = [];
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const files = await readdir(path.join(dir, folder.name), { withFileTypes: true }).catch(
      () => [],
    );
    const present = new Set(files.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const texts: Partial<Record<(typeof intentFileKinds)[number], string>> = {};
    for (const kind of intentFileKinds) {
      const name = intentFileName(kind);
      if (!present.has(name)) continue;
      const text = await readFile(path.join(dir, folder.name, name), 'utf8').catch(() => undefined);
      if (text !== undefined) texts[kind] = text;
    }
    if (Object.keys(texts).length === 0) continue;
    const document = readIntent({ id: folder.name, ...texts });
    const intent = presentable({
      id: `${project.id}:${document.id}`,
      projectId: project.id,
      intentId: document.id,
      title: document.title,
      hasIntent: document.hasIntent,
      status: document.status,
      rev: document.rev,
      spec: document.spec,
      plan: document.plan,
      source: document.source,
      units: document.units.map((unit) => {
        const status = fileStatus(unit);
        return {
          key: unit.key,
          title: unit.title,
          line: unit.line,
          dependsOn: [...unit.dependsOn],
          blocked: unit.blocked,
          contract: unit.contract
            ? unitContractFields.map((name) => ({
                name,
                value: unit.contract?.find((field) => field.name === name)?.value ?? null,
              }))
            : null,
          status,
          statusReason: status === 'blocked' ? (unit.blocked ?? '') : noHostReason,
        };
      }),
      problems: [...document.problems],
    });
    if (intent) intents.push(intent);
  }
  return intents.toSorted((a, b) => a.intentId.localeCompare(b.intentId));
}

// Keeps the plans projection in step with the intent files on disk: a read at start, another
// whenever a watched folder changes, when the project list or a plans setting changes, and one
// on request. It only reads; wow never writes these files.
export class PlansService {
  readonly #deps: PlansServiceDeps;
  readonly #unsubscribe: (() => void)[] = [];
  #watcher: PlansWatcher | undefined;
  #watchedKey = '';
  #tail: Promise<unknown> = Promise.resolve();
  #queued: Promise<PlanIntent[]> | undefined;
  #stopped = false;

  constructor(deps: PlansServiceDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    this.#unsubscribe.push(
      this.#deps.settings.onChange((key) => {
        if (key === 'plans.intentsDirectory' || key === 'plans.writeSettleMs') this.#changed();
      }),
      this.#deps.engine.onCommit((commit) => {
        if (commit.topics.has('projects')) this.#changed();
      }),
    );
    await this.refresh();
  }

  // Reads now. Calls that arrive while a read is waiting to start share that read, so a burst of
  // file changes costs one more read, not one each.
  refresh(): Promise<PlanIntent[]> {
    if (this.#queued) return this.#queued;
    const read = this.#tail.then(() => {
      this.#queued = undefined;
      return this.#read();
    });
    this.#queued = read;
    this.#tail = read.catch(() => undefined);
    return read;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    await this.#tail;
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  #changed(): void {
    this.refresh().catch((error: unknown) => this.#deps.logger.error('plan read failed', error));
  }

  async #read(): Promise<PlanIntent[]> {
    if (this.#stopped) return [];
    const { db, engine } = this.#deps;
    const all = db.select().from(projects).all();
    // The watcher is in place before the files are read, so a change made during the read is
    // reported after it. A folder that appeared while the watcher was starting changes what to
    // watch, hence the second look.
    let folders = await this.#locate(all);
    while (await this.#watch(folders.flatMap(({ folder }) => folder.watch ?? []))) {
      folders = await this.#locate(all);
    }
    const intents: PlanIntent[] = [];
    for (const { project, folder } of folders) {
      if (folder.dir) intents.push(...(await readProjectIntents(project, folder.dir)));
    }
    if (this.#stopped) return intents;
    engine.dispatch(`plans.sync:${randomUUID()}`, { type: 'plans.sync', intents });
    return intents;
  }

  async #locate(
    all: readonly Project[],
  ): Promise<{ project: Project; folder: ProjectIntentsFolder }[]> {
    const { settings, logger } = this.#deps;
    const located: { project: Project; folder: ProjectIntentsFolder }[] = [];
    for (const project of all) {
      const setting = settings.get('plans.intentsDirectory', { projectId: project.id });
      const folder = await locateIntents(project, setting);
      if (folder.refused) {
        logger.warn(`plans of project ${project.name} are not read: ${folder.refused}`, setting);
      }
      located.push({ project, folder });
    }
    return located;
  }

  // Answers whether a new watcher was started.
  async #watch(targets: readonly PlansWatchTarget[]): Promise<boolean> {
    const settleMs = this.#deps.settings.get('plans.writeSettleMs');
    const key = JSON.stringify([settleMs, targets]);
    if (this.#watcher && key === this.#watchedKey) return false;
    await this.#watcher?.close();
    this.#watchedKey = key;
    this.#watcher = await (this.#deps.watch ?? chokidarPlansWatch)(targets, () => this.#changed(), {
      settleMs,
    });
    return true;
  }
}
