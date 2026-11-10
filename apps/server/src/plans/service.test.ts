import { unitContractFields } from '@wow/agent-os';
import type { PlanIntent } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';
import { intentsDirectory, noHostReason } from './service.js';

// The nine agent-os contract fields with only Outcome written.
const outcomeOnly = (outcome: string) =>
  unitContractFields.map((name) => ({ name, value: name === 'Outcome' ? outcome : null }));

// Invented plan files in the agent-os format.
const intentMd = (id: string, rev = 1, title = 'A tea timer that rings') =>
  `---\nid: ${id}\nstatus: accepted\nrev: ${rev}\nsupersedes: null\n---\n\n# ${title}\n`;
const specMd = (id: string, builtOn = 1) =>
  `---\nintent: ${id}\nrev: 1\nbuilt_on: intent@${builtOn}\nstatus: accepted\n---\n\n# Spec\n`;
const planMd = (id: string, units: string, source = 'files') =>
  `---\nintent: ${id}\nrev: 1\nbuilt_on: spec@1\nstatus: accepted\nsource: ${source}\n---\n\n# Plan\n\n## Units\n\n${units}\n`;

const teaUnits = [
  '- [U1] Count down',
  '- [U2] Ring the bell — depends on U1 — blocked: the bell is on order',
  '',
  '### U1 Count down',
  '',
  'Outcome: the timer counts down.',
  '',
  '### U2 Ring the bell',
  '',
  'Outcome: a bell rings.',
].join('\n');

let root: string;
let server: RunningServer;
let watched: { dirs: readonly string[]; onChange: () => void }[];

const projectDir = (name: string) => path.join(root, name);

async function writeIntent(
  project: string,
  id: string,
  files: Partial<Record<'intent' | 'spec' | 'plan', string>>,
  dir = 'intents',
): Promise<void> {
  const folder = path.join(projectDir(project), dir, id);
  await mkdir(folder, { recursive: true });
  for (const [kind, text] of Object.entries(files)) {
    await writeFile(path.join(folder, `${kind}.md`), text);
  }
}

function addProject(id: string): void {
  server.engine.dispatch(`create-${id}`, {
    type: 'project.create',
    projectId: id,
    name: id,
    cwd: projectDir(id),
  });
}

// The rows a subscriber of the plans topic gets.
const rows = (): PlanIntent[] =>
  snapshot(server.database.db, { topic: 'planIntents' }) as PlanIntent[];
const row = (id: string): PlanIntent | undefined => rows().find((intent) => intent.id === id);

