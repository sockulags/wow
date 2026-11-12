import {
  Diagnosis,
  ModelGuidance,
  ModelsRead,
  defaultAssistantInstructions,
  defaultModelGuidance,
  type AssistantChange,
  type ProviderModel,
  type ServerCommand,
  type SetupApplication,
  type Thread,
  type Workflow,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';

// Models for the assistant, guidance, and steps that need a model (questions and models plan
// U2): each acceptance line has a case here that names its spec behavior. The providers are
// mocks; their models are invented.

const claudeModels: ProviderModel[] = [
  { id: 'big-claude', label: 'Big', description: 'Invented', efforts: ['low', 'high'] },
  { id: 'small-claude', label: 'Small', description: 'Invented', efforts: ['low'] },
];
const codexModels: ProviderModel[] = [
  { id: 'codex-max', label: 'Max', description: 'Invented', efforts: ['low', 'medium', 'high'] },
  { id: 'codex-mini', label: 'Mini', description: 'Invented', efforts: ['low'] },
];

let root: string;
let server: RunningServer;
let ids = 0;
const now = '2026-11-11T08:00:00.000Z';

const dispatch = (command: ServerCommand) => server.engine.dispatch(`m${++ids}`, command);

function refusal(send: () => unknown): string | undefined {
  try {
    send();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return undefined;
}

const workflow = (id: string) =>
  (snapshot(server.database.db, { topic: 'workflows' }) as Workflow[]).find((row) => row.id === id);

const firstThread = (runId: string) =>
  (snapshot(server.database.db, { topic: 'threads' }) as Thread[]).find(
    (thread) => thread.runId === runId,
  );

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await server.assistant.tools.call(name, args);
  return { isError: result.isError, content: JSON.parse(result.text) as Record<string, unknown> };
}

const step = (id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'codex-work',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
  ...extra,
});

const instance = (
  id: string,
  kind: 'claude' | 'codex',
  name: string,
  defaults: { defaultModel?: string; defaultEffort?: string } = {},
): ServerCommand => ({
  type: 'providerInstance.create',
  providerInstanceId: id,
  kind,
  name,
  binaryPath: kind,
  configDir: '',
  env: {},
  launchArgs: [],
  ...defaults,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-models-'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
    hooks: {
      providers: {
        claude: () =>
          new MockProviderAdapter(
            'claude',
            () => [],
            undefined,
            () => claudeModels,
          ),
        codex: (row) =>
          new MockProviderAdapter(
            'codex',
            () => [],
            row.id === 'codex-home'
              ? () => ({ ok: false, account: null, version: null, message: 'Not signed in' })
              : undefined,
            () => codexModels,
          ),
      },
    },
  });
  dispatch(instance('claude-work', 'claude', 'Claude at work', { defaultModel: 'big-claude' }));
  dispatch(
    instance('codex-work', 'codex', 'Codex at work', {
      defaultModel: 'codex-max',
      defaultEffort: 'medium',
    }),
  );
  dispatch(instance('codex-bare', 'codex', 'Codex bare'));
  dispatch(instance('codex-home', 'codex', 'Codex at home'));
  for (const id of ['claude-work', 'codex-work', 'codex-bare', 'codex-home']) {
    await server.providerService.test(id);
  }
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('read_models (spec 13)', () => {
  it("lists each connected instance's models, efforts, defaults and whether a model is required, and one that is not connected as such", async () => {
    const { isError, content } = await call('read_models');
    expect(isError).toBe(false);
    const read = ModelsRead.parse(content);
    const byId = new Map(read.instances.map((entry) => [entry.providerInstanceId, entry]));
    expect(byId.get('claude-work')).toMatchObject({
      kind: 'claude',
      connected: true,
      requiresModel: false,
      defaultModel: 'big-claude',
      models: [
        { id: 'big-claude', efforts: ['default', 'low', 'high'], isDefault: true },
        { id: 'small-claude', efforts: ['default', 'low'], isDefault: false },
      ],
    });
    expect(byId.get('codex-work')).toMatchObject({
      kind: 'codex',
      connected: true,
      requiresModel: true,
      defaultModel: 'codex-max',
      defaultEffort: 'medium',
      models: [
        { id: 'codex-max', efforts: ['low', 'medium', 'high'], isDefault: true },
        { id: 'codex-mini', efforts: ['low'], isDefault: false },
      ],
    });
    expect(byId.get('codex-home')).toEqual({
      providerInstanceId: 'codex-home',
      name: 'Codex at home',
      kind: 'codex',
      connected: false,
      reason: 'Its last test failed (Not signed in). Test it in Settings → Providers.',
      requiresModel: true,
      defaultModel: null,
      defaultEffort: null,
      models: [],
    });
    const one = ModelsRead.parse(
      (await call('read_models', { providerInstanceId: 'codex-bare' })).content,
    );
    expect(one.instances.map((entry) => entry.providerInstanceId)).toEqual(['codex-bare']);
  });
});

