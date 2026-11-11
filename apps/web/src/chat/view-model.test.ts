import type { ProviderInstance, Skill, Thread, ThreadItem } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { threadDefaults } from './new-thread';
import {
  effortLabel,
  failedToolCalls,
  formatElapsed,
  groupToolCalls,
  lastUsedThread,
  lastUserSent,
  listTitle,
  providerLabel,
  recentFolders,
  skillGroup,
  skillSourceLabel,
  starterSkills,
  type ConversationEntry,
} from './view-model';

const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
  id,
  projectId: null,
  cwd: `/work/${id}`,
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: `Thread ${id}`,
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  ...overrides,
});

const instance = (id: string, name: string, kind: ProviderInstance['kind']): ProviderInstance => ({
  id,
  kind,
  name,
  binaryPath: kind,
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
});

const skill = (name: string, source: Skill['source'], claude = `/${name}`): Skill => ({
  id: `${source}/${name}`,
  name,
  description: '',
  dir: `/skills/${name}`,
  source,
  manualOnly: false,
  invocations: { claude, codex: `$${name}` },
});

describe('chat labels', () => {
  it('names a provider instance without its kind unless two names clash (C-03)', () => {
    const work = instance('a', 'Work', 'claude');
    const home = instance('b', 'Home', 'codex');
    expect(providerLabel(work, [work, home])).toBe('Work');
    const twin = instance('c', 'Work', 'codex');
    expect(providerLabel(twin, [work, twin])).toBe('Work (Codex)');
  });

  it('drops the workflow prefix from a run thread in the list (C-06)', () => {
    expect(listTitle({ title: 'Feature: search: capture-intent' }, 'Feature: search')).toBe(
      'capture-intent',
    );
    expect(listTitle({ title: 'Plain thread' }, undefined)).toBe('Plain thread');
    expect(listTitle({ title: '' }, undefined)).toBe('New thread');
  });

  it('labels effort one way (C-15) and turn time as a clock (C-09)', () => {
    expect(['default', 'low', 'high'].map(effortLabel)).toEqual(['Default', 'Low', 'High']);
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe('12:05');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });

  it('groups skills by where they come from (C-07)', () => {
    expect(skillGroup(skill('a', 'project-agents'))).toBe('project');
    expect(skillGroup(skill('b', 'user-codex'))).toBe('user');
    expect(skillGroup(skill('c', 'user-claude', '/agent-os:c'))).toBe('plugins');
    expect(skillGroup(skill('d', 'custom'))).toBe('other');
    expect(skillGroup(skill('e', 'yours'))).toBe('yours');
    expect(skillGroup(skill('wow-verdict', 'wow'))).toBe('wow');
    expect(skillSourceLabel(skill('c', 'user-claude', '/agent-os:c'))).toBe('Plugin agent-os');
  });

  it('offers the project skills first as starters, once each', () => {
    const skills = [
      skill('zeta', 'user-claude'),
      skill('alpha', 'user-claude'),
      skill('plan', 'project-claude'),
      skill('plan', 'user-codex'),
    ];
    expect(starterSkills(skills, 2).map((entry) => entry.name)).toEqual(['plan', 'alpha']);
    expect(starterSkills(skills, 0)).toEqual([]);
  });
});

