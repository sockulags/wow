export const newProjectId = () => `project-${globalThis.crypto.randomUUID().slice(0, 8)}`;

// The server refuses a name another project has, ignoring case, so an imported folder whose name
// is taken gets a number: `wow`, `wow 2`, `wow 3`.
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  let n = 2;
  while (used.has(`${name} ${n}`.toLowerCase())) n += 1;
  return `${name} ${n}`;
}

// The last segment of a folder path, as the default project name: C:\code\wow gives wow.
export function folderName(folder: string): string {
  const trimmed = folder.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}
