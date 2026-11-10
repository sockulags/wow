import { describe, expect, it } from 'vitest';
import {
  PageRead,
  ChangeRequest,
  changeRequestName,
  Command,
  InternalCommand,
  WorkingCopy,
  runFolder,
  workingCopyOnDisk,
  PlanIntent,
  PlanRun,
  isLivePlanRunState,
  subscriptionTopics,
  Keybinding,
  KeyValueList,
  ProviderCommand,
  SettingScopeRef,
  SubscribeParams,
  rpcMethods,
  ProviderEvent,
  RpcResponse,
  ServerMessage,
  StepRun,
  WorkflowStep,
  alwaysStopSkillDefaults,
  alwaysStops,
  settingsRegistry,
  type SettingDefinition,
} from './index.js';

describe('rpc envelope', () => {
  it('accepts a result or an error but not both', () => {
    expect(RpcResponse.safeParse({ id: '1', result: { ok: true } }).success).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', error: { code: 'invalid', message: 'x' } }).success,
    ).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', result: 1, error: { code: 'x', message: 'y' } }).success,
    ).toBe(false);
  });

  it('accepts subscription pushes from the server', () => {
    expect(ServerMessage.safeParse({ subscription: 'threads', data: [] }).success).toBe(true);
  });
});

describe('provider protocol', () => {
  it('parses a start turn command', () => {
    const command = ProviderCommand.parse({
      type: 'startTurn',
      threadId: 't1',
      cwd: 'C:\\work\\wow',
      prompt: 'hello',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(command.type).toBe('startTurn');
  });

  it('rejects an unknown event type', () => {
    expect(ProviderEvent.safeParse({ type: 'nope', threadId: 't1' }).success).toBe(false);
  });

  it('parses a question with options', () => {
    const event = ProviderEvent.parse({
      type: 'questionAsked',
      threadId: 't1',
      questionId: 'q1',
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'needs a server' }],
      multiSelect: false,
    });
    expect(event.type).toBe('questionAsked');
  });
});

describe('workflow contracts', () => {
  it('parses a step and its run', () => {
    expect(
      WorkflowStep.parse({
        id: 's1',
        skillName: 'capture-intent',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: ['intents/*/intent.md'],
      }).gateAfter,
    ).toBe(true);
    expect(StepRun.safeParse({ stepId: 's1', state: 'waiting', artifactsFound: [] }).success).toBe(
      true,
    );
  });
});

describe('settings registry', () => {
  const entries: [string, SettingDefinition][] = Object.entries(settingsRegistry);

  it('fills in every settings group', () => {
    const groups = new Set(entries.map(([, definition]) => definition.group));
    expect(groups).toEqual(
      new Set([
        'providers',
        'chat',
        'calendar',
        'outlook',
        'scheduler',
        'workflows',
        'skills',
        'plans',
        'trackers',
        'hosts',
        'triggers',
        'viewer',
        'diff',
        'workspaces',
        'appearance',
        'keybindings',
        'desktop',
        'updates',
        'advanced',
      ]),
    );
  });

  it('accepts the answers of files.read and nothing between them', () => {
    const result = rpcMethods['files.read'].result;
    const read = { absolutePath: '/work/demo/a.md', size: 3 };
    expect(result.safeParse({ kind: 'markdown', ...read, text: '# a' }).success).toBe(true);
    expect(
      result.safeParse({ kind: 'image', ...read, mediaType: 'image/png', base64: 'AAEC' }).success,
    ).toBe(true);
    expect(
      result.safeParse({ kind: 'refused', reason: 'outside', message: 'Not read.' }).success,
    ).toBe(true);
    expect(result.safeParse({ kind: 'image', ...read, text: 'not a picture' }).success).toBe(false);
    expect(
      result.safeParse({ kind: 'image', ...read, mediaType: 'text/html', base64: '' }).success,
    ).toBe(false);
    expect(result.safeParse({ kind: 'refused', reason: 'secret', message: 'x' }).success).toBe(
      false,
    );
    const params = rpcMethods['files.read'].params;
    expect(params.safeParse({ runId: 'r1', path: 'a.md' }).success).toBe(true);
    expect(params.safeParse({ runId: 'r1', path: '' }).success).toBe(false);
    expect(params.safeParse({ runId: 'r1', path: 'a\0.md' }).success).toBe(false);
  });

  it('seeds the Bug, Feature and Initiative templates (behavior 25)', () => {
    const outline = settingsRegistry['workflows.templates'].default.map((template) => [
      template.name,
      template.steps.map((step) => `${step.skillName}${step.gateAfter ? ' (gate after)' : ''}`),
    ]);
    expect(outline).toEqual([
      ['Bug', ['deliver-work', 'check-work']],
      [
        'Feature',
        ['capture-intent (gate after)', 'plan-work (gate after)', 'deliver-work', 'check-work'],
      ],
      [
        'Initiative',
        [
          'capture-intent (gate after)',
          'plan-work (gate after)',
          'shape-work (gate after)',
          'deliver-work',
          'check-work',
        ],
      ],
    ]);
  });

  it('refuses templates that share a kind', () => {
    const [bug] = settingsRegistry['workflows.templates'].default;
    expect(settingsRegistry['workflows.templates'].schema.safeParse([bug, bug]).success).toBe(
      false,
    );
  });

  it('accepts shortcuts with modifiers or empty, and marks the schema as a keybinding', () => {
    expect(Keybinding.safeParse('Mod+K').success).toBe(true);
    expect(Keybinding.safeParse('Mod+Shift+,').success).toBe(true);
    expect(Keybinding.safeParse('').success).toBe(true);
    expect(Keybinding.safeParse('Mod+').success).toBe(false);
    expect(Keybinding.safeParse('Hyper+K').success).toBe(false);
    expect(Keybinding.meta()?.['widget']).toBe('keybinding');
  });

  it('rejects duplicate keys in a key-value list', () => {
    const entry = { key: 'TOKEN', value: 'x', secret: true };
    expect(KeyValueList.safeParse([entry]).success).toBe(true);
    expect(KeyValueList.safeParse([entry, entry]).success).toBe(false);
  });

  it.each(entries)('%s has a default that passes its own schema', (_key, definition) => {
    expect(definition.schema.safeParse(definition.default).success).toBe(true);
  });

  it('prefixes every key with its group', () => {
    for (const [key, definition] of entries) {
      expect(key.startsWith(`${definition.group}.`)).toBe(true);
    }
  });

  it('rejects an unknown time zone and inverted work hours', () => {
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Europe/Stockholm').success).toBe(
      true,
    );
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Mars/Olympus').success).toBe(false);
    expect(
      settingsRegistry['calendar.workHours'].schema.safeParse({
        start: '17:00',
        end: '08:00',
        days: ['monday'],
      }).success,
    ).toBe(false);
  });
});

