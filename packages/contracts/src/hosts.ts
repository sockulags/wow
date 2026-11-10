import { z } from 'zod';

// What wow reads from a code host (review loop spec 23 and 26 to 32). Orchestration and the UI
// see only these shapes; what a host calls them (pull request, merge request, check run,
// pipeline) stays inside its adapter in apps/server/src/hosts.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// GitHub and GitHub Enterprise Server today; the other hosts join this list with their adapter.
export const HostKind = z.enum(['github']);
export type HostKind = z.infer<typeof HostKind>;

export const hostKindLabels: Readonly<Record<HostKind, string>> = { github: 'GitHub' };

export const ChangeRequestState = z.enum(['open', 'merged', 'closed']);
export type ChangeRequestState = z.infer<typeof ChangeRequestState>;

// `none`: the head commit has no checks, or the host has no checks to ask for.
export const CheckState = z.enum(['none', 'pending', 'success', 'failure']);
export type CheckState = z.infer<typeof CheckState>;

export const HostCheck = z.object({
  name: z.string().min(1),
  state: CheckState.exclude(['none']),
  url: z.string().nullable(),
});
export type HostCheck = z.infer<typeof HostCheck>;

// One `Intent-Unit: <intent-id>/<unit-key>` line of a change request's body.
export const UnitRef = z.object({ intentId: z.string().min(1), unitKey: z.string().min(1) });
export type UnitRef = z.infer<typeof UnitRef>;

export const ReviewComment = z.object({
  id: Id,
  author: z.string(),
  // Written by someone else: shown as text, never run and never put into a prompt.
  body: z.string(),
  // The file the comment is on, when it is on one.
  path: z.string().nullable(),
  url: z.string().min(1),
  createdAt: Timestamp.nullable(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

// A pull request (GitHub) as last read. Later units compare the next read with this row, so it
// keeps the state, the head commit, the check result and the newest comment.
export const ChangeRequest = z.object({
  // `<projectId>:<number>`.
  id: Id,
  projectId: Id,
  host: HostKind,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().min(1),
  state: ChangeRequestState,
  draft: z.boolean(),
  mergedAt: Timestamp.nullable(),
  headBranch: z.string(),
  headSha: z.string(),
  units: z.array(UnitRef),
  checkState: CheckState,
  checks: z.array(HostCheck),
  comments: z.array(ReviewComment),
  newestCommentId: Id.nullable(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

// Why the last read did not work. `notSetUp`: a setting is missing; `refused`: the host turned
// the token down or cannot see the repository with it; `failed`: an error, no answer in time or
// no connection. `setting` is the registry key to look at, when one is to blame.
export const HostErrorKind = z.enum(['notSetUp', 'refused', 'failed']);
export type HostErrorKind = z.infer<typeof HostErrorKind>;

export const HostError = z.object({
  kind: HostErrorKind,
  message: z.string().min(1),
  setting: z.string().nullable(),
  at: Timestamp,
});
export type HostError = z.infer<typeof HostError>;

export const HostReadScope = z.enum(['plan', 'run']);
export type HostReadScope = z.infer<typeof HostReadScope>;

// What was last read for one followed plan or one run: which change requests are its own, when
// that was fetched and what went wrong since. A failed read keeps the last data and its time.
export const HostRead = z.object({
  // `plan:<planIntentId>` or `run:<runId>`.
  id: Id,
  projectId: Id,
  scope: HostReadScope,
  host: HostKind,
  // The host as the user knows it: github.com or the Enterprise host. Empty while not set up.
  hostName: z.string(),
  // For a run: the branch its folder was on, null when it is on none.
  branch: z.string().nullable(),
  changeRequestIds: z.array(Id),
  fetchedAt: Timestamp.nullable(),
  error: HostError.nullable(),
});
export type HostRead = z.infer<typeof HostRead>;

export const hostReadId = (scope: HostReadScope, id: string): string => `${scope}:${id}`;
export const changeRequestId = (projectId: string, number: number): string =>
  `${projectId}:${number}`;

// One scope of a poll as the poller reports it: read, or failed with the reason.
export const HostReadOutcome = z.object({
  id: Id,
  scope: HostReadScope,
  branch: z.string().nullable(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), changeRequestIds: z.array(Id) }),
    z.object({ ok: z.literal(false), error: HostError.omit({ at: true }) }),
  ]),
});
export type HostReadOutcome = z.infer<typeof HostReadOutcome>;

// "Refresh now": one plan, one run, or everything wow follows.
export const HostRefreshParams = z.object({ planId: Id.optional(), runId: Id.optional() });
export type HostRefreshParams = z.infer<typeof HostRefreshParams>;
