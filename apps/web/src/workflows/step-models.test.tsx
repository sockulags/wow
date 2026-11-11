import type { Command, ProviderInstance, ProviderModel, Skill, Workflow } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';

// A step's models in the workflow builder (questions and models spec 17 to 19), against a fake
// server whose providers list invented models.

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<() => void>(),
  mermaidAPI: { getDiagramFromText: vi.fn<() => Promise<{ db: object }>>() },
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const T = '2026-11-11T08:00:00.000Z';

const codexModels: ProviderModel[] = [
  { id: 'codex-max', label: 'Max', description: '', efforts: ['low', 'medium', 'high'] },
  { id: 'codex-mini', label: 'Mini', description: '', efforts: ['low'] },
];

const codex = (
  id: string,
  name: string,
  defaults: Partial<ProviderInstance>,
): ProviderInstance => ({
  id,
  kind: 'codex',
  name,
  binaryPath: 'codex',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: 'auto',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
  ...defaults,
});

const instances = [
  codex('codex-work', 'Codex at work', { defaultModel: 'codex-max', defaultEffort: 'medium' }),
  codex('codex-bare', 'Codex bare', {}),
];

const skills: Skill[] = ['plan-work', 'check-work'].map((name) => ({
  id: name,
  name,
  description: '',
  dir: `/skills/${name}`,
  source: 'custom',
  manualOnly: false,
  invocations: { claude: `/${name}`, codex: `$${name}` },
}));

const workflowOf = (steps: Workflow['steps']): Workflow => ({
  id: 'w',
  name: 'Review',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps,
});

const step = (
  id: string,
  providerInstanceId: string,
  more: Partial<Workflow['steps'][number]> = {},
) => ({
  id,
  skillName: id,
  providerInstanceId,
  effort: 'low',
  permissionMode: 'auto',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...more,
});

function fake(workflow: Workflow): Runtime & { sent: Command[] } {
  const sent: Command[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflows: [workflow],
    providerInstances: instances,
    skills,
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'provider.listModels') return Promise.resolve(codexModels);
      if (method !== 'dispatch') return Promise.resolve([]);
      const { command, commandId } = params as { command: Command; commandId: string };
      sent.push(command);
      return Promise.resolve({ commandId, seqs: [sent.length], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    sent,
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue({ db: {} });
  mermaid.render.mockImplementation((id) => Promise.resolve({ svg: `<svg id="${id}"></svg>` }));
});

async function open(workflow: Workflow) {
  const runtime = fake(workflow);
  await renderApp('/workflows/w', runtime);
  const user = userEvent.setup();
  const builder = within(await screen.findByRole('form', { name: 'Workflow builder' }));
  const stepItem = (number: number) =>
    within(builder.getByRole('listitem', { name: `Step ${number}` }));
  const expand = (number: number) =>
    user.click(builder.getByRole('button', { name: `Expand step ${number}` }));
  const options = async (number: number, label: string) => {
    await user.click(stepItem(number).getByRole('combobox', { name: label }));
    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);
    await user.keyboard('{Escape}');
    return names;
  };
  const save = () => user.click(builder.getByRole('button', { name: 'Save' }));
  return { runtime, builder, stepItem, expand, options, save };
}

describe("a step's models in the builder", () => {
  it("lists the instance's models and efforts with its default marked (spec 18)", async () => {
    const { stepItem, expand, options } = await open(
      workflowOf([step('plan-work', 'codex-work', { model: 'codex-max', effort: 'medium' })]),
    );
    await expand(1);
    const model = stepItem(1).getByRole('combobox', { name: 'Model' });
    expect(await within(model).findByText('Max (default)')).toBeTruthy();
    expect(await options(1, 'Model')).toEqual(['Max (default)', 'Mini']);
    expect(await options(1, 'Effort')).toEqual(['Low', 'Medium (default)', 'High']);
  });

  it('shows the refusal in words beside a step on Codex without a model or a default, and saves nothing (spec 17, 18)', async () => {
    const { runtime, stepItem, save } = await open(workflowOf([step('check-work', 'codex-bare')]));
    const sentence =
      'Step check-work runs on Codex (Codex bare), which needs a model on every step, and Codex bare has no default model: choose a model for the step.';
    expect(await stepItem(1).findByText(sentence)).toBeTruthy();
    await save();
    expect(runtime.sent).toEqual([]);
  });

  it('marks a step stored without a model and saves it with the default the builder shows (spec 17, 19)', async () => {
    const { runtime, stepItem, save } = await open(workflowOf([step('check-work', 'codex-work')]));
    expect(
      await stepItem(1).findByText(
        'Step 1 was saved without a model, which Codex needs; Save stores codex-max.',
      ),
    ).toBeTruthy();
    await save();
    const [command] = runtime.sent;
    expect(command?.type === 'workflow.update' ? command.steps?.[0]?.model : undefined).toBe(
      'codex-max',
    );
  });
});
