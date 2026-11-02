import type { CalendarItem, StepRun, Trigger, Turn, WorkflowRun } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeStep,
  cardRun,
  clampPanelWidth,
  hasSelection,
  panelSelection,
  threadUsage,
} from './model';

const at = '2026-11-02T10:00:00.000Z';

const step = (patch: Partial<StepRun> = {}): StepRun => ({
  stepId: 'step',
  state: 'not_started',
  artifactsFound: [],
  ...patch,
});

const run = (patch: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'wf',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'running',
  currentStep: 0,
  steps: [step()],
  startedAt: at,
  endedAt: null,
  ...patch,
});

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
    expect(panelSelection('/workflows/runs/run-1', {})).toEqual({ view: 'run', runId: 'run-1' });
    expect(panelSelection('/workflows/wf', {})).toEqual({ view: 'workflow', workflowId: 'wf' });
    expect(panelSelection('/workflows/new', {})).toEqual({ view: 'workflows' });
    expect(panelSelection('/backlog/item-1', {})).toEqual({ view: 'backlog', itemId: 'item-1' });
    expect(panelSelection('/backlog/new', {})).toEqual({ view: 'backlog', itemId: undefined });
    expect(panelSelection('/settings/appearance', {})).toEqual({ view: 'other' });
  });

  it('says whether something is selected', () => {
    expect(hasSelection({ view: 'calendar', itemId: undefined })).toBe(false);
    expect(hasSelection({ view: 'calendar', itemId: 'card-1' })).toBe(true);
    expect(hasSelection({ view: 'run', runId: 'run-1' })).toBe(true);
    expect(hasSelection({ view: 'other' })).toBe(false);
  });
});

describe('activeStep', () => {
  it('is the step that just ended at a gate after it', () => {
    const waiting = run({
      state: 'waiting',
      currentStep: 0,
      steps: [step({ state: 'waiting', threadId: 't1', startedAt: at, endedAt: at }), step()],
    });
    expect(activeStep(waiting)).toEqual({ index: 0, threadId: 't1' });
  });

  it('is the step before at a gate before a step that has not started', () => {
    const waiting = run({
      state: 'waiting',
      currentStep: 1,
      steps: [step({ state: 'done', threadId: 't1', endedAt: at }), step({ state: 'waiting' })],
    });
    expect(activeStep(waiting)).toEqual({ index: 0, threadId: 't1' });
  });

  it('is the running step, or the last one with a thread once the run ended', () => {
    const running = run({
      currentStep: 1,
      steps: [step({ state: 'done', threadId: 't1' }), step({ state: 'running', threadId: 't2' })],
    });
    expect(activeStep(running)).toEqual({ index: 1, threadId: 't2' });
    const failed = run({
      state: 'failed',
      currentStep: 1,
      steps: [step({ state: 'done', threadId: 't1' }), step({ state: 'failed' })],
    });
    expect(activeStep(failed)).toEqual({ index: 0, threadId: 't1' });
    expect(activeStep(run())).toEqual({ index: 0, threadId: undefined });
  });
});

describe('cardRun', () => {
  const card = { id: 'card-1', runId: null } as CalendarItem;
  const trigger = { calendarItemId: 'card-1', runId: 'run-1' } as Trigger;

  it("finds the card's run through the card row or its trigger", () => {
    expect(cardRun({ ...card, runId: 'run-1' }, [], [run()])?.id).toBe('run-1');
    expect(cardRun(card, [trigger], [run()])?.id).toBe('run-1');
    expect(cardRun(card, [], [run()])).toBeUndefined();
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
