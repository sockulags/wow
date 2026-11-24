import {
  settingsRegistry,
  type AssistantPermission,
  type AssistantPermissionUse,
  type AssistantProposal,
  type ServerCommand,
  type SettingRow,
  type SubscriptionTopic,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModel } from '../core/projector.js';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';
import { threads } from '../db/schema.js';
import { commandClasses } from './classes.js';
import { coverage } from './permissions.js';

// Chief of staff plan U2: standing permissions in the class table.

const now = '2026-11-10T08:00:00.000Z'; // a Tuesday

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
const setting = (key: string) =>
  rows<SettingRow>('settings').find((row) => row.key === key && row.scope === 'global')?.value;

interface Called {
  readonly isError: boolean;
  readonly content: Record<string, unknown> & { outcome?: string };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Called['content'] };
}

const step = (id: string): WorkflowStep => ({
  id,
  skillName: 'deliver-work',
  providerInstanceId: 'claude-work',
  model: 'mock-model',
  effort: 'high',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
});

const permission = (extra: Partial<AssistantPermission>): AssistantPermission => ({
  id: 'p1',
  kind: 'startRuns',
  projectIds: ['tea'],
  workflowIds: ['delivery'],
  paused: false,
  addedAt: now,
  ...extra,
});

const allow = (...permissions: AssistantPermission[]) => {
  asUser({ type: 'setting.set', key: 'assistant.delegation', scope: 'global', value: true });
  asUser({
    type: 'setting.set',
    key: 'assistant.permissions',
    scope: 'global',
    value: permissions,
  });
};

const proposals = () =>
  rows<AssistantProposal>('assistantProposals').filter((row) => row.state === 'pending');
