import {
  defaultGoBackTemplate,
  defaultHandoverTemplate,
  defaultSendBackTemplate,
  defaultUnitPromptTemplate,
  type GateCondition,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  advance,
  gateCondition,
  startRun,
  verdictLine,
  type ChecksReading,
  type EngineContext,
  type RunInput,
  type Transition,
} from './index.js';

// Review loop spec 54 to 58: a gate after a step that passes by itself when every chosen part
// holds. One case per part passing and failing, then the wait for checks and the skills that
// always stop.

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

const workflow = (...steps: WorkflowStep[]): Workflow => ({
  id: 'wf1',
  name: 'Deliver',
  templateKind: null,
  steps,
  createdAt: T0,
  updatedAt: T0,
});

const context = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  now: T1,
  handoverTemplate: defaultHandoverTemplate,
  sendBackTemplate: defaultSendBackTemplate,
  unitPromptTemplate: defaultUnitPromptTemplate,
  verdictApprovedLine: 'APPROVED',
  verdictChangesRequestedLine: 'CHANGES_REQUESTED',
  verdictBlockedLine: 'BLOCKED',
  goBackTemplate: defaultGoBackTemplate,
  maxStepVisits: 3,
  alwaysStopSkills: [],
  gateChecksTimeoutMinutes: 30,
  invocationFor: (s) => `/${s.skillName}`,
  ...overrides,
});

// A reviewing step with a gate after it and the condition, then a step that delivers.
const gated = (condition: GateCondition, overrides: Partial<WorkflowStep> = {}) =>
  workflow(
    step('check-work', { gateAfter: true, gateAfterCondition: condition, ...overrides }),
    step('deliver-work'),
  );

type StepCompleted = Extract<RunInput, { type: 'stepCompleted' }>;

const ended = (finalMessage: string, more: Partial<StepCompleted> = {}): StepCompleted => ({
  type: 'stepCompleted',
  stepId: 'check-work',
  finalMessage,
  artifactsFound: [],
  ...more,
});

function end(definition: Workflow, input: RunInput, ctx = context()): Transition {
  const started = startRun(definition, { runId: 'r1', projectId: 'p1' }, ctx);
  return advance(definition, started.run, input, ctx);
}

const look = (
  definition: Workflow,
  run: WorkflowRun,
  reading: ChecksReading | null,
  ctx = context(),
): Transition =>
  advance(definition, run, { type: 'gateChecks', stepId: 'check-work', reading }, ctx);

const states = (run: WorkflowRun) => run.steps.map((entry) => entry.state);
const effectTypes = (transition: Transition) => transition.effects.map((effect) => effect.type);

const success: ChecksReading = { state: 'success', number: 14, checks: ['test', 'lint'] };
const running: ChecksReading = { state: 'pending', number: 14, running: ['test'] };

