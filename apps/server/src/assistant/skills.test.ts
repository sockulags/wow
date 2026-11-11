import type {
  AssistantProposal,
  ServerCommand,
  Skill,
  SubscriptionTopic,
  Workflow,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { ownSkillDir } from '@wow/skills';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { createHandlers, type Connection } from '../rpc/handlers.js';
import { route } from '../rpc/router.js';
import { startServer, type RunningServer } from '../server.js';

// The assistant and wow skills (wow skills spec 21 to 23): it reads the list and a wow skill's
// text, and every own skill it writes, changes or removes waits for the user's yes with the
// whole text on the card. Built-in skills and skills from folders are not its to change.

const now = '2026-11-11T08:00:00.000Z';
const longText = Array.from(
  { length: 12 },
  (_, line) => `Line ${line + 1}: check the kettle before the tea.`,
).join('\n');

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
const proposals = () => rows<AssistantProposal>('assistantProposals');
const ownSkills = () => rows<Skill>('skills').filter((skill) => skill.source === 'yours');
const skillFile = (name: string) =>
  path.join(ownSkillDir(path.join(root, '.wow'), name), 'SKILL.md');

interface Called {
  readonly isError: boolean;
  readonly content: Record<string, unknown> & {
    outcome?: string;
    reason?: string;
    proposal?: Pick<AssistantProposal, 'id' | 'title' | 'lines' | 'place'>;
  };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { isError: result.isError, content: JSON.parse(result.text) as Called['content'] };
}

// The user's yes as the app sends it, through the RPC handler, which looks at the disk first.
function acceptOverRpc(proposalId: string) {
  const handlers = createHandlers({
    engine: server.engine,
    subscriptions: undefined as never,
    workspaces: undefined as never,
    settings: server.settings,
    secrets: undefined as never,
    db: server.database.db,
    skills: server.skills,
    hosts: undefined as never,
    plans: undefined as never,
    workflows: undefined as never,
    providers: undefined as never,
    providerUpdates: undefined as never,
    trackers: undefined as never,
    detectProviders: () => Promise.resolve([]),
    discoverProjects: () => Promise.resolve([]),
    outlook: () => undefined,
    info: { version: '0.0.0', home: path.join(root, '.wow') },
    clock: () => new Date(now),
  });
  const connection: Connection = { push: () => undefined, subscriptionIds: new Set() };
  return route(
    JSON.stringify({
      id: `rpc-${++ids}`,
      method: 'dispatch',
      params: {
        commandId: `rpc-${ids}`,
        command: { type: 'assistant.proposal.accept', proposalId },
      },
    }),
    handlers,
    connection,
    () => undefined,
  );
}

// The user's yes, then the scan its file write queued.
async function accept(proposalId: string): Promise<void> {
  asUser({ type: 'assistant.proposal.accept', proposalId });
  await server.skills.refresh();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-skills-'));
  // A folder skill under ~/.claude/skills, as the user installed it.
  const folder = path.join(root, '.claude', 'skills', 'tidy-up');
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'SKILL.md'),
    '---\nname: tidy-up\ndescription: Tidies the imports.\n---\nTidy the imports.\n',
  );
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
    fetch: () => Promise.resolve(Response.json({})),
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
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({
    type: 'skill.create',
    skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil first.' },
  });
  await server.skills.refresh();
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the assistant reads skills (wow skills spec 21)', () => {
  it('lists every skill with its description and group, yours first, and reads the text of a wow skill', async () => {
    const listed = JSON.parse((await server.assistant.tools.call('read_skills', {})).text) as {
      name: string;
      description: string;
      group: string;
      skillSource?: string;
    }[];
    expect(listed.map(({ name, group }) => `${group}:${name}`)).toEqual([
      'yours:kettle-check',
      'wow:wow-artifacts',
      'wow:wow-handover',
      'wow:wow-pull-request',
      'wow:wow-verdict',
      'user:tidy-up',
    ]);
    expect(listed[0]).toMatchObject({
      description: 'Before any tea step.',
      skillSource: 'yours',
    });
    expect(listed.at(-1)).not.toHaveProperty('skillSource');

    expect((await call('read_skill', { name: 'kettle-check' })).content).toEqual({
      name: 'kettle-check',
      description: 'Before any tea step.',
      group: 'yours',
      text: 'Boil first.',
      changeable: true,
    });
    const verdict = await call('read_skill', { name: 'wow-verdict' });
    expect(verdict.content).toMatchObject({ group: 'wow', changeable: false });
    expect(String(verdict.content['text'])).toContain('{{approvedLine}}');
    const folder = await call('read_skill', { name: 'tidy-up' });
    expect(folder).toMatchObject({ isError: true, content: { outcome: 'refused' } });
    expect(folder.content.reason).toContain('There is no wow skill named tidy-up');
  });
});

