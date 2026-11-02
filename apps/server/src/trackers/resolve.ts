import {
  settingsRegistry,
  type GitHubRemote,
  type PublishProject,
  type ResolvedSetting,
  type ResolvedTrackerSetting,
  type TrackerSuggestion,
  type TrackerValueSource,
} from '@wow/contracts';
import type { JiraKeyGuess } from '../projects/git.js';

// How a project's tracker settings are worked out (owner decision F-4), without I/O so the order
// is easy to test:
//
//   stored for the project > the project's git remote (GitHub owner, repository and API URL)
//   > the default in Settings → Trackers > the Outlook address (Jira email) > the registry default
//
// Tokens follow the same order without a git or Outlook step: the token stored in Settings →
// Trackers is shared by every project, and a project may store its own to override it.

export const trackerKeys: readonly string[] = Object.entries(settingsRegistry)
  .filter(
    ([key, definition]) =>
      (key.startsWith('trackers.jira.') || key.startsWith('trackers.github.')) &&
      definition.scope === 'project',
  )
  .map(([key]) => key)
  .toSorted();

const sourceOf = (scope: string): TrackerValueSource =>
  scope.startsWith('project:') ? 'project' : scope === 'global' ? 'global' : 'default';

export interface ResolveInput {
  // The settings service's answer for the key in the project's context.
  readonly resolve: (key: string) => ResolvedSetting;
  readonly github: GitHubRemote | null;
  readonly outlookAddress: string | null;
}

export function resolveTrackerSettings(input: ResolveInput): ResolvedTrackerSetting[] {
  const fromRemote: Readonly<Record<string, string | undefined>> = input.github
    ? {
        'trackers.github.owner': input.github.owner,
        'trackers.github.repo': input.github.repo,
        'trackers.github.baseUrl': input.github.apiBaseUrl,
      }
    : {};
  const resolved = trackerKeys.map((key): ResolvedTrackerSetting => {
    const stored = input.resolve(key);
    const source = sourceOf(stored.source);
    const remote = fromRemote[key];
    if (source !== 'project' && remote !== undefined) {
      return { key, value: remote, source: 'gitRemote' };
    }
    return { key, value: stored.value, source };
  });
  const authMode = resolved.find((entry) => entry.key === 'trackers.jira.authMode')?.value;
  return resolved.map((entry) =>
    entry.key === 'trackers.jira.email' &&
    entry.source === 'default' &&
    entry.value === '' &&
    authMode === 'cloud-basic' &&
    input.outlookAddress
      ? { ...entry, value: input.outlookAddress, source: 'outlook' }
      : entry,
  );
}

export interface SuggestionInput {
  readonly settings: readonly ResolvedTrackerSetting[];
  // Jira sites other projects store, with the project names.
  readonly otherSites: readonly { readonly baseUrl: string; readonly projectName: string }[];
  readonly jiraKeys: readonly JiraKeyGuess[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Guesses the user confirms with one press; none of them is used before that.
export function trackerSuggestions(input: SuggestionInput): TrackerSuggestion[] {
  const value = (key: string) => input.settings.find((entry) => entry.key === key);
  const suggestions: TrackerSuggestion[] = [];
  const site = value('trackers.jira.baseUrl');
  if (site?.value === '') {
    const counts = new Map<string, string[]>();
    for (const { baseUrl, projectName } of input.otherSites) {
      if (baseUrl === '') continue;
      counts.set(baseUrl, [...(counts.get(baseUrl) ?? []), projectName]);
    }
    const [best] = [...counts.entries()].toSorted((a, b) => b[1].length - a[1].length);
    if (best) {
      suggestions.push({
        key: 'trackers.jira.baseUrl',
        value: best[0],
        from: 'otherProject',
        detail: `Used by ${best[1].join(', ')}`,
      });
    }
  }
  const projectKey = value('trackers.jira.projectKey');
  const [guess] = input.jiraKeys;
  if (guess && projectKey?.source !== 'project' && projectKey?.value !== guess.key) {
    suggestions.push({
      key: 'trackers.jira.projectKey',
      value: guess.key,
      from: 'gitHistory',
      detail: `Seen in ${plural(guess.issues, 'issue', 'issues')} in recent commits and branches, such as ${guess.example}`,
    });
  }
  return suggestions;
}

export interface ItemLinks {
  // The item's cards with a project, newest first.
  readonly cards: readonly { readonly projectId: string }[];
  // The item's runs, newest first.
  readonly runs: readonly { readonly projectId: string }[];
}

export interface TargetChoice {
  // undefined: work it out from the item; null: the defaults, no project; else that project.
  readonly requested: string | null | undefined;
  readonly links: ItemLinks;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

// Whose tracker settings a publish uses: the project chosen in the dialog, else the project of
// the item's newest card, else of its newest run. Without any, the dialog asks while projects
// exist (needsProject) and the defaults apply until it does.
export function publishTarget(choice: TargetChoice): {
  readonly project: PublishProject | null;
  readonly needsProject: boolean;
} {
  const named = (id: string) => choice.projects.find((project) => project.id === id);
  if (choice.requested === null) return { project: null, needsProject: false };
  if (choice.requested !== undefined) {
    const project = named(choice.requested);
    if (!project) return { project: null, needsProject: choice.projects.length > 0 };
    return { project: { ...project, source: 'chosen' }, needsProject: false };
  }
  for (const [links, source] of [
    [choice.links.cards, 'card'],
    [choice.links.runs, 'run'],
  ] as const) {
    for (const link of links) {
      const project = named(link.projectId);
      if (project) return { project: { ...project, source }, needsProject: false };
    }
  }
  return { project: null, needsProject: choice.projects.length > 0 };
}
