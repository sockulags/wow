import type { Command, ProviderInstance, Skill, Workflow } from '@wow/contracts';
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
import { workflowCommands } from './commands';
import { draftOf } from './model';
import { rulesStore } from './rules';
import { attachedSkills, skillChoices } from './step-skills';

// "Also follow" and the built-in skills wow attaches by itself in the workflow builder (wow
// skills spec 11, 12), against a fake server. The skills are invented.

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<() => void>(),
  mermaidAPI: { getDiagramFromText: vi.fn<() => Promise<{ db: object }>>() },
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const T = '2026-11-02T08:05:00.000Z';

const skill = (name: string, source: Skill['source'], text?: string): Skill => ({
  id: `${source}/${name}`,
  name,
  description: `Invented ${name}.`,
  dir: `/skills/${source}/${name}`,
  source,
  manualOnly: false,
  invocations: { claude: `/${name}`, codex: `$${name}` },
  ...(text === undefined ? {} : { text }),
});

// The order the server sends: Yours, wow, then folders.
const skills: Skill[] = [
  skill('kettle-check', 'yours', 'Boil first.'),
  skill('wow-artifacts', 'wow', 'Write {{expectedArtifacts}}.'),
  skill('wow-verdict', 'wow', 'End with {{approvedLine}}.'),
  skill('check-work', 'user-claude'),
  skill('kettle-check', 'user-claude'),
];

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

const workflow: Workflow = {
  id: 'w',
  name: 'Check',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps: [
    step('check', 'check-work', {
      rules: [{ when: { fact: 'verdict', is: 'changesRequested' }, goTo: { type: 'end' } }],
    }),
  ],
};

const instance: ProviderInstance = {
  id: 'mock',
  kind: 'claude',
  name: 'Mock',
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

function fake(settings: Record<string, unknown> = {}): Runtime & { sent: Command[] } {
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
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false, ...settings }),
    ),
  };
}

beforeEach(() => {
  mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue({ db: {} });
  mermaid.render.mockImplementation((id) => Promise.resolve({ svg: `<svg id="${id}"></svg>` }));
});

async function open(settings: Record<string, unknown> = {}) {
  const runtime = fake(settings);
  await renderApp('/workflows/w', runtime);
  const user = userEvent.setup();
  const builder = within(await screen.findByRole('form', { name: 'Workflow builder' }));
  await user.click(builder.getByRole('button', { name: 'Expand step 1' }));
  const save = () => user.click(builder.getByRole('button', { name: 'Save' }));
  const saved = () => {
    const [command] = runtime.sent;
    return command?.type === 'workflow.update' ? command.steps?.[0] : undefined;
  };
  return { runtime, user, builder, save, saved };
}

describe('the skill choices of a step', () => {
  it('keep an own skill and a folder skill of the same name apart, each with its group (spec 9)', () => {
    expect(skillChoices(skills).map(({ value, detail }) => `${value} ${detail}`)).toEqual([
      'yours/kettle-check Yours',
      'wow/wow-artifacts wow',
      'wow/wow-verdict wow',
      'check-work User',
      'kettle-check User',
    ]);
  });

  it('names both folders of two own skills that share a name, in their one choice', () => {
    const twin = { ...skill('kettle-check', 'yours'), id: 'b', dir: '/skills/yours/kettle-b' };
    const first = { ...skill('kettle-check', 'yours'), dir: '/skills/yours/kettle-a' };
    expect(skillChoices([first, twin]).map(({ value, detail }) => `${value} ${detail}`)).toEqual([
      'yours/kettle-check Yours · In kettle-a, kettle-b: rename one',
    ]);
  });
});

describe('the built-in skills wow attaches to a step (spec 12)', () => {
  const draft = draftOf(workflow).steps[0];
  if (!draft) throw new Error('no step');
  const options = { on: true, forUnits: false, skills };

  it('attach wow-verdict when a rule reads the verdict, and wow-artifacts when artifacts are expected', () => {
    expect(attachedSkills(draft, options)).toEqual([
      { name: 'wow-verdict', reason: 'a rule of this step reads the verdict', left: false },
    ]);
    expect(
      attachedSkills({ ...draft, artifactsText: 'docs/plan.md' }, options).map((s) => s.name),
    ).toEqual(['wow-verdict', 'wow-artifacts']);
  });

  it('mark one the step leaves out, and show none with the setting off, one the step already follows, or one switched off', () => {
    expect(attachedSkills({ ...draft, leaveOut: ['wow-verdict'] }, options)).toEqual([
      { name: 'wow-verdict', reason: 'a rule of this step reads the verdict', left: true },
    ]);
    expect(attachedSkills(draft, { ...options, on: false })).toEqual([]);
    expect(
      attachedSkills({ ...draft, alsoFollow: [{ name: 'wow-verdict', source: 'wow' }] }, options),
    ).toEqual([]);
    expect(
      attachedSkills(draft, {
        ...options,
        skills: skills.filter((entry) => entry.name !== 'wow-verdict'),
      }),
    ).toEqual([]);
  });
});

