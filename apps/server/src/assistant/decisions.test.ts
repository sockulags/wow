import {
  type Decision,
  type ServerCommand,
  type SubscriptionTopic,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';
import { decisionOrder } from './decisions.js';

// Chief of staff plan U4: the decision queue and its briefs.

const now = '2026-11-10T08:00:00.000Z';

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, threadId ? { topic, threadId } : { topic }) as T[];
const decisions = () => rows<Decision>('decisions');

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Record<string, unknown> };
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-decisions-'));
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
    defaultModel: 'mock-model',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  asUser({
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    steps: [step('s1'), step('s2')],
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

function runAtGate(runId = 'run-1'): WorkflowRun {
  asUser({ type: 'workflowRun.start', runId, workflowId: 'delivery', projectId: 'tea' });
  const run = rows<WorkflowRun>('workflowRuns').find((entry) => entry.id === runId);
  asUser({
    type: 'workflowRun.stepCompleted',
    runId,
    stepId: run?.steps[0]?.stepId ?? '',
    finalMessage: 'Done.\n\nAPPROVED',
    artifactsFound: ['notes.md'],
  });
  const waiting = rows<WorkflowRun>('workflowRuns').find((entry) => entry.id === runId);
  if (!waiting) throw new Error('no run');
  return waiting;
}

const row = (extra: Partial<Decision>): Omit<Decision, 'brief' | 'briefPending'> => ({
  id: 'x',
  kind: 'gate',
  at: now,
  title: 't',
  where: null,
  path: '/',
  threadId: null,
  runId: null,
  proposalId: null,
  approvalId: null,
  questionId: null,
  cardId: null,
  holdsTurn: false,
  cardStart: null,
  fixed: [],
  ...extra,
});

describe('the queue (chief of staff spec 16, 17)', () => {
  it('lists a run at its gate with what wow says of it', () => {
    runAtGate();
    expect(decisions()).toMatchObject([
      {
        id: 'gate:run-1:s1',
        kind: 'gate',
        title: 'deliver-work waits for your review',
        where: 'Delivery · Tea',
        path: '/workflows/runs/run-1',
        fixed: ['Artifacts: notes.md'],
        brief: null,
      },
    ]);
  });

  it('puts what holds a turn first, then gates, proposals and failures, soonest card first', () => {
    const order = [
      row({ id: 'failed', kind: 'failedRun', at: '2026-11-10T07:00:00.000Z' }),
      row({ id: 'proposal', kind: 'proposal', at: '2026-11-10T06:00:00.000Z' }),
      row({ id: 'gate-late', kind: 'gate', cardStart: '2026-11-10T15:00:00.000Z' }),
      row({ id: 'gate-soon', kind: 'gate', cardStart: '2026-11-10T09:00:00.000Z' }),
      row({ id: 'gate-none', kind: 'gate', at: '2026-11-10T05:00:00.000Z' }),
      row({ id: 'approval', kind: 'approval', holdsTurn: true, at: '2026-11-10T07:59:00.000Z' }),
    ]
      .toSorted(decisionOrder)
      .map((entry) => entry.id);
    expect(order).toEqual([
      'approval',
      'gate-soon',
      'gate-late',
      'gate-none',
      'proposal',
      'failed',
    ]);
  });

  it('keeps a failed run until it is dismissed, and dismisses nothing else', () => {
    runAtGate();
    asUser({ type: 'workflowRun.stop', runId: 'run-1' });
    asUser({ type: 'workflowRun.start', runId: 'run-2', workflowId: 'delivery', projectId: 'tea' });
    const run = rows<WorkflowRun>('workflowRuns').find((entry) => entry.id === 'run-2');
    asUser({
      type: 'workflowRun.stepFailed',
      runId: 'run-2',
      stepId: run?.steps[0]?.stepId ?? '',
      error: 'The provider stopped.',
    });
    expect(decisions().map((entry) => entry.id)).toContain('failedRun:run-2');
    expect(() => asUser({ type: 'decision.dismiss', decisionId: 'gate:run-1:s1' })).toThrow(
      /Only a failed run or a missed card/,
    );
    asUser({ type: 'decision.dismiss', decisionId: 'failedRun:run-2' });
    expect(decisions().map((entry) => entry.id)).not.toContain('failedRun:run-2');
  });
});

describe('briefs (chief of staff spec 18)', () => {
  beforeEach(async () => {
    await server.providerService.test('claude-work');
    asUser({ type: 'thread.openAssistant', fallbackModel: 'mock-model', fallbackEffort: 'high' });
  });

  it('writes no brief it was not asked for, and asks for none past the daily limit', async () => {
    expect(
      (await call('write_brief', { decisionId: 'gate:nope:s1', text: 'x', recommendation: 'y' }))
        .isError,
    ).toBe(true);
    asUser({ type: 'setting.set', key: 'assistant.briefsPerDay', scope: 'global', value: 0 });
    runAtGate();
    await server.briefs.settled();
    expect(decisions()[0]).toMatchObject({ briefPending: false, brief: null });
  });
});
