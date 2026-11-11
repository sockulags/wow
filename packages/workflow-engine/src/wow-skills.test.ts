import {
  defaultGoBackTemplate,
  defaultHandoverTemplate,
  defaultSendBackTemplate,
  defaultUnitPromptTemplate,
  fillTemplate,
  Workflow as WorkflowSchema,
  type SkillRef,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { advance, startRun, type EngineContext, type ResolvedSkill } from './index.js';

// wow skills spec 10 to 15 in the engine: the step prompt with skills, the built-in skills
// attached by themselves, a run stored before, and a skill that is gone.

const T0 = '2026-11-02T08:00:00.000Z';
const T1 = '2026-11-02T09:00:00.000Z';

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

const workflow = (...steps: WorkflowStep[]): Workflow => ({
  id: 'wf1',
  name: 'Feature',
  templateKind: null,
  steps,
  createdAt: T0,
  updatedAt: T0,
});

// The skills the server would have: two built-in templates, one own skill, folder skills.
const wowTexts: Record<string, string> = {
  'wow-verdict': 'End with {{approvedLine}} or {{changesRequestedLine}} or {{blockedLine}}.',
  'wow-artifacts':
    'Write the artifacts.{{#expectedArtifacts}}\n\n{{expectedArtifacts}}{{/expectedArtifacts}}',
  'wow-pull-request':
    'Put the line in.{{#intentUnitLine}}\n\n{{intentUnitLine}}{{/intentUnitLine}}',
  'wow-handover': 'Hand over.',
};
const ownTexts: Record<string, string> = { tidy: 'Tidy the imports.' };

function skillFor(gone: readonly string[] = []): NonNullable<EngineContext['skillFor']> {
  return (current: WorkflowStep, ref: SkillRef, values): ResolvedSkill | undefined => {
    if (gone.includes(ref.name)) return undefined;
    const source = ref.source ?? (ref.name.startsWith('wow-') ? 'wow' : undefined);
    if (source === 'wow') {
      const template = wowTexts[ref.name];
      return template === undefined
        ? undefined
        : { kind: 'text', name: ref.name, source, text: fillTemplate(template, { ...values }) };
    }
    if (source === 'yours') {
      const text = ownTexts[ref.name];
      return text === undefined ? undefined : { kind: 'text', name: ref.name, source, text };
    }
    const codex = current.providerInstanceId.startsWith('codex');
    return {
      kind: 'invoke',
      name: ref.name,
      source: 'user-claude',
      invocation: codex ? `$${ref.name}` : `/${ref.name}`,
    };
  };
}

const context = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  now: T1,
  handoverTemplate: defaultHandoverTemplate,
  sendBackTemplate: defaultSendBackTemplate,
  unitPromptTemplate: defaultUnitPromptTemplate,
  verdictApprovedLine: 'APPROVED',
  verdictChangesRequestedLine: 'CHANGES_REQUESTED',
  verdictBlockedLine: 'BLOCKED',
  goBackTemplate: defaultGoBackTemplate,
  maxStepVisits: 3,
  alwaysStopSkills: [],
  gateChecksTimeoutMinutes: 30,
  invocationFor: (s) =>
    s.providerInstanceId.startsWith('codex') ? `$${s.skillName}` : `/${s.skillName}`,
  skillFor: skillFor(),
  attachBuiltInSkills: true,
  ...overrides,
});

const unit = {
  planRunId: 'pr1',
  planId: 'p1:demo',
  intentId: 'demo',
  unitKey: 'U2',
  title: 'Count down',
};

const firstStart = (definition: Workflow, ctx = context(), withUnit = false) => {
  const { effects, run } = startRun(
    definition,
    { runId: 'r1', projectId: 'p1', ...(withUnit ? { unit } : {}) },
    ctx,
  );
  const start = effects.find((effect) => effect.type === 'startStep');
  return { run, start };
};

