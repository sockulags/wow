import {
  settingsRegistry as registry,
  type RpcResponse,
  type SetupApplication,
  type Command,
  type ServerCommand,
  type SetupRead,
  type SetupSaved,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parse } from 'yaml';
import { CommandRejected } from '../core/orchestrator.js';
import { readModel } from '../core/projector.js';
import { snapshot } from '../core/subscriptions.js';
import { commandReceipts, events } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';
import { planSetup } from './plan.js';
import { writeSetup } from './write.js';

// The setup file (app assistant plan U5): saved without secrets, folders or account names, read
// on another install with a preview, applied as one step that Undo takes back, and refused with
// the line and the reason when it is wrong.

// Invented values; the marked ones may never reach a setup file.
const markedToken = 'wow-marked-setup-token-5c81e2';
const markedFolderName = 'marked-folder-4410';
const markedEmail = 'ada.marked@example.com';
const markedCard = 'Marked card 8812';
const markedBacklog = 'Marked backlog item 3307';
const lookalike = 'glpat-abcdefghijklmnopqrstuvwxyz0123';
const now = '2026-11-11T09:00:00.000Z';

let root: string;
let source: RunningServer;
let other: RunningServer;
let ids = 0;

const step = (id: string, skillName: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
  ...extra,
});

const on = (server: RunningServer, command: ServerCommand) =>
  server.engine.dispatch(`s${++ids}`, command);

const stored = (server: RunningServer, key: string) =>
  readModel(server.database.db).setting(key, 'global')?.value;

const workflowOf = (server: RunningServer, id: string) =>
  readModel(server.database.db).workflow(id);

