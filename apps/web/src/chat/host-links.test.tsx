import type { HostItemRead, HostItemRef, HostLinkRules, ThreadItem } from '@wow/contracts';
import { hostItemKey, hostItemReadId, sameHostItem } from '@wow/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Markdown } from '@/components/markdown';
import { threadMentions } from '@/panel/thread-panel';
import { loadMarkdown } from '../test/markdown';
import {
  BookOpenIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  TicketIcon,
} from 'lucide-react';
import {
  HostLinkContext,
  bareHostRefs,
  hostChipText,
  hostItemIcon,
  hostItemsIn,
  recogniseHostLink,
  recogniseHostRef,
  type HostLinks,
} from './host-links';

beforeAll(loadMarkdown);
afterEach(() => vi.restoreAllMocks());

// Agent workbench spec 19, 20, 21, 23, 24: which links and keys in a chat are chips, what a chip
// says before and after its read, and what Enter and Shift+Enter do. Every site is invented.

const rules: HostLinkRules = {
  sites: [
    { host: 'github', base: 'https://ghe.example.invalid', name: 'ghe.example.invalid' },
    { host: 'gitlab', base: 'https://lab.example.invalid/gitlab', name: 'lab.example.invalid' },
    { host: 'jira', base: 'https://jira.example.invalid', name: 'jira.example.invalid' },
    { host: 'confluence', base: 'https://wiki.example.invalid/wiki', name: 'wiki.example.invalid' },
  ],
  repository: { host: 'github', base: 'https://ghe.example.invalid', path: 'acme/tea' },
  jiraKey: 'DEMO',
};

const gitlabRules: HostLinkRules = {
  ...rules,
  repository: { host: 'gitlab', base: 'https://lab.example.invalid/gitlab', path: 'tea/field' },
};

describe('link recognition @agent-workbench-20 @agent-workbench-23', () => {
  it.each([
    ['https://ghe.example.invalid/acme/tea/pull/14', 'github', 'changeRequest', 'acme/tea', '14'],
    [
      'https://ghe.example.invalid/acme/tea/pull/14/files',
      'github',
      'changeRequest',
      'acme/tea',
      '14',
    ],
    ['https://ghe.example.invalid/acme/other/issues/3', 'github', 'issue', 'acme/other', '3'],
    [
      'https://lab.example.invalid/gitlab/tea/fields/field/-/merge_requests/7',
      'gitlab',
      'changeRequest',
      'tea/fields/field',
      '7',
    ],
    [
      'https://lab.example.invalid/gitlab/tea/field/-/issues/4',
      'gitlab',
      'issue',
      'tea/field',
      '4',
    ],
    ['https://jira.example.invalid/browse/DEMO-42', 'jira', 'ticket', '', 'DEMO-42'],
    [
      'https://wiki.example.invalid/wiki/pages/viewpage.action?pageId=123',
      'confluence',
      'page',
      '',
      'id:123',
    ],
    [
      'https://wiki.example.invalid/wiki/display/ENG/Watering+notes',
      'confluence',
      'page',
      '',
      'title:ENG/Watering notes',
    ],
  ])('reads %s', (link, host, kind, path, id) => {
    expect(recogniseHostLink(link, rules)).toMatchObject({ host, kind, path, id });
  });

  it.each([
    'https://github.com/acme/tea/pull/14',
    'https://ghe.example.invalid/acme/tea/commit/abc123',
    'https://ghe.example.invalid/acme/tea',
    'https://lab.example.invalid/tea/field/-/merge_requests/7',
    'https://jira.example.invalid.evil.invalid/browse/DEMO-42',
    'https://jira.example.invalid/browse/demo-42',
    'https://wiki.example.invalid/pages/viewpage.action?pageId=123',
    'https://me:pw@ghe.example.invalid/acme/tea/pull/14',
    'ftp://ghe.example.invalid/acme/tea/pull/14',
    'javascript:alert(1)',
  ])('leaves %s plain', (link) => {
    expect(recogniseHostLink(link, rules)).toBeUndefined();
  });

  it('reads owner, repository and site prefix without case and decodes path parts once', () => {
    const lower = recogniseHostLink('https://ghe.example.invalid/acme/tea/pull/14', rules);
    const upper = recogniseHostLink('https://GHE.example.invalid/Acme/TEA/pull/14', rules);
    const encoded = recogniseHostLink('https://ghe.example.invalid/acme/te%61/pull/14', rules);
    if (!lower || !upper || !encoded) throw new Error('not recognised');
    expect(sameHostItem(lower, upper)).toBe(true);
    expect(sameHostItem(lower, encoded)).toBe(true);
    expect(encoded.path).toBe('acme/tea');
    const bare = recogniseHostRef('#14', rules);
    if (!bare) throw new Error('no bare item');
    expect(hostItemKey(bare)).toBe(hostItemKey({ ...upper, kind: 'issue' }));
    expect(
      recogniseHostLink('https://lab.example.invalid/GitLab/Tea/Field/-/merge_requests/7', rules),
    ).toMatchObject({ host: 'gitlab', path: 'Tea/Field', id: '7' });
    expect(
      recogniseHostLink('https://lab.example.invalid/gitlab/te%2/field/-/issues/4', rules),
    ).toBeUndefined();
  });

  it.each([
    'https://ghe.example.invalid/acme/te%2561/pull/14',
    'https://ghe.example.invalid/acme/te%3Fa/issues/3',
    'https://lab.example.invalid/gitlab/te%23a/field/-/merge_requests/7',
  ])('gives %s an address that is read again as the same item', (link) => {
    const item = recogniseHostLink(link, rules);
    if (!item) throw new Error('not recognised');
    const again = recogniseHostLink(item.url, rules);
    if (!again) throw new Error('its address is not recognised');
    expect(hostItemKey(again)).toBe(hostItemKey(item));
    expect(again.url).toBe(item.url);
  });

  it('knows no link without a site, as for a host without a token', () => {
    expect(
      recogniseHostLink('https://ghe.example.invalid/acme/tea/pull/14', {
        sites: [],
        repository: null,
        jiraKey: null,
      }),
    ).toBeUndefined();
  });
});

