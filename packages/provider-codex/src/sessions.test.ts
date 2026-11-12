import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCodexSessions } from './sessions.js';

// Invented Codex rollouts under `sessions/YYYY/MM/DD`, in the shapes Codex writes them.

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(path.join(tmpdir(), 'wow-codex-sessions-'));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function rollout(day: string, name: string, lines: unknown[], modified: string) {
  const dir = path.join(codexHome, 'sessions', ...day.split('/'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(
    file,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'),
  );
  await utimes(file, new Date(modified), new Date(modified));
}

const meta = (id: string, cwd: string) => ({
  timestamp: '2026-11-01T08:00:00.000Z',
  type: 'session_meta',
  payload: { id, timestamp: '2026-11-01T08:00:00.000Z', cwd, originator: 'codex_cli_rs' },
});
const userItem = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

describe('listCodexSessions (agent workbench spec 72)', () => {
  it('lists each rollout with its id, folder, first prompt and time, newest first', async () => {
    await rollout(
      '2026/11/01',
      'rollout-2026-11-01T08-00-00-invented.jsonl',
      [
        meta('11111111-2222-3333-4444-555555555555', '/work/kettle'),
        userItem('<environment_context>\n  <cwd>/work/kettle</cwd>\n</environment_context>'),
        userItem('Fix the whistle'),
        { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the whistle' } },
      ],
      '2026-11-01T09:00:00.000Z',
    );
    await rollout(
      '2026/11/02',
      'rollout-2026-11-02T08-00-00-invented.jsonl',
      [
        meta('66666666-7777-8888-9999-000000000000', '/work/tea'),
        '{"broken":',
        userItem('<user_instructions>Invented</user_instructions>'),
        userItem('Steep the tea\nfor three minutes'),
      ],
      '2026-11-02T09:00:00.000Z',
    );
    expect(await listCodexSessions(codexHome, { limit: 10, promptChars: 200 })).toEqual([
      {
        id: '66666666-7777-8888-9999-000000000000',
        cwd: '/work/tea',
        firstPrompt: 'Steep the tea for three minutes',
        lastUsedAt: '2026-11-02T09:00:00.000Z',
      },
      {
        id: '11111111-2222-3333-4444-555555555555',
        cwd: '/work/kettle',
        firstPrompt: 'Fix the whistle',
        lastUsedAt: '2026-11-01T09:00:00.000Z',
      },
    ]);
  });

  it('reads an older rollout with its metadata at the top level, keeps the newest and cuts the prompt', async () => {
    await rollout(
      '2026/10/01',
      'rollout-2026-10-01T08-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
      [
        { timestamp: '2026-10-01T08:00:00.000Z', cwd: '/work/old' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Boil water' }] },
      ],
      '2026-10-01T09:00:00.000Z',
    );
    await rollout(
      '2026/09/01',
      'rollout-old.jsonl',
      [meta('x', '/work/older')],
      '2026-09-01T09:00:00.000Z',
    );
    expect(await listCodexSessions(codexHome, { limit: 1, promptChars: 4 })).toEqual([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd: '/work/old',
        firstPrompt: 'Boil…',
        lastUsedAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
    expect(
      await listCodexSessions(path.join(codexHome, 'missing'), { limit: 5, promptChars: 9 }),
    ).toEqual([]);
  });
});
