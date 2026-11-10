import { describe, expect, it } from 'vitest';
import {
  AssistantChange,
  AssistantProposal,
  DomainEvent,
  defaultSecretPatterns,
  hiddenText,
  hideSecrets,
  hideSecretsDeep,
  looksLikeSecret,
  secretPatterns,
  settingGroupTitles,
  SettingGroup,
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
  PathVisit,
  StepGate,
  StepRun,
  StepRunState,
  ruleConditionText,
  ruleProblems,
  WorkflowStep,
  alwaysStopSkillDefaults,
  alwaysStops,
  rulesForTemplate,
  rulesFromTemplate,
  settingsRegistry,
  type TemplateRule,
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

const templateStepWith = (skillName: string, rules?: TemplateRule[]) => ({
  skillName,
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...(rules ? { rules } : {}),
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
        'assistant',
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

  it('gives check-work of every default template the rule back to deliver-work (workflow branches spec 20)', () => {
    const templates = settingsRegistry['workflows.templates'].default;
    expect(templates.map((template) => template.kind)).toEqual(['bug', 'feature', 'initiative']);
    for (const template of templates) {
      const withRules = template.steps.filter((step) => step.rules !== undefined);
      expect(withRules.map((step) => [step.skillName, step.rules])).toEqual([
        [
          'check-work',
          [
            {
              when: { fact: 'verdict', is: 'changesRequested' },
              goTo: { type: 'skill', skillName: 'deliver-work' },
            },
          ],
        ],
      ]);
    }
  });

  it('reads a template stored before rules existed as it was stored', () => {
    const stored = [
      {
        kind: 'bug',
        name: 'Bug',
        steps: [
          { skillName: 'deliver-work', gateBefore: false, gateAfter: false, expectedArtifacts: [] },
          { skillName: 'check-work', gateBefore: false, gateAfter: true, expectedArtifacts: [] },
        ],
      },
    ];
    expect(settingsRegistry['workflows.templates'].schema.parse(stored)).toEqual(stored);
  });

  it('turns the rules of a template into rules between steps and back', () => {
    const when = { fact: 'verdict', is: 'changesRequested' } as const;
    const template = [
      templateStepWith('deliver-work'),
      templateStepWith('check-work', [
        { when, goTo: { type: 'skill', skillName: 'deliver-work' } },
      ]),
      templateStepWith('deliver-work'),
      templateStepWith('check-work', [
        { when, goTo: { type: 'skill', skillName: 'deliver-work' } },
        { when: { fact: 'stepFailed' }, goTo: { type: 'end' } },
        { when: { fact: 'verdict', is: 'blocked' }, goTo: { type: 'skill', skillName: 'gone' } },
      ]),
    ];
    const ids = ['a', 'b', 'c', 'd'];
    expect(rulesFromTemplate(template, ids, 0)).toEqual([]);
    // The nearest step before with that skill.
    expect(rulesFromTemplate(template, ids, 1)).toEqual([
      { when, goTo: { type: 'step', stepId: 'a' } },
    ]);
    expect(rulesFromTemplate(template, ids, 3)).toEqual([
      { when, goTo: { type: 'step', stepId: 'c' } },
      { when: { fact: 'stepFailed' }, goTo: { type: 'end' } },
    ]);

    const steps = template.map((entry, index) => ({
      id: ids[index] as string,
      skillName: entry.skillName,
      rules: rulesFromTemplate(template, ids, index),
    }));
    expect(rulesForTemplate(steps, 3)).toEqual(template[3]?.rules?.slice(0, 2));
    // A step that its skill would not find again cannot be named in a template.
    const far = [...steps];
    far[3] = {
      id: 'd',
      skillName: 'check-work',
      rules: [{ when, goTo: { type: 'step', stepId: 'a' } }],
    };
    expect(rulesForTemplate(far, 3)).toEqual([]);
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

const reviewStep = {
  id: 'review',
  skillName: 'check-work',
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
};
const toBuild = { type: 'step' as const, stepId: 'build' };
const withRule = (when: unknown) =>
  WorkflowStep.safeParse({ ...reviewStep, rules: [{ when, goTo: toBuild }] });

describe('rules on a step (workflow branches spec 1 to 18)', () => {
  it('takes a step with rules and still takes one without', () => {
    expect(WorkflowStep.safeParse(reviewStep).success).toBe(true);
    const rules = [
      { when: { fact: 'verdict', is: 'changesRequested' }, goTo: toBuild },
      { when: { fact: 'checks', is: 'failed' }, goTo: toBuild },
      { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
      { when: { fact: 'stepFailed' }, goTo: { type: 'end' } },
    ];
    expect(WorkflowStep.safeParse({ ...reviewStep, rules }).success).toBe(true);
  });

  it('refuses a fact or value wow does not read', () => {
    expect(withRule({ fact: 'changeSize', is: 'large' }).success).toBe(false);
    expect(withRule({ fact: 'verdict', is: 'maybe' }).success).toBe(false);
    expect(withRule({ fact: 'checks', is: 'undecided' }).success).toBe(false);
  });

  it('names what is wrong with rules: a missing step, no expected artifacts, one condition twice', () => {
    const step = WorkflowStep.parse({
      ...reviewStep,
      rules: [
        {
          when: { fact: 'verdict', is: 'changesRequested' },
          goTo: { type: 'step', stepId: 'gone' },
        },
        { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
        { when: { fact: 'verdict', is: 'changesRequested' }, goTo: { type: 'end' } },
      ],
    });
    expect(ruleProblems([step])).toEqual([
      {
        stepId: 'review',
        rule: 0,
        reason: 'The rule "verdict changes requested" goes to a step that no longer exists',
      },
      {
        stepId: 'review',
        rule: 1,
        reason: 'The rule "artifacts missing" needs expected artifacts, and this step names none',
      },
      {
        stepId: 'review',
        rule: 2,
        reason: 'The step already has a rule for "verdict changes requested"',
      },
    ]);
    expect(ruleProblems([WorkflowStep.parse(reviewStep)])).toEqual([]);
  });

  it('says a condition in words', () => {
    expect(ruleConditionText({ fact: 'verdict', is: 'none' })).toBe('no verdict');
    expect(ruleConditionText({ fact: 'checks', is: 'successful' })).toBe('checks successful');
    expect(ruleConditionText({ fact: 'stepFailed' })).toBe('step failed');
  });

  it('has skipped as a step state, the limit as a gate state and a path on a run', () => {
    expect(StepRunState.safeParse('skipped').success).toBe(true);
    const at = '2026-11-03T09:00:00.000Z';
    expect(
      StepGate.safeParse({
        state: 'waitingAtLimit',
        parts: [],
        detail: 'deliver-work has run 3 times: the limit',
        since: at,
        at,
      }).success,
    ).toBe(true);
    expect(
      PathVisit.safeParse({
        stepId: 'review',
        attempt: 2,
        startedAt: at,
        endedAt: at,
        ended: 'done',
        next: { to: toBuild, by: 'rule', when: { fact: 'verdict', is: 'changesRequested' } },
        reason: 'verdict changes requested → deliver-work',
      }).success,
    ).toBe(true);
  });

  it('takes a limit of its own on a workflow, and null to take it away', () => {
    const update = { type: 'workflow.update', workflowId: 'w' };
    expect(Command.safeParse({ ...update, maxStepVisits: 2 }).success).toBe(true);
    expect(Command.safeParse({ ...update, maxStepVisits: null }).success).toBe(true);
    expect(Command.safeParse({ ...update, maxStepVisits: 0 }).success).toBe(false);
  });

  it('registers the settings rules use, with their defaults', () => {
    expect(settingsRegistry['workflows.maxStepVisits'].default).toBe(3);
    expect(settingsRegistry['workflows.verdictChangesRequestedLine'].default).toBe(
      'CHANGES_REQUESTED',
    );
    expect(settingsRegistry['workflows.verdictBlockedLine'].default).toBe('BLOCKED');
    expect(settingsRegistry['workflows.goBackTemplate'].default).toContain('{{fromStep}}');
  });
});

describe('app assistant', () => {
  const at = '2026-11-10T08:00:00.000Z';
  const place = { label: 'Settings → Calendar', path: '/settings/calendar' };
  const change = {
    id: 'c1',
    at,
    commandType: 'setting.set',
    what: 'Work hours',
    from: '08:00–17:00',
    to: '08:00–16:00',
    place,
    target: { kind: 'setting', id: 'calendar.workHours:global' },
    expect: { value: { start: '08:00', end: '16:00' } },
    inverse: [{ type: 'setting.reset', key: 'calendar.workHours', scope: 'global' }],
    state: 'applied',
    undoneAt: null,
  };
  const proposal = {
    id: 'p1',
    at,
    commandType: 'workflowRun.start',
    title: 'Start Delivery in Tea',
    lines: [{ what: 'Backlog item', from: null, to: 'A quieter kettle' }],
    place: { label: 'Workflows → Delivery', path: '/workflows/delivery' },
    command: { type: 'workflowRun.start', runId: 'r1', workflowId: 'delivery', projectId: 'tea' },
    state: 'pending',
    answeredAt: null,
    reason: null,
  };

  it('has commands for the answers only the user gives', () => {
    expect(Command.safeParse({ type: 'assistant.undo', changeId: 'c1' }).success).toBe(true);
    expect(Command.safeParse({ type: 'assistant.proposal.accept', proposalId: 'p1' }).success).toBe(
      true,
    );
    expect(
      Command.safeParse({ type: 'assistant.proposal.decline', proposalId: 'p1', reason: 'No' })
        .success,
    ).toBe(true);
    expect(
      Command.safeParse({ type: 'assistant.proposal.decline', proposalId: 'p1' }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'assistant.undo' }).success).toBe(false);
    // A command carries no origin: who sent it is the connection's to say, not the sender's.
    expect(Command.parse({ type: 'assistant.undo', changeId: 'c1', origin: 'user' })).toEqual({
      type: 'assistant.undo',
      changeId: 'c1',
    });
  });

  it('describes a change and a proposal, as rows of their own topics and as events', () => {
    expect(subscriptionTopics.assistantChanges.row.parse(change)).toEqual(change);
    expect(subscriptionTopics.assistantProposals.row.parse(proposal)).toEqual(proposal);
    expect(AssistantChange.safeParse({ ...change, state: 'gone' }).success).toBe(false);
    expect(AssistantChange.safeParse({ ...change, from: null, expect: null }).success).toBe(true);
    expect(AssistantProposal.safeParse({ ...proposal, state: 'applied' }).success).toBe(false);
    for (const event of [
      { kind: 'assistant.changed', aggregate: 'c1', payload: change },
      { kind: 'assistant.changeUndone', aggregate: 'c1', payload: { changeId: 'c1', at } },
      { kind: 'assistant.proposed', aggregate: 'p1', payload: proposal },
      {
        kind: 'assistant.proposalAnswered',
        aggregate: 'p1',
        payload: { proposalId: 'p1', state: 'declined', reason: 'Not today', at },
      },
    ]) {
      expect(DomainEvent.safeParse(event).success).toBe(true);
    }
    expect(
      DomainEvent.safeParse({
        kind: 'assistant.proposalAnswered',
        aggregate: 'p1',
        payload: { proposalId: 'p1', state: 'pending', reason: null, at },
      }).success,
    ).toBe(false);
  });

  it('registers the assistant settings and names every settings page', () => {
    expect(settingsRegistry['assistant.providerInstanceId'].default).toBe('');
    expect(settingsRegistry['assistant.model'].default).toBe('');
    expect(settingsRegistry['assistant.effort'].default).toBe('');
    expect(settingsRegistry['assistant.secretPatterns'].default).toEqual(defaultSecretPatterns);
    expect(Object.keys(settingGroupTitles)).toEqual(SettingGroup.options);
    expect(settingGroupTitles.assistant).toBe('Assistant');
  });

  it('refuses a pattern that does not compile or that matches nothing at all', () => {
    const { schema } = settingsRegistry['assistant.secretPatterns'];
    expect(schema.safeParse(['tea-[0-9]{4}']).success).toBe(true);
    expect(schema.safeParse(['(']).success).toBe(false);
    expect(schema.safeParse(['x*']).success).toBe(false);
    expect(schema.safeParse(['']).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(true);
  });

  it('hides known token shapes, key blocks and a long random string after "token", "password" or "key"', () => {
    const patterns = secretPatterns(defaultSecretPatterns);
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
      'glpat-abcdefghijklmnopqrst',
      'ATATT3xFfGF0abcdefghijklmnop',
      'xoxb-1234567890-abcdefghij',
      'sk-abcdefghijklmnopqrstuvwx',
      'AKIAABCDEFGHIJKLMNOP',
    ];
    for (const secret of secrets) {
      expect(hideSecrets(`use ${secret} for it`, patterns)).toBe(`use ${hiddenText} for it`);
      expect(looksLikeSecret(secret, patterns)).toBe(true);
    }
    expect(
      hideSecrets(
        'before -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- after',
        patterns,
      ),
    ).toBe(`before ${hiddenText} after`);
    expect(hideSecrets('my password is 9f8e7d6c5b4a39281706f5e4d3c2', patterns)).toBe(
      `my password is ${hiddenText}`,
    );
    expect(hideSecrets('password: 9f8e7d6c5b4a39281706f5e4d3c2', patterns)).toBe(
      `password: ${hiddenText}`,
    );
    expect(hideSecrets('token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==', patterns)).toBe(
      `token=${hiddenText}`,
    );
    for (const harmless of [
      'Set the work hours to 08:00–16:00',
      'the key keybindings.goCalendar opens the calendar',
      'key: a-long-name-without-any-digit-in-it',
      'https://gitlab.example/tea/pot',
      'the branch task-123-fix-the-kettle-lid-for-good',
      'risk-assessment-for-the-new-kettle-and-pot',
    ]) {
      expect(looksLikeSecret(harmless, patterns)).toBe(false);
    }
  });

  it('hides inside any JSON value and skips a stored pattern that no longer compiles', () => {
    const patterns = secretPatterns(['(', 'tea-[0-9]{4}']);
    expect(patterns).toHaveLength(1);
    expect(
      hideSecretsDeep(
        { a: ['tea-1234', 5, null], 'tea-9999': { b: 'x tea-0000 y', c: true } },
        patterns,
      ),
    ).toEqual({ a: [hiddenText, 5, null], [hiddenText]: { b: `x ${hiddenText} y`, c: true } });
    // The same pattern object hides every time it is used.
    expect(hideSecrets('tea-1111 tea-2222', patterns)).toBe(`${hiddenText} ${hiddenText}`);
    expect(hideSecrets('tea-3333', patterns)).toBe(hiddenText);
  });
});