describe('read_model_guidance (spec 14)', () => {
  it('returns the shipped guidance, and an edited text is what the assistant reads next', async () => {
    const shipped = ModelGuidance.parse((await call('read_model_guidance')).content);
    expect(shipped).toMatchObject({ text: defaultModelGuidance, edited: false });
    for (const work of ['Planning and specification', 'Building', 'Reviewing', 'Mechanical']) {
      expect(shipped.text).toContain(work);
    }
    expect(shipped.text).toContain('Claude Code');
    expect(shipped.text).toContain('Codex');

    const edited = 'Use codex-mini for everything; it is cheap.';
    dispatch({
      type: 'setting.set',
      key: 'assistant.modelGuidance',
      scope: 'global',
      value: edited,
    });
    expect(ModelGuidance.parse((await call('read_model_guidance')).content)).toMatchObject({
      text: edited,
      edited: true,
    });
  });
});

describe('the workflows the assistant writes (spec 15, 16)', () => {
  it('stores each step with an instance, a model and an effort it offers, and the change row shows them', async () => {
    const { isError, content } = await call('create_workflow', {
      name: 'Review loop',
      steps: [
        step('plan-work', { model: 'codex-max', effort: 'high' }),
        step('deliver-work', {
          providerInstanceId: 'claude-work',
          model: 'small-claude',
          effort: 'default',
        }),
      ],
    });
    expect(isError).toBe(false);
    const id = String(content['workflowId']);
    expect(
      workflow(id)?.steps.map(({ providerInstanceId, model, effort }) => ({
        providerInstanceId,
        model,
        effort,
      })),
    ).toEqual([
      { providerInstanceId: 'codex-work', model: 'codex-max', effort: 'high' },
      { providerInstanceId: 'claude-work', model: 'small-claude', effort: 'default' },
    ]);
    const change = content['change'] as Pick<AssistantChange, 'to'>;
    expect(change.to).toContain('plan-work (Codex at work, Max, high)');
    expect(change.to).toContain('deliver-work (Claude at work, Small, default)');
  });

  it('refuses a model or an effort the instance does not offer, with what it offers', async () => {
    const refused = await call('create_workflow', {
      name: 'Review loop',
      steps: [step('plan-work', { model: 'codex-ultra', effort: 'high' })],
    });
    expect(refused).toEqual({
      isError: true,
      content: {
        outcome: 'refused',
        reason:
          'Codex at work does not offer the model codex-ultra (Step 1 (plan-work)). It offers: codex-max, codex-mini.',
      },
    });
    const effort = await call('create_workflow', {
      name: 'Review loop',
      steps: [step('plan-work', { model: 'codex-mini', effort: 'high' })],
    });
    expect(effort.content['reason']).toBe(
      'codex-mini on Codex at work does not take the effort high (Step 1 (plan-work)). It takes: low.',
    );
    const unnamed = await call('create_workflow', {
      name: 'Review loop',
      steps: [step('plan-work', { providerInstanceId: 'claude-work' })],
    });
    expect(unnamed.content['reason']).toBe(
      'Step 1 (plan-work) names no model. Claude at work offers: big-claude, small-claude.',
    );
    dispatch({ type: 'workflow.create', workflowId: 'loop', name: 'Loop', steps: [step('a')] });
    const update = await call('update_workflow', {
      workflowId: 'loop',
      steps: [step('a', { model: 'codex-ultra', effort: 'low' })],
    });
    expect(update.content['reason']).toContain('It offers: codex-max, codex-mini.');
    expect(workflow('loop')?.steps[0]?.model).toBe('codex-max');
    expect(
      (snapshot(server.database.db, { topic: 'workflows' }) as Workflow[]).map((row) => row.id),
    ).toEqual(['loop']);
  });

  it('refuses a step on an instance whose models cannot be read', async () => {
    const result = await call('create_workflow', {
      name: 'Review loop',
      steps: [step('plan-work', { providerInstanceId: 'nowhere', model: 'x', effort: 'low' })],
    });
    expect(result.content['reason']).toBe(
      'Step 1 (plan-work) names provider instance nowhere, which does not exist. read_models lists the instances.',
    );
  });

  it('refuses a step on an instance read_models reports as not connected, with the same reason (spec 16)', async () => {
    const read = ModelsRead.parse(
      (await call('read_models', { providerInstanceId: 'codex-home' })).content,
    );
    const reason = read.instances[0]?.reason;
    expect(reason).toContain('Not signed in');
    const result = await call('create_workflow', {
      name: 'Review loop',
      steps: [
        step('plan-work', { providerInstanceId: 'codex-home', model: 'codex-max', effort: 'low' }),
      ],
    });
    expect(result).toEqual({
      isError: true,
      content: {
        outcome: 'refused',
        reason: `Codex at home is not connected, so wow cannot check Step 1 (plan-work): ${reason}`,
      },
    });
  });

  it('has an instruction text that names the tools, says to give the reason and when to ask', () => {
    expect(defaultAssistantInstructions).toContain('read_models');
    expect(defaultAssistantInstructions).toContain('read_model_guidance');
    expect(defaultAssistantInstructions).toContain('what you recommend for each step and why');
    expect(defaultAssistantInstructions).toContain(
      'such as cost against quality, ask with ask_questions',
    );
  });
});

