import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, dpapiProtector, plainProtector, secretsFileName } from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-secrets-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SecretStore', () => {
  it('stores, lists, reads and deletes values and hands out references', async () => {
    const store = new SecretStore({ dir, protector: plainProtector });
    expect(await store.set('jira.token', 's3cret')).toEqual({ secretRef: 'jira.token' });
    await store.set('github.token', 'other');
    expect(await store.names()).toEqual(['github.token', 'jira.token']);
    expect(await store.resolve({ secretRef: 'jira.token' })).toBe('s3cret');
    expect(await store.delete('jira.token')).toBe(true);
    expect(await store.delete('jira.token')).toBe(false);
    expect(await store.get('jira.token')).toBeUndefined();
  });

  it('keeps every concurrent write', async () => {
    const store = new SecretStore({ dir, protector: plainProtector });
    await Promise.all(['a', 'b', 'c', 'd'].map((name) => store.set(name, name)));
    expect(await store.names()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses to mix protections in one file', async () => {
    await new SecretStore({ dir, protector: plainProtector }).set('a', 'x');
    const other = new SecretStore({
      dir,
      protector: { ...plainProtector, kind: 'dpapi' },
    });
    await expect(other.get('a')).rejects.toThrow(/none protection/);
    await expect(other.set('b', 'y')).rejects.toThrow(/none protection/);
  });

  it.runIf(process.platform !== 'win32')('writes the file with mode 0600 on POSIX', async () => {
    const store = new SecretStore({ dir: path.join(dir, 'home'), protector: plainProtector });
    await store.set('token', 'value');
    const file = path.join(dir, 'home', secretsFileName);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await store.set('token', 'changed');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')(
    'protects values with DPAPI on Windows',
    async () => {
      const store = new SecretStore({ dir, protector: dpapiProtector() });
      await store.set('token', 'plain-value-ä');
      const raw = await readFile(path.join(dir, secretsFileName), 'utf8');
      expect(raw).toContain('"protection": "dpapi"');
      expect(raw).not.toContain('plain-value');
      expect(await store.get('token')).toBe('plain-value-ä');
    },
    30_000,
  );
});
