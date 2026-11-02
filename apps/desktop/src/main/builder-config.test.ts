import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// electron-builder.yml for auto-update (plan U17). The publish provider is what makes `dist` write
// latest.yml and the .blockmap next to the installer and app-update.yml into the packaged app; the
// desktop-installer CI job checks the files exist after `dist` on windows-latest.

const config = parse(
  await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('electron-builder.yml', () => {
  it('publishes to GitHub Releases of sockulags/wow, stable releases only', () => {
    expect(config['publish']).toEqual({
      provider: 'github',
      owner: 'sockulags',
      repo: 'wow',
      releaseType: 'release',
    });
  });

  it('builds the per-user NSIS installer that latest.yml points at, and never publishes itself', async () => {
    expect(config['nsis']).toMatchObject({
      perMachine: false,
      artifactName: 'wow-setup-${version}.${ext}',
    });
    expect(config['win']).toMatchObject({ target: [{ target: 'nsis', arch: ['x64'] }] });
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['dist']).toMatch(/--publish never/);
  });
});
