import type {
  ProviderCommand,
  ProviderInstance,
  ServerCommand,
  Skill,
  WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { createHandlers, type Connection } from '../rpc/handlers.js';
import { route } from '../rpc/router.js';
import { providerInstances, threadItems } from '../db/schema.js';
import { MockProviderAdapter, type MockScript } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// wow skills U1: built-in and own skills on the server, sent as text, attached to steps.

let root: string;
let userHome: string;
let wowHome: string;
let projectDir: string;
let server: RunningServer;
// The folders the last skills watcher was given.
let watchedDirs: readonly string[] = [];
let adapters: MockProviderAdapter[];

const finalMessage = new Map<string, string>();
// Hears every log line the server writes, for a case that acts at a set point of a scan.
let onLog: (line: string) => void = () => undefined;

const answer: MockScript = (command) => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  return [
    {
      type: 'textDelta',
      threadId,
      itemId: `${threadId}-${adapters.length}-${Math.random()}`,
      delta: finalMessage.get(threadId) ?? 'Done',
    },
    { type: 'turnCompleted', threadId },
  ];
};

const instance = (id: string, kind: 'claude' | 'codex'): ProviderInstance => ({
  id,
  kind,
  name: id,
  binaryPath: kind,
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'm',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
});

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`skills-test-${(commandCount += 1)}`, command);

// The dispatch call as the app sends it, through the RPC handler.
const rpcDispatch = (command: ServerCommand) => {
  const handlers = createHandlers({
    engine: server.engine,
    subscriptions: undefined as never,
    workspaces: undefined as never,
    settings: server.settings,
    secrets: undefined as never,
    db: undefined as never,
    skills: server.skills,
    hostLookup: undefined as never,
    images: undefined as never,
    snapshots: undefined as never,
    threadGit: undefined as never,
    threadApply: undefined as never,
    providers: undefined as never,
    providerUpdates: undefined as never,
    trackers: undefined as never,
    detectProviders: () => Promise.resolve([]),
    discoverProjects: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    outlook: () => undefined,
    info: { version: '0.0.0', home: wowHome },
    clock: () => new Date(),
  });
  const connection: Connection = { push: () => {}, subscriptionIds: new Set() };
  return route(
    JSON.stringify({
      id: `rpc-${(commandCount += 1)}`,
      method: 'dispatch',
      params: { commandId: `skills-rpc-${commandCount}`, command },
    }),
    handlers,
    connection,
    () => {},
  );
};

const createThread = (threadId: string, providerInstanceId: string) =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId,
    projectId: 'p1',
    cwd: projectDir,
    model: 'm',
    effort: 'high',
    permissionMode: 'default',
  });

const skillList = () => snapshot(server.database.db, { topic: 'skills' }) as Skill[];
const groupOf = (name: string, source: string) =>
  skillList().find((skill) => skill.name === name && skill.source === source);

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

const startTurns = () =>
  adapters.flatMap((adapter) =>
    adapter.sent.filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn',
    ),
  );
const promptOf = (threadId: string) =>
  startTurns().find((turn) => turn.threadId === threadId)?.prompt;

const firstItem = (threadId: string) =>
  server.database.db
    .select()
    .from(threadItems)
    .where(eq(threadItems.threadId, threadId))
    .orderBy(threadItems.index)
    .get();

