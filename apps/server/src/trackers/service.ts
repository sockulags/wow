import {
  OutlookProfile,
  SecretRef,
  settingsRegistry,
  type BacklogItem,
  type BacklogRemote,
  type ProjectGit,
  type ProjectTrackers,
  type PublishProject,
  type ResolvedTrackerSetting,
  type TrackerPreview,
  type GitLabProject,
  type TrackerConnection,
  type TrackerTestResult,
  type TrackerService as TrackerKind,
} from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { and, desc, eq, isNotNull, like } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import {
  backlogItems,
  calendarItems,
  outlookStatus,
  projects,
  settings as settingsTable,
  workflowRuns,
} from '../db/schema.js';
import type { Logger } from '../logger.js';
import {
  gitLabProjectOf,
  guessJiraKeys,
  readFolderGit,
  readHistoryTexts,
  type FolderGit,
  type GitRunOptions,
} from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import { createGitHubIssue, type GitHubConfig } from './github.js';
import type { GitLabConfig } from './gitlab.js';
import { TrackerError, type NewIssue, type RequestOptions } from './http.js';
import type { JiraSignIn } from '../hosts/jira.js';
import type { ConfluenceSignIn } from '../hosts/confluence.js';
import { createJiraIssue, type JiraConfig } from './jira.js';
import { publishTarget, resolveTrackerSettings, trackerSuggestions } from './resolve.js';
import { confluenceWhoAmI, gitHubWhoAmI, gitLabWhoAmI, jiraWhoAmI } from './whoami.js';

// The settings a sign-in needs; the project key or repository only matter when publishing.
const signInKeys = new Set([
  'trackers.jira.baseUrl',
  'trackers.jira.email',
  'trackers.jira.token',
  'trackers.github.baseUrl',
  'trackers.github.token',
  'trackers.gitlab.baseUrl',
  'trackers.gitlab.token',
  'trackers.confluence.baseUrl',
  'trackers.confluence.email',
  'trackers.confluence.token',
]);

// Reads a project folder's git state; tests replace it.
export interface GitReader {
  folder(folder: string, options: GitRunOptions): Promise<FolderGit>;
  history(folder: string, commits: number, options: GitRunOptions): Promise<string[]>;
}

const defaultGit: GitReader = { folder: readFolderGit, history: readHistoryTexts };

export interface TrackerServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  // Replaces the global fetch, for tests that do not intercept it.
  readonly fetch?: typeof fetch;
  readonly git?: GitReader;
}

export type Configured<T> =
  | { readonly config: T; readonly missing: readonly [] }
  | { readonly config: undefined; readonly missing: readonly string[] };

export interface ProjectGitHubHost {
  readonly github: Configured<GitHubConfig>;
  // github.com or the Enterprise host; empty while the API URL is not set.
  readonly name: string;
  readonly branch: string | null;
}

export interface ProjectGitLabHost {
  readonly gitlab: Configured<GitLabConfig>;
  // The GitLab site's host.
  readonly name: string;
  readonly branch: string | null;
}

export interface ProjectConfluenceHost {
  readonly confluence: Configured<ConfluenceSignIn>;
  // The stored site, which links must be on to be read; empty while not set.
  readonly baseUrl: string;
  // The Confluence site's host; empty while the URL is not set.
  readonly name: string;
}