const tidyStep = (providerInstanceId: string) =>
  step('tidy-up', {
    skillName: 'tidy',
    skillSource: 'yours',
    providerInstanceId,
    alsoFollow: [{ name: 'wow-handover', source: 'wow' }, { name: 'ship' }],
    extraPrompt: 'Only the server.',
  });

describe('a step with a wow skill and Also follow (spec 10, 11)', () => {
  it('makes the prompt for Claude Code: the skill text, the other wow skill, the folder skill, the extra prompt', () => {
    const { start } = firstStart(workflow(tidyStep('claude-work')));
    expect(start).toEqual({
      type: 'startStep',
      runId: 'r1',
      stepId: 'tidy-up',
      threadId: 'r1.tidy-up',
      prompt: [
        '<skill name="tidy">',
        'Tidy the imports.',
        '</skill>',
        '',
        '<skill name="wow-handover">',
        'Hand over.',
        '</skill>',
        '',
        '/ship Only the server.',
      ].join('\n'),
      shown: '/ship Only the server.',
      skills: [
        { name: 'tidy', source: 'yours', text: 'Tidy the imports.' },
        { name: 'wow-handover', source: 'wow', text: 'Hand over.' },
        { name: 'ship', source: 'user-claude', invocation: '/ship' },
      ],
    });
  });

  it('makes the prompt for Codex the same way with its own invocation', () => {
    const { start } = firstStart(workflow(tidyStep('codex-work')));
    expect(start?.type === 'startStep' && start.prompt.endsWith('\n\n$ship Only the server.')).toBe(
      true,
    );
  });

  it('keeps the prompt of a step with a folder skill and nothing else as it was', () => {
    const { start } = firstStart(workflow(step('ship', { extraPrompt: 'Go.' })));
    expect(start).toMatchObject({ prompt: '/ship Go.', shown: '/ship Go.' });
  });
});

describe('built-in skills attached by themselves (spec 12, 13)', () => {
  it('attaches wow-verdict when the gate after reads the verdict, filled from the verdict lines', () => {
    const { start } = firstStart(
      workflow(step('review', { gateAfter: true, gateAfterCondition: ['verdict'] })),
      context({ verdictApprovedLine: 'SHIP IT' }),
    );
    expect(start).toMatchObject({
      prompt:
        '/review\n\n<skill name="wow-verdict">\nEnd with SHIP IT or CHANGES_REQUESTED or BLOCKED.\n</skill>',
      skills: [
        { name: 'review' },
        { name: 'wow-verdict', reason: 'the gate after this step reads the verdict' },
      ],
    });
  });

  it('attaches wow-verdict when a rule reads the verdict', () => {
    const { start } = firstStart(
      workflow(
        step('review', {
          rules: [{ when: { fact: 'verdict', is: 'changesRequested' }, goTo: { type: 'end' } }],
        }),
      ),
    );
    expect(start).toMatchObject({
      skills: [
        { name: 'review' },
        { name: 'wow-verdict', reason: 'a rule of this step reads the verdict' },
      ],
    });
  });

  it('attaches wow-artifacts and wow-pull-request in place of the handover and unit sentences', () => {
    const { start } = firstStart(
      workflow(step('ship', { expectedArtifacts: ['docs/a.md', 'docs/b.md'] })),
      context(),
      true,
    );
    const prompt = start?.type === 'startStep' ? start.prompt : '';
    expect(prompt).toBe(
      [
        '/ship',
        '',
        '<skill name="wow-artifacts">',
        'Write the artifacts.',
        '',
        '- docs/a.md',
        '- docs/b.md',
        '</skill>',
        '',
        '<skill name="wow-pull-request">',
        'Put the line in.',
        '',
        'Intent-Unit: demo/U2',
        '</skill>',
        '',
        'This run delivers one unit of a plan.',
        '',
        'Intent: demo',
        'Unit: U2 Count down',
      ].join('\n'),
    );
  });

  it('attaches nothing with the setting off and keeps the sentences', () => {
    const { start } = firstStart(
      workflow(step('ship', { expectedArtifacts: ['docs/a.md'] })),
      context({ attachBuiltInSkills: false }),
      true,
    );
    const prompt = start?.type === 'startStep' ? start.prompt : '';
    expect(prompt).not.toContain('<skill');
    expect(prompt).toContain('This step is expected to produce:\n- docs/a.md');
    expect(prompt).toContain('put this line in its body: Intent-Unit: demo/U2');
  });

  it('leaves out a skill the step leaves out, and one switched off', () => {
    const { start } = firstStart(
      workflow(
        step('ship', {
          expectedArtifacts: ['docs/a.md'],
          gateAfter: true,
          gateAfterCondition: ['verdict'],
          leaveOut: ['wow-artifacts'],
        }),
      ),
      context({ skillFor: skillFor(['wow-verdict']) }),
    );
    expect(start).toMatchObject({ skills: [{ name: 'ship' }] });
    expect(start?.type === 'startStep' && start.prompt).toContain(
      'This step is expected to produce:\n- docs/a.md',
    );
  });

  it('attaches a built-in skill once when the step already follows it', () => {
    const { start } = firstStart(
      workflow(
        step('ship', {
          expectedArtifacts: ['docs/a.md'],
          alsoFollow: [{ name: 'wow-artifacts', source: 'wow' }],
        }),
      ),
    );
    expect(start).toMatchObject({ skills: [{ name: 'ship' }, { name: 'wow-artifacts' }] });
    expect(start?.type === 'startStep' && start.skills?.[1]?.reason).toBeUndefined();
  });
});

