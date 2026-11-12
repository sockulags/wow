import { describe, expect, it } from 'vitest';
import { proposeRule, ruleCovers, ruleText, type AlwaysAllowRule } from './approvals.js';
import { diffCounts } from './diff.js';

const at = '2026-11-02T08:00:00.000Z';

describe('always allow rules (agent workbench spec 38, 39)', () => {
  it('proposes the first words of a command, or the prefix the provider proposed', () => {
    expect(proposeRule('command', { command: 'pnpm test --watch' })).toEqual({
      kind: 'command',
      prefix: 'pnpm test',
    });
    expect(proposeRule('command', { command: 'ls -la' })).toEqual({
      kind: 'command',
      prefix: 'ls',
    });
    expect(
      proposeRule('command', { command: 'cargo build --release', ruleHint: 'cargo build' }),
    ).toEqual({ kind: 'command', prefix: 'cargo build' });
    // A hint that is not a prefix of the command is not taken.
    expect(proposeRule('command', { command: 'git status', ruleHint: 'rm' })).toEqual({
      kind: 'command',
      prefix: 'git status',
    });
  });

  it('offers no rule for edits, plans, chained commands or a tool without a name', () => {
    expect(proposeRule('fileChange', { kind: 'edit', path: 'a.ts' })).toBeUndefined();
    expect(proposeRule('plan', { plan: 'x' })).toBeUndefined();
    expect(proposeRule('command', { command: 'pnpm test && rm -rf /' })).toBeUndefined();
    expect(proposeRule('command', { command: 'echo $(whoami)' })).toBeUndefined();
    expect(proposeRule('tool', { kind: 'other' })).toBeUndefined();
    expect(proposeRule('command', undefined)).toBeUndefined();
  });

  it('covers a command by whole words of its prefix and a tool by its name', () => {
    const tests: AlwaysAllowRule = { kind: 'command', prefix: 'pnpm test', addedAt: at };
    expect(ruleCovers(tests, 'command', { command: 'pnpm test' })).toBe(true);
    expect(ruleCovers(tests, 'command', { command: 'pnpm   test --watch' })).toBe(true);
    expect(ruleCovers(tests, 'command', { command: 'pnpm tests' })).toBe(false);
    expect(ruleCovers(tests, 'command', { command: 'pnpm test; rm -rf /' })).toBe(false);
    expect(ruleCovers(tests, 'fileChange', { command: 'pnpm test' })).toBe(false);
    const issue: AlwaysAllowRule = {
      kind: 'tool',
      server: 'github',
      tool: 'create_issue',
      addedAt: at,
    };
    expect(ruleCovers(issue, 'tool', { server: 'github', tool: 'create_issue' })).toBe(true);
    expect(ruleCovers(issue, 'tool', { server: 'gitlab', tool: 'create_issue' })).toBe(false);
    expect(ruleCovers(issue, 'tool', { tool: 'create_issue' })).toBe(false);
  });

  it('words each rule as the card and Settings show it', () => {
    expect(ruleText({ kind: 'command', prefix: 'pnpm test' })).toBe(
      'Run commands starting with `pnpm test`',
    );
    expect(ruleText({ kind: 'tool', server: 'github', tool: 'create_issue' })).toBe(
      'Use the tool `github › create_issue`',
    );
    expect(ruleText({ kind: 'tool', server: null, tool: 'WebFetch' })).toBe(
      'Use the tool `WebFetch`',
    );
  });
});

describe('diffCounts (spec 33)', () => {
  it('counts added and removed lines, not headers, and not a removed line that looks like one', () => {
    expect(diffCounts('@@ -1,2 +1,2 @@\n a\n-b\n+c')).toEqual({ added: 1, removed: 1 });
    expect(
      diffCounts(
        '--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n--- not a header\n-b\n+c\n\\ No newline at end of file',
      ),
    ).toEqual({ added: 1, removed: 2 });
    expect(diffCounts('')).toEqual({ added: 0, removed: 0 });
  });
});
