import type { Command, Skill } from '@wow/contracts';
import {
  chokidarWatch,
  claudePluginRoots,
  scanSkills,
  skillRoots,
  watchSkillRoots,
  type SkillRoot,
  type SkillWatcher,
  type WatchFactory,
  ownSkillFile,
  ownSkillsDir,
  removeOwnSkill,
  skillFileName,
  wowSkillRoots,
  writeOwnSkillFile,
} from '@wow/skills';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Commit, Engine } from '../core/engine.js';
import { alreadyThere } from '../core/skills.js';
import type { Db } from '../db/database.js';
import { readModel } from '../core/projector.js';
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
  // wow's own folder: own skills are files under <wowHome>/skills (wow skills spec 6).
  readonly wowHome: string;
  readonly watch?: WatchFactory;
}

// Keeps the skills projection in step with the skill folders on disk: a scan at start, another
// whenever a watched folder changes, and one on request (the builder's refresh). The watched
// folders follow the skills settings and the project list. wow's built-in skills and the user's
// own skills are read like any other folder; an own skill saved or deleted by command has its
// file written or removed here once the command has committed. A write that fails is answered
// to the command (`writeFailure`) and a scan puts the list back to what is on disk.
export class SkillsService {
  readonly #deps: SkillsServiceDeps;
  readonly #unsubscribe: (() => void)[] = [];
  #watcher: SkillWatcher | undefined;
  #watchedKey = '';
  #tail: Promise<unknown> = Promise.resolve();
  #queued: Promise<Skill[]> | undefined;
  #stopped = false;
  // Counts own-skill commits, so a scan that read the folder before one does not undo it.
  #ownGeneration = 0;
  #lastWriteFailure: { readonly commandId: string; readonly message: string } | undefined;

  constructor(deps: SkillsServiceDeps) {
    this.#deps = deps;
  }

  async start(): Promise<void> {
    this.#unsubscribe.push(
      this.#deps.settings.onChange((key) => {
        if (key.startsWith('skills.')) this.#rootsMayHaveChanged();
      }),
      this.#deps.engine.onCommit((commit) => {
        if (this.#writeOwnSkills(commit.commandId, commit.events)) this.#rootsMayHaveChanged();
        else if (commit.topics.has('projects')) this.#rootsMayHaveChanged();
      }),
    );
    await this.refresh();
  }

  // Scans now. Calls that arrive while a scan is waiting to start share that scan, so a burst of
  // file changes costs one more scan, not one each. A scan overtaken by an own-skill commit
  // answers with the scan that commit queued, so no caller gets the list from before it.
  refresh(): Promise<Skill[]> {
    if (this.#queued) return this.#queued;
    const scan = this.#tail.then(() => {
      this.#queued = undefined;
      return this.#scan();
    });
    this.#tail = scan.catch(() => undefined);
    const answer = scan.then(({ skills, overtaken }) => (overtaken ? this.refresh() : skills));
    this.#queued = answer;
    return answer;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    await this.#tail;
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  // Refuses a new own skill whose folder already holds a SKILL.md the list does not show (one
  // the scan skipped, or on Windows one whose name differs only in case), so it is not
  // overwritten. The orchestrator does no I/O, so this runs before the command is decided.
  async refusal(command: Command): Promise<string | undefined> {
    if (command.type === 'skill.restore') return this.#restoreRefusal(command.folder);
    if (command.type !== 'skill.create') return undefined;
    const dir = ownSkillsDir(this.#deps.wowHome);
    const names = await readdir(dir).catch(() => [] as string[]);
    const wanted = command.skill.name.toLowerCase();
    const found = names.find(
      (name) => name.toLowerCase() === wanted && existsSync(path.join(dir, name, skillFileName)),
    );
    return found === undefined ? undefined : alreadyThere(path.join(dir, found));
  }

  // A restore puts a file back where the list has that skill, or where nothing is; never over
  // a SKILL.md the list does not show.
  #restoreRefusal(folder: string): string | undefined {
    const dir = path.resolve(ownSkillsDir(this.#deps.wowHome), folder);
    if (!existsSync(path.join(dir, skillFileName))) return undefined;
    const listed = readModel(this.#deps.db)
      .skills()
      .some((skill) => skill.source === 'yours' && skill.dir.toLowerCase() === dir.toLowerCase());
    return listed ? undefined : alreadyThere(dir);
  }

  // Why the file of the own skill a command saved or deleted could not be written or removed.
  writeFailure(commandId: string): string | undefined {
    const failure = this.#lastWriteFailure;
    return failure?.commandId === commandId ? failure.message : undefined;
  }

  // Synchronous, so the file is there when the command's answer reaches the client.
  #writeOwnSkills(commandId: string, events: Commit['events']): boolean {
    let touched = false;
    for (const { event } of events) {
      if (event.kind !== 'skill.saved' && event.kind !== 'skill.deleted') continue;
      touched = true;
      const { dir } = event.payload.skill;
      try {
        if (event.kind === 'skill.saved') {
          const { skill, previous } = event.payload;
          writeOwnSkillFile(
            skill.dir,
            skill.file ?? ownSkillFile({ ...skill, text: skill.text ?? '' }),
          );
          if (previous && previous.dir !== skill.dir) removeOwnSkill(previous.dir);
        } else {
          removeOwnSkill(dir);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `Could not write ${path.join(dir, skillFileName)}: ${reason}`;
        this.#lastWriteFailure = { commandId, message };
        this.#deps.logger.error('writing an own skill failed', error);
      }
    }
    if (touched) this.#ownGeneration += 1;
    return touched;
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
    const roots = [
      ...wowSkillRoots(this.#deps.wowHome),
      ...skillRoots(settings.get('skills.directories'), { userHome, projectDirs }),
    ];
    if (settings.get('skills.includeClaudePlugins')) {
      roots.push(...(await claudePluginRoots(path.join(userHome, '.claude'))));
    }
    return roots;
  }

  async #scan(): Promise<{ skills: Skill[]; overtaken: boolean }> {
    if (this.#stopped) return { skills: [], overtaken: false };
    const generation = this.#ownGeneration;
    const roots = await this.#roots();
    await this.#watch(roots);
    const scanned = await scanSkills(roots);
    const { problems } = scanned;
    // A built-in skill switched off is in no list (wow skills spec 3).
    const off = new Set<string>(this.#deps.settings.get('skills.builtInOff'));
    const skills = scanned.skills.filter((skill) => skill.source !== 'wow' || !off.has(skill.name));
    for (const problem of problems) {
      this.#deps.logger.warn(`skipped skill file ${problem.file}`, problem.message);
    }
    // An own skill committed since this scan began: the scan its commit queued sends the list.
    if (this.#stopped) return { skills, overtaken: false };
    if (generation !== this.#ownGeneration) return { skills, overtaken: true };
    this.#deps.engine.dispatch(`skills.sync:${randomUUID()}`, { type: 'skills.sync', skills });
    return { skills, overtaken: false };
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