describe('a step on a provider that requires a model (spec 17)', () => {
  it('takes the instance default when the step names no model', () => {
    dispatch({ type: 'workflow.create', workflowId: 'loop', name: 'Loop', steps: [step('a')] });
    expect(workflow('loop')?.steps[0]).toMatchObject({ model: 'codex-max' });
    dispatch({
      type: 'workflow.update',
      workflowId: 'loop',
      steps: [step('a', { model: 'codex-mini' }), step('b')],
    });
    expect(workflow('loop')?.steps.map((entry) => entry.model)).toEqual([
      'codex-mini',
      'codex-max',
    ]);
  });

  it('refuses workflow.create and workflow.update naming the step and the provider without a default', () => {
    const sentence =
      'Step check-work runs on Codex (Codex bare), which needs a model on every step, and Codex bare has no default model: choose a model for the step.';
    expect(
      refusal(() =>
        dispatch({
          type: 'workflow.create',
          workflowId: 'loop',
          name: 'Loop',
          steps: [step('check-work', { providerInstanceId: 'codex-bare' })],
        }),
      ),
    ).toBe(sentence);
    expect(workflow('loop')).toBeUndefined();
    dispatch({
      type: 'workflow.create',
      workflowId: 'loop',
      name: 'Loop',
      steps: [step('check-work', { providerInstanceId: 'codex-bare', model: 'codex-mini' })],
    });
    expect(
      refusal(() =>
        dispatch({
          type: 'workflow.update',
          workflowId: 'loop',
          steps: [step('check-work', { providerInstanceId: 'codex-bare' })],
        }),
      ),
    ).toBe(sentence);
    expect(workflow('loop')?.steps[0]?.model).toBe('codex-mini');
  });

  it('saves a step on Claude Code without a model as before', () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'loop',
      name: 'Loop',
      steps: [step('a', { providerInstanceId: 'claude-work' })],
    });
    expect(workflow('loop')?.steps[0]).not.toHaveProperty('model');
  });
});

