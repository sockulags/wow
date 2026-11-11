import {
  TokenGuideRequest,
  assistantTokenGuideTool,
  settingGroupTitles,
  settingsRegistry,
  type AssistantPlace,
  type TokenGuide,
  type TokenGuideStep,
  type TrackerConnection,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import * as t from '../db/schema.js';
import { RpcFault } from '../rpc/router.js';
import type { Reader, ReaderDeps } from './readers.js';

// Where to make a host token and with which rights (app assistant spec 15). The guides are data
// that ships with wow, one per host kind and sign-in, so the assistant never recalls a token page
// from memory: those pages differ between host versions and a model can be wrong about them
// with confidence. Each names the versions it was written for, and every link is built from the
// address stored in wow, so it opens the user's own host.

export type GuideKind =
  | 'github.com'
  | 'github-enterprise'
  | 'gitlab'
  | 'jira-pat'
  | 'jira-cloud'
  | 'confluence-pat'
  | 'confluence-cloud';

interface GuideData {
  readonly service: TrackerConnection;
  readonly host: string;
  readonly writtenFor: string;
  // The steps, with the web address of the host (no trailing slash) to build links from.
  readonly steps: (web: string) => readonly TokenGuideStep[];
  readonly rights: readonly string[];
  readonly copy: string;
}

const step = (text: string, link: string | null = null): TokenGuideStep => ({ text, link });

// Atlassian Cloud API tokens are made in the Atlassian account, not on the site.
const atlassianTokens = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const github = (web: string): readonly TokenGuideStep[] => [
  step(
    'Open Personal access tokens (classic) under Settings → Developer settings, signed in as the account wow should read as. The link fills in the note and the scope.',
    `${web}/settings/tokens/new?scopes=repo&description=wow`,
  ),
  step('Keep the note "wow", choose an expiration and leave the scope repo ticked.'),
  step('Press Generate token at the bottom of the page.'),
  step(
    'If the organization uses single sign-on, press Configure SSO next to the new token and authorize the organization, or the token sees none of its repositories.',
  ),
];

const githubRights = [
  'repo: wow reads pull requests, their checks and review comments, and Publish creates issues. Classic tokens have no read-only scope for private repositories.',
  'public_repo is enough when every repository wow reads is public.',
];

const githubCopy =
  'The token GitHub shows once after Generate, starting with ghp_. Put it in the field, not in the conversation.';

export const guides: Readonly<Record<GuideKind, GuideData>> = {
  'github.com': {
    service: 'github',
    host: 'github.com',
    writtenFor: 'github.com as of November 2026',
    steps: github,
    rights: githubRights,
    copy: githubCopy,
  },
  'github-enterprise': {
    service: 'github',
    host: 'GitHub Enterprise Server',
    writtenFor: 'GitHub Enterprise Server 3.10 to 3.17',
    steps: github,
    rights: githubRights,
    copy: githubCopy,
  },
  gitlab: {
    service: 'gitlab',
    host: 'GitLab',
    writtenFor: 'GitLab 16.9 and later, self-managed and gitlab.com',
    steps: (web) => [
      step(
        'Open Access tokens under your avatar → Edit profile, signed in as the account wow should read as. The link fills in the name and the scope.',
        `${web}/-/user_settings/personal_access_tokens?name=wow&scopes=read_api`,
      ),
      step(
        'On GitLab before 16.9 the same page is under User settings → Access tokens, at this address instead.',
        `${web}/-/profile/personal_access_tokens`,
      ),
      step('Press Add new token, keep the name "wow", choose an expiry date and tick read_api.'),
      step('Press Create personal access token.'),
    ],
    rights: [
      'read_api: wow reads merge requests, their pipelines and comments, and writes nothing to GitLab.',
      'A project access token with the Reporter role and read_api works too, for that one project.',
    ],
    copy: 'The token GitLab shows once after Create, starting with glpat-. Put it in the field, not in the conversation.',
  },
  'jira-pat': {
    service: 'jira',
    host: 'Jira Server or Data Center',
    writtenFor: 'Jira Software and Jira Service Management Server and Data Center 8.14 and later',
    steps: (web) => [
      step(
        'Open your profile → Personal Access Tokens, signed in as the account wow should act as.',
        `${web}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`,
      ),
      step('Press Create token, name it "wow" and choose when it expires.'),
      step('Press Create.'),
    ],
    rights: [
      'A personal access token acts as your account and has no scopes of its own.',
      'Browse projects in the projects whose tickets wow reads, and Create issues in the project named in Jira project key for Publish.',
    ],
    copy: 'The token Jira shows once after Create. Put it in the field, not in the conversation.',
  },
  'jira-cloud': {
    service: 'jira',
    host: 'Jira Cloud',
    writtenFor: 'Jira Cloud and Atlassian accounts as of November 2026',
    steps: () => [
      step(
        'Open API tokens in your Atlassian account (the same page for every Atlassian Cloud site), signed in as the account wow should act as.',
        atlassianTokens,
      ),
      step(
        'Press Create API token (not the one with scopes), name it "wow" and choose when it expires.',
      ),
      step('Press Create.'),
      step('Put the email of that Atlassian account in Jira email.'),
    ],
    rights: [
      'An API token acts as your account and has no scopes of its own.',
      'Browse projects in the projects whose tickets wow reads, and Create issues in the project named in Jira project key for Publish.',
    ],
    copy: 'The API token Atlassian shows once after Create, starting with ATATT. Put it in the field, not in the conversation.',
  },
  'confluence-pat': {
    service: 'confluence',
    host: 'Confluence Server or Data Center',
    writtenFor: 'Confluence Server and Data Center 7.9 and later',
    steps: (web) => [
      step(
        'Open your profile → Settings → Personal Access Tokens, signed in as the account wow should read as.',
        `${web}/plugins/personalaccesstokens/usertokens.action`,
      ),
      step('Press Create token, name it "wow" and choose when it expires.'),
      step('Press Create.'),
    ],
    rights: [
      'A personal access token acts as your account and has no scopes of its own.',
      'View the spaces of the pages that tickets, pull requests and intents link to. wow only reads pages.',
    ],
    copy: 'The token Confluence shows once after Create. Put it in the field, not in the conversation.',
  },
  'confluence-cloud': {
    service: 'confluence',
    host: 'Confluence Cloud',
    writtenFor: 'Confluence Cloud and Atlassian accounts as of November 2026',
    steps: () => [
      step(
        'Open API tokens in your Atlassian account (the same page for every Atlassian Cloud site), signed in as the account wow should read as.',
        atlassianTokens,
      ),
      step(
        'Press Create API token (not the one with scopes), name it "wow" and choose when it expires.',
      ),
      step('Press Create.'),
      step('Put the email of that Atlassian account in Confluence email.'),
    ],
    rights: [
      'An API token acts as your account and has no scopes of its own.',
      'View the spaces of the pages that tickets, pull requests and intents link to. wow only reads pages.',
    ],
    copy: 'The API token Atlassian shows once after Create, starting with ATATT. Put it in the field, not in the conversation.',
  },
};

const trimmed = (value: string) => value.trim().replace(/\/+$/, '');

// The web pages of a GitHub host from its API address: https://api.github.com is github.com,
// and GitHub Enterprise Server serves its API under https://<host>/api/v3.
function githubWeb(apiUrl: string): { kind: GuideKind; web: string } {
  const url = new URL(apiUrl);
  if (url.hostname === 'api.github.com') return { kind: 'github.com', web: 'https://github.com' };
  const prefix = trimmed(url.pathname).replace(/\/api\/v3$/i, '');
  return { kind: 'github-enterprise', web: `${url.origin}${prefix}` };
}

export interface GuideSettings {
  // The stored address: the GitHub API URL, or the GitLab, Jira or Confluence site.
  readonly baseUrl: string;
  // Jira's and Confluence's sign-in; ignored for GitHub and GitLab.
  readonly authMode: string;
}

const kindOf = (service: TrackerConnection, authMode: string, baseUrl: string): GuideKind => {
  switch (service) {
    case 'github':
      return baseUrl === '' ? 'github.com' : githubWeb(baseUrl).kind;
    case 'gitlab':
      return 'gitlab';
    case 'jira':
      return authMode === 'pat' ? 'jira-pat' : 'jira-cloud';
    case 'confluence':
      return authMode === 'pat' ? 'confluence-pat' : 'confluence-cloud';
  }
};

const label = (key: string) =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

// The guide for a host kind and sign-in at the stored address. Without an address the only
// step is to fill it in, since every link is built from it and wow cannot sign in without it.
export function tokenGuide(
  service: TrackerConnection,
  settings: GuideSettings,
  place: AssistantPlace,
): TokenGuide {
  const baseUrl = trimmed(settings.baseUrl);
  const kind = kindOf(service, settings.authMode, baseUrl);
  const data = guides[kind];
  const addressKey = `trackers.${service}.baseUrl`;
  const common = {
    service,
    host: data.host,
    writtenFor: data.writtenFor,
    tokenSetting: `trackers.${service}.token`,
    rights: [...data.rights],
    copy: data.copy,
  };
  if (baseUrl === '') {
    const description = settingsRegistry[addressKey as keyof typeof settingsRegistry].description;
    return {
      ...common,
      address: null,
      addressNeeded: { key: addressKey, label: label(addressKey), place },
      steps: [
        step(
          `Fill in ${label(addressKey)} in ${place.label} first; the token page is on that host and wow signs in there. ${description}`,
        ),
      ],
    };
  }
  const web = service === 'github' ? githubWeb(baseUrl).web : baseUrl;
  return { ...common, address: web, addressNeeded: null, steps: [...data.steps(web)] };
}

const tokenKey = /^trackers\.(jira|github|gitlab|confluence)\.token$/;

export const serviceOfToken = (key: string): TrackerConnection | undefined => {
  const found = tokenKey.exec(key)?.[1];
  return found === 'jira' || found === 'github' || found === 'gitlab' || found === 'confluence'
    ? found
    : undefined;
};

// The guide as it applies to a project, or to the shared settings without one.
export function guideFor(
  service: TrackerConnection,
  projectId: string | undefined,
  deps: ReaderDeps,
): TokenGuide {
  let place: AssistantPlace = {
    label: `Settings → ${settingGroupTitles.trackers}`,
    path: '/settings/trackers',
  };
  if (projectId !== undefined) {
    const project = deps.db.select().from(t.projects).where(eq(t.projects.id, projectId)).get();
    if (!project) throw new RpcFault('not_found', `No project ${projectId}`);
    place = { label: `Settings → Projects → ${project.name}`, path: '/settings/projects' };
  }
  const read = (key: string) => {
    const value = deps.settings.resolve(key, { projectId }).value;
    return typeof value === 'string' ? value : '';
  };
  const authMode =
    service === 'jira' || service === 'confluence' ? `trackers.${service}.authMode` : null;
  return tokenGuide(
    service,
    { baseUrl: read(`trackers.${service}.baseUrl`), authMode: authMode ? read(authMode) : '' },
    place,
  );
}

export const guideReaders = {
  [assistantTokenGuideTool]: {
    description:
      "How to make the token for Jira, GitHub, GitLab or Confluence, from the guide wow ships: the page on the user's own host (built from the stored address), the steps, the rights it needs and what to copy, and the host versions the guide was written for. Use it instead of what you remember; if it says the address is needed first, ask for that. Give a projectId for a project's own settings.",
    input: TokenGuideRequest,
    read: ({ service, projectId }, deps) => ({
      outcome: 'guide',
      guide: guideFor(service, projectId, deps),
      note: 'Tell the user these steps in your words, with the links as they are, and say which versions the guide was written for. Put the field in front of them with show_secret_field; never ask for the token in the conversation.',
    }),
  } satisfies Reader<typeof TokenGuideRequest>,
} as const;