describe('server contracts', () => {
  it('accepts only the three setting scopes', () => {
    expect(SettingScopeRef.safeParse('global').success).toBe(true);
    expect(SettingScopeRef.safeParse('project:p1').success).toBe(true);
    expect(SettingScopeRef.safeParse('provider:claude-work').success).toBe(true);
    expect(SettingScopeRef.safeParse('project:').success).toBe(false);
    expect(SettingScopeRef.safeParse('team:x').success).toBe(false);
  });

  it('keeps the intents folder inside the project', () => {
    const { schema } = settingsRegistry['plans.intentsDirectory'];
    expect(schema.parse(' docs/intents ')).toBe('docs/intents');
    const outside = ['', '../intents', 'docs/../../x', '/etc', 'C:\\plans', '~/intents', '.', './'];
    expect(schema.parse('..drafts')).toBe('..drafts');
    expect(outside.filter((value) => schema.safeParse(value).success)).toEqual([]);
  });

  it('needs a threadId for thread-scoped topics', () => {
    expect(SubscribeParams.safeParse({ topic: 'projects' }).success).toBe(true);
    expect(SubscribeParams.safeParse({ topic: 'threadItems' }).success).toBe(false);
    expect(SubscribeParams.safeParse({ topic: 'threadItems', threadId: 't1' }).success).toBe(true);
  });

  it('dispatches only known commands', () => {
    const params = rpcMethods.dispatch.params;
    expect(
      params.safeParse({
        commandId: 'c1',
        command: { type: 'setting.set', key: 'k', scope: 'global', value: 1 },
      }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'project.explode', projectId: 'p1' }).success).toBe(false);
  });
});

