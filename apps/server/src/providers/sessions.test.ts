import type { Project, ProviderInstance, ProviderSession } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { folderGone, listTerminalSessions, type SessionListDeps } from './sessions.js';

// "Open session from Claude Code / Codex…" (agent workbench spec 72): the server only merges what
// the adapter packages read. Instances, folders and sessions here are invented.

const instance = (
  id: string,
  kind: ProviderInstance['kind'],
  configDir: string,
): ProviderInstance => ({
  id,
  kind,
  name: `${kind} ${id}`,
  binaryPath: kind,
  configDir,
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
});

const project: Project = {
  id: 'kettle',
  name: 'Kettle',
  cwd: '/work/kettle',
  defaultProviderInstanceId: null,
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

const claudeSessions: ProviderSession[] = [
  {
    id: 'c-new',
    cwd: '/work/kettle',
    firstPrompt: 'Make it whistle',
    lastUsedAt: '2026-11-03T08:00:00.000Z',
  },
  { id: 'c-gone', cwd: '/work/gone', firstPrompt: null, lastUsedAt: '2026-11-01T08:00:00.000Z' },
  { id: 'c-relative', cwd: 'work', firstPrompt: null, lastUsedAt: '2026-11-01T08:00:00.000Z' },
];
const codexSessions: ProviderSession[] = [
  {
    id: 'x-1',
    cwd: '/work/tea',
    firstPrompt: 'Steep it',
    lastUsedAt: '2026-11-02T08:00:00.000Z',
  },
];

function deps(overrides: Partial<SessionListDeps> = {}): SessionListDeps & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    instances: [
      instance('claude-work', 'claude', '/home/me/.claude'),
      // Same files as claude-work: listed once.
      instance('claude-again', 'claude', ''),
      instance('codex-work', 'codex', '/home/me/.codex'),
    ],
    projects: [project],
    threads: [{ id: 'thread-1', providerInstanceId: 'codex-work', providerSessionId: 'x-1' }],
    defaultConfigDir: (kind) => (kind === 'claude' ? '/home/me/.claude' : '/home/me/.codex'),
    list: {
      claude: (configDir, options) => {
        asked.push(`claude ${configDir} ${options.limit} ${options.promptChars}`);
        return Promise.resolve(claudeSessions);
      },
      codex: (configDir) => {
        asked.push(`codex ${configDir}`);
        return Promise.resolve(codexSessions);
      },
    },
    limit: 20,
    promptChars: 80,
    platform: 'linux',
    isFolder: (cwd) => Promise.resolve(cwd !== '/work/gone'),
    ...overrides,
  };
}

describe('listTerminalSessions (agent workbench spec 72)', () => {
  it('lists every instance’s sessions once, newest first, with their project, thread and a gone folder', async () => {
    const given = deps();
    const sessions = await listTerminalSessions(given);
    expect(given.asked).toEqual(['claude /home/me/.claude 20 80', 'codex /home/me/.codex']);
    expect(sessions).toEqual([
      {
        ...claudeSessions[0],
        providerInstanceId: 'claude-work',
        providerInstanceName: 'claude claude-work',
        kind: 'claude',
        projectId: 'kettle',
        threadId: null,
        unavailable: null,
      },
      {
        ...codexSessions[0],
        providerInstanceId: 'codex-work',
        providerInstanceName: 'codex codex-work',
        kind: 'codex',
        projectId: null,
        threadId: 'thread-1',
        unavailable: null,
      },
      {
        ...claudeSessions[1],
        providerInstanceId: 'claude-work',
        providerInstanceName: 'claude claude-work',
        kind: 'claude',
        projectId: null,
        threadId: null,
        unavailable: folderGone,
      },
    ]);
  });

  it('asks only the instance named, and an instance whose files cannot be read lists nothing', async () => {
    const given = deps({
      list: {
        claude: () => Promise.reject(new Error('unreadable')),
        codex: () => Promise.resolve(codexSessions),
      },
    });
    expect(await listTerminalSessions(given, 'claude-work')).toEqual([]);
    expect((await listTerminalSessions(given, 'codex-work')).map((s) => s.id)).toEqual(['x-1']);
  });

  it('matches a project folder without case or separators on Windows', async () => {
    const sessions = await listTerminalSessions(
      deps({
        platform: 'win32',
        projects: [{ ...project, cwd: 'C:\\Work\\Kettle' }],
        list: {
          claude: () =>
            Promise.resolve([
              { id: 'w', cwd: 'c:/work/kettle/', firstPrompt: null, lastUsedAt: null },
            ]),
          codex: () => Promise.resolve([]),
        },
      }),
    );
    expect(sessions.map((session) => [session.cwd, session.projectId])).toEqual([
      ['c:\\work\\kettle', 'kettle'],
    ]);
  });
});
