import type { Skill } from '@wow/contracts';
import {
  chokidarWatch,
  claudePluginRoots,
  scanSkills,
  skillRoots,
  watchSkillRoots,
  type SkillRoot,
  type SkillWatcher,
  type WatchFactory,
} from '@wow/skills';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { projects } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';

export interface SkillsServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  // The folder "~" stands for in skills.directories; Claude plugins are read from <home>/.claude.
  readonly userHome: string;
  readonly watch?: WatchFactory;
}

// Keeps the skills projection in step with the skill folders on disk: a scan at start, another
// whenever a watched folder changes, and one on request (the builder's refresh). The watched
// folders follow the skills settings and the project list.
export class SkillsService {
  readonly #deps: SkillsServiceDeps;
  readonly #unsubscribe: (() => void)[] = [];
  #watcher: SkillWatcher | undefined;
  #watchedKey = '';
  #tail: Promise<unknown> = Promise.resolve();
  #queued: Promise<Skill[]> | undefined;
  #stopped = false;

  constructor(deps: SkillsServiceDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    this.#unsubscribe.push(
      this.#deps.settings.onChange((key) => {
        if (key.startsWith('skills.')) this.#rootsMayHaveChanged();
      }),
      this.#deps.engine.onCommit((commit) => {
        if (commit.topics.has('projects')) this.#rootsMayHaveChanged();
      }),
    );
    await this.refresh();
  }

  // Scans now. Calls that arrive while a scan is waiting to start share that scan, so a burst of
  // file changes costs one more scan, not one each.
  refresh(): Promise<Skill[]> {
    if (this.#queued) return this.#queued;
    const scan = this.#tail.then(() => {
      this.#queued = undefined;
      return this.#scan();
    });
    this.#queued = scan;
    this.#tail = scan.catch(() => undefined);
    return scan;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    await this.#tail;
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  #rootsMayHaveChanged(): void {
    this.refresh().catch((error: unknown) => this.#deps.logger.error('skill scan failed', error));
  }

  async #roots(): Promise<SkillRoot[]> {
    const { settings, db, userHome } = this.#deps;
    const projectDirs = db
      .select({ cwd: projects.cwd })
      .from(projects)
      .all()
      .map((row) => row.cwd);
    const roots = skillRoots(settings.get('skills.directories'), { userHome, projectDirs });
    if (settings.get('skills.includeClaudePlugins')) {
      roots.push(...(await claudePluginRoots(path.join(userHome, '.claude'))));
    }
    return roots;
  }

  async #scan(): Promise<Skill[]> {
    if (this.#stopped) return [];
    const roots = await this.#roots();
    await this.#watch(roots);
    const { skills, problems } = await scanSkills(roots);
    for (const problem of problems) {
      this.#deps.logger.warn(`skipped skill file ${problem.file}`, problem.message);
    }
    if (this.#stopped) return skills;
    this.#deps.engine.dispatch(`skills.sync:${randomUUID()}`, { type: 'skills.sync', skills });
    return skills;
  }

  async #watch(roots: readonly SkillRoot[]): Promise<void> {
    const key = roots.map((root) => root.dir).join('\n');
    if (this.#watcher && key === this.#watchedKey) return;
    await this.#watcher?.close();
    this.#watchedKey = key;
    this.#watcher = watchSkillRoots(
      roots,
      () => this.#rootsMayHaveChanged(),
      this.#deps.watch ?? chokidarWatch,
    );
  }
}