describe('the verdict part', () => {
  it('passes by itself when the last non-empty line is APPROVED and records the part', () => {
    const passed = end(gated(['verdict']), ended('Everything holds.\n\nAPPROVED\n\n'));
    expect(passed.run.state).toBe('running');
    expect(states(passed.run)).toEqual(['done', 'running']);
    expect(passed.run.steps[0]?.gate).toEqual({
      state: 'passedByItself',
      parts: [{ part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' }],
      since: T1,
      at: T1,
    });
    expect(effectTypes(passed)).toEqual(['setThreadState', 'startStep']);
  });

  it('waits and names the verdict when the last line is CHANGES_REQUESTED', () => {
    const waiting = end(gated(['verdict']), ended('Two findings.\nCHANGES_REQUESTED'));
    expect(waiting.run.state).toBe('waiting');
    expect(states(waiting.run)).toEqual(['waiting', 'not_started']);
    expect(waiting.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForUser',
      parts: [
        {
          part: 'verdict',
          state: 'failed',
          detail: 'The final message ends with "CHANGES_REQUESTED", not APPROVED',
        },
      ],
    });
    expect(effectTypes(waiting)).toEqual(['setThreadState', 'notify']);
  });

  it('waits when APPROVED is only earlier in the message', () => {
    const waiting = end(
      gated(['verdict']),
      ended('APPROVED\n\nOn second thought, the bell test is missing.'),
    );
    expect(waiting.run.state).toBe('waiting');
    expect(waiting.run.steps[0]?.gate?.parts[0]).toMatchObject({
      part: 'verdict',
      state: 'failed',
    });
  });

  it('waits when the step left no final message', () => {
    const waiting = end(gated(['verdict']), ended('  \n'));
    expect(waiting.run.steps[0]?.gate?.parts[0]).toEqual({
      part: 'verdict',
      state: 'failed',
      detail: 'The step left no final message',
    });
  });

  it.each([
    ['backticks', 'Looks right.\n`APPROVED`'],
    ['bold', 'Looks right.\n**APPROVED**'],
    ['bold around backticks', 'Looks right.\n**`APPROVED`**  '],
  ])('reads a verdict wrapped in %s', (_name, message) => {
    expect(end(gated(['verdict']), ended(message)).run.steps[0]?.gate?.state).toBe(
      'passedByItself',
    );
  });

  it.each([
    ['a heading', '# APPROVED'],
    ['a list item', '- APPROVED'],
    ['italics', '*APPROVED*'],
    ['a sentence', 'APPROVED.'],
    ['another case', 'approved'],
    ['quotes', '"APPROVED"'],
  ])('strips nothing else: %s is not the verdict', (_name, line) => {
    expect(verdictLine(line)).toBe(line);
    expect(end(gated(['verdict']), ended(line)).run.state).toBe('waiting');
  });

  it('uses the line from the settings', () => {
    const ctx = context({ verdictApprovedLine: 'LGTM' });
    expect(end(gated(['verdict']), ended('LGTM'), ctx).run.steps[0]?.gate?.state).toBe(
      'passedByItself',
    );
    expect(end(gated(['verdict']), ended('APPROVED'), ctx).run.state).toBe('waiting');
  });
});

describe('the artifacts part', () => {
  const definition = gated(['artifacts'], { expectedArtifacts: ['docs/*.md', 'report.html'] });

  it('passes when a file was found for every expected artifact', () => {
    const passed = end(
      definition,
      ended('Done', { artifactsFound: ['docs/a.md', 'report.html'], artifactsMissing: [] }),
    );
    expect(passed.run.steps[0]?.gate).toMatchObject({
      state: 'passedByItself',
      parts: [
        { part: 'artifacts', state: 'held', detail: 'Found a file for docs/*.md, report.html' },
      ],
    });
    expect(states(passed.run)).toEqual(['done', 'running']);
  });

  it('waits and names the glob that found nothing', () => {
    const waiting = end(
      definition,
      ended('Done', { artifactsFound: ['report.html'], artifactsMissing: ['docs/*.md'] }),
    );
    expect(waiting.run.state).toBe('waiting');
    expect(waiting.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'artifacts', state: 'failed', detail: 'Nothing found for docs/*.md' }],
    });
  });

  it('waits when the step names no expected artifacts', () => {
    const waiting = end(gated(['artifacts']), ended('Done'));
    expect(waiting.run.steps[0]?.gate?.parts[0]).toEqual({
      part: 'artifacts',
      state: 'failed',
      detail: 'The step names no expected artifacts to look for',
    });
  });
});

