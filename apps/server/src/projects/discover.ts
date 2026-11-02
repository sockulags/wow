import type {
  DiscoveredProject,
  Project,
  ProviderFolder,
  ProviderInstance,
  ProviderKind,
} from '@wow/contracts';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// "Import from Claude and Codex": each adapter package reads its own CLI's session files; this
// only asks every configured instance, merges folders by path, and leaves out folders that are
// gone or already a project.

export interface DiscoverDeps {
  readonly instances: readonly ProviderInstance[];
  readonly projects: readonly Project[];
  // The config directory an instance with an empty one uses (CLAUDE_CONFIG_DIR, ~/.claude, …).
  readonly defaultConfigDir: (kind: ProviderKind) => string;
  readonly discover: Readonly<
    Record<ProviderKind, (configDir: string) => Promise<ProviderFolder[]>>
  >;
  readonly platform: NodeJS.Platform;
  readonly isFolder?: (cwd: string) => Promise<boolean>;
}

const isFolder = async (cwd: string) =>
  (await stat(cwd).catch(() => undefined))?.isDirectory() ?? false;

const newer = (a: string | null, b: string | null) =>
  a === null ? b : b === null || a > b ? a : b;

export async function discoverProjects(deps: DiscoverDeps): Promise<DiscoveredProject[]> {
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
  // Windows paths differ in case and separators without naming another folder.
  const key = (cwd: string) => {
    const resolved = pathApi.resolve(cwd);
    return deps.platform === 'win32' || deps.platform === 'darwin'
      ? resolved.toLowerCase()
      : resolved;
  };
  const known = new Set(deps.projects.map((project) => key(project.cwd)));
  const found = new Map<string, DiscoveredProject>();
  for (const instance of deps.instances) {
    const configDir = instance.configDir || deps.defaultConfigDir(instance.kind);
    const folders = await deps.discover[instance.kind](configDir).catch(() => []);
    for (const folder of folders) {
      if (!pathApi.isAbsolute(folder.cwd)) continue;
      const id = key(folder.cwd);
      if (known.has(id)) continue;
      const source = {
        providerInstanceId: instance.id,
        providerInstanceName: instance.name,
        kind: instance.kind,
      };
      const seen = found.get(id);
      if (seen) {
        found.set(id, {
          ...seen,
          lastUsedAt: newer(seen.lastUsedAt, folder.lastUsedAt),
          sources: seen.sources.some((entry) => entry.providerInstanceId === instance.id)
            ? seen.sources
            : [...seen.sources, source],
        });
        continue;
      }
      const cwd = pathApi.resolve(folder.cwd);
      found.set(id, {
        cwd,
        name: pathApi.basename(cwd) || cwd,
        lastUsedAt: folder.lastUsedAt,
        sources: [source],
      });
    }
  }
  const exists = deps.isFolder ?? isFolder;
  const existing = await Promise.all(
    [...found.values()].map(async (entry) => ((await exists(entry.cwd)) ? entry : undefined)),
  );
  return existing
    .filter((entry) => entry !== undefined)
    .toSorted(
      (a, b) =>
        (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.cwd.localeCompare(b.cwd),
    );
}
