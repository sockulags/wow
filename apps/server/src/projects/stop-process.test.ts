import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readCurrentBranch, type GitProcess } from './git.js';
import { stopProcessTree, type Stoppable } from './stop-process.js';

const taskkill = () => {
  const runs: string[][] = [];
  const process = new EventEmitter();
  const run = (command: string, args: string[]) => {
    runs.push([command, ...args]);
    return process;
  };
  return { runs, process, run };
};

const output = () => {
  const stream = new EventEmitter();
  return Object.assign(stream, { setEncoding: () => stream });
};

const fakeGit = () => {
  const stdout = output();
  const child: GitProcess & EventEmitter = Object.assign(new EventEmitter(), {
    pid: 7,
    stdout,
    stderr: output(),
    kill: () => true,
  });
  return { child, stdout };
};

// Finding 143: on Windows the cmd\git.exe wrapper starts the real git.exe; killing the wrapper
// alone left the real git running with the project folder as its working directory.
describe('stopProcessTree', () => {
  it('stops the whole tree on Windows', () => {
    const { runs, process, run } = taskkill();
    const child = { pid: 42, kill: vi.fn<() => boolean>(() => true) };
    stopProcessTree('win32', run)(child);
    expect(runs).toEqual([['taskkill', '/pid', '42', '/T', '/F']]);
    process.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills the process itself when taskkill cannot stop it, and elsewhere', () => {
    const failed = taskkill();
    const child = { pid: 42, kill: vi.fn<() => boolean>(() => true) };
    stopProcessTree('win32', failed.run)(child);
    failed.process.emit('close', 128);
    expect(child.kill).toHaveBeenCalledTimes(1);

    const missing = taskkill();
    stopProcessTree('win32', missing.run)(child);
    missing.process.emit('error');
    expect(child.kill).toHaveBeenCalledTimes(2);

    const linux = taskkill();
    stopProcessTree('linux', linux.run)(child);
    expect(linux.runs).toEqual([]);
    expect(child.kill).toHaveBeenCalledTimes(3);
  });
});

describe('a git that runs out of time', () => {
  it('is stopped with its tree and waited for, but only for the stop wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stopped: Stoppable[] = [];
      const stop = (child: Stoppable) => {
        stopped.push(child);
      };
      const answers: string[] = [];
      const { child: gone, stdout } = fakeGit();
      const goneBranch = readCurrentBranch('/work/invented', {
        timeoutMs: 500,
        stopWaitMs: 2_000,
        start: () => gone,
        stop,
      }).then((branch) => answers.push('gone') && branch);
      const { child: stuck } = fakeGit();
      const stuckBranch = readCurrentBranch('/work/invented', {
        timeoutMs: 500,
        stopWaitMs: 2_000,
        start: () => stuck,
        stop,
      }).then((branch) => answers.push('stuck') && branch);
      vi.advanceTimersByTime(500);
      expect(stopped).toHaveLength(2);
      expect(stopped[0]).toBe(gone);
      expect(stopped[1]).toBe(stuck);
      await new Promise((resolve) => setImmediate(resolve));
      expect(answers).toEqual([]);
      stdout.emit('data', 'main\n');
      gone.emit('close', null);
      expect(await goneBranch).toBeNull();
      expect(answers).toEqual(['gone']);
      vi.advanceTimersByTime(2_000);
      expect(await stuckBranch).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
