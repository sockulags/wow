import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fileStatus, parseFrontmatter, parseUnits, readIntent, unitContracts } from './index.js';

const intentText = (rev = 1) =>
  `---\nid: 2026-01-tea-timer\nstatus: accepted\nrev: ${rev}\nsupersedes: null\n---\n\n# A tea timer that rings\n\n## Who and why\n\nInvented.\n`;
const specText = (builtOn = 1, rev = 1) =>
  `---\nintent: 2026-01-tea-timer\nrev: ${rev}\nbuilt_on: intent@${builtOn}\nstatus: accepted\n---\n\n# A tea timer that rings\n`;
const planText = ({
  builtOn = 1,
  source = 'files',
  units = defaultUnits,
  sections = defaultSections,
} = {}) =>
  `---\nintent: 2026-01-tea-timer\nrev: 1\nbuilt_on: spec@${builtOn}\nstatus: accepted\nsource: ${source}\n---\n\n# Plan: A tea timer\n\n## Units\n\n${units}\n\n${sections}`;

const defaultUnits = [
  '- [U1] Count down',
  '- [U2] Ring the bell — depends on U1 — blocked: the bell is on order',
  '- [U3] Show the time left -- depends on U1, U2',
].join('\n');
const defaultSections = [
  '### U1 Count down',
  '',
  'Outcome: the timer counts down.',
  'Acceptance:',
  '',
  '- Given three minutes, then it ends after three minutes.',
  '',
  '### U2 Ring the bell',
  '',
  'Outcome: a bell rings',
  'at the end.',
  'Boundaries: no volume control.',
  'Ground truth (commands): `pnpm test`',
  'Open risks: none.',
  '',
  '### U3 Show the time left',
  '',
  'Outcome: the time left shows.',
  '',
  '## Epic contract',
  '',
  'Outcome: not part of U3.',
].join('\n');

const tea = (files: { intent?: string; spec?: string; plan?: string }) =>
  readIntent({ id: '2026-01-tea-timer', ...files });

describe('frontmatter', () => {
  it('reads flat key: value pairs with their lines and strips quotes', () => {
    const parsed = parseFrontmatter(
      '---\r\nid: "a"\r\nrev: 3\r\n\r\nnot a pair\r\n---\r\nbody\r\n',
    );
    expect(parsed?.data).toEqual({ id: 'a', rev: '3' });
    expect(parsed?.lines).toEqual({ id: 2, rev: 3 });
    expect(parsed?.bodyLine).toBe(7);
    expect(parsed?.body).toBe('body\n');
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parseFrontmatter('\uFEFF---\nid: a\n---\nbody\n')?.data).toEqual({ id: 'a' });
  });

  it('answers null without a closed --- block', () => {
    expect(parseFrontmatter('# Title\n')).toBeNull();
    expect(parseFrontmatter('---\nid: a\n')).toBeNull();
  });
});

