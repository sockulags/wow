import path from 'node:path';

// One key per folder: on Windows and macOS the same folder may be spelled in another case or with
// other separators.
export function folderKey(folder: string, platform: NodeJS.Platform): string {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(folder);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}