describe('key recognition @agent-workbench-24', () => {
  it('finds the project’s Jira key and its repository’s numbers, nowhere else', () => {
    const text =
      'Fixes DEMO-42 and #14 (see #15). Not DEMO-0, XDEMO-3, OTHER-1, v1#2, a/#3, &#39; or #0.';
    expect(bareHostRefs(text, rules).map((match) => match.text)).toEqual(['DEMO-42', '#14', '#15']);
    expect(bareHostRefs('!7 is no GitHub reference', rules)).toEqual([]);
    expect(
      bareHostRefs('#333, #102030, color: #123; #111 but #123 and #1020', rules).map(
        (match) => match.text,
      ),
    ).toEqual(['#123', '#1020']);
    expect(
      bareHostRefs('Fixes: #123. Closes: #456, see #124; then background-color: #789', rules).map(
        (match) => match.text,
      ),
    ).toEqual(['#123', '#456', '#124']);
  });

  it('reads `!7` and `#4` on a GitLab repository', () => {
    expect(
      bareHostRefs('!7 then #4', gitlabRules).map((match) => [match.text, match.item.kind]),
    ).toEqual([
      ['!7', 'changeRequest'],
      ['#4', 'issue'],
    ]);
  });

  it('has no bare references without a project', () => {
    expect(
      bareHostRefs('DEMO-42 #14', { sites: rules.sites, repository: null, jiraKey: null }),
    ).toEqual([]);
  });

  it('takes one key or an address in the palette, nothing longer', () => {
    expect(recogniseHostRef(' DEMO-42 ', rules)?.url).toBe(
      'https://jira.example.invalid/browse/DEMO-42',
    );
    expect(recogniseHostRef('#14', rules)?.url).toBe(
      'https://ghe.example.invalid/acme/tea/issues/14',
    );
    expect(recogniseHostRef('see DEMO-42', rules)).toBeUndefined();
    expect(recogniseHostRef('https://ghe.example.invalid/acme/tea/pull/14', rules)?.kind).toBe(
      'changeRequest',
    );
  });
});

const pr: HostItemRef = {
  host: 'github',
  kind: 'changeRequest',
  site: 'https://ghe.example.invalid',
  path: 'acme/tea',
  id: '14',
  url: 'https://ghe.example.invalid/acme/tea/pull/14',
};

const prRead: HostItemRead = {
  id: hostItemReadId('t1', pr),
  scope: 'thread',
  threadId: 't1',
  item: pr,
  hostName: 'ghe.example.invalid',
  fetchedAt: '2026-11-12T09:00:00.000Z',
  error: null,
  data: {
    kind: 'changeRequest',
    changeRequest: {
      host: 'github',
      number: 14,
      title: 'Water the beds',
      url: pr.url,
      state: 'open',
      draft: true,
      mergedAt: null,
      headBranch: 'agent/water',
      headSha: 'b2b2b2',
      units: [],
      checkState: 'failure',
      checks: [
        { name: 'test', state: 'failure', url: null },
        { name: 'lint', state: 'failure', url: null },
        { name: 'build', state: 'success', url: null },
      ],
      comments: [],
      newestCommentId: null,
    },
  },
};

