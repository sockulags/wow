import type { ProviderInstance, Skill, Thread } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { threadDefaults } from './new-thread';
import {
  effortLabel,
  formatElapsed,
  lastUsedThread,
  listTitle,
  providerLabel,
  recentFolders,
  skillGroup,
  skillSourceLabel,
  starterSkills,
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
    expect(skillGroup(skill('a', 'project-agents'))).toBe('Project');
    expect(skillGroup(skill('b', 'user-codex'))).toBe('User');
    expect(skillGroup(skill('c', 'user-claude', '/agent-os:c'))).toBe('Plugins');
    expect(skillGroup(skill('d', 'custom'))).toBe('Other');
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
