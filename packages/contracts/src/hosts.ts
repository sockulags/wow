import { z } from 'zod';

// What wow reads from a code host (review loop spec 23 and 26 to 32). Orchestration and the UI
// see only these shapes; what a host calls them (pull request, merge request, check run,
// pipeline) stays inside its adapter in apps/server/src/hosts.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// GitHub and GitHub Enterprise Server for pull requests, Jira (Cloud, Server and Data Center) for
// tickets; the other hosts join this list with their adapter.
export const HostKind = z.enum(['github', 'jira']);
export type HostKind = z.infer<typeof HostKind>;

export const hostKindLabels: Readonly<Record<HostKind, string>> = {
  github: 'GitHub',
  jira: 'Jira',
};

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

// A ticket as last read (review loop spec 33): what the Ticket tab shows. Read only.
export const Ticket = z.object({
  key: z.string().min(1),
  summary: z.string(),
  status: z.string(),
  // The assignee's display name; null while nobody is assigned.
  assignee: z.string().nullable(),
  type: z.string(),
  // Markdown converted from the host's own markup by its adapter. Written by someone else: shown
  // through the shared renderer, which never runs HTML, and never put into a prompt.
  description: z.string(),
  // The ticket on the host; null when the host's address is not a web address.
  url: z.string().min(1).nullable(),
});
export type Ticket = z.infer<typeof Ticket>;

// Where a run's ticket key came from, in the order it is looked for: the issue its backlog item
// was published as, the title of its pull request, the branch its folder is on.
export const TicketSource = z.enum(['backlog', 'pullRequest', 'branch']);
export type TicketSource = z.infer<typeof TicketSource>;

export const ticketSourceLabels: Readonly<Record<TicketSource, string>> = {
  backlog: 'the issue its backlog item was published as',
  pullRequest: 'the title of its pull request',
  branch: 'the name of its branch',
};

// What was last read about one run's ticket. `key` is null when the run has none; a failed read
// keeps the last ticket of the same key, with its time, beside the error (spec 31).
export const TicketRead = z.object({
  // `run:<runId>`.
  id: Id,
  projectId: Id,
  runId: Id,
  host: HostKind,
  // The Jira site as the user knows it. Empty while not set up.
  hostName: z.string(),
  key: z.string().min(1).nullable(),
  source: TicketSource.nullable(),
  ticket: Ticket.nullable(),
  fetchedAt: Timestamp.nullable(),
  error: HostError.nullable(),
});
export type TicketRead = z.infer<typeof TicketRead>;

// One run's ticket as one poll found it: no key, the ticket, or why it could not be read.
export const TicketReadOutcome = z.object({
  runId: Id,
  key: z.string().min(1).nullable(),
  source: TicketSource.nullable(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), ticket: Ticket.nullable() }),
    z.object({ ok: z.literal(false), error: HostError.omit({ at: true }) }),
  ]),
});
export type TicketReadOutcome = z.infer<typeof TicketReadOutcome>;

// "Refresh now": one plan, one run, or everything wow follows.
export const HostRefreshParams = z.object({ planId: Id.optional(), runId: Id.optional() });
export type HostRefreshParams = z.infer<typeof HostRefreshParams>;
