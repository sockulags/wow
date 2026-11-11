import type { StepRule } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { diagramLabel, diagramText, pathsDiagram, type DiagramStep } from './paths-diagram';

// The source of the builder's paths diagram (workflow branches spec 15, 17). The real drawing
// is covered by the e2e case "build a workflow with a loop".

const step = (id: string, skillName: string, more: Partial<DiagramStep> = {}): DiagramStep => ({
  id,
  skillName,
  gateBefore: false,
  gateAfter: false,
  ...more,
});

const toStep = (when: StepRule['when'], stepId: string): StepRule => ({
  when,
  goTo: { type: 'step', stepId },
});

const withRule = (rule: StepRule) =>
  pathsDiagram([step('a', 'deliver-work'), step('b', 'check-work', { rules: [rule] })]);

const lines = (steps: readonly DiagramStep[]) => pathsDiagram(steps).split('\n');

describe('the paths diagram source', () => {
  it('draws a workflow without rules as a straight line (spec 17)', () => {
    expect(
      lines([step('a', 'plan-work'), step('b', 'deliver-work'), step('c', 'check-work')]),
    ).toEqual([
      'flowchart TD',
      '  start(["Start"])',
      '  s1["1. plan-work"]',
      '  s2["2. deliver-work"]',
      '  s3["3. check-work"]',
      '  finish(["End"])',
      '  start --> s1',
      '  s1 --> s2',
      '  s2 --> s3',
      '  s3 --> finish',
    ]);
  });

  it('draws a loop: each step, the list order, the rule arrow with its condition, and the gates (spec 15)', () => {
    const source = lines([
      step('plan', 'plan-work', { gateAfter: true }),
      step('deliver', 'deliver-work'),
      step('check', 'check-work', {
        gateAfter: true,
        rules: [
          toStep({ fact: 'verdict', is: 'changesRequested' }, 'deliver'),
          toStep({ fact: 'stepFailed' }, 'plan'),
        ],
      }),
    ]);
    expect(source.slice(2, 6)).toEqual([
      '  s1["1. plan-work"]',
      '  s2["2. deliver-work"]',
      '  s3["3. check-work"]',
      '  finish(["End"])',
    ]);
    expect(source.slice(6)).toEqual([
      '  start --> s1',
      '  s1 -->|"gate"| s2',
      '  s2 --> s3',
      // The rule is followed after the step's gate; a failed step passes no gate.
      '  s3 -.->|"gate · verdict changes requested"| s2',
      '  s3 -.->|"step failed"| s1',
      '  s3 -->|"gate · otherwise"| finish',
    ]);
  });

  it('changes when a rule is edited', () => {
    const before = withRule(toStep({ fact: 'verdict', is: 'changesRequested' }, 'a'));
    const after = withRule(toStep({ fact: 'verdict', is: 'none' }, 'a'));
    expect(before).toContain('  s2 -.->|"verdict changes requested"| s1');
    expect(after).toContain('  s2 -.->|"no verdict"| s1');
    expect(after).not.toContain('changes requested');
  });

  it('draws a skip to a later step and a rule that ends the run', () => {
    const source = lines([
      step('a', 'check-work', {
        rules: [
          toStep({ fact: 'artifacts', is: 'found' }, 'c'),
          { when: { fact: 'checks', is: 'failed' }, goTo: { type: 'end' } },
        ],
      }),
      step('b', 'deliver-work'),
      step('c', 'learn-work', { gateBefore: true }),
    ]);
    expect(source.slice(6)).toEqual([
      '  start --> s1',
      // The gate before the step the rule reaches.
      '  s1 -.->|"gate · artifacts found"| s3',
      '  s1 -.->|"checks failed"| finish',
      '  s1 -->|"otherwise"| s2',
      '  s2 -->|"gate"| s3',
      '  s3 --> finish',
    ]);
  });

  it('marks the gate before the first step and leaves out a rule whose step is gone', () => {
    const source = lines([
      step('a', '', {
        gateBefore: true,
        rules: [toStep({ fact: 'verdict', is: 'blocked' }, 'gone')],
      }),
    ]);
    expect(source).toEqual([
      'flowchart TD',
      '  start(["Start"])',
      '  s1["1. no skill yet"]',
      '  finish(["End"])',
      '  start -->|"gate"| s1',
      '  s1 -->|"otherwise"| finish',
    ]);
  });

  it('writes a hostile step name with nothing the diagram language reads, and gets it back as text', () => {
    const name = 'say "hi" [now]\n(url(x)) <b>{end}| --> s9; %% `*x*` &amp; #35; \\n';
    const source = pathsDiagram([step('s9"]\n  click s1 href "x"', name)]);
    const [, , box] = source.split('\n');
    // Only the generated id and a quoted label: no quote, bracket, markup or style can end it.
    expect(box).toMatch(/^ {2}s1\["[\p{L}\p{N} .\ue000-\ue07f]+"\]$/u);
    expect(source.split('\n')).toHaveLength(6);
    expect(source).not.toMatch(/url\(|click|href/);
    // The drawn text turns back into the name, the line break as a space.
    expect(diagramText(box ?? '')).toBe(`  s1["1. ${name.replace('\n', ' ').trim()}"]`);
  });

  it('keeps ordinary names readable and drops stand-ins a name brings itself', () => {
    expect(diagramLabel('agent-os-core:plan-work')).toBe('agent-os-core\ue03aplan-work');
    expect(diagramLabel('Översätt snabbt_nu v1.2')).toBe('Översätt snabbt_nu v1.2');
    expect(diagramLabel('- item')).toBe('\ue02d item');
    expect(diagramText(diagramLabel('a \ue022 b'))).toBe('a  b');
    expect(diagramText(diagramLabel('1. "x"'))).toBe('1. "x"');
  });
});
