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
  const projectOf = new Map(deps.projects.map((project) => [key(project.cwd), project.id]));
  const kindOf = new Map(deps.instances.map((instance) => [instance.id, instance.kind]));
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
    const sessions = await deps.list[instance.kind](configDir, {
      limit: deps.limit,
      promptChars: deps.promptChars,
    }).catch(() => []);
    for (const session of sessions) {
      if (!pathApi.isAbsolute(session.cwd)) continue;
      const thread = deps.threads.find(
        (candidate) =>
          candidate.providerSessionId === session.id &&
          kindOf.get(candidate.providerInstanceId) === instance.kind,
      );
      found.push({
        ...session,
        cwd: pathApi.resolve(session.cwd),
        providerInstanceId: instance.id,
        providerInstanceName: instance.name,
        kind: instance.kind,
        projectId: projectOf.get(key(session.cwd)) ?? null,
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
