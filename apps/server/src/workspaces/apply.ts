import {
  ChangesAppliedItemPayload,
  applyConfirmedOf,
  applyLeftWords,
  undoableApply,
  type ApplyConfirmed,
  type ApplyFile,
  type ApplyPreview,
  type ApplyStatus,
  type Command,
  type DispatchResult,
} from '@wow/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { commandReceipts, projects, threadItems, threads, turns } from '../db/schema.js';
import { folderKey } from '../files/folder-key.js';
import { unsafeSnapshotPath } from '../files/snapshots.js';
import type { Logger } from '../logger.js';
import {
  hashSnapshotFiles,
  initSnapshotStore,
  listChangedSince,
  listSnapshotRefs,
  mergeFileBytes,
  readFolderBlobs,
  readFolderTree,
  readSnapshotBlobs,
  readSnapshotRepository,
  readSnapshotTree,
  updateSnapshotRefs,
  writeSnapshotTree,
  type GitRunOptions,
  type SnapshotEntry,
} from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';

// Apply a chat thread's changes to its project folder, and Undo it (parallel threads spec 1 to
// 10). Only the RPC handlers call this, on the user's click after the confirm: the assistant has
// no tool for it. It writes files in the project folder and nothing else there: no commit, index,
// branch or stash is touched, and no hook or filter runs. The copies Undo needs are trees in
// wow's own snapshot store of the project folder.

export interface ApplyDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  // wow's own folder; scratch files of a merge live under it.
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly clock: () => Date;
  readonly snapshots: {
    storeOf(folder: string): string;
    idle(): Promise<void>;
    exclusive<T>(folder: string, task: () => Promise<T>): Promise<T>;
  };
}

// Refused with the reason in words, answered as `rejected` (or `not_found`).
export class ApplyRefused extends Error {
  readonly notFound: boolean;
  constructor(message: string, notFound = false) {
    super(message);
    this.name = 'ApplyRefused';
    this.notFound = notFound;
  }
}

// The folders hold other changes than the confirm showed (spec 6); `preview` is what they hold now.
export class ApplyChanged extends Error {
  readonly preview: ApplyPreview;
  constructor(preview: ApplyPreview) {
    super('The files changed since the confirm was shown; look at the list again.');
    this.name = 'ApplyChanged';
    this.preview = preview;
  }
}

type ThreadRow = typeof threads.$inferSelect;

interface Context {
  readonly thread: ThreadRow;
  readonly projectFolder: string;
  readonly base: string;
}

// One file of the plan, with the bytes to write for `write` and `merge`.
interface Planned {
  readonly file: ApplyFile;
  readonly bytes?: Buffer;
  readonly executable?: boolean;
}

