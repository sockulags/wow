import { spawn } from 'node:child_process';

// What stopping a process needs of it.
export interface Stoppable {
  readonly pid?: number | undefined;
  kill(): boolean;
}

export type StopProcess = (child: Stoppable) => void;

type RunTaskkill = (
  command: string,
  args: string[],
) => { on(event: 'error', listener: () => void): unknown } & {
  on(event: 'close', listener: (code: number | null) => void): unknown;
};

const runTaskkill: RunTaskkill = (command, args) =>
  spawn(command, args, { windowsHide: true, stdio: 'ignore' });

// On Windows `git` is often Git for Windows' cmd\git.exe, which starts the real git.exe and waits
// for it. Killing the wrapper alone leaves the real git running with the folder as its working
// directory, which holds the folder, so the whole tree is stopped.
export function stopProcessTree(
  platform: NodeJS.Platform = process.platform,
  run: RunTaskkill = runTaskkill,
): StopProcess {
  return (child) => {
    if (platform !== 'win32' || child.pid === undefined) {
      child.kill();
      return;
    }
    const taskkill = run('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    taskkill.on('error', () => child.kill());
    taskkill.on('close', (code) => {
      if (code !== 0) child.kill();
    });
  };
}
