import { z } from 'zod';
import { DiffFileStatus } from './diff.js';
import { HostItemRef } from './host-links.js';

// Commit and pull request from a chat thread's Changes (thread work spec 27 to 36). Everything
// here happens on the user's click in the commit and pull request dialogs only: the assistant has
// no tool for it and an agent cannot reach it through wow.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const RelativePath = z.string().min(1).max(4096);

// One changed, deleted or new file of the folder that Git does not ignore (spec 27), against
// HEAD. `inThread`: it is one of the thread's own Changes and was not changed outside the thread
// since its last turn, so the dialog ticks it. `staged`: the index holds a change of it.
export const CommitFile = z.object({
  path: RelativePath,
  oldPath: RelativePath.nullable(),
  status: DiffFileStatus,
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
  inThread: z.boolean(),
  staged: z.boolean(),
});
export type CommitFile = z.infer<typeof CommitFile>;

// `ok`: Commit can go. Anything else is why it cannot, with `message` in words (spec 30); the
// files are listed all the same where git could read them.
export const CommitPlanStatus = z.enum([
  'ok',
  'turnRunning',
  'operationInProgress',
  'noRepository',
  'gitUnavailable',
  'folderMissing',
  'notChat',
  'failed',
]);
export type CommitPlanStatus = z.infer<typeof CommitPlanStatus>;

export const CommitPlan = z.object({
  status: CommitPlanStatus,
  message: z.string().nullable(),
  // The branch the commit goes on; null when the folder is on no branch and the dialog asks for
  // a new one.
  branch: z.string().nullable(),
  // The commit the folder is on, short.
  head: z.string().nullable(),
  // The names of the commit hooks that will run (pre-commit, prepare-commit-msg, commit-msg,
  // post-commit), from the repository's hooks folder or its `core.hooksPath`.
  hooks: z.array(z.string()),
  // Where the hooks were looked for, as git names it.
  hooksPath: z.string().nullable(),
  files: z.array(CommitFile),
  // Files past `diff.maxFiles` that are not listed.
  omitted: z.number().int().nonnegative(),
});
export type CommitPlan = z.infer<typeof CommitPlan>;

export const CommitParams = z.object({
  threadId: Id,
  files: z.array(RelativePath).min(1),
  message: z.string(),
  // For a folder on no branch (spec 30): the branch made where the folder is.
  newBranch: z.string().min(1).max(250).optional(),
});
export type CommitParams = z.infer<typeof CommitParams>;

export const CommitResult = z.object({ sha: z.string().min(1), subject: z.string() });
export type CommitResult = z.infer<typeof CommitResult>;

// The `data` of a refused `threads.commit` (`rejected`): why in words, and git's and a hook's
// output, its last `chat.commitOutputMaxBytes` bytes (spec 29).
export const CommitRefusal = z.object({ reason: z.string().min(1), output: z.string() });
export type CommitRefusal = z.infer<typeof CommitRefusal>;

// The `committed` line (spec 29): "Committed 3 files · 4e1d2a0 Ring the bell twice".
export const CommittedItemPayload = z.object({
  sha: z.string().min(1),
  subject: z.string(),
  files: z.array(RelativePath),
  branch: z.string().nullable(),
  at: Timestamp,
});
export type CommittedItemPayload = z.infer<typeof CommittedItemPayload>;

export const CodeHostKind = z.enum(['github', 'gitlab']);
export type CodeHostKind = z.infer<typeof CodeHostKind>;

export const BranchCommit = z.object({
  sha: z.string().min(1),
  subject: z.string(),
  body: z.string(),
});
export type BranchCommit = z.infer<typeof BranchCommit>;

// `ok`: Open can go. Anything else is why not, before anything is pushed (spec 33); `existing`
// is a pull request already open for the branch.
export const PullRequestPlanStatus = z.enum([
  'ok',
  'existing',
  'turnRunning',
  'noRepository',
  'gitUnavailable',
  'folderMissing',
  'notChat',
  'noBranch',
  'noRemote',
  'notSetUp',
  'noTarget',
  'isTarget',
  'protected',
  'noCommits',
  'failed',
]);
export type PullRequestPlanStatus = z.infer<typeof PullRequestPlanStatus>;