describe('a workflow stored before the rule (spec 19, 20)', () => {
  const old: Workflow = {
    id: 'old',
    name: 'Old review',
    templateKind: null,
    steps: [step('check-work', { providerInstanceId: 'codex-bare' })],
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
  };

  it('loads and runs as before, and the diagnosis names the step', async () => {
    dispatch({ type: 'workflow.restore', workflow: old });
    expect(workflow('old')?.steps[0]).not.toHaveProperty('model');
    dispatch({ type: 'workflow.update', workflowId: 'old', name: 'Older review' });
    expect(workflow('old')?.name).toBe('Older review');
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'old', projectId: 'tea' });
    expect(snapshot(server.database.db, { topic: 'workflowRuns' })).toMatchObject([
      { id: 'r1', workflowId: 'old' },
    ]);
    // Its first step's thread starts as before: with no model, which the runner fails, when
    // neither the instance nor the project has a default.
    expect(firstThread('r1')).toMatchObject({ stepId: 'check-work', model: '' });

    const result = await server.assistant.tools.call('diagnose_setup', {});
    const { problems } = Diagnosis.parse(JSON.parse(result.text));
    expect(problems.filter((problem) => problem.kind === 'model')).toEqual([
      {
        kind: 'model',
        what: 'Workflow Older review, step check-work',
        reason:
          'Step check-work has no model, which Codex needs; choose one in the workflow, or the step fails when it starts.',
        place: { label: 'Workflows → Older review', path: '/workflows/old' },
      },
    ]);
  });

  it("starts a run's step stored without a model on its instance's default (spec 19)", () => {
    dispatch({
      type: 'workflow.restore',
      workflow: {
        ...old,
        id: 'old-default',
        steps: [step('check-work', { providerInstanceId: 'codex-work' })],
      },
    });
    dispatch({
      type: 'workflowRun.start',
      runId: 'r2',
      workflowId: 'old-default',
      projectId: 'tea',
    });
    expect(firstThread('r2')).toMatchObject({
      stepId: 'check-work',
      providerInstanceId: 'codex-work',
      model: 'codex-max',
      effort: 'medium',
    });
  });

  it('is put back without a model by an undo, though its instance has a default (spec 19)', async () => {
    dispatch({
      type: 'workflow.restore',
      workflow: { ...old, steps: [step('check-work', { providerInstanceId: 'codex-work' })] },
    });
    const { isError, content } = await call('update_workflow', {
      workflowId: 'old',
      steps: [step('check-work', { model: 'codex-mini', effort: 'low' })],
    });
    expect(isError).toBe(false);
    expect(workflow('old')?.steps[0]?.model).toBe('codex-mini');
    const change = content['change'] as Pick<AssistantChange, 'id'>;
    dispatch({ type: 'assistant.undo', changeId: change.id });
    expect(workflow('old')?.steps[0]).not.toHaveProperty('model');
  });

  it('applies a setup file with such a step, marked', () => {
    // The first Codex instance here has no default model.
    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'codex-work' });
    dispatch({ type: 'providerInstance.delete', providerInstanceId: 'codex-home' });
    const text = [
      'version: 1',
      'workflows:',
      '  - id: second',
      '    name: Second opinion',
      '    steps:',
      '      - id: a',
      '        skillName: check-work',
      '        provider: codex',
      '        gateBefore: false',
      '        gateAfter: true',
      '        expectedArtifacts: []',
      '',
    ].join('\n');
    dispatch({ type: 'setup.apply', applicationId: 'setup-1', name: 'team.yaml', text });
    expect(workflow('second')?.steps[0]).toMatchObject({ providerInstanceId: 'codex-bare' });
    expect(workflow('second')?.steps[0]).not.toHaveProperty('model');
    const [application] = snapshot(server.database.db, {
      topic: 'setupApplications',
    }) as SetupApplication[];
    expect(application?.marked).toEqual([
      // As for a missing skill, which this invented one also is.
      { workflow: 'Second opinion', reason: 'skill not installed: check-work' },
      {
        workflow: 'Second opinion',
        reason:
          'step check-work has no model, which Codex needs; choose one in the workflow, or the step fails when it starts',
      },
    ]);
  });
});