describe('intent folder', () => {
  it('reads title, status, revision and which files exist', () => {
    const all = tea({ intent: intentText(), spec: specText(), plan: planText() });
    expect(all).toMatchObject({
      id: '2026-01-tea-timer',
      title: 'A tea timer that rings',
      hasIntent: true,
      status: 'accepted',
      rev: 1,
      spec: { rev: 1, status: 'accepted', stale: null },
      plan: { rev: 1, status: 'accepted', stale: null },
      source: 'files',
      problems: [],
    });
    const alone = tea({ intent: intentText(2) });
    expect(alone).toMatchObject({ rev: 2, spec: null, plan: null, source: null, units: [] });
    expect(alone.problems).toEqual([]);
  });

  it('marks a spec stale against a newer intent and a plan against a newer spec', () => {
    const staleSpec = tea({ intent: intentText(2), spec: specText(1), plan: planText() });
    expect(staleSpec.spec?.stale).toEqual({ builtOn: 1, current: 2 });
    expect(staleSpec.plan?.stale).toBeNull();
    const stalePlan = tea({ intent: intentText(), spec: specText(1, 3), plan: planText() });
    expect(stalePlan.spec?.stale).toBeNull();
    expect(stalePlan.plan?.stale).toEqual({ builtOn: 1, current: 3 });
    expect(staleSpec.problems).toEqual([]);
  });

  it('reports a malformed built_on, a bad rev and missing frontmatter with their lines', () => {
    const document = tea({
      intent: '# No frontmatter\n',
      spec: specText().replace('built_on: intent@1', 'built_on: intent'),
      plan: planText().replace('rev: 1', 'rev: one'),
    });
    expect(document.title).toBe('A tea timer that rings');
    expect(document.problems).toEqual([
      { file: 'intent', line: 1, message: 'Missing frontmatter between --- lines' },
      { file: 'plan', line: 3, message: 'rev must be a positive whole number' },
      { file: 'spec', line: 4, message: 'built_on must look like intent@<rev>' },
    ]);
  });

  it('does not take a run of digits too long to be a number for a revision', () => {
    const digits = '99999999999999999999999';
    const document = tea({
      intent: intentText().replace(/rev: \d+/, `rev: ${digits}`),
      spec: specText().replace('built_on: intent@1', `built_on: intent@${digits}`),
    });
    expect(document.rev).toBeNull();
    expect(document.spec?.stale).toBeNull();
    expect(document.problems.map((problem) => `${problem.file}: ${problem.message}`)).toEqual([
      'intent: rev must be a positive whole number',
      'spec: built_on must look like intent@<rev>',
    ]);
    expect(tea({ intent: intentText().replace(/rev: \d+/, 'rev: 9007199254740991') }).rev).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('reports a folder name that is not an intent id', () => {
    expect(readIntent({ id: 'demo', intent: intentText() }).problems).toEqual([
      {
        file: 'intent',
        line: 1,
        message: 'Folder name must be <YYYY-MM>-<slug> in lowercase kebab-case',
      },
    ]);
  });
});

describe('plan units', () => {
  it('reads keys, titles, dependencies and the blocked note from both dash forms', () => {
    const { units } = tea({ intent: intentText(), spec: specText(), plan: planText() });
    expect(
      units.map(({ key, title, dependsOn, blocked, line }) => ({
        key,
        title,
        dependsOn,
        blocked,
        line,
      })),
    ).toEqual([
      { key: 'U1', title: 'Count down', dependsOn: [], blocked: null, line: 13 },
      {
        key: 'U2',
        title: 'Ring the bell',
        dependsOn: ['U1'],
        blocked: 'the bell is on order',
        line: 14,
      },
      { key: 'U3', title: 'Show the time left', dependsOn: ['U1', 'U2'], blocked: null, line: 15 },
    ]);
  });

  it('reads a unit line with a very long run of spaces without slowing down', () => {
    // A hundred thousand spaces took minutes when notes were split on runs of whitespace.
    const list = parseUnits(`## Units\n- [U1] a${' '.repeat(100_000)}b — depends on U2\n`);
    expect(list?.units).toEqual([
      { key: 'U1', title: 'a b', dependsOn: ['U2'], blocked: null, line: 2 },
    ]);
  });

  it('reads notes case-insensitively and stops at the next ## heading', () => {
    const list = parseUnits(
      '## Units\n- [A.1] One — Depends On B/2 — BLOCKED: wait\n## Later\n- [C] Not a unit\n',
    );
    expect(list?.units).toEqual([
      { key: 'A.1', title: 'One', dependsOn: ['B/2'], blocked: 'wait', line: 2 },
    ]);
  });

  it('shows the contract fields a ### section has for source: files, absent ones left out', () => {
    const { units, problems } = tea({ intent: intentText(), spec: specText(), plan: planText() });
    expect(units[0]?.contract).toEqual([
      { name: 'Outcome', value: 'the timer counts down.' },
      { name: 'Acceptance', value: '- Given three minutes, then it ends after three minutes.' },
    ]);
    expect(units[1]?.contract).toEqual([
      { name: 'Outcome', value: 'a bell rings\nat the end.' },
      { name: 'Boundaries', value: 'no volume control.' },
      { name: 'Ground truth', value: '`pnpm test`' },
      { name: 'Open risks', value: 'none.' },
    ]);
    expect(units[2]?.contract).toEqual([{ name: 'Outcome', value: 'the time left shows.' }]);
    expect(problems).toEqual([]);
  });

  it('keeps key, title and the blocked note for source: issues', () => {
    const { units, source, problems } = tea({
      intent: intentText(),
      spec: specText(),
      plan: planText({ source: 'issues', sections: '' }),
    });
    expect(source).toBe('issues');
    expect(units).toEqual([
      { key: 'U1', title: 'Count down', line: 13, dependsOn: [], blocked: null, contract: null },
      {
        key: 'U2',
        title: 'Ring the bell',
        line: 14,
        dependsOn: [],
        blocked: 'the bell is on order',
        contract: null,
      },
      {
        key: 'U3',
        title: 'Show the time left',
        line: 15,
        dependsOn: [],
        blocked: null,
        contract: null,
      },
    ]);
    expect(problems).toEqual([]);
  });

  it('says what the files alone say about a unit', () => {
    const { units } = tea({ intent: intentText(), spec: specText(), plan: planText() });
    expect(units.map(fileStatus)).toEqual(['unknown', 'blocked', 'unknown']);
    const inIssues = tea({
      intent: intentText(),
      spec: specText(),
      plan: planText({ source: 'issues', sections: '' }),
    });
    expect(inIssues.units.map(fileStatus)).toEqual(['unknown', 'blocked', 'unknown']);
  });

  it('reports a plan without unit lines with the line of its heading', () => {
    const empty = tea({
      intent: intentText(),
      plan: planText({ units: 'Nothing yet.', sections: '' }),
    });
    expect(empty.units).toEqual([]);
    expect(empty.problems).toEqual([
      { file: 'plan', line: 11, message: '"## Units" has no "- [KEY] title" lines' },
    ]);
    const none = tea({ plan: planText().replace('## Units', '## Pieces') });
    expect(none.problems).toContainEqual({
      file: 'plan',
      line: 8,
      message: 'Needs a "## Units" section with at least one "- [KEY] title" line',
    });
  });

  it('reports a duplicate key, an unknown dependency, a missing section and a bad source', () => {
    const document = tea({
      intent: intentText(),
      spec: specText(),
      plan: planText({
        units: '- [U1] Count down\n- [U1] Count again — depends on U9\n- [U4] No section',
      }).replace('source: files', 'source: files '),
    });
    expect(document.units.map((unit) => unit.key)).toEqual(['U1', 'U1', 'U4']);
    expect(document.problems).toEqual([
      { file: 'plan', line: 14, message: 'Unit key U1 appears twice' },
      { file: 'plan', line: 14, message: 'Unit U1 depends on unknown unit U9' },
      { file: 'plan', line: 15, message: 'Unit U4 needs a "### U4 <title>" section' },
    ]);
    const badSource = tea({ plan: planText({ source: 'tracker' }) });
    expect(badSource.source).toBeNull();
    expect(badSource.problems).toContainEqual({
      file: 'plan',
      line: 6,
      message: 'source must be files or issues',
    });
  });

  it('ends a contract at the next ## heading', () => {
    expect(unitContracts(defaultSections).get('U3')).toEqual([
      { name: 'Outcome', value: 'the time left shows.' },
    ]);
  });
});

// The agent-os format as this repository's own plans use it.
describe('this repository', () => {
  const intentsDir = fileURLToPath(new URL('../../../intents', import.meta.url));
  const read = (id: string) => {
    const text = (name: string) => {
      try {
        return readFileSync(path.join(intentsDir, id, name), 'utf8');
      } catch {
        return undefined;
      }
    };
    return readIntent({
      id,
      intent: text('intent.md'),
      spec: text('spec.md'),
      plan: text('plan.md'),
    });
  };

  it('reads the review-loop plan: fourteen units with full contracts and no problems', () => {
    const document = read('2026-11-review-loop');
    expect(document.problems).toEqual([]);
    expect(document.source).toBe('files');
    expect(document.units.map((unit) => unit.key)).toEqual(
      Array.from({ length: 14 }, (_, index) => `U${index + 1}`),
    );
    const u6 = document.units.find((unit) => unit.key === 'U6');
    expect(u6?.dependsOn).toEqual(['U4', 'U5']);
    const u5 = document.units.find((unit) => unit.key === 'U5');
    expect(u5?.title).toBe('Plan files and the Plans view');
    expect(u5?.contract?.map((field) => field.name)).toEqual([
      'Outcome',
      'Boundaries',
      'Change surface',
      'Acceptance',
      'Ground truth',
      'Dependencies',
      'Evidence and settled decisions',
      'Delivery target',
      'Open risks',
    ]);
  });

  it('reads the app plan: seventeen units, a stale spec, and absent contract fields without problems', () => {
    const document = read('2026-11-wow-app');
    expect(document.problems).toEqual([]);
    expect(document.units).toHaveLength(17);
    expect(document.rev).toBe(2);
    expect(document.spec?.stale).toEqual({ builtOn: 1, current: 2 });
    expect(document.plan?.stale).toBeNull();
    const u2 = document.units.find((unit) => unit.key === 'U2');
    expect(u2?.contract?.map((field) => field.name)).toEqual([
      'Outcome',
      'Boundaries',
      'Acceptance',
      'Ground truth',
      'Delivery target',
      'Open risks',
    ]);
  });

  it('reads every intent folder without throwing', () => {
    for (const id of readdirSync(intentsDir)) expect(read(id).id).toBe(id);
  });
});
