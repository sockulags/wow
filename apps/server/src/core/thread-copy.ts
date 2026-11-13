import {
  branchName,
  sameBranchName,
  type DomainEvent,
  type ServerCommand,
  type Thread,
  type WorkingCopy,
} from '@wow/contracts';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { resolvedSetting, threadWorkingCopyPath } from './workflows.js';

// A chat thread's own working copy (thread work spec 10 to 18). The decision names the folder and
// the branch when the thread is created, without touching the disk; the workspaces service makes
// the worktree before the first turn goes out and reports every outcome back as one of the
// internal commands below, so the thread row is the only state.

type CopyCommand = Extract<
  ServerCommand,
  {
    type:
      | 'thread.workingCopyReady'
      | 'thread.workingCopyFailed'
      | 'thread.workingCopyBranching'
      | 'thread.workingCopySettled';
  }
>;

// The longest id a branch name gets when shorter ones are taken by another thread's branch.
const longestId = 16;

const stringSetting = (
  key: string,
  read: ReadModel,
  context: DecideContext,
  projectId: string | undefined,
): string => {
  const value = resolvedSetting(key, read, context, projectId);
  return typeof value === 'string' ? value : String(context.registry[key]?.default);
};

// The folder, branch and pending copy of a new thread with "Own working copy" on.
export function ownCopyOf(
  read: ReadModel,
  context: DecideContext,
  command: Extract<ServerCommand, { type: 'thread.create' }>,
): { readonly cwd: string; readonly branch: string; readonly workingCopy: WorkingCopy } {
  if (command.projectId === undefined) {
    throw new CommandRejected(
      'rejected',
      'Only a thread in a project can have its own working copy; this one has a folder only.',
    );
  }
  if (command.resumeSessionId !== undefined) {
    throw new CommandRejected(
      'rejected',
      'A session started in a terminal goes on in its own folder, so it cannot move to a working copy.',
    );
  }
  const project = read.project(command.projectId);
  if (!project) throw new CommandRejected('not_found', `No project ${command.projectId}`);
  const template = stringSetting('chat.workingCopyBranch', read, context, project.id);
  const taken = read
    .projectThreads(project.id)
    .map((thread) => thread.branch)
    .filter((branch): branch is string => branch !== null);
  let branch = '';
  // Ids differ, so names differ; this only matters when six characters of two ids agree.
  for (let length = 6; length <= longestId; length += 2) {
    branch = branchName(template, command.title ?? '', command.threadId, length);
    if (!taken.some((other) => sameBranchName(other, branch))) break;
  }
  const cwd = threadWorkingCopyPath(
    stringSetting('workspaces.root', read, context, undefined),
    context.home,
    project.name,
    command.threadId,
  );
  return {
    cwd,
    branch,
    workingCopy: {
      path: cwd,
      state: 'pending',
      startSha: null,
      defaultBranch: null,
      note: null,
      unpushed: null,
      error: null,
      branch,
    },
  };
}

const changed = (thread: Thread, workingCopy: WorkingCopy): DomainEvent => ({
  kind: 'thread.workingCopyChanged',
  aggregate: thread.id,
  payload: { threadId: thread.id, workingCopy },
});

export function decideThreadCopy(command: CopyCommand, read: ReadModel): DomainEvent[] {
  const thread = read.thread(command.threadId);
  if (!thread) throw new CommandRejected('not_found', `No thread ${command.threadId}`);
  const copy = thread.workingCopy;
  if (!copy) {
    throw new CommandRejected('rejected', `Thread ${thread.id} has no working copy of its own`);
  }
  switch (command.type) {
    case 'thread.workingCopyReady': {
      const { startSha, defaultBranch, note } = command;
      return [
        changed(thread, {
          ...copy,
          state: 'ready',
          startSha,
          defaultBranch,
          note,
          unpushed: null,
          error: null,
        }),
      ];
    }
    case 'thread.workingCopyFailed':
      return [changed(thread, { ...copy, state: 'failed', error: command.error })];
    case 'thread.workingCopyBranching':
      return [changed(thread, { ...copy, branchStart: command.startSha })];
    case 'thread.workingCopySettled': {
      if (read.runningTurn(thread.id)) {
        throw new CommandRejected('rejected', `A turn runs in thread ${thread.id}'s working copy`);
      }
      const { state, unpushed, error } = command;
      return [changed(thread, { ...copy, state, unpushed, error })];
    }
  }
}
