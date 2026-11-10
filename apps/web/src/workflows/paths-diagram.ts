import { ruleConditionText, type WorkflowStep } from '@wow/contracts';

// The paths a run of a workflow can take, as the source of a flowchart for `MermaidDiagram`
// (workflow branches spec 15). The source is built from generated ids and escaped labels only:
// nothing a step is called can become diagram syntax, a style or a link.
//
//   <MermaidDiagram source={pathsDiagram(draft.steps)} shown={diagramText} />
//   // flowchart TD
//   //   start(["Start"])
//   //   s1["1. deliver-work"]
//   //   s1 -->|"gate"| s2
//   //   ...

export type DiagramStep = Pick<
  WorkflowStep,
  'id' | 'skillName' | 'gateBefore' | 'gateAfter' | 'rules'
>;

const plain = /[\p{L}\p{N}]/u;
// Where the stand-ins live: a range of code points that no script uses.
const standIn = 0xe000;

// A label as the diagram language's quoted text. The language has no way to write a double
// quote inside a label, and reads other punctuation as markup, entities or line breaks. So
// letters, digits and single spaces stay, `-`, `_` and `.` stay inside or after a word, text
// beyond ASCII stays, and every other character becomes a stand-in that `diagramText` turns
// back once the diagram is drawn.
export function diagramLabel(text: string): string {
  const characters = [...text.replace(/\s+/g, ' ').trim()];
  return characters
    .map((character, index) => {
      const code = character.codePointAt(0) ?? 0;
      if (character === ' ' || plain.test(character)) return character;
      // Stand-ins that are already in a name are dropped: they would be read as punctuation.
      if (code >= standIn && code < standIn + 128) return '';
      if (code >= 128) return character;
      const after = plain.test(characters[index - 1] ?? '');
      const before = plain.test(characters[index + 1] ?? '');
      if (after && (character === '.' || (before && '-_'.includes(character)))) return character;
      return String.fromCodePoint(standIn + code);
    })
    .join('');
}

// Drawn text with the stand-ins of `diagramLabel` turned back into their characters. Give it
// to `MermaidDiagram` as `shown`; the result is put into the drawing as text.
export const diagramText = (drawn: string): string =>
  drawn.replace(/[\ue000-\ue07f]/g, (character) =>
    String.fromCodePoint((character.codePointAt(0) ?? standIn) - standIn),
  );

const gateMark = 'gate';

function arrow(from: string, to: string, words: readonly string[], rule: boolean): string {
  const label = words.length > 0 ? `|"${diagramLabel(words.join(' · '))}"|` : '';
  return `  ${from} ${rule ? '-.->' : '-->'}${label} ${to}`;
}

// One box per step in list order, a solid arrow to the next step (marked "otherwise" where the
// step has rules), a dotted arrow per rule with its condition, and "gate" on every arrow that
// passes a gate: the gate after the step it leaves (a failed step passes none) or the gate
// before the step it reaches.
export function pathsDiagram(steps: readonly DiagramStep[]): string {
  const node = new Map(steps.map((step, index) => [step.id, `s${index + 1}`]));
  const lines = ['flowchart TD', '  start(["Start"])'];
  steps.forEach((step, index) => {
    const name = step.skillName.trim() === '' ? 'no skill yet' : step.skillName;
    lines.push(`  s${index + 1}["${diagramLabel(`${index + 1}. ${name}`)}"]`);
  });
  lines.push('  finish(["End"])');

  const first = steps[0];
  lines.push(arrow('start', first ? 's1' : 'finish', first?.gateBefore ? [gateMark] : [], false));
  steps.forEach((step, index) => {
    const from = `s${index + 1}`;
    const next = steps[index + 1];
    const rules = step.rules ?? [];
    for (const rule of rules) {
      const target = rule.goTo.type === 'step' ? rule.goTo.stepId : undefined;
      const to = target === undefined ? 'finish' : node.get(target);
      // A rule whose step is gone is refused when the workflow is saved; it has no arrow.
      if (to === undefined) continue;
      const gated =
        (step.gateAfter && rule.when.fact !== 'stepFailed') ||
        steps.some((candidate) => candidate.id === target && candidate.gateBefore);
      lines.push(
        arrow(from, to, [...(gated ? [gateMark] : []), ruleConditionText(rule.when)], true),
      );
    }
    lines.push(
      arrow(
        from,
        next ? `s${index + 2}` : 'finish',
        [
          ...(step.gateAfter || next?.gateBefore ? [gateMark] : []),
          ...(rules.length > 0 ? ['otherwise'] : []),
        ],
        false,
      ),
    );
  });
  return lines.join('\n');
}
