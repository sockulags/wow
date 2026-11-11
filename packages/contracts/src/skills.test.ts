import { describe, expect, it } from 'vitest';
import {
  automaticSkills,
  inListOrder,
  ownSkillNameProblem,
  promptShown,
  promptWithSkills,
  skillGroupOf,
} from './index.js';

const skill = (name: string, source: string, claude = `/${name}`) => ({
  name,
  source,
  invocations: { claude },
});

describe('wow skills contracts', () => {
  it('checks an own skill name (wow skills spec 5)', () => {
    expect(ownSkillNameProblem('tidy-up-2', [])).toBeUndefined();
    expect(ownSkillNameProblem('Tidy', [])).toMatch(/lower case/);
    expect(ownSkillNameProblem('tidy--up', [])).toMatch(/single hyphens/);
    expect(ownSkillNameProblem('wow-mine', [])).toMatch(/wow-/);
    expect(ownSkillNameProblem('tidy', ['tidy'])).toBe('There is already a wow skill named tidy');
  });

  it('lists Yours first, then wow, then the folders (spec 1, 7)', () => {
    const listed = inListOrder([
      skill('ship', 'user-claude'),
      skill('deliver', 'user-claude', '/agent-os:deliver'),
      skill('wow-verdict', 'wow'),
      skill('plan', 'project-agents'),
      skill('tidy', 'yours'),
    ]);
    expect(listed.map((entry) => [entry.name, skillGroupOf(entry)])).toEqual([
      ['tidy', 'yours'],
      ['wow-verdict', 'wow'],
      ['plan', 'project'],
      ['ship', 'user'],
      ['deliver', 'plugins'],
    ]);
  });

  it('puts wow skills as marked blocks and invocations with the tail on one line (spec 10, 11)', () => {
    const parts = [
      { kind: 'text', name: 'tidy', text: 'Tidy.\n' },
      { kind: 'invoke', invocation: '/ship' },
      { kind: 'text', name: 'wow-handover', text: 'Hand over.' },
      { kind: 'invoke', invocation: '/review' },
    ] as const;
    expect(promptWithSkills(parts, 'Go.')).toBe(
      '<skill name="tidy">\nTidy.\n</skill>\n\n/ship\n\n<skill name="wow-handover">\nHand over.\n</skill>\n\n/review Go.',
    );
    expect(promptShown(parts, 'Go.')).toBe('/ship /review Go.');
    expect(promptWithSkills([], 'Go.')).toBe('Go.');
  });

  it('names the built-in skills a step depends on with the reason (spec 12)', () => {
    expect(
      automaticSkills(
        { gateAfter: true, gateAfterCondition: ['verdict'], expectedArtifacts: ['a.md'] },
        { intentId: 'demo', unitKey: 'U1' },
      ),
    ).toEqual([
      { name: 'wow-verdict', reason: 'the gate after this step reads the verdict' },
      { name: 'wow-artifacts', reason: 'this step expects artifacts' },
      { name: 'wow-pull-request', reason: 'this run delivers unit U1 of demo' },
    ]);
    expect(automaticSkills({ gateAfter: false, expectedArtifacts: [] }, null)).toEqual([]);
  });
});
