import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';

// Finding 143: on the Windows runner a seeded project folder stayed held (EBUSY) after
// everything inside it was gone. The seeding checks whether the emptied folder is held and, when
// it is, writes which processes could hold it, so one CI run names the holder. Neither wmic
// nor tasklist reports a working directory: wmic gives command lines, where `git -C <folder>`
// names the folder, and tasklist (when wmic is not installed) at least names the git and node
// processes still running.

const run = (command: string, args: string[]): string | undefined => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

export function describeFolderHolders(folder: string): string {
  const wanted = [folder, folder.replaceAll('\\', '/')].map((name) => name.toLowerCase());
  const processes = run('wmic', [
    'process',
    'get',
    'ProcessId,ParentProcessId,Name,CommandLine',
    '/format:csv',
  ]);
  if (processes !== undefined) {
    const lines = processes
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .filter((line) => {
        const lower = line.toLowerCase();
        return wanted.some((name) => lower.includes(name)) || /\b(git|git-\w+)\.exe\b/.test(lower);
      });
    return lines.length === 0 ? 'wmic: no process names the folder or is a git' : lines.join('\n');
  }
  const tasks = [
    run('tasklist', ['/v', '/fo', 'csv', '/fi', 'IMAGENAME eq git.exe']),
    run('tasklist', ['/v', '/fo', 'csv', '/fi', 'IMAGENAME eq node.exe']),
  ].filter((text) => text !== undefined);
  return tasks.length === 0 ? 'neither wmic nor tasklist could run' : tasks.join('\n');
}

// On Windows a process whose working directory is the folder keeps it from being removed or
// renamed. A rename there and straight back tells whether something holds it without removing it:
// a removed folder that a watcher still has open stays pending and could not be made again. A
// refusal is written out with the possible holders and the folder is left as it is.
export function reportFolderHolders(folder: string): void {
  if (process.platform !== 'win32') return;
  const probe = `${folder}.probe`;
  try {
    renameSync(folder, probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(
      `[e2e] ${folder} is held (${code ?? 'unknown'}); processes that may hold it:\n${describeFolderHolders(folder)}\n`,
    );
    return;
  }
  renameSync(probe, folder);
}
