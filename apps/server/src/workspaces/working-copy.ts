import type { UnpushedWork } from '@wow/contracts';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  addWorktree,
  askRemoteDefaultBranch,
  fetchRemote,
  pruneWorktrees,
  readCommit,
  readFolderGit,
  readHeadCommit,
  readRemoteDefaultBranch,
  readUnpushed,
  removeWorktree,
  type GitRunOptions,
} from '../projects/git.js';

// A run's own working copy (review loop spec 36 to 38): a Git worktree of the project's
// repository on no branch, because the agent's delivery skill names and creates its own branch.
// Nothing here installs dependencies or runs a command the repository declares.

export interface CreateRequest {
  readonly projectFolder: string;
  // Where the working copy goes; its parent folder is made when missing.
  readonly target: string;
  // `workspaces.fetchBeforeCreate`.
  readonly fetch: boolean;
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
  { projectFolder: folder, fetch, git }: CreateRequest,
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

const failed = (reason: string): Created => ({
  ok: false,
  error: `No working copy could be made: ${reason}`,
});

export async function createWorkingCopy(request: CreateRequest): Promise<Created> {
  const { projectFolder, target, git } = request;
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
      break;
  }
  const start = await startCommit(request, head.sha);
  try {
    await mkdir(path.dirname(target), { recursive: true });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  const added = await addWorktree(projectFolder, target, start.sha, git);
  if (!added.ok) return failed(`${added.message} (${target})`);
  return { ok: true, startSha: start.sha, defaultBranch: start.defaultBranch, note: start.note };
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
}: SettleRequest): Promise<Settled> {
  if (await gone(target)) {
    await pruneWorktrees(projectFolder, git);
    return { state: 'removed', unpushed: null, error: null };
  }
  const unpushed = await readUnpushed(target, startSha, git);
  if (!unpushed) {
    return {
      state: 'kept',
      unpushed: null,
      error: 'Git could not say what the working copy holds, so it was kept.',
    };
  }
  if (unpushed.uncommittedFiles > 0 || unpushed.unpushedCommits > 0) {
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
}: Omit<SettleRequest, 'startSha'>): Promise<Settled> {
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
