import type { ProviderFolder } from '@wow/contracts';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Codex writes one `rollout-*.jsonl` per session under `<CODEX_HOME>/sessions/YYYY/MM/DD`. The
// first line is the session's metadata: `{"type":"session_meta","payload":{"cwd":…}}` in current
// versions, the same fields at the top level in older ones.

function cwdOf(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const holder =
    'payload' in parsed && parsed.payload && typeof parsed.payload === 'object'
      ? parsed.payload
      : parsed;
  const cwd = 'cwd' in holder ? holder.cwd : undefined;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

async function sessionCwd(file: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const cwd = cwdOf(line);
      if (cwd) return cwd;
    }
    return undefined;
  } finally {
    lines.close();
  }
}

async function sessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sessionFiles(full);
      return Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : []);
    }),
  );
  return nested.flat();
}

export async function discoverCodexFolders(codexHome: string): Promise<ProviderFolder[]> {
  const latest = new Map<string, Date>();
  for (const file of await sessionFiles(path.join(codexHome, 'sessions'))) {
    const cwd = await sessionCwd(file).catch(() => undefined);
    if (!cwd) continue;
    const modified = (await stat(file).catch(() => undefined))?.mtime;
    const seen = latest.get(cwd);
    if (modified && (!seen || modified > seen)) latest.set(cwd, modified);
    else if (!seen) latest.set(cwd, new Date(0));
  }
  return [...latest].map(([cwd, modified]) => ({
    cwd,
    lastUsedAt: modified.getTime() === 0 ? null : modified.toISOString(),
  }));
}
