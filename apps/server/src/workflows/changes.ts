import type {
  FileHash,
  RunDiff,
  RunDiffFile,
  RunDiffStatus,
  ThreadDiff,
  WorkflowRun,
} from '@wow/contracts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsService } from '../settings/service.js';
import { pipeline } from 'node:stream/promises';
import {
  listChangedPaths,
  readBaseSizes,
  readHeadCommit,
  readPatch,
  type ChangedPath,
  type GitRunOptions,
} from '../projects/git.js';

// What a run changed in its working folder (review loop spec 10 to 13). The diff is the folder
// as it is now against the commit it was on when the run's first step began. Which step changed
// a file comes from content hashes taken when each step ended, because wow makes no commits of
// its own. Nothing here writes to the folder or to the repository.

export interface ChangesOptions {
  readonly git: GitRunOptions;
  // `diff.maxFileBytes`: a larger file is listed without its lines.
  readonly maxFileBytes: number;
  // `diff.maxFiles`: how many changed files are listed and hashed.
  readonly maxFiles: number;
  // `diff.maxHashBytes`: a larger file is not read when it is hashed.
  readonly maxHashBytes: number;
}

// The settings as they are now; git keeps the limit it has for every other read of a project.
export const changesOptions = (settings: Pick<SettingsService, 'get'>): ChangesOptions => ({
  git: {
    timeoutMs: settings.get('trackers.gitTimeoutMs'),
    stopWaitMs: settings.get('advanced.gitStopWaitMs'),
  },
  maxFileBytes: settings.get('diff.maxFileBytes'),
  maxFiles: settings.get('diff.maxFiles'),
  maxHashBytes: settings.get('diff.maxHashBytes'),
});

const fullPath = (folder: string, relative: string) => path.join(folder, ...relative.split('/'));

// The file's own entry, or undefined when it is gone or a folder on its way is a link: a tracked
// folder replaced by a link would otherwise be followed to whatever it points at.
async function entryOf(folder: string, relative: string) {
  const parts = relative.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const parent = await lstat(path.join(folder, ...parts.slice(0, depth))).catch(() => undefined);
    if (!parent?.isDirectory()) return undefined;
  }
  const full = path.join(folder, ...parts);
  const found = await lstat(full).catch(() => undefined);
  return found && { full, found };
}