const links = (open: (item: HostItemRef) => void): HostLinks => ({
  threadId: 't1',
  rules,
  reads: [prRead],
  open,
});

const at = (ref: string, on: HostLinkRules): HostItemRef => {
  const found = recogniseHostRef(ref, on);
  if (!found) throw new Error(`no item for ${ref}`);
  return found;
};
const read = (item: HostItemRef, data: HostItemRead['data']): HostItemRead => ({
  ...prRead,
  id: hostItemReadId('t1', item),
  item,
  data,
});
const issueOf = (item: HostItemRef, state: 'open' | 'closed'): HostItemRead['data'] => ({
  kind: 'issue',
  issue: {
    host: item.host,
    number: Number(item.id),
    title: 'The kettle whistles',
    state,
    author: 'jon',
    labels: [],
    body: '',
    url: item.url,
    comments: [],
  },
});

describe('chips @agent-workbench-20 @agent-workbench-21', () => {
  it('says the key before the read and adds the state after it', () => {
    expect(hostChipText(pr, undefined)).toBe('PR #14');
    expect(hostChipText(pr, prRead)).toBe('PR #14 · Draft · 2 checks failed');
    const ticket = recogniseHostRef('DEMO-42', rules);
    if (!ticket) throw new Error('no ticket');
    expect(
      hostChipText(ticket, {
        ...prRead,
        item: ticket,
        data: {
          kind: 'ticket',
          ticket: {
            key: 'DEMO-42',
            summary: 'Water on a schedule',
            status: 'To Do',
            assignee: null,
            type: 'Story',
            description: '',
            url: null,
          },
        },
      }),
    ).toBe('DEMO-42 · To Do');
  });

  it('says MR !7 for a GitLab merge request and Issue #n once an issue was read on either host', () => {
    const merge = at('!7', gitlabRules);
    expect(hostChipText(merge, undefined)).toBe('MR !7');
    const githubIssue = at('#3', rules);
    expect(hostChipText(githubIssue, undefined)).toBe('#3');
    expect(hostChipText(githubIssue, read(githubIssue, issueOf(githubIssue, 'open')))).toBe(
      'Issue #3 · Open',
    );
    const gitlabIssue = at('#4', gitlabRules);
    expect(hostChipText(gitlabIssue, undefined)).toBe('Issue #4');
    expect(hostChipText(gitlabIssue, read(gitlabIssue, issueOf(gitlabIssue, 'closed')))).toBe(
      'Issue #4 · Closed',
    );
  });

  it('shows a Confluence page by its link before the read and by its title after it', () => {
    const page = recogniseHostLink(
      'https://wiki.example.invalid/wiki/pages/viewpage.action?pageId=123',
      rules,
    );
    if (!page) throw new Error('no page');
    expect(hostChipText(page, undefined)).toBe('Page 123');
    expect(
      hostChipText(page, {
        ...prRead,
        id: hostItemReadId('t1', page),
        item: page,
        data: {
          kind: 'page',
          page: {
            id: '123',
            title: 'Watering schedule',
            space: 'ENG',
            version: 3,
            body: '',
            url: page.url,
          },
        },
      }),
    ).toBe('Watering schedule');
  });

  it('gives each kind its icon, and a GitHub number the pull request icon once read as one', () => {
    const ofRef = (ref: string, on: HostLinkRules = rules) => {
      const found = recogniseHostRef(ref, on);
      if (!found) throw new Error(`no item for ${ref}`);
      return hostItemIcon(found);
    };
    expect(ofRef('https://ghe.example.invalid/acme/tea/pull/14')).toBe(GitPullRequestIcon);
    expect(ofRef('!7', gitlabRules)).toBe(GitMergeIcon);
    expect(ofRef('#3')).toBe(CircleDotIcon);
    expect(ofRef('DEMO-42')).toBe(TicketIcon);
    expect(ofRef('https://wiki.example.invalid/wiki/pages/viewpage.action?pageId=123')).toBe(
      BookOpenIcon,
    );
    const bare = recogniseHostRef('#14', rules);
    if (!bare) throw new Error('no item');
    expect(hostItemIcon(bare, prRead.data)).toBe(GitPullRequestIcon);
  });

  it('shows links and keys of a message as chips, leaves others links, and opens on Enter', async () => {
    const user = userEvent.setup();
    const open = vi.fn<(item: HostItemRef) => void>();
    const text =
      'See https://ghe.example.invalid/acme/tea/pull/14, [the ticket](https://jira.example.invalid/browse/DEMO-42) and #3. Also `DEMO-7` and [elsewhere](https://github.com/acme/tea/pull/1).';
    render(
      <HostLinkContext value={links(open)}>
        <Markdown text={text} />
      </HostLinkContext>,
    );
    const chips = await screen.findAllByTestId('host-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'PR #14 · Draft · 2 checks failed',
      'DEMO-42',
      '#3',
      'DEMO-7',
    ]);
    expect(screen.getByRole('link', { name: 'elsewhere' }).getAttribute('href')).toBe(
      'https://github.com/acme/tea/pull/1',
    );
    chips[0]?.focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'changeRequest', id: '14' }));
  });

  it('leaves `#n` and `!n` in inline code alone and keeps a Jira key there', async () => {
    render(
      <HostLinkContext value={{ ...links(vi.fn()), rules: gitlabRules }}>
        <Markdown text="Run `#14`, `!7` and ` #4`, but `DEMO-42` is a ticket." />
      </HostLinkContext>,
    );
    const chips = await screen.findAllByTestId('host-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['DEMO-42']);
    expect(screen.getByText('#14').tagName).toBe('CODE');
    expect(screen.getByText('!7').tagName).toBe('CODE');
  });

  it('leaves colours plain (#333, #102030) and keeps issue numbers', async () => {
    render(
      <HostLinkContext value={links(vi.fn())}>
        <Markdown text="Text is #333 on #102030, set color: #123; and see #123 and #45." />
      </HostLinkContext>,
    );
    const chips = await screen.findAllByTestId('host-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['#123', '#45']);
  });

  it('opens the browser on Shift+Enter and Shift+click instead (spec 21)', async () => {
    const user = userEvent.setup();
    const open = vi.fn<(item: HostItemRef) => void>();
    const browser = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <HostLinkContext value={links(open)}>
        <Markdown text="https://jira.example.invalid/browse/DEMO-42" />
      </HostLinkContext>,
    );
    const chip = await screen.findByTestId('host-chip');
    chip.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.keyboard('{Shift>}');
    await user.click(chip);
    await user.keyboard('{/Shift}');
    expect(browser).toHaveBeenCalledTimes(2);
    expect(browser).toHaveBeenCalledWith(
      'https://jira.example.invalid/browse/DEMO-42',
      '_blank',
      'noopener,noreferrer',
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves every link plain outside a chat thread', async () => {
    render(<Markdown text="https://ghe.example.invalid/acme/tea/pull/14 and DEMO-42" />);
    expect(
      (await screen.findByRole('link', { name: 'https://ghe.example.invalid/acme/tea/pull/14' }))
        .tagName,
    ).toBe('A');
    expect(screen.queryByTestId('host-chip')).toBeNull();
  });
});

