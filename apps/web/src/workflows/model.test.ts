import {
  defaultWorkflowTemplates,
  type ProviderInstance,
  type Skill,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { workflowCommands } from './commands';
import {
  applyStepChanges,
  artifactPath,
  artifactUrl,
  blocking,
  draftFromTemplate,
  draftOf,
  gateMessage,
  gateOf,
  gateRunForThread,
  moveStep,
  reviewedStep,
  saveAsTemplate,
  setGate,
  stepDisplayState,
  stepDurationMs,
  waitsAt,
  newStep,
  sameJson,
  sortRuns,
  stepDefaults,
  stepsOf,
  validateDraft,
} from './model';

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: 'claude',
  configDir: '/home/me/.claude',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const skill = (name: string, plugin?: string): Skill => ({
  id: `/skills/${name}`,
  name,
  description: `${name} skill`,
  dir: `/skills/${name}`,
  source: 'user-claude',
  manualOnly: false,
  invocations: {
    claude: plugin ? `/${plugin}:${name}` : `/${name}`,
    codex: `$${name}`,
  },
});

const feature = defaultWorkflowTemplates.find((template) => template.kind === 'feature');
if (!feature) throw new Error('the default templates lost Feature');

const ready = { model: 'mock-model', effort: 'high', permissionMode: 'default' };

describe('workflow drafts', () => {
  it('builds the Feature template with its gates and artifacts (behavior 25)', () => {
    const draft = draftFromTemplate(feature, instance.id, '');
    expect(draft.name).toBe('Feature');
    expect(draft.templateKind).toBe('feature');
    expect(draft.steps.map((step) => [step.skillName, step.gateBefore, step.gateAfter])).toEqual([
      ['capture-intent', false, true],
      ['plan-work', false, true],
      ['deliver-work', false, false],
      ['check-work', false, false],
    ]);
    expect(draft.steps.every((step) => step.providerInstanceId === instance.id)).toBe(true);
    expect(new Set(draft.steps.map((step) => step.id)).size).toBe(4);
    expect(stepsOf(draft)[0]?.expectedArtifacts).toEqual([
      'intents/*/intent.md',
      'intents/*/spec.md',
    ]);
  });

  it('keeps a typed name when a template is applied', () => {
    expect(draftFromTemplate(feature, instance.id, 'Billing').name).toBe('Billing');
  });

  it('turns typed globs and prompts into a step and back', () => {
    const step = {
      ...newStep(instance.id, 'deliver-work'),
      ...ready,
      extraPrompt: '  ',
      artifactsText: ' docs/*.md \n\nREADME.md\n',
    };
    const [saved] = stepsOf({ name: 'x', templateKind: null, steps: [step] });
    expect(saved).not.toHaveProperty('extraPrompt');
    expect(saved?.expectedArtifacts).toEqual(['docs/*.md', 'README.md']);
    const workflow: Workflow = {
      id: 'w',
      name: 'x',
      templateKind: null,
      steps: [saved!],
      createdAt: '2026-11-02T08:00:00.000Z',
      updatedAt: '2026-11-02T08:00:00.000Z',
    };
    expect(sameJson(stepsOf(draftOf(workflow)), workflow.steps)).toBe(true);
  });

  it('moves steps for drag and the move buttons', () => {
    expect(moveStep(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveStep(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveStep(['a', 'b', 'c'], 1, 5)).toEqual(['a', 'b', 'c']);
  });

  it('drops model, effort and permission mode when the provider instance changes', () => {
    const step = { ...newStep(instance.id, 'deliver-work'), ...ready };
    expect(applyStepChanges(step, { effort: 'low' })).toMatchObject({ ...ready, effort: 'low' });
    const moved = applyStepChanges(step, { providerInstanceId: 'codex' });
    expect(moved.providerInstanceId).toBe('codex');
    expect(moved).not.toHaveProperty('model');
    expect(moved).not.toHaveProperty('effort');
    expect(moved).not.toHaveProperty('permissionMode');
  });

  it('fills step defaults from the instance, then the listed models', () => {
    const models = [{ id: 'm1', label: 'M1', description: '', efforts: ['low', 'high'] }];
    expect(stepDefaults(instance, models)).toEqual({
      model: 'm1',
      effort: 'default',
      permissionMode: 'default',
    });
    expect(
      stepDefaults({ ...instance, defaultModel: 'opus', defaultEffort: 'high' }, models),
    ).toMatchObject({ model: 'opus', effort: 'high' });
  });
});

describe('validateDraft (behavior 24)', () => {
  const skills = [skill('deliver-work'), skill('plan-work', 'agent-os-dev')];

  it('asks for a name, steps, a skill, an instance, a model, an effort and a permission mode', () => {
    expect(validateDraft({ name: ' ', templateKind: null, steps: [] }, [instance], skills)).toEqual(
      [{ message: 'Give the workflow a name.' }, { message: 'Add at least one step.' }],
    );
    const step = newStep('gone');
    const messages = validateDraft({ name: 'x', templateKind: null, steps: [step] }, [], skills)
      .filter((problem) => problem.stepId === step.id)
      .map((problem) => problem.message);
    expect(messages).toEqual([
      'Step 1 needs a skill.',
      'Step 1 needs a provider instance.',
      'Step 1 needs a model.',
      'Step 1 needs an effort.',
      'Step 1 needs a permission mode.',
    ]);
  });

  it('accepts installed and plugin skills and only warns about unknown ones', () => {
    const draft = {
      name: 'x',
      templateKind: null,
      steps: [
        { ...newStep(instance.id, 'deliver-work'), ...ready },
        { ...newStep(instance.id, 'agent-os-dev:plan-work'), ...ready },
        { ...newStep(instance.id, 'shape-work'), ...ready },
      ],
    };
    const problems = validateDraft(draft, [instance], skills);
    expect(blocking(problems)).toEqual([]);
    expect(problems).toEqual([
      expect.objectContaining({ warning: true, message: expect.stringContaining('shape-work') }),
    ]);
  });
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: 0,
  steps: [
    {
      stepId: 's1',
      state: 'waiting',
      threadId: 'run-1.s1',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      artifactsFound: [],
    },
    { stepId: 's2', state: 'not_started', artifactsFound: [] },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
  ...overrides,
});

const workflow: Workflow = {
  id: 'w',
  name: 'Feature',
  templateKind: 'feature',
  steps: [
    {
      id: 's1',
      skillName: 'capture-intent',
      providerInstanceId: instance.id,
      gateBefore: false,
      gateAfter: true,
      expectedArtifacts: [],
    },
    {
      id: 's2',
      skillName: 'plan-work',
      providerInstanceId: instance.id,
      gateBefore: true,
      gateAfter: false,
      expectedArtifacts: [],
    },
  ],
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

describe('run view helpers', () => {
  it('reads the gate the run waits at', () => {
    const after = gateOf(run());
    expect(after).toEqual({ stepIndex: 0, position: 'after' });
    expect(gateMessage(after!, workflow)).toBe(
      'capture-intent finished. Continue starts plan-work.',
    );
    const before = run({
      currentStep: 1,
      steps: [
        { stepId: 's1', state: 'done', artifactsFound: [] },
        { stepId: 's2', state: 'waiting', artifactsFound: [] },
      ],
    });
    expect(gateOf(before)).toEqual({ stepIndex: 1, position: 'before' });
    expect(gateMessage(gateOf(before)!, workflow)).toBe('Waiting for you before plan-work starts.');
    expect(gateOf(run({ state: 'running' }))).toBeUndefined();
  });

  it('sorts live runs first, then the newest', () => {
    const done = run({ id: 'a', state: 'done', startedAt: '2026-11-02T09:00:00.000Z' });
    const old = run({ id: 'b', state: 'done', startedAt: '2026-11-01T09:00:00.000Z' });
    const live = run({ id: 'c', state: 'running', startedAt: '2026-10-01T09:00:00.000Z' });
    expect(sortRuns([old, done, live]).map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('links artifacts inside the project folder on Windows and POSIX', () => {
    expect(artifactUrl('C:\\work\\demo', 'intents/my app/spec.md')).toBe(
      'file:///C:/work/demo/intents/my%20app/spec.md',
    );
    expect(artifactUrl('/home/me/demo/', 'intents/x/spec.md')).toBe(
      'file:///home/me/demo/intents/x/spec.md',
    );
    expect(artifactPath('C:\\work\\demo', 'intents/x/spec.md')).toBe(
      'C:\\work\\demo\\intents\\x\\spec.md',
    );
    expect(artifactPath('/home/me/demo', 'intents/x/spec.md')).toBe(
      '/home/me/demo/intents/x/spec.md',
    );
  });
});

const titles = (open?: WorkflowRun) =>
  workflowCommands({
    workflows: [workflow],
    runs: [run()],
    templates: defaultWorkflowTemplates,
    openRun: open,
  }).map((command) => command.title);

describe('workflowCommands', () => {
  it('offers new workflows, templates, every workflow and run', () => {
    expect(titles()).toEqual([
      'New workflow',
      'Refresh skills',
      'New workflow from template: Bug',
      'New workflow from template: Feature',
      'New workflow from template: Initiative',
      'Feature',
      'Feature',
    ]);
  });

  it('says what each workflow and run is, and puts a waiting run under Needs you', () => {
    const commands = workflowCommands({
      workflows: [workflow],
      runs: [run()],
      templates: defaultWorkflowTemplates,
      openRun: undefined,
      formatWhen: () => '14:39',
    });
    const runCommand = commands.find((command) => command.id.startsWith('workflowRun.'));
    expect(runCommand).toMatchObject({
      detail: 'Run · Waiting for you · 14:39',
      needsYou: true,
    });
    expect(commands.find((command) => command.id === `workflow.${workflow.id}`)).toMatchObject({
      detail: 'Workflow',
      searchOnly: true,
    });
  });

  it('offers Continue and Stop for the open run at a gate, and only Stop while it runs', () => {
    expect(titles(run())).toContain('Continue run');
    expect(titles(run())).toContain('Stop run');
    const running = run({ state: 'running' });
    expect(titles(running)).not.toContain('Continue run');
    expect(titles(running)).toContain('Stop run');
    expect(titles(run({ state: 'done' }))).not.toContain('Stop run');
  });
});

describe('gates in the builder and the thread', () => {
  it('reads and toggles the gate at each position of the chain', () => {
    const draft = draftFromTemplate(feature, instance.id, '');
    // Feature waits after capture-intent and after plan-work.
    expect([0, 1, 2, 3, 4].map((position) => waitsAt(draft, position))).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const before = setGate(draft, 0);
    expect(before.steps[0]?.gateBefore).toBe(true);
    const off = setGate(draft, 1);
    expect(waitsAt(off, 1)).toBe(false);
    expect(off.steps[0]?.gateAfter).toBe(false);
    // A gate stored as "before the next step" is cleared by the same toggle.
    const stored = {
      steps: draft.steps.map((step, index) => (index === 3 ? { ...step, gateBefore: true } : step)),
    };
    expect(waitsAt(stored, 3)).toBe(true);
    expect(waitsAt(setGate(stored, 3), 3)).toBe(false);
    expect(setGate(draft, 4).steps[3]?.gateAfter).toBe(true);
  });

  it('finds the thread whose step a waiting run asks to review (spec 9)', () => {
    const waiting = run();
    expect(reviewedStep(waiting)?.stepId).toBe('s1');
    expect(gateRunForThread({ id: 'run-1.s1', runId: 'run-1' }, [waiting])).toBe(waiting);
    expect(gateRunForThread({ id: 'run-1.s2', runId: 'run-1' }, [waiting])).toBeUndefined();
    expect(gateRunForThread({ id: 'other', runId: null }, [waiting])).toBeUndefined();
    expect(gateRunForThread({ id: 'run-1.s1', runId: 'run-1' }, [run({ state: 'running' })])).toBe(
      undefined,
    );
  });

  it('shows a finished step at its gate as done, with its duration', () => {
    const [first, second] = run().steps;
    if (!first || !second) throw new Error('two steps');
    expect(stepDisplayState(first)).toBe('done');
    expect(stepDisplayState(second)).toBe('not_started');
    expect(stepDurationMs(first)).toBe(5 * 60_000);
    expect(stepDurationMs(second)).toBeUndefined();
  });
});

describe('templates from the builder (E-05)', () => {
  it('saves the steps as a new template, or replaces the one with that name', () => {
    const draft = draftFromTemplate(feature, instance.id, '');
    const added = saveAsTemplate(defaultWorkflowTemplates, draft, 'My feature');
    if (typeof added === 'string') throw new Error(added);
    expect(added.kind).toBe('my-feature');
    expect(added.templates.at(-1)).toMatchObject({
      kind: 'my-feature',
      name: 'My feature',
      steps: [
        { skillName: 'capture-intent', gateAfter: true },
        { skillName: 'plan-work', gateAfter: true },
        { skillName: 'deliver-work' },
        { skillName: 'check-work' },
      ],
    });
    const replaced = saveAsTemplate(added.templates, { steps: draft.steps.slice(0, 1) }, 'feature');
    if (typeof replaced === 'string') throw new Error(replaced);
    expect(replaced.kind).toBe('feature');
    expect(replaced.templates.find((t) => t.kind === 'feature')?.steps).toHaveLength(1);
    expect(replaced.templates).toHaveLength(added.templates.length);
    expect(saveAsTemplate([], draft, '  ')).toBe('Give the template a name');
    expect(saveAsTemplate([], { steps: [] }, 'x')).toBe('Add a step with a skill first');
    const clash = saveAsTemplate([{ kind: 'x', name: 'Other', steps: feature.steps }], draft, 'X');
    expect(typeof clash === 'string' ? clash : clash.kind).toBe('x-2');
  });
});
