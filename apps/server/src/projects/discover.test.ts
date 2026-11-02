import type { Project, ProviderInstance } from '@wow/contracts';
import { discoverClaudeFolders } from '@wow/provider-claude';
import { discoverCodexFolders } from '@wow/provider-codex';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjects } from './discover.js';

// Invented Claude and Codex homes read through the adapters' own discovery, merged here.

let root: string;

const instance = (id: string, kind: 'claude' | 'codex', configDir: string): ProviderInstance => ({
  id,
  kind,
  name: id,
  binaryPath: '',
  configDir,
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
});

const project = (cwd: string): Project => ({
  id: 'p1',
  name: 'existing',
  cwd,
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
});

async function jsonl(file: string, line: unknown, modified: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(line)}\n`);
  await utimes(file, new Date(modified), new Date(modified));
}

const claudeSession = (configDir: string, cwd: string, modified: string) =>
  jsonl(
    path.join(configDir, 'projects', cwd.replaceAll(/[^A-Za-z0-9]/g, '-'), 's.jsonl'),
    { type: 'user', cwd },
    modified,
  );
const codexSession = (home: string, cwd: string, name: string, modified: string) =>
  jsonl(
    path.join(home, 'sessions', '2026', '11', '01', `rollout-${name}.jsonl`),
    { type: 'session_meta', payload: { cwd } },
    modified,
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-discover-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverProjects', () => {
  it('merges every instance by path, skips gone folders and existing projects', async () => {
    const work = path.join(root, 'code', 'work');
    const site = path.join(root, 'code', 'site');
    const known = path.join(root, 'code', 'known');
    const gone = path.join(root, 'code', 'gone');
    for (const folder of [work, site, known]) await mkdir(folder, { recursive: true });
    const claudeDir = path.join(root, 'claude');
    const defaultClaude = path.join(root, 'default-claude');
    const codexHome = path.join(root, 'codex');
    await claudeSession(claudeDir, work, '2026-10-20T08:00:00.000Z');
    await claudeSession(claudeDir, gone, '2026-10-21T08:00:00.000Z');
    await claudeSession(defaultClaude, known, '2026-10-22T08:00:00.000Z');
    await codexSession(codexHome, `${work}${path.sep}`, 'a', '2026-11-01T08:00:00.000Z');
    await codexSession(codexHome, site, 'b', '2026-10-01T08:00:00.000Z');

    const found = await discoverProjects({
      instances: [
        instance('claude-work', 'claude', claudeDir),
        instance('claude-default', 'claude', ''),
        instance('codex', 'codex', codexHome),
        instance('codex-missing', 'codex', path.join(root, 'nowhere')),
      ],
      projects: [project(known)],
      defaultConfigDir: (kind) => (kind === 'claude' ? defaultClaude : path.join(root, 'none')),
      discover: { claude: discoverClaudeFolders, codex: discoverCodexFolders },
      platform: process.platform,
    });

    expect(found).toEqual([
      {
        cwd: work,
        name: 'work',
        lastUsedAt: '2026-11-01T08:00:00.000Z',
        sources: [
          {
            providerInstanceId: 'claude-work',
            providerInstanceName: 'claude-work',
            kind: 'claude',
          },
          { providerInstanceId: 'codex', providerInstanceName: 'codex', kind: 'codex' },
        ],
      },
      {
        cwd: site,
        name: 'site',
        lastUsedAt: '2026-10-01T08:00:00.000Z',
        sources: [{ providerInstanceId: 'codex', providerInstanceName: 'codex', kind: 'codex' }],
      },
    ]);
  });

  it('treats Windows paths that differ only in case and separators as one folder', async () => {
    const found = await discoverProjects({
      instances: [instance('a', 'claude', 'x'), instance('b', 'codex', 'y')],
      projects: [],
      defaultConfigDir: () => '',
      discover: {
        claude: () => Promise.resolve([{ cwd: 'C:\\Code\\Wow', lastUsedAt: null }]),
        codex: () => Promise.resolve([{ cwd: 'c:/code/wow/', lastUsedAt: null }]),
      },
      platform: 'win32',
      isFolder: () => Promise.resolve(true),
    });
    expect(found).toEqual([
      {
        cwd: 'C:\\Code\\Wow',
        name: 'Wow',
        lastUsedAt: null,
        sources: [
          { providerInstanceId: 'a', providerInstanceName: 'a', kind: 'claude' },
          { providerInstanceId: 'b', providerInstanceName: 'b', kind: 'codex' },
        ],
      },
    ]);
  });

  it('ignores relative paths and a provider whose discovery fails', async () => {
    const found = await discoverProjects({
      instances: [instance('a', 'claude', 'x'), instance('b', 'codex', 'y')],
      projects: [],
      defaultConfigDir: () => '',
      discover: {
        claude: () => Promise.resolve([{ cwd: 'relative', lastUsedAt: null }]),
        codex: () => Promise.reject(new Error('unreadable')),
      },
      platform: process.platform,
    });
    expect(found).toEqual([]);
  });
});
