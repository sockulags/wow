import { settingsRegistry as registry, type ServerCommand, type Skill } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { ownSkillDir } from '@wow/skills';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readModel } from '../core/projector.js';
import { MockProviderAdapter } from '../hooks/providers.js';
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
