import {
  fileStatus,
  intentFileKinds,
  intentFileName,
  readIntent,
  unitContractFields,
} from '@wow/agent-os';
import type { PlanIntent, Project } from '@wow/contracts';
import { chokidarWatch, type SkillWatcher, type WatchFactory } from '@wow/skills';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { projects } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';

export interface PlansServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly watch?: WatchFactory;
}

// Shown on every unit that is not blocked while no host can say more (spec 24).
export const noHostReason = 'No host is set up for this project, so only the plan files are read';

// The project's intents folder, or undefined when the setting would leave the project folder.
export function intentsDirectory(
  project: Pick<Project, 'cwd'>,
  setting: string,
): string | undefined {
  const dir = path.resolve(project.cwd, setting);
  const relative = path.relative(project.cwd, dir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return dir;
}

// Reads one project's intent folders. Links are not followed, so a folder or file that points
// outside the project is left out. A folder that is missing or unreadable has no intents.
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
    intents.push({
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
  }
  return intents.toSorted((a, b) => a.intentId.localeCompare(b.intentId));
}

// Keeps the plans projection in step with the intent files on disk: a read at start, another
// whenever a watched folder changes, when the project list or `plans.intentsDirectory` changes,
// and one on request. It only reads; wow never writes these files.
export class PlansService {
  readonly #deps: PlansServiceDeps;
  readonly #unsubscribe: (() => void)[] = [];
  #watcher: SkillWatcher | undefined;
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
        if (key === 'plans.intentsDirectory') this.#changed();
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
    const { db, settings, logger, engine } = this.#deps;
    const dirs: string[] = [];
    const intents: PlanIntent[] = [];
    for (const project of db.select().from(projects).all()) {
      const setting = settings.get('plans.intentsDirectory', { projectId: project.id });
      const dir = intentsDirectory(project, setting);
      if (!dir) {
        logger.warn(`plans.intentsDirectory leaves the folder of project ${project.name}`, setting);
        continue;
      }
      dirs.push(dir);
      intents.push(...(await readProjectIntents(project, dir)));
    }
    await this.#watch(dirs);
    if (this.#stopped) return intents;
    engine.dispatch(`plans.sync:${randomUUID()}`, { type: 'plans.sync', intents });
    return intents;
  }

  async #watch(dirs: readonly string[]): Promise<void> {
    const key = dirs.join('\n');
    if (this.#watcher && key === this.#watchedKey) return;
    await this.#watcher?.close();
    this.#watchedKey = key;
    this.#watcher = (this.#deps.watch ?? chokidarWatch)(dirs, () => this.#changed());
  }
}
