import type { Command, ProviderInstance, Skill, Workflow } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { workflowCommands } from './commands';
import { draftOf, stepsOf } from './model';
import { draftRuleProblems, factChoices, newRule, rulesStore } from './rules';

// The rules under "After this step" in the workflow builder and the diagram beside the steps
// (workflow branches spec 14 to 17), against a fake server. The data is invented.

// jsdom cannot lay a diagram out, so the library is replaced: the drawing is the source's
// lines as text, which is enough to see that the diagram follows the draft.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<() => void>(),
  mermaidAPI: { getDiagramFromText: vi.fn<() => Promise<{ db: object }>>() },
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const T = '2026-11-02T08:05:00.000Z';

const step = (id: string, skillName: string, more: Partial<Workflow['steps'][number]> = {}) => ({
  id,
  skillName,
  providerInstanceId: 'mock',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...more,
});

const plain: Workflow = {
  id: 'w',
  name: 'Deliver and check',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps: [
    step('plan', 'plan-work', { gateAfter: true, expectedArtifacts: ['intents/*/plan.md'] }),
    step('deliver', 'deliver-work'),
    step('check', 'check-work'),
  ],
};

const looped: Workflow = {
  ...plain,
  steps: [
    ...plain.steps.slice(0, 2),
    step('check', 'check-work', {
      rules: [
        { when: { fact: 'verdict', is: 'blocked' }, goTo: { type: 'end' } },
        {
          when: { fact: 'verdict', is: 'changesRequested' },
          goTo: { type: 'step', stepId: 'deliver' },
        },
      ],
    }),
  ],
};

const instance: ProviderInstance = {
  id: 'mock',
  kind: 'claude',
  name: 'Mock Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'mock-model',
  defaultEffort: 'default',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const skills: Skill[] = ['plan-work', 'deliver-work', 'check-work'].map((name) => ({
  id: name,
  name,
  description: '',
  dir: `/skills/${name}`,
  source: 'custom',
  manualOnly: false,
  invocations: { claude: `/${name}`, codex: `$${name}` },
}));

function fake(workflow: Workflow, refuse?: string): Runtime & { sent: Command[] } {
  const sent: Command[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflows: [workflow],
    providerInstances: [instance],
    skills,
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method !== 'dispatch') return Promise.resolve([]);
      if (refuse !== undefined) return Promise.reject(new Error(refuse));
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
  mermaid.render.mockImplementation((id, source) =>
    Promise.resolve({
      svg: `<svg id="${id}">${source
        .split('\n')
        .map((line) => `<text>${line.trim().replaceAll('<', '&lt;')}</text>`)
        .join('')}</svg>`,
    }),
  );
});

const drawnLines = async () => {
  const diagram = await within(await screen.findByRole('region', { name: 'Paths' })).findByRole(
    'img',
    { name: 'Diagram' },
  );
  return [...diagram.querySelectorAll('text')].map((text) => text.textContent);
};

