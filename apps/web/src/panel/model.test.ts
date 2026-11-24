import type { Turn } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  clampPanelWidth,
  effectivePanelWidth,
  hasSelection,
  overlayCap,
  panelSelection,
  threadUsage,
} from './model';

const at = '2026-11-02T10:00:00.000Z';

describe('panelSelection', () => {
  it('reads the selection from the route, never from anything else', () => {
    expect(panelSelection('/calendar', { view: 'week', item: 'card-1' })).toEqual({
      view: 'calendar',
      itemId: 'card-1',
    });
    expect(panelSelection('/calendar', {})).toEqual({ view: 'calendar', itemId: undefined });
    expect(panelSelection('/chat/thread-1', {})).toEqual({ view: 'chat', threadId: 'thread-1' });
    expect(panelSelection('/chat/new', {})).toEqual({ view: 'chat', threadId: undefined });
    expect(panelSelection('/chat', {})).toEqual({ view: 'chat', threadId: undefined });
    expect(panelSelection('/workflows', {})).toEqual({ view: 'other' });
    expect(panelSelection('/backlog/item-1', {})).toEqual({ view: 'backlog', itemId: 'item-1' });
    expect(panelSelection('/backlog/new', {})).toEqual({ view: 'backlog', itemId: undefined });
    expect(panelSelection('/settings/appearance', {})).toEqual({ view: 'other' });
  });

  it('says whether something is selected', () => {
    expect(hasSelection({ view: 'calendar', itemId: undefined })).toBe(false);
    expect(hasSelection({ view: 'calendar', itemId: 'card-1' })).toBe(true);
    expect(hasSelection({ view: 'chat', threadId: 'thread-1' })).toBe(true);
    expect(hasSelection({ view: 'other' })).toBe(false);
  });
});

const turn = (usage: Turn['usage']): Turn => ({
  id: 'turn',
  threadId: 't1',
  index: 0,
  state: 'completed',
  startedAt: at,
  endedAt: at,
  usage,
});

describe('threadUsage', () => {
  it('adds up tokens and cost over the turns that reported them', () => {
    expect(
      threadUsage([
        turn({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, costUsd: 0.01 }),
        turn({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 }),
        turn(null),
      ]),
    ).toEqual({
      inputTokens: 110,
      outputTokens: 25,
      cachedInputTokens: 50,
      costUsd: 0.01,
      turns: 3,
    });
    expect(threadUsage([]).costUsd).toBeUndefined();
  });
});

describe('clampPanelWidth', () => {
  it('keeps the width inside the setting bounds', () => {
    expect(clampPanelWidth(100)).toBe(280);
    expect(clampPanelWidth(5000)).toBe(720);
    expect(clampPanelWidth(400.4)).toBe(400);
  });
});

describe('overlayCap', () => {
  it("leaves the thread list's rail beside a panel laid over the view", () => {
    expect(overlayCap(1024, 16)).toBe(976);
    expect(effectivePanelWidth(720, undefined, overlayCap(1024, 16))).toBe(720);
    expect(effectivePanelWidth(380, 700, overlayCap(1024, 16))).toBe(700);
  });

  it('never goes under the panel minimum in a small window', () => {
    expect(overlayCap(300, 16)).toBe(280);
  });
});
