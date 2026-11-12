import {
  assistantToolWords,
  type AssistantChange,
  type AssistantProposal,
  type ServerCommand,
  type SettingRow,
  type SubscriptionTopic,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';

// Agent workbench U13 on the server: the assistant's "always allow" rule proposal (spec 41),
// its tools in words (spec 82) and change rows in the settings page's words (spec 95).

const now = '2026-11-12T08:00:00.000Z';

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
const proposals = () => rows<AssistantProposal>('assistantProposals');
const changes = () => rows<AssistantChange>('assistantChanges');
const setting = (key: string, scope = 'global') =>
  rows<SettingRow>('settings').find((row) => row.key === key && row.scope === scope)?.value;

interface Called {
  readonly isError: boolean;
  readonly content: {
    outcome?: string;
    reason?: string;
    proposal?: Pick<AssistantProposal, 'id' | 'title' | 'lines' | 'place'>;
    change?: Pick<AssistantChange, 'id' | 'what' | 'from' | 'to' | 'place'>;
  };
}

async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { isError: result.isError, content: JSON.parse(result.text) as Called['content'] };
}

const propose = (rule: Record<string, unknown>, projectId = 'tea') =>
  call('propose_always_allow_rule', { projectId, rule });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-polish-'));
  await mkdir(path.join(root, 'tea'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
  });
  asUser({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Claude at work',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
  });
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the assistant proposes an always-allow rule (spec 41)', () => {
  it('waits for a yes, stores nothing on No and the rule only on Yes', async () => {
    const proposed = await propose({ kind: 'command', prefix: '  pnpm   test ' });
    expect(proposed).toMatchObject({ isError: false, content: { outcome: 'proposed' } });
    expect(proposed.content.proposal).toEqual({
      id: expect.any(String) as string,
      title: 'Always allow `pnpm test` in Tea',
      lines: [{ what: 'Always allow', from: null, to: 'Run commands starting with `pnpm test`' }],
      place: { label: 'Settings → Approvals', path: '/settings/approvals' },
    });
    expect(setting('approvals.alwaysAllow', 'project:tea')).toBeUndefined();

    asUser({ type: 'assistant.proposal.decline', proposalId: proposed.content.proposal?.id ?? '' });
    expect(setting('approvals.alwaysAllow', 'project:tea')).toBeUndefined();

    const again = await propose({ kind: 'command', prefix: 'pnpm test' });
    asUser({ type: 'assistant.proposal.accept', proposalId: again.content.proposal?.id ?? '' });
    expect(setting('approvals.alwaysAllow', 'project:tea')).toEqual([
      { kind: 'command', prefix: 'pnpm test', addedAt: now },
    ]);
    expect(proposals().map((proposal) => proposal.state)).toEqual(['declined', 'accepted']);
    expect(changes()).toEqual([]);

    // A rule the project has is already so.
    expect((await propose({ kind: 'command', prefix: 'pnpm test' })).content).toMatchObject({
      outcome: 'unchanged',
    });
  });

  it('proposes a tool rule beside the stored ones, and the same card for set_setting', async () => {
    asUser({
      type: 'setting.set',
      key: 'approvals.alwaysAllow',
      scope: 'project:tea',
      value: [{ kind: 'command', prefix: 'pnpm lint', addedAt: now }],
    });
    const tool = await propose({ kind: 'tool', server: 'github', tool: 'create_issue' });
    expect(tool.content.proposal).toMatchObject({
      title: 'Always allow the tool `github › create_issue` in Tea',
      lines: [{ what: 'Always allow', from: null, to: 'Use the tool `github › create_issue`' }],
    });
    asUser({ type: 'assistant.proposal.accept', proposalId: tool.content.proposal?.id ?? '' });
    expect(setting('approvals.alwaysAllow', 'project:tea')).toEqual([
      { kind: 'command', prefix: 'pnpm lint', addedAt: now },
      { kind: 'tool', server: 'github', tool: 'create_issue', addedAt: now },
    ]);

    const direct = await call('set_setting', {
      key: 'approvals.alwaysAllow',
      scope: 'project:tea',
      value: [{ kind: 'command', prefix: 'pnpm build', addedAt: now }],
    });
    expect(direct.content.proposal).toMatchObject({
      title: 'Change what is always allowed in Tea',
      lines: [
        { what: 'Always allow', from: null, to: 'Run commands starting with `pnpm build`' },
        { what: 'Always allow', from: 'Run commands starting with `pnpm lint`', to: null },
        {
          what: 'Always allow',
          from: 'Use the tool `github › create_issue`',
          to: null,
        },
      ],
    });
  });

  it('refuses a rule that would allow more than the command, and an unknown project', async () => {
    for (const prefix of ['bash', 'npx vitest', 'pnpm test && rm -rf .', 'node -e']) {
      const refused = await propose({ kind: 'command', prefix });
      expect({ prefix, ...refused }).toMatchObject({
        prefix,
        isError: true,
        content: { outcome: 'refused' },
      });
    }
    expect((await propose({ kind: 'command', prefix: 'bash' })).content.reason).toBe(
      'Run commands starting with `bash` would allow more than that command, so wow offers no rule for it.',
    );
    expect(
      (await propose({ kind: 'command', prefix: 'pnpm test' }, 'nowhere')).content,
    ).toMatchObject({ outcome: 'refused', reason: 'There is no project nowhere.' });
    expect(proposals()).toEqual([]);
  });
});

