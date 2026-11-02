import type { Skill, Thread, ThreadItem } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  effortOptions,
  filterSkills,
  groupThreads,
  insertSkill,
  latestContext,
  permissionOptions,
  runLabel,
  skillQuery,
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
    const runs = [
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

describe('skill picker', () => {
  it('opens on a $ at the start of a word and reads what follows', () => {
    expect(skillQuery('$del', 4)).toEqual({ start: 0, query: 'del' });
    expect(skillQuery('run $ ', 5)).toEqual({ start: 4, query: '' });
    expect(skillQuery('costs 5$', 8)).toBeUndefined();
    expect(skillQuery('$del rest', 9)).toBeUndefined();
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

  it('replaces the query with the invocation and moves the caret after it', () => {
    const text = 'please $deli now';
    const query = skillQuery(text, 12);
    expect(query).toEqual({ start: 7, query: 'deli' });
    if (!query) return;
    expect(insertSkill(text, query, 12, '/deliver-work')).toEqual({
      text: 'please /deliver-work  now',
      caret: 21,
    });
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
