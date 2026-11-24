import { describe, expect, it } from 'vitest';
import { threadListStatuses } from './thread-list.js';

// The thread list's status of a main thread, read from its tree (orchestrator threads spec 31).
// All invented.

const row = (
  id: string,
  state: string,
  extra: { parentThreadId?: string; seen?: boolean } = {},
) => ({ id, state, ...extra });

describe("a main thread's status in the thread list (spec 31)", () => {
  it('waits for the user when it needs the user or holds an open gate card', () => {
    const statuses = threadListStatuses(
      [row('a', 'needs_you'), row('b', 'working'), row('b1', 'needs_you', { parentThreadId: 'b' })],
      new Set(['b']),
    );
    expect(statuses.get('a')).toBe('waits_for_you');
    expect(statuses.get('b')).toBe('waits_for_you');
  });

  it('works while a helper anywhere under it works, and lists no helper', () => {
    const statuses = threadListStatuses(
      [
        row('main', 'idle', { seen: false }),
        row('h1', 'idle', { parentThreadId: 'main' }),
        row('h2', 'working', { parentThreadId: 'h1' }),
      ],
      new Set(),
    );
    expect(statuses.get('main')).toBe('working');
    expect([...statuses.keys()]).toEqual(['main']);
  });

  it('is unread when a turn ended since the user looked, else done', () => {
    const statuses = threadListStatuses(
      [
        row('unread', 'idle', { seen: false }),
        row('read', 'idle', { seen: true }),
        row('old', 'done'),
        row('failed', 'failed', { seen: false }),
      ],
      new Set(),
    );
    expect(statuses.get('unread')).toBe('unread');
    expect(statuses.get('read')).toBe('done');
    expect(statuses.get('old')).toBe('done');
    expect(statuses.get('failed')).toBe('unread');
  });

  it('does not loop on a parent link that goes round', () => {
    const statuses = threadListStatuses(
      [row('x', 'working', { parentThreadId: 'y' }), row('y', 'idle', { parentThreadId: 'x' })],
      new Set(),
    );
    expect(statuses.size).toBe(0);
  });
});
