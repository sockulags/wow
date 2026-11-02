import type { ResolvedSetting } from '@wow/contracts';
import { settingsRegistry } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  publishTarget,
  resolveTrackerSettings,
  trackerKeys,
  trackerSuggestions,
} from './resolve.js';

// Owner decision F-4: which value a project's tracker setting gets, which guesses wow offers, and
// whose settings a publish uses.

const stored =
  (values: Readonly<Record<string, { value: unknown; source: string }>>) =>
  (key: string): ResolvedSetting =>
    values[key]
      ? { key, ...values[key] }
      : {
          key,
          value: settingsRegistry[key as keyof typeof settingsRegistry].default,
          source: 'default',
        };

const remote = {
  owner: 'acme',
  repo: 'widgets',
  host: 'github.com',
  apiBaseUrl: 'https://api.github.com',
  enterprise: false,
};

const valueOf = (settings: ReturnType<typeof resolveTrackerSettings>, key: string) =>
  settings.find((entry) => entry.key === key);

describe('resolveTrackerSettings', () => {
  it('covers every project-scoped tracker setting and no global-only one', () => {
    expect(trackerKeys).toContain('trackers.github.token');
    expect(trackerKeys).toContain('trackers.jira.projectKey');
    expect(trackerKeys).not.toContain('trackers.requestTimeoutMs');
    expect(trackerKeys).not.toContain('trackers.jira.keyScanCommits');
  });

  it('orders project over git remote over the default over the registry', () => {
    const settings = resolveTrackerSettings({
      resolve: stored({
        'trackers.github.owner': { value: 'global-owner', source: 'global' },
        'trackers.github.repo': { value: 'mine', source: 'project:p1' },
        'trackers.github.baseUrl': {
          value: 'https://ghe.example.invalid/api/v3',
          source: 'global',
        },
        'trackers.github.token': {
          value: { secretRef: 'setting:trackers.github.token' },
          source: 'global',
        },
      }),
      github: remote,
      outlookAddress: null,
    });
    expect(valueOf(settings, 'trackers.github.owner')).toEqual({
      key: 'trackers.github.owner',
      value: 'acme',
      source: 'gitRemote',
    });
    expect(valueOf(settings, 'trackers.github.repo')).toMatchObject({
      value: 'mine',
      source: 'project',
    });
    // The remote's host decides the API, over a default set for another host.
    expect(valueOf(settings, 'trackers.github.baseUrl')).toMatchObject({
      value: 'https://api.github.com',
      source: 'gitRemote',
    });
    // The shared token applies to every project that has none of its own.
    expect(valueOf(settings, 'trackers.github.token')).toMatchObject({ source: 'global' });
    expect(valueOf(settings, 'trackers.jira.issueType')).toMatchObject({
      value: 'Task',
      source: 'default',
    });
  });

  it('falls back to the default without a GitHub remote', () => {
    const settings = resolveTrackerSettings({
      resolve: stored({ 'trackers.github.owner': { value: 'acme', source: 'global' } }),
      github: null,
      outlookAddress: null,
    });
    expect(valueOf(settings, 'trackers.github.owner')).toMatchObject({
      value: 'acme',
      source: 'global',
    });
    expect(valueOf(settings, 'trackers.github.repo')).toMatchObject({
      value: '',
      source: 'default',
    });
  });

  it('fills the Jira Cloud email from Outlook only while none is stored', () => {
    const outlookAddress = 'me@example.invalid';
    expect(
      valueOf(
        resolveTrackerSettings({ resolve: stored({}), github: null, outlookAddress }),
        'trackers.jira.email',
      ),
    ).toMatchObject({ value: outlookAddress, source: 'outlook' });
    expect(
      valueOf(
        resolveTrackerSettings({
          resolve: stored({
            'trackers.jira.email': { value: 'other@example.invalid', source: 'global' },
          }),
          github: null,
          outlookAddress,
        }),
        'trackers.jira.email',
      ),
    ).toMatchObject({ value: 'other@example.invalid', source: 'global' });
    expect(
      valueOf(
        resolveTrackerSettings({
          resolve: stored({ 'trackers.jira.authMode': { value: 'pat', source: 'global' } }),
          github: null,
          outlookAddress,
        }),
        'trackers.jira.email',
      ),
    ).toMatchObject({ value: '', source: 'default' });
  });
});

