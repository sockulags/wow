import { npmInstallCommand } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { codexUpdateOffer, detectCodexInstall, findOnPath, type InstallIo } from './install.js';

// Invented machines: the files that exist, and where links point.
const machine = (
  platform: NodeJS.Platform,
  files: readonly string[],
  links: Record<string, string> = {},
  env: Record<string, string> = {},
): InstallIo => {
  const known = new Set(files.map((file) => (platform === 'win32' ? file.toLowerCase() : file)));
  return {
    platform,
    env,
    exists: (file) => known.has(platform === 'win32' ? file.toLowerCase() : file),
    realpath: (file) => links[file] ?? file,
  };
};

const appData = 'C:\\Users\\demo\\AppData\\Roaming\\npm';

describe('detectCodexInstall', () => {
  it('finds the npm shim on Windows, also through PATH and PATHEXT', () => {
    const io = machine(
      'win32',
      [`${appData}\\codex.cmd`, `${appData}\\node_modules\\@openai\\codex\\package.json`],
      {},
      { Path: `C:\\Windows;${appData}`, PATHEXT: '.COM;.EXE;.CMD' },
    );
    expect(detectCodexInstall(`${appData}\\codex.cmd`, io)).toEqual({
      method: 'npm',
      binary: `${appData}\\codex.cmd`,
      prefix: appData,
    });
    expect(findOnPath('codex', io)).toBe(`${appData}\\codex.cmd`);
    expect(detectCodexInstall('', io)).toMatchObject({ method: 'npm', prefix: appData });
  });

  it('finds the npm package from a path inside it on Windows', () => {
    const exe = `${appData}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
    const io = machine('win32', [exe, `${appData}\\codex.cmd`]);
    expect(detectCodexInstall(exe, io)).toMatchObject({ method: 'npm', prefix: appData });
    // A project's own node_modules is not a global install.
    const local = 'C:\\work\\demo\\node_modules\\@openai\\codex\\bin\\codex.js';
    expect(detectCodexInstall(local, machine('win32', [local]))).toMatchObject({
      method: 'standalone',
    });
  });

  it('follows the npm link on POSIX', () => {
    const io = machine(
      'linux',
      ['/usr/local/bin/codex'],
      { '/usr/local/bin/codex': '/usr/local/lib/node_modules/@openai/codex/bin/codex.js' },
      { PATH: '/usr/bin:/usr/local/bin' },
    );
    expect(detectCodexInstall('codex', io)).toEqual({
      method: 'npm',
      binary: '/usr/local/bin/codex',
      prefix: '/usr/local',
    });
  });

  it('finds an npm prefix from its bin folder when the link cannot be read', () => {
    const io = machine('darwin', [
      '/Users/demo/.npm-global/bin/codex',
      '/Users/demo/.npm-global/lib/node_modules/@openai/codex/package.json',
    ]);
    expect(detectCodexInstall('/Users/demo/.npm-global/bin/codex', io)).toMatchObject({
      method: 'npm',
      prefix: '/Users/demo/.npm-global',
    });
  });

  it('tells Homebrew, standalone binaries, local installs and a missing codex apart', () => {
    const brew = machine('darwin', ['/opt/homebrew/bin/codex'], {
      '/opt/homebrew/bin/codex': '/opt/homebrew/Caskroom/codex/0.164.0/codex-aarch64-apple-darwin',
    });
    expect(detectCodexInstall('/opt/homebrew/bin/codex', brew)).toMatchObject({
      method: 'homebrew',
    });
    const standalone = machine('linux', ['/home/demo/bin/codex']);
    expect(detectCodexInstall('/home/demo/bin/codex', standalone)).toEqual({
      method: 'standalone',
      binary: '/home/demo/bin/codex',
    });
    const local = '/work/demo/node_modules/@openai/codex/bin/codex.js';
    expect(detectCodexInstall(local, machine('linux', [local]))).toMatchObject({
      method: 'standalone',
    });
    expect(detectCodexInstall('', machine('linux', [], {}, { PATH: '/usr/bin' }))).toEqual({
      method: 'notFound',
    });
  });
});

describe('codexUpdateOffer', () => {
  const npm = { method: 'npm', binary: `${appData}\\codex.cmd`, prefix: appData } as const;

  it('runs npm install -g when npm installs to the same prefix', () => {
    const offer = codexUpdateOffer({
      install: npm,
      targetVersion: '0.166.0',
      reason: 'incompatible',
      npmGlobalPrefix: 'c:\\users\\demo\\appdata\\roaming\\npm',
      platform: 'win32',
    });
    expect(offer).toEqual({
      method: 'npm',
      targetVersion: '0.166.0',
      reason: 'incompatible',
      packageSpec: '@openai/codex@0.166.0',
      prefix: null,
    });
    if (offer.method !== 'npm') throw new Error('expected an npm offer');
    expect(npmInstallCommand(offer)).toBe('npm install -g @openai/codex@0.166.0');
  });

  it('names the prefix when npm on PATH installs elsewhere', () => {
    const offer = codexUpdateOffer({
      install: npm,
      targetVersion: '0.166.0',
      reason: 'older',
      npmGlobalPrefix: 'C:\\Program Files\\nodejs',
      platform: 'win32',
    });
    if (offer.method !== 'npm') throw new Error('expected an npm offer');
    expect(npmInstallCommand(offer)).toBe(
      `npm install -g @openai/codex@0.166.0 --prefix "${appData}"`,
    );
  });

  it('gives an instruction when wow cannot run the update', () => {
    const base = { targetVersion: '0.166.0', reason: 'older', platform: 'darwin' } as const;
    expect(codexUpdateOffer({ ...base, install: npm, npmGlobalPrefix: null })).toMatchObject({
      method: 'manual',
      instruction: expect.stringContaining('cannot find npm'),
    });
    expect(
      codexUpdateOffer({
        ...base,
        install: { method: 'homebrew', binary: '/opt/homebrew/bin/codex' },
        npmGlobalPrefix: '/opt/homebrew',
      }),
    ).toMatchObject({
      method: 'manual',
      instruction: expect.stringContaining('brew upgrade codex'),
    });
    expect(
      codexUpdateOffer({
        ...base,
        install: { method: 'standalone', binary: '/home/demo/bin/codex' },
        npmGlobalPrefix: null,
      }),
    ).toMatchObject({
      method: 'manual',
      instruction: expect.stringContaining('Replace /home/demo/bin/codex with codex 0.166.0'),
    });
  });
});