describe('own skills the assistant writes wait for a yes (wow skills spec 22)', () => {
  it('proposes a new skill with its whole text, writes nothing until the yes, then the file is there', async () => {
    const proposed = await call('create_skill', {
      skill: { name: 'pour-over', description: 'When tea is poured.', text: longText },
    });
    expect(proposed.content.outcome).toBe('proposed');
    expect(proposed.content.proposal).toMatchObject({
      title: 'Write the skill "pour-over"',
      place: { label: 'Settings → Skills', path: '/settings/skills' },
    });
    const [described, text] = proposals()[0]?.lines ?? [];
    expect(described).toMatchObject({
      what: 'When to use it',
      from: null,
      to: 'When tea is poured.',
    });
    // The card shows the start; the whole text is kept beside it.
    expect(text).toMatchObject({ what: 'Text', from: null, toFull: longText });
    expect(text?.to).not.toBe(longText);
    expect(ownSkills().map((skill) => skill.name)).toEqual(['kettle-check']);
    expect(existsSync(skillFile('pour-over'))).toBe(false);

    await accept(proposals()[0]?.id ?? '');
    expect(ownSkills().map((skill) => skill.name)).toEqual(['kettle-check', 'pour-over']);
    expect(await readFile(skillFile('pour-over'), 'utf8')).toContain('Line 12: check the kettle');
  });

  it('proposes a change with what was and what becomes, and a removal with the text that goes', async () => {
    const changed = await call('update_skill', {
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil twice.' },
    });
    expect(changed.content.proposal).toMatchObject({
      title: 'Change your skill "kettle-check"',
      lines: [{ what: 'Text', from: 'Boil first.', to: 'Boil twice.' }],
    });
    await accept(changed.content.proposal?.id ?? '');
    expect(ownSkills()[0]?.text).toBe('Boil twice.');

    const removed = await call('delete_skill', { name: 'kettle-check' });
    expect(removed.content.proposal).toMatchObject({
      title: 'Remove your skill "kettle-check"',
      lines: [{ what: 'Text', from: 'Boil twice.', to: null }],
    });
    expect(ownSkills()).toHaveLength(1);
    await accept(removed.content.proposal?.id ?? '');
    expect(ownSkills()).toEqual([]);
    expect(existsSync(skillFile('kettle-check'))).toBe(false);
  });

  it('refuses a built-in skill and a skill from another folder, and a name the rule refuses, with the reason', async () => {
    const builtIn = await call('update_skill', {
      skill: { name: 'wow-verdict', description: 'Mine now.', text: 'Say anything.' },
    });
    expect(builtIn.content).toEqual({
      outcome: 'refused',
      reason:
        'wow-verdict ships with wow and cannot be changed or removed. Write an own skill with another name instead.',
    });
    const folder = await call('delete_skill', { name: 'tidy-up' });
    expect(folder.content.outcome).toBe('refused');
    expect(folder.content.reason).toMatch(
      /^tidy-up is a skill from a folder .*wow does not change skills in other folders/,
    );
    const reserved = await call('create_skill', {
      skill: { name: 'wow-kettle', description: '', text: 'Boil.' },
    });
    expect(reserved.content).toEqual({
      outcome: 'refused',
      reason: 'Names starting with wow- are kept for the skills wow ships',
    });
    expect(proposals()).toEqual([]);
  });

  it('refuses a new skill whose folder holds a hand-written skill of another name, and leaves the file', async () => {
    const dir = ownSkillDir(path.join(root, '.wow'), 'sip');
    await mkdir(dir, { recursive: true });
    const handWritten = '---\nname: slow-sip\ndescription: Sip slowly.\n---\nSip it slowly.\n';
    await writeFile(path.join(dir, 'SKILL.md'), handWritten);
    await server.skills.refresh();
    const refused = await call('create_skill', {
      skill: { name: 'sip', description: 'When tea is drunk.', text: 'Drink it.' },
    });
    expect(refused.content).toEqual({
      outcome: 'refused',
      reason: `${path.join(dir, 'SKILL.md')} is already there. Rename or remove it first.`,
    });
    expect(proposals()).toEqual([]);
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(handWritten);
  });

  it('refuses the yes when a SKILL.md the list does not show was put in the folder since', async () => {
    const proposed = await call('create_skill', {
      skill: { name: 'sip', description: 'When tea is drunk.', text: 'Drink it.' },
    });
    // Frontmatter that is not YAML, so the scan skips it.
    const dir = ownSkillDir(path.join(root, '.wow'), 'sip');
    const handWritten = '---\nname: [sip\n---\nMine, by hand.\n';
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), handWritten);
    await server.skills.refresh();
    expect(await acceptOverRpc(proposed.content.proposal?.id ?? '')).toMatchObject({
      error: {
        code: 'rejected',
        message: `${path.join(dir, 'SKILL.md')} is already there. Rename or remove it first.`,
      },
    });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(handWritten);
    expect(proposals()[0]?.state).toBe('pending');
  });

  it('refuses a change to a skill that is not there, and proposes nothing for a change that changes nothing', async () => {
    const unknown = await call('update_skill', {
      skill: { name: 'no-such-tea', description: 'Never.', text: 'Nothing.' },
    });
    expect(unknown.content).toEqual({
      outcome: 'refused',
      reason: 'You have no skill named no-such-tea',
    });
    const same = await call('update_skill', {
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil first.' },
    });
    expect(same.content).toEqual({
      outcome: 'unchanged',
      note: 'It is already so; nothing changed.',
    });
    expect(proposals()).toEqual([]);
  });

  it('is refused at Yes when the skill was changed by hand since the card was written', async () => {
    const changed = await call('update_skill', {
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil twice.' },
    });
    asUser({
      type: 'skill.update',
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Boil once.' },
    });
    expect(() =>
      asUser({ type: 'assistant.proposal.accept', proposalId: changed.content.proposal?.id ?? '' }),
    ).toThrow(/and the skill changed since/);
    expect(ownSkills()[0]?.text).toBe('Boil once.');
  });
});

