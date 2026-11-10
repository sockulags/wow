import { z } from 'zod';

// Per-project tracker settings (owner decision F-4). The server reads each project folder's git
// remotes and recent history; these are the shapes it answers with.

// What wow found in a project folder. `folderMissing` and `noRepository` are shown on the
// project's row (audit E-12); `gitUnavailable` means git could not be run and `.git/config` could
// not be read either.
export const ProjectGitStatus = z.enum([
  'ok',
  'folderMissing',
  'noRepository',
  'noRemote',
  'gitUnavailable',
]);
export type ProjectGitStatus = z.infer<typeof ProjectGitStatus>;

// The GitHub repository a remote points at. `apiBaseUrl` is https://api.github.com for github.com
// and https://<host>/api/v3 for any other host (GitHub Enterprise Server).
export const GitHubRemote = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  host: z.string().min(1),
  apiBaseUrl: z.string().min(1),
  enterprise: z.boolean(),
});
export type GitHubRemote = z.infer<typeof GitHubRemote>;

export const GitRemote = z.object({
  name: z.string().min(1),
  // The fetch URL with any user name and password removed.
  url: z.string().min(1),
  // Null for a local path remote.
  host: z.string().nullable(),
  // "owner/repo" style path without ".git", or null when there is none.
  path: z.string().nullable(),
  // Null when the remote cannot be a GitHub repository (a local path, GitLab subgroups, a known
  // other host).
  github: GitHubRemote.nullable(),
});
export type GitRemote = z.infer<typeof GitRemote>;

export const ProjectGit = z.object({
  projectId: z.string().min(1),
  status: ProjectGitStatus,
  remotes: z.array(GitRemote),
  // The remote wow reads the repository from: origin, else the first GitHub one, else the first.
  primary: z.string().nullable(),
  branch: z.string().nullable(),
  // What git said when it failed, such as "detected dubious ownership".
  message: z.string().nullable(),
});
export type ProjectGit = z.infer<typeof ProjectGit>;

// Where a tracker value came from: stored for the project, from the project's git remote, the
// default set in Settings → Trackers, the Outlook profile, or the registry default.
export const TrackerValueSource = z.enum(['project', 'gitRemote', 'global', 'outlook', 'default']);
export type TrackerValueSource = z.infer<typeof TrackerValueSource>;

export const ResolvedTrackerSetting = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  source: TrackerValueSource,
});
export type ResolvedTrackerSetting = z.infer<typeof ResolvedTrackerSetting>;

// A value wow guessed but does not use until the user confirms it: the Jira site another project
// uses, or a project key seen in branch names and commit messages.
export const TrackerSuggestion = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  from: z.enum(['otherProject', 'gitHistory']),
  // One sentence for the user: "Used by Billing" or "Seen in 12 commits, such as ABC-123".
  detail: z.string(),
});
export type TrackerSuggestion = z.infer<typeof TrackerSuggestion>;

// The GitLab project a remote points at, when the remote is on the GitLab host the user stored in
// `trackers.gitlab.baseUrl`. Nested groups stay in `path` (`group/sub/app`); the API takes the
// whole path, URL-encoded, as one project id.
export const GitLabProject = z.object({
  host: z.string().min(1),
  path: z.string().min(1),
});
export type GitLabProject = z.infer<typeof GitLabProject>;

export const ProjectTrackers = z.object({
  projectId: z.string().min(1),
  git: ProjectGit,
  // The GitLab project of the primary remote, or null when that remote is not on the stored
  // GitLab host. While it is set, the remote names no GitHub repository.
  gitlab: GitLabProject.nullable(),
  // Every trackers.jira.*, trackers.github.* and trackers.gitlab.* setting as it applies to this project.
  settings: z.array(ResolvedTrackerSetting),
  suggestions: z.array(TrackerSuggestion),
});
export type ProjectTrackers = z.infer<typeof ProjectTrackers>;

// Settings that say who signs in, which projects normally share: the publish dialog's inline
// set-up stores them as the default and the rest (where issues go) for the project.
export const trackerAccountKeys: ReadonlySet<string> = new Set([
  'trackers.jira.baseUrl',
  'trackers.jira.authMode',
  'trackers.jira.email',
  'trackers.jira.token',
  'trackers.github.baseUrl',
  'trackers.github.token',
  'trackers.gitlab.baseUrl',
  'trackers.gitlab.token',
  'trackers.confluence.baseUrl',
  'trackers.confluence.authMode',
  'trackers.confluence.email',
  'trackers.confluence.token',
]);

// The accounts "Test connection" signs in to. GitLab (merge requests) and Confluence (linked
// pages) are read only, so they are not publish targets.
export const TrackerConnection = z.enum(['jira', 'github', 'gitlab', 'confluence']);
export type TrackerConnection = z.infer<typeof TrackerConnection>;

export const trackerConnectionLabels: Readonly<Record<TrackerConnection, string>> = {
  jira: 'Jira',
  github: 'GitHub',
  gitlab: 'GitLab',
  confluence: 'Confluence',
};

// How a publish found its project: chosen in the dialog, or from the item's card or run.
export const PublishProjectSource = z.enum(['chosen', 'card', 'run']);
export type PublishProjectSource = z.infer<typeof PublishProjectSource>;

export const PublishProject = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: PublishProjectSource,
});
export type PublishProject = z.infer<typeof PublishProject>;