describe('trackerSuggestions', () => {
  const base = resolveTrackerSettings({ resolve: stored({}), github: null, outlookAddress: null });

  it('offers the Jira site other projects use and the key seen in history', () => {
    expect(
      trackerSuggestions({
        settings: base,
        otherSites: [
          { baseUrl: 'https://acme.atlassian.net', projectName: 'Billing' },
          { baseUrl: 'https://acme.atlassian.net', projectName: 'Site' },
          { baseUrl: 'https://old.example.invalid', projectName: 'Legacy' },
        ],
        jiraKeys: [{ key: 'WID', issues: 4, example: 'WID-7' }],
      }),
    ).toEqual([
      {
        key: 'trackers.jira.baseUrl',
        value: 'https://acme.atlassian.net',
        from: 'otherProject',
        detail: 'Used by Billing, Site',
      },
      {
        key: 'trackers.jira.projectKey',
        value: 'WID',
        from: 'gitHistory',
        detail: 'Seen in 4 issues in recent commits and branches, such as WID-7',
      },
    ]);
  });

  it('suggests nothing the project already has', () => {
    const settings = resolveTrackerSettings({
      resolve: stored({
        'trackers.jira.baseUrl': { value: 'https://acme.atlassian.net', source: 'global' },
        'trackers.jira.projectKey': { value: 'OPS', source: 'project:p1' },
      }),
      github: null,
      outlookAddress: null,
    });
    expect(
      trackerSuggestions({
        settings,
        otherSites: [{ baseUrl: 'https://other.example.invalid', projectName: 'Billing' }],
        jiraKeys: [{ key: 'WID', issues: 1, example: 'WID-1' }],
      }),
    ).toEqual([]);
  });
});

describe('publishTarget', () => {
  const projects = [
    { id: 'p1', name: 'Widgets' },
    { id: 'p2', name: 'Billing' },
  ];
  const none = { cards: [], runs: [] };

  it('uses the chosen project, then the card, then the run', () => {
    expect(
      publishTarget({
        requested: 'p2',
        links: { cards: [{ projectId: 'p1' }], runs: [] },
        projects,
      }),
    ).toEqual({
      project: { id: 'p2', name: 'Billing', source: 'chosen' },
      needsProject: false,
    });
    expect(
      publishTarget({
        requested: undefined,
        links: { cards: [{ projectId: 'p1' }], runs: [{ projectId: 'p2' }] },
        projects,
      }).project,
    ).toEqual({ id: 'p1', name: 'Widgets', source: 'card' });
    expect(
      publishTarget({
        requested: undefined,
        links: { cards: [], runs: [{ projectId: 'p2' }] },
        projects,
      }).project,
    ).toEqual({ id: 'p2', name: 'Billing', source: 'run' });
    // A card whose project was removed does not count.
    expect(
      publishTarget({
        requested: undefined,
        links: { cards: [{ projectId: 'gone' }], runs: [{ projectId: 'p2' }] },
        projects,
      }).project?.id,
    ).toBe('p2');
  });

  it('asks for a project when the item has none and projects exist', () => {
    expect(publishTarget({ requested: undefined, links: none, projects })).toEqual({
      project: null,
      needsProject: true,
    });
    expect(publishTarget({ requested: undefined, links: none, projects: [] })).toEqual({
      project: null,
      needsProject: false,
    });
    // "No project" chosen in the dialog: the defaults, without asking again.
    expect(
      publishTarget({
        requested: null,
        links: { cards: [{ projectId: 'p1' }], runs: [] },
        projects,
      }),
    ).toEqual({
      project: null,
      needsProject: false,
    });
  });
});
