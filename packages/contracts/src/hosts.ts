import { z } from 'zod';

// What wow reads from a code host (review loop spec 23 and 26 to 32). Orchestration and the UI
// see only these shapes; what a host calls them (pull request, merge request, check run,
// pipeline) stays inside its adapter in apps/server/src/hosts.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// GitHub and GitHub Enterprise Server for pull requests, GitLab for merge requests (spec 34), Jira
// (Cloud, Server and Data Center) for tickets, Confluence (Cloud, Server and Data Center) for the
// pages they link to (spec 35).
export const HostKind = z.enum(['github', 'jira', 'gitlab', 'confluence']);
export type HostKind = z.infer<typeof HostKind>;

export const hostKindLabels: Readonly<Record<HostKind, string>> = {
  github: 'GitHub',
  jira: 'Jira',
  gitlab: 'GitLab',
  confluence: 'Confluence',
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

// A pull request (GitHub) or merge request (GitLab) as last read: its state, head commit, checks
// and review comments.
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
  // The head is in another repository than the one wow follows (a fork), or the host did not
  // say it is in this one. Absent on rows read before wow asked.
  fromFork: z.boolean().optional(),
  checkState: CheckState,
  checks: z.array(HostCheck),
  comments: z.array(ReviewComment),
  newestCommentId: Id.nullable(),
  // The web addresses its body links to. Absent on rows read before wow looked for them.
  links: z.array(z.string().min(1)).optional(),
});
export type ChangeRequest = z.infer<typeof ChangeRequest>;

// How the host writes a change request's number: GitLab's merge requests are `!12`, GitHub's
// pull requests `#12`.
export const changeRequestRef = (request: Pick<ChangeRequest, 'host' | 'number'>): string =>
  `${request.host === 'gitlab' ? '!' : '#'}${request.number}`;

// "Merge request !12" or "Pull request #12", for a sentence or a label.
export const changeRequestName = (request: Pick<ChangeRequest, 'host' | 'number'>): string =>
  `${request.host === 'gitlab' ? 'Merge request' : 'Pull request'} ${changeRequestRef(request)}`;

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

// What the host calls a change request: GitLab's are merge requests.
export const changeRequestNoun = (host: HostKind): string =>
  host === 'gitlab' ? 'merge request' : 'pull request';

export const changeRequestId = (projectId: string, number: number): string =>
  `${projectId}:${number}`;

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

// An issue of a code host as last read (agent workbench spec 21): GitHub's or GitLab's. Read
// only, like the rest.
export const IssueState = z.enum(['open', 'closed']);
export type IssueState = z.infer<typeof IssueState>;

export const Issue = z.object({
  host: HostKind,
  number: z.number().int().positive(),
  title: z.string(),
  state: IssueState,
  author: z.string(),
  labels: z.array(z.string()),
  // Markdown as the host has it. Written by someone else: shown through the shared renderer,
  // which never runs HTML, and never put into a prompt.
  body: z.string(),
  url: z.string().min(1),
  comments: z.array(ReviewComment),
});
export type Issue = z.infer<typeof Issue>;

// A Confluence page as last read (review loop spec 35): what the Pages tab lists and the viewer
// shows. Read only.
export const Page = z.object({
  // The page's content id on the host.
  id: Id,
  title: z.string(),
  // The key of the space it is in; empty when the answer did not say.
  space: z.string(),
  // The page's version number when it was read; null when the answer did not say.
  version: z.number().int().positive().nullable(),
  // The rendered body as the host answers it (`body.view`). Written by someone else and HTML: it
  // is only ever shown inside a sandboxed frame where nothing runs and nothing is fetched, and
  // never put into a prompt.
  body: z.string(),
  // The page on the host; null when the host's address is not a web address.
  url: z.string().min(1).nullable(),
});
export type Page = z.infer<typeof Page>;