const workflowStep = (extra: Record<string, unknown> = {}) => ({
  id: 'brew',
  skillName: 'tidy-up',
  providerInstanceId: 'claude-work',
  // What the mock provider offers: the assistant's tools refuse any other model or effort.
  model: 'mock-model',
  effort: 'high',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
  ...extra,
});

describe('Also follow through a workflow change (wow skills spec 23)', () => {
  it('is an ordinary change on a step that waits for the user, and a proposal on a step that acts alone', async () => {
    asUser({ type: 'workflow.create', workflowId: 'tea', name: 'Tea', steps: [workflowStep()] });
    const plain = await call('update_workflow', {
      workflowId: 'tea',
      steps: [
        workflowStep({
          alsoFollow: [{ name: 'kettle-check', source: 'yours' }],
          leaveOut: ['wow-verdict'],
        }),
      ],
    });
    expect(plain.content.outcome).toBe('changed');
    expect(rows<Workflow>('workflows')[0]?.steps[0]).toMatchObject({
      alsoFollow: [{ name: 'kettle-check', source: 'yours' }],
      leaveOut: ['wow-verdict'],
    });

    asUser({
      type: 'workflow.update',
      workflowId: 'tea',
      steps: [workflowStep({ gateAfterCondition: ['verdict'] })],
    });
    const alone = await call('update_workflow', {
      workflowId: 'tea',
      steps: [
        workflowStep({
          gateAfterCondition: ['verdict'],
          alsoFollow: [{ name: 'kettle-check', source: 'yours' }],
        }),
      ],
    });
    expect(alone.content.outcome).toBe('proposed');
    expect(alone.content.proposal?.lines).toContainEqual({
      what: 'Step 1 (tidy-up) also follows',
      from: 'nothing',
      to: 'kettle-check',
    });
  });
});
