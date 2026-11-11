import {
  defaultGoBackTemplate,
  defaultHandoverTemplate,
  defaultSendBackTemplate,
  defaultUnitPromptTemplate,
  type RuleCondition,
  type RunEffect,
  type StepRule,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  advance,
  pendingGate,
  readVerdict,
  reviewedStepIndex,
  RunRejected,
  startRun,
  type EngineContext,
  type RunInput,
  type Transition,
} from './index.js';

const T0 = '2026-11-02T08:00:00.000Z';
const T1 = '2026-11-02T09:00:00.000Z';
const minutesLater = (minutes: number) => new Date(Date.parse(T1) + minutes * 60_000).toISOString();

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

const workflow = (steps: WorkflowStep[], overrides: Partial<Workflow> = {}): Workflow => ({
  id: 'wf1',
  name: 'Feature',
  templateKind: null,
  steps,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const context = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  now: T1,
  handoverTemplate: defaultHandoverTemplate,
  sendBackTemplate: defaultSendBackTemplate,
  goBackTemplate: defaultGoBackTemplate,
  unitPromptTemplate: defaultUnitPromptTemplate,
  verdictApprovedLine: 'APPROVED',
  verdictChangesRequestedLine: 'CHANGES_REQUESTED',
  verdictBlockedLine: 'BLOCKED',
  alwaysStopSkills: [],
  gateChecksTimeoutMinutes: 30,
  maxStepVisits: 3,
  invocationFor: (s) => `/${s.skillName}`,
  ...overrides,
});

const when = (condition: RuleCondition, target: string): StepRule => ({
  when: condition,
  goTo: target === 'End' ? { type: 'end' } : { type: 'step', stepId: target },
});
const changesRequested: RuleCondition = { fact: 'verdict', is: 'changesRequested' };
const blocked: RuleCondition = { fact: 'verdict', is: 'blocked' };

type Completed = Extract<RunInput, { type: 'stepCompleted' }>;

const completed = (stepId: string, finalMessage = `${stepId} finished`): Completed => ({
  type: 'stepCompleted',
  stepId,
  finalMessage,
  artifactsFound: [],
});

const newRun = { runId: 'r1', projectId: 'p1' };

function play(definition: Workflow, inputs: RunInput[], ctx = context()): Transition {
  let transition = startRun(definition, newRun, ctx);
  for (const input of inputs) transition = advance(definition, transition.run, input, ctx);
  return transition;
}

const states = (run: WorkflowRun) => run.steps.map((entry) => entry.state);
const visits = (run: WorkflowRun) =>
  (run.path ?? []).map(
    (visit) => `${visit.stepId}#${visit.attempt} ${visit.ended}: ${visit.reason}`,
  );
const effectOf = <T extends RunEffect['type']>(effects: RunEffect[], type: T) =>
  effects.find((effect): effect is Extract<RunEffect, { type: T }> => effect.type === type);

// build, review (changes requested goes back to build, blocked ends the run), ship.
const loop = (overrides: Partial<Workflow> = {}) =>
  workflow(
    [
      step('build'),
      step('review', { rules: [when(changesRequested, 'build'), when(blocked, 'End')] }),
      step('ship'),
    ],
    overrides,
  );

