import {
  FilesRestoredItemPayload,
  isTurnSnapshot,
  undoableRestore,
  type Command,
  type DispatchResult,
  type OmittedFile,
  type RestoreConfirmed,
  type RestorePreview,
  type RestorePreviewParams,
  type RestoreRefusal,
  type SnapshotAt,
  type StoredSnapshot,
  type TurnSnapshot,
} from '@wow/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { commandReceipts, restorePoints, threadItems, threads, turns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import {
  hashSnapshotFiles,
  initSnapshotStore,
  listSnapshotFiles,
  pruneSnapshotStore,
  readSnapshotBlobs,
  readSnapshotRepository,
  readSnapshotTree,
  updateSnapshotRefs,
  writeSnapshotTree,
  type GitRunOptions,
  type SnapshotEntry,
} from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import { folderKey } from './folder-key.js';

// Snapshots of a chat thread's folder and restores from them (thread work spec 19 to 26). A
// snapshot is a tree in wow's own bare repository for the folder, `<home>/snapshots/<key>.git`,
// kept by a ref per turn; the user's repository is only listed. Everything for one folder runs
// one after the other, so a restore never meets a snapshot half taken.

export interface SnapshotDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly clock: () => Date;
}

// Refused with the reason in words; `status` is the preview's.
export class RestoreRefused extends Error {
  readonly status: RestoreRefusal | 'notFound';
  constructor(status: RestoreRefusal | 'notFound', message: string) {
    super(message);
    this.status = status;
  }
}

// The folder holds other files than the confirm showed (spec 22); `preview` is what it holds now.
export class RestoreChanged extends Error {
  readonly preview: RestorePreview;
  constructor(preview: RestorePreview) {
    super('The files changed since the confirm was shown; look at the list again.');
    this.preview = preview;
  }
}

type Taken = TurnSnapshot | { readonly missing: string };

interface ManifestEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: string;
  readonly id: string;
}

// What the last snapshot of the folder read, so the next hashes only files that changed since.
interface Manifest {
  // When that snapshot began reading, in the file system's clock as seen through a scratch file.
  readonly readAt: number;
  readonly files: Readonly<Record<string, ManifestEntry>>;
}

interface Plan {
  readonly write: string[];
  readonly remove: string[];
  readonly outside: string[];
  readonly notRestorable: OmittedFile[];
  readonly target: ReadonlyMap<string, SnapshotEntry>;
}

interface Prepared {
  readonly folder: string;
  readonly store: string;
  readonly now: TurnSnapshot;
  readonly plan: Plan;
}