describe('"Also follow" in the builder (spec 11)', () => {
  it('adds skills from every group, removes one, and saves them in their order', async () => {
    const { user, builder, save, saved } = await open();
    const follow = within(builder.getByTestId('also-follow'));
    await user.click(builder.getByRole('combobox', { name: 'Step 1 also follow' }));
    await user.click(await screen.findByRole('option', { name: /^kettle-check\s*Yours/ }));
    await user.click(builder.getByRole('combobox', { name: 'Step 1 also follow' }));
    await user.click(await screen.findByRole('option', { name: /^kettle-check\s*User/ }));
    await user.click(builder.getByRole('combobox', { name: 'Step 1 also follow' }));
    await user.click(await screen.findByRole('option', { name: /^wow-artifacts/ }));
    expect(follow.getAllByText(/^kettle-check$|^wow-artifacts$/).map((n) => n.textContent)).toEqual(
      ['kettle-check', 'kettle-check', 'wow-artifacts'],
    );
    await user.click(
      follow.getByRole('button', { name: 'Stop following wow-artifacts in step 1' }),
    );
    await save();
    expect(saved()?.alsoFollow).toEqual([
      { name: 'kettle-check', source: 'yours' },
      { name: 'kettle-check' },
    ]);
    // Three picks through a popover each; a loaded machine needs more than the default.
  }, 15_000);

  it('runs an own skill as the step skill with its source', async () => {
    const { user, builder, save, saved } = await open();
    await user.click(builder.getByRole('combobox', { name: 'Step 1 skill' }));
    await user.click(await screen.findByRole('option', { name: /^kettle-check\s*Yours/ }));
    await save();
    expect(saved()).toMatchObject({ skillName: 'kettle-check', skillSource: 'yours' });
  });
});

describe('the attached marks in the builder (spec 12)', () => {
  it('show wow-verdict as attached because of the rule, and Leave out saves it left out', async () => {
    const { user, builder, save, saved } = await open();
    const attached = within(builder.getByRole('region', { name: 'Step 1 skills attached by wow' }));
    expect(attached.getByTestId('attached-skill').textContent).toContain(
      'Because a rule of this step reads the verdict.',
    );
    await user.click(attached.getByRole('button', { name: 'Leave wow-verdict out of step 1' }));
    expect(attached.getByTestId('attached-skill').textContent).toContain('Left out');
    await save();
    expect(saved()?.leaveOut).toEqual(['wow-verdict']);
  });

  it('are not shown while automatic attaching is off', async () => {
    const { builder } = await open({ 'workflows.attachBuiltInSkills': false });
    expect(builder.queryByTestId('attached-skills')).toBeNull();
  });
});

describe('palette commands for the step being edited', () => {
  it('follow another skill, stop following one, and leave out or attach again a built-in skill', () => {
    const changed: unknown[] = [];
    const [draft] = draftOf(workflow).steps;
    if (!draft) throw new Error('no step');
    const steps = [{ ...draft, alsoFollow: [{ name: 'kettle-check', source: 'yours' as const }] }];
    rulesStore.setState({
      builder: {
        steps,
        setRules: () => undefined,
        changeStep: (stepId, changes) => changed.push({ stepId, changes }),
        forUnits: false,
        attachBuiltIn: true,
      },
      at: { stepId: 'check', rule: undefined },
    });
    const commands = workflowCommands({
      workflows: [workflow],
      runs: [],
      templates: [],
      openRun: undefined,
      rules: rulesStore.getState(),
      skills,
    });
    const titles = commands.map((command) => command.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Also follow wow-artifacts in step 1 (check-work)',
        'Also follow kettle-check in step 1 (check-work)',
        'Stop following kettle-check in step 1 (check-work)',
        'Leave wow-verdict out of step 1 (check-work)',
      ]),
    );
    commands.find((command) => command.title.startsWith('Leave wow-verdict'))?.run({} as never);
    expect(changed).toEqual([{ stepId: 'check', changes: { leaveOut: ['wow-verdict'] } }]);
    rulesStore.setState({ builder: undefined, at: undefined, focus: undefined });
  });
});
