import {
  Diagnosis,
  type ChangeRequest,
  type DiagnosisProblem,
  type ServerCommand,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflowRuns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';

// "Why does this not work" (app assistant plan U4, spec 19, 20): the diagnosis tool lists each
// failing thing with its reason and the setting or view to fix it in, and says so when nothing
// fails. Every host is the invented fetch below; GitLab refuses its token.

// Invented. It must not show in any answer.
const gitlabToken = 'wow-marked-gitlab-token-2c81';

let root: string;
let server: RunningServer;
let ids = 0;
const now = '2026-11-10T08:00:00.000Z';
// The server's clock; a case moves it on instead of waiting.
let clock = Date.parse(now);
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();

const dispatch = (command: ServerCommand) => server.engine.dispatch(`d${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });

const hostFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname === 'gitlab.example.invalid') {
    return Promise.resolve(Response.json({ message: '401 Unauthorized' }, { status: 401 }));
  }
  return Promise.resolve(
    Response.json({ login: 'ada', name: 'Ada', displayName: 'Ada', username: 'ada' }),
  );
};

const step = (id: string, skillName = 'brew', extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...extra,
});

async function diagnose(): Promise<{ text: string; diagnosis: Diagnosis }> {
  const result = await server.assistant.tools.call('diagnose_setup', {});
  expect(result.isError).toBe(false);
  return { text: result.text, diagnosis: Diagnosis.parse(JSON.parse(result.text)) };
}

const ofKind = (problems: readonly DiagnosisProblem[], kind: DiagnosisProblem['kind']) =>
  problems.filter((problem) => problem.kind === kind);

const runOf = (id: string) =>
  server.database.db
    .select()
    .from(workflowRuns)
    .all()
    .find((run) => run.id === id);

beforeEach(async () => {
  clock = Date.parse(now);
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-diagnosis-'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(clock),
    fetch: hostFetch,
    hooks: {
      providers: {
        // A step's turn never ends by itself; the test says how it ends.
        claude: () => new MockProviderAdapter('claude', () => []),
      },
    },
  });
  dispatch({
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
  await server.providerService.test('claude-work');
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
  dispatch({
    type: 'skills.sync',
    skills: [
      {
        id: 'skill-brew',
        name: 'brew',
        description: 'Brews.',
        dir: path.join(root, 'skills', 'brew'),
        source: 'custom',
        manualOnly: false,
        invocations: { claude: '/brew', codex: '$brew' },
      },
    ],
  });
  dispatch({ type: 'workflow.create', workflowId: 'brew', name: 'Brew', steps: [step('pour')] });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the diagnosis (spec 19, 20)', () => {
  it('says nothing is failing when nothing is, and what it looked at', async () => {
    const { diagnosis } = await diagnose();
    expect(diagnosis.problems).toEqual([]);
    expect(diagnosis.summary).toBe('Nothing is failing in what wow checked.');
    expect(diagnosis.checked).toEqual(
      expect.arrayContaining([
        'provider sign-ins: 1 instance',
        'connection tests: no host connection is set up',
        'skills of 1 workflow',
      ]),
    );
  });

  it('names a provider that is not signed in, with its last test and Settings → Providers', async () => {
    dispatch({
      type: 'providerInstance.recordTest',
      providerInstanceId: 'claude-work',
      result: { ok: false, account: null, version: '2.1.0', message: 'Not logged in' },
    } as ServerCommand);
    const { diagnosis } = await diagnose();
    expect(ofKind(diagnosis.problems, 'provider')).toEqual([
      {
        kind: 'provider',
        what: 'Provider Claude at work',
        reason:
          'It is not signed in: its last test failed (Not logged in). Press Test after fixing it.',
        place: { label: 'Settings → Providers', path: '/settings/providers' },
      },
    ]);
    expect(diagnosis.summary).toBe('1 thing is failing.');
  });

  it("names a failed connection test with the host's refusal, for the shared settings and a project's own, and tests only the hosts in use", async () => {
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid');
    set(
      'trackers.gitlab.token',
      await server.secrets.set('setting:trackers.gitlab.token', gitlabToken),
    );
    set('trackers.jira.baseUrl', 'https://acme.atlassian.example');
    dispatch({ type: 'project.create', projectId: 'leaf', name: 'Leaf', cwd: root });
    set('trackers.gitlab.baseUrl', 'https://gitlab.example.invalid', 'project:leaf');

    const { diagnosis, text } = await diagnose();
    const failed = ofKind(diagnosis.problems, 'connection');
    expect(failed.map(({ what, place }) => ({ what, place }))).toEqual([
      {
        what: 'Jira: connection test',
        place: { label: 'Settings → Trackers', path: '/settings/trackers' },
      },
      {
        what: 'GitLab: connection test',
        place: { label: 'Settings → Trackers', path: '/settings/trackers' },
      },
      {
        what: 'GitLab for Leaf: connection test',
        place: { label: 'Settings → Projects → Leaf', path: '/settings/projects' },
      },
    ]);
    // Jira's address is there and nothing else; the test says what to fill in.
    expect(failed[0]?.reason).toMatch(/^Fill in .*Jira email.*Jira token/);
    expect(failed[1]?.reason).toMatch(/401/);
    expect(diagnosis.checked).toContain('connection tests: Jira, GitLab, GitLab for Leaf');
    // GitHub and Confluence are not set up, so they are not tested and not failing.
    expect(diagnosis.problems.some((problem) => /GitHub|Confluence/.test(problem.what))).toBe(
      false,
    );
    expect(text).not.toContain(gitlabToken);
  });

  it('names a workflow step whose skill is not installed, with the workflow to fix it in', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'steep',
      name: 'Steep',
      steps: [step('warm'), step('wait', 'wait-patiently')],
    });
    const { diagnosis } = await diagnose();
    expect(ofKind(diagnosis.problems, 'skill')).toEqual([
      {
        kind: 'skill',
        what: 'Workflow Steep, step wait',
        reason:
          'It runs the skill wait-patiently, which is not installed on this machine. Install the skill or pick another one for the step.',
        place: { label: 'Workflows → Steep', path: '/workflows/steep' },
      },
    ]);
  });

  it('names an event trigger that could not start its run, and a failed host read with the setting it names', async () => {
    dispatch({ type: 'workflow.create', workflowId: 'mend', name: 'Mend', steps: [step('fix')] });
    dispatch({
      type: 'trigger.create',
      triggerId: 'on-merged',
      projectId: 'tea',
      event: 'merged',
      workflowId: 'mend',
    });
    dispatch({
      type: 'workflowRun.start',
      runId: 'run-watch',
      workflowId: 'brew',
      projectId: 'tea',
    });
    const request = (state: ChangeRequest['state']): ChangeRequest => ({
      id: 'tea:14',
      projectId: 'tea',
      host: 'github',
      number: 14,
      title: 'Ring the bell',
      url: 'https://github.example.invalid/acme/tea/pull/14',
      state,
      draft: false,
      mergedAt: state === 'merged' ? at(-5) : null,
      headBranch: 'agent/bell',
      headSha: 'b2b2b2b',
      units: [],
      checkState: 'none',
      checks: [],
      comments: [],
      newestCommentId: null,
    });
    const sync = (state: ChangeRequest['state']) =>
      dispatch({
        type: 'hosts.sync',
        projectId: 'tea',
        at: now,
        host: 'github',
        hostName: 'github.example.invalid',
        reads: [
          {
            id: 'run:run-watch',
            scope: 'run',
            branch: 'agent/bell',
            result: { ok: true, changeRequestIds: ['tea:14'] },
          },
        ],
        changeRequests: [request(state)],
      });
    sync('open');
    dispatch({ type: 'workflow.delete', workflowId: 'mend' });
    sync('merged');

    const { diagnosis } = await diagnose();
    const [trigger] = ofKind(diagnosis.problems, 'trigger');
    expect(trigger).toMatchObject({
      what: 'Trigger "Pull request merged" for mend in Tea',
      place: { label: 'Workflows → Triggers', path: '/workflows/triggers' },
    });
    expect(trigger?.reason).toMatch(/^It could not start a run: .*mend/i);

    dispatch({
      type: 'hosts.sync',
      projectId: 'tea',
      at: at(1),
      host: 'github',
      hostName: 'github.example.invalid',
      reads: [
        {
          id: 'run:run-watch',
          scope: 'run',
          branch: 'agent/bell',
          result: {
            ok: false,
            error: {
              kind: 'refused',
              message: 'github.example.invalid refused the GitHub token (401).',
              setting: 'trackers.github.token',
            },
          },
        },
      ],
      changeRequests: [],
    });
    expect(ofKind((await diagnose()).diagnosis.problems, 'hostRead')).toEqual([
      {
        kind: 'hostRead',
        what: 'Reading github.example.invalid',
        reason: 'github.example.invalid refused the GitHub token (401).',
        place: { label: 'Settings → Trackers', path: '/settings/trackers' },
      },
    ]);
  });

  it('names a failed run with its error and its link, until a later run of it ends done', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'brew', projectId: 'tea' });
    dispatch({
      type: 'workflowRun.stepFailed',
      runId: 'run-1',
      stepId: 'pour',
      error: 'The kettle was empty.',
    });
    expect(runOf('run-1')?.state).toBe('failed');
    const { diagnosis } = await diagnose();
    expect(ofKind(diagnosis.problems, 'run')).toEqual([
      {
        kind: 'run',
        what: `Run of Brew in Tea, started ${now}`,
        reason: 'Step pour failed: The kettle was empty.',
        place: { label: 'The run of Brew', path: '/workflows/runs/run-1' },
      },
    ]);

    clock = Date.parse(at(10));
    dispatch({ type: 'workflowRun.start', runId: 'run-2', workflowId: 'brew', projectId: 'tea' });
    dispatch({
      type: 'workflowRun.stepCompleted',
      runId: 'run-2',
      stepId: 'pour',
      finalMessage: 'Poured.',
      artifactsFound: [],
    });
    expect(runOf('run-2')?.state).toBe('done');
    expect(ofKind((await diagnose()).diagnosis.problems, 'run')).toEqual([]);
  });

  it('names a card that did not start: missed, and failed with the reason, each with its card', async () => {
    dispatch({
      type: 'card.create',
      cardId: 'late',
      title: 'Brew yesterday',
      start: at(-24 * 60),
      end: at(-23 * 60),
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'brew',
    });
    dispatch({ type: 'workflow.create', workflowId: 'gone', name: 'Gone', steps: [step('x')] });
    dispatch({
      type: 'card.create',
      cardId: 'orphan',
      title: 'Brew the gone one',
      start: at(60),
      end: at(120),
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'gone',
    });
    dispatch({ type: 'workflow.delete', workflowId: 'gone' });
    dispatch({ type: 'trigger.fire', triggerId: 'orphan:trigger', runAt: at(60), runId: 'run-x' });

    const found = ofKind((await diagnose()).diagnosis.problems, 'card');
    expect(found.map(({ what, place }) => ({ what, place }))).toEqual([
      {
        what: `Card "Brew the gone one" at ${at(60)}`,
        place: { label: 'Calendar → Brew the gone one', path: '/calendar?item=orphan' },
      },
      {
        what: `Card "Brew yesterday" at ${at(-24 * 60)}`,
        place: { label: 'Calendar → Brew yesterday', path: '/calendar?item=late' },
      },
    ]);
    expect(found[0]?.reason).toMatch(/^Its run could not start: .*gone/i);
    expect(found[1]?.reason).toBe(
      'Its start time passed without a run: it was put in the past, or wow was closed or the scheduler paused then. Missed triggers are set to "Mark as missed" in Settings → Scheduler. Run now on the card starts it.',
    );
  });

  it('lists at most assistant.diagnosisLimit failed runs, newest first', async () => {
    set('assistant.diagnosisLimit', 2);
    for (const id of ['a', 'b', 'c']) {
      dispatch({ type: 'workflow.create', workflowId: id, name: `W${id}`, steps: [step('s')] });
      dispatch({ type: 'workflowRun.start', runId: `run-${id}`, workflowId: id, projectId: 'tea' });
      dispatch({ type: 'workflowRun.stepFailed', runId: `run-${id}`, stepId: 's', error: 'No.' });
    }
    const failed = ofKind((await diagnose()).diagnosis.problems, 'run');
    expect(failed).toHaveLength(2);
  });
});
