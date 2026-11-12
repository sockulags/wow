import type { ProviderInstance, Skill, Thread, ThreadItem, WorkflowRun } from '@wow/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/app/commands';
import { chatCommands } from './commands';
import { showSkillComposer, skillComposerStore, threadSkillComposer } from './composer-store';
import { createDraftStore } from './draft';
import {
  canMarkDone,
  effortOptions,
  filterSkills,
  groupThreads,
  latestContext,
  permissionOptions,
  runLabel,
  skillQuery,
  skillRefOf,
  typedTrigger,
  withoutQuery,
} from './model';

const thread = (id: string, changes: Partial<Thread> = {}): Thread => ({
  id,
  projectId: null,
  cwd: '/work',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: id,
  model: 'sonnet',
  effort: 'default',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00Z',
  updatedAt: '2026-11-02T08:00:00Z',
  ...changes,
});

const skill = (name: string, description: string): Skill => ({
  id: name,
  name,
  description,
  dir: `/skills/${name}`,
  source: 'user-claude',
  manualOnly: false,
  invocations: { claude: `/${name}`, codex: `$${name}` },
});

describe('thread groups', () => {
  it('groups by state with pinned threads first, then the most recent', () => {
    const groups = groupThreads([
      thread('old', { updatedAt: '2026-11-02T08:00:00Z' }),
      thread('new', { updatedAt: '2026-11-02T09:00:00Z' }),
      thread('pinned', { pinned: true, updatedAt: '2026-11-01T08:00:00Z' }),
      thread('failed', { state: 'failed', updatedAt: '2026-11-02T07:00:00Z' }),
      thread('asking', { state: 'needs_you' }),
      thread('busy', { state: 'working' }),
      thread('finished', { state: 'done' }),
    ]);
    expect(groups.map(([group, members]) => [group, members.map((member) => member.id)])).toEqual([
      ['Needs you', ['asking']],
      ['Working', ['busy']],
      ['Idle', ['pinned', 'new', 'old', 'failed']],
      ['Done', ['finished']],
    ]);
  });

  it('labels a workflow thread with the run and step name', () => {
    const workflows = [
      {
        id: 'w1',
        name: 'Feature',
        templateKind: null,
        createdAt: '2026-11-02T08:00:00Z',
        updatedAt: '2026-11-02T08:00:00Z',
        steps: [
          {
            id: 's1',
            skillName: 'plan-work',
            providerInstanceId: 'claude',
            gateBefore: false,
            gateAfter: true,
            expectedArtifacts: [],
          },
        ],
      },
    ];
    const runs: WorkflowRun[] = [
      {
        id: 'r1',
        workflowId: 'w1',
        projectId: 'p1',
        calendarItemId: null,
        backlogItemId: null,
        state: 'running',
        currentStep: 0,
        steps: [],
        startedAt: '2026-11-02T08:00:00Z',
        endedAt: null,
      },
    ];
    expect(runLabel(thread('t', { runId: 'r1', stepId: 's1' }), runs, workflows)).toBe(
      'Feature · plan-work',
    );
    expect(runLabel(thread('t'), runs, workflows)).toBeUndefined();
  });
});

describe('thread settings', () => {
  const models = [{ id: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'high'] }];

  it('offers the provider default effort and keeps an unlisted current value', () => {
    expect(effortOptions('claude', models, 'sonnet', 'high')).toEqual(['default', 'low', 'high']);
    expect(effortOptions('codex', models, 'sonnet', 'xhigh')).toEqual(['xhigh', 'low', 'high']);
  });

  it('lists the permission modes of the provider kind', () => {
    expect(permissionOptions('codex', 'auto').map((option) => option.id)).toEqual([
      'read-only',
      'auto',
      'untrusted',
      'full-access',
    ]);
    expect(permissionOptions('claude', 'custom')[0]).toEqual({ id: 'custom', label: 'custom' });
  });
});

