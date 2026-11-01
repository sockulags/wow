import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { SkillRoot } from './scan.js';

interface InstalledPlugin {
  readonly key: string;
  readonly installPath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

const installPathOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry['installPath'] === 'string' ? entry['installPath'] : undefined;

// `plugins/installed_plugins.json` maps "plugin@marketplace" to one install (version 1) or a list
// of installs (version 2). The last listed install is the one in use.
function fromInstalledFile(data: unknown): InstalledPlugin[] | undefined {
  if (!isRecord(data) || !isRecord(data['plugins'])) return undefined;
  const found: InstalledPlugin[] = [];
  for (const [key, value] of Object.entries(data['plugins'])) {
    const entries = Array.isArray(value) ? value : [value];
    const installPath = entries.map(installPathOf).findLast((entry) => entry !== undefined);
    if (installPath) found.push({ key, installPath });
  }
  return found;
}

const childDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

const byVersion = new Intl.Collator('en', { numeric: true }).compare;

// Without installed_plugins.json, take the newest version folder of every plugin in the cache
// (plugins/cache/<marketplace>/<plugin>/<version>).
async function fromCache(cache: string): Promise<InstalledPlugin[]> {
  const found: InstalledPlugin[] = [];
  for (const marketplace of (await childDirs(cache)).toSorted()) {
    for (const plugin of (await childDirs(path.join(cache, marketplace))).toSorted()) {
      const versions = (await childDirs(path.join(cache, marketplace, plugin))).toSorted(byVersion);
      const newest = versions.at(-1);
      if (newest) {
        found.push({
          key: `${plugin}@${marketplace}`,
          installPath: path.join(cache, marketplace, plugin, newest),
        });
      }
    }
  }
  return found;
}

// Skill folders of the Claude plugins installed under a Claude config directory (~/.claude).
export async function claudePluginRoots(claudeDir: string): Promise<SkillRoot[]> {
  const plugins = path.join(claudeDir, 'plugins');
  const installed =
    fromInstalledFile(await readJson(path.join(plugins, 'installed_plugins.json'))) ??
    (await fromCache(path.join(plugins, 'cache')));
  const roots: SkillRoot[] = [];
  for (const { key, installPath } of installed) {
    const manifest = await readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
    const declared =
      isRecord(manifest) && typeof manifest['name'] === 'string' ? manifest['name'] : '';
    const plugin = declared !== '' ? declared : (key.split('@')[0] ?? key);
    roots.push({ dir: path.join(installPath, 'skills'), source: 'user-claude', plugin });
  }
  return roots;
}