export interface ProjectJiraHost {
  readonly jira: Configured<JiraSignIn>;
  // The Jira site's host; empty while the URL is not set.
  readonly name: string;
  // The project's Jira key, for finding ticket keys in titles and branch names. May be empty.
  readonly projectKey: string;
  // The branch the project folder is on, read only when it is needed.
  readonly branch: () => Promise<string | null>;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const serviceNames: Readonly<Record<TrackerKind, string>> = { jira: 'Jira', github: 'GitHub' };

// The secret store entry a project's own token goes to; the shared one is `setting:<key>`.
export const projectSecretPrefix = (projectId: string) => `setting:project:${projectId}:`;

// What one publish, preview or test works with: the project (if any) and its tracker settings.
interface Context {
  readonly project: PublishProject | null;
  readonly needsProject: boolean;
  readonly values: ReadonlyMap<string, ResolvedTrackerSetting>;
}

const hostOf = (url: string): string | null => {
  try {
    const host = new URL(url).host;
    // github.com and <name>.ghe.com serve their API on an api. host of their own.
    return host === 'api.github.com' || /^api\.[a-z0-9-]+\.ghe\.com$/.test(host)
      ? host.slice('api.'.length)
      : host;
  } catch {
    return null;
  }
};

// "Publish to Jira" and "Publish to GitHub" (behavior 30): shows the issue it would create, creates
// it on confirm, and stores the key and URL on the item through `backlog.published`. Nothing is
// read back from the tracker afterwards (no status sync, no import). The settings come from the
// item's project (owner decision F-4, see resolve.ts).
export class TrackerService {
  readonly #deps: TrackerServiceDeps;
  readonly #git: GitReader;
  // One publish per item at a time, so a double click creates one issue.
  readonly #inFlight = new Map<string, Promise<BacklogRemote>>();
  readonly #cleanups = new Set<Promise<void>>();

