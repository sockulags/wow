import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

// The folder of a main thread with no project and no folder of its own (orchestrator threads
// spec 1): `<wow home>/threads/<threadId>`. Not a setting, like the assistant's folder: it must
// start empty, so nothing an agent reads there was put there before it.
export const threadFolderOf = (home: string, threadId: string): string =>
  path.join(home, 'threads', threadId);

// Makes the folder before the thread's first turn and refuses one that holds anything, naming
// what it found.
export async function prepareThreadFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const found = await readdir(folder);
  if (found.length > 0) {
    throw new Error(
      `The thread's folder ${folder} must be empty before its first turn and holds ${found.length === 1 ? 'a file' : `${found.length} files`} (${found.slice(0, 3).join(', ')}). Move them away, then send the message again.`,
    );
  }
}
