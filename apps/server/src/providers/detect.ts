import { ProviderKind, providerSetup, type DetectedProvider } from '@wow/contracts';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface DetectOptions {
  readonly env: Record<string, string | undefined>;
  readonly platform: NodeJS.Platform;
}

// Windows resolves `claude` to `claude.cmd` or `claude.exe` through PATHEXT; elsewhere the file
// itself must be executable.
const windowsExtensions = (env: Record<string, string | undefined>): string[] =>
  (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => extension.toLowerCase());

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findOnPath(name: string, options: DetectOptions): Promise<string | null> {
  const { env, platform } = options;
  // Windows environment keys are case-insensitive; Node keeps whichever spelling the OS used.
  const pathValue =
    env['PATH'] ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? windowsExtensions(env).map((ext) => name + ext) : [name];
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (await isExecutable(file, platform)) return file;
    }
  }
  return null;
}

// What the first-run wizard offers: each provider CLI found on PATH and the config directory it
// would use without CLAUDE_CONFIG_DIR or CODEX_HOME given to it.
export async function detectProviders(options: DetectOptions): Promise<DetectedProvider[]> {
  const home = options.env['USERPROFILE'] ?? options.env['HOME'] ?? homedir();
  return Promise.all(
    ProviderKind.options.map(async (kind) => {
      const setup = providerSetup[kind];
      return {
        kind,
        binaryPath: await findOnPath(setup.binaryName, options),
        configDir: options.env[setup.configDirEnv] || path.join(home, setup.defaultConfigDir),
      };
    }),
  );
}
