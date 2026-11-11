import type { UnpushedWork } from '@wow/contracts';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  addBranchWorktree,
  addTrackingWorktree,
  addWorktree,
  askRemoteDefaultBranch,
  fetchRemote,
  fetchRemoteRef,
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
  // at the default branch's tip.
  readonly head?: { readonly sha: string; readonly ref: string } | undefined;
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
// the head commit; else it is on that commit and on no branch. Answers why not when the head
// commit is not here even after the fetch; the caller then starts at the default branch.
async function createAtHead(
  { projectFolder: folder, target, fetch, branch, git }: CreateRequest,
  head: { readonly sha: string; readonly ref: string },
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
    return detached("The working copy is on the pull request's head commit and on no branch.");
  }
  const localTip = await readCommit(folder, `refs/heads/${branch}`, git);
  const remoteTip =
    remote === null ? null : await readCommit(folder, `refs/remotes/${remote}/${branch}`, git);
  const tip = localTip ?? remoteTip;
  if (tip === null) {
    return detached(
      `Branch ${branch} was not found, so the working copy is on the pull request's head commit and on no branch.`,
    );
  }
  if (tip !== sha) {
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