async function open(workflow: Workflow, refuse?: string) {
  const runtime = fake(workflow, refuse);
  await renderApp('/workflows/w', runtime);
  const user = userEvent.setup();
  const builder = within(await screen.findByRole('form', { name: 'Workflow builder' }));
  const choose = async (label: string, option: string) => {
    await user.click(builder.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  const expand = (number: number) =>
    user.click(builder.getByRole('button', { name: `Expand step ${number}` }));
  const rules = (number: number) =>
    within(builder.getByRole('list', { name: `Step ${number} rules` }));
  const save = () => user.click(builder.getByRole('button', { name: 'Save' }));
  const savedSteps = () => {
    const [command] = runtime.sent;
    return command?.type === 'workflow.update' ? command.steps : undefined;
  };
  return { runtime, user, builder, choose, expand, rules, save, savedSteps };
}

const texts = (items: readonly HTMLElement[]) =>
  items.map((item) => item.getAttribute('aria-label') ?? item.textContent);

describe('the rules of a step in the builder', () => {
  it('adds a rule with fact, value and target, saves it, and keeps "Otherwise: the next step" last (spec 14)', async () => {
    const { user, builder, choose, expand, rules, save, savedSteps } = await open(plain);
    await expand(2);
    expect(texts(rules(2).getAllByRole('listitem'))).toEqual(['Otherwise: the next step']);

    await user.click(builder.getByRole('button', { name: /Add rule/ }));
    await choose('Step 2 rule 1 fact', 'the checks are');
    await choose('Step 2 rule 1 value', 'failed');
    await choose('Step 2 rule 1 target', '1. plan-work');
    expect(texts(rules(2).getAllByRole('listitem'))).toEqual([
      'When the checks are failed, go to 1. plan-work',
      'Otherwise: the next step',
    ]);

    await save();
    expect(savedSteps()?.[1]?.rules).toEqual([
      { when: { fact: 'checks', is: 'failed' }, goTo: { type: 'step', stepId: 'plan' } },
    ]);
    expect(savedSteps()?.[0]).toEqual(plain.steps[0]);
  });

  it('says that the run ends after the last step when no rule holds', async () => {
    const { expand, rules } = await open(plain);
    await expand(3);
    expect(texts(rules(3).getAllByRole('listitem'))).toEqual([
      'Otherwise: the next step (this is the last step, so the run ends)',
    ]);
  });

  it('moves the second rule up by keyboard, keeps the keyboard on it, and saves the order (spec 14)', async () => {
    const { builder, expand, rules, save, savedSteps } = await open(looped);
    await expand(3);
    const target = builder.getByRole('combobox', { name: 'Step 3 rule 2 target' });
    target.focus();
    fireEvent.keyDown(target, { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    expect(texts(rules(3).getAllByRole('listitem')).slice(0, 2)).toEqual([
      'When the verdict is changes requested, go to 2. deliver-work',
      'When the verdict is blocked, go to End',
    ]);
    // The key did not open the select's list, and the moved rule still has the keyboard.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(
      builder.getByRole('combobox', { name: 'Step 3 rule 1 target' }),
    );

    await save();
    expect(savedSteps()?.[2]?.rules).toEqual((looped.steps[2]?.rules ?? []).toReversed());
  });

  it('moves and removes a rule with its buttons', async () => {
    const { user, builder, expand, rules } = await open(looped);
    await expand(3);
    expect(builder.getByRole('button', { name: 'Move step 3 rule 1 up' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(builder.getByRole('button', { name: 'Move step 3 rule 1 down' }));
    expect(texts(rules(3).getAllByRole('listitem'))[0]).toBe(
      'When the verdict is changes requested, go to 2. deliver-work',
    );
    await user.click(builder.getByRole('button', { name: 'Remove step 3 rule 1' }));
    expect(texts(rules(3).getAllByRole('listitem'))).toEqual([
      'When the verdict is blocked, go to End',
      'Otherwise: the next step (this is the last step, so the run ends)',
    ]);
  });

  it('does not offer the artifacts fact for a step without expected artifacts (spec 16)', async () => {
    const draft = draftOf(plain);
    const [plan, deliver] = draft.steps;
    expect(factChoices(deliver!, 'verdict').map((choice) => choice.label)).toEqual([
      'the verdict is',
      'the checks are',
      'the step failed',
    ]);
    expect(factChoices(plan!, 'verdict').map((choice) => choice.label)).toEqual([
      'the verdict is',
      'the checks are',
      'the expected artifacts are',
      'the step failed',
    ]);

    const { user, builder, expand } = await open(plain);
    await expand(2);
    await user.click(builder.getByRole('button', { name: /Add rule/ }));
    await user.click(builder.getByRole('combobox', { name: 'Step 2 rule 1 fact' }));
    expect(texts(await screen.findAllByRole('option'))).toEqual([
      'the verdict is',
      'the checks are',
      'the step failed',
    ]);
  });

  it('marks a rule whose target step was deleted with the reason of the server, which refuses the save (spec 16)', async () => {
    const refusal =
      'Step check-work, rule 2: The rule "verdict changes requested" goes to a step that no longer exists';
    const { user, builder, expand, rules, save, runtime } = await open(looped, refusal);
    await user.click(builder.getByRole('button', { name: 'Remove step 2' }));
    // Closed, the step says it on its line.
    expect(builder.getByRole('listitem', { name: 'Step 2' }).textContent).toContain(
      'Rule 2: The rule "verdict changes requested" goes to a step that no longer exists.',
    );
    await expand(2);
    const [, marked] = rules(2).getAllByTestId('step-rule');
    expect(within(marked!).getByRole('alert').textContent).toBe(
      'The rule "verdict changes requested" goes to a step that no longer exists',
    );
    expect(builder.getByRole('combobox', { name: 'Step 2 rule 2 target' }).textContent).toBe(
      'A step that no longer exists',
    );
    expect(
      builder.getByRole('combobox', { name: 'Step 2 rule 2 fact' }).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(within(rules(2).getAllByTestId('step-rule')[0]!).queryByRole('alert')).toBeNull();

    await save();
    expect((await builder.findAllByRole('alert')).map((alert) => alert.textContent)).toContain(
      refusal,
    );
    expect(runtime.sent).toEqual([]);
    expect(builder.queryByRole('status')).toBeNull();
  });

  it('names the other two refusals as the server does: artifacts without globs, one condition twice', () => {
    const draft = draftOf({
      ...plain,
      steps: [
        plain.steps[0]!,
        step('deliver', 'deliver-work', {
          rules: [
            { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
            { when: { fact: 'checks', is: 'failed' }, goTo: { type: 'end' } },
            { when: { fact: 'checks', is: 'failed' }, goTo: { type: 'step', stepId: 'plan' } },
          ],
        }),
      ],
    });
    expect(draftRuleProblems(draft.steps)).toEqual([
      {
        stepId: 'deliver',
        rule: 0,
        reason: 'The rule "artifacts missing" needs expected artifacts, and this step names none',
      },
      { stepId: 'deliver', rule: 2, reason: 'The step already has a rule for "checks failed"' },
    ]);
  });

  it('starts a new rule on a condition the step has no rule for yet', () => {
    const { steps } = draftOf(looped);
    expect(newRule(steps, 'check')).toEqual({
      when: { fact: 'verdict', is: 'approved' },
      goTo: { type: 'step', stepId: 'deliver' },
    });
    expect(newRule(steps, 'plan')).toEqual({
      when: { fact: 'verdict', is: 'changesRequested' },
      goTo: { type: 'end' },
    });
    expect(newRule(steps, 'gone')).toBeUndefined();
  });
});

describe('a workflow without rules (spec 17)', () => {
  it('looks and saves as before, and its diagram is a straight line', async () => {
    const { user, builder, expand, save, savedSteps } = await open(plain);
    expect(await drawnLines()).toEqual([
      'flowchart TD',
      'start(["Start"])',
      's1["1. plan-work"]',
      's2["2. deliver-work"]',
      's3["3. check-work"]',
      'finish(["End"])',
      'start --> s1',
      's1 -->|"gate"| s2',
      's2 --> s3',
      's3 --> finish',
    ]);
    expect(builder.getByRole('listitem', { name: 'Step 3' }).textContent).not.toContain('rule');
    // A rule added and taken away again leaves the workflow as it was: nothing to save.
    await expand(3);
    await user.click(builder.getByRole('button', { name: /Add rule/ }));
    expect(builder.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    await user.click(builder.getByRole('button', { name: 'Remove step 3 rule 1' }));
    expect(builder.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(stepsOf(draftOf(plain))).toEqual(plain.steps);

    // Another edit saves steps that carry no `rules` at all.
    await user.type(builder.getByRole('textbox', { name: 'Step 3 extra prompt' }), 'Be strict.');
    await save();
    expect(savedSteps()).toEqual([
      plain.steps[0],
      plain.steps[1],
      { ...plain.steps[2], extraPrompt: 'Be strict.' },
    ]);
  });
});

describe('the paths diagram in the builder (spec 15)', () => {
  it('shows the loop and the gate, and changes when a rule is edited', async () => {
    const { choose, expand } = await open(looped);
    expect((await drawnLines()).slice(6)).toEqual([
      'start --> s1',
      's1 -->|"gate"| s2',
      's2 --> s3',
      's3 -.->|"verdict blocked"| finish',
      's3 -.->|"verdict changes requested"| s2',
      's3 -->|"otherwise"| finish',
    ]);
    await expand(3);
    await choose('Step 3 rule 2 target', '1. plan-work');
    await screen.findByText('s3 -.->|"verdict changes requested"| s1');
    expect(await drawnLines()).not.toContain('s3 -.->|"verdict changes requested"| s2');
  });
});

const ruleCommands = () =>
  workflowCommands({
    workflows: [],
    runs: [],
    templates: [],
    openRun: undefined,
    rules: rulesStore.getState(),
  }).filter((command) => command.id.startsWith('workflow.rule.'));

describe('palette commands and keys for rules', () => {
  it('are offered only while a builder is open', async () => {
    expect(ruleCommands()).toEqual([]);
    const { expand } = await open(looped);
    await expand(3);
    expect(ruleCommands().map((command) => [command.id, command.title])).toEqual([
      ['workflow.rule.add.plan', 'Rule: add to step 1 (plan-work)'],
      ['workflow.rule.add.deliver', 'Rule: add to step 2 (deliver-work)'],
      ['workflow.rule.add', 'Rule: add to step 3 (check-work)'],
    ]);
  });

  it('add a rule to the step being edited, and move or remove the rule that has the keyboard', async () => {
    const { builder, expand, rules } = await open(looped);
    await expand(3);
    builder.getByRole('combobox', { name: 'Step 3 rule 2 fact' }).focus();
    expect(
      ruleCommands().map((command) => [command.id, command.keybinding, command.detail]),
    ).toEqual([
      ['workflow.rule.add.plan', undefined, undefined],
      ['workflow.rule.add.deliver', undefined, undefined],
      ['workflow.rule.add', 'keybindings.ruleAdd', undefined],
      [
        'workflow.rule.moveUp',
        'keybindings.ruleMoveUp',
        'Rule 2 of step 3 (check-work): When the verdict is changes requested, go to 2. deliver-work',
      ],
      [
        'workflow.rule.remove',
        undefined,
        'Rule 2 of step 3 (check-work): When the verdict is changes requested, go to 2. deliver-work',
      ],
    ]);

    const run = (id: string) =>
      act(() =>
        ruleCommands()
          .find((command) => command.id === id)
          ?.run({} as never),
      );
    run('workflow.rule.moveUp');
    expect(texts(await rules(3).findAllByRole('listitem')).slice(0, 2)).toEqual([
      'When the verdict is changes requested, go to 2. deliver-work',
      'When the verdict is blocked, go to End',
    ]);
    expect(ruleCommands().map((command) => command.id)).toContain('workflow.rule.moveDown');
    expect(ruleCommands().map((command) => command.id)).not.toContain('workflow.rule.moveUp');

    // The Add key works from anywhere in the step, through the app's key handler.
    fireEvent.keyDown(builder.getByRole('textbox', { name: 'Step 3 extra prompt' }), {
      key: 'r',
      code: 'KeyR',
      altKey: true,
    });
    expect(
      (await rules(3).findAllByTestId('step-rule')).map((row) => row.getAttribute('aria-label')),
    ).toEqual([
      'When the verdict is changes requested, go to 2. deliver-work',
      'When the verdict is blocked, go to End',
      'When the verdict is approved, go to 2. deliver-work',
    ]);

    run('workflow.rule.remove');
    expect(await rules(3).findAllByTestId('step-rule')).toHaveLength(2);
    // A command for a step that is closed opens it.
    run('workflow.rule.add.deliver');
    expect(
      texts(
        await within(await builder.findByRole('list', { name: 'Step 2 rules' })).findAllByRole(
          'listitem',
        ),
      ),
    ).toEqual([
      'When the verdict is changes requested, go to 1. plan-work',
      'Otherwise: the next step',
    ]);
  });
});