export const ExistingRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().min(1),
  ref: HostItemRef,
  // Commits of the folder's branch the remote branch does not have yet.
  unpushed: z.number().int().nonnegative(),
});
export type ExistingRequest = z.infer<typeof ExistingRequest>;

export const PullRequestPlan = z.object({
  status: PullRequestPlanStatus,
  message: z.string().nullable(),
  host: CodeHostKind.nullable(),
  // github.com, or the GitLab or Enterprise site's host.
  hostName: z.string(),
  // `acme/tea` or `group/sub/app`.
  repository: z.string(),
  remote: z.string().nullable(),
  branch: z.string().nullable(),
  target: z.string().nullable(),
  // The remote's branches, for the target list.
  branches: z.array(z.string()),
  commits: z.array(BranchCommit),
  // The subject of the only commit, or of the newest, and the commits' messages (spec 31).
  title: z.string(),
  body: z.string(),
  // From `chat.pullRequestDraft`.
  draft: z.boolean(),
  existing: ExistingRequest.nullable(),
  // The setting to fill in when the host is not set up (spec 33).
  missing: z.string().nullable(),
});
export type PullRequestPlan = z.infer<typeof PullRequestPlan>;

export const PullRequestPlanParams = z.object({
  threadId: Id,
  target: z.string().min(1).max(250).optional(),
});
export type PullRequestPlanParams = z.infer<typeof PullRequestPlanParams>;

export const OpenPullRequestParams = z.object({
  threadId: Id,
  target: z.string().min(1).max(250),
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
});
export type OpenPullRequestParams = z.infer<typeof OpenPullRequestParams>;

export const OpenPullRequestResult = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
});
export type OpenPullRequestResult = z.infer<typeof OpenPullRequestResult>;

// The `data` of a refused `threads.openPullRequest` or `threads.pushBranch` (`rejected`): why in
// words, git's output, and whether the branch was pushed before the host refused (spec 34).
export const PullRequestRefusal = z.object({
  reason: z.string().min(1),
  output: z.string(),
  pushed: z.boolean(),
});
export type PullRequestRefusal = z.infer<typeof PullRequestRefusal>;

// The `change_request_opened` line (spec 32): "Opened pull request #14 · Ring the bell twice",
// with the host chip.
export const ChangeRequestOpenedItemPayload = z.object({
  ref: HostItemRef,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().min(1),
  at: Timestamp,
});
export type ChangeRequestOpenedItemPayload = z.infer<typeof ChangeRequestOpenedItemPayload>;

export const ProposalPurpose = z.enum(['commitMessage', 'pullRequest']);
export type ProposalPurpose = z.infer<typeof ProposalPurpose>;

// "Propose" (spec 28, 31): a one-off request to the thread's provider instance and model, outside
// its conversation. `requestId` names it for Cancel.
export const ProposeParams = z.object({
  threadId: Id,
  requestId: z.string().min(1).max(100),
  purpose: ProposalPurpose,
  files: z.array(RelativePath).optional(),
  target: z.string().min(1).max(250).optional(),
});
export type ProposeParams = z.infer<typeof ProposeParams>;

export const ProposeResult = z.union([
  z.object({ text: z.string() }),
  z.object({ title: z.string(), body: z.string() }),
]);
export type ProposeResult = z.infer<typeof ProposeResult>;

// What an adapter answers the `propose` ProviderCommand with.
export const ProposalAnswer = z.object({ text: z.string() });
export type ProposalAnswer = z.infer<typeof ProposalAnswer>;

// How a pull or merge request is named on each host.
export const changeRequestWords = {
  github: { noun: 'pull request', mark: '#' },
  gitlab: { noun: 'merge request', mark: '!' },
} as const satisfies Record<CodeHostKind, { noun: string; mark: string }>;

// A proposed answer: the first line is the subject or title, the rest after a blank line the
// body. Code fences a model wraps the answer in are taken off.
export function splitProposal(text: string): { title: string; body: string } {
  const bare = text
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n```$/, '$1')
    .trim();
  const [first = '', ...rest] = bare.split(/\r?\n/);
  return { title: first.trim(), body: rest.join('\n').trim() };
}