describe('rules on the verdict (spec 1, 2, 6)', () => {
  it('starts build when review ends with CHANGES_REQUESTED', () => {
    const { run, effects } = play(loop(), [
      completed('build'),
      completed('review', 'Two things are wrong.\n\nCHANGES_REQUESTED'),
    ]);
    expect(run).toMatchObject({ state: 'running', currentStep: 0 });
    expect(states(run)).toEqual(['running', 'done', 'not_started']);
    expect(effectOf(effects, 'sendBack')).toMatchObject({ stepId: 'build', attempt: 2 });
  });

  it('ends the run as done when review ends with BLOCKED and the rule goes to End', () => {
    const { run, effects } = play(loop(), [completed('build'), completed('review', 'BLOCKED')]);
    expect(run).toMatchObject({ state: 'done', endedAt: T1 });
    expect(states(run)).toEqual(['done', 'done', 'not_started']);
    expect(effects).toContainEqual({ type: 'notify', runId: 'r1', stepId: null, reason: 'done' });
  });

  it('starts the next step in the list when review ends with APPROVED and no rule holds', () => {
    const { run, effects } = play(loop(), [completed('build'), completed('review', 'APPROVED')]);
    expect(run).toMatchObject({ state: 'running', currentStep: 2 });
    expect(effectOf(effects, 'startStep')).toMatchObject({ stepId: 'ship', threadId: 'r1.ship' });
  });

  it('reads the verdict from the last non-empty line, with bold or backticks around it', () => {
    const lines = context();
    expect(readVerdict('Found two bugs.\n\n**CHANGES_REQUESTED**\n\n', lines)).toBe(
      'changesRequested',
    );
    expect(readVerdict('Found two bugs.\n`CHANGES_REQUESTED`', lines)).toBe('changesRequested');
    expect(readVerdict('`BLOCKED`', lines)).toBe('blocked');
    expect(readVerdict('All good.\nAPPROVED', lines)).toBe('approved');
  });

  it('reads no verdict when the word only comes earlier in the message', () => {
    const lines = context();
    expect(readVerdict('CHANGES_REQUESTED\n\nSee the list above.', lines)).toBe('none');
    expect(readVerdict('I would say CHANGES_REQUESTED', lines)).toBe('none');
    expect(readVerdict('', lines)).toBe('none');
    const { run } = play(loop(), [
      completed('build'),
      completed('review', 'CHANGES_REQUESTED is what I thought at first.\nIt is fine now.'),
    ]);
    expect(run.steps[1]?.facts?.verdict).toBe('none');
    expect(run.currentStep).toBe(2);
  });

  it('follows a rule that names "no verdict"', () => {
    const definition = workflow([
      step('build'),
      step('review', { rules: [when({ fact: 'verdict', is: 'none' }, 'End')] }),
      step('ship'),
    ]);
    const { run } = play(definition, [completed('build'), completed('review', 'Looks fine.')]);
    expect(run.state).toBe('done');
    expect(visits(run).at(-1)).toBe('review#1 done: no verdict → End');
  });
});

const reading = (
  state: 'failure' | 'pending' | 'success',
): Extract<RunInput, { type: 'gateChecks' }> => ({
  type: 'gateChecks',
  stepId: 'build',
  reading:
    state === 'failure'
      ? { state, number: 7, failing: ['test'] }
      : state === 'pending'
        ? { state, number: 7, running: ['test'] }
        : { state, number: 7, checks: ['test'] },
});