describe('a run stored before wow skills (spec 13)', () => {
  it('continues with the prompts it had', () => {
    const definition = workflow(
      step('plan', { gateAfter: true }),
      step('ship', { expectedArtifacts: ['docs/a.md'] }),
    );
    const started = startRun(definition, { runId: 'r1', projectId: 'p1', unit }, context());
    expect(started.run.wowSkills).toBe(true);
    const old: WorkflowRun = { ...started.run };
    delete old.wowSkills;
    const waiting = advance(
      definition,
      old,
      { type: 'stepCompleted', stepId: 'plan', finalMessage: 'Planned', artifactsFound: [] },
      context(),
    );
    const next = advance(definition, waiting.run, { type: 'continue' }, context());
    const start = next.effects.find((effect) => effect.type === 'startStep');
    expect(start).toEqual({
      type: 'startStep',
      runId: 'r1',
      stepId: 'ship',
      threadId: 'r1.ship',
      prompt: [
        '/ship',
        '',
        'This run delivers one unit of a plan.',
        '',
        'Intent: demo',
        'Unit: U2 Count down',
        '',
        'When you open a pull request for it, put this line in its body: Intent-Unit: demo/U2',
        '',
        'The previous step (plan) ended with:',
        '',
        'Planned',
        '',
        'This step is expected to produce:',
        '- docs/a.md',
      ].join('\n'),
    });
  });

  it('loads a workflow without alsoFollow', () => {
    const parsed = WorkflowSchema.parse(workflow(step('ship')));
    expect(parsed.steps[0]?.alsoFollow).toBeUndefined();
  });
});

describe('a skill that is gone (spec 15)', () => {
  it('fails the step before it starts, with the skill name, and follows no rule', () => {
    const { run, effects } = startRun(
      workflow(
        step('tidy-up', {
          alsoFollow: [{ name: 'tidy', source: 'yours' }],
          rules: [{ when: { fact: 'stepFailed' }, goTo: { type: 'end' } }],
        }),
      ),
      { runId: 'r1', projectId: 'p1' },
      context({ skillFor: skillFor(['tidy']) }),
    );
    expect(run.state).toBe('failed');
    expect(run.steps[0]).toMatchObject({
      state: 'failed',
      error:
        'The skill tidy no longer exists, so the step cannot start. Pick another skill for it, or make the skill again.',
    });
    expect(run.steps[0]?.threadId).toBeUndefined();
    expect(effects).toEqual([{ type: 'notify', runId: 'r1', stepId: 'tidy-up', reason: 'failed' }]);
  });
});
