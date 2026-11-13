import type { UnpushedWork, WorkingCopyStart } from '@wow/contracts';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  addBranchWorktree,
  addNewBranchWorktree,
  addTrackingWorktree,
  addWorktree,
  askRemoteDefaultBranch,
  branchNeverMoved,
  checkBranchName,
  listCommitsOnNoBranch,
  fetchRemote,
  fetchRemoteRef,
  pruneWorktrees,
  readCommit,
  readCurrentBranch,
  readFolderGit,
  readHeadCommit,
  readRemoteDefaultBranch,
  readUnpushed,
  readUnpushedWithStatus,
  removeWorktree,
  type GitRunOptions,
} from '../projects/git.js';

// A run's own working copy (review loop spec 36 to 38): a Git worktree of the project's
// repository on no branch, because the agent's delivery skill names and creates its own branch.
// A run that an event started on a pull request is the exception: its copy is at the pull
// request's head commit, and on its branch when this repository's branch is at that commit, so
// the agent adds to that pull request (spec 48).
// Nothing here installs dependencies or runs a command the repository declares.

export interface CreateRequest {
  readonly projectFolder: string;
  // Where the working copy goes; its parent folder is made when missing.
  readonly target: string;
  // `workspaces.fetchBeforeCreate`.
  readonly fetch: boolean;
  // For a run an event started on a pull request: its head commit, the ref of this repository's
  // remote that commit is fetched from, and its branch. Without a head the copy is on no branch
  // at the default branch's tip. `merged`: the pull request's code is on the default branch now,
  // so the copy is never left at the head commit off its branch; it starts at the default
  // branch's tip instead.
  readonly head?:
    | { readonly sha: string; readonly ref: string; readonly merged?: boolean | undefined }
    | undefined;
  readonly branch?: string | null | undefined;
  readonly git: GitRunOptions;
}

export type Created =
  | {
      readonly ok: true;
      readonly startSha: string;
      readonly defaultBranch: string | null;
      readonly note: string | null;
    }
  | { readonly ok: false; readonly error: string };

interface Start {
  readonly sha: string;
  readonly defaultBranch: string | null;
  readonly note: string | null;
}

// Branch names a remote that does not say which is its default most often uses.
const usualDefaults = ['main', 'master'];

async function defaultBranchOf(
  folder: string,
  remote: string,
  fetched: boolean,
  git: GitRunOptions,
): Promise<string | null> {
  const stored = await readRemoteDefaultBranch(folder, remote, git);
  if (stored !== null) return stored;
  // Only a remote that just answered a fetch is asked again.
  const asked = fetched ? await askRemoteDefaultBranch(folder, remote, git) : null;
  if (asked !== null) return asked;
  for (const name of usualDefaults) {
    if ((await readCommit(folder, `refs/remotes/${remote}/${name}`, git)) !== null) return name;
  }
  return null;
}

// The commit a working copy starts at: the tip of the remote's default branch after a fetch, or
// what this computer already has, with a sentence that says so.
async function startCommit(
  { projectFolder: folder, fetch, git }: Pick<CreateRequest, 'projectFolder' | 'fetch' | 'git'>,
  headSha: string,
): Promise<Start> {
  const { primary: remote } = await readFolderGit(folder, git);
  if (remote === null) {
    return {
      sha: headSha,
      defaultBranch: null,
      note: 'The project has no remote, so the working copy starts at the commit the project folder is on.',
    };
  }
  const fetched = fetch ? await fetchRemote(folder, remote, git) : undefined;
  const branch = await defaultBranchOf(folder, remote, fetched?.ok === true, git);
  if (branch === null) {
    return {
      sha: headSha,
      defaultBranch: null,
      note: `The default branch of ${remote} is not known, so the working copy starts at the commit the project folder is on.`,
    };
  }
  const remoteTip = await readCommit(folder, `refs/remotes/${remote}/${branch}`, git);
  if (fetched?.ok === true && remoteTip !== null) {
    return { sha: remoteTip, defaultBranch: branch, note: null };
  }
  const localTip = await readCommit(folder, `refs/heads/${branch}`, git);
  const why =
    fetched === undefined
      ? `${remote} was not fetched (the setting is off)`
      : fetched.ok
        ? `${remote} has no branch ${branch}`
        : `Fetching ${remote} failed (${fetched.message})`;
  const where =
    localTip !== null
      ? `the local tip of ${branch}`
      : remoteTip !== null
        ? `the tip of ${branch} as it was last fetched`
        : 'the commit the project folder is on';
  return {
    sha: localTip ?? remoteTip ?? headSha,
    defaultBranch: branch,
    note: `${why}, so the working copy starts at ${where}.`,
  };
}