describe('rules on checks (spec 3)', () => {
  const checksFailed: RuleCondition = { fact: 'checks', is: 'failed' };
  const definition = workflow([
    step('build', { rules: [when(checksFailed, 'fix')] }),
    step('ship'),
    step('fix'),
  ]);
  const built: Completed = { ...completed('build'), headSha: 'abc123' };
  it('waits for checks while they run, without asking the user', () => {
    const { run, effects } = play(definition, [built, reading('pending')]);
    expect(run).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(run.steps[0]).toMatchObject({
      state: 'waiting',
      gate: { state: 'waitingForChecks', forRules: true, since: T1, headSha: 'abc123' },
    });
    expect(run.steps[0]?.gate?.parts[0]?.detail).toContain('still running: test');
    expect(effects).toEqual([]);
  });

  it('follows the "failed" rule when a read of the step\'s commit shows a failure', () => {
    const { run, effects } = play(definition, [built, reading('pending'), reading('failure')]);
    expect(run).toMatchObject({ state: 'running', currentStep: 2 });
    expect(states(run)).toEqual(['done', 'skipped', 'running']);
    expect(run.steps[0]?.facts?.checks).toBe('failed');
    expect(run.steps[0]?.gate).toBeUndefined();
    expect(effectOf(effects, 'startStep')?.stepId).toBe('fix');
    expect(visits(run)[0]).toBe('build#1 done: checks failed → fix');
  });

  it('goes to the next step when the checks are successful and only "failed" has a rule', () => {
    const { run } = play(definition, [built, reading('success')]);
    expect(run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(visits(run)[0]).toBe('build#1 done: no rule held → next step');
  });

  it('waits for the user after the timeout and says so; Approve then follows no checks rule', () => {
    const waiting = play(definition, [built, reading('pending')]);
    const late = context({ now: minutesLater(30) });
    const timedOut = advance(
      definition,
      waiting.run,
      { type: 'gateChecks', stepId: 'build', reading: null },
      late,
    );
    expect(timedOut.run.state).toBe('waiting');
    expect(timedOut.run.steps[0]?.gate).toMatchObject({ state: 'waitingForUser' });
    expect(timedOut.run.steps[0]?.gate?.parts[0]?.detail).toContain(
      'Checks were not successful within 30 minutes',
    );
    expect(timedOut.effects).toContainEqual({
      type: 'notify',
      runId: 'r1',
      stepId: 'build',
      reason: 'waiting',
    });
    const approved = advance(definition, timedOut.run, { type: 'continue' }, late);
    expect(approved.run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(approved.run.steps[0]?.facts?.checks).toBe('undecided');
  });

  it('uses what a gate with a checks condition already read, without waiting twice', () => {
    const gated = workflow([
      step('build', {
        gateAfter: true,
        gateAfterCondition: ['checks'],
        rules: [when(checksFailed, 'fix')],
      }),
      step('ship'),
      step('fix'),
    ]);
    const failed = play(gated, [built, reading('failure')]);
    // The gate did not pass, so no rule is followed yet.
    expect(failed.run.state).toBe('waiting');
    expect(failed.run.steps[0]?.gate?.state).toBe('waitingForUser');
    const approved = advance(gated, failed.run, { type: 'continue' }, context());
    expect(approved.run).toMatchObject({ state: 'running', currentStep: 2 });
  });
});

describe('rules on artifacts (spec 4)', () => {
  const definition = workflow([
    step('build', {
      expectedArtifacts: ['docs/*.md', 'notes/*.txt'],
      rules: [when({ fact: 'artifacts', is: 'missing' }, 'End')],
    }),
    step('ship'),
  ]);

  it('follows the "missing" rule when a glob found nothing', () => {
    const { run } = play(definition, [
      {
        ...completed('build'),
        artifactsFound: ['docs/kettle.md'],
        artifactsMissing: ['notes/*.txt'],
      },
    ]);
    expect(run.state).toBe('done');
    expect(run.steps[0]?.facts?.artifacts).toBe('missing');
    expect(visits(run)).toEqual(['build#1 done: artifacts missing → End']);
  });

  it('goes on by the list when every glob found a file', () => {
    const { run } = play(definition, [
      {
        ...completed('build'),
        artifactsFound: ['docs/kettle.md', 'notes/a.txt'],
        artifactsMissing: [],
      },
    ]);
    expect(run).toMatchObject({ state: 'running', currentStep: 1 });
  });
});

describe('a rule for a failed step (spec 5)', () => {
  const failed: RunInput = { type: 'stepFailed', stepId: 'build', error: 'The compiler crashed' };
  const withRule = workflow([
    step('build', { rules: [when({ fact: 'stepFailed' }, 'diagnose')] }),
    step('ship'),
    step('diagnose'),
  ]);

  it('starts diagnose with the error in its handover', () => {
    const { run, effects } = play(withRule, [failed]);
    expect(run).toMatchObject({ state: 'running', currentStep: 2, endedAt: null });
    expect(states(run)).toEqual(['failed', 'skipped', 'running']);
    expect(effectOf(effects, 'startStep')).toMatchObject({
      stepId: 'diagnose',
      prompt: '/diagnose\n\nThe previous step (build) failed with:\n\nThe compiler crashed',
    });
    expect(effects).toContainEqual({
      type: 'setThreadState',
      threadId: 'r1.build',
      state: 'failed',
    });
    expect(effects.some((effect) => effect.type === 'notify')).toBe(false);
    expect(visits(run)[0]).toBe('build#1 failed: step failed → diagnose');
  });

  it('fails the run without such a rule', () => {
    const { run, effects } = play(workflow([step('build'), step('ship')]), [failed]);
    expect(run).toMatchObject({ state: 'failed', endedAt: T1 });
    expect(effects).toContainEqual({
      type: 'notify',
      runId: 'r1',
      stepId: 'build',
      reason: 'failed',
    });
  });

  it('follows no rule for a step the user stopped', () => {
    const interrupted = play(withRule, [{ ...failed, stopped: true }]);
    expect(interrupted.run.state).toBe('failed');
    expect(states(interrupted.run)).toEqual(['failed', 'not_started', 'not_started']);
    const stopped = play(withRule, [{ type: 'stop' }]);
    expect(stopped.run.state).toBe('stopped');
    expect(() => advance(withRule, stopped.run, failed, context())).toThrow(RunRejected);
    expect(visits(stopped.run)).toEqual(['build#1 stopped: you stopped the run']);
  });
});

const hashed = (stepId: string, hash: string, message = `${stepId} finished`): Completed => ({
  ...completed(stepId, message),
  fileHashes: [{ path: 'a', hash }],
});

describe('going back (spec 7, 8)', () => {
  const sendsBack = completed('review', 'The bell rings twice.\n\nCHANGES_REQUESTED');

  it('runs build again in its own thread as attempt 2 with the go-back message', () => {
    const { run, effects } = play(loop(), [completed('build'), sendsBack]);
    expect(run.steps[0]).toMatchObject({
      state: 'running',
      attempt: 2,
      threadId: 'r1.build',
      finalMessage: 'build finished',
    });
    expect(effects).toEqual([
      { type: 'setThreadState', threadId: 'r1.review', state: 'done' },
      {
        type: 'sendBack',
        runId: 'r1',
        stepId: 'build',
        threadId: 'r1.build',
        attempt: 2,
        prompt: [
          'The step review sent the work back to this step: verdict changes requested.',
          '',
          'What review ended with:',
          '',
          'The bell rings twice.',
          '',
          'CHANGES_REQUESTED',
          '',
          'Do the step (build) again in this conversation with that taken into account, and end with your result as before.',
        ].join('\n'),
      },
    ]);
  });

  it("stops a step whose turn waits for the user's own turn in its thread without interrupting that turn", () => {
    const { run } = play(loop(), [completed('build'), sendsBack]);
    // The server holds the turn while the user's message in build's thread is answered.
    const held: WorkflowRun = {
      ...run,
      steps: run.steps.map((entry) =>
        entry.stepId === 'build' ? { ...entry, heldPrompt: 'Do it again' } : entry,
      ),
    };
    const stopped = advance(loop(), held, { type: 'stop' }, context());
    expect(stopped.run.state).toBe('stopped');
    expect(stopped.run.steps[0]?.heldPrompt).toBeUndefined();
    expect(effectOf(stopped.effects, 'interrupt')).toBeUndefined();
    // Without a hold the step's own turn is interrupted as before.
    expect(
      effectOf(advance(loop(), run, { type: 'stop' }, context()).effects, 'interrupt'),
    ).toEqual({ type: 'interrupt', threadId: 'r1.build' });
  });

  it('keeps with each attempt the changed files as the step before it left them', () => {
    const base = advance(
      loop(),
      startRun(loop(), newRun, context()).run,
      { type: 'baseRecorded', baseSha: 'b0', files: [{ path: 'a', hash: 'a0' }] },
      context(),
    ).run;
    let run = advance(loop(), base, hashed('build', 'a1'), context()).run;
    expect(run.steps[0]?.fileHashesBefore).toEqual([{ path: 'a', hash: 'a0' }]);
    run = advance(loop(), run, hashed('review', 'a1', 'CHANGES_REQUESTED'), context()).run;
    expect(run.steps[1]?.fileHashesBefore).toEqual([{ path: 'a', hash: 'a1' }]);
    run = advance(loop(), run, hashed('build', 'a2'), context()).run;
    // Build's second attempt began from what the review left.
    expect(run.steps[0]?.fileHashesBefore).toEqual([{ path: 'a', hash: 'a1' }]);
    expect(run.steps[1]?.fileHashesBefore).toEqual([{ path: 'a', hash: 'a1' }]);
  });

  it('then runs review again as attempt 2 in its own thread, with the handover from build', () => {
    const { run, effects } = play(loop(), [
      completed('build'),
      sendsBack,
      completed('build', 'One ring now'),
    ]);
    expect(run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(run.steps[1]).toMatchObject({ state: 'running', attempt: 2, threadId: 'r1.review' });
    expect(effectOf(effects, 'sendBack')).toMatchObject({
      stepId: 'review',
      threadId: 'r1.review',
      attempt: 2,
      prompt: '/review\n\nThe previous step (build) ended with:\n\nOne ring now',
    });
    expect(effects.some((effect) => effect.type === 'startStep')).toBe(false);
  });

  it('review sends back twice then approves', () => {
    const { run, effects } = play(loop(), [
      completed('build'),
      sendsBack,
      completed('build'),
      sendsBack,
      completed('build'),
      completed('review', 'APPROVED'),
    ]);
    expect(run).toMatchObject({ state: 'running', currentStep: 2 });
    expect(run.steps.map((entry) => entry.attempt)).toEqual([3, 3, undefined]);
    expect(effectOf(effects, 'startStep')?.stepId).toBe('ship');
    expect(visits(run)).toEqual([
      'build#1 done: next step',
      'review#1 done: verdict changes requested → build',
      'build#2 done: next step',
      'review#2 done: verdict changes requested → build',
      'build#3 done: next step',
      'review#3 done: no rule held → next step',
      'ship#1 null: null',
    ]);
    const done = advance(loop(), run, completed('ship'), context());
    expect(done.run.state).toBe('done');
    expect(visits(done.run).at(-1)).toBe('ship#1 done: last step');
  });

  it('sends the step prompt when the go-back template is emptied', () => {
    const { effects } = play(
      loop(),
      [completed('build'), sendsBack],
      context({ goBackTemplate: '' }),
    );
    expect(effectOf(effects, 'sendBack')?.prompt).toBe(
      '/build\n\nThe previous step (review) ended with:\n\nThe bell rings twice.\n\nCHANGES_REQUESTED',
    );
  });
});

describe('the limit on step starts (spec 9)', () => {
  const sendsBack = completed('review', 'CHANGES_REQUESTED');
  const rounds = (count: number): RunInput[] =>
    Array.from({ length: count }, () => [completed('build'), sendsBack]).flat();

  it('waits for the user with the limit sentence when build would start a fourth time', () => {
    const { run, effects } = play(loop(), rounds(3));
    expect(run).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(run.steps[0]).toMatchObject({
      state: 'waiting',
      attempt: 3,
      gate: { state: 'waitingAtLimit', detail: 'build has run 3 times: the limit', parts: [] },
    });
    expect(pendingGate(run)).toEqual({ stepIndex: 0, position: 'before' });
    expect(reviewedStepIndex(run)).toBe(1);
    expect(effects).toEqual([
      { type: 'setThreadState', threadId: 'r1.review', state: 'needs_you' },
      { type: 'notify', runId: 'r1', stepId: 'build', reason: 'waiting' },
    ]);
    expect(run.path?.at(-1)).toMatchObject({
      stepId: 'review',
      attempt: 3,
      reason: 'verdict changes requested → build',
      limit: 'build has run 3 times: the limit',
    });
  });

  it('Approve starts the step once more, and the next time it waits again', () => {
    const waiting = play(loop(), rounds(3));
    const approved = advance(loop(), waiting.run, { type: 'continue' }, context());
    expect(approved.run).toMatchObject({ state: 'running', currentStep: 0 });
    expect(approved.run.steps[0]).toMatchObject({ state: 'running', attempt: 4 });
    expect(approved.run.steps[0]?.gate).toBeUndefined();
    expect(effectOf(approved.effects, 'sendBack')).toMatchObject({ stepId: 'build', attempt: 4 });
    expect(effectOf(approved.effects, 'sendBack')?.prompt).toContain(
      'The step review sent the work back to this step: verdict changes requested.',
    );
    // Review has started three times by now, so the list waits at it too.
    const again = advance(loop(), approved.run, completed('build'), context());
    expect(again.run).toMatchObject({ state: 'waiting', currentStep: 1 });
    expect(again.run.steps[1]?.gate?.detail).toBe('review has run 3 times: the limit');
  });

  it('Stop ends the run and leaves build as its last pass left it', () => {
    const waiting = play(loop(), rounds(3));
    const stopped = advance(loop(), waiting.run, { type: 'stop' }, context());
    expect(stopped.run).toMatchObject({ state: 'stopped', endedAt: T1 });
    expect(stopped.run.steps[0]).toMatchObject({ state: 'done', attempt: 3 });
    expect(stopped.run.steps[0]?.gate).toBeUndefined();
    expect(stopped.effects).toEqual([
      { type: 'setThreadState', threadId: 'r1.review', state: 'done' },
    ]);
  });

  it("lets the workflow's own number win over the setting", () => {
    const own = loop({ maxStepVisits: 1 });
    const { run } = play(own, rounds(1), context({ maxStepVisits: 5 }));
    expect(run.state).toBe('waiting');
    expect(run.steps[0]?.gate?.detail).toBe('build has run 1 time: the limit');
    const generous = play(loop(), rounds(4), context({ maxStepVisits: 5 }));
    expect(generous.run).toMatchObject({ state: 'running', currentStep: 0 });
    expect(generous.run.steps[0]?.attempt).toBe(5);
  });

  it('does not count against a send back by hand', () => {
    const definition = workflow([step('build', { gateAfter: true }), step('ship')], {
      maxStepVisits: 1,
    });
    const { run } = play(definition, [completed('build'), { type: 'sendBack', note: 'Once more' }]);
    expect(run.steps[0]).toMatchObject({ state: 'running', attempt: 2 });
  });
});

describe('gates on a path a rule takes (spec 10, 12, 13)', () => {
  const sendsBack = completed('review', 'CHANGES_REQUESTED');

  it('waits at the gate before the step that is gone back to, and Approve starts it again', () => {
    const definition = workflow([
      step('build', { gateBefore: true }),
      step('review', { rules: [when(changesRequested, 'build')] }),
    ]);
    const waiting = play(definition, [{ type: 'continue' }, completed('build'), sendsBack]);
    expect(waiting.run).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(waiting.run.steps[0]).toMatchObject({
      state: 'waiting',
      finalMessage: 'build finished',
    });
    expect(pendingGate(waiting.run)).toEqual({ stepIndex: 0, position: 'before' });
    expect(waiting.effects).toEqual([
      { type: 'setThreadState', threadId: 'r1.review', state: 'needs_you' },
      { type: 'notify', runId: 'r1', stepId: 'build', reason: 'waiting' },
    ]);
    const approved = advance(definition, waiting.run, { type: 'continue' }, context());
    expect(approved.run.steps[0]).toMatchObject({ state: 'running', attempt: 2 });
    expect(effectOf(approved.effects, 'sendBack')?.prompt).toContain('The step review sent');
  });

  it('a send back by hand at that gate reruns the step the run came from', () => {
    const definition = workflow([
      step('build', { gateBefore: true }),
      step('review', { rules: [when(changesRequested, 'build')] }),
    ]);
    const waiting = play(definition, [{ type: 'continue' }, completed('build'), sendsBack]);
    const sent = advance(
      definition,
      waiting.run,
      { type: 'sendBack', note: 'Look again' },
      context(),
    );
    expect(sent.run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(states(sent.run)).toEqual(['done', 'running']);
    expect(sent.run.steps[1]?.attempt).toBe(2);
  });

  it('waits for the user at the gate of a planning skill that a rule reached', () => {
    const definition = workflow([
      step('review', { rules: [when(changesRequested, 'plan-work')] }),
      step('ship'),
      step('plan-work', {
        gateAfter: true,
        gateAfterCondition: ['verdict'],
        rules: [when({ fact: 'verdict', is: 'approved' }, 'ship')],
      }),
    ]);
    const waiting = play(definition, [sendsBack, completed('plan-work', 'The plan.\n\nAPPROVED')]);
    expect(waiting.run).toMatchObject({ state: 'waiting', currentStep: 2 });
    expect(waiting.run.steps[2]).toMatchObject({ state: 'waiting' });
    expect(waiting.run.steps[2]?.gate).toBeUndefined();
    expect(pendingGate(waiting.run)).toEqual({ stepIndex: 2, position: 'after' });
    // Only the user's Approve lets the rule be followed.
    const approved = advance(definition, waiting.run, { type: 'continue' }, context());
    expect(approved.run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(visits(approved.run)[1]).toBe('plan-work#1 done: verdict approved → ship');
  });

  it('follows no rule while the gate after the step waits, and a send back by hand works as before', () => {
    const definition = workflow([
      step('build'),
      step('review', { gateAfter: true, rules: [when(changesRequested, 'build')] }),
    ]);
    const waiting = play(definition, [completed('build'), sendsBack]);
    expect(waiting.run).toMatchObject({ state: 'waiting', currentStep: 1 });
    expect(states(waiting.run)).toEqual(['done', 'waiting']);
    expect(pendingGate(waiting.run)).toEqual({ stepIndex: 1, position: 'after' });

    const sent = advance(
      definition,
      waiting.run,
      { type: 'sendBack', note: 'Be stricter' },
      context(),
    );
    expect(sent.run).toMatchObject({ state: 'running', currentStep: 1 });
    expect(sent.run.steps[1]).toMatchObject({ state: 'running', attempt: 2 });
    expect(sent.run.steps[0]?.attempt).toBeUndefined();
    expect(effectOf(sent.effects, 'sendBack')?.prompt).toContain('Be stricter');

    const again = advance(definition, sent.run, sendsBack, context());
    expect(again.run.state).toBe('waiting');
    const approved = advance(definition, again.run, { type: 'continue' }, context());
    expect(approved.run).toMatchObject({ state: 'running', currentStep: 0 });
    expect(approved.run.steps[0]?.attempt).toBe(2);
    expect(visits(approved.run)).toEqual([
      'build#1 done: next step',
      'review#1 done: you sent it back',
      'review#2 done: verdict changes requested → build',
      'build#2 null: null',
    ]);
  });
});

describe('skipping (spec 11)', () => {
  const definition = workflow([
    step('triage', {
      rules: [when({ fact: 'verdict', is: 'approved' }, 'ship'), when(changesRequested, 'triage')],
    }),
    step('build'),
    step('review'),
    step('ship'),
  ]);

  it('shows the steps a rule jumps over as skipped for that pass', () => {
    const { run, effects } = play(definition, [completed('triage', 'APPROVED')]);
    expect(run).toMatchObject({ state: 'running', currentStep: 3 });
    expect(states(run)).toEqual(['done', 'skipped', 'skipped', 'running']);
    expect(effectOf(effects, 'startStep')).toMatchObject({
      stepId: 'ship',
      prompt: '/ship\n\nThe previous step (triage) ended with:\n\nAPPROVED',
    });
  });

  it('lets a later pass run a step that an earlier pass skipped', () => {
    const back = workflow([
      step('triage', { rules: [when({ fact: 'verdict', is: 'approved' }, 'ship')] }),
      step('build'),
      step('ship', { rules: [when(changesRequested, 'build')] }),
    ]);
    const { run, effects } = play(back, [
      completed('triage', 'APPROVED'),
      completed('ship', 'CHANGES_REQUESTED'),
    ]);
    expect(states(run)).toEqual(['done', 'running', 'done']);
    expect(effectOf(effects, 'startStep')?.stepId).toBe('build');
  });
});

describe('the path of a run (spec 18)', () => {
  it('gains a visit with step, attempt, how it ended and the reason for every transition', () => {
    const { run } = play(loop(), [
      completed('build'),
      completed('review', 'CHANGES_REQUESTED'),
      completed('build'),
      completed('review', 'BLOCKED'),
    ]);
    expect(run.path).toEqual([
      {
        stepId: 'build',
        attempt: 1,
        startedAt: T1,
        endedAt: T1,
        ended: 'done',
        next: { to: { type: 'step', stepId: 'review' }, by: 'list' },
        reason: 'next step',
      },
      {
        stepId: 'review',
        attempt: 1,
        startedAt: T1,
        endedAt: T1,
        ended: 'done',
        next: { to: { type: 'step', stepId: 'build' }, by: 'rule', when: changesRequested },
        reason: 'verdict changes requested → build',
      },
      {
        stepId: 'build',
        attempt: 2,
        startedAt: T1,
        endedAt: T1,
        ended: 'done',
        next: { to: { type: 'step', stepId: 'review' }, by: 'list' },
        reason: 'next step',
      },
      {
        stepId: 'review',
        attempt: 2,
        startedAt: T1,
        endedAt: T1,
        ended: 'done',
        next: { to: { type: 'end' }, by: 'rule', when: blocked },
        reason: 'verdict blocked → End',
      },
    ]);
  });

  it('records a failed step that fails the run', () => {
    const { run } = play(loop(), [{ type: 'stepFailed', stepId: 'build', error: 'No model' }]);
    expect(run.path).toEqual([
      {
        stepId: 'build',
        attempt: 1,
        startedAt: T1,
        endedAt: T1,
        ended: 'failed',
        next: null,
        reason: 'step failed',
      },
    ]);
  });
});

describe('where a run waits, as the engine says it', () => {
  it('reads a wait at the limit in a run from before paths, whose workflow gained a rule, as a wait before the step', () => {
    // A run stored before paths were kept: build done, review running, no `path`. The workflow
    // has gained a rule that sends review's changes back to build, with a limit of one start.
    const stored: WorkflowRun = {
      id: 'old',
      workflowId: 'wf1',
      projectId: 'p1',
      calendarItemId: null,
      backlogItemId: null,
      state: 'running',
      currentStep: 1,
      steps: [
        {
          stepId: 'build',
          state: 'done',
          threadId: 'old.build',
          startedAt: T0,
          endedAt: T0,
          artifactsFound: [],
          finalMessage: 'built',
        },
        {
          stepId: 'review',
          state: 'running',
          threadId: 'old.review',
          startedAt: T0,
          artifactsFound: [],
        },
        { stepId: 'ship', state: 'not_started', artifactsFound: [] },
      ],
      startedAt: T0,
      endedAt: null,
      baseSha: null,
      baseFiles: null,
    };
    const gained = loop({ maxStepVisits: 1 });
    const { run } = advance(gained, stored, completed('review', 'CHANGES_REQUESTED'), context());
    expect(run.steps[0]).toMatchObject({ state: 'waiting', waits: 'before' });
    expect(run.steps[0]?.gate?.state).toBe('waitingAtLimit');
    expect(pendingGate(run)).toEqual({ stepIndex: 0, position: 'before' });
    // Run once more starts build again, rather than passing a gate after it.
    const again = advance(gained, run, { type: 'continue' }, context());
    expect(again.run).toMatchObject({ state: 'running', currentStep: 0 });
    expect(again.run.steps[0]).toMatchObject({ state: 'running', attempt: 2 });
    expect(again.run.steps[0]?.waits).toBeUndefined();
    expect(effectOf(again.effects, 'sendBack')).toMatchObject({ stepId: 'build', attempt: 2 });
  });

  it('marks the step the run waits at with the side it waits on, and only while it waits', () => {
    const gated = workflow([step('build', { gateBefore: true, gateAfter: true }), step('ship')]);
    const before = play(gated, []);
    expect(before.run.steps[0]?.waits).toBe('before');
    const after = advance(gated, before.run, { type: 'continue' }, context());
    expect(after.run.steps[0]?.waits).toBeUndefined();
    const ended = advance(gated, after.run, completed('build'), context());
    expect(ended.run.steps[0]?.waits).toBe('after');
    const passed = advance(gated, ended.run, { type: 'continue' }, context());
    expect(passed.run.steps.map((entry) => entry.waits)).toEqual([undefined, undefined]);
  });
});

describe('runs and workflows from before rules (spec 17)', () => {
  const plain = workflow([step('build', { gateAfter: true }), step('review'), step('ship')]);

  it('takes a workflow without rules through the same states and effects as before', () => {
    const waiting = play(plain, [completed('build')]);
    expect(waiting.run.steps[0]?.facts).toBeUndefined();
    const { run, effects } = advance(plain, waiting.run, { type: 'continue' }, context());
    expect(states(run)).toEqual(['done', 'running', 'not_started']);
    expect(effects).toEqual([
      { type: 'setThreadState', threadId: 'r1.build', state: 'done' },
      {
        type: 'startStep',
        runId: 'r1',
        stepId: 'review',
        threadId: 'r1.review',
        prompt: '/review\n\nThe previous step (build) ended with:\n\nbuild finished',
      },
    ]);
  });

  it('continues and finishes a run stored without a path, and gives it none', () => {
    // A run as the store held it before this change: waiting after build, no `path`.
    const stored: WorkflowRun = {
      id: 'old',
      workflowId: 'wf1',
      projectId: 'p1',
      calendarItemId: null,
      backlogItemId: null,
      state: 'waiting',
      currentStep: 0,
      steps: [
        {
          stepId: 'build',
          state: 'waiting',
          threadId: 'old.build',
          startedAt: T0,
          endedAt: T0,
          artifactsFound: [],
          finalMessage: 'built',
        },
        { stepId: 'review', state: 'not_started', artifactsFound: [] },
        { stepId: 'ship', state: 'not_started', artifactsFound: [] },
      ],
      startedAt: T0,
      endedAt: null,
      baseSha: null,
      baseFiles: null,
    };
    expect(pendingGate(stored)).toEqual({ stepIndex: 0, position: 'after' });
    let { run } = advance(plain, stored, { type: 'continue' }, context());
    expect(states(run)).toEqual(['done', 'running', 'not_started']);
    ({ run } = advance(plain, run, completed('review'), context()));
    const last = advance(plain, run, completed('ship'), context());
    expect(last.run).toMatchObject({ state: 'done', endedAt: T1 });
    expect(states(last.run)).toEqual(['done', 'done', 'done']);
    expect(last.run.path).toBeUndefined();
    expect(last.effects).toEqual([
      { type: 'setThreadState', threadId: 'old.ship', state: 'done' },
      { type: 'notify', runId: 'old', stepId: null, reason: 'done' },
    ]);
  });
});
