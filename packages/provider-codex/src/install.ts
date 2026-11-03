import type { ProviderUpdate } from '@wow/contracts';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

// How the codex binary of an instance was installed, which decides how wow offers to update it.
// Only an npm install is updated by wow itself (`npm install -g @openai/codex@<version>`).
export type CodexInstall =
  | { readonly method: 'npm'; readonly binary: string; readonly prefix: string }
  | { readonly method: 'homebrew'; readonly binary: string }
  | { readonly method: 'standalone'; readonly binary: string }
  | { readonly method: 'notFound' };

export const codexNpmPackage = '@openai/codex';

export interface InstallIo {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (file: string) => boolean;
  // The file a symlink points at; the path itself when it is no link or cannot be read.
  readonly realpath: (file: string) => string;
}

export const systemInstallIo: InstallIo = {
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  realpath: (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  },
};

const pathsFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

const envValue = (env: InstallIo['env'], name: string): string | undefined => {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

// The file a bare command name runs, the way the shell finds it (PATHEXT on Windows).
export function findOnPath(name: string, io: InstallIo): string | null {
  const paths = pathsFor(io.platform);
  const dirs = (envValue(io.env, 'PATH') ?? '').split(paths.delimiter).filter(Boolean);
  const extensions =
    io.platform === 'win32'
      ? (envValue(io.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [''];
  for (const dir of dirs)
    for (const ext of extensions) {
      const candidate = paths.join(dir, `${name}${ext}`);
      if (io.exists(candidate)) return candidate;
    }
  return null;
}

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => {
  const paths = pathsFor(platform);
  const left = paths.resolve(a);
  const right = paths.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

// The npm prefix a path inside `<prefix>/lib/node_modules/@openai/codex` (POSIX) or
// `<prefix>\node_modules\@openai\codex` (Windows) belongs to.
function prefixFromPackagePath(file: string, platform: NodeJS.Platform): string | null {
  const paths = pathsFor(platform);
  const parts = paths.normalize(file).split(paths.sep);
  const lower = parts.map((part) => (platform === 'win32' ? part.toLowerCase() : part));
  for (let index = lower.length - 3; index >= 0; index -= 1) {
    if (lower[index] !== 'node_modules' || lower[index + 1] !== '@openai') continue;
    if (lower[index + 2] !== 'codex') continue;
    let prefix = parts.slice(0, index);
    // Without lib/ it is a project's local node_modules, which `npm install -g` does not update.
    if (platform !== 'win32') {
      if (prefix.at(-1) !== 'lib') return null;
      prefix = prefix.slice(0, -1);
    }
    const joined = prefix.join(paths.sep);
    return joined === '' ? paths.sep : joined;
  }
  return null;
}

export function detectCodexInstall(binaryPath: string, io: InstallIo): CodexInstall {
  const paths = pathsFor(io.platform);
  const command = binaryPath || 'codex';
  const hasDir = command.includes('/') || (io.platform === 'win32' && command.includes('\\'));
  const binary = hasDir ? command : findOnPath(command, io);
  if (!binary) return { method: 'notFound' };
  const real = io.realpath(binary);
  const fromPackage =
    prefixFromPackagePath(real, io.platform) ?? prefixFromPackagePath(binary, io.platform);
  // On Windows a global prefix holds npm's codex.cmd shim next to node_modules; a project's local
  // node_modules does not.
  const globalPrefix =
    fromPackage && (io.platform !== 'win32' || io.exists(paths.join(fromPackage, 'codex.cmd')));
  if (fromPackage && globalPrefix) return { method: 'npm', binary, prefix: fromPackage };
  const dir = paths.dirname(binary);
  const packageIn = (prefix: string, ...layout: string[]) =>
    io.exists(paths.join(prefix, ...layout, 'node_modules', '@openai', 'codex', 'package.json'));
  // npm's shims: <prefix>\codex.cmd on Windows, <prefix>/bin/codex on POSIX (when the link
  // could not be followed).
  if (io.platform === 'win32' && packageIn(dir)) return { method: 'npm', binary, prefix: dir };
  if (io.platform !== 'win32' && paths.basename(dir) === 'bin') {
    const prefix = paths.dirname(dir);
    if (packageIn(prefix, 'lib')) return { method: 'npm', binary, prefix };
  }
  if (/[/\\](Cellar|Caskroom)[/\\]codex[/\\]/i.test(real)) return { method: 'homebrew', binary };
  return { method: 'standalone', binary };
}

export interface UpdateOfferInput {
  readonly install: CodexInstall;
  readonly targetVersion: string;
  readonly reason: ProviderUpdate['reason'];
  // What `npm prefix -g` prints with the server's PATH, or null when npm is not there.
  readonly npmGlobalPrefix: string | null;
  readonly platform: NodeJS.Platform;
}

// What Settings → Providers offers for an instance that is incompatible or older than tested.
export function codexUpdateOffer(input: UpdateOfferInput): ProviderUpdate {
  const { install, targetVersion, reason, npmGlobalPrefix, platform } = input;
  const packageSpec = `${codexNpmPackage}@${targetVersion}`;
  const npmCommand = `npm install -g ${packageSpec}`;
  const base = { targetVersion, reason };
  switch (install.method) {
    case 'npm': {
      if (npmGlobalPrefix === null)
        return {
          ...base,
          method: 'manual',
          instruction: `codex was installed with npm, but wow cannot find npm on its PATH. Run "${npmCommand}" in a terminal, then test again.`,
        };
      const prefix = samePath(npmGlobalPrefix, install.prefix, platform) ? null : install.prefix;
      return { ...base, method: 'npm', packageSpec, prefix };
    }
    case 'homebrew':
      return {
        ...base,
        method: 'manual',
        instruction: `codex was installed with Homebrew (${install.binary}). Run "brew upgrade codex", or install the tested version with "${npmCommand}" and point this instance at it, then test again.`,
      };
    case 'standalone':
      return {
        ...base,
        method: 'manual',
        instruction: `Replace ${install.binary} with codex ${targetVersion} from https://github.com/openai/codex/releases, or install it with "${npmCommand}" and point this instance at it, then test again.`,
      };
    case 'notFound':
      return {
        ...base,
        method: 'manual',
        instruction: `Install codex ${targetVersion} with "${npmCommand}", then test again.`,
      };
  }
}
