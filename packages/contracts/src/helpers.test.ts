import { describe, expect, it } from 'vitest';
import { helperDepth, helperPermissionMode, helperTree } from './helpers.js';

// A helper's permission mode (agent orchestration spec 6): never wider than its main thread's.

describe('helperPermissionMode', () => {
  it("keeps the main thread's mode on the same provider", () => {
    expect(helperPermissionMode({ kind: 'claude', mode: 'plan' }, 'claude')).toBe('plan');
    expect(helperPermissionMode({ kind: 'codex', mode: 'full-access' }, 'codex')).toBe(
      'full-access',
    );
  });

  it('takes the widest mode of the other provider that reaches no further', () => {
    expect(helperPermissionMode({ kind: 'claude', mode: 'plan' }, 'codex')).toBe('read-only');
    expect(helperPermissionMode({ kind: 'claude', mode: 'default' }, 'codex')).toBe('untrusted');
    expect(helperPermissionMode({ kind: 'claude', mode: 'acceptEdits' }, 'codex')).toBe('auto');
    expect(helperPermissionMode({ kind: 'claude', mode: 'auto' }, 'codex')).toBe('auto');
    expect(helperPermissionMode({ kind: 'codex', mode: 'read-only' }, 'claude')).toBe('plan');
    expect(helperPermissionMode({ kind: 'codex', mode: 'untrusted' }, 'claude')).toBe('default');
    expect(helperPermissionMode({ kind: 'codex', mode: 'auto' }, 'claude')).toBe('acceptEdits');
  });

  it('gives a dangerous mode only to a main thread that has one', () => {
    expect(helperPermissionMode({ kind: 'codex', mode: 'full-access' }, 'claude')).toBe(
      'bypassPermissions',
    );
    expect(helperPermissionMode({ kind: 'claude', mode: 'bypassPermissions' }, 'codex')).toBe(
      'full-access',
    );
  });
});

// A thread's depth and the helpers under it (orchestrator threads spec 4, 8, 36).
describe('helperDepth and helperTree', () => {
  const parents: Record<string, string | null> = { main: null, a: 'main', b: 'a', c: 'main' };
  const children = (id: string) =>
    Object.entries(parents)
      .filter(([, parent]) => parent === id)
      .map(([child]) => ({ id: child }));

  it('counts the levels up to the main thread, and a stored helper is one down', () => {
    expect(helperDepth('main', (id) => parents[id])).toBe(0);
    expect(helperDepth('a', (id) => parents[id])).toBe(1);
    expect(helperDepth('b', (id) => parents[id])).toBe(2);
  });

  it('stops at a chain that loops', () => {
    const loop: Record<string, string> = { x: 'y', y: 'x' };
    expect(helperDepth('x', (id) => loop[id])).toBe(1);
  });

  it('lists every helper under a thread, nearest first, with its depth', () => {
    expect(helperTree('main', children)).toEqual([
      { thread: { id: 'a' }, depth: 1 },
      { thread: { id: 'c' }, depth: 1 },
      { thread: { id: 'b' }, depth: 2 },
    ]);
  });
});