describe('skill list (wow skills spec 16, 19)', () => {
  it('opens where the trigger was typed at the start or after a space, and reads what follows', () => {
    expect(typedTrigger('/', 1, '/', '/')).toBe(0);
    expect(typedTrigger('run /', 5, '/', '/')).toBe(4);
    expect(skillQuery('/del', 4, 0, '/')).toEqual({ start: 0, query: 'del' });
    expect(skillQuery('run / ', 5, 4, '/')).toEqual({ start: 4, query: '' });
    // Leaving the word closes it.
    expect(skillQuery('/del rest', 9, 0, '/')).toBeUndefined();
    expect(skillQuery('/del', 4, undefined, '/')).toBeUndefined();
  });

  it('opens nothing for src/app or 2026/11/12 in a sentence, nor for $ while the trigger is /', () => {
    expect(typedTrigger('see src/', 8, '/', '/')).toBeUndefined();
    expect(typedTrigger('due 2026/', 9, '/', '/')).toBeUndefined();
    expect(typedTrigger('costs $', 7, '$', '/')).toBeUndefined();
    expect(skillQuery('see src/app', 11, 7, '/')).toBeUndefined();
  });

  it('follows chat.skillTrigger set to $: $ opens it and / does not', () => {
    expect(typedTrigger('$', 1, '$', '$')).toBe(0);
    expect(typedTrigger('/', 1, '/', '$')).toBeUndefined();
    expect(skillQuery('please $che', 11, 7, '$')).toEqual({ start: 7, query: 'che' });
  });

  it('opens nothing for pasted text with a slash', () => {
    // A paste is no typed character.
    expect(typedTrigger('/deliver-work now', 17, null, '/')).toBeUndefined();
  });

  it('ranks name matches above description matches', () => {
    const skills = [
      skill('check-work', 'Review delivered work'),
      skill('deliver-work', 'Ship a unit'),
      skill('capture-intent', 'Write an intent'),
    ];
    expect(filterSkills(skills, 'deliver').map((match) => match.name)).toEqual([
      'deliver-work',
      'check-work',
    ]);
    expect(filterSkills(skills, '')).toHaveLength(3);
  });

  it('takes the trigger and the query out of the text on a pick', () => {
    const text = 'please /deli now';
    const query = skillQuery(text, 12, 7, '/');
    expect(query).toEqual({ start: 7, query: 'deli' });
    if (!query) return;
    expect(withoutQuery(text, query, 12)).toEqual({ text: 'please  now', caret: 7 });
  });

  it('names a wow skill by its source and a plugin skill as plugin:name', () => {
    expect(skillRefOf({ ...skill('tidy', ''), source: 'yours' })).toEqual({
      name: 'tidy',
      source: 'yours',
    });
    expect(skillRefOf({ ...skill('wow-verdict', ''), source: 'wow' })).toEqual({
      name: 'wow-verdict',
      source: 'wow',
    });
    expect(
      skillRefOf({ ...skill('c', ''), invocations: { claude: '/agent-os:c', codex: '$c' } }),
    ).toEqual({ name: 'agent-os:c' });
    expect(skillRefOf(skill('deliver-work', ''))).toEqual({ name: 'deliver-work' });
  });
});

const usage = (index: number, payload: unknown): ThreadItem => ({
  id: `u${index}`,
  threadId: 't',
  turnId: `t:turn:${index}`,
  index,
  kind: 'usage',
  payload,
  streaming: false,
});

describe('context meter', () => {
  it('reads the latest context report', () => {
    expect(
      latestContext([
        usage(0, { inputTokens: 1, context: { usedTokens: 10, maxTokens: 100 } }),
        usage(1, { inputTokens: 2, context: { usedTokens: 40, maxTokens: 100 } }),
        usage(2, { inputTokens: 3 }),
      ]),
    ).toEqual({ usedTokens: 40, maxTokens: 100 });
    expect(latestContext([usage(0, { inputTokens: 1 })])).toBeUndefined();
  });
});

const doneTitles = (open: Thread | undefined) =>
  chatCommands({ threads: [], instances: [], openThread: open, running: false })
    .map((command) => command.title)
    .filter((title) => title === 'Mark thread done' || title === 'Reopen thread');

describe('done threads', () => {
  it('offers Mark thread done or Reopen thread for the open thread from its state', () => {
    expect(doneTitles(undefined)).toEqual([]);
    expect(doneTitles(thread('a'))).toEqual(['Mark thread done']);
    expect(doneTitles(thread('a', { state: 'failed' }))).toEqual(['Mark thread done']);
    expect(doneTitles(thread('a', { state: 'done' }))).toEqual(['Reopen thread']);
    expect(doneTitles(thread('a', { state: 'working' }))).toEqual([]);
    expect(doneTitles(thread('a', { state: 'needs_you' }))).toEqual([]);
  });

  it('allows marking done only when the agent neither works nor waits', () => {
    expect(
      (['idle', 'failed', 'working', 'needs_you', 'done'] as const).map((state) =>
        canMarkDone({ state }),
      ),
    ).toEqual([true, true, false, false, false]);
  });
});

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const openComposer = {
  id: 'composer-a',
  draftKey: 'a',
  chips: [],
  openSkills: () => undefined,
  removeSkill: () => undefined,
  putBack: () => undefined,
};

