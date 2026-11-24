import type { Approval, Question, Thread, ThreadItem, Turn } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { cardStateOfThread } from './card-threads.js';
import type { ReadModel } from './orchestrator.js';

// The state a card shows for its main thread (orchestrator threads spec 28). All invented.

interface World {
  readonly thread: Pick<Thread, 'state'>;
  readonly running?: boolean;
  readonly last?: Turn['state'];
  readonly items?: Pick<ThreadItem, 'kind' | 'payload'>[];
  readonly approval?: Pick<Approval, 'decision'>;
  readonly question?: Pick<Question, 'answer'>;
}

const readOf = (world: World) =>
  ({
    thread: () => world.thread,
    runningTurn: () => (world.running ? {} : undefined),
    lastTurn: () => (world.last === undefined ? undefined : { state: world.last }),
    threadItems: () => world.items ?? [],
    approval: () => world.approval,
    question: () => world.question,
  }) as unknown as ReadModel;

const gate = (kind: 'approval' | 'question') => ({
  kind: 'gate_card' as const,
  payload: { kind, requestId: 'r1', fromThreadId: 'helper' },
});

describe('cardStateOfThread', () => {
  it('is running while a turn runs, and how the last turn ended after', () => {
    expect(cardStateOfThread('t', readOf({ thread: { state: 'working' }, running: true }))).toBe(
      'running',
    );
    expect(cardStateOfThread('t', readOf({ thread: { state: 'done' }, last: 'completed' }))).toBe(
      'done',
    );
    expect(cardStateOfThread('t', readOf({ thread: { state: 'failed' }, last: 'failed' }))).toBe(
      'failed',
    );
    expect(cardStateOfThread('t', readOf({ thread: { state: 'idle' }, last: 'interrupted' }))).toBe(
      'stopped',
    );
  });

  it('is waiting while the thread itself waits for the user', () => {
    expect(cardStateOfThread('t', readOf({ thread: { state: 'needs_you' }, running: true }))).toBe(
      'waiting',
    );
  });

  it('is waiting while a gate card from a helper is open, and running once it is answered', () => {
    const working = { thread: { state: 'working' as const }, running: true };
    expect(
      cardStateOfThread(
        't',
        readOf({ ...working, items: [gate('approval')], approval: { decision: null } }),
      ),
    ).toBe('waiting');
    expect(
      cardStateOfThread(
        't',
        readOf({ ...working, items: [gate('approval')], approval: { decision: 'allowOnce' } }),
      ),
    ).toBe('running');
    expect(
      cardStateOfThread(
        't',
        readOf({ ...working, items: [gate('question')], question: { answer: null } }),
      ),
    ).toBe('waiting');
  });

  it('says nothing for a thread that is gone', () => {
    expect(cardStateOfThread('t', { thread: () => undefined } as unknown as ReadModel)).toBe(
      undefined,
    );
  });
});
