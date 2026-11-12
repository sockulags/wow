import type {
  Project,
  ProviderInstance,
  ProviderKind,
  ProviderSession,
  TerminalSession,
  Thread,
} from '@wow/contracts';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// "Open session from Claude Code / Codex…" (agent workbench spec 72). Each adapter package reads
// its own CLI's session files; this asks every configured instance (or the one named), names the
// project a session's folder is and the wow thread that already resumes it, and says when a
// session cannot be opened because its folder is gone. Nothing is written.

export interface SessionListDeps {
  readonly instances: readonly ProviderInstance[];
  readonly projects: readonly Project[];
  readonly threads: readonly Pick<Thread, 'id' | 'providerInstanceId' | 'providerSessionId'>[];
  readonly defaultConfigDir: (kind: ProviderKind) => string;
  readonly list: Readonly<
    Record<
      ProviderKind,
      (
        configDir: string,
        options: { readonly limit: number; readonly promptChars: number },
      ) => Promise<ProviderSession[]>
    >
  >;
  readonly limit: number;
  readonly promptChars: number;
  readonly platform: NodeJS.Platform;
  readonly isFolder?: (cwd: string) => Promise<boolean>;
}

const isFolder = async (cwd: string) =>
  (await stat(cwd).catch(() => undefined))?.isDirectory() ?? false;

export const folderGone = 'Its folder is gone';

export async function listTerminalSessions(
  deps: SessionListDeps,
  providerInstanceId?: string,
): Promise<TerminalSession[]> {
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
  // The same folder on Windows and macOS may differ in case and separators.
  const key = (cwd: string) => {
    const resolved = pathApi.resolve(cwd);
    return deps.platform === 'win32' || deps.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved;
  };
  const projectOf = new Map(deps.projects.map((project) => [key(project.cwd), project]));
  const kindOf = new Map(deps.instances.map((instance) => [instance.id, instance.kind]));
  // One spelling per folder, so the dialog groups 'C:\Work\Kettle' and 'c:\work\kettle' as one:
  // the project's, else the first seen.
  const spelling = new Map<string, string>();
  const exists = deps.isFolder ?? isFolder;
  // Two instances on one config folder see the same files: each session is listed once.
  const read = new Set<string>();
  const found: TerminalSession[] = [];
  for (const instance of deps.instances) {
    if (providerInstanceId !== undefined && instance.id !== providerInstanceId) continue;
    const configDir = instance.configDir || deps.defaultConfigDir(instance.kind);
    const folderKey = `${instance.kind}\n${key(configDir)}`;
    if (read.has(folderKey)) continue;
    read.add(folderKey);
    const owned = deps.threads.filter(
      (thread) =>
        thread.providerSessionId !== null &&
        kindOf.get(thread.providerInstanceId) === instance.kind,
    );
    // wow's own threads write to the same files; the limit counts the sessions started
    // elsewhere, so those do not fall off the list for someone who mostly works in wow.
    const sessions = await deps.list[instance.kind](configDir, {
      limit: deps.limit + owned.length,
      promptChars: deps.promptChars,
    }).catch(() => []);
    let elsewhere = 0;
    for (const [index, session] of sessions.entries()) {
      if (!pathApi.isAbsolute(session.cwd)) continue;
      const thread = owned.find((candidate) => candidate.providerSessionId === session.id);
      if (thread ? index >= deps.limit : elsewhere >= deps.limit) continue;
      if (!thread) elsewhere += 1;
      const folder = key(session.cwd);
      const project = projectOf.get(folder);
      const cwd = project?.cwd ?? spelling.get(folder) ?? pathApi.resolve(session.cwd);
      spelling.set(folder, cwd);
      found.push({
        ...session,
        cwd,
        providerInstanceId: instance.id,
        providerInstanceName: instance.name,
        kind: instance.kind,
        projectId: project?.id ?? null,
        threadId: thread?.id ?? null,
        unavailable: null,
      });
    }
  }
  const checked = await Promise.all(
    found.map(async (session) =>
      (await exists(session.cwd)) ? session : { ...session, unavailable: folderGone },
    ),
  );
  return checked.toSorted(
    (a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.cwd.localeCompare(b.cwd),
  );
}
