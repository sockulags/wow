import {
  TokenGuide,
  defaultSecretPatterns,
  hiddenText,
  looksLikeSecret,
  secretPatterns,
  type ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { guides, tokenGuide } from './guides.js';

// Token guides (app assistant plan U4, spec 15): where to make the token on each host kind and
// sign-in, which rights reading needs and what to copy, with links built from the stored
// address and the host versions each guide was written for. Every address is invented.

let root: string;
let server: RunningServer;
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`g${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });

async function guide(service: string, projectId?: string): Promise<TokenGuide> {
  const result = await server.assistant.tools.call('read_token_guide', {
    service,
    ...(projectId ? { projectId } : {}),
  });
  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.text) as { outcome: string; guide: unknown };
  expect(parsed.outcome).toBe('guide');
  return TokenGuide.parse(parsed.guide);
}

const links = (found: TokenGuide) => found.steps.flatMap((step) => (step.link ? [step.link] : []));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-guides-'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    fetch: () => Promise.resolve(Response.json({})),
  });
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('token guides (spec 15)', () => {
  it("links GitHub Enterprise at a stored address to that host's token page, names the rights reading needs and what to copy", async () => {
    set('trackers.github.baseUrl', 'https://ghe.example.invalid/api/v3');
    const found = await guide('github');
    expect(found).toMatchObject({
      service: 'github',
      host: 'GitHub Enterprise Server',
      tokenSetting: 'trackers.github.token',
      address: 'https://ghe.example.invalid',
      addressNeeded: null,
    });
    expect(links(found)).toEqual([
      'https://ghe.example.invalid/settings/tokens/new?scopes=repo&description=wow',
    ]);
    expect(found.rights.join(' ')).toMatch(/\brepo\b.*pull requests/);
    expect(found.copy).toMatch(/shows once.*ghp_/);
  });

  it('links github.com for the default API address', async () => {
    const found = await guide('github');
    expect(found).toMatchObject({ host: 'github.com', address: 'https://github.com' });
    expect(links(found)).toEqual([
      'https://github.com/settings/tokens/new?scopes=repo&description=wow',
    ]);
  });

  it('links GitHub Enterprise Cloud with data residency at its pages, not at its API host', async () => {
    set('trackers.github.baseUrl', 'https://api.octo-tea.ghe.com');
    const found = await guide('github');
    expect(found).toMatchObject({
      host: 'GitHub Enterprise Cloud with data residency (GHE.com)',
      address: 'https://octo-tea.ghe.com',
    });
    expect(links(found)).toEqual([
      'https://octo-tea.ghe.com/settings/tokens/new?scopes=repo&description=wow',
    ]);
  });

  it("links a project's GitHub token where the poller sends it: its git remote's host, not the stored one", async () => {
    set('trackers.github.baseUrl', 'https://ghe.example.invalid/api/v3');
    const repo = path.join(root, 'leaf');
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://code.leaf.example.invalid/acme/leaf.git');
    dispatch({ type: 'project.create', projectId: 'leaf', name: 'Leaf', cwd: repo });

    const own = await guide('github', 'leaf');
    expect(own.address).toBe('https://code.leaf.example.invalid');
    expect(links(own)).toEqual([
      'https://code.leaf.example.invalid/settings/tokens/new?scopes=repo&description=wow',
    ]);
    const field = await server.assistant.tools.call('show_secret_field', {
      key: 'trackers.github.token',
      projectId: 'leaf',
    });
    expect(field.text).toContain('https://code.leaf.example.invalid/settings/tokens/new');
    // The shared token goes only to the stored host, so its guide stays there.
    expect((await guide('github')).address).toBe('https://ghe.example.invalid');
    // An address the project stores wins over its remote.
    set('trackers.github.baseUrl', 'https://ghe.example.invalid/api/v3', 'project:leaf');
    expect((await guide('github', 'leaf')).address).toBe('https://ghe.example.invalid');
  });

  it("links GitLab's access token page on the stored site with read_api", async () => {
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid/');
    const found = await guide('gitlab');
    expect(found).toMatchObject({ host: 'GitLab', address: 'https://gitlab.example.invalid' });
    expect(links(found)).toEqual([
      'https://gitlab.example.invalid/-/user_settings/personal_access_tokens?name=wow&scopes=read_api',
      'https://gitlab.example.invalid/-/profile/personal_access_tokens',
    ]);
    expect(found.rights[0]).toMatch(/^read_api/);
    expect(found.copy).toMatch(/glpat-/);
  });

  it("links Jira's personal access tokens on the stored site, keeping its path, and Jira Cloud's Atlassian account page", async () => {
    set('trackers.jira.baseUrl', 'https://jira.example.invalid/jira');
    set('trackers.jira.authMode', 'pat');
    const pat = await guide('jira');
    expect(pat.host).toBe('Jira Server or Data Center');
    expect(links(pat)).toEqual([
      'https://jira.example.invalid/jira/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens',
    ]);
    expect(pat.rights.join(' ')).toMatch(/Browse projects/);

    set('trackers.jira.baseUrl', 'https://acme.atlassian.example');
    set('trackers.jira.authMode', 'cloud-basic');
    const cloud = await guide('jira');
    expect(cloud).toMatchObject({ host: 'Jira Cloud', address: 'https://acme.atlassian.example' });
    expect(links(cloud)).toEqual(['https://id.atlassian.com/manage-profile/security/api-tokens']);
    expect(cloud.steps.map((step) => step.text).join(' ')).toMatch(/Jira email/);
    expect(cloud.copy).toMatch(/ATATT/);
  });

  it('links Confluence Server or Data Center and Confluence Cloud by their sign-in', async () => {
    set('trackers.confluence.baseUrl', 'https://confluence.example.invalid');
    const pat = await guide('confluence');
    expect(pat.host).toBe('Confluence Server or Data Center');
    expect(links(pat)).toEqual([
      'https://confluence.example.invalid/plugins/personalaccesstokens/usertokens.action',
    ]);
    set('trackers.confluence.authMode', 'cloud-basic');
    const cloud = await guide('confluence');
    expect(cloud.host).toBe('Confluence Cloud');
    expect(links(cloud)).toEqual(['https://id.atlassian.com/manage-profile/security/api-tokens']);
    expect(cloud.rights.join(' ')).toMatch(/only reads pages/);
  });

  it("uses a project's own address for that project", async () => {
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid');
    set('trackers.gitlab.baseUrl', 'https://code.tea.example.invalid', 'project:tea');
    expect((await guide('gitlab', 'tea')).address).toBe('https://code.tea.example.invalid');
    expect((await guide('gitlab')).address).toBe('https://gitlab.example.invalid');
  });

  it('says the address is needed first when none is stored', async () => {
    for (const service of ['gitlab', 'jira', 'confluence'] as const) {
      const found = await guide(service);
      expect(found).toMatchObject({
        address: null,
        addressNeeded: {
          key: `trackers.${service}.baseUrl`,
          place: { label: 'Settings → Trackers', path: '/settings/trackers' },
        },
      });
      expect(links(found)).toEqual([]);
      expect(found.steps[0]?.text).toMatch(/^Fill in .* URL in Settings → Trackers first/);
    }
    set('trackers.github.baseUrl', '', 'project:tea');
    expect(await guide('github', 'tea')).toMatchObject({
      addressNeeded: {
        key: 'trackers.github.baseUrl',
        place: { label: 'Settings → Projects → Tea', path: '/settings/projects' },
      },
    });
  });

  it('builds every link and the address without the user name, password, query or fragment written into the stored address', async () => {
    const stored = {
      github: 'https://reader:hunter2pass@ghe.example.invalid/api/v3?x=1#top',
      gitlab: 'https://reader:hunter2pass@gitlab.example.invalid/?private_token=1#frag',
      jira: 'https://reader:hunter2pass@jira.example.invalid/jira?a=b',
      confluence: 'https://reader:hunter2pass@confluence.example.invalid/wiki#x',
    } as const;
    set('trackers.jira.authMode', 'pat');
    set('trackers.confluence.authMode', 'pat');
    for (const [service, address] of Object.entries(stored)) {
      set(`trackers.${service}.baseUrl`, address);
      for (const tool of ['read_token_guide', 'show_secret_field'] as const) {
        const args =
          tool === 'read_token_guide' ? { service } : { key: `trackers.${service}.token` };
        const result = await server.assistant.tools.call(tool, args);
        expect(result.isError).toBe(false);
        expect(result.text).not.toMatch(/reader|hunter2pass|private_token|#frag|#top|\?x=1|a=b/);
      }
    }
    expect((await guide('gitlab')).address).toBe('https://gitlab.example.invalid');
    expect(links(await guide('gitlab'))[1]).toBe(
      'https://gitlab.example.invalid/-/profile/personal_access_tokens',
    );
    expect((await guide('github')).address).toBe('https://ghe.example.invalid');
    expect((await guide('jira')).address).toBe('https://jira.example.invalid/jira');
    expect((await guide('confluence')).address).toBe('https://confluence.example.invalid/wiki');
  });

  it('reads settings and diagnoses without the user name and password in a stored address', async () => {
    set('trackers.gitlab.baseUrl', 'https://reader:hunter2pass@gitlab.example.invalid');
    set(
      'trackers.gitlab.baseUrl',
      'https://reader:hunter2pass@code.tea.example.invalid',
      'project:tea',
    );
    for (const [tool, args] of [
      ['read_settings', { group: 'trackers' }],
      ['read_settings', { group: 'trackers', projectId: 'tea' }],
      ['diagnose_setup', {}],
    ] as const) {
      const result = await server.assistant.tools.call(tool, args);
      expect(result.isError).toBe(false);
      expect(result.text).not.toMatch(/reader|hunter2pass/);
    }
    const settings = await server.assistant.tools.call('read_settings', { group: 'trackers' });
    expect(settings.text).toContain('"value":"https://gitlab.example.invalid"');
  });

  it('says which setting to correct when the stored address is not a web address', async () => {
    for (const service of ['github', 'gitlab', 'jira', 'confluence'] as const) {
      set(`trackers.${service}.baseUrl`, 'https://gitlab example invalid');
      const found = await guide(service);
      expect(found).toMatchObject({
        address: null,
        addressNeeded: { key: `trackers.${service}.baseUrl` },
      });
      expect(links(found)).toEqual([]);
      expect(found.steps[0]?.text).toMatch(
        /^Correct .* in Settings → Trackers first: what is stored there is not a web address/,
      );
      const field = await server.assistant.tools.call('show_secret_field', {
        key: `trackers.${service}.token`,
      });
      expect(field.isError).toBe(false);
      expect(field.text).not.toContain('Invalid URL');
    }
  });

  it('names the host versions every guide was written for', () => {
    for (const data of Object.values(guides)) {
      expect(data.writtenFor).toMatch(/\d/);
    }
    expect(guides['github-enterprise'].writtenFor).toBe('GitHub Enterprise Server 3.10 to 3.17');
    expect(guides.gitlab.writtenFor).toMatch(/^GitLab 16\.9 and later/);
    expect(guides['jira-pat'].writtenFor).toMatch(/8\.14/);
    expect(guides['confluence-pat'].writtenFor).toMatch(/7\.9/);
  });

  it('passes the secret net untouched, so no step arrives as [hidden]', async () => {
    const patterns = secretPatterns(defaultSecretPatterns);
    const place = { label: 'Settings → Trackers', path: '/settings/trackers' };
    for (const [service, baseUrl, authMode] of [
      ['github', 'https://api.github.com', ''],
      ['github', 'https://ghe.example.invalid/api/v3', ''],
      ['gitlab', 'https://gitlab.example.invalid', ''],
      ['jira', 'https://jira.example.invalid', 'pat'],
      ['jira', 'https://acme.atlassian.example', 'cloud-basic'],
      ['confluence', 'https://confluence.example.invalid', 'pat'],
      ['confluence', 'https://acme.atlassian.example/wiki', 'cloud-basic'],
    ] as const) {
      const text = JSON.stringify(tokenGuide(service, { baseUrl, authMode }, place));
      expect(looksLikeSecret(text, patterns)).toBe(false);
    }
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid');
    const result = await server.assistant.tools.call('read_token_guide', { service: 'gitlab' });
    expect(result.text).not.toContain(hiddenText);
  });

  it("goes with the secret field of a host token, whose card shows the steps, and not with another secret's", async () => {
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid');
    const shown = await server.assistant.tools.call('show_secret_field', {
      key: 'trackers.gitlab.token',
    });
    const answer = JSON.parse(shown.text) as { guide?: unknown };
    expect(TokenGuide.parse(answer.guide)).toMatchObject({
      host: 'GitLab',
      address: 'https://gitlab.example.invalid',
    });
    const own = await server.assistant.tools.call('show_secret_field', {
      key: 'trackers.jira.token',
      projectId: 'tea',
    });
    expect(JSON.parse(own.text)).toMatchObject({
      guide: {
        host: 'Jira Cloud',
        addressNeeded: { place: { label: 'Settings → Projects → Tea' } },
      },
    });
  });

  it('refuses a project that does not exist and a service it has no guide for', async () => {
    expect(
      await server.assistant.tools.call('read_token_guide', { service: 'gitlab', projectId: 'x' }),
    ).toMatchObject({ isError: true });
    expect(
      await server.assistant.tools.call('read_token_guide', { service: 'bitbucket' }),
    ).toMatchObject({ isError: true });
  });
});
