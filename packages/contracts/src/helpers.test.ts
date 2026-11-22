import { describe, expect, it } from 'vitest';
import { helperPermissionMode } from './helpers.js';

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
