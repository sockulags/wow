import type { BacklogItem, Thread, ThreadItem } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  backlogBlock,
  backlogMatches,
  lastAnswer,
  threadBlock,
  threadMatches,
} from './mention-blocks';

// `@` on threads and backlog items (chat overview spec 36). All invented.

const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  projectId: 'tea',
  cwd: '/work/tea',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title,
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  ...extra,
});

const item: BacklogItem = {
  id: 'b1',
  title: 'Quiet bell',
  body: 'The bell is too loud at night.',
  tags: ['bell'],
  state: 'idea',
  runId: null,
  remote: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

const text = (id: string, payload: Record<string, unknown>): ThreadItem => ({
  id,
  threadId: 't2',
  turnId: 't2:turn:0',
  index: 0,
  kind: 'assistant_text',
  payload,
  streaming: false,
});

describe('mentions of threads and backlog items (spec 36)', () => {
  it('offers other chat threads newest first, never itself or a step', () => {
    const threads = [
      thread('t1', 'Ring the bell'),
      thread('t2', 'Bell volume', { updatedAt: '2026-11-03T08:00:00.000Z' }),
      thread('t3', 'Bell step', { runId: 'r1' }),
    ];
    expect(threadMatches(threads, 'bell', 't1', 5).map((found) => found.id)).toEqual(['t2']);
    expect(backlogMatches([item, { ...item, id: 'b2', state: 'done' }], 'bell', 5)).toEqual([item]);
  });

  it("quotes a thread's last own answer and a backlog item, cut at the limit", () => {
    const answer = lastAnswer([
      text('a', { text: 'First try' }),
      text('b', { text: 'It rings softly now.' }),
      text('c', { text: 'A subagent note', parentItemId: 'x' }),
    ]);
    expect(answer).toBe('It rings softly now.');
    expect(threadBlock({ title: 'Bell volume' }, 'Tea', answer, 1000)).toBe(
      '```thread\nThread: Bell volume\nProject: Tea\n\nIt rings softly now.\n```',
    );
    expect(backlogBlock(item, 1000)).toBe(
      '```backlog\nBacklog item: Quiet bell\nState: idea\nTags: bell\n\nThe bell is too loud at night.\n```',
    );
    expect(backlogBlock(item, 20)).toContain('[Cut here');
  });
});