const sha = (text: string) => createHash('sha1').update(text).digest('hex');
const fullPath = (folder: string, relative: string) => path.join(folder, ...relative.split('/'));
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.toSorted().join('\0') === b.toSorted().join('\0');
const oneDay = 86_400_000;
// What git prints per changed path at most, for the output limit of a listing.
const listingBytesPerFile = 4200;
const binary = (bytes: Buffer) => bytes.includes(0);
const refusal = (status: ApplyStatus, message: string): ApplyPreview => ({
  status,
  message,
  projectFolder: null,
  base: null,
  files: [],
});
const refused = (status: ApplyStatus, message: string) => ({ refused: refusal(status, message) });
// Two versions of a file are the same: both absent, or the same bytes.
const same = (a: Buffer | undefined, b: Buffer | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a.equals(b);

export class ThreadApply {
  readonly #deps: ApplyDeps;

  constructor(deps: ApplyDeps) {
    this.#deps = deps;
  }

  #git(): GitRunOptions {
    return {
      timeoutMs: this.#deps.settings.get('chat.snapshotTimeoutMs'),
      stopWaitMs: this.#deps.settings.get('advanced.gitStopWaitMs'),
    };
  }

  #lastTurnState(threadId: string): string | undefined {
    return this.#deps.db
      .select({ state: turns.state })
      .from(turns)
      .where(eq(turns.threadId, threadId))
      .orderBy(desc(turns.index))
      .get()?.state;
  }

  // A turn runs in a thread that works in the project folder itself (spec 5).
  #projectBusy(projectFolder: string): ThreadRow | undefined {
    const key = folderKey(projectFolder, this.#deps.platform);
    return this.#deps.db
      .select()
      .from(threads)
      .all()
      .find(
        (other) =>
          folderKey(other.cwd, this.#deps.platform) === key &&
          this.#lastTurnState(other.id) === 'running',
      );
  }

  #threadRow(threadId: string): ThreadRow {
    const thread = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw new ApplyRefused(`No thread ${threadId}`, true);
    return thread;
  }

  // A helper's copy of another repository comes home to that repository (orchestrator threads
  // spec 5); every other copy to its project's folder.
  #projectFolderOf(thread: ThreadRow): string | undefined {
    if (thread.workingCopy?.repository) return thread.workingCopy.repository;
    if (thread.projectId === null) return undefined;
    return this.#deps.db.select().from(projects).where(eq(projects.id, thread.projectId)).get()
      ?.cwd;
  }

  // Why the folders cannot be written now, as a preview's refusal, or the context. `needCopy` is
  // false for Undo, which only needs the project folder.
  async #context(
    threadId: string,
    needCopy: boolean,
  ): Promise<Context | { readonly refused: ApplyPreview }> {
    const thread = this.#threadRow(threadId);
    if (thread.kind !== 'chat') {
      return refused('notChat', 'Only a chat thread applies its changes.');
    }
    const copy = thread.workingCopy;
    const projectFolder = this.#projectFolderOf(thread);
    if (!copy?.startSha || projectFolder === undefined) {
      return refused(
        'noWorkingCopy',
        'This thread works in the project folder; its changes are already there.',
      );
    }
    if (needCopy && copy.state === 'removed') {
      return refused(
        'noWorkingCopy',
        "The thread's working copy was removed. A message to the thread makes it again on its branch.",
      );
    }
    if (this.#lastTurnState(thread.id) === 'running') {
      return refused('turnRunning', 'A turn is running in this thread. Apply once it has ended.');
    }
    const busy = this.#projectBusy(projectFolder);
    if (busy) {
      return refused(
        'projectBusy',
        `A turn is running in "${busy.title}", which works in the project folder. Apply once it has ended.`,
      );
    }
    for (const folder of needCopy ? [thread.cwd, projectFolder] : [projectFolder]) {
      const found = await lstat(folder).catch(() => undefined);
      if (!found?.isDirectory())
        return refused('folderMissing', `The folder ${folder} is missing.`);
    }
    const repository = await readSnapshotRepository(projectFolder, this.#git());
    if (repository.status !== 'ok') return refused(repository.status, repository.message);
    return { thread, projectFolder, base: copy.startSha };
  }

  // Why a path is not written in `folder`: unsafe by name, or a link or junction on the way.
  async #unsafe(folder: string, relative: string): Promise<boolean> {
    if (unsafeSnapshotPath(relative, this.#deps.platform)) return true;
    let at = folder;
    for (const segment of relative.split('/').slice(0, -1)) {
      at = path.join(at, segment);
      const found = await lstat(at).catch(() => undefined);
      if (!found) return false;
      if (found.isSymbolicLink() || !found.isDirectory()) return true;
    }
    return false;
  }

  // Each changed file with what Apply would do (spec 2, 3).
  async #plan(context: Context): Promise<Planned[]> {
    const { thread, base } = context;
    const git = this.#git();
    const maxFiles = this.#deps.settings.get('chat.snapshotMaxFiles');
    const maxBytes = this.#deps.settings.get('chat.snapshotMaxFileBytes');
    const listed = await listChangedSince(
      thread.cwd,
      base,
      (maxFiles + 1) * listingBytesPerFile,
      git,
    );
    if (!listed.ok)
      throw new ApplyRefused(`git could not list the thread's changes: ${listed.message}`);
    if (listed.paths.length > maxFiles) {
      throw new ApplyRefused(
        `The thread changed more than ${maxFiles} files (Most files in a snapshot); wow does not apply that many.`,
      );
    }
    const tree = await readFolderTree(
      thread.cwd,
      base,
      (maxFiles + 1) * listingBytesPerFile * 4,
      git,
    );
    if (!tree.ok) throw new ApplyRefused(`git could not read the start commit: ${tree.message}`);
    const inBase = new Map(tree.entries.map((entry) => [entry.path, entry]));
    const wanted = listed.paths.flatMap((relative) => {
      const entry = inBase.get(relative);
      return entry && entry.mode !== '120000' && (entry.size ?? 0) <= maxBytes ? [entry.id] : [];
    });
    const blobs = await readFolderBlobs(thread.cwd, wanted, wanted.length * maxBytes, git);
    if (!blobs.ok) throw new ApplyRefused(`git could not read the start commit: ${blobs.message}`);
    const scratch = path.join(this.#deps.home, 'apply-scratch', randomUUID());
    try {
      const planned: Planned[] = [];
      for (const relative of listed.paths) {
        planned.push(
          await this.#planOne(context, relative, inBase.get(relative), blobs.blobs, scratch),
        );
      }
      return planned;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #planOne(
    { thread, projectFolder }: Context,
    relative: string,
    baseEntry: SnapshotEntry | undefined,
    blobs: ReadonlyMap<string, Buffer>,
    scratch: string,
  ): Promise<Planned> {
    const maxBytes = this.#deps.settings.get('chat.snapshotMaxFileBytes');
    const theirsAt = await lstat(fullPath(thread.cwd, relative)).catch(() => undefined);
    const oursAt = await lstat(fullPath(projectFolder, relative)).catch(() => undefined);
    const change: ApplyFile['change'] =
      baseEntry === undefined ? 'added' : theirsAt === undefined ? 'deleted' : 'modified';
    const left = (reason: NonNullable<ApplyFile['reason']>): Planned => ({
      file: { path: relative, change, outcome: 'left', reason },
    });
    if (
      (await this.#unsafe(projectFolder, relative)) ||
      (await this.#unsafe(thread.cwd, relative)) ||
      theirsAt?.isDirectory() ||
      oursAt?.isDirectory()
    ) {
      return left('unsafe');
    }
    if (baseEntry?.mode === '120000' || theirsAt?.isSymbolicLink() || oursAt?.isSymbolicLink()) {
      return left('link');
    }
    if (
      (baseEntry?.size ?? 0) > maxBytes ||
      (theirsAt?.size ?? 0) > maxBytes ||
      (oursAt?.size ?? 0) > maxBytes
    ) {
      return left('tooLarge');
    }
    const base = baseEntry ? (blobs.get(baseEntry.id) ?? Buffer.alloc(0)) : undefined;
    const theirs = theirsAt ? await readFile(fullPath(thread.cwd, relative)) : undefined;
    const ours = oursAt ? await readFile(fullPath(projectFolder, relative)) : undefined;
    const executable =
      this.#deps.platform !== 'win32' && theirsAt !== undefined && (theirsAt.mode & 0o111) !== 0;
    if (same(ours, theirs)) {
      return { file: { path: relative, change, outcome: 'same', reason: null } };
    }
    if (same(ours, base)) {
      return theirs === undefined
        ? { file: { path: relative, change, outcome: 'delete', reason: null } }
        : {
            file: { path: relative, change, outcome: 'write', reason: null },
            bytes: theirs,
            executable,
          };
    }
    // Both sides changed the file since the start commit.
    if (theirs === undefined) return left('deletedThere');
    if (ours === undefined) return left('deletedHere');
    if (binary(theirs) || binary(ours) || (base !== undefined && binary(base))) {
      return left('binary');
    }
    const merged = await mergeFileBytes(
      path.join(scratch, sha(relative)),
      { ours, base: base ?? Buffer.alloc(0), theirs },
      maxBytes * 3,
      this.#git(),
    );
    if (merged === undefined) return left('conflict');
    return {
      file: { path: relative, change, outcome: 'merge', reason: null },
      bytes: merged,
      executable,
    };
  }

  // "Apply to project folder…" (spec 4, 5): what it would do now. Never throws for a refusal.
  async preview(threadId: string): Promise<ApplyPreview> {
    await this.#deps.snapshots.idle();
    const context = await this.#context(threadId, true);
    if ('refused' in context) return context.refused;
    try {
      return this.#previewOf(context, await this.#plan(context));
    } catch (error) {
      return refusal('failed', describe(error));
    }
  }

  #previewOf(context: Context, planned: readonly Planned[]): ApplyPreview {
    const files = planned.map((entry) => entry.file);
    const acting = files.some((file) => file.outcome !== 'same' && file.outcome !== 'left');
    return {
      status: acting ? 'ok' : 'nothing',
      message: acting
        ? null
        : files.length === 0
          ? 'The thread has changed nothing since its working copy was made.'
          : 'Nothing to write: the project folder has these changes already, or they are left for you.',
      projectFolder: context.projectFolder,
      base: context.base.slice(0, 7),
      files,
    };
  }

  // Apply and Undo, after the user's yes (spec 6 to 9).
  async run(
    commandId: string,
    command: Extract<Command, { type: 'thread.applyToProject' | 'thread.undoApply' }>,
  ): Promise<DispatchResult> {
    const receipt = this.#deps.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.commandId, commandId))
      .get();
    if (receipt) return { commandId, seqs: receipt.seqs, duplicate: true };
    await this.#deps.snapshots.idle();
    const thread = this.#threadRow(command.threadId);
    const projectFolder = this.#projectFolderOf(thread);
    if (projectFolder === undefined) {
      throw new ApplyRefused(
        'This thread works in the project folder; its changes are already there.',
      );
    }
    return this.#deps.snapshots.exclusive(projectFolder, async () => {
      const context = await this.#context(
        command.threadId,
        command.type === 'thread.applyToProject',
      );
      if ('refused' in context) {
        throw new ApplyRefused(context.refused.message ?? context.refused.status);
      }
      const applied =
        command.type === 'thread.applyToProject'
          ? await this.#apply(context, command.confirmed, commandId)
          : await this.#undo(context, command.itemId);
      return this.#deps.engine.dispatch(commandId, {
        type: 'thread.changesApplied',
        threadId: command.threadId,
        applied,
      });
    });
  }

  async #store(folder: string): Promise<string> {
    const store = this.#deps.snapshots.storeOf(folder);
    await mkdir(path.dirname(store), { recursive: true });
    const head = await lstat(path.join(store, 'HEAD')).catch(() => undefined);
    if (!head) {
      const made = await initSnapshotStore(store, this.#git());
      if (!made.ok) throw new ApplyRefused(`wow could not make its store: ${made.message}`);
    }
    return store;
  }

  // The tree of the files at `paths` in `folder` as they are now; absent files are left out.
  async #treeOf(store: string, folder: string, paths: readonly string[]): Promise<string> {
    const present: { path: string; mode: string }[] = [];
    for (const relative of paths) {
      const found = await lstat(fullPath(folder, relative)).catch(() => undefined);
      if (!found?.isFile()) continue;
      const executable = this.#deps.platform !== 'win32' && (found.mode & 0o111) !== 0;
      present.push({ path: relative, mode: executable ? '100755' : '100644' });
    }
    const git = this.#git();
    const hashed = await hashSnapshotFiles(
      store,
      folder,
      present.map((entry) => fullPath(folder, entry.path)),
      git,
    );
    if (!hashed.ok)
      throw new ApplyRefused(`wow could not keep a copy of the files: ${hashed.message}`);
    const scratch = path.join(store, 'wow-scratch', randomUUID());
    await mkdir(scratch, { recursive: true });
    try {
      const tree = await writeSnapshotTree(
        store,
        path.join(scratch, 'index'),
        present.map((entry, index) => ({
          mode: entry.mode,
          id: hashed.ids[index] ?? '',
          path: entry.path,
        })),
        git,
      );
      if (!tree.ok)
        throw new ApplyRefused(`wow could not keep a copy of the files: ${tree.message}`);
      return tree.tree;
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Drops the copies of applies older than `chat.snapshotKeepDays`; their Undo is refused then.
  async #expire(store: string): Promise<void> {
    const cutoff =
      this.#deps.clock().getTime() - this.#deps.settings.get('chat.snapshotKeepDays') * oneDay;
    const refs = await listSnapshotRefs(store, 'refs/applies/', this.#git());
    if (!refs.ok) return;
    const old = refs.refs.filter((ref) => {
      const at = Number(/^refs\/applies\/(\d+)-/.exec(ref)?.[1] ?? Number.NaN);
      return Number.isFinite(at) && at < cutoff;
    });
    const dropped = await updateSnapshotRefs(
      store,
      old.map((ref) => ({ ref, id: null })),
      this.#git(),
    );
    if (!dropped.ok) this.#deps.logger.warn('old apply copies were not dropped', dropped.message);
  }

  async #removeEmptyFolders(folder: string, relative: string): Promise<void> {
    let dir = path.dirname(fullPath(folder, relative));
    while (path.relative(folder, dir) !== '' && !path.relative(folder, dir).startsWith('..')) {
      const gone = await rmdir(dir).then(
        () => true,
        () => false,
      );
      if (!gone) break;
      dir = path.dirname(dir);
    }
  }

  async #apply(
    context: Context,
    confirmed: ApplyConfirmed,
    commandId: string,
  ): Promise<ChangesAppliedItemPayload> {
    const planned = await this.#plan(context);
    const preview = this.#previewOf(context, planned);
    const found = applyConfirmedOf(preview);
    if (
      !sameList(found.write, confirmed.write) ||
      !sameList(found.merge, confirmed.merge) ||
      !sameList(found.left, confirmed.left)
    ) {
      throw new ApplyChanged(preview);
    }
    if (preview.status !== 'ok') throw new ApplyRefused(preview.message ?? 'Nothing to apply.');
    const { projectFolder } = context;
    const acting = planned.filter(
      (entry) =>
        entry.file.outcome === 'write' ||
        entry.file.outcome === 'merge' ||
        entry.file.outcome === 'delete',
    );
    const touched = acting.map((entry) => entry.file.path);
    const store = await this.#store(projectFolder);
    await this.#expire(store);
    const before = await this.#treeOf(store, projectFolder, touched);
    const written: string[] = [];
    const merged: string[] = [];
    const removed: string[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const entry of acting) {
      const target = fullPath(projectFolder, entry.file.path);
      try {
        if (entry.file.outcome === 'delete') {
          await unlink(target);
          await this.#removeEmptyFolders(projectFolder, entry.file.path);
          removed.push(entry.file.path);
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.bytes ?? Buffer.alloc(0));
        if (this.#deps.platform !== 'win32') {
          const mode = (await lstat(target)).mode & 0o777;
          await chmod(target, entry.executable ? mode | 0o111 : mode & ~0o111);
        }
        (entry.file.outcome === 'merge' ? merged : written).push(entry.file.path);
      } catch (error) {
        failed.push({ path: entry.file.path, message: describe(error) });
      }
    }
    const after = await this.#treeOf(store, projectFolder, touched);
    const at = this.#deps.clock();
    const savedAs = `${at.getTime()}-${sha(commandId)}`;
    const kept = await updateSnapshotRefs(
      store,
      [
        { ref: `refs/applies/${savedAs}/before`, id: before },
        { ref: `refs/applies/${savedAs}/after`, id: after },
      ],
      this.#git(),
    );
    if (!kept.ok) this.#deps.logger.warn('the copies for Undo were not kept', kept.message);
    return {
      projectFolder,
      base: context.base.slice(0, 7),
      written,
      merged,
      removed,
      left: planned
        .filter((entry) => entry.file.outcome === 'left')
        .map((entry) => ({
          path: entry.file.path,
          reason: applyLeftWords[entry.file.reason ?? 'conflict'],
        })),
      failed,
      ...(kept.ok ? { savedAs } : {}),
      at: at.toISOString(),
    };
  }

  // Undo (spec 9): each file Apply wrote or deleted goes back when it still holds what Apply
  // left; one changed since is left and named.
  async #undo(context: Context, itemId: string): Promise<ChangesAppliedItemPayload> {
    const { thread, projectFolder } = context;
    const item = this.#deps.db
      .select()
      .from(threadItems)
      .where(and(eq(threadItems.id, itemId), eq(threadItems.threadId, thread.id)))
      .get();
    const newest = this.#deps.db
      .select({ id: threadItems.id })
      .from(threadItems)
      .where(and(eq(threadItems.threadId, thread.id), eq(threadItems.kind, 'changes_applied')))
      .orderBy(desc(threadItems.index))
      .get();
    const parsed = ChangesAppliedItemPayload.safeParse(item?.payload);
    if (!item || item.kind !== 'changes_applied' || !parsed.success) {
      throw new ApplyRefused(`No apply line ${itemId} in this thread`, true);
    }
    const applied = parsed.data;
    if (!undoableApply(item, newest?.id) || applied.savedAs === undefined) {
      throw new ApplyRefused('Only the newest apply of a thread is undone, once.');
    }
    const store = await this.#store(projectFolder);
    const git = this.#git();
    const maxBytes = this.#deps.settings.get('chat.snapshotMaxFileBytes');
    const read = async (side: 'before' | 'after') => {
      const tree = await readSnapshotTree(
        store,
        `refs/applies/${applied.savedAs}/${side}`,
        64 * 1024 * 1024,
        git,
      );
      if (!tree.ok) {
        throw new ApplyRefused(
          `wow no longer holds the files as they were before this apply (they are kept for ${this.#deps.settings.get('chat.snapshotKeepDays')} days), so it cannot be undone.`,
        );
      }
      return new Map(tree.entries.map((entry) => [entry.path, entry]));
    };
    const beforeFiles = await read('before');
    const afterFiles = await read('after');
    const touched = [...applied.written, ...applied.merged, ...applied.removed];
    const present = [];
    for (const relative of touched) {
      const found = await lstat(fullPath(projectFolder, relative)).catch(() => undefined);
      if (found?.isFile()) present.push(relative);
    }
    const hashed = await hashSnapshotFiles(
      store,
      projectFolder,
      present.map((relative) => fullPath(projectFolder, relative)),
      git,
    );
    if (!hashed.ok) throw new ApplyRefused(`wow could not read the files: ${hashed.message}`);
    const now = new Map(present.map((relative, index) => [relative, hashed.ids[index]]));
    const back = [...beforeFiles.values()].filter((entry) => touched.includes(entry.path));
    const blobs = await readSnapshotBlobs(
      store,
      back.map((entry) => entry.id),
      back.length * maxBytes,
      git,
    );
    if (!blobs.ok) throw new ApplyRefused(`wow could not read its copy: ${blobs.message}`);
    const written: string[] = [];
    const removed: string[] = [];
    const left: { path: string; reason: string }[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const relative of touched) {
      const after = afterFiles.get(relative);
      const current = now.get(relative);
      if (after === undefined ? current !== undefined : after.id !== current) {
        left.push({ path: relative, reason: 'changed since Apply' });
        continue;
      }
      if (await this.#unsafe(projectFolder, relative)) {
        left.push({ path: relative, reason: applyLeftWords.unsafe });
        continue;
      }
      const target = fullPath(projectFolder, relative);
      const was = beforeFiles.get(relative);
      try {
        if (was === undefined) {
          if (current !== undefined) {
            await unlink(target);
            await this.#removeEmptyFolders(projectFolder, relative);
          }
          removed.push(relative);
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, blobs.blobs.get(was.id) ?? Buffer.alloc(0));
        if (this.#deps.platform !== 'win32') {
          const mode = (await lstat(target)).mode & 0o777;
          await chmod(target, was.mode === '100755' ? mode | 0o111 : mode & ~0o111);
        }
        written.push(relative);
      } catch (error) {
        failed.push({ path: relative, message: describe(error) });
      }
    }
    return {
      projectFolder,
      base: applied.base,
      written,
      merged: [],
      removed,
      left,
      failed,
      undoOf: itemId,
      at: this.#deps.clock().toISOString(),
    };
  }
}