async function start(name: string, instanceId: string): Promise<RunningServer> {
  const server = await startServer({
    home: path.join(root, name, '.wow'),
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
    providerInstanceId: instanceId,
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
  on(server, {
    type: 'skills.sync',
    skills: ['deliver-work', 'check-work'].map((skill) => ({
      id: `skill-${skill}`,
      name: skill,
      description: 'Invented.',
      dir: path.join(root, name, 'skills', skill),
      source: 'custom' as const,
      manualOnly: false,
      invocations: { claude: `/${skill}`, codex: `$${skill}` },
    })),
  });
  return server;
}

const save = (server: RunningServer): SetupSaved =>
  writeSetup(readModel(server.database.db), { now, registry, version: '0.1.2' });

const preview = (server: RunningServer, text: string) =>
  planSetup(text, readModel(server.database.db), { now, registry });

function ready(server: RunningServer, text: string) {
  const plan = preview(server, text);
  if (plan.outcome !== 'ready') throw new Error(JSON.stringify(plan.problems));
  return plan.preview;
}

function problems(server: RunningServer, text: string) {
  const plan = preview(server, text);
  if (plan.outcome !== 'refused') throw new Error('the file was not refused');
  return plan.problems;
}

const apply = (server: RunningServer, text: string, applicationId = `apply-${++ids}`) => {
  on(server, { type: 'setup.apply', applicationId, name: 'team.yaml', text });
  return applicationId;
};

const applications = (server: RunningServer) =>
  snapshot(server.database.db, { topic: 'setupApplications' }) as SetupApplication[];

// Everything the source install holds besides what a setup file is for, marked so a search
// finds it.
async function fillSource(): Promise<void> {
  const reference = await source.secrets.set('setting:trackers.github.token', markedToken);
  const set = (key: string, value: unknown) =>
    on(source, { type: 'setting.set', key, scope: 'global', value });
  set('trackers.github.token', reference);
  set('trackers.github.baseUrl', 'https://github.example.com/api/v3');
  set('trackers.jira.baseUrl', 'https://jira.example.com');
  set('trackers.jira.authMode', 'pat');
  set('trackers.jira.email', markedEmail);
  set('trackers.github.owner', 'marked-owner-6620');
  set('triggers.ignoredCommentAuthors', ['marked-bot-6621']);
  set('hosts.pollSeconds', 600);
  set('scheduler.tickSeconds', 45);
  set('calendar.workHours', { start: '07:00', end: '15:00', days: ['monday'] });
  set('skills.directories', [path.join(root, markedFolderName)]);
  set('workflows.templates', [
    {
      kind: 'tea',
      name: 'Tea',
      steps: [
        { skillName: 'deliver-work', gateBefore: false, gateAfter: true, expectedArtifacts: [] },
      ],
    },
  ]);
  // A value that is not marked secret but looks like one stays out of the file.
  set('workflows.verdictApprovedLine', `APPROVED ${lookalike}`);
  on(source, {
    type: 'project.create',
    projectId: 'tea',
    name: 'Tea',
    cwd: root,
  });
  on(source, {
    type: 'card.create',
    cardId: 'card-1',
    title: markedCard,
    start: '2026-11-12T09:00:00.000Z',
    end: '2026-11-12T10:00:00.000Z',
    zone: 'Europe/Berlin',
  });
  on(source, {
    type: 'backlog.create',
    backlogItemId: 'item-1',
    title: markedBacklog,
    body: markedBacklog,
    tags: [],
  });
  on(source, {
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    templateKind: 'feature',
    steps: [step('build', 'deliver-work', { model: 'opus' }), step('review', 'check-work')],
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-setup-'));
  source = await start('source', 'claude-work');
  other = await start('other', 'claude-home');
  await fillSource();
});

afterEach(async () => {
  await source.stop();
  await other.stop();
  await rm(root, { recursive: true, force: true });
});

describe('saving a setup (spec 21)', () => {
  it('holds changed settings, tracker and host settings, workflows and templates, and lists a set secret to fill in', () => {
    const saved = save(source);
    const file = parse(saved.text) as Record<string, unknown>;
    expect(file).toMatchObject({
      version: 1,
      wow: '0.1.2',
      settings: {
        'trackers.github.baseUrl': 'https://github.example.com/api/v3',
        'trackers.jira.baseUrl': 'https://jira.example.com',
        'trackers.jira.authMode': 'pat',
        'hosts.pollSeconds': 600,
        'scheduler.tickSeconds': 45,
        'workflows.templates': [{ kind: 'tea', name: 'Tea' }],
      },
      toFillIn: ['trackers.github.token'],
      workflows: [
        {
          id: 'delivery',
          name: 'Delivery',
          templateKind: 'feature',
          steps: [
            { id: 'build', skillName: 'deliver-work', provider: 'claude', model: 'opus' },
            { id: 'review', skillName: 'check-work', provider: 'claude' },
          ],
        },
      ],
    });
    expect(Object.keys(file)).toEqual(['version', 'wow', 'settings', 'toFillIn', 'workflows']);
    expect(saved.toFillIn).toEqual(['trackers.github.token']);
    expect(saved.fileName).toBe('wow-setup-2026-11-11.yaml');
    // Only what differs from the default: the log level, never touched, is not there.
    expect(Object.keys(file['settings'] as object)).not.toContain('advanced.logLevel');
  });

  it('holds no secret value, project folder, account name, calendar, backlog, thread or run', async () => {
    on(source, {
      type: 'thread.create',
      threadId: 'chat-1',
      providerInstanceId: 'claude-work',
      projectId: 'tea',
      cwd: root,
      title: 'Marked thread 5521',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    const { text, leftOut } = save(source);
    for (const marked of [
      markedToken,
      markedFolderName,
      markedEmail,
      'marked-owner-6620',
      'marked-bot-6621',
      markedCard,
      markedBacklog,
      'Marked thread 5521',
      lookalike,
      root,
      'claude-work',
      'secretRef',
    ]) {
      expect(text).not.toContain(marked);
    }
    const file = parse(text) as { settings: Record<string, unknown> };
    for (const key of [
      'trackers.github.token',
      'trackers.github.owner',
      'triggers.ignoredCommentAuthors',
      'trackers.jira.email',
      'calendar.workHours',
      'skills.directories',
    ]) {
      expect(file.settings).not.toHaveProperty(key);
    }
    expect(leftOut).toEqual([{ what: 'Approved verdict line', reason: 'it looks like a secret' }]);
    // An address with a user name and password written into it stays out too.
    on(source, {
      type: 'setting.set',
      key: 'trackers.gitlab.baseUrl',
      scope: 'global',
      value: 'https://reader:hunter2pass@gitlab.example.invalid',
    });
    const again = save(source);
    expect(again.text).not.toMatch(/hunter2pass|gitlab\.example/);
    expect(again.leftOut).toContainEqual({ what: 'GitLab URL', reason: 'it looks like a secret' });
    // The secret store was never asked: the marked value is in no event or receipt either.
    const history = JSON.stringify([
      source.database.db.select().from(events).all(),
      source.database.db.select().from(commandReceipts).all(),
    ]);
    expect(history).not.toContain(markedToken);
    expect(await readdir(path.join(root, 'source', '.wow'))).not.toContain('setup');
  });
});

describe('starting from a setup file (spec 22)', () => {
  beforeEach(() => {
    // The other install already has values of its own.
    on(other, { type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 20 });
    on(other, {
      type: 'workflow.create',
      workflowId: 'their-delivery',
      name: 'Delivery',
      steps: [step('build', 'deliver-work', { providerInstanceId: 'claude-home' })],
    });
  });

  it('previews what would be added and what would replace a value, then applies it as one step that Undo reverses', () => {
    const { text } = save(source);
    const shown = ready(other, text);
    expect(shown.added).toContainEqual({
      what: 'Interval (Hosts)',
      from: expect.stringContaining('(default)'),
      to: '600',
    });
    expect(shown.replaced).toContainEqual({
      what: 'Tick interval (Scheduler)',
      from: '20',
      to: '45',
    });
    expect(shown.added).toContainEqual({
      what: 'Templates (Workflows)',
      from: 'Bug, Feature, Initiative (default)',
      to: 'Tea',
      full: expect.stringContaining('skillName: deliver-work') as string,
    });
    expect(shown.replaced).toContainEqual({
      what: 'Workflow "Delivery"',
      from: 'templateKind: none; 1 step: deliver-work',
      to: 'templateKind: feature; 2 steps: deliver-work, check-work',
      full: expect.stringContaining('model: opus') as string,
    });
    expect(shown.toFillIn).toEqual([
      {
        key: 'trackers.github.token',
        label: expect.any(String),
        place: { label: 'Settings → Trackers', path: '/settings/trackers' },
      },
    ]);
    expect(shown.marked).toEqual([]);

    const before = {
      tick: stored(other, 'scheduler.tickSeconds'),
      poll: stored(other, 'hosts.pollSeconds'),
      workflow: workflowOf(other, 'their-delivery'),
    };
    const id = apply(other, text);
    expect(stored(other, 'scheduler.tickSeconds')).toBe(45);
    expect(stored(other, 'hosts.pollSeconds')).toBe(600);
    expect(stored(other, 'trackers.github.baseUrl')).toBe('https://github.example.com/api/v3');
    expect(stored(other, 'trackers.github.token')).toBeUndefined();
    expect(workflowOf(other, 'their-delivery')).toMatchObject({
      name: 'Delivery',
      templateKind: 'feature',
      steps: [
        { id: 'build', providerInstanceId: 'claude-home', model: 'opus' },
        { id: 'review', providerInstanceId: 'claude-home' },
      ],
    });
    // The file's workflow took the place of the one with its name; none was added beside it.
    expect(readModel(other.database.db).workflows()).toHaveLength(1);
    const [row] = applications(other);
    expect(row).toMatchObject({ id, name: 'team.yaml', state: 'applied', undoneAt: null });
    expect(row).not.toHaveProperty('parts');

    on(other, { type: 'setup.undo', applicationId: id });
    expect(stored(other, 'scheduler.tickSeconds')).toBe(before.tick);
    expect(stored(other, 'hosts.pollSeconds')).toBe(before.poll);
    expect(stored(other, 'trackers.github.baseUrl')).toBeUndefined();
    expect(workflowOf(other, 'their-delivery')).toEqual({
      ...before.workflow,
      updatedAt: expect.any(String),
    });
    expect(applications(other)[0]).toMatchObject({ state: 'undone', undoneAt: now });
  });

  it('adds a workflow it does not find and takes it away again on Undo', () => {
    on(other, { type: 'workflow.delete', workflowId: 'their-delivery' });
    const id = apply(other, save(source).text);
    expect(workflowOf(other, 'delivery')?.steps.map((s) => s.providerInstanceId)).toEqual([
      'claude-home',
      'claude-home',
    ]);
    on(other, { type: 'setup.undo', applicationId: id });
    expect(workflowOf(other, 'delivery')).toBeUndefined();
  });

  it('refuses Undo once something the file set changed again, and says what', () => {
    const id = apply(other, save(source).text);
    on(other, { type: 'setting.set', key: 'hosts.pollSeconds', scope: 'global', value: 900 });
    expect(() => on(other, { type: 'setup.undo', applicationId: id })).toThrow(
      /The setup from team\.yaml cannot be undone\. .*it changed again since \(it is now 900 s\)/,
    );
    // Nothing was taken back.
    expect(stored(other, 'scheduler.tickSeconds')).toBe(45);
    expect(applications(other)[0]?.state).toBe('applied');
  });

  it('reads a file with CRLF line endings and a byte order mark the same way', () => {
    const { text } = save(source);
    const windows = `\uFEFF${text.replaceAll('\n', '\r\n')}`;
    expect(ready(other, windows)).toEqual(ready(other, text));
    const broken = windows.replace('version: 1', 'version: 1\r\nshade: blue');
    const line = text.split('\n').indexOf('version: 1') + 2;
    expect(problems(other, broken)).toEqual([
      { line, reason: 'The file has a key wow does not know: "shade"' },
    ]);
  });

  it('is refused from the assistant: only the user starts from a setup file or undoes one', () => {
    const { text } = save(source);
    expect(() =>
      other.engine.dispatch(
        'from-assistant',
        { type: 'setup.apply', applicationId: 'a1', name: 'team.yaml', text },
        'assistant',
      ),
    ).toThrow(/Only the user starts from a setup file/);
    const id = apply(other, text);
    expect(() =>
      other.engine.dispatch(
        'undo-assistant',
        { type: 'setup.undo', applicationId: id },
        'assistant',
      ),
    ).toThrow(/Only the user undoes a setup file/);
  });
});

describe('a saved file read back where it was saved', () => {
  it('previews nothing to add, replace, mark or fill in', () => {
    expect(ready(source, save(source).text)).toEqual({
      added: [],
      replaced: [],
      marked: [],
      toFillIn: [],
      warnings: [],
    });
  });
});

const file = (body: string) => `# invented\nversion: 1\nwow: 0.1.2\n${body}`;

const storeToken = async (scope: string) => {
  const reference = await other.secrets.set(`setting:trackers.gitlab.token:${scope}`, 'invented');
  on(other, { type: 'setting.set', key: 'trackers.gitlab.token', scope, value: reference });
};

describe('what the preview makes plain before Apply (spec 22)', () => {
  it('warns that a stored token would be sent to the host the file names, globally and for a project that takes the global address', async () => {
    on(other, { type: 'project.create', projectId: 'kettle', name: 'Kettle', cwd: root });
    on(other, { type: 'project.create', projectId: 'own', name: 'Own', cwd: root });
    on(other, {
      type: 'setting.set',
      key: 'trackers.gitlab.baseUrl',
      scope: 'global',
      value: 'https://gitlab.here.invalid',
    });
    await storeToken('global');
    await storeToken('project:kettle');
    await storeToken('project:own');
    on(other, {
      type: 'setting.set',
      key: 'trackers.gitlab.baseUrl',
      scope: 'project:own',
      value: 'https://gitlab.own.invalid',
    });
    const body =
      'settings:\n  trackers.gitlab.baseUrl: https://gitlab.elsewhere.invalid/\n  viewer.htmlScripts: true\n';
    expect(ready(other, file(body)).warnings).toEqual([
      'GitLab URL changes to gitlab.elsewhere.invalid: the token stored here will be sent to gitlab.elsewhere.invalid.',
      'GitLab URL changes to gitlab.elsewhere.invalid for project Kettle, which takes the global address: the token stored for it will be sent to gitlab.elsewhere.invalid.',
      '"Run scripts in HTML files" is turned on: an HTML file opened in the viewer runs its scripts.',
    ]);
    // The same host, or no token stored, warns of nothing.
    expect(
      ready(other, file('settings:\n  trackers.gitlab.baseUrl: https://gitlab.here.invalid/\n'))
        .warnings,
    ).toEqual([]);
    expect(
      ready(other, file('settings:\n  trackers.jira.baseUrl: https://jira.elsewhere.invalid\n'))
        .warnings,
    ).toEqual([]);
  });

  it('carries the whole of a long text and of every step a workflow holds', () => {
    const instructions = `Answer in rhyme. ${'Mind the kettle. '.repeat(20)}The end.`;
    const body = [
      'settings:',
      `  assistant.instructions: "${instructions}"`,
      'workflows:',
      '  - id: w',
      '    name: W',
      '    steps:',
      '      - id: a',
      '        skillName: deliver-work',
      '        provider: claude',
      '        gateBefore: false',
      '        gateAfter: false',
      '        expectedArtifacts: []',
      '        extraPrompt: Also push to the other remote without asking.',
      '',
    ].join('\n');
    const shown = ready(other, file(body));
    const text = shown.replaced
      .concat(shown.added)
      .find((line) => line.what.startsWith('Instructions'));
    expect(text?.to?.length).toBeLessThanOrEqual(160);
    expect(text?.full).toBe(instructions);
    const workflow = shown.added.find((line) => line.what === 'Workflow "W"');
    expect(workflow?.to).toBe('1 step: deliver-work');
    expect(workflow?.full).toContain('extraPrompt: Also push to the other remote without asking.');
  });
});

describe('refusing a file (spec 23)', () => {
  it.each([
    ['an unknown key', 'colour: blue\n', 4, 'The file has a key wow does not know: "colour"'],
    [
      'an unknown setting',
      'settings:\n  scheduler.speed: 3\n',
      5,
      'Unknown setting scheduler.speed',
    ],
    [
      'a setting of the wrong type',
      'settings:\n  hosts.pollSeconds: soon\n',
      5,
      'Setting hosts.pollSeconds: Invalid input: expected number, received string',
    ],
    [
      'a workflow step of the wrong type',
      'workflows:\n  - id: w\n    name: W\n    steps:\n      - id: a\n        skillName: deliver-work\n        provider: claude\n        gateBefore: maybe\n        gateAfter: false\n        expectedArtifacts: []\n',
      11,
      'Workflow "W", step 1: Invalid input: expected boolean, received string',
    ],
    [
      'a secret setting with a value',
      `settings:\n  trackers.github.token: ${markedToken}\n`,
      5,
      'trackers.github.token is a secret; a setup file names it under toFillIn and never holds its value',
    ],
    [
      'a value that looks like a secret',
      `settings:\n  workflows.verdictApprovedLine: ${lookalike}\n`,
      5,
      'This looks like a secret (a GitLab token); a setup file never holds one. Put the value in its field in Settings instead',
    ],
    [
      'an address with a user name and password in it',
      'settings:\n  trackers.gitlab.baseUrl: https://reader:hunter2pass@gitlab.example.invalid\n',
      5,
      'This address has a user name or password written into it; a setup file never holds one. Write the address without it and put the token in its field in Settings',
    ],
    [
      'an account name',
      `settings:\n  trackers.jira.email: ${markedEmail}\n`,
      5,
      'trackers.jira.email is an account name, which each person fills in for themselves',
    ],
    [
      'a folder of this computer',
      'settings:\n  skills.directories: [C:\\skills]\n',
      5,
      'skills.directories only fits the computer it was set on',
    ],
    [
      'a __proto__ key under settings',
      'settings:\n  __proto__: { polluted: true }\n',
      5,
      'Unknown setting __proto__',
    ],
    [
      'the GitHub owner, an account name',
      'settings:\n  trackers.github.owner: ada\n',
      5,
      'trackers.github.owner is an account name, which each person fills in for themselves',
    ],
    [
      'the accounts whose comments start nothing',
      'settings:\n  triggers.ignoredCommentAuthors: [ada-bot]\n',
      5,
      'triggers.ignoredCommentAuthors is an account name, which each person fills in for themselves',
    ],
    [
      'toFillIn naming a setting that is not secret',
      'toFillIn:\n  - hosts.polling\n',
      5,
      'toFillIn names hosts.polling, which is not a secret setting',
    ],
  ])('refuses %s with the line and the reason', (_name, body, line, reason) => {
    expect(problems(other, file(body))).toEqual([{ line, reason }]);
  });

  it('refuses aliases of aliases with a line and a reason instead of failing', () => {
    const body = [
      'settings:',
      '  workflows.verdictApprovedLine: ok',
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
      '',
    ].join('\n');
    expect(problems(other, file(body))).toEqual([
      {
        line: 7,
        reason:
          'The file repeats aliases (*name) more than wow reads; write the values out instead',
      },
    ]);
  });

  it('refuses a step the app would refuse, with the line of its workflow', () => {
    const body =
      'workflows:\n  - id: w\n    name: W\n    steps:\n      - id: a\n        skillName: deliver-work\n        provider: claude\n        gateBefore: false\n        gateAfter: false\n        expectedArtifacts: []\n        rules:\n          - when: { fact: stepFailed }\n            goTo: { type: step, stepId: nowhere }\n';
    const [problem] = problems(other, file(body));
    expect(problem?.line).toBe(5);
    expect(problem?.reason).toMatch(/rule/i);
  });

  it('refuses text that is not YAML and a file without a version', () => {
    expect(problems(other, 'version: 1\nsettings: [\n')).toEqual([
      { line: expect.any(Number), reason: expect.stringMatching(/^This is not readable YAML/) },
    ]);
    expect(problems(other, 'settings: {}\n')).toEqual([
      { line: null, reason: 'The file has no version key, so it is not a wow setup file' },
    ]);
    expect(problems(other, '')).toEqual([{ line: null, reason: 'The file is empty' }]);
  });

  it('refuses a newer version and says which wow it needs', () => {
    expect(problems(other, 'version: 2\nwow: 0.9.0\nshade: blue\n')).toEqual([
      {
        line: 1,
        reason:
          'This setup file is version 2 and needs wow 0.9.0 or newer; this wow reads version 1. Update wow, then read the file again.',
      },
    ]);
  });

  it('refuses at apply too, with the lines, and stores nothing', () => {
    const before = other.database.db.select().from(events).all().length;
    expect(() => apply(other, file('colour: blue\n'))).toThrow(CommandRejected);
    expect(() => apply(other, file('colour: blue\n'))).toThrow(
      'Line 4: The file has a key wow does not know: "colour"',
    );
    expect(other.database.db.select().from(events).all()).toHaveLength(before);
  });

  it('applies a workflow whose skill is not installed and marks it', () => {
    const body =
      'workflows:\n  - id: brew\n    name: Brew report\n    steps:\n      - id: a\n        skillName: brew-report\n        provider: claude\n        gateBefore: false\n        gateAfter: true\n        expectedArtifacts: []\n';
    expect(ready(other, file(body)).marked).toEqual([
      { workflow: 'Brew report', reason: 'skill not installed: brew-report' },
    ]);
    apply(other, file(body));
    expect(workflowOf(other, 'brew')?.steps[0]).toMatchObject({
      skillName: 'brew-report',
      providerInstanceId: 'claude-home',
    });
    expect(applications(other)[0]?.marked).toEqual([
      { workflow: 'Brew report', reason: 'skill not installed: brew-report' },
    ]);
  });
});

describe('a step whose provider kind has no instance here', () => {
  const codexBody =
    'workflows:\n  - id: second\n    name: Second opinion\n    steps:\n      - id: a\n        skillName: check-work\n        provider: codex\n        gateBefore: false\n        gateAfter: true\n        expectedArtifacts: []\n';

  it('is saved again with its kind, and a run says which kind it waits for', () => {
    apply(other, file(codexBody));
    expect(applications(other)[0]?.marked).toEqual([
      {
        workflow: 'Second opinion',
        reason:
          'step check-work has no model, which Codex needs; choose one in the workflow, or the step fails when it starts',
      },
      {
        workflow: 'Second opinion',
        reason: 'no Codex instance here yet; choose one for its steps in the workflow',
      },
    ]);
    const saved = save(other);
    expect(saved.leftOut).toEqual([]);
    const entry = (
      parse(saved.text) as { workflows: { id: string; steps: unknown[] }[] }
    ).workflows.find((workflow) => workflow.id === 'second');
    expect(entry?.steps[0]).toMatchObject({ id: 'a', skillName: 'check-work', provider: 'codex' });
    on(other, { type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
    expect(() =>
      on(other, { type: 'workflowRun.start', runId: 'r1', workflowId: 'second', projectId: 'tea' }),
    ).toThrow(
      'Step check-work has no Codex instance here yet: choose one for it in the workflow Second opinion.',
    );
  });
});

describe('the size of a setup file', () => {
  it('refuses a preview and an apply of a text longer than advanced.setupFileMaxBytes', () => {
    on(other, {
      type: 'setting.set',
      key: 'advanced.setupFileMaxBytes',
      scope: 'global',
      value: 1024,
    });
    const long = file(`settings:\n  hosts.pollSeconds: 600\n# ${'x'.repeat(1100)}\n`);
    const reason =
      'The file is 1.2 KB; a setup file may be at most 1 KB (Settings → Advanced → Largest setup file).';
    expect(problems(other, long)).toEqual([{ line: null, reason }]);
    expect(() => apply(other, long)).toThrow(reason);
    expect(ready(other, file('settings:\n  hosts.pollSeconds: 600\n')).added).toHaveLength(1);
  });
});

// The methods the app calls, over the server's own connection.
function request(server: RunningServer, method: string, params: unknown): Promise<RpcResponse> {
  const socket = new WebSocket(server.url);
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ id: '1', method, params })));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as RpcResponse;
      if (!('id' in message)) return;
      socket.close();
      resolve(message);
    });
  });
}

describe('over the app connection', () => {
  it('saves, previews and applies through setup.save, setup.preview and dispatch', async () => {
    const saved = (await request(source, 'setup.save', {})) as { result: SetupSaved };
    expect(saved.result.text).toContain('version: 1');
    const read = (await request(other, 'setup.preview', { text: saved.result.text })) as {
      result: SetupRead;
    };
    expect(read.result.outcome).toBe('ready');
    const command: Command = {
      type: 'setup.apply',
      applicationId: 'over-rpc',
      name: 'team.yaml',
      text: saved.result.text,
    };
    expect(await request(other, 'dispatch', { commandId: 'c-over-rpc', command })).toMatchObject({
      result: { duplicate: false },
    });
    expect(applications(other).map((row) => row.id)).toEqual(['over-rpc']);
  });
});
