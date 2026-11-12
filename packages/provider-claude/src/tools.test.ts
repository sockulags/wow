import { ProviderEvent } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { claudeToolFacts } from './tools.js';

describe('Claude Code tool facts (agent workbench spec 27 to 29)', () => {
  it('gives Bash its command and no exit code, since Claude Code reports none', () => {
    expect(claudeToolFacts('Bash', { command: 'pnpm test', description: 'Run the tests' })).toEqual(
      { kind: 'command', command: 'pnpm test' },
    );
  });

  it('gives Read its path and lines, Grep and Glob their pattern and folder', () => {
    expect(claudeToolFacts('Read', { file_path: '/work/demo/README.md' })).toEqual({
      kind: 'read',
      path: '/work/demo/README.md',
    });
    expect(
      claudeToolFacts('Read', { file_path: '/work/demo/src/timer.ts', offset: 1, limit: 80 }),
    ).toEqual({ kind: 'read', path: '/work/demo/src/timer.ts', lines: { from: 1, to: 80 } });
    expect(claudeToolFacts('Grep', { pattern: 'kettle', path: 'src' })).toEqual({
      kind: 'search',
      pattern: 'kettle',
      path: 'src',
    });
    expect(claudeToolFacts('Glob', { pattern: '**/*.md' })).toEqual({
      kind: 'search',
      pattern: '**/*.md',
    });
  });

  it('gives WebFetch its address and WebSearch its words', () => {
    expect(claudeToolFacts('WebFetch', { url: 'https://example.org/', prompt: 'Read' })).toEqual({
      kind: 'web',
      url: 'https://example.org/',
    });
    expect(claudeToolFacts('WebSearch', { query: 'kettle descaling' })).toEqual({
      kind: 'web',
      query: 'kettle descaling',
    });
  });

  it('reads an MCP tool name as server and tool', () => {
    expect(claudeToolFacts('mcp__tracker__find_issue', { key: 'DEMO-42' })).toEqual({
      kind: 'mcp',
      server: 'tracker',
      tool: 'find_issue',
    });
    expect(claudeToolFacts('mcp__wow__read__deep', {})).toEqual({
      kind: 'mcp',
      server: 'wow',
      tool: 'read__deep',
    });
  });

  it('marks edits and writes with their file, and anything else as other', () => {
    expect(claudeToolFacts('Edit', { file_path: 'src/timer.ts' })).toEqual({
      kind: 'edit',
      path: 'src/timer.ts',
    });
    expect(claudeToolFacts('Write', { file_path: 'src/new.ts', content: '' })).toEqual({
      kind: 'edit',
      path: 'src/new.ts',
    });
    expect(
      claudeToolFacts('MultiEdit', {
        file_path: 'src/timer.ts',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: '', new_string: 'z\n' },
        ],
      }),
    ).toEqual({
      kind: 'edit',
      path: 'src/timer.ts',
      diff: '@@ -1 +1 @@\n-x\n+y\n@@ -0,0 +1 @@\n+z',
    });
    expect(claudeToolFacts('TodoWrite', { todos: [] })).toEqual({ kind: 'other' });
    expect(claudeToolFacts('Read', 'not an object')).toEqual({ kind: 'read' });
  });

  it('makes events that pass the shared contract', () => {
    const event = {
      type: 'toolCallStarted',
      threadId: 't1',
      itemId: 'toolu_1',
      name: 'Read',
      input: { file_path: 'README.md', offset: 10, limit: 5 },
      ...claudeToolFacts('Read', { file_path: 'README.md', offset: 10, limit: 5 }),
    };
    expect(ProviderEvent.parse(event)).toEqual(event);
  });
});