describe('the checks part', () => {
  const definition = gated(['checks']);
  const waitingForChecks = () => end(definition, ended('Pushed.'));

  it('waits for checks when the step ends, without asking the user', () => {
    const waiting = waitingForChecks();
    expect(waiting.run.state).toBe('waiting');
    expect(states(waiting.run)).toEqual(['waiting', 'not_started']);
    expect(waiting.run.steps[0]?.gate).toMatchObject({ state: 'waitingForChecks', since: T1 });
    expect(waiting.effects).toEqual([]);
  });

  it('passes when the host shows every check successful', () => {
    const passed = look(
      definition,
      waitingForChecks().run,
      success,
      context({ now: minutesLater(2) }),
    );
    expect(states(passed.run)).toEqual(['done', 'running']);
    expect(passed.run.steps[0]?.gate).toEqual({
      state: 'passedByItself',
      parts: [
        {
          part: 'checks',
          state: 'held',
          detail: 'Every check of pull request #14 is successful (test, lint)',
        },
      ],
      since: T1,
      at: minutesLater(2),
    });
    expect(effectTypes(passed)).toEqual(['setThreadState', 'startStep']);
  });

  it('waits for the user and names the failing check', () => {
    const failed = look(definition, waitingForChecks().run, {
      state: 'failure',
      number: 14,
      failing: ['test'],
    });
    expect(failed.run.state).toBe('waiting');
    expect(failed.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForUser',
      parts: [
        { part: 'checks', state: 'failed', detail: 'Pull request #14 has failing checks: test' },
      ],
    });
    expect(effectTypes(failed)).toEqual(['setThreadState', 'notify']);
  });

  it('keeps waiting while checks run, then passes when a later look shows success', () => {
    const still = look(
      definition,
      waitingForChecks().run,
      running,
      context({ now: minutesLater(5) }),
    );
    expect(still.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForChecks',
      parts: [{ state: 'pending', detail: 'Checks of pull request #14 are still running: test' }],
    });
    expect(still.effects).toEqual([]);
    // The same answer again changes nothing.
    expect(look(definition, still.run, running, context({ now: minutesLater(6) })).run).toBe(
      still.run,
    );
    const passed = look(definition, still.run, success, context({ now: minutesLater(10) }));
    expect(passed.run.steps[0]?.gate?.state).toBe('passedByItself');
  });

  it.each<[string, ChecksReading, string]>([
    [
      'no pull request',
      { state: 'noPullRequest', branch: 'agent/U2-bell' },
      'No pull request found yet for branch agent/U2-bell',
    ],
    [
      'no branch',
      { state: 'noPullRequest', branch: null },
      'The run is on no branch yet, so it has no pull request',
    ],
    ['no checks yet', { state: 'none', number: 14 }, 'Pull request #14 shows no checks yet'],
    [
      'a host that did not answer',
      { state: 'unavailable', message: 'ghe.example.invalid did not answer' },
      'ghe.example.invalid did not answer',
    ],
  ])('keeps waiting with %s', (_name, reading, detail) => {
    const still = look(definition, waitingForChecks().run, reading);
    expect(still.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForChecks',
      parts: [{ part: 'checks', state: 'pending', detail }],
    });
  });

  it('waits for the user at once when the host is not set up', () => {
    const failed = look(definition, waitingForChecks().run, {
      state: 'notSetUp',
      message: 'GitHub is not set up for this project',
    });
    expect(failed.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForUser',
      parts: [{ state: 'failed', detail: 'GitHub is not set up for this project' }],
    });
  });

  it('waits for the user after workflows.gateChecksTimeoutMinutes', () => {
    const still = look(
      definition,
      waitingForChecks().run,
      running,
      context({ now: minutesLater(29) }),
    );
    expect(still.run.steps[0]?.gate?.state).toBe('waitingForChecks');
    // Nothing new was read; only the time decides.
    const late = look(definition, still.run, null, context({ now: minutesLater(30) }));
    expect(late.run.state).toBe('waiting');
    expect(late.run.steps[0]?.gate).toEqual({
      state: 'waitingForUser',
      parts: [
        {
          part: 'checks',
          state: 'failed',
          detail:
            'Checks were not successful within 30 minutes. Checks of pull request #14 are still running: test',
        },
      ],
      since: T1,
      at: minutesLater(30),
    });
    expect(effectTypes(late)).toEqual(['setThreadState', 'notify']);
    const shorter = context({ now: minutesLater(5), gateChecksTimeoutMinutes: 5 });
    expect(look(definition, waitingForChecks().run, null, shorter).run.steps[0]?.gate?.state).toBe(
      'waitingForUser',
    );
  });

  it('does nothing before the wait is over when nothing was read', () => {
    const waiting = waitingForChecks();
    expect(look(definition, waiting.run, null, context({ now: minutesLater(10) })).run).toBe(
      waiting.run,
    );
  });

  it('still passes on success after the wait, and ignores a look at a gate already answered', () => {
    const waiting = waitingForChecks();
    const passed = look(definition, waiting.run, success, context({ now: minutesLater(45) }));
    expect(passed.run.steps[0]?.gate?.state).toBe('passedByItself');
    const again = look(definition, passed.run, success);
    expect(again).toEqual({ run: passed.run, effects: [] });
    const other = advance(
      definition,
      waiting.run,
      { type: 'gateChecks', stepId: 'deliver-work', reading: success },
      context(),
    );
    expect(other.run).toBe(waiting.run);
  });

  it('lets the user approve, send back or stop while it waits for checks', () => {
    const waiting = waitingForChecks();
    const approved = advance(definition, waiting.run, { type: 'continue' }, context());
    expect(approved.run.steps[0]?.gate?.state).toBe('passedByUser');
    expect(states(approved.run)).toEqual(['done', 'running']);
    const sentBack = advance(
      definition,
      waiting.run,
      { type: 'sendBack', note: 'Fix the bell' },
      context(),
    );
    expect(sentBack.run.steps[0]).toMatchObject({ state: 'running', attempt: 2 });
    expect(sentBack.run.steps[0]?.gate).toBeUndefined();
    const stopped = advance(definition, waiting.run, { type: 'stop' }, context());
    expect(stopped.run.state).toBe('stopped');
    expect(stopped.run.steps[0]?.gate).toBeUndefined();
  });
});