const oneDay = 86_400_000;
// What git prints per file in a listing at most, for the output limits of its answers.
const listingBytesPerFile = 4200;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const turnRef = (turnId: string, at: SnapshotAt) => `refs/turns/${sha(turnId).slice(0, 40)}-${at}`;
const treeRef = (tree: string) => `refs/trees/${tree}`;
const fullPath = (folder: string, relative: string) => path.join(folder, ...relative.split('/'));
const sorted = (paths: Iterable<string>) => [...paths].toSorted();
const sameList = (a: readonly string[], b: readonly string[]) => {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameEntry = (a: SnapshotEntry | undefined, b: SnapshotEntry | undefined) =>
  a !== undefined && b !== undefined && a.mode === b.mode && a.id === b.id;

const windowsReserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Why a path from a snapshot or from Git may not be written in the folder, or undefined. A
// name is a literal path; nothing in it may climb out or mean something else on Windows.
export function unsafeSnapshotPath(
  relative: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (relative === '' || relative.includes('\0')) return 'an empty name';
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return 'a full path';
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'a name that climbs out of the folder';
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return "a name inside Git's own folder";
  }
  if (platform === 'win32') {
    for (const segment of segments) {
      if (/[\\:*?"<>|]/.test(segment) || [...segment].some((char) => char.charCodeAt(0) < 32)) {
        return 'a name Windows does not take';
      }
      if (/[. ]$/.test(segment) || windowsReserved.test(segment)) {
        return 'a name Windows does not take';
      }
    }
  }
  return undefined;
}

const refusedPreview = (status: RestoreRefusal, message: string): RestorePreview => ({
  status,
  message,
  write: [],
  remove: [],
  outside: [],
  notRestorable: [],
});

export class FolderSnapshots {
  readonly #deps: SnapshotDeps;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #work = new Set<Promise<unknown>>();
  #stopped = false;

  constructor(deps: SnapshotDeps) {
    this.#deps = deps;
  }

  storeOf(folder: string): string {
    const key = sha(folderKey(folder, this.#deps.platform)).slice(0, 32);
    return path.join(this.#deps.home, 'snapshots', `${key}.git`);
  }

  // Resolves once everything started so far has finished (for tests).
  async idle(): Promise<void> {
    while (this.#work.size > 0) await Promise.allSettled(this.#work);
  }

  // Waits for the snapshots in flight, their records and the expiry after them, and starts none
  // after this is called: nothing touches the store or the database once it resolves.
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.idle();
  }

  // A job counts as work until its last step, not only while its folder's queue runs.
  #tracked<T>(job: Promise<T>): Promise<T> {
    const kept = job.then(
      () => undefined,
      () => undefined,
    );
    this.#work.add(kept);
    void kept.then(() => this.#work.delete(kept));
    return job;
  }

  // One folder at a time; a task that fails does not stop the next.
  #serial<T>(folder: string, task: () => Promise<T>): Promise<T> {
    const key = folderKey(folder, this.#deps.platform);
    const before = this.#queues.get(key) ?? Promise.resolve();
    const next = before.then(task, task);
    const kept = next.catch(() => undefined);
    this.#queues.set(key, kept);
    this.#work.add(kept);
    void kept.then(() => {
      this.#work.delete(kept);
      if (this.#queues.get(key) === kept) this.#queues.delete(key);
    });
    return next;
  }

  #git(deadline: number): GitRunOptions {
    return {
      timeoutMs: Math.max(1, deadline - Date.now()),
      stopWaitMs: this.#deps.settings.get('advanced.gitStopWaitMs'),
    };
  }

  #deadline(): number {
    return Date.now() + this.#deps.settings.get('chat.snapshotTimeoutMs');
  }

  #thread(threadId: string) {
    return this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
  }

  // Only a chat thread's files are kept and put back: a workflow step's thread works in its
  // run's folder and the Assistant in wow's own (spec 23).
  #isChat(thread: { readonly kind: string; readonly runId: string | null }): boolean {
    return thread.kind === 'chat' && thread.runId === null;
  }

  // The provider service, as a chat thread's turn starts (awaited, so the agent starts on the
  // folder as it was read) and after it ends. Never throws: a turn goes on without a snapshot.
  // The folder's queue is joined before the first await, so what is asked after this call
  // (the next turn's start, a restore) sees this snapshot.
  take(threadId: string, turnId: string, at: SnapshotAt): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#tracked(this.#take(threadId, turnId, at));
  }

  #take(threadId: string, turnId: string, at: SnapshotAt): Promise<void> {
    const thread = this.#thread(threadId);
    if (!thread || !this.#isChat(thread)) return Promise.resolve();
    const snapshot = this.#serial(thread.cwd, async (): Promise<StoredSnapshot> => {
      const on = this.#deps.settings.get(
        'chat.snapshots',
        thread.projectId === null ? {} : { projectId: thread.projectId },
      );
      if (!on) {
        return {
          missing:
            "Snapshots of the files are off for this thread's project (Keep snapshots of the files).",
        };
      }
      const store = this.storeOf(thread.cwd);
      const taken = await this.#takeIn(thread.cwd, store);
      if (!isTurnSnapshot(taken)) return taken;
      const kept = await updateSnapshotRefs(
        store,
        [{ ref: turnRef(turnId, at), id: taken.tree }],
        this.#git(this.#deadline()),
      );
      return kept.ok ? taken : { missing: `wow could not keep the snapshot: ${kept.message}` };
    }).catch((error: unknown): StoredSnapshot => ({
      missing: `wow could not read the folder: ${describe(error)}`,
    }));
    return snapshot.then(async (stored) => {
      this.#record(threadId, turnId, at, stored);
      if (at === 'end') {
        await this.expire().catch((error: unknown) =>
          this.#deps.logger.warn('old snapshots were not dropped', describe(error)),
        );
      }
    });
  }

  #record(threadId: string, turnId: string, at: SnapshotAt, snapshot: StoredSnapshot): void {
    try {
      this.#deps.engine.dispatch(`snapshot:${turnId}:${at}`, {
        type: 'thread.snapshotTaken',
        threadId,
        turnId,
        at,
        snapshot,
      });
    } catch (error) {
      this.#deps.logger.warn('the snapshot was not recorded', describe(error));
    }
  }

  // Reads the folder into the store: the tree, unreferenced until a ref keeps it.
  async #takeIn(folder: string, store: string): Promise<Taken> {
    const deadline = this.#deadline();
    const timeoutMs = this.#deps.settings.get('chat.snapshotTimeoutMs');
    const outOfTime = {
      missing: `Reading the folder took longer than ${timeoutMs} ms (Time to take a snapshot), so no snapshot was kept.`,
    };
    const repository = await readSnapshotRepository(folder, this.#git(deadline));
    if (repository.status !== 'ok') return { missing: repository.message };
    const maxFiles = this.#deps.settings.get('chat.snapshotMaxFiles');
    const tooMany = {
      missing: `The folder has more than ${maxFiles} files (Most files in a snapshot), so no snapshot was kept.`,
    };
    const listed = await listSnapshotFiles(
      folder,
      (maxFiles + 1) * listingBytesPerFile,
      this.#git(deadline),
    );
    if (!listed.ok) {
      if (Date.now() >= deadline) return outOfTime;
      return listed.message === 'git wrote more than wow reads'
        ? tooMany
        : { missing: listed.message };
    }
    if (listed.paths.length > maxFiles) return tooMany;
    const maxBytes = this.#deps.settings.get('chat.snapshotMaxFileBytes');
    await mkdir(path.dirname(store), { recursive: true });
    const head = await lstat(path.join(store, 'HEAD')).catch(() => undefined);
    if (!head) {
      const made = await initSnapshotStore(store, this.#git(deadline));
      if (!made.ok) return { missing: `wow could not make its snapshot store: ${made.message}` };
    }
    const manifest = await this.#manifest(store);
    const scratch = path.join(store, 'wow-scratch', randomUUID());
    await mkdir(scratch, { recursive: true });
    try {
      // The file system's own time now: a file changed in the same tick as the last read is
      // hashed again, since its time alone cannot tell (Git's "racily clean" rule).
      const clockFile = path.join(scratch, 'now');
      await writeFile(clockFile, '');
      const readAt = (await lstat(clockFile)).mtimeMs;
      const entries: SnapshotEntry[] = [];
      const omitted: OmittedFile[] = [];
      const hash: { path: string; source: string; mode: string; size: number; mtimeMs: number }[] =
        [];
      const next: Record<string, ManifestEntry> = {};
      let links = 0;
      for (const relative of listed.paths) {
        if (Date.now() >= deadline) return outOfTime;
        // A name git cannot take on stdin, or one this system cannot write back, is left out.
        if (relative.includes('\n') || unsafeSnapshotPath(relative, this.#deps.platform)) {
          omitted.push({ path: relative, size: 0 });
          continue;
        }
        const file = fullPath(folder, relative);
        const found = await lstat(file).catch(() => undefined);
        // Deleted since git listed it, a submodule or a nested repository's folder.
        if (!found || found.isDirectory()) continue;
        if (found.isSymbolicLink()) {
          // Kept as the link's own text and never followed.
          const target = await readlink(file, { encoding: 'buffer' });
          const source = path.join(scratch, `link-${(links += 1)}`);
          await writeFile(source, target);
          hash.push({ path: relative, source, mode: '120000', size: target.length, mtimeMs: -1 });
          continue;
        }
        if (!found.isFile()) continue;
        if (found.size > maxBytes) {
          omitted.push({ path: relative, size: found.size });
          continue;
        }
        const known = manifest?.files[relative];
        // Windows has no executable bit; the mode the file had in the last snapshot stays.
        const mode =
          this.#deps.platform === 'win32'
            ? (known?.mode ?? '100644')
            : (found.mode & 0o111) !== 0
              ? '100755'
              : '100644';
        if (
          manifest &&
          known &&
          known.size === found.size &&
          known.mtimeMs === found.mtimeMs &&
          known.mode === mode &&
          found.mtimeMs < manifest.readAt
        ) {
          entries.push({ mode, id: known.id, path: relative });
          next[relative] = known;
          continue;
        }
        hash.push({ path: relative, source: file, mode, size: found.size, mtimeMs: found.mtimeMs });
      }
      const hashed = await hashSnapshotFiles(
        store,
        folder,
        hash.map((entry) => entry.source),
        this.#git(deadline),
      );
      if (!hashed.ok) return Date.now() >= deadline ? outOfTime : { missing: hashed.message };
      hash.forEach((entry, index) => {
        const id = hashed.ids[index] ?? '';
        entries.push({ mode: entry.mode, id, path: entry.path });
        if (entry.mode !== '120000') {
          next[entry.path] = { size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, id };
        }
      });
      const tree = await writeSnapshotTree(
        store,
        path.join(scratch, 'index'),
        entries,
        this.#git(deadline),
      );
      if (!tree.ok) return Date.now() >= deadline ? outOfTime : { missing: tree.message };
      const kept: Manifest = { readAt, files: next };
      await writeFile(path.join(store, 'wow-manifest.json'), JSON.stringify(kept));
      return {
        tree: tree.tree,
        files: entries.length,
        omitted,
        at: this.#deps.clock().toISOString(),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #manifest(store: string): Promise<Manifest | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(store, 'wow-manifest.json'), 'utf8'),
      );
      if (
        parsed &&
        typeof parsed === 'object' &&
        'readAt' in parsed &&
        typeof parsed.readAt === 'number' &&
        'files' in parsed &&
        parsed.files &&
        typeof parsed.files === 'object'
      ) {
        return parsed as Manifest;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // What restoring would do now (spec 22, 23); nothing is written to the folder.
  async preview(params: RestorePreviewParams): Promise<RestorePreview> {
    const thread = this.#thread(params.threadId);
    if (!thread) throw new RestoreRefused('notFound', `No thread ${params.threadId}`);
    return this.#serial(thread.cwd, async () => {
      try {
        const { plan } = await this.#prepare(params, false);
        return {
          status: 'ok' as const,
          message: null,
          write: plan.write,
          remove: plan.remove,
          outside: plan.outside,
          notRestorable: plan.notRestorable,
        };
      } catch (error) {
        if (!(error instanceof RestoreRefused) || error.status === 'notFound') throw error;
        return refusedPreview(error.status, error.message);
      }
    });
  }

  // The target, the folder as it is now and what changes, or why it cannot be restored.
  async #prepare(params: RestorePreviewParams, forEdit: boolean): Promise<Prepared> {
    const thread = this.#thread(params.threadId);
    if (!thread) throw new RestoreRefused('notFound', `No thread ${params.threadId}`);
    if (!this.#isChat(thread)) {
      throw new RestoreRefused(
        'notChat',
        "Files are put back only in a chat thread; a workflow step's thread and the Assistant keep theirs.",
      );
    }
    const all = this.#deps.db
      .select()
      .from(turns)
      .where(eq(turns.threadId, thread.id))
      .orderBy(asc(turns.index))
      .all();
    // Edit's own turn is running already: it waits for this restore before it goes out.
    if (!forEdit && all.some((turn) => turn.state === 'running')) {
      throw new RestoreRefused(
        'turnRunning',
        'A turn is running in this thread; stop it or let it end before the files are put back.',
      );
    }
    const deadline = this.#deadline();
    const repository = await readSnapshotRepository(thread.cwd, this.#git(deadline));
    if (repository.status !== 'ok') throw new RestoreRefused(repository.status, repository.message);
    const keepDays = this.#deps.settings.get('chat.snapshotKeepDays');
    const cutoff = this.#deps.clock().getTime() - keepDays * oneDay;
    const expired = `The snapshot was dropped: wow keeps them for ${keepDays} days (Keep snapshots for).`;
    let target: TurnSnapshot;
    let reference: TurnSnapshot | null;
    if ('turnId' in params) {
      const turn = all.find((candidate) => candidate.id === params.turnId);
      if (!turn) throw new RestoreRefused('notFound', `No turn ${params.turnId}`);
      const start = turn.startSnapshot;
      if (start === null) {
        throw new RestoreRefused(
          'noSnapshot',
          'wow kept no snapshot of the files before this message (it was sent before wow kept them), so only the conversation can go back.',
        );
      }
      if (!isTurnSnapshot(start)) throw new RestoreRefused('noSnapshot', start.missing);
      if (Date.parse(start.at) < cutoff) throw new RestoreRefused('noSnapshot', expired);
      target = start;
      reference = this.#reference(thread.id, all);
    } else {
      const item = this.#deps.db
        .select()
        .from(threadItems)
        .where(and(eq(threadItems.id, params.undoItemId), eq(threadItems.threadId, thread.id)))
        .get();
      if (!item || item.kind !== 'files_restored') {
        throw new RestoreRefused('notFound', `No restore ${params.undoItemId}`);
      }
      const newest = this.#deps.db
        .select({ id: threadItems.id })
        .from(threadItems)
        .where(and(eq(threadItems.threadId, thread.id), eq(threadItems.kind, 'files_restored')))
        .orderBy(desc(threadItems.index))
        .get();
      if (!undoableRestore(item, newest?.id, all.at(-1))) {
        throw new RestoreRefused(
          'noSnapshot',
          'Undo is offered until the next turn starts or another restore is made.',
        );
      }
      const point = this.#deps.db
        .select()
        .from(restorePoints)
        .where(eq(restorePoints.itemId, item.id))
        .get();
      if (!point?.before) {
        throw new RestoreRefused('noSnapshot', 'wow could not read the files before that restore.');
      }
      if (Date.parse(point.before.at) < cutoff) throw new RestoreRefused('noSnapshot', expired);
      target = point.before;
      reference = point.after;
    }
    const folder = thread.cwd;
    const store = this.storeOf(folder);
    const now = await this.#takeIn(folder, store);
    if (!isTurnSnapshot(now)) {
      throw new RestoreRefused(
        'noSnapshot',
        `wow could not read the folder as it is now: ${now.missing}`,
      );
    }
    const plan = await this.#plan(folder, store, target, now, reference, deadline);
    for (const relative of [...plan.write, ...plan.remove]) {
      const why = await this.#leadsOutside(folder, relative);
      if (why !== undefined) {
        throw new RestoreRefused(
          'outside',
          `${relative} ${why}, so nothing is put back. wow writes only inside the thread's folder.`,
        );
      }
    }
    return { folder, store, now, plan };
  }

  // The state the thread left the folder in: its last restore when one came after its last
  // turn's end, else that end's snapshot. Changes since were made outside the thread.
  #reference(
    threadId: string,
    all: readonly {
      readonly endedAt: string | null;
      readonly endSnapshot: StoredSnapshot | null;
    }[],
  ): TurnSnapshot | null {
    const ended = all.findLast((turn) => turn.endedAt !== null);
    const point = this.#deps.db
      .select()
      .from(restorePoints)
      .where(eq(restorePoints.threadId, threadId))
      .orderBy(desc(restorePoints.at))
      .get();
    const end = ended && isTurnSnapshot(ended.endSnapshot) ? ended.endSnapshot : null;
    if (point?.after && (!ended?.endedAt || point.at >= ended.endedAt)) return point.after;
    return end;
  }

  async #entries(store: string, snapshot: TurnSnapshot, deadline: number) {
    const listed = await readSnapshotTree(
      store,
      snapshot.tree,
      (snapshot.files + 1) * listingBytesPerFile,
      this.#git(deadline),
    );
    if (!listed.ok) {
      throw new RestoreRefused('noSnapshot', `wow could not read its snapshot: ${listed.message}`);
    }
    return new Map(listed.entries.map((entry) => [entry.path, entry]));
  }

  async #plan(
    folder: string,
    store: string,
    target: TurnSnapshot,
    now: TurnSnapshot,
    reference: TurnSnapshot | null,
    deadline: number,
  ): Promise<Plan> {
    const wanted = await this.#entries(store, target, deadline);
    const present = await this.#entries(store, now, deadline);
    // A reference wow cannot read any more only means nothing is told apart as outside.
    const before = reference
      ? await this.#entries(store, reference, deadline).catch(() => undefined)
      : undefined;
    const tooLarge = new Set(target.omitted.map((file) => file.path));
    const largeNow = new Map(now.omitted.map((file) => [file.path, file.size]));
    const write: string[] = [];
    for (const [file, entry] of wanted) {
      if (!largeNow.has(file) && sameEntry(entry, present.get(file))) continue;
      // Not listed now but on disk: Git ignores it now, and an ignored file is never touched.
      if (
        !largeNow.has(file) &&
        !present.has(file) &&
        (await lstat(fullPath(folder, file)).catch(() => undefined))
      ) {
        continue;
      }
      write.push(file);
    }
    const remove = [...present.keys(), ...largeNow.keys()].filter(
      (file) => !wanted.has(file) && !tooLarge.has(file),
    );
    const touched = new Set([...write, ...remove]);
    const largeBefore = new Map(reference?.omitted.map((file) => [file.path, file.size]));
    const outside = before
      ? [...touched].filter((file) => {
          if (largeBefore.has(file) || largeNow.has(file)) {
            return largeBefore.get(file) !== largeNow.get(file);
          }
          return before.has(file) || present.has(file)
            ? !sameEntry(before.get(file), present.get(file))
            : false;
        })
      : [];
    return {
      write: sorted(write),
      remove: sorted(new Set(remove)),
      outside: sorted(outside),
      notRestorable: target.omitted.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      target: wanted,
    };
  }

  // A path is written only through folders of the thread's own: no link or junction on the way.
  async #leadsOutside(folder: string, relative: string): Promise<string | undefined> {
    const unsafe = unsafeSnapshotPath(relative, this.#deps.platform);
    if (unsafe) return `is ${unsafe}`;
    let at = folder;
    for (const segment of relative.split('/').slice(0, -1)) {
      at = path.join(at, segment);
      const found = await lstat(at).catch(() => undefined);
      if (!found) return undefined;
      if (found.isSymbolicLink()) return 'leads through a link or junction';
      if (!found.isDirectory()) return undefined;
    }
    return undefined;
  }

  // "Restore files to here" and Undo (spec 20, 24), after the user's yes.
  async restore(
    commandId: string,
    command: Extract<Command, { type: 'thread.restoreFiles' | 'thread.undoRestore' }>,
  ): Promise<DispatchResult> {
    const receipt = this.#deps.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.commandId, commandId))
      .get();
    if (receipt) return { commandId, seqs: receipt.seqs, duplicate: true };
    const thread = this.#thread(command.threadId);
    if (!thread) throw new RestoreRefused('notFound', `No thread ${command.threadId}`);
    return this.#serial(thread.cwd, async () => {
      const params: RestorePreviewParams =
        command.type === 'thread.restoreFiles'
          ? { threadId: command.threadId, turnId: command.turnId }
          : { threadId: command.threadId, undoItemId: command.itemId };
      const prepared = await this.#prepare(params, false);
      this.#check(prepared, command.confirmed);
      const toTurnId =
        command.type === 'thread.restoreFiles'
          ? command.turnId
          : (FilesRestoredItemPayload.safeParse(
              this.#deps.db
                .select()
                .from(threadItems)
                .where(eq(threadItems.id, command.itemId))
                .get()?.payload,
            ).data?.toTurnId ?? command.itemId);
      const done = await this.#apply(prepared);
      return this.#deps.engine.dispatch(commandId, {
        type: 'thread.filesRestored',
        threadId: command.threadId,
        restore: {
          toTurnId,
          ...done.outcome,
          ...(command.type === 'thread.undoRestore' ? { undoOf: command.itemId } : {}),
          at: this.#deps.clock().toISOString(),
        },
        before: prepared.now,
        after: done.after,
      });
    });
  }

  // Edit's "Conversation and files" (spec 21), from the provider service before the turn goes
  // out: the reason it could not, or undefined once the files are back.
  async restoreForEdit(
    threadId: string,
    turnId: string,
    toTurnId: string,
    confirmed: RestoreConfirmed,
  ): Promise<string | undefined> {
    const thread = this.#thread(threadId);
    if (!thread) return `No thread ${threadId}`;
    try {
      return await this.#serial(thread.cwd, async () => {
        const prepared = await this.#prepare({ threadId, turnId: toTurnId }, true);
        this.#check(prepared, confirmed);
        const done = await this.#apply(prepared);
        this.#deps.engine.dispatch(`edit-restore:${turnId}`, {
          type: 'thread.filesRestored',
          threadId,
          restore: { toTurnId, ...done.outcome, edit: true, at: this.#deps.clock().toISOString() },
          before: prepared.now,
          after: done.after,
        });
        const failed = done.outcome.failed;
        if (failed.length === 0) return undefined;
        return `${failed.length} of the files could not be put back (${failed
          .map((file) => `${file.path}: ${file.message}`)
          .join('; ')}), so the message was not sent.`;
      });
    } catch (error) {
      return `The files were not put back, so the message was not sent: ${describe(error)}`;
    }
  }

  // The confirm showed these lists; anything else changed meanwhile and is asked about again.
  #check(prepared: Prepared, confirmed: RestoreConfirmed): void {
    const { plan } = prepared;
    const large = plan.notRestorable.map((file) => file.path);
    if (sameList(plan.outside, confirmed.outside) && sameList(large, confirmed.notRestorable)) {
      return;
    }
    throw new RestoreChanged({
      status: 'ok',
      message: null,
      write: plan.write,
      remove: plan.remove,
      outside: plan.outside,
      notRestorable: plan.notRestorable,
    });
  }

  // The bytes of the entries, read a part at a time so no more than about one large file's worth
  // is held beyond what is being written.
  async #blobs(store: string, entries: readonly SnapshotEntry[], deadline: number) {
    const limit = this.#deps.settings.get('chat.snapshotMaxFileBytes');
    const blobs = new Map<string, Buffer>();
    let part: SnapshotEntry[] = [];
    let size = 0;
    const flush = async () => {
      if (part.length === 0) return;
      const read = await readSnapshotBlobs(
        store,
        part.map((entry) => entry.id),
        size,
        this.#git(deadline),
      );
      if (!read.ok) {
        throw new RestoreRefused('noSnapshot', `wow could not read its snapshot: ${read.message}`);
      }
      for (const [id, bytes] of read.blobs) blobs.set(id, bytes);
      part = [];
      size = 0;
    };
    for (const entry of entries) {
      if (size > 0 && size + (entry.size ?? 0) > limit) await flush();
      part.push(entry);
      size += entry.size ?? 0;
    }
    await flush();
    return blobs;
  }

  // Writes the target's bytes and deletes what it did not have; folders a delete leaves empty go.
  // What the system refuses (a file held open on Windows) is listed and the rest goes on.
  async #apply(prepared: Prepared): Promise<{
    readonly outcome: Pick<FilesRestoredItemPayload, 'written' | 'removed' | 'failed'>;
    readonly after: TurnSnapshot | null;
  }> {
    const { folder, store, plan, now } = prepared;
    const deadline = this.#deadline();
    // The state just before stays in the store for Undo.
    const kept = await updateSnapshotRefs(
      store,
      [{ ref: treeRef(now.tree), id: now.tree }],
      this.#git(deadline),
    );
    if (!kept.ok) {
      throw new RestoreRefused(
        'noSnapshot',
        `wow could not keep the files as they are now: ${kept.message}`,
      );
    }
    const entries = plan.write.flatMap((file) => plan.target.get(file) ?? []);
    const blobs = await this.#blobs(store, entries, deadline);
    const written: string[] = [];
    const removed: string[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const file of plan.remove) {
      try {
        await unlink(fullPath(folder, file));
        removed.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed.push(file);
        else failed.push({ path: file, message: describe(error) });
      }
    }
    for (const file of removed) {
      let dir = path.dirname(fullPath(folder, file));
      while (path.relative(folder, dir) !== '' && !path.relative(folder, dir).startsWith('..')) {
        const gone = await rmdir(dir).then(
          () => true,
          () => false,
        );
        if (!gone) break;
        dir = path.dirname(dir);
      }
    }
    for (const entry of entries) {
      const target = fullPath(folder, entry.path);
      const bytes = blobs.get(entry.id);
      try {
        if (!bytes) throw new Error('its bytes are not in the snapshot');
        await mkdir(path.dirname(target), { recursive: true });
        const found = await lstat(target).catch(() => undefined);
        if (found?.isDirectory()) await rmdir(target);
        // A link is replaced, never written through.
        else if (found && (found.isSymbolicLink() || entry.mode === '120000')) await unlink(target);
        if (entry.mode === '120000') {
          await symlink(bytes.toString('utf8'), target);
        } else {
          await writeFile(target, bytes);
          if (this.#deps.platform !== 'win32') {
            const mode = (await lstat(target)).mode & 0o777;
            await chmod(target, entry.mode === '100755' ? mode | 0o111 : mode & ~0o111);
          }
        }
        written.push(entry.path);
      } catch (error) {
        failed.push({ path: entry.path, message: describe(error) });
      }
    }
    const after = await this.#takeIn(folder, store);
    let afterTree: TurnSnapshot | null = null;
    if (isTurnSnapshot(after)) {
      const ref = await updateSnapshotRefs(
        store,
        [{ ref: treeRef(after.tree), id: after.tree }],
        this.#git(this.#deadline()),
      );
      if (ref.ok) afterTree = after;
    }
    return { outcome: { written, removed, failed }, after: afterTree };
  }

  // Drops snapshots older than `chat.snapshotKeepDays` (spec 26): their refs go, the store
  // forgets what nothing keeps, and their turns stop offering Restore.
  expire(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#tracked(this.#expire());
  }

  async #expire(): Promise<void> {
    const keepDays = this.#deps.settings.get('chat.snapshotKeepDays');
    const cutoff = this.#deps.clock().getTime() - keepDays * oneDay;
    const old = (snapshot: StoredSnapshot | null) =>
      isTurnSnapshot(snapshot) && Date.parse(snapshot.at) < cutoff;
    const rows = this.#deps.db
      .select({
        id: turns.id,
        threadId: turns.threadId,
        start: turns.startSnapshot,
        end: turns.endSnapshot,
      })
      .from(turns)
      .all()
      .filter((row) => old(row.start) || old(row.end));
    const points = this.#deps.db.select().from(restorePoints).all();
    const byThread = new Map<string, typeof rows>();
    for (const row of rows)
      byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
    for (const [threadId, dropped] of byThread) {
      if (this.#stopped) return;
      const thread = this.#thread(threadId);
      if (!thread) continue;
      const done = await this.#serial(thread.cwd, async () => {
        const store = this.storeOf(thread.cwd);
        const git = this.#git(this.#deadline());
        const refs = dropped.flatMap((row) => [
          ...(old(row.start) ? [{ ref: turnRef(row.id, 'start'), id: null }] : []),
          ...(old(row.end) ? [{ ref: turnRef(row.id, 'end'), id: null }] : []),
        ]);
        // A tree kept for a restore goes once no restore newer than the cutoff names it.
        const live = new Set(
          points
            .filter((point) => Date.parse(point.at) >= cutoff)
            .flatMap((point) => [point.before?.tree, point.after?.tree]),
        );
        const oldTrees = points
          .filter((point) => point.threadId === threadId && Date.parse(point.at) < cutoff)
          .flatMap((point) => [point.before?.tree, point.after?.tree])
          .filter((tree): tree is string => tree !== undefined && !live.has(tree));
        const deleted = await updateSnapshotRefs(
          store,
          [...refs, ...[...new Set(oldTrees)].map((tree) => ({ ref: treeRef(tree), id: null }))],
          git,
        );
        if (!deleted.ok) {
          this.#deps.logger.warn('old snapshots were not dropped', deleted.message);
          return false;
        }
        // The kept blob ids may be among what goes, so the next snapshot reads every file.
        await rm(path.join(store, 'wow-manifest.json'), { force: true });
        const pruned = await pruneSnapshotStore(store, git);
        if (!pruned.ok) this.#deps.logger.warn('the snapshot store was not pruned', pruned.message);
        return true;
      });
      if (!done) continue;
      try {
        this.#deps.engine.dispatch(`snapshots-dropped:${randomUUID()}`, {
          type: 'thread.snapshotsDropped',
          threadId,
          turnIds: dropped.map((row) => row.id),
          before: new Date(cutoff).toISOString(),
        });
      } catch (error) {
        this.#deps.logger.warn('dropped snapshots were not recorded', describe(error));
      }
    }
  }
}