describe('new thread defaults (owner decision F-5)', () => {
  it('starts from the thread the user started last, ignoring workflow threads', () => {
    const threads = [
      thread('old', { createdAt: '2026-11-01T08:00:00.000Z' }),
      thread('new', { createdAt: '2026-11-02T09:00:00.000Z', providerInstanceId: 'codex' }),
      thread('run', { createdAt: '2026-11-02T10:00:00.000Z', runId: 'r1' }),
    ];
    expect(lastUsedThread(threads)?.id).toBe('new');
    expect(lastUsedThread([])).toBeUndefined();
  });

  it('takes the last thread model and effort on the same instance, else the defaults', () => {
    const claude = instance('claude', 'Claude', 'claude');
    const last = thread('t', { model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(threadDefaults(claude, [], last)).toEqual({
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
    });
    expect(threadDefaults(claude, [], { ...last, providerInstanceId: 'other' })).toEqual({
      model: 'sonnet',
      effort: 'default',
      permissionMode: 'default',
    });
  });

  it('lists folders used without a project, newest first, not the project folders', () => {
    const threads = [
      thread('a', { cwd: '/tmp/a', createdAt: '2026-11-01T08:00:00.000Z' }),
      thread('b', { cwd: '/tmp/b', createdAt: '2026-11-02T08:00:00.000Z' }),
      thread('c', { cwd: '/tmp/a', createdAt: '2026-11-03T08:00:00.000Z' }),
      thread('d', { cwd: '/work/demo', createdAt: '2026-11-04T08:00:00.000Z' }),
      thread('e', { cwd: '/tmp/e', projectId: 'p' }),
    ];
    expect(recentFolders(threads, [{ cwd: '/work/demo' }])).toEqual(['/tmp/a', '/tmp/b']);
  });
});

const item = (
  id: string,
  kind: ThreadItem['kind'],
  turnId = 'turn-1',
  status: 'running' | 'ok' | 'error' = 'ok',
): ThreadItem => ({
  id,
  threadId: 'thread',
  turnId,
  index: 0,
  kind,
  payload:
    kind === 'tool_call' ? { name: `Read ${id}`, input: {}, output: '', status } : { text: id },
  streaming: false,
});
const shape = (entries: ConversationEntry[]) =>
  entries.map((entry) =>
    entry.kind === 'item' ? entry.item.id : `${entry.id}[${entry.items.map((i) => i.id)}]`,
  );

describe('tool calls in a run are one row', () => {
  it('groups consecutive calls of a turn and leaves a single call as it is', () => {
    const items = [
      item('u', 'user'),
      item('a', 'tool_call'),
      item('b', 'tool_call'),
      item('c', 'tool_call'),
      item('t', 'assistant_text'),
      item('d', 'tool_call'),
      item('x', 'usage'),
    ];
    expect(shape(groupToolCalls(items))).toEqual(['u', 'a[a,b,c]', 't', 'd', 'x']);
  });

  it('breaks a run at any other item, at a new turn and after a call with a row of its own', () => {
    const items = [
      item('a', 'tool_call'),
      item('r', 'reasoning'),
      item('b', 'tool_call'),
      item('c', 'tool_call', 'turn-2'),
      item('d', 'tool_call', 'turn-2'),
      item('e', 'tool_call', 'turn-2'),
      item('f', 'tool_call', 'turn-2'),
      item('p', 'approval', 'turn-2'),
      item('g', 'tool_call', 'turn-2'),
    ];
    expect(shape(groupToolCalls(items, (entry) => entry.id === 'd'))).toEqual([
      'a',
      'r',
      'b',
      'c[c,d]',
      'e[e,f]',
      'p',
      'g',
    ]);
  });

  it('keeps the id of its first call while a running turn adds calls', () => {
    const first = groupToolCalls([item('a', 'tool_call'), item('b', 'tool_call')]);
    const later = groupToolCalls([
      item('a', 'tool_call'),
      item('b', 'tool_call'),
      item('c', 'tool_call', 'turn-1', 'running'),
    ]);
    expect(first[0]).toMatchObject({ kind: 'tools', id: 'a' });
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ kind: 'tools', id: 'a' });
    expect(later[0]?.kind === 'tools' && later[0].items.at(-1)?.id).toBe('c');
  });

  it('counts the failed calls of a run', () => {
    expect(
      failedToolCalls([
        item('a', 'tool_call'),
        item('b', 'tool_call', 'turn-1', 'error'),
        item('c', 'tool_call', 'turn-1', 'running'),
      ]),
    ).toBe(1);
  });
});

const user = (id: string, payload: unknown): ThreadItem => ({
  id,
  threadId: 'thread',
  turnId: id,
  index: 0,
  kind: 'user',
  payload,
  streaming: false,
});

describe('Retry resends the last message as it was sent (wow skills spec 18)', () => {
  it('gives the text and the skills, wow and own by source, folder and plugin ones by name', () => {
    const items = [
      user('old', { text: 'an older message' }),
      user('last', {
        text: 'fix the login',
        skills: [
          { name: 'wow-handover', source: 'wow', text: 'End with a handover.' },
          { name: 'tidy-notes', source: 'yours', text: 'Tidy.' },
          { name: 'deliver-work', source: 'user-claude', invocation: '/deliver-work' },
          { name: 'kit:review', source: 'plugin', invocation: '/kit:review' },
        ],
      }),
      item('answer', 'assistant_text'),
    ];
    expect(lastUserSent(items)).toEqual({
      text: 'fix the login',
      skills: [
        { name: 'wow-handover', source: 'wow' },
        { name: 'tidy-notes', source: 'yours' },
        { name: 'deliver-work' },
        { name: 'kit:review' },
      ],
    });
  });

  it('gives a message that is only chips, and an old message with $name as plain text', () => {
    expect(
      lastUserSent([user('only', { text: '', skills: [{ name: 'tidy-notes', source: 'yours' }] })]),
    ).toEqual({ text: '', skills: [{ name: 'tidy-notes', source: 'yours' }] });
    expect(lastUserSent([user('old', { text: '$deliver-work now' })])).toEqual({
      text: '$deliver-work now',
      skills: [],
    });
  });

  it('skips empty and unreadable user items and gives nothing without a user message', () => {
    expect(
      lastUserSent([user('a', { text: 'first' }), user('b', { text: '  ' }), user('c', 42)]),
    ).toEqual({ text: 'first', skills: [] });
    expect(lastUserSent([item('answer', 'assistant_text')])).toBeUndefined();
  });
});
