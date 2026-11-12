import { describe, expect, it } from 'vitest';
import {
  proposeRule,
  ruleCovers,
  ruleText,
  shellInner,
  type AlwaysAllowRule,
} from './approvals.js';
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

  it('offers no rule for a shell or another program that runs what it is handed', () => {
    for (const command of [
      "/bin/bash -lc 'pnpm test --watch'",
      'bash -lc "pnpm test"',
      'powershell.exe -NoProfile -Command "pnpm test"',
      'C:\\Windows\\System32\\cmd.exe /c pnpm test',
      'sudo pnpm test',
      'env FOO=1 pnpm test',
      'xargs rm',
      "node -e 'process.exit(1)'",
    ]) {
      expect([command, proposeRule('command', { command, ruleHint: 'pnpm test' })]).toEqual([
        command,
        undefined,
      ]);
    }
    expect(proposeRule('command', { command: 'git status', ruleHint: 'bash' })).toEqual({
      kind: 'command',
      prefix: 'git status',
    });
  });

  it('offers no rule for a command behind variables or a runner that runs what it is handed', () => {
    for (const command of [
      'FOO=1 bash x.sh',
      'FOO=1 pnpm test',
      'busybox sh x',
      'pnpm exec bash x.sh',
      'pnpm dlx cowsay hi',
      'npm exec cowsay',
      'yarn dlx cowsay',
      'npx cowsay',
      'find . -exec rm x +',
      'find . -name x -execdir rm {} +',
      'node -e process.exit(1)',
      'node --eval x',
      'python3 -c print(1)',
      'python -m http.server',
      'npx.cmd cowsay',
      'NPX.CMD cowsay',
      'pnpm.cmd exec bash x.sh',
      'bash.bat x',
      'pnpm --silent exec bash x.sh',
      'pnpm -C dir exec bash x',
      'npm --yes exec cowsay',
      'yarn bash',
      'yarn --silent bash x.sh',
      'pnpm node -e x',
      'python3.12 -c x',
      'python3.12.cmd -c x',
      'deno eval x',
      'tsx -e x',
      'ts-node -e x',
      'find . -exec=rm',
      'fd x --exec=rm',
      'pnpm --filter web --silent exec bash x.sh',
      'pnpm -C dir --silent exec bash x',
      'pnpm --filter web -r exec bash x',
      'uv --project a --quiet run python -c x',
      'yarn workspace web exec bash x.sh',
      'yarn workspace web bash x.sh',
      'pnpm -- exec bash x',
    ]) {
      expect([command, proposeRule('command', { command })]).toEqual([command, undefined]);
    }
    const node: AlwaysAllowRule = { kind: 'command', prefix: 'node', addedAt: at };
    expect(ruleCovers(node, 'command', { command: 'node -e process.exit(1)' })).toBe(false);
    const pnpm: AlwaysAllowRule = { kind: 'command', prefix: 'pnpm', addedAt: at };
    expect(ruleCovers(pnpm, 'command', { command: 'pnpm --silent exec bash x.sh' })).toBe(false);
    expect(
      ruleCovers(pnpm, 'command', { command: 'pnpm --filter web --silent exec bash x.sh' }),
    ).toBe(false);
    expect(ruleCovers(pnpm, 'command', { command: 'pnpm --version' })).toBe(true);
    expect(proposeRule('command', { command: 'pnpm test -- --grep node' })).toEqual({
      kind: 'command',
      prefix: 'pnpm test',
    });
    expect(proposeRule('command', { command: 'pnpm add -D tsx' })).toEqual({
      kind: 'command',
      prefix: 'pnpm add',
    });
    const find: AlwaysAllowRule = { kind: 'command', prefix: 'find .', addedAt: at };
    expect(ruleCovers(find, 'command', { command: 'find . -exec rm x +' })).toBe(false);
    // A script a runner is not involved in still gets its rule.
    expect(proposeRule('command', { command: 'node scripts/build.mjs' })).toEqual({
      kind: 'command',
      prefix: 'node scripts/build.mjs',
    });
    expect(proposeRule('command', { command: 'pnpm --filter web test' })).toEqual({
      kind: 'command',
      prefix: 'pnpm',
    });
    expect(proposeRule('command', { command: 'pnpm.cmd test' })).toEqual({
      kind: 'command',
      prefix: 'pnpm.cmd test',
    });
    expect(proposeRule('command', { command: 'find . -name x' })).toEqual({
      kind: 'command',
      prefix: 'find .',
    });
  });

  it('reads the command a shell line runs (Codex reports the shell line)', () => {
    expect(shellInner("/bin/zsh -lc 'pnpm test --watch'")).toBe('pnpm test --watch');
    expect(shellInner('bash -c "pnpm test"')).toBe('pnpm test');
    expect(shellInner('powershell.exe -NoProfile -Command "pnpm test"')).toBe('pnpm test');
    expect(shellInner('C:\\Windows\\System32\\cmd.exe /c "pnpm test"')).toBe('pnpm test');
    expect(shellInner('pnpm test')).toBeUndefined();
    expect(shellInner("bash -lc 'pnpm test' && rm -rf ~")).toBeUndefined();
    expect(shellInner("node -c 'x'")).toBeUndefined();
    expect(shellInner("cmd -lc 'x'")).toBeUndefined();
    expect(shellInner("bash -lc ''")).toBeUndefined();
  });

  it('reads the shell lines Codex reports on Windows', () => {
    expect(shellInner('cmd.exe /d /s /c "pnpm test"')).toBe('pnpm test');
    expect(shellInner('C:\\Windows\\System32\\cmd.exe /S /C "pnpm test"')).toBe('pnpm test');
    expect(
      shellInner('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "pnpm test"'),
    ).toBe('pnpm test');
    expect(shellInner("'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -Command 'pnpm test'")).toBe(
      'pnpm test',
    );
    expect(shellInner('"C:\\Program Files\\Tools\\node.exe" /c "x"')).toBeUndefined();
    expect(shellInner('bash /d -c "x"')).toBeUndefined();
  });

  it('covers a command by whole words of its prefix and a tool by its name', () => {
    const tests: AlwaysAllowRule = { kind: 'command', prefix: 'pnpm test', addedAt: at };
    expect(ruleCovers(tests, 'command', { command: 'pnpm test' })).toBe(true);
    expect(ruleCovers(tests, 'command', { command: 'pnpm   test --watch' })).toBe(true);
    expect(ruleCovers(tests, 'command', { command: 'pnpm tests' })).toBe(false);
    expect(ruleCovers(tests, 'command', { command: 'pnpm test; rm -rf /' })).toBe(false);
    expect(ruleCovers(tests, 'fileChange', { command: 'pnpm test' })).toBe(false);
    const shell: AlwaysAllowRule = { kind: 'command', prefix: '/bin/bash', addedAt: at };
    expect(ruleCovers(shell, 'command', { command: "/bin/bash -lc 'rm -rf ~/work'" })).toBe(false);
    expect(ruleCovers(tests, 'command', { command: 'pnpm test "a b"' })).toBe(false);
    // Case counts, also on Windows: a rule never covers more than it says (docs/architecture.md).
    expect(ruleCovers(tests, 'command', { command: 'Pnpm test' })).toBe(false);
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