const uses = () => rows<AssistantPermissionUse>('assistantPermissionUses');
const runs = () => rows<WorkflowRun>('workflowRuns');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-permissions-'));
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
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  for (const workflowId of ['delivery', 'other']) {
    asUser({ type: 'workflow.create', workflowId, name: workflowId, steps: [step('s1')] });
  }
  asUser({ type: 'setting.set', key: 'calendar.zone', scope: 'global', value: 'UTC' });
  asUser({
    type: 'setting.set',
    key: 'calendar.workHours',
    scope: 'global',
    value: {
      start: '08:00',
      end: '17:00',
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const startDelivery = () => call('start_run', { workflowId: 'delivery', projectId: 'tea' });

describe('Start runs (chief of staff spec 4, 5, 7)', () => {
  it('starts nothing on its own while delegation is off, whatever is stored', async () => {
    asUser({
      type: 'setting.set',
      key: 'assistant.permissions',
      scope: 'global',
      value: [permission({})],
    });
    expect((await startDelivery()).content.outcome).toBe('proposed');
    expect(runs()).toEqual([]);
  });

  it('starts a covered run at once, reports it and records the use', async () => {
    allow(permission({}));
    const started = await startDelivery();
    expect(started.content).toMatchObject({ outcome: 'done', underPermission: 'Start runs' });
    expect(runs()).toHaveLength(1);
    expect(uses()).toMatchObject([{ permissionId: 'p1', kind: 'startRuns' }]);
    expect(proposals()).toEqual([]);
    const read = await call('read_permissions');
    expect(read.content['permissions']).toMatchObject([{ id: 'p1', usedToday: 1 }]);
  });

  it("starts a covered card's thread at once and reports it like a run (orchestrator threads spec 27)", async () => {
    allow(permission({}));
    // The stored workflow's file, as the export writes it (spec 22).
    asUser({
      type: 'skills.sync',
      skills: [
        {
          id: path.join(root, 'workflows', 'delivery.md'),
          name: 'delivery',
          description: '',
          dir: path.join(root, 'workflows'),
          source: 'workflow',
          manualOnly: true,
          invocations: { claude: '/delivery', codex: '$delivery' },
          text: '## Deliver',
        },
      ],
    });
    asUser({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Brew the plan',
      start: '2026-11-11T12:00:00.000Z',
      end: '2026-11-11T13:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    const started = await call('start_card_run', { cardId: 'card-1' });
    expect(started.content).toMatchObject({ outcome: 'done', underPermission: 'Start runs' });
    expect(uses()).toMatchObject([{ permissionId: 'p1', kind: 'startRuns' }]);
    expect(runs()).toEqual([]);
    expect(
      server.database.db
        .select()
        .from(threads)
        .all()
        .map((thread) => thread.title),
    ).toEqual(['Brew the plan · 2026-11-11']);
  });

  it('leaves a workflow or project it does not name as a proposal', async () => {
    allow(permission({}));
    expect(
      (await call('start_run', { workflowId: 'other', projectId: 'tea' })).content.outcome,
    ).toBe('proposed');
  });

  it('asks again past the daily limit, when paused or ended, and says why', async () => {
    allow(permission({ dailyLimit: 1 }));
    expect((await startDelivery()).content.outcome).toBe('done');
    asUser({ type: 'workflowRun.stop', runId: runs()[0]?.id ?? '' });
    expect((await startDelivery()).content.outcome).toBe('proposed');
    expect(proposals()[0]?.lines.at(-1)).toMatchObject({
      what: 'Why this asks',
      to: 'Start runs was used 1 times today, its limit.',
    });

    allow(permission({ paused: true }));
    expect((await startDelivery()).content.outcome).toBe('proposed');
    allow(permission({ until: '2026-11-09' }));
    expect((await startDelivery()).content.outcome).toBe('proposed');
    expect(proposals().at(-1)?.lines.at(-1)?.to).toBe('Start runs ended on 2026-11-09.');
  });
});

const soonCard = (start: string, end: string) =>
  call('create_card', {
    title: 'Triage',
    start,
    end,
    zone: 'UTC',
    projectId: 'tea',
    workflowId: 'delivery',
  });

describe('Plan runs (chief of staff spec 4, 5)', () => {
  it('puts a card that starts soon on the calendar at once, inside work hours', async () => {
    allow(permission({ kind: 'planRuns' }));
    const made = await soonCard('2026-11-10T08:10:00.000Z', '2026-11-10T08:40:00.000Z');
    expect(made.content).toMatchObject({ outcome: 'changed', underPermission: 'Plan runs' });
    expect(uses()).toHaveLength(1);
  });

  it('asks for a card outside work hours', async () => {
    allow(permission({ kind: 'planRuns' }));
    asUser({
      type: 'setting.set',
      key: 'calendar.workHours',
      scope: 'global',
      value: { start: '09:00', end: '17:00', days: ['tuesday'] },
    });
    const made = await soonCard('2026-11-10T08:10:00.000Z', '2026-11-10T08:40:00.000Z');
    expect(made.content.outcome).toBe('proposed');
    expect(proposals()[0]?.lines.at(-1)?.to).toContain('outside');
  });
});

describe('what no permission covers (chief of staff spec 6, 7)', () => {
  it('covers only the five commands of planning and starting runs', () => {
    allow(
      ...(
        ['planRuns', 'startRuns', 'startThreads', 'driveThreads', 'retry', 'moveCards'] as const
      ).map((kind, index) => permission({ id: `p${index}`, kind })),
    );
    const coverable = new Set([
      'card.create',
      'card.update',
      'backlog.plan',
      'workflowRun.start',
      'card.runNow',
    ]);
    const read = readModel(server.database.db);
    const context = { now, registry: settingsRegistry };
    for (const type of Object.keys(commandClasses)) {
      if (coverable.has(type)) continue;
      const command = {
        type,
        projectId: 'tea',
        workflowId: 'delivery',
        runId: 'r',
        cardId: 'c',
      } as unknown as ServerCommand;
      expect([type, coverage(command, read, context)]).toEqual([type, undefined]);
    }
  });

  it('keeps delegation and the permissions themselves behind a yes', async () => {
    const on = await call('set_setting', {
      key: 'assistant.delegation',
      scope: 'global',
      value: true,
    });
    expect(on.content.outcome).toBe('proposed');
    allow(permission({}));
    const widened = await call('set_setting', {
      key: 'assistant.permissions',
      scope: 'global',
      value: [permission({ workflowIds: ['delivery', 'other'] })],
    });
    expect(widened.content.outcome).toBe('proposed');
    expect(setting('assistant.permissions')).toMatchObject([{ workflowIds: ['delivery'] }]);
  });

  it('never answers a gate under any permission', async () => {
    allow(permission({}));
    await startDelivery();
    const stop = await call('stop_run', { runId: runs()[0]?.id ?? '' });
    expect(stop.isError).toBe(true);
  });
});

describe('Focus cards (chief of staff spec 28)', () => {
  it('carry no workflow, and keep the time off the free slots', async () => {
    expect(() =>
      asUser({
        type: 'card.create',
        cardId: 'deep',
        title: 'Deep work',
        start: '2026-11-10T09:00:00.000Z',
        end: '2026-11-10T11:00:00.000Z',
        zone: 'UTC',
        focus: true,
        workflowId: 'delivery',
        projectId: 'tea',
      }),
    ).toThrow(/focus card carries no workflow/);
    asUser({
      type: 'card.create',
      cardId: 'deep',
      title: 'Deep work',
      start: '2026-11-10T09:00:00.000Z',
      end: '2026-11-10T11:00:00.000Z',
      zone: 'UTC',
      focus: true,
    });
    expect(() => asUser({ type: 'card.update', cardId: 'deep', workflowId: 'delivery' })).toThrow(
      /focus card carries no workflow/,
    );
    const { content } = await call('read_free_slots', { minutes: 60, days: 1 });
    expect(content['slots']).toEqual([
      { start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' },
      { start: '2026-11-10T11:00:00.000Z', end: '2026-11-10T17:00:00.000Z' },
    ]);
  });
});