describe('several parts', () => {
  const definition = gated(['verdict', 'checks', 'artifacts'], {
    expectedArtifacts: ['docs/*.md'],
  });

  it('does not wait for checks when another part already failed', () => {
    const waiting = end(
      definition,
      ended('CHANGES_REQUESTED', { artifactsFound: ['docs/a.md'], artifactsMissing: [] }),
    );
    expect(waiting.run.steps[0]?.gate).toMatchObject({
      state: 'waitingForUser',
      parts: [
        { part: 'verdict', state: 'failed' },
        {
          part: 'checks',
          state: 'pending',
          detail: 'Not looked at, because another part did not hold',
        },
        { part: 'artifacts', state: 'held' },
      ],
    });
  });

  it('passes with every part once the checks succeed', () => {
    const waiting = end(
      definition,
      ended('APPROVED', { artifactsFound: ['docs/a.md'], artifactsMissing: [] }),
    );
    expect(waiting.run.steps[0]?.gate?.state).toBe('waitingForChecks');
    const passed = look(definition, waiting.run, success);
    expect(passed.run.steps[0]?.gate?.parts.map((part) => [part.part, part.state])).toEqual([
      ['verdict', 'held'],
      ['checks', 'held'],
      ['artifacts', 'held'],
    ]);
  });
});

describe('what stays as before', () => {
  it('a gate without a condition waits and records nothing', () => {
    const waiting = end(
      workflow(step('check-work', { gateAfter: true }), step('deliver-work')),
      ended('APPROVED'),
    );
    expect(waiting.run.state).toBe('waiting');
    expect(waiting.run.steps[0]?.gate).toBeUndefined();
    const approved = advance(
      workflow(step('check-work', { gateAfter: true }), step('deliver-work')),
      waiting.run,
      { type: 'continue' },
      context(),
    );
    expect(approved.run.steps[0]?.gate).toBeUndefined();
  });

  it('a condition without a gate after the step is ignored', () => {
    const definition = workflow(
      step('check-work', { gateAfterCondition: ['verdict'] }),
      step('deliver-work'),
    );
    const went = end(definition, ended('CHANGES_REQUESTED'));
    expect(states(went.run)).toEqual(['done', 'running']);
    expect(went.run.steps[0]?.gate).toBeUndefined();
  });

  it('the next step still waits at its own gate before it', () => {
    const definition = workflow(
      step('check-work', { gateAfter: true, gateAfterCondition: ['verdict'] }),
      step('deliver-work', { gateBefore: true }),
    );
    const passed = end(definition, ended('APPROVED'));
    expect(passed.run.steps[0]?.gate?.state).toBe('passedByItself');
    expect(passed.run.state).toBe('waiting');
    expect(states(passed.run)).toEqual(['done', 'waiting']);
  });

  it('a gate after the last step that passes by itself ends the run', () => {
    const definition = workflow(
      step('check-work', { gateAfter: true, gateAfterCondition: ['verdict'] }),
    );
    const passed = end(definition, ended('APPROVED'));
    expect(passed.run.state).toBe('done');
    expect(effectTypes(passed)).toEqual(['setThreadState', 'notify']);
  });

  it('a step sent back is judged again when it ends', () => {
    const definition = gated(['verdict']);
    const waiting = end(definition, ended('CHANGES_REQUESTED'));
    const rerun = advance(definition, waiting.run, { type: 'sendBack', note: 'Again' }, context());
    const passed = advance(
      definition,
      rerun.run,
      ended('APPROVED'),
      context({ now: minutesLater(3) }),
    );
    expect(passed.run.steps[0]).toMatchObject({
      attempt: 2,
      state: 'done',
      gate: { state: 'passedByItself', since: minutesLater(3) },
    });
  });
});

const planning = (skillName: string) =>
  workflow(
    step('check-work', { skillName, gateAfter: true, gateAfterCondition: ['verdict'] }),
    step('deliver-work'),
  );

describe('skills that always stop (spec 57)', () => {
  it.each(['capture-intent', 'plan-work', 'design-work', 'shape-work', 'agent-os-core:plan-work'])(
    '%s waits for the user whatever its condition says',
    (skillName) => {
      const waiting = end(planning(skillName), ended('APPROVED'));
      expect(waiting.run.state).toBe('waiting');
      expect(waiting.run.steps[0]?.gate).toBeUndefined();
      expect(effectTypes(waiting)).toEqual(['setThreadState', 'notify']);
    },
  );

  it('the four defaults still stop when they are removed from the setting', () => {
    const ctx = context({ alwaysStopSkills: [] });
    expect(end(planning('plan-work'), ended('APPROVED'), ctx).run.state).toBe('waiting');
    expect(gateCondition(planning('shape-work').steps[0] as WorkflowStep, ctx)).toBeUndefined();
  });

  it('a skill added to the setting stops as well, and others do not', () => {
    const ctx = context({ alwaysStopSkills: ['write-spec'] });
    expect(end(planning('write-spec'), ended('APPROVED'), ctx).run.state).toBe('waiting');
    expect(end(planning('check-work'), ended('APPROVED'), ctx).run.state).toBe('running');
  });
});