const ids = (running: boolean, changes: Partial<Thread> = {}) =>
  chatCommands({
    threads: [],
    instances: [instance],
    openThread: thread('a', changes),
    running,
    openComposer,
  })
    .map((command) => command.id)
    .filter((id) => ['chat.compact', 'chat.editQueued', 'chat.cancelQueued'].includes(id));

// Agent workbench spec 58, 59: the palette commands behind `/clear` and `/compact`.
describe('clear and compact', () => {
  it('starts a new thread with the same instance, model, effort, mode and folder', () => {
    const open = thread('a', {
      projectId: 'kettle',
      cwd: '/work/kettle-branch',
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
    });
    const clear = chatCommands({
      threads: [open],
      instances: [instance],
      openThread: open,
      running: false,
    }).find((command) => command.id === 'chat.clear');
    const draft = createDraftStore();
    const navigate = vi.fn<(to: unknown) => Promise<void>>(() => Promise.resolve());
    clear?.run({ navigate, draft } as unknown as CommandContext);
    expect(draft.getState()).toMatchObject({
      providerInstanceId: 'claude',
      projectId: 'kettle',
      cwd: '/work/kettle-branch',
      settings: {
        providerInstanceId: 'claude',
        model: 'opus',
        effort: 'high',
        permissionMode: 'plan',
      },
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/chat/new' });
  });

  it('offers Compact only while no turn runs, and the queue commands while one waits', () => {
    expect(ids(false)).toEqual(['chat.compact']);
    expect(
      ids(true, {
        queued: { id: 'q', text: 'Then this', queuedAt: '2026-11-02T08:00:00Z' },
      }),
    ).toEqual(['chat.editQueued', 'chat.cancelQueued']);
  });
});

const composer = (id: string, draftKey: string | undefined) => {
  const putBack =
    vi.fn<
      (
        text: string,
        skills: readonly unknown[],
        images?: readonly unknown[],
        files?: readonly string[],
      ) => void
    >();
  return {
    putBack,
    entry: {
      id,
      draftKey,
      chips: [],
      openSkills: () => undefined,
      removeSkill: () => undefined,
      putBack,
    },
  };
};

describe('Edit queued message from the palette (agent workbench spec 52)', () => {
  const queued = {
    id: 'q',
    text: '@src/timer.ts\n\nThen this',
    files: ['src/timer.ts'],
    queuedAt: '2026-11-02T08:00:00Z',
  };
  const editQueued = (composers: Parameters<typeof showSkillComposer>[0][]) => {
    const hide = composers.map((entry) => showSkillComposer(entry));
    const found = threadSkillComposer(skillComposerStore.getState(), 'a');
    hide.forEach((stop) => stop());
    return chatCommands({
      threads: [],
      instances: [instance],
      openThread: thread('a', { queued }),
      running: true,
      openComposer: found,
    }).find((command) => command.id === 'chat.editQueued');
  };

  it('is not offered while the thread has no composer to take the text', () => {
    expect(editQueued([composer('panel', 'b').entry])).toBeUndefined();
  });

  it("puts the text back in the thread's own composer, not the one focused last", async () => {
    const own = composer('main', 'a');
    const panel = composer('panel', 'b');
    const command = editQueued([own.entry, panel.entry]);
    const request = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({
        commandId: '00000000-0000-4000-8000-000000000000',
        seqs: [],
        duplicate: false,
      }),
    );
    const answered = new Promise<void>((resolve) =>
      own.putBack.mockImplementation(() => resolve()),
    );
    command?.run({ connection: { request } } as unknown as CommandContext);
    await answered;
    // No skills and no images went with it; its files go back as chips (spec 56).
    expect(own.putBack).toHaveBeenCalledWith(
      '@src/timer.ts\n\nThen this',
      [],
      [],
      ['src/timer.ts'],
    );
    expect(panel.putBack).not.toHaveBeenCalled();
  });
});