// A link is hashed as where it points, never as what it points at: that may be outside the folder.
// A file over the limit stands for its size and change time, so a huge file is never read.
async function hashOf(
  folder: string,
  relative: string,
  maxHashBytes: number,
): Promise<string | null> {
  const entry = await entryOf(folder, relative);
  if (!entry) return null;
  const { full: file, found } = entry;
  try {
    if (found.isSymbolicLink()) {
      return createHash('sha256')
        .update(`link:${await readlink(file)}`)
        .digest('hex');
    }
    if (!found.isFile()) return 'not-a-file';
    if (found.size > maxHashBytes) {
      return createHash('sha256').update(`large:${found.size}:${found.mtimeMs}`).digest('hex');
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
  } catch {
    // Locked or gone since it was listed. The next snapshot that can read it shows a change.
    return 'unreadable';
  }
}

// The changed files and what is in each right now, or undefined when git cannot say.
export async function snapshotChanges(
  folder: string,
  baseSha: string,
  options: ChangesOptions,
): Promise<FileHash[] | undefined> {
  const listed = await listChangedPaths(folder, baseSha, options.git, false);
  if (!listed.ok) return undefined;
  const hashes: FileHash[] = [];
  for (const { path: relative } of listed.files.slice(0, options.maxFiles)) {
    hashes.push({ path: relative, hash: await hashOf(folder, relative, options.maxHashBytes) });
  }
  return hashes;
}

export interface RunBase {
  readonly baseSha: string;
  // What already differed from the base commit before the first step did anything.
  readonly files: FileHash[];
}

// The commit the folder is on, for a run about to begin its first step. Undefined when the
// folder is not a repository, has no commit yet, or git is not installed.
export async function readRunBase(
  folder: string,
  options: ChangesOptions,
): Promise<RunBase | undefined> {
  const head = await readHeadCommit(folder, options.git);
  if (head.status !== 'ok') return undefined;
  return { baseSha: head.sha, files: (await snapshotChanges(folder, head.sha, options)) ?? [] };
}

type RunHashes = Pick<WorkflowRun, 'baseFiles' | 'steps' | 'path'>;

// The steps with their hashes in the order they last ended. That is the order of the list
// unless a rule sent the run back (workflow branches spec 19): a step keeps only the hashes of
// its latest attempt, so it is compared with whichever step ended before that attempt.
function inOrderEnded(run: RunHashes): WorkflowRun['steps'] {
  const visits = run.path ?? [];
  const lastEnded = (stepId: string) =>
    visits.findLastIndex((visit) => visit.stepId === stepId && visit.ended === 'done');
  return run.steps
    .map((step, index) => ({ step, index, ended: lastEnded(step.stepId) }))
    .toSorted((a, b) => a.ended - b.ended || a.index - b.index)
    .map(({ step }) => step);
}

// The steps that changed the file, in the order they last ended: a step changed it when the
// file's hash at the step's end is not the hash it had when the step that ended before it ended
// (or when the run began, for the first of them). A path missing from a list was the same as in
// the base commit then. A step that kept what it began from (`fileHashesBefore`) is compared
// with that instead, so after a loop every step is marked with what its latest attempt changed.
export function stepsThatChanged(run: RunHashes, relative: string): string[] {
  const hashAt = (files: readonly FileHash[]) =>
    files.find((entry) => entry.path === relative)?.hash;
  let before = hashAt(run.baseFiles ?? []);
  const steps: string[] = [];
  for (const step of inOrderEnded(run)) {
    if (!step.fileHashes) continue;
    const after = hashAt(step.fileHashes);
    // What the step began from, when it was kept: the chain loses it after a loop.
    if (step.fileHashesBefore) before = hashAt(step.fileHashesBefore);
    if (after !== before) steps.push(step.stepId);
    before = after;
  }
  return steps;
}

// The same test git uses: a NUL byte near the start means the file is not text.
const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

const lineCount = (text: string) =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// A new file git does not know yet has no diff of its own, so every line is an added line.
export function addedPatch(text: string): string {
  const count = lineCount(text);
  if (count === 0) return '';
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return [
    `@@ -0,0 +1${count === 1 ? '' : `,${count}`} @@`,
    ...lines.map((line) => `+${line}`),
    ...(text.endsWith('\n') ? [] : ['\\ No newline at end of file']),
    '',
  ].join('\n');
}

interface Described {
  readonly file: RunDiffFile;
  // The content of a new untracked text file, which is its whole diff.
  readonly text?: string;
}

async function describe(
  folder: string,
  entry: ChangedPath,
  run: RunHashes,
  baseSizes: ReadonlyMap<string, number>,
  maxFileBytes: number,
): Promise<Described> {
  const full = fullPath(folder, entry.path);
  const found = (await entryOf(folder, entry.path))?.found;
  const regular = found?.isFile() === true;
  const size = regular ? found.size : (baseSizes.get(entry.path) ?? null);
  const shown = {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    size,
    changedBy: stepsThatChanged(run, entry.path),
  };
  const withoutLines = (content: 'binary' | 'tooLarge'): Described => ({
    file: { ...shown, content, added: null, removed: null },
  });
  if (entry.binary) return withoutLines('binary');
  if (size !== null && size > maxFileBytes) return withoutLines('tooLarge');
  if (entry.tracked) {
    return { file: { ...shown, content: 'text', added: entry.added, removed: entry.removed } };
  }
  // A link or anything else that is not a plain file is not followed or read.
  if (!regular) return withoutLines('binary');
  const bytes = await readFile(full).catch(() => undefined);
  if (bytes === undefined || looksBinary(bytes)) return withoutLines('binary');
  // The file may have grown since its size was read.
  if (bytes.byteLength > maxFileBytes) return withoutLines('tooLarge');
  const text = bytes.toString('utf8');
  return { file: { ...shown, content: 'text', added: lineCount(text), removed: 0 }, text };
}

export interface RunDiffRequest {
  readonly folder: string;
  readonly run: Pick<WorkflowRun, 'baseSha' | 'baseFiles' | 'steps'>;
  // One file to answer with its diff; without it the answer is the list.
  readonly path?: string | undefined;
  readonly options: ChangesOptions;
}

export async function readRunDiff({
  folder,
  run,
  path: asked,
  options,
}: RunDiffRequest): Promise<RunDiff> {
  const baseSha = run.baseSha ?? null;
  const nothing = (status: RunDiffStatus, message: string | null = null): RunDiff => ({
    status,
    message,
    baseSha,
    files: [],
    omitted: 0,
    patch: null,
  });
  // The folder is asked first, so a folder that is not a repository says so even for a run
  // that has no base either.
  const head = await readHeadCommit(folder, options.git);
  if (
    head.status === 'folderMissing' ||
    head.status === 'noRepository' ||
    head.status === 'gitUnavailable'
  ) {
    return nothing(head.status, head.message);
  }
  if (baseSha === null) return nothing('noBase');
  const listed = await listChangedPaths(folder, baseSha, options.git);
  if (!listed.ok) return nothing(listed.baseMissing ? 'baseMissing' : 'failed', listed.message);

  const entries =
    asked === undefined
      ? listed.files.slice(0, options.maxFiles)
      : listed.files.filter((entry) => entry.path === asked);
  const omitted = asked === undefined ? listed.files.length - entries.length : 0;
  const deleted = entries.filter((entry) => entry.status === 'deleted').map((entry) => entry.path);
  const baseSizes = await readBaseSizes(folder, baseSha, deleted, options.git);
  const described: Described[] = [];
  for (const entry of entries) {
    described.push(await describe(folder, entry, run, baseSizes, options.maxFileBytes));
  }
  const files = described.map((entry) => entry.file);
  const answer = { status: 'ok' as const, message: null, baseSha, files, omitted };
  const [only] = described;
  const [entry] = entries;
  if (asked === undefined || !only || !entry || only.file.content !== 'text') {
    return { ...answer, patch: null };
  }
  if (only.text !== undefined) return { ...answer, patch: addedPatch(only.text) };
  const patch = await readPatch(folder, baseSha, entry, options.git);
  // A diff git could not give (too long to hold, or the file changed under it) is not shown.
  if (patch === undefined) {
    return { ...answer, files: [{ ...only.file, content: 'tooLarge' }], patch: null };
  }
  return { ...answer, patch };
}

export interface ThreadDiffRequest {
  readonly folder: string;
  // Set at the thread's first turn; null for a thread stored before, or begun outside git.
  readonly baseSha: string | null;
  readonly baseFiles: readonly FileHash[] | null;
  // The changed files' hashes as the last turn began, or null when it has none.
  readonly mark: readonly FileHash[] | null;
  readonly path?: string | undefined;
  readonly options: ChangesOptions;
}

// A chat thread's changes (agent workbench spec 34, 35) with the run's diff code: the folder
// against the commit of its first turn, without what already differed then and is unchanged
// since. "This turn only" compares each listed file's content now with its hash when the last
// turn began; a file the mark does not list was as in the base then. A file that differed before
// the thread and changed again shows its whole diff against the commit.
export async function readThreadDiff({
  folder,
  baseSha,
  baseFiles,
  mark,
  path: asked,
  options,
}: ThreadDiffRequest): Promise<ThreadDiff> {
  const diff = await readRunDiff({
    folder,
    run: { baseSha, baseFiles: baseFiles ? [...baseFiles] : null, steps: [] },
    path: asked,
    options,
  });
  if (diff.status !== 'ok' || baseSha === null) return { ...diff, turnPaths: null };
  // A file that already differed from the commit when the thread began, and is as it was then,
  // is not the thread's change.
  const began = new Map((baseFiles ?? []).map((entry) => [entry.path, entry.hash]));
  const before = mark && new Map(mark.map((entry) => [entry.path, entry.hash]));
  const files: RunDiffFile[] = [];
  const turnPaths: string[] = [];
  for (const file of diff.files) {
    const now = await hashOf(folder, file.path, options.maxHashBytes);
    if (began.has(file.path) && began.get(file.path) === now) continue;
    files.push(file);
    if (before && (!before.has(file.path) || before.get(file.path) !== now)) {
      turnPaths.push(file.path);
    }
  }
  return {
    ...diff,
    files,
    patch: files.length === 0 ? null : diff.patch,
    turnPaths: before ? turnPaths : null,
  };
}