  constructor(deps: TrackerServiceDeps) {
    this.#deps = deps;
    this.#git = deps.git ?? defaultGit;
    // A removed project's settings go with it (core/projects.ts); its own tokens go here.
    deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind !== 'project.deleted') continue;
        const cleanup = this.#forgetProjectSecrets(event.payload.projectId).finally(() =>
          this.#cleanups.delete(cleanup),
        );
        this.#cleanups.add(cleanup);
      }
    });
  }

  // Settles once the tokens of removed projects are deleted; for tests and shutdown.
  async idle(): Promise<void> {
    await Promise.all(this.#cleanups);
  }

  async #forgetProjectSecrets(projectId: string): Promise<void> {
    try {
      const prefix = projectSecretPrefix(projectId);
      for (const name of await this.#deps.secrets.names()) {
        if (name.startsWith(prefix)) await this.#deps.secrets.delete(name);
      }
    } catch (error) {
      this.#deps.logger.warn('could not delete the tokens of a removed project', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #gitOptions(): GitRunOptions {
    return { timeoutMs: this.#deps.settings.get('trackers.gitTimeoutMs') };
  }

  #project(projectId: string) {
    const project = this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new CommandRejected('not_found', `No project ${projectId}`);
    return project;
  }

  async #folderGit(projectId: string, cwd: string): Promise<ProjectGit> {
    const git: ProjectGit = {
      projectId,
      ...(await this.#git.folder(cwd, this.#gitOptions())),
      codeHost: 'github',
    };
    // The rule gitlabHost gives the poller: GitLab when the remote is on the stored site.
    return this.#gitlabProject(projectId, git) ? { ...git, codeHost: 'gitlab' } : git;
  }

  // Every project's git status and remotes, for Settings → Projects (audit E-12).
  async projectsGit(): Promise<ProjectGit[]> {
    const rows = this.#deps.db.select().from(projects).all();
    return Promise.all(rows.map((project) => this.#folderGit(project.id, project.cwd)));
  }

  #outlookAddress(): string | null {
    const row = this.#deps.db.select().from(outlookStatus).get();
    const profile = OutlookProfile.safeParse(row?.profile);
    return profile.success ? profile.data.address : null;
  }

  // The GitLab project of the folder's primary remote, when that remote is on the GitLab site
  // stored for the project (or as the default).
  #gitlabProject(projectId: string | null, git: ProjectGit | null): GitLabProject | null {
    const primary = git?.remotes.find((remote) => remote.name === git.primary);
    const site = this.#deps.settings.resolve(
      'trackers.gitlab.baseUrl',
      projectId ? { projectId } : {},
    ).value;
    return gitLabProjectOf(primary, typeof site === 'string' ? site : '');
  }

  #resolve(projectId: string | null, git: ProjectGit | null): ResolvedTrackerSetting[] {
    const primary = git?.remotes.find((remote) => remote.name === git.primary);
    return resolveTrackerSettings({
      resolve: (key) => this.#deps.settings.resolve(key, projectId ? { projectId } : {}),
      github: this.#gitlabProject(projectId, git) ? null : (primary?.github ?? null),
      outlookAddress: this.#outlookAddress(),
    });
  }

  async #context(projectId: string | null): Promise<Map<string, ResolvedTrackerSetting>> {
    const project = projectId ? this.#project(projectId) : undefined;
    const git = project ? await this.#folderGit(project.id, project.cwd) : null;
    return new Map(this.#resolve(projectId, git).map((entry) => [entry.key, entry]));
  }

  // One project's tracker settings with their sources, and the guesses to confirm.
  async projectTrackers(projectId: string): Promise<ProjectTrackers> {
    const project = this.#project(projectId);
    const git = await this.#folderGit(project.id, project.cwd);
    const settings = this.#resolve(project.id, git);
    const commits = this.#deps.settings.get('trackers.jira.keyScanCommits');
    const texts =
      git.status === 'ok' || git.status === 'noRemote'
        ? await this.#git.history(project.cwd, commits, this.#gitOptions())
        : [];
    const names = new Map(
      this.#deps.db
        .select()
        .from(projects)
        .all()
        .map((row) => [row.id, row.name]),
    );
    const otherSites = this.#deps.db
      .select()
      .from(settingsTable)
      .where(
        and(eq(settingsTable.key, 'trackers.jira.baseUrl'), like(settingsTable.scope, 'project:%')),
      )
      .all()
      .flatMap((row) => {
        const id = row.scope.slice('project:'.length);
        const name = names.get(id);
        return id !== project.id && name && typeof row.value === 'string'
          ? [{ baseUrl: row.value, projectName: name }]
          : [];
      });
    return {
      projectId,
      git,
      gitlab: this.#gitlabProject(project.id, git),
      settings,
      suggestions: trackerSuggestions({
        settings,
        otherSites,
        jiraKeys: guessJiraKeys(git.branch ? [git.branch, ...texts] : texts),
      }),
    };
  }

  // The GitHub API address a project's own token is sent to (see githubHost): stored for the
  // project, else the host of its folder's git remote, else the shared one.
  async githubAddress(projectId: string): Promise<string> {
    const value = (await this.#context(projectId)).get('trackers.github.baseUrl')?.value;
    return typeof value === 'string' ? value : '';
  }

  // The project's GitHub host as the poller reads it: the same settings a publish uses, the
  // host's name and the branch the project folder is on. Without a token nothing is set up, and
  // the folder's git is not asked.
  //
  // The poller sends the token without anyone pressing a button, so it goes only to a host the
  // user chose: the API URL they stored, or the remote's host when it is the one they stored or
  // when the token is the project's own. A folder's git remote alone can name any host, and a
  // publish shows its target before the user confirms; a poll does not.
  async githubHost(projectId: string): Promise<ProjectGitHubHost | undefined> {
    const project = this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return undefined;
    const tokenSetting = this.#deps.settings.resolve('trackers.github.token', { projectId });
    const token = tokenSetting.value;
    if (!SecretRef.safeParse(token).success) {
      return {
        github: { config: undefined, missing: ['trackers.github.token'] },
        name: '',
        branch: null,
      };
    }
    const git = await this.#folderGit(project.id, project.cwd);
    const values = new Map(this.#resolve(project.id, git).map((entry) => [entry.key, entry]));
    const api = values.get('trackers.github.baseUrl');
    const name = hostOf(String(api?.value ?? '')) ?? '';
    const stored = this.#deps.settings.resolve('trackers.github.baseUrl', { projectId }).value;
    const chosen =
      api?.source !== 'gitRemote' ||
      tokenSetting.source.startsWith('project:') ||
      hostOf(String(stored)) === name;
    if (!chosen) {
      return {
        github: { config: undefined, missing: ['trackers.github.baseUrl'] },
        name,
        branch: git.branch,
      };
    }
    return { github: await this.#github(values), name, branch: git.branch };
  }

  // The project's GitLab site as the poller reads merge requests from it (review loop spec 34),
  // or undefined when the project's remote is not on the stored GitLab site, so its host is
  // GitHub. The site is always one the user stored, so the token goes only there.
  async gitlabHost(projectId: string): Promise<ProjectGitLabHost | undefined> {
    const project = this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return undefined;
    const site = this.#deps.settings.resolve('trackers.gitlab.baseUrl', { projectId }).value;
    if (typeof site !== 'string' || site === '') return undefined;
    const git = await this.#folderGit(project.id, project.cwd);
    const gitlab = this.#gitlabProject(project.id, git);
    if (!gitlab) return undefined;
    const token = await this.#token(
      this.#deps.settings.resolve('trackers.gitlab.token', { projectId }).value,
    );
    return {
      gitlab:
        token === ''
          ? { config: undefined, missing: ['trackers.gitlab.token'] }
          : { config: { baseUrl: site, token, projectPath: gitlab.path }, missing: [] },
      name: hostOf(site) ?? gitlab.host,
      branch: git.branch,
    };
  }

  // The project's Jira site as the poller reads tickets from it: the same sign-in a publish uses.
  // The site is always one the user stored (a git remote never names it), so the token goes
  // only there.
  async jiraHost(projectId: string): Promise<ProjectJiraHost | undefined> {
    const project = this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return undefined;
    const values = new Map(this.#resolve(project.id, null).map((entry) => [entry.key, entry]));
    const config = await this.#jiraConfig(values);
    const missing = [
      config.baseUrl === '' && 'trackers.jira.baseUrl',
      config.authMode === 'cloud-basic' && config.email === '' && 'trackers.jira.email',
      config.token === '' && 'trackers.jira.token',
    ].filter((entry): entry is string => typeof entry === 'string');
    return {
      jira: missing.length === 0 ? { config, missing: [] } : { config: undefined, missing },
      name: hostOf(config.baseUrl) ?? '',
      projectKey: config.projectKey,
      branch: async () => (await this.#folderGit(project.id, project.cwd)).branch,
    };
  }

  // The project's Confluence site as the poller reads linked pages from it (review loop spec 35).
  // The site is always one the user stored, and only links to it are read, so the token goes only
  // there.
  async confluenceHost(projectId: string): Promise<ProjectConfluenceHost | undefined> {
    const project = this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return undefined;
    const confluence = await this.#confluence(project.id);
    const site = this.#deps.settings.resolve('trackers.confluence.baseUrl', { projectId }).value;
    const baseUrl = typeof site === 'string' ? site : '';
    return { confluence, baseUrl, name: hostOf(baseUrl) ?? '' };
  }

  // Whose settings apply to the item: see publishTarget.
  async #target(item: BacklogItem, requested: string | null | undefined): Promise<Context> {
    if (typeof requested === 'string') this.#project(requested);
    const { db } = this.#deps;
    const cards = db
      .select({ projectId: calendarItems.projectId })
      .from(calendarItems)
      .where(and(eq(calendarItems.backlogItemId, item.id), isNotNull(calendarItems.projectId)))
      .orderBy(desc(calendarItems.updatedAt))
      .all()
      .flatMap((row) => (row.projectId ? [{ projectId: row.projectId }] : []));
    const runs = db
      .select({ projectId: workflowRuns.projectId })
      .from(workflowRuns)
      .where(eq(workflowRuns.backlogItemId, item.id))
      .orderBy(desc(workflowRuns.startedAt))
      .all();
    const { project, needsProject } = publishTarget({
      requested,
      links: { cards, runs },
      projects: db.select({ id: projects.id, name: projects.name }).from(projects).all(),
    });
    return { project, needsProject, values: await this.#context(project?.id ?? null) };
  }

  async preview(
    backlogItemId: string,
    service: TrackerKind,
    projectId?: string | null,
  ): Promise<TrackerPreview> {
    const item = this.#item(backlogItemId);
    const issue = issueOf(item);
    const context = await this.#target(item, projectId);
    const { values } = context;
    const read = (key: string) => values.get(key);
    const common = {
      service,
      ...issue,
      existing: item.remote,
      project: context.project,
      needsProject: context.needsProject,
    };
    if (service === 'jira') {
      const { missing } = await this.#jira(values);
      const key = read('trackers.jira.projectKey');
      return {
        ...common,
        target: String(key?.value ?? ''),
        targetSource: key?.source ?? 'default',
        targetHost: hostOf(String(read('trackers.jira.baseUrl')?.value ?? '')),
        issueType: String(read('trackers.jira.issueType')?.value ?? ''),
        labels: [],
        missing: [...missing],
      };
    }
    const { missing } = await this.#github(values);
    const owner = String(read('trackers.github.owner')?.value ?? '');
    const repo = read('trackers.github.repo');
    return {
      ...common,
      target: owner && repo?.value ? `${owner}/${String(repo.value)}` : '',
      targetSource: repo?.source ?? 'default',
      targetHost: hostOf(String(read('trackers.github.baseUrl')?.value ?? '')),
      issueType: null,
      labels: stringList(read('trackers.github.labels')?.value),
      missing: [...missing],
    };
  }

  // "Test connection": signs in with what applies to the project (or the defaults) and says as
  // whom. Failures are answers, not errors, so the page can show them next to the button.
  async test(service: TrackerConnection, projectId?: string): Promise<TrackerTestResult> {
    const options = this.#options();
    const result = (
      ok: boolean,
      account: string | null,
      message: string,
      missing: string[] = [],
      version: string | null = null,
    ) => ({
      service,
      ok,
      account,
      version,
      message,
      missing,
    });
    if (service === 'gitlab') {
      const { config, missing } = await this.#gitlab(projectId ?? null);
      if (!config) {
        return result(false, null, `Fill in ${missing.map(labelOf).join(', ')} first.`, [
          ...missing,
        ]);
      }
      try {
        const { account, version } = await gitLabWhoAmI(config, options);
        const on = version ? ` on GitLab ${version}` : '';
        return result(true, account, `Signed in as ${account}${on}.`, [], version);
      } catch (error) {
        if (error instanceof TrackerError) return result(false, null, error.message);
        throw error;
      }
    }
    if (service === 'confluence') {
      const { config, missing } = await this.#confluence(projectId ?? null);
      if (!config) {
        return result(false, null, `Fill in ${missing.map(labelOf).join(', ')} first.`, [
          ...missing,
        ]);
      }
      try {
        const account = await confluenceWhoAmI(config, options);
        return result(true, account, `Signed in as ${account}.`);
      } catch (error) {
        if (error instanceof TrackerError) return result(false, null, error.message);
        throw error;
      }
    }
    const values = await this.#context(projectId ?? null);
    try {
      const { missing } =
        service === 'jira' ? await this.#jira(values) : await this.#github(values);
      const needed = missing.filter((key) => signInKeys.has(key));
      if (needed.length > 0) {
        return result(false, null, `Fill in ${needed.map(labelOf).join(', ')} first.`, needed);
      }
      // Signing in needs only the account settings, so a missing project key does not stop it.
      const account =
        service === 'jira'
          ? await jiraWhoAmI(await this.#jiraConfig(values), options)
          : await gitHubWhoAmI(await this.#githubConfig(values), options);
      return result(true, account, `Signed in as ${account}.`, [...missing]);
    } catch (error) {
      if (error instanceof TrackerError) return result(false, null, error.message);
      throw error;
    }
  }

  #options(): RequestOptions {
    return {
      timeoutMs: this.#deps.settings.get('trackers.requestTimeoutMs'),
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    };
  }

  publish(
    backlogItemId: string,
    service: TrackerKind,
    edits: IssueEdits = {},
  ): Promise<BacklogRemote> {
    const running = this.#inFlight.get(backlogItemId);
    if (running) return running;
    const started = this.#publish(backlogItemId, service, edits).finally(() =>
      this.#inFlight.delete(backlogItemId),
    );
    this.#inFlight.set(backlogItemId, started);
    return started;
  }

  async #publish(
    backlogItemId: string,
    service: TrackerKind,
    edits: IssueEdits,
  ): Promise<BacklogRemote> {
    const item = this.#item(backlogItemId);
    if (item.remote) {
      throw new CommandRejected(
        'conflict',
        `${item.title} is already published as ${item.remote.key}`,
        item.remote,
      );
    }
    const context = await this.#target(item, edits.projectId);
    const created = await this.#create(service, context, issueOf(item, edits), this.#options());
    const remote: BacklogRemote = { service, ...created };
    try {
      this.#deps.engine.dispatch(`backlog.published:${backlogItemId}`, {
        type: 'backlog.published',
        backlogItemId,
        remote,
      });
    } catch (error) {
      // The issue exists now whatever happened to the item; say where it is.
      this.#deps.logger.warn('published issue could not be stored', { backlogItemId, remote });
      const reason = error instanceof Error ? error.message : String(error);
      throw new CommandRejected(
        'conflict',
        `Created ${created.key} (${created.url}) but could not store it: ${reason}`,
        remote,
      );
    }
    this.#deps.logger.info('published backlog item', {
      backlogItemId,
      key: remote.key,
      projectId: context.project?.id ?? null,
    });
    return remote;
  }

  async #create(service: TrackerKind, context: Context, issue: NewIssue, options: RequestOptions) {
    if (service === 'jira') {
      const jira = await this.#jira(context.values);
      if (jira.config) return createJiraIssue(jira.config, issue, options);
      throw notSetUp(service, jira.missing, context.project);
    }
    const github = await this.#github(context.values);
    if (github.config) return createGitHubIssue(github.config, issue, options);
    throw notSetUp(service, github.missing, context.project);
  }

  #item(backlogItemId: string): BacklogItem {
    const item = this.#deps.db
      .select()
      .from(backlogItems)
      .where(eq(backlogItems.id, backlogItemId))
      .get();
    if (!item) throw new CommandRejected('not_found', `No backlog item ${backlogItemId}`);
    return item;
  }

  async #token(value: unknown): Promise<string> {
    const ref = SecretRef.safeParse(value);
    if (!ref.success) return '';
    return (await this.#deps.secrets.resolve(ref.data)) ?? '';
  }

  async #jiraConfig(values: ReadonlyMap<string, ResolvedTrackerSetting>): Promise<JiraConfig> {
    const text = (key: string) => String(values.get(key)?.value ?? '');
    return {
      baseUrl: text('trackers.jira.baseUrl'),
      authMode: text('trackers.jira.authMode') === 'pat' ? 'pat' : 'cloud-basic',
      email: text('trackers.jira.email'),
      token: await this.#token(values.get('trackers.jira.token')?.value),
      projectKey: text('trackers.jira.projectKey'),
      issueType: text('trackers.jira.issueType'),
    };
  }

  async #githubConfig(values: ReadonlyMap<string, ResolvedTrackerSetting>): Promise<GitHubConfig> {
    const text = (key: string) => String(values.get(key)?.value ?? '');
    return {
      baseUrl: text('trackers.github.baseUrl'),
      token: await this.#token(values.get('trackers.github.token')?.value),
      owner: text('trackers.github.owner'),
      repo: text('trackers.github.repo'),
      labels: stringList(values.get('trackers.github.labels')?.value),
    };
  }

  // GitLab as Test connection signs in to it: the site and token, and the project's path when its
  // remote is on that site, so the test also says whether the token may read the project.
  async #gitlab(projectId: string | null): Promise<Configured<GitLabConfig>> {
    const project = projectId ? this.#project(projectId) : undefined;
    const git = project ? await this.#folderGit(project.id, project.cwd) : null;
    const context = projectId ? { projectId } : {};
    const site = this.#deps.settings.resolve('trackers.gitlab.baseUrl', context).value;
    const baseUrl = typeof site === 'string' ? site : '';
    const token = await this.#token(
      this.#deps.settings.resolve('trackers.gitlab.token', context).value,
    );
    const missing = [
      baseUrl === '' && 'trackers.gitlab.baseUrl',
      token === '' && 'trackers.gitlab.token',
    ].filter((entry): entry is string => typeof entry === 'string');
    if (missing.length > 0) return { config: undefined, missing };
    const projectPath = this.#gitlabProject(projectId, git)?.path ?? '';
    return { config: { baseUrl, token, projectPath }, missing: [] };
  }

  async #confluence(projectId: string | null): Promise<Configured<ConfluenceSignIn>> {
    const context = projectId ? { projectId } : {};
    const read = (key: string) => this.#deps.settings.resolve(key, context).value;
    const config: ConfluenceSignIn = {
      baseUrl: trimmed(read('trackers.confluence.baseUrl')),
      authMode: read('trackers.confluence.authMode') === 'cloud-basic' ? 'cloud-basic' : 'pat',
      email: trimmed(read('trackers.confluence.email')),
      token: await this.#token(read('trackers.confluence.token')),
    };
    const missing = [
      config.baseUrl === '' && 'trackers.confluence.baseUrl',
      config.authMode === 'cloud-basic' && config.email === '' && 'trackers.confluence.email',
      config.token === '' && 'trackers.confluence.token',
    ].filter((entry): entry is string => typeof entry === 'string');
    return missing.length === 0 ? { config, missing: [] } : { config: undefined, missing };
  }

  async #jira(
    values: ReadonlyMap<string, ResolvedTrackerSetting>,
  ): Promise<Configured<JiraConfig>> {
    const config = await this.#jiraConfig(values);
    const missing = [
      config.baseUrl === '' && 'trackers.jira.baseUrl',
      config.authMode === 'cloud-basic' && config.email === '' && 'trackers.jira.email',
      config.token === '' && 'trackers.jira.token',
      config.projectKey === '' && 'trackers.jira.projectKey',
    ].filter((entry): entry is string => typeof entry === 'string');
    return missing.length === 0 ? { config, missing: [] } : { config: undefined, missing };
  }

  async #github(
    values: ReadonlyMap<string, ResolvedTrackerSetting>,
  ): Promise<Configured<GitHubConfig>> {
    const config = await this.#githubConfig(values);
    const missing = [
      config.baseUrl === '' && 'trackers.github.baseUrl',
      config.token === '' && 'trackers.github.token',
      config.owner === '' && 'trackers.github.owner',
      config.repo === '' && 'trackers.github.repo',
    ].filter((entry): entry is string => typeof entry === 'string');
    return missing.length === 0 ? { config, missing: [] } : { config: undefined, missing };
  }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const labelOf = (key: string) =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

const notSetUp = (
  service: TrackerKind,
  missing: readonly string[],
  project: PublishProject | null,
) =>
  new CommandRejected(
    'rejected',
    `${serviceNames[service]} is not set up: fill in ${missing.map(labelOf).join(', ')} in ${
      project ? `Settings → Projects → ${project.name}` : 'Settings → Trackers'
    }`,
    { missing },
  );

// What the user may change in the preview before creating the issue, and the project chosen there.
export interface IssueEdits {
  readonly title?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly projectId?: string | null | undefined;
}

// The issue is the item's title (or the one edited in the preview) and its markdown body; the
// clients convert the body for their tracker. Tags become labels only when picked; state stays
// in wow.
const issueOf = (item: BacklogItem, edits: IssueEdits = {}): NewIssue => ({
  title: edits.title?.trim() || item.title,
  body: item.body,
  ...(edits.labels && edits.labels.length > 0 ? { labels: edits.labels } : {}),
});
