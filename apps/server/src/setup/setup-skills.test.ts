import { settingsRegistry as registry, type ServerCommand, type Skill } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { ownSkillDir } from '@wow/skills';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify as stringifyYaml } from 'yaml';
import { readModel } from '../core/projector.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { createHandlers, type Connection } from '../rpc/handlers.js';
import { route } from '../rpc/router.js';
import { startServer, type RunningServer } from '../server.js';
import { planSetup } from './plan.js';
import { writeSetup } from './write.js';

// Own skills in the setup file (wow skills spec 8): saved with the file, shown in the preview
// as added or replaced with their whole text, applied as part of the file and taken back by
// its one Undo.

const now = '2026-11-11T09:00:00.000Z';
const kettleText = 'Boil the water first.\nThen pour it over the leaves and wait three minutes.';

let root: string;
let source: RunningServer;
let other: RunningServer;
let ids = 0;

const on = (server: RunningServer, command: ServerCommand) =>
  server.engine.dispatch(`k${++ids}`, command);

const home = (name: string) => path.join(root, name, '.wow');

async function start(name: string): Promise<RunningServer> {
  const server = await startServer({
    home: home(name),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, name, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
    fetch: () => Promise.resolve(Response.json({})),
    hooks: { providers: { claude: () => new MockProviderAdapter('claude', () => []) } },
  });
  on(server, {
    type: 'providerInstance.create',
    providerInstanceId: `claude-${name}`,
    kind: 'claude',
    name: 'Claude',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  return server;
}

// A command that writes an own skill, then the scan it queued, so the list is what is on disk.
async function write(server: RunningServer, command: ServerCommand): Promise<void> {
  on(server, command);
  await server.skills.refresh();
}

const ownSkills = (server: RunningServer): Skill[] =>
  readModel(server.database.db)
    .skills()
    .filter((skill) => skill.source === 'yours');

const save = (server: RunningServer) =>
  writeSetup(readModel(server.database.db), { now, registry, version: '0.1.2' });

const preview = (server: RunningServer, text: string, name: string) =>
  planSetup(text, readModel(server.database.db), { now, registry, home: home(name) });

// setup.apply as the app sends it, through the RPC handler, which looks at the disk first.
function applyOverRpc(server: RunningServer, name: string, text: string) {
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
    info: { version: '0.0.0', home: home(name) },
    clock: () => new Date(now),
  });
  const connection: Connection = { push: () => undefined, subscriptionIds: new Set() };
  const command = { type: 'setup.apply', applicationId: `a${++ids}`, name: 'tea.yaml', text };
  return route(
    JSON.stringify({
      id: `rpc-${ids}`,
      method: 'dispatch',
      params: { commandId: `rpc-${ids}`, command },
    }),
    handlers,
    connection,
    () => undefined,
  );
}

const steepFile = [
  'version: 1',
  'skills:',
  '  - name: steep',
  '    description: When leaves steep.',
  '    text: Three minutes.',
  '',
].join('\n');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-setup-skills-'));
  source = await start('source');
  other = await start('other');
  await write(source, {
    type: 'skill.create',
    skill: { name: 'kettle-check', description: 'Before any tea step.', text: kettleText },
  });
});

afterEach(async () => {
  await source.stop();
  await other.stop();
  await rm(root, { recursive: true, force: true });
});

