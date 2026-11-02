import type { ProviderFolder } from '@wow/contracts';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Claude Code keeps one folder per working directory under `<config dir>/projects`, named after
// the directory with every character that is not a letter or digit replaced by `-`, and one
// `<session>.jsonl` per session in it. Message lines carry the session's `cwd`. The name alone
// cannot be decoded reliably (`my-app` and `my/app` give the same name), so the `cwd` in the
// newest session wins and the name is only a fallback.

async function firstCwd(file: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && 'cwd' in parsed) {
          const { cwd } = parsed;
          if (typeof cwd === 'string' && cwd !== '') return cwd;
        }
      } catch {
        // A line cut off by a crash; the next one may still say where the session ran.
      }
    }
    return undefined;
  } finally {
    lines.close();
  }
}

// `-home-me-code-wow` → `/home/me/code/wow`; `C--Users-me-code-wow` → `C:\Users\me\code\wow`.
export function decodeClaudeProjectName(name: string): string | undefined {
  const drive = /^([A-Za-z])--(.*)$/.exec(name);
  if (drive) return `${drive[1]}:\\${(drive[2] ?? '').replaceAll('-', '\\')}`;
  if (name.startsWith('-')) return `/${name.slice(1).replaceAll('-', '/')}`;
  return undefined;
}

export async function discoverClaudeFolders(configDir: string): Promise<ProviderFolder[]> {
  const root = path.join(configDir, 'projects');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const folders: ProviderFolder[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const sessions = await Promise.all(
      (await readdir(dir).catch(() => []))
        .filter((file) => file.endsWith('.jsonl'))
        .map(async (file) => {
          const full = path.join(dir, file);
          const info = await stat(full).catch(() => undefined);
          return info?.isFile() ? { file: full, modified: info.mtime } : undefined;
        }),
    );
    const newestFirst = sessions
      .filter((session) => session !== undefined)
      .toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
    let cwd: string | undefined;
    for (const session of newestFirst) {
      cwd = await firstCwd(session.file).catch(() => undefined);
      if (cwd) break;
    }
    cwd ??= decodeClaudeProjectName(entry.name);
    if (!cwd) continue;
    folders.push({ cwd, lastUsedAt: newestFirst[0]?.modified.toISOString() ?? null });
  }
  return folders;
}