const item = (id: string, kind: ThreadItem['kind'], payload: unknown): ThreadItem => ({
  id,
  threadId: 't1',
  turnId: 'u1',
  index: 0,
  kind,
  payload,
  streaming: false,
});

describe('links in a draft @agent-workbench-25', () => {
  it('finds the addresses once each without trailing punctuation, and no bare keys', () => {
    const text =
      'See https://ghe.example.invalid/acme/tea/pull/14, (https://jira.example.invalid/browse/DEMO-42) and https://ghe.example.invalid/acme/tea/pull/14. DEMO-7 #3';
    expect(hostItemsIn(text, rules, { linksOnly: true }).map((found) => found.id)).toEqual([
      '14',
      'DEMO-42',
    ]);
    expect(hostItemsIn(text, rules).map((found) => found.id)).toEqual([
      '14',
      'DEMO-42',
      'DEMO-7',
      '3',
    ]);
  });
});

describe('Mentioned @agent-workbench-19', () => {
  it('lists the thread’s paths and host links once each, in the order written', () => {
    const mentioned = threadMentions(
      [
        item('a', 'user', { text: '@docs/spec.md fix DEMO-42', files: ['docs/spec.md'] }),
        item('b', 'assistant_text', {
          text: 'Done in `src/timer.ts`, see [notes](docs/notes.md), https://ghe.example.invalid/acme/tea/pull/14 and DEMO-42 again. `pnpm test` passed.',
        }),
        item('c', 'tool_call', { text: 'src/ignored.ts' }),
      ],
      rules,
    );
    expect(mentioned.files).toEqual(['docs/spec.md', 'src/timer.ts', 'docs/notes.md']);
    expect(mentioned.links.map((link) => `${link.kind}:${link.id}`)).toEqual([
      'ticket:DEMO-42',
      'changeRequest:14',
    ]);
  });
});