async function writeSkill(dir: string, name: string, body = ''): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`,
  );
}

const file = () => path.join(wowHome, 'skills', 'tidy', 'SKILL.md');

const tidyBlock = ['<skill name="tidy">', 'Tidy the imports.', '</skill>'].join('\n');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-skills-server-'));
  userHome = path.join(root, 'user');
  wowHome = path.join(root, '.wow');
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  await writeSkill(path.join(userHome, '.claude', 'skills'), 'ship');
  await writeSkill(path.join(userHome, '.claude', 'skills'), 'review');
  adapters = [];
  finalMessage.clear();
  server = await startServer({
    home: wowHome,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: (line) => onLog(line),
    userHome,
    watchSkills: (dirs) => {
      watchedDirs = dirs;
      return { close: () => Promise.resolve() };
    },
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => answer(command));
          adapters.push(adapter);
          return adapter;
        },
        codex: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => answer(command));
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.database.db
    .insert(providerInstances)
    .values([instance('claude-work', 'claude'), instance('codex-work', 'codex')])
    .run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
  await server.skills.refresh();
});

afterEach(async () => {
  onLog = () => undefined;
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('built-in skills (spec 1, 3, 4)', () => {
  it('lists wow-verdict, wow-artifacts, wow-pull-request and wow-handover in the group wow on a fresh install, and none can be changed or deleted', () => {
    const wow = skillList().filter((skill) => skill.source === 'wow');
    expect(wow.map((skill) => skill.name).toSorted()).toEqual([
      'wow-artifacts',
      'wow-handover',
      'wow-pull-request',
      'wow-verdict',
    ]);
    for (const skill of wow) expect(skill.text).not.toBe('');
    expect(() =>
      dispatch({
        type: 'skill.update',
        skill: { name: 'wow-verdict', description: 'mine', text: 'Say yes.' },
      }),
    ).toThrow('wow-verdict ships with wow and cannot be changed or deleted');
    expect(() => dispatch({ type: 'skill.delete', name: 'wow-handover' })).toThrow(
      'wow-handover ships with wow and cannot be changed or deleted',
    );
    // Nothing is written to the user's skill folders (spec 4).
    expect(existsSync(path.join(userHome, '.claude', 'skills', 'wow-verdict'))).toBe(false);
  });

  it('leaves a built-in skill switched off in the setting out of every list', async () => {
    dispatch({
      type: 'setting.set',
      key: 'skills.builtInOff',
      scope: 'global',
      value: ['wow-verdict'],
    });
    await server.skills.refresh();
    expect(groupOf('wow-verdict', 'wow')).toBeUndefined();
    expect(groupOf('wow-artifacts', 'wow')).toBeDefined();
  });
});

describe('built-in texts filled from settings and the run (spec 2)', () => {
  it('leaves the unit sentence out of a wow-pull-request picked in chat without a unit', async () => {
    createThread('t1', 'claude-work');
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: 'Open it.',
      skills: [{ name: 'wow-pull-request', source: 'wow' }],
    });
    await server.providerService.idle();
    const prompt = promptOf('t1') ?? '';
    expect(prompt).toBe(
      [
        '<skill name="wow-pull-request">',
        'When you open a pull request or a merge request, put an Intent-Unit line in its body for each unit it delivers, one line per unit, so wow can find it.',
        '</skill>',
        '',
        'Open it.',
      ].join('\n'),
    );
  });
});

describe('own skills (spec 5, 6, 7)', () => {
  const tidy = { name: 'tidy', description: 'When imports are messy', text: 'Tidy the imports.' };

  it('creates a file under wow home in the skill file format and lists it in Yours before other groups', async () => {
    dispatch({ type: 'skill.create', skill: tidy });
    expect(await readFile(file(), 'utf8')).toBe(
      '---\nname: tidy\ndescription: When imports are messy\n---\n\nTidy the imports.\n',
    );
    await server.skills.refresh();
    const list = skillList();
    expect(list[0]).toMatchObject({
      name: 'tidy',
      source: 'yours',
      description: 'When imports are messy',
      text: 'Tidy the imports.',
    });
    expect(list.slice(1, 5).map((skill) => skill.source)).toEqual(['wow', 'wow', 'wow', 'wow']);
    expect(list.slice(5).map((skill) => skill.name)).toEqual(['review', 'ship']);
  });

  it('refuses an invalid name, a taken name and one starting with wow-, with the reason', () => {
    dispatch({ type: 'skill.create', skill: tidy });
    const create = (name: string) => () =>
      dispatch({ type: 'skill.create', skill: { ...tidy, name } });
    expect(create('Tidy Up')).toThrow(
      'A skill name has only lower case letters, digits and single hyphens between them',
    );
    expect(create('tidy')).toThrow('There is already a wow skill named tidy');
    expect(create('wow-mine')).toThrow(
      'Names starting with wow- are kept for the skills wow ships',
    );
  });

  it('updates and deletes an own skill, and Undo takes each back', async () => {
    dispatch({ type: 'skill.create', skill: tidy });
    // Undo of a create: the delete it offers.
    dispatch({ type: 'skill.delete', name: 'tidy' });
    expect(existsSync(file())).toBe(false);
    expect(groupOf('tidy', 'yours')).toBeUndefined();

    dispatch({ type: 'skill.create', skill: tidy });
    const before = groupOf('tidy', 'yours');
    dispatch({ type: 'skill.update', skill: { ...tidy, text: 'Sort the imports.' } });
    expect(await readFile(file(), 'utf8')).toContain('Sort the imports.');
    expect(groupOf('tidy', 'yours')?.text).toBe('Sort the imports.');
    // Undo of an update: the update back to the text it had.
    dispatch({ type: 'skill.update', skill: tidy });
    expect(groupOf('tidy', 'yours')).toEqual(before);
    expect(await readFile(file(), 'utf8')).toContain('Tidy the imports.');

    dispatch({ type: 'skill.delete', name: 'tidy' });
    expect(existsSync(path.dirname(file()))).toBe(false);
    // Undo of a delete: the create with what the client still holds.
    dispatch({ type: 'skill.create', skill: tidy });
    expect(groupOf('tidy', 'yours')).toEqual(before);
    await server.skills.refresh();
    expect(groupOf('tidy', 'yours')).toEqual(before);
  });

  it('refuses a create over a SKILL.md the list does not show, also one named in another case', async () => {
    // Skipped by the scan: no frontmatter name. On Windows `Tidy` is the folder `tidy` would be.
    await mkdir(path.join(wowHome, 'skills', 'Tidy'), { recursive: true });
    await writeFile(path.join(wowHome, 'skills', 'Tidy', 'SKILL.md'), 'Mine, by hand.');
    await server.skills.refresh();
    expect(groupOf('tidy', 'yours')).toBeUndefined();
    expect(await rpcDispatch({ type: 'skill.create', skill: tidy })).toMatchObject({
      error: {
        code: 'rejected',
        message: `${path.join(wowHome, 'skills', 'Tidy', 'SKILL.md')} is already there. Rename or remove it first.`,
      },
    });
    expect(await readFile(path.join(wowHome, 'skills', 'Tidy', 'SKILL.md'), 'utf8')).toBe(
      'Mine, by hand.',
    );
    expect(groupOf('tidy', 'yours')).toBeUndefined();
  });

  it('answers a save whose file cannot be written with the reason, and lists what is on disk', async () => {
    // A file where the skill's folder would go makes the write fail on every platform.
    await mkdir(path.join(wowHome, 'skills'), { recursive: true });
    await writeFile(path.join(wowHome, 'skills', 'tidy'), 'not a folder');
    const reply = await rpcDispatch({ type: 'skill.create', skill: tidy });
    expect(reply).toMatchObject({ error: { code: 'rejected' } });
    expect(JSON.stringify(reply)).toContain(
      JSON.stringify(`Could not write ${path.join(wowHome, 'skills', 'tidy', 'SKILL.md')}: `).slice(
        1,
        -1,
      ),
    );
    await server.skills.refresh();
    expect(groupOf('tidy', 'yours')).toBeUndefined();
  });

  it('keeps an own skill saved while a scan that read the folder before was still going', async () => {
    dispatch({ type: 'skill.create', skill: tidy });
    await server.skills.refresh();
    // A file the scan skips is logged after the folders are read and before the list is sent:
    // the update commits exactly then.
    await mkdir(path.join(userHome, '.claude', 'skills', 'broken'), { recursive: true });
    await writeFile(
      path.join(userHome, '.claude', 'skills', 'broken', 'SKILL.md'),
      '---\nname: [unclosed\n---\n',
    );
    let updated = false;
    onLog = (line) => {
      if (updated || !line.includes('skipped skill file')) return;
      updated = true;
      dispatch({ type: 'skill.update', skill: { ...tidy, text: 'Sort the imports.' } });
    };
    await server.skills.refresh();
    expect(updated).toBe(true);
    expect(groupOf('tidy', 'yours')?.text).toBe('Sort the imports.');
    await server.skills.refresh();
    expect(groupOf('tidy', 'yours')?.text).toBe('Sort the imports.');
  });

  it('answers a refresh overtaken by an own-skill commit with the list after that commit', async () => {
    dispatch({ type: 'skill.create', skill: tidy });
    await server.skills.refresh();
    await mkdir(path.join(userHome, '.claude', 'skills', 'broken'), { recursive: true });
    await writeFile(
      path.join(userHome, '.claude', 'skills', 'broken', 'SKILL.md'),
      '---\nname: [unclosed\n---\n',
    );
    let updated = false;
    onLog = (line) => {
      if (updated || !line.includes('skipped skill file')) return;
      updated = true;
      dispatch({ type: 'skill.update', skill: { ...tidy, text: 'Sort the imports.' } });
    };
    const list = await server.skills.refresh();
    expect(updated).toBe(true);
    expect(list.find((skill) => skill.source === 'yours' && skill.name === 'tidy')?.text).toBe(
      'Sort the imports.',
    );
  });

  it('lists a file added under wow home by hand after a refresh', async () => {
    await writeSkill(path.join(wowHome, 'skills'), 'by-hand', 'Written by hand.');
    expect(groupOf('by-hand', 'yours')).toBeUndefined();
    await server.skills.refresh();
    expect(groupOf('by-hand', 'yours')).toMatchObject({ text: 'Written by hand.' });
  });

  // chokidar waits for a missing folder by watching the one above it, and on Windows a watched
  // folder cannot be renamed or removed: a project without .claude/skills would be held.
  it('watches only skill folders that exist and lists one created later after a turn ends', async () => {
    expect(watchedDirs).toContain(path.join(userHome, '.claude', 'skills'));
    expect(watchedDirs.filter((dir) => dir.startsWith(projectDir))).toEqual([]);

    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'steep');
    const listed = new Promise<void>((resolve) => {
      const off = server.engine.onCommit(() => {
        if (groupOf('steep', 'project-claude')) {
          off();
          resolve();
        }
      });
    });
    createThread('t-steep', 'claude-work');
    dispatch({ type: 'thread.sendMessage', threadId: 't-steep', text: 'add a skill' });
    await listed;
    expect(watchedDirs).toContain(path.join(projectDir, '.claude', 'skills'));
  });

  // ~/.codex/skills is missing for anyone without Codex: it must not cost a scan per turn.
  it('watches a missing user-level skill folder and does not rescan for it when a turn ends', async () => {
    await mkdir(path.join(projectDir, '.claude', 'skills'), { recursive: true });
    await mkdir(path.join(projectDir, '.agents', 'skills'), { recursive: true });
    await server.skills.refresh();
    const refresh = vi.spyOn(server.skills, 'refresh');
    const ended = new Promise<void>((resolve) => {
      const off = server.engine.onCommit((commit) => {
        if (commit.events.some(({ event }) => event.kind === 'turn.ended')) {
          off();
          resolve();
        }
      });
    });
    createThread('t-codex', 'claude-work');
    dispatch({ type: 'thread.sendMessage', threadId: 't-codex', text: 'hello' });
    await ended;
    expect(refresh).not.toHaveBeenCalled();
    expect(watchedDirs).toContain(path.join(userHome, '.codex', 'skills'));
  });
});

const handDir = () => path.join(wowHome, 'skills', 'My_Skill');
const handPath = () => path.join(handDir(), 'SKILL.md');

describe('an own skill written by hand (spec 6)', () => {
  // A name and a folder the editor would refuse, no text, and frontmatter wow does not own.
  const handFile = [
    '---',
    '# mine',
    'name: My Skill',
    'description: "By hand"',
    'allowed-tools: Read, Grep',
    'disable-model-invocation: true',
    '---',
    '',
  ].join('\n');

  beforeEach(async () => {
    await mkdir(handDir(), { recursive: true });
    await writeFile(handPath(), handFile);
    await server.skills.refresh();
  });

  it('lists it with its file, and Undo of a delete puts that file back exactly', async () => {
    const listed = groupOf('My Skill', 'yours');
    expect(listed).toMatchObject({ text: '', manualOnly: true, file: handFile });
    dispatch({ type: 'skill.delete', name: 'My Skill' });
    expect(existsSync(handPath())).toBe(false);
    expect(
      await rpcDispatch({ type: 'skill.restore', folder: 'My_Skill', file: handFile }),
    ).not.toHaveProperty('error');
    expect(await readFile(handPath(), 'utf8')).toBe(handFile);
    expect(groupOf('My Skill', 'yours')).toEqual(listed);
    await server.skills.refresh();
    expect(groupOf('My Skill', 'yours')).toEqual(listed);
  });

  it('keeps every other frontmatter key on an update, and Undo puts the file back exactly', async () => {
    const listed = groupOf('My Skill', 'yours');
    dispatch({
      type: 'skill.update',
      skill: { name: 'My Skill', description: 'By hand', text: 'Now with a text.' },
    });
    expect(await readFile(handPath(), 'utf8')).toBe(`${handFile}\nNow with a text.\n`);
    await server.skills.refresh();
    expect(groupOf('My Skill', 'yours')).toMatchObject({
      text: 'Now with a text.',
      manualOnly: true,
    });
    dispatch({ type: 'skill.restore', folder: 'My_Skill', file: handFile });
    expect(await readFile(handPath(), 'utf8')).toBe(handFile);
    await server.skills.refresh();
    expect(groupOf('My Skill', 'yours')).toEqual(listed);
  });

  it('refuses a restore over a SKILL.md the list does not show, and one outside the folder', async () => {
    await mkdir(path.join(wowHome, 'skills', 'broken'), { recursive: true });
    await writeFile(path.join(wowHome, 'skills', 'broken', 'SKILL.md'), '---\nname: [x\n---\n');
    expect(
      await rpcDispatch({ type: 'skill.restore', folder: 'broken', file: handFile }),
    ).toMatchObject({
      error: {
        code: 'rejected',
        message: `${path.join(wowHome, 'skills', 'broken', 'SKILL.md')} is already there. Rename or remove it first.`,
      },
    });
    expect(() => dispatch({ type: 'skill.restore', folder: '..', file: handFile })).toThrow(
      '.. is not a folder name',
    );
    expect(() =>
      dispatch({ type: 'skill.restore', folder: path.join('a', 'b'), file: handFile }),
    ).toThrow('is not a folder name');
  });
});

// An own skill named brew in a folder of its own, as written by hand.
const twin = (folder: string, text: string) =>
  writeSkill(path.join(wowHome, 'skills'), folder, text).then(() =>
    writeFile(
      path.join(wowHome, 'skills', folder, 'SKILL.md'),
      `---\nname: brew\ndescription: ${folder}\n---\n\n${text}\n`,
    ),
  );
describe('two hand-made folders with the same skill name', () => {
  const refusal =
    'Two of your skills are named brew, in the folders brew-a and brew-b. Rename one in its SKILL.md so wow knows which to use.';

  beforeEach(async () => {
    await twin('brew-a', 'Brew green tea.');
    await twin('brew-b', 'Brew black tea.');
    await server.skills.refresh();
  });

  it('lists both but sends, changes and deletes neither, naming both folders', async () => {
    expect(skillList().filter((skill) => skill.name === 'brew')).toHaveLength(2);
    createThread('t1', 'claude-work');
    expect(() =>
      dispatch({
        type: 'thread.sendMessage',
        threadId: 't1',
        text: 'Go',
        skills: [{ name: 'brew', source: 'yours' }],
      }),
    ).toThrow(refusal);
    expect(() =>
      dispatch({
        type: 'skill.update',
        skill: { name: 'brew', description: 'Either', text: 'Brew any tea.' },
      }),
    ).toThrow(refusal);
    expect(() => dispatch({ type: 'skill.delete', name: 'brew' })).toThrow(refusal);
    expect(startTurns()).toEqual([]);
  });
});

describe('the same name in Yours and in a folder (spec 9)', () => {
  it('lists both with their groups', async () => {
    await writeSkill(path.join(userHome, '.claude', 'skills'), 'tidy');
    await server.skills.refresh();
    dispatch({
      type: 'skill.create',
      skill: { name: 'tidy', description: 'Mine', text: 'Tidy the imports.' },
    });
    expect(groupOf('tidy', 'yours')).toBeDefined();
    expect(groupOf('tidy', 'user-claude')).toBeDefined();
  });
});

describe('runs and workflows stored before (spec 13)', () => {
  it('loads a workflow without alsoFollow', () => {
    dispatch({ type: 'workflow.create', workflowId: 'wf', name: 'Old', steps: [step('ship')] });
    const stored = snapshot(server.database.db, { topic: 'workflows' }) as {
      steps: WorkflowStep[];
    }[];
    expect(stored[0]?.steps[0]?.alsoFollow).toBeUndefined();
  });
});

describe('what a message or a step was sent with (spec 14, 15)', () => {
  it('stores the skills a chat message was sent with by name, with the text reachable, and the message as typed', async () => {
    dispatch({
      type: 'skill.create',
      skill: { name: 'tidy', description: 'Mine', text: 'Tidy the imports.' },
    });
    createThread('t1', 'codex-work');
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: 'Please.',
      skills: [{ name: 'tidy', source: 'yours' }, { name: 'review' }],
    });
    await server.providerService.idle();
    expect(promptOf('t1')).toBe([tidyBlock, '', '$review Please.'].join('\n'));
    expect(firstItem('t1')?.payload).toEqual({
      text: 'Please.',
      skills: [
        { name: 'tidy', source: 'yours', text: 'Tidy the imports.' },
        { name: 'review', source: 'user-claude', invocation: '$review' },
      ],
    });
  });

  it('sends a message that is only a picked skill, and refuses one with neither text nor skill', async () => {
    dispatch({
      type: 'skill.create',
      skill: { name: 'tidy', description: 'Mine', text: 'Tidy the imports.' },
    });
    createThread('t1', 'claude-work');
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: '',
      skills: [{ name: 'tidy', source: 'yours' }],
    });
    await server.providerService.idle();
    expect(promptOf('t1')).toBe(tidyBlock);
    expect(firstItem('t1')?.payload).toEqual({
      text: '',
      skills: [{ name: 'tidy', source: 'yours', text: 'Tidy the imports.' }],
    });
    createThread('t2', 'claude-work');
    expect(() => dispatch({ type: 'thread.sendMessage', threadId: 't2', text: '  ' })).toThrow(
      'A message needs text, a skill or an image',
    );
  });

  it('refuses a chat message with a skill that is gone, naming it', () => {
    createThread('t1', 'claude-work');
    expect(() =>
      dispatch({
        type: 'thread.sendMessage',
        threadId: 't1',
        text: 'Please.',
        skills: [{ name: 'tidy', source: 'yours' }],
      }),
    ).toThrow('The skill tidy no longer exists');
  });
});
