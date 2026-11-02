import {
  settingsRegistry,
  type BacklogItem,
  type BacklogRemote,
  type SecretRef,
  type TrackerPreview,
  type TrackerService as TrackerKind,
} from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { backlogItems } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import { createGitHubIssue, type GitHubConfig } from './github.js';
import type { NewIssue, RequestOptions } from './http.js';
import { createJiraIssue, type JiraConfig } from './jira.js';

export interface TrackerServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  // Replaces the global fetch, for tests that do not intercept it.
  readonly fetch?: typeof fetch;
}

type Configured<T> =
  | { readonly config: T; readonly missing: readonly [] }
  | { readonly config: undefined; readonly missing: readonly string[] };

const serviceNames: Readonly<Record<TrackerKind, string>> = { jira: 'Jira', github: 'GitHub' };

// "Publish to Jira" and "Publish to GitHub" (behavior 30): shows the issue it would create, creates
// it on confirm, and stores the key and URL on the item through `backlog.published`. Nothing is
// read back from the tracker afterwards (no status sync, no import).
export class TrackerService {
  readonly #deps: TrackerServiceDeps;
  // One publish per item at a time, so a double click creates one issue.
  readonly #inFlight = new Map<string, Promise<BacklogRemote>>();

  constructor(deps: TrackerServiceDeps) {
    this.#deps = deps;
  }

  async preview(backlogItemId: string, service: TrackerKind): Promise<TrackerPreview> {
    const item = this.#item(backlogItemId);
    const issue = issueOf(item);
    if (service === 'jira') {
      const { config, missing } = await this.#jira();
      return {
        service,
        target: this.#deps.settings.get('trackers.jira.projectKey'),
        ...issue,
        issueType: config?.issueType ?? this.#deps.settings.get('trackers.jira.issueType'),
        labels: [],
        missing: [...missing],
        existing: item.remote,
      };
    }
    const { missing } = await this.#github();
    const owner = this.#deps.settings.get('trackers.github.owner');
    const repo = this.#deps.settings.get('trackers.github.repo');
    return {
      service,
      target: owner && repo ? `${owner}/${repo}` : '',
      ...issue,
      issueType: null,
      labels: [...this.#deps.settings.get('trackers.github.labels')],
      missing: [...missing],
      existing: item.remote,
    };
  }

  publish(backlogItemId: string, service: TrackerKind): Promise<BacklogRemote> {
    const running = this.#inFlight.get(backlogItemId);
    if (running) return running;
    const started = this.#publish(backlogItemId, service).finally(() =>
      this.#inFlight.delete(backlogItemId),
    );
    this.#inFlight.set(backlogItemId, started);
    return started;
  }

  async #publish(backlogItemId: string, service: TrackerKind): Promise<BacklogRemote> {
    const item = this.#item(backlogItemId);
    if (item.remote) {
      throw new CommandRejected(
        'conflict',
        `${item.title} is already published as ${item.remote.key}`,
        item.remote,
      );
    }
    const options: RequestOptions = {
      timeoutMs: this.#deps.settings.get('trackers.requestTimeoutMs'),
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    };
    const created = await this.#create(service, issueOf(item), options);
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
    this.#deps.logger.info('published backlog item', { backlogItemId, key: remote.key });
    return remote;
  }

  async #create(service: TrackerKind, issue: NewIssue, options: RequestOptions) {
    if (service === 'jira') {
      const jira = await this.#jira();
      if (jira.config) return createJiraIssue(jira.config, issue, options);
      throw notSetUp(service, jira.missing);
    }
    const github = await this.#github();
    if (github.config) return createGitHubIssue(github.config, issue, options);
    throw notSetUp(service, github.missing);
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

  async #token(ref: SecretRef | null): Promise<string> {
    if (!ref) return '';
    return (await this.#deps.secrets.resolve(ref)) ?? '';
  }

  async #jira(): Promise<Configured<JiraConfig>> {
    const { settings } = this.#deps;
    const config: JiraConfig = {
      baseUrl: settings.get('trackers.jira.baseUrl'),
      authMode: settings.get('trackers.jira.authMode'),
      email: settings.get('trackers.jira.email'),
      token: await this.#token(settings.get('trackers.jira.token')),
      projectKey: settings.get('trackers.jira.projectKey'),
      issueType: settings.get('trackers.jira.issueType'),
    };
    const missing = [
      config.baseUrl === '' && 'trackers.jira.baseUrl',
      config.authMode === 'cloud-basic' && config.email === '' && 'trackers.jira.email',
      config.token === '' && 'trackers.jira.token',
      config.projectKey === '' && 'trackers.jira.projectKey',
    ].filter((entry): entry is string => typeof entry === 'string');
    return missing.length === 0 ? { config, missing: [] } : { config: undefined, missing };
  }

  async #github(): Promise<Configured<GitHubConfig>> {
    const { settings } = this.#deps;
    const config: GitHubConfig = {
      baseUrl: settings.get('trackers.github.baseUrl'),
      token: await this.#token(settings.get('trackers.github.token')),
      owner: settings.get('trackers.github.owner'),
      repo: settings.get('trackers.github.repo'),
      labels: settings.get('trackers.github.labels'),
    };
    const missing = [
      config.baseUrl === '' && 'trackers.github.baseUrl',
      config.token === '' && 'trackers.github.token',
      config.owner === '' && 'trackers.github.owner',
      config.repo === '' && 'trackers.github.repo',
    ].filter((entry): entry is string => typeof entry === 'string');
    return missing.length === 0 ? { config, missing: [] } : { config: undefined, missing };
  }
}

const labelOf = (key: string) =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

const notSetUp = (service: TrackerKind, missing: readonly string[]) =>
  new CommandRejected(
    'rejected',
    `${serviceNames[service]} is not set up: fill in ${missing.map(labelOf).join(', ')} in Settings → Trackers`,
    { missing },
  );

// The issue is the item's title and its markdown body as written; tags and state stay in wow.
const issueOf = (item: BacklogItem): NewIssue => ({ title: item.title, body: item.body });