describe('hosts', () => {
  it('reads a page read of linked Confluence pages, each with its own error', () => {
    const row = {
      id: 'run:r1',
      projectId: 'tea',
      runId: 'r1',
      host: 'confluence',
      hostName: 'wiki.example.invalid',
      pages: [
        {
          ref: 'id:123',
          link: 'https://wiki.example.invalid/pages/viewpage.action?pageId=123',
          source: 'ticket',
          page: {
            id: '123',
            title: 'Design',
            space: 'ENG',
            version: 2,
            body: '<p>x</p>',
            url: null,
          },
          fetchedAt: '2026-11-03T09:00:00.000Z',
          error: null,
        },
      ],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: null,
    };
    expect(PageRead.safeParse(row).success).toBe(true);
    expect(
      PageRead.safeParse({ ...row, pages: [{ ...row.pages[0], source: 'search' }] }).success,
    ).toBe(false);
  });

  it('reads a plan row stored before plans could be followed', () => {
    const stored = {
      id: 'tea:2026-01-tea-timer',
      projectId: 'tea',
      intentId: '2026-01-tea-timer',
      title: 'A tea timer',
      hasIntent: true,
      status: 'accepted',
      rev: 1,
      spec: null,
      plan: null,
      source: 'files',
      units: [
        {
          key: 'U1',
          title: 'Count down',
          line: 12,
          dependsOn: [],
          blocked: null,
          contract: null,
          status: 'unknown',
          statusReason: 'No host is set up',
        },
      ],
      problems: [],
    };
    const row = PlanIntent.parse(stored);
    expect(row.followed).toBe(false);
    expect(row.units[0]?.changeRequestId).toBeNull();
  });

  it('accepts a plan.follow command and a change request with checks and comments', () => {
    expect(
      Command.safeParse({ type: 'plan.follow', planId: 'tea:2026-01-tea-timer', followed: true })
        .success,
    ).toBe(true);
    const request = {
      id: 'tea:14',
      projectId: 'tea',
      host: 'github',
      number: 14,
      title: 'Ring the bell',
      url: 'https://ghe.example.invalid/acme/tea/pull/14',
      state: 'open',
      draft: true,
      mergedAt: null,
      headBranch: 'agent/U2-bell',
      headSha: 'b2b2b2b',
      units: [{ intentId: '2026-01-tea-timer', unitKey: 'U2' }],
      checkState: 'failure',
      checks: [{ name: 'test', state: 'failure', url: null }],
      comments: [],
      newestCommentId: null,
    };
    expect(ChangeRequest.safeParse(request).success).toBe(true);
    // A GitLab merge request is a change request too (review loop spec 34), written `!14`.
    expect(ChangeRequest.safeParse({ ...request, host: 'gitlab' }).success).toBe(true);
    expect(ChangeRequest.safeParse({ ...request, host: 'bitbucket' }).success).toBe(false);
    expect(changeRequestName({ host: 'gitlab', number: 14 })).toBe('Merge request !14');
    expect(changeRequestName({ host: 'github', number: 14 })).toBe('Pull request #14');
    expect(
      ChangeRequest.safeParse({ ...request, checks: [{ name: 'test', state: 'none', url: null }] })
        .success,
    ).toBe(false);
  });
});

describe('working copies', () => {
  const copy = {
    path: '/home/me/.wow/workspaces/tea-timer-1a2b3c4d',
    state: 'pending',
    startSha: null,
    defaultBranch: null,
    note: null,
    unpushed: null,
    error: null,
  };

  it('accepts a working copy in every state and only those', () => {
    for (const state of ['pending', 'ready', 'failed', 'kept', 'removed']) {
      expect(WorkingCopy.safeParse({ ...copy, state }).success).toBe(true);
    }
    expect(WorkingCopy.safeParse({ ...copy, state: 'gone' }).success).toBe(false);
    expect(WorkingCopy.safeParse({ ...copy, path: '' }).success).toBe(false);
    expect(workingCopyOnDisk(WorkingCopy.parse({ ...copy, state: 'kept' }))).toBe(true);
    expect(workingCopyOnDisk(WorkingCopy.parse({ ...copy, state: 'removed' }))).toBe(false);
  });

  it('names the folder a run works in', () => {
    expect(runFolder({ workingCopy: WorkingCopy.parse(copy) }, '/home/me/tea')).toBe(copy.path);
    expect(runFolder({ workingCopy: null }, '/home/me/tea')).toBe('/home/me/tea');
    expect(runFolder({}, '/home/me/tea')).toBe('/home/me/tea');
  });

  it('takes the switch on a workflow and the outcome of a working copy as commands', () => {
    expect(
      Command.safeParse({ type: 'workflow.update', workflowId: 'w', ownWorkingCopy: true }).success,
    ).toBe(true);
    expect(
      InternalCommand.safeParse({
        type: 'workflowRun.workingCopySettled',
        runId: 'r1',
        state: 'kept',
        unpushed: {
          uncommittedFiles: 2,
          unpushedCommits: 1,
          newestSubject: 'Ring the bell',
          branch: null,
        },
        error: null,
      }).success,
    ).toBe(true);
    // A client cannot report what became of a working copy.
    expect(
      Command.safeParse({
        type: 'workflowRun.workingCopyFailed',
        runId: 'r1',
        error: 'made up',
      }).success,
    ).toBe(false);
    expect(Object.keys(rpcMethods)).toContain('workflowRuns.removeWorkingCopy');
  });
});