const failed = (reason: string): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error: `No working copy could be made: ${reason}`,
});

export async function createWorkingCopy(request: CreateRequest): Promise<Created> {
  const { projectFolder, target, git } = request;
  const head = await projectHead(projectFolder, git);
  if (typeof head !== 'string') return head;
  const start = await startCommit(request, head);
  try {
    await mkdir(path.dirname(target), { recursive: true });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  let missing: string | undefined;
  if (request.head) {
    const atHead = await createAtHead(request, request.head, start.defaultBranch);
    if (typeof atHead !== 'string') return atHead;
    missing = atHead;
  }
  const added = await addWorktree(projectFolder, target, start.sha, git);
  if (!added.ok) return failed(`${added.message} (${target})`);
  const note =
    missing === undefined
      ? start.note
      : start.note === null
        ? `${missing}, so the working copy starts at the tip of the default branch, on no branch.`
        : `${missing}. ${start.note}`;
  return { ok: true, startSha: start.sha, defaultBranch: start.defaultBranch, note };
}

const commitName = /^[0-9a-f]{7,64}$/i;

// The working copy at the pull request's head commit, fetched by the pull request's own ref of
// this repository's remote. A branch name alone can name other code: a fork's branch may be
// called like one here. So the copy is on the branch only when this repository's branch is at
// the head commit; else it is on that commit and on no branch, unless the pull request is merged:
// its code is on the default branch then. Answers why not when the head commit is not here even
// after the fetch, or a merged pull request's branch is not at it; the caller then starts at the
// default branch.
async function createAtHead(
  { projectFolder: folder, target, fetch, branch, git }: CreateRequest,
  head: NonNullable<CreateRequest['head']>,
  defaultBranch: string | null,
): Promise<Created | string> {
  const { primary: remote } = await readFolderGit(folder, git);
  const fetched =
    fetch && remote !== null ? await fetchRemoteRef(folder, remote, head.ref, git) : undefined;
  const sha = commitName.test(head.sha) ? await readCommit(folder, head.sha, git) : null;
  if (sha === null) {
    const why =
      fetched === undefined
        ? remote === null
          ? ' (the project has no remote)'
          : ` (${remote} was not fetched: the setting is off)`
        : fetched.ok
          ? ''
          : ` (fetching ${head.ref} from ${remote} failed: ${fetched.message})`;
    return `The pull request's head commit ${head.sha} was not found${why}`;
  }
  const made = (note: string | null): Created => ({
    ok: true,
    startSha: sha,
    defaultBranch,
    note,
  });
  const detached = async (note: string): Promise<Created> => {
    const added = await addWorktree(folder, target, sha, git);
    return added.ok ? made(note) : failed(`${added.message} (${target})`);
  };
  // The name comes from the host. One that git would read as an option is not used.
  if (!branch || branch.startsWith('-')) {
    if (head.merged) return "The pull request's branch is not known";
    return detached("The working copy is on the pull request's head commit and on no branch.");
  }
  const localTip = await readCommit(folder, `refs/heads/${branch}`, git);
  const remoteTip =
    remote === null ? null : await readCommit(folder, `refs/remotes/${remote}/${branch}`, git);
  const tip = localTip ?? remoteTip;
  if (tip === null) {
    if (head.merged) return `Branch ${branch} was not found`;
    return detached(
      `Branch ${branch} was not found, so the working copy is on the pull request's head commit and on no branch.`,
    );
  }
  if (tip !== sha) {
    if (head.merged) return `Branch ${branch} here is not at the pull request's head commit`;
    return detached(
      `Branch ${branch} here is not at the pull request's head commit (the pull request may come from a fork, or the branch moved since), so the working copy is on that commit and on no branch.`,
    );
  }
  const added =
    localTip !== null
      ? await addBranchWorktree(folder, target, branch, git)
      : await addTrackingWorktree(folder, target, branch, remote as string, git);
  if (added.ok) return made(null);
  // Most often the project folder or another working copy is on the branch.
  return detached(
    `The working copy could not be put on branch ${branch} (${added.message}), so it is on that branch's commit and on no branch.`,
  );
}

export interface ThreadCreateRequest {
  readonly projectFolder: string;
  readonly target: string;
  // The new branch, named when the thread was created.
  readonly branch: string;
  // `chat.workingCopyStart`.
  readonly start: WorkingCopyStart;
  // `workspaces.fetchBeforeCreate`, for a copy that starts at the default branch.
  readonly fetch: boolean;
  // The thread's `WorkingCopy.branchStart`: where an earlier try had git make the branch.
  readonly branchStart: string | null;
  // Called with the start commit right before git is asked to make the branch; the caller
  // stores it, so a branch git leaves is known as wow's own. Called with null when git failed
  // without making it, so the note is not left to match a branch someone else makes later.
  readonly beforeBranch: (startSha: string | null) => void;
  readonly git: GitRunOptions;
}

// A chat thread's own working copy (thread work spec 11, 12): a worktree on a new branch, at the
// commit the project folder is on or at the default branch's tip. `defaultBranch` is the branch
// the start commit was read from (the project folder's, or the remote's default), null when it
// is on none. Nothing falls back to the project folder: a copy that cannot be made answers why.
export async function createThreadWorkingCopy(request: ThreadCreateRequest): Promise<Created> {
  const { projectFolder, target, branch, git } = request;
  const head = await projectHead(projectFolder, git);
  if (typeof head !== 'string') return head;
  const named = await checkBranchName(projectFolder, branch, git);
  if (!named.ok) return failed(`${named.message}.`);
  const start =
    request.start === 'head'
      ? { sha: head, defaultBranch: await readCurrentBranch(projectFolder, git), note: null }
      : await startCommit({ projectFolder, fetch: request.fetch, git }, head);
  try {
    await mkdir(path.dirname(target), { recursive: true });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  // `worktree add -b` makes the branch before the folder and leaves it when the folder then fails
  // (a folder already there, a path too long, a locked file, a server stop). The branch an
  // earlier try of this thread made, still at its commit and never moved, is taken up again, so
  // Retry works once the cause is gone. Any other branch of that name is the user's: git refuses
  // it, and that is the reason. wow never deletes a branch (spec 15).
  const tip = await readCommit(projectFolder, `refs/heads/${branch}`, git);
  const left =
    tip !== null &&
    tip === request.branchStart &&
    (await branchNeverMoved(projectFolder, branch, git));
  if (!left) {
    // From here the branch is wow's own, even when git stops halfway.
    if (tip === null) request.beforeBranch(start.sha);
    const added = await addNewBranchWorktree(projectFolder, target, branch, start.sha, git);
    if (!added.ok) {
      if (tip === null && (await readCommit(projectFolder, `refs/heads/${branch}`, git)) === null) {
        request.beforeBranch(null);
      }
      return failed(`${added.message} (${target})`);
    }
    return { ok: true, startSha: start.sha, defaultBranch: start.defaultBranch, note: start.note };
  }
  await pruneWorktrees(projectFolder, git);
  const added = await addBranchWorktree(projectFolder, target, branch, git);
  if (!added.ok) return failed(`${added.message} (${target})`);
  return tip === start.sha
    ? { ok: true, startSha: tip, defaultBranch: start.defaultBranch, note: start.note }
    : {
        ok: true,
        startSha: tip,
        defaultBranch: null,
        note: `An earlier try made branch ${branch} at ${tip.slice(0, 7)}, so the working copy starts there.`,
      };
}

// Where a thread's copy would start, read without fetching or writing anything, for the draft's
// line (spec 10). `from` is the branch the commit is read from, null on no branch.
export async function readThreadStart(
  projectFolder: string,
  start: WorkingCopyStart,
  git: GitRunOptions,
): Promise<
  | {
      readonly ok: true;
      readonly sha: string;
      readonly from: string | null;
      readonly remote: boolean;
    }
  | { readonly ok: false; readonly error: string }
> {
  const head = await projectHead(projectFolder, git);
  if (typeof head !== 'string') return head;
  if (start === 'head') {
    return {
      ok: true,
      sha: head,
      from: await readCurrentBranch(projectFolder, git),
      remote: false,
    };
  }
  const { primary: remote } = await readFolderGit(projectFolder, git);
  const branch = remote === null ? null : await defaultBranchOf(projectFolder, remote, false, git);
  if (remote === null || branch === null) {
    return {
      ok: true,
      sha: head,
      from: await readCurrentBranch(projectFolder, git),
      remote: false,
    };
  }
  const tip =
    (await readCommit(projectFolder, `refs/remotes/${remote}/${branch}`, git)) ??
    (await readCommit(projectFolder, `refs/heads/${branch}`, git)) ??
    head;
  return { ok: true, sha: tip, from: branch, remote: true };
}

// The copy of a thread whose folder was removed, made again on its branch (spec 16). A folder
// that is there on the branch already (a fork of the thread made it again first) is taken as it
// is. Git refuses when the branch is gone or another folder is on it; that is the reason.
export async function reopenThreadWorkingCopy({
  projectFolder,
  target,
  branch,
  git,
}: Pick<ThreadCreateRequest, 'projectFolder' | 'target' | 'branch' | 'git'>): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const head = await projectHead(projectFolder, git);
  if (typeof head !== 'string') return head;
  if (!(await gone(target))) {
    if ((await readCurrentBranch(target, git)) === branch) return { ok: true };
    return failed(`${target} is there and is not on branch ${branch}.`);
  }
  await pruneWorktrees(projectFolder, git);
  const added = await addBranchWorktree(projectFolder, target, branch, git);
  return added.ok ? { ok: true } : failed(`${added.message} (${target})`);
}

// The project folder's commit, or why no working copy can be made from it.
async function projectHead(
  projectFolder: string,
  git: GitRunOptions,
): Promise<string | { readonly ok: false; readonly error: string }> {
  const head = await readHeadCommit(projectFolder, git);
  switch (head.status) {
    case 'folderMissing':
      return failed(`the project folder ${projectFolder} does not exist.`);
    case 'gitUnavailable':
      return failed('git was not found on the PATH.');
    case 'noRepository':
      return failed(
        `${projectFolder} is not a Git repository${head.message ? ` (${head.message})` : ''}.`,
      );
    case 'noCommit':
      return failed(`the repository in ${projectFolder} has no commit yet.`);
    case 'ok':
      return head.sha;
  }
}

// What a thread's copy holds that would be lost with it: as for a run, and of its commits the
// ones made on no branch, which the thread's branch does not keep (spec 14, 15).
export async function readThreadHolds(
  target: string,
  startSha: string | null,
  branch: string,
  git: GitRunOptions,
): Promise<UnpushedWork | undefined> {
  const read = await readUnpushedWithStatus(target, startSha, git);
  if (!read) return undefined;
  const { unpushed, status } = read;
  const branches = unpushed.branch === null ? [branch] : [...new Set([branch, unpushed.branch])];
  const onNoBranch = await listCommitsOnNoBranch(target, branches, git);
  if (onNoBranch === undefined) return undefined;
  const digest = createHash('sha256').update(status).update('\0').update(onNoBranch.join('\n'));
  return { ...unpushed, commitsOnNoBranch: onNoBranch.length, digest: digest.digest('hex') };
}

export interface Settled {
  readonly state: 'kept' | 'removed';
  readonly unpushed: UnpushedWork | null;
  readonly error: string | null;
}

export interface SettleRequest {
  readonly projectFolder: string;
  readonly target: string;
  readonly startSha: string | null;
  readonly git: GitRunOptions;
  // A run's copy is on no branch, so its commits are lost with it. A thread's copy is on its own
  // branch, named here, which keeps them unless they were made on no branch (thread work spec 14).
  readonly branch?: string | undefined;
}

const gone = async (target: string) => (await stat(target).catch(() => undefined)) === undefined;

// After the run ended: removes the working copy when nothing in it would be lost, and says what
// it holds otherwise. A removal that fails (a locked file, a path too long) is not tried again;
// the copy is kept and listed with the reason.
export async function settleWorkingCopy({
  projectFolder,
  target,
  startSha,
  git,
  branch,
}: SettleRequest): Promise<Settled> {
  if (await gone(target)) {
    await pruneWorktrees(projectFolder, git);
    return { state: 'removed', unpushed: null, error: null };
  }
  const unpushed: UnpushedWork | undefined =
    branch === undefined
      ? await readUnpushed(target, startSha, git)
      : await readThreadHolds(target, startSha, branch, git);
  if (!unpushed) {
    return {
      state: 'kept',
      unpushed: null,
      error: 'Git could not say what the working copy holds, so it was kept.',
    };
  }
  const commitsLost =
    branch === undefined ? unpushed.unpushedCommits > 0 : (unpushed.commitsOnNoBranch ?? 0) > 0;
  if (unpushed.uncommittedFiles > 0 || (unpushed.ignoredFiles ?? 0) > 0 || commitsLost) {
    return { state: 'kept', unpushed, error: null };
  }
  const removed = await removeWorktree(projectFolder, target, false, git);
  if (removed.ok) return { state: 'removed', unpushed: null, error: null };
  return {
    state: 'kept',
    unpushed: null,
    error: `Nothing in it would be lost, but it could not be removed: ${removed.message}`,
  };
}

// "Remove working copy": the user has confirmed, so uncommitted and unpushed work goes with it.
export async function discardWorkingCopy({
  projectFolder,
  target,
  git,
}: Omit<SettleRequest, 'startSha' | 'branch'>): Promise<Settled> {
  if (!(await gone(target))) {
    const removed = await removeWorktree(projectFolder, target, true, git);
    if (!removed.ok) {
      return {
        state: 'kept',
        unpushed: null,
        error: `The working copy could not be removed: ${removed.message}`,
      };
    }
  } else {
    await pruneWorktrees(projectFolder, git);
  }
  return { state: 'removed', unpushed: null, error: null };
}