// A file change as the watcher reports it; the read it starts is the one refresh() joins.
async function fileChanged(): Promise<void> {
  watched.at(-1)?.onChange();
  await server.plans.refresh();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-plans-'));
  await mkdir(projectDir('tea'), { recursive: true });
  await mkdir(projectDir('garden'), { recursive: true });
  watched = [];
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    watchPlans: (dirs, onChange) => {
      watched.push({ dirs, onChange });
      return { close: () => Promise.resolve() };
    },
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('plans service', () => {
  it('lists an intent with title, status, revision and spec and plan presence', async () => {
    const id = '2026-01-tea-timer';
    await writeIntent('tea', id, {
      intent: intentMd(id),
      spec: specMd(id),
      plan: planMd(id, teaUnits),
    });
    await writeIntent('tea', '2026-02-kettle', {
      intent: intentMd('2026-02-kettle', 3, 'A kettle'),
    });
    addProject('tea');
    await server.plans.refresh();

    expect(row(`tea:${id}`)).toMatchObject({
      projectId: 'tea',
      intentId: id,
      title: 'A tea timer that rings',
      hasIntent: true,
      status: 'accepted',
      rev: 1,
      spec: { rev: 1, status: 'accepted', stale: null },
      plan: { rev: 1, status: 'accepted', stale: null },
      source: 'files',
      problems: [],
    });
    expect(row('tea:2026-02-kettle')).toMatchObject({
      title: 'A kettle',
      rev: 3,
      spec: null,
      plan: null,
      units: [],
    });
  });

  it('marks a spec built on an older intent revision stale', async () => {
    const id = '2026-01-tea-timer';
    await writeIntent('tea', id, { intent: intentMd(id, 2), spec: specMd(id, 1) });
    addProject('tea');
    await server.plans.refresh();
    expect(row(`tea:${id}`)?.spec?.stale).toEqual({ builtOn: 1, current: 2 });
  });

  it('shows a blocked unit as blocked and the others as status unknown with the reason, without a host', async () => {
    const id = '2026-01-tea-timer';
    await writeIntent('tea', id, {
      intent: intentMd(id),
      spec: specMd(id),
      plan: planMd(id, teaUnits),
    });
    addProject('tea');
    await server.plans.refresh();
    expect(row(`tea:${id}`)?.units).toEqual([
      {
        key: 'U1',
        title: 'Count down',
        line: 13,
        dependsOn: [],
        blocked: null,
        contract: outcomeOnly('the timer counts down.'),
        status: 'unknown',
        statusReason: noHostReason,
      },
      {
        key: 'U2',
        title: 'Ring the bell',
        line: 14,
        dependsOn: ['U1'],
        blocked: 'the bell is on order',
        contract: outcomeOnly('a bell rings.'),
        status: 'blocked',
        statusReason: 'the bell is on order',
      },
    ]);
  });

  it('lists a plan that cannot be read with the problem and its line, and still shows other intents', async () => {
    const broken = '2026-01-tea-timer';
    await writeIntent('tea', broken, {
      intent: intentMd(broken),
      spec: specMd(broken),
      plan: planMd(broken, 'Nothing yet.'),
    });
    await writeIntent('tea', '2026-03-twice', {
      intent: intentMd('2026-03-twice'),
      spec: specMd('2026-03-twice'),
      plan: planMd('2026-03-twice', '- [U1] One\n- [U1] One again', 'issues'),
    });
    await writeIntent('tea', '2026-02-kettle', { intent: intentMd('2026-02-kettle') });
    addProject('tea');
    await server.plans.refresh();
    expect(row(`tea:${broken}`)).toMatchObject({
      title: 'A tea timer that rings',
      units: [],
      problems: [{ file: 'plan', line: 11, message: '"## Units" has no "- [KEY] title" lines' }],
    });
    expect(row('tea:2026-03-twice')?.problems).toEqual([
      { file: 'plan', line: 14, message: 'Unit key U1 appears twice' },
    ]);
    expect(row('tea:2026-02-kettle')?.problems).toEqual([]);
  });

  it('follows a plan file that changes on disk without a restart', async () => {
    const id = '2026-01-tea-timer';
    await writeIntent('tea', id, {
      intent: intentMd(id),
      spec: specMd(id),
      plan: planMd(id, teaUnits),
    });
    addProject('tea');
    await server.plans.refresh();
    expect(watched.at(-1)?.dirs).toEqual([path.join(projectDir('tea'), 'intents')]);
    expect(row(`tea:${id}`)?.units.map((unit) => unit.key)).toEqual(['U1', 'U2']);

    await writeIntent('tea', id, {
      plan: planMd(id, `${teaUnits}\n\n## Units later\n`).replace(
        '- [U2] Ring',
        '- [U3] Steep -- depends on U1\n- [U2] Ring',
      ),
    });
    await fileChanged();
    expect(row(`tea:${id}`)?.units.map((unit) => unit.key)).toEqual(['U1', 'U3', 'U2']);

    await rm(path.join(projectDir('tea'), 'intents', id), { recursive: true });
    await fileChanged();
    expect(rows()).toEqual([]);
  });

  it('stores nothing new when the files did not change', async () => {
    const id = '2026-01-tea-timer';
    await writeIntent('tea', id, { intent: intentMd(id) });
    addProject('tea');
    await server.plans.refresh();
    const commits: number[] = [];
    const stop = server.engine.onCommit((commit) => commits.push(commit.events.length));
    await fileChanged();
    stop();
    expect(commits).toEqual([]);
  });

  it('reads each project with its own plans.intentsDirectory and drops a removed project', async () => {
    await writeIntent('tea', '2026-01-tea-timer', { intent: intentMd('2026-01-tea-timer') });
    await writeIntent(
      'garden',
      '2026-04-beds',
      { intent: intentMd('2026-04-beds', 1, 'Raised beds') },
      path.join('docs', 'intents'),
    );
    addProject('tea');
    addProject('garden');
    await server.plans.refresh();
    expect(rows().map((intent) => intent.id)).toEqual(['tea:2026-01-tea-timer']);

    server.engine.dispatch('set-dir', {
      type: 'setting.set',
      key: 'plans.intentsDirectory',
      scope: 'project:garden',
      value: 'docs/intents',
    });
    await server.plans.refresh();
    expect(rows().map((intent) => intent.id)).toEqual([
      'garden:2026-04-beds',
      'tea:2026-01-tea-timer',
    ]);
    expect(watched.at(-1)?.dirs).toEqual([
      path.join(projectDir('tea'), 'intents'),
      path.join(projectDir('garden'), 'docs', 'intents'),
    ]);

    server.engine.dispatch('delete-tea', { type: 'project.delete', projectId: 'tea' });
    await server.plans.refresh();
    expect(rows().map((intent) => intent.id)).toEqual(['garden:2026-04-beds']);
  });

  it('does not follow links out of the project and ignores folders without intent files', async () => {
    const outside = path.join(root, 'elsewhere', '2026-05-secret');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'intent.md'), intentMd('2026-05-secret'));
    await mkdir(path.join(projectDir('tea'), 'intents', 'sketches'), { recursive: true });
    await symlink(outside, path.join(projectDir('tea'), 'intents', '2026-05-secret'), 'junction');
    addProject('tea');
    expect(await server.plans.refresh()).toEqual([]);
  });

  it('keeps the intents folder inside the project folder', () => {
    const cwd = projectDir('tea');
    expect(intentsDirectory({ cwd }, 'intents')).toBe(path.join(cwd, 'intents'));
    expect(intentsDirectory({ cwd }, path.join('..', 'garden'))).toBeUndefined();
    expect(intentsDirectory({ cwd }, projectDir('garden'))).toBeUndefined();
    expect(intentsDirectory({ cwd }, '.')).toBeUndefined();
  });
});