const rule = (prefix: string) => ({ kind: 'command', prefix, addedAt: now });

describe('rules only for a project, through any tool', () => {
  it('refuses always-allow rules at a scope that is not an existing project', async () => {
    for (const scope of ['global', 'project:nowhere', 'provider:claude-work']) {
      const refused = await call('set_setting', {
        key: 'approvals.alwaysAllow',
        scope,
        value: [rule('rm')],
      });
      expect({ scope, ...refused }).toMatchObject({
        scope,
        isError: true,
        content: { outcome: 'refused' },
      });
      expect(refused.content.reason).toContain('propose_always_allow_rule');
    }
    expect(proposals()).toEqual([]);
  });

  it("compares and adds a rule against the project's own list, not a global one", async () => {
    // A value at global scope from before the scope was refused: nothing reads it.
    asUser({
      type: 'setting.set',
      key: 'approvals.alwaysAllow',
      scope: 'global',
      value: [rule('pnpm test'), rule('pnpm lint')],
    });
    const proposed = await propose({ kind: 'command', prefix: 'pnpm test' });
    expect(proposed.content).toMatchObject({ outcome: 'proposed' });
    asUser({ type: 'assistant.proposal.accept', proposalId: proposed.content.proposal?.id ?? '' });
    expect(setting('approvals.alwaysAllow', 'project:tea')).toEqual([rule('pnpm test')]);
  });

  it('refuses through set_setting a rule for a command that runs other commands', async () => {
    for (const prefix of ['bash -c', 'pnpm test`; rm']) {
      const refused = await call('set_setting', {
        key: 'approvals.alwaysAllow',
        scope: 'project:tea',
        value: [rule(prefix)],
      });
      expect({ prefix, ...refused }).toMatchObject({
        prefix,
        isError: true,
        content: { outcome: 'refused' },
      });
      expect(refused.content.reason).toContain(
        'would allow more than that command, so wow offers no rule for it.',
      );
    }
    expect(proposals()).toEqual([]);
  });
});

describe("the assistant's tools in words (spec 82)", () => {
  it('names every tool it offers in words', () => {
    const names = server.assistant.tools.list().map((tool) => tool.name);
    expect(names.filter((name) => assistantToolWords[name] === undefined)).toEqual([]);
  });
});

describe('change rows in the words of the settings page (spec 95)', () => {
  it('says work hours as the page does and a model by its label', async () => {
    const hours = await call('set_setting', {
      key: 'calendar.workHours',
      scope: 'global',
      value: {
        start: '08:00',
        end: '16:00',
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      },
    });
    expect(hours.content.change).toMatchObject({
      from: 'From Outlook',
      to: '08:00–16:00, Mon–Fri',
    });

    // The label comes from the provider's own list, once it was asked for it.
    await server.providerService.listModels('claude-work');
    const model = await call('set_setting', {
      key: 'assistant.model',
      scope: 'global',
      value: 'mock-model-large',
    });
    expect(model.content.change).toMatchObject({
      what: 'Model',
      from: 'None (default)',
      to: 'Mock model, large',
    });
    const paused = await call('set_setting', {
      key: 'calendar.snapMinutes',
      scope: 'global',
      value: 30,
    });
    expect(paused.content.change?.to).toBe('30 min');
  });
});