// A step that runs the folder skill kettle-check and also follows these.
const followStep = (id: string, alsoFollow: { name: string; source?: 'yours' }[]) => ({
  id,
  skillName: 'kettle-check',
  providerInstanceId: 'claude-source',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  alsoFollow,
});
describe('own skills in a setup file (wow skills spec 8)', () => {
  it('saves own skills with their text, and neither built-in nor folder skills', () => {
    const file = parse(save(source).text) as { skills?: unknown };
    expect(file.skills).toEqual([
      { name: 'kettle-check', description: 'Before any tea step.', text: kettleText },
    ]);
  });

  it('previews a new skill as added with its full text, applies it as a file under wow home, and one Undo removes it', async () => {
    const { text } = save(source);
    const plan = preview(other, text, 'other');
    if (plan.outcome !== 'ready') throw new Error(JSON.stringify(plan.problems));
    expect(plan.preview.added).toContainEqual({
      what: 'Skill "kettle-check"',
      from: null,
      to: 'Before any tea step.',
      full: kettleText,
    });

    const applicationId = 'apply-kettle';
    await write(other, { type: 'setup.apply', applicationId, name: 'team.yaml', text });
    expect(ownSkills(other).map(({ name, text: body }) => ({ name, body }))).toEqual([
      { name: 'kettle-check', body: kettleText },
    ]);
    const file = path.join(ownSkillDir(home('other'), 'kettle-check'), 'SKILL.md');
    expect(await readFile(file, 'utf8')).toContain('Then pour it over the leaves');

    await write(other, { type: 'setup.undo', applicationId });
    expect(ownSkills(other)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('previews a skill of the same name as replaced, and Undo puts the old text back', async () => {
    await write(other, {
      type: 'skill.create',
      skill: { name: 'kettle-check', description: 'Before any tea step.', text: 'Old text.' },
    });
    const { text } = save(source);
    const plan = preview(other, text, 'other');
    if (plan.outcome !== 'ready') throw new Error(JSON.stringify(plan.problems));
    expect(plan.preview.added).toEqual([]);
    expect(plan.preview.replaced).toEqual([
      {
        what: 'Skill "kettle-check"',
        from: 'Before any tea step.',
        to: 'Before any tea step. (the text differs)',
        full: kettleText,
      },
    ]);
    await write(other, { type: 'setup.apply', applicationId: 'a2', name: 'team.yaml', text });
    expect(ownSkills(other)[0]?.text).toBe(kettleText);
    await write(other, { type: 'setup.undo', applicationId: 'a2' });
    expect(ownSkills(other)[0]?.text).toBe('Old text.');
  });

  it('marks no workflow whose step follows a skill the same file brings', () => {
    on(source, {
      type: 'workflow.create',
      workflowId: 'tea',
      name: 'Tea',
      steps: [
        {
          id: 'brew',
          skillName: 'kettle-check',
          skillSource: 'yours',
          alsoFollow: [{ name: 'kettle-check', source: 'yours' }],
          providerInstanceId: 'claude-source',
          gateBefore: false,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
    const plan = preview(other, save(source).text, 'other');
    if (plan.outcome !== 'ready') throw new Error(JSON.stringify(plan.problems));
    expect(plan.preview.marked).toEqual([]);
  });

  it('refuses a skill whose folder holds a hand-written skill of another name, with the line, and leaves the file', async () => {
    const dir = ownSkillDir(home('other'), 'steep');
    const handWritten = '---\nname: brew-notes\ndescription: Notes.\n---\nWrite the notes.\n';
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), handWritten);
    await other.skills.refresh();
    expect(preview(other, steepFile, 'other')).toEqual({
      outcome: 'refused',
      problems: [
        {
          line: 3,
          reason: `${path.join(dir, 'SKILL.md')} is already there. Rename or remove it first.`,
        },
      ],
    });
    expect(await applyOverRpc(other, 'other', steepFile)).toMatchObject({
      error: { code: 'rejected' },
    });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(handWritten);
    expect(ownSkills(other).map((skill) => skill.name)).toEqual(['brew-notes']);
  });

  it('refuses to apply a skill over a SKILL.md the list does not show, and leaves the file', async () => {
    // Frontmatter that is not YAML, so the scan skips it and the preview cannot know.
    const dir = ownSkillDir(home('other'), 'steep');
    const handWritten = '---\nname: [steep\n---\nMine, by hand.\n';
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), handWritten);
    await other.skills.refresh();
    expect(await applyOverRpc(other, 'other', steepFile)).toMatchObject({
      error: {
        code: 'rejected',
        message: `${path.join(dir, 'SKILL.md')} is already there. Rename or remove it first.`,
      },
    });
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(handWritten);
    expect(ownSkills(other)).toEqual([]);
  });

  it('marks a step that follows an own skill only a folder skill of that name stands for, and the reverse', async () => {
    const folder = path.join(root, 'other', 'user', '.claude', 'skills', 'kettle-check');
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, 'SKILL.md'),
      '---\nname: kettle-check\ndescription: A folder skill.\n---\nBoil.\n',
    );
    await write(other, {
      type: 'skill.create',
      skill: { name: 'pour', description: 'When tea is poured.', text: 'Pour slowly.' },
    });
    await write(source, {
      type: 'skill.create',
      skill: { name: 'pour', description: 'When tea is poured.', text: 'Pour slowly.' },
    });
    const workflow = (
      workflowId: string,
      name: string,
      alsoFollow: Parameters<typeof followStep>[1],
    ) =>
      on(source, {
        type: 'workflow.create',
        workflowId,
        name,
        steps: [followStep('brew', alsoFollow)],
      });
    workflow('own-as-folder', 'Own named, folder there', [
      { name: 'kettle-check', source: 'yours' },
    ]);
    workflow('folder-as-own', 'Folder named, own there', [{ name: 'pour' }]);
    workflow('both-right', 'Both right', [{ name: 'pour', source: 'yours' }]);
    const saved = parse(save(source).text) as Record<string, unknown>;
    // Without the file's own skills, so only what the other install has counts.
    const { skills: _left, ...rest } = saved;
    const plan = preview(other, stringifyYaml(rest), 'other');
    if (plan.outcome !== 'ready') throw new Error(JSON.stringify(plan.problems));
    expect(plan.preview.marked).toEqual([
      { workflow: 'Own named, folder there', reason: 'skill not installed: kettle-check' },
      { workflow: 'Folder named, own there', reason: 'skill not installed: pour' },
    ]);
  });

  it('refuses a skill whose name wow keeps for its own, with the line', () => {
    const text = [
      'version: 1',
      'skills:',
      '  - name: wow-kettle',
      '    description: Invented.',
      '    text: Boil.',
      '',
    ].join('\n');
    const plan = preview(other, text, 'other');
    expect(plan).toEqual({
      outcome: 'refused',
      problems: [{ line: 3, reason: 'Names starting with wow- are kept for the skills wow ships' }],
    });
  });
});
