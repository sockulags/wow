import {
  assistantThreadId,
  type AppNotification,
  type AssistantPermission,
  type AssistantProposal,
  type Briefing,
  type CalendarItem,
  type ServerCommand,
  type SubscriptionTopic,
  type ThreadItem,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { calendarItems } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';

// Chief of staff plan U5: briefings, reminders, cards moved around meetings, and quiet. The clock
// is the test's own and the scheduler ticks only when the test says so.

let root: string;
let server: RunningServer;
let now: Date;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, threadId ? { topic, threadId } : { topic }) as T[];
const briefings = () => rows<Briefing>('briefings');
const notifications = () => rows<AppNotification>('notifications');
const at = (iso: string) => {
  now = new Date(iso);
};

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

function meeting(id: string, start: string, end: string): void {
  const item: CalendarItem = {
    id,
    source: 'outlook',
    externalId: id,
    title: 'Planning',
    start,
    end,
    zone: 'UTC',
    allDay: false,
    location: null,
    joinUrl: null,
    body: null,
    organizer: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: start,
  };
  server.database.db.insert(calendarItems).values(item).run();
}

beforeEach(async () => {
  at('2026-11-10T07:00:00.000Z'); // a Tuesday, before work hours
  root = await mkdtemp(path.join(tmpdir(), 'wow-chief-'));
  await mkdir(path.join(root, 'tea'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => now,
    schedulerTimers: { setTimeout: () => 0, clearTimeout: () => undefined },
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
    defaultModel: 'mock-model',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  await server.providerService.test('claude-work');
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  asUser({
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    steps: [step('s1')],
  });
  asUser({ type: 'setting.set', key: 'calendar.zone', scope: 'global', value: 'UTC' });
  asUser({
    type: 'setting.set',
    key: 'calendar.workHours',
    scope: 'global',
    value: { start: '08:00', end: '17:00', days: ['tuesday', 'wednesday'] },
  });
  asUser({ type: 'thread.openAssistant', fallbackModel: 'mock-model', fallbackEffort: 'high' });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('briefings (chief of staff spec 20 to 23)', () => {
  it('briefs once when work hours start, with wow’s lines, and asks the Assistant thread for nothing', () => {
    server.scheduler.tick();
    expect(briefings()).toEqual([]);
    at('2026-11-10T08:00:00.000Z');
    server.scheduler.tick();
    server.scheduler.tick();
    const [morning] = briefings();
    expect(briefings()).toHaveLength(1);
    expect(morning).toMatchObject({
      id: 'morning:2026-11-10',
      moment: 'morning',
      // The Assistant thread has no tool to write a summary with (orchestrator threads spec 25).
      summaryPending: false,
    });
    expect(morning?.lines.map((line) => line.text)).toContain('Nothing waits for you.');
    const asked = rows<ThreadItem>('threadItems', assistantThreadId).filter((item) =>
      String((item.payload as { text?: string }).text).includes('briefing morning:2026-11-10'),
    );
    expect(asked).toHaveLength(0);
    expect(notifications()).toMatchObject([{ kind: 'briefing', title: 'Good morning' }]);
  });

  it('briefs when the user comes back after a while away', async () => {
    at('2026-11-10T08:00:00.000Z');
    server.scheduler.tick();
    at('2026-11-10T10:30:00.000Z');
    asUser({ type: 'presence.back', awayFrom: '2026-11-10T09:00:00.000Z' });
    await Promise.resolve();
    expect(briefings().map((entry) => entry.moment)).toContain('back');
  });

  it('holds the notification during a meeting and sends it after', () => {
    meeting('outlook:standup', '2026-11-10T07:50:00.000Z', '2026-11-10T08:20:00.000Z');
    at('2026-11-10T08:05:00.000Z');
    server.scheduler.tick();
    expect(briefings()).toHaveLength(1);
    expect(notifications()).toEqual([]);
    at('2026-11-10T08:25:00.000Z');
    server.scheduler.tick();
    expect(notifications()).toMatchObject([{ kind: 'briefing' }]);
  });
});

describe('reminders (chief of staff spec 26)', () => {
  it('reminds once about a decision that waited long', () => {
    at('2026-11-10T08:00:00.000Z');
    asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'delivery', projectId: 'tea' });
    asUser({
      type: 'workflowRun.stepCompleted',
      runId: 'run-1',
      stepId: 's1',
      finalMessage: 'Done.',
      artifactsFound: [],
    });
    at('2026-11-10T08:30:00.000Z');
    server.scheduler.tick();
    expect(notifications().filter((entry) => entry.kind === 'reminder')).toEqual([]);
    at('2026-11-10T09:10:00.000Z');
    server.scheduler.tick();
    at('2026-11-10T10:30:00.000Z');
    server.scheduler.tick();
    expect(notifications().filter((entry) => entry.kind === 'reminder')).toHaveLength(1);
  });
});

const triageCard = () =>
  asUser({
    type: 'card.create',
    cardId: 'triage',
    title: 'Triage',
    start: '2026-11-10T13:00:00.000Z',
    end: '2026-11-10T13:30:00.000Z',
    zone: 'UTC',
    projectId: 'tea',
    workflowId: 'delivery',
  });

describe('cards moved around meetings (chief of staff spec 24)', () => {
  it('proposes the move without Move cards', () => {
    at('2026-11-10T09:00:00.000Z');
    triageCard();
    meeting('outlook:review', '2026-11-10T12:30:00.000Z', '2026-11-10T14:00:00.000Z');
    server.scheduler.tick();
    const [proposal] = rows<AssistantProposal>('assistantProposals');
    expect(proposal).toMatchObject({ title: 'Move "Triage" off Planning', state: 'pending' });
    expect(rows<CalendarItem>('calendarItems').find((item) => item.id === 'triage')?.start).toBe(
      '2026-11-10T13:00:00.000Z',
    );
  });

  it('moves it to the next free slot under Move cards', () => {
    const permission: AssistantPermission = {
      id: 'p1',
      kind: 'moveCards',
      projectIds: ['tea'],
      workflowIds: [],
      paused: false,
      addedAt: '2026-11-10T07:00:00.000Z',
    };
    asUser({ type: 'setting.set', key: 'assistant.delegation', scope: 'global', value: true });
    asUser({
      type: 'setting.set',
      key: 'assistant.permissions',
      scope: 'global',
      value: [permission],
    });
    at('2026-11-10T09:00:00.000Z');
    triageCard();
    meeting('outlook:review', '2026-11-10T12:30:00.000Z', '2026-11-10T14:00:00.000Z');
    server.scheduler.tick();
    expect(rows<CalendarItem>('calendarItems').find((item) => item.id === 'triage')).toMatchObject({
      start: '2026-11-10T14:00:00.000Z',
      end: '2026-11-10T14:30:00.000Z',
    });
    expect(rows('assistantPermissionUses')).toMatchObject([{ kind: 'moveCards' }]);
  });
});