describe('plan runs', () => {
  const planRun = {
    id: 'pr1',
    planId: 'tea:2026-01-tea-timer',
    projectId: 'tea',
    intentId: '2026-01-tea-timer',
    workflowId: 'deliver',
    state: 'waiting',
    units: [{ unitKey: 'U1', title: 'Count down', runId: 'pr1.U1', outcome: 'done' }],
    waitingFor: ['U2 waits for U1 to merge'],
    message: null,
    startedAt: '2026-11-03T09:00:00.000Z',
    endedAt: null,
  };

  it('accepts a plan run in every state and only those, on its own topic', () => {
    for (const state of ['running', 'waiting', 'done', 'failed', 'stopped']) {
      expect(PlanRun.safeParse({ ...planRun, state }).success).toBe(true);
    }
    expect(PlanRun.safeParse({ ...planRun, state: 'paused' }).success).toBe(false);
    expect(
      PlanRun.safeParse({ ...planRun, units: [{ ...planRun.units[0], outcome: 'merged' }] })
        .success,
    ).toBe(false);
    expect(isLivePlanRunState('waiting')).toBe(true);
    expect(isLivePlanRunState('failed')).toBe(false);
    expect(subscriptionTopics.planRuns.row).toBe(PlanRun);
  });

  it('takes start, stop and the For units switch from clients, and advance only from the server', () => {
    expect(
      Command.safeParse({
        type: 'planRun.start',
        planRunId: 'pr1',
        planId: 'tea:2026-01-tea-timer',
        workflowId: 'deliver',
      }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'planRun.stop', planRunId: 'pr1' }).success).toBe(true);
    expect(
      Command.safeParse({ type: 'workflow.update', workflowId: 'w', forUnits: true }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'planRun.advance', planRunId: 'pr1' }).success).toBe(false);
    expect(InternalCommand.safeParse({ type: 'planRun.advance', planRunId: 'pr1' }).success).toBe(
      true,
    );
  });

  it('has the unit text and the failure choice as project settings', () => {
    const template = settingsRegistry['workflows.unitPromptTemplate'];
    expect(template.scope).toBe('project');
    expect(template.default).toContain('Intent-Unit: {{intentId}}/{{unitKey}}');
    const onFailure = settingsRegistry['workflows.planRunOnFailure'];
    expect(onFailure.default).toBe('stop');
    expect(onFailure.schema.safeParse('skip').success).toBe(true);
    expect(onFailure.schema.safeParse('retry').success).toBe(false);
  });
});

describe('gate conditions (review loop spec 54 to 57)', () => {
  const step = {
    id: 'check',
    skillName: 'check-work',
    providerInstanceId: 'claude-work',
    gateBefore: false,
    gateAfter: true,
    expectedArtifacts: [],
  };

  it('takes each part once on a step and nothing else', () => {
    const parse = (gateAfterCondition: unknown) =>
      WorkflowStep.safeParse({ ...step, gateAfterCondition }).success;
    expect(WorkflowStep.safeParse(step).success).toBe(true);
    expect(parse(['verdict', 'checks', 'artifacts'])).toBe(true);
    expect(parse(['verdict', 'verdict'])).toBe(false);
    expect(parse([])).toBe(false);
    expect(parse(['model'])).toBe(false);
  });

  it('records how a gate stands on the step run', () => {
    const gate = {
      state: 'passedByItself',
      parts: [{ part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' }],
      since: '2026-11-03T09:00:00.000Z',
      at: '2026-11-03T09:00:00.000Z',
    };
    const run = { stepId: 'check', state: 'done', artifactsFound: [] };
    expect(StepRun.safeParse({ ...run, gate }).success).toBe(true);
    expect(StepRun.safeParse({ ...run, gate: { ...gate, state: 'merged' } }).success).toBe(false);
  });

  it('always stops the four planning skills, with or without a plugin prefix, and what the setting adds', () => {
    for (const name of alwaysStopSkillDefaults) expect(alwaysStops(name, [])).toBe(true);
    expect(alwaysStops('agent-os-core:plan-work', [])).toBe(true);
    expect(alwaysStops('check-work', [])).toBe(false);
    expect(alwaysStops('write-spec', ['write-spec'])).toBe(true);
    expect(alwaysStops('acme:write-spec', ['write-spec'])).toBe(true);
  });

  it('has the three settings with their defaults, and the checks wait is sent only by the server', () => {
    expect(settingsRegistry['workflows.verdictApprovedLine'].default).toBe('APPROVED');
    expect(settingsRegistry['workflows.alwaysStopSkills'].default).toEqual([
      'capture-intent',
      'plan-work',
      'design-work',
      'shape-work',
    ]);
    expect(settingsRegistry['workflows.gateChecksTimeoutMinutes'].default).toBe(30);
    const check = { type: 'workflowRun.checkGate', runId: 'r1', stepId: 'check' };
    expect(InternalCommand.safeParse(check).success).toBe(true);
    expect(Command.safeParse(check).success).toBe(false);
  });
});
