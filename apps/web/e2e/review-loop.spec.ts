import { expect, test } from '@playwright/test';
import { settingsRegistry, type SettingGroup } from '@wow/contracts';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// U14 of the review loop: the spec's ground truth names the behaviors `pnpm e2e` must cover. Each
// case that covers one carries `@review-loop-<n>` in its title, so `pnpm e2e --grep @review-loop`
// runs exactly those and the report lists them. These checks read files only; no browser starts.

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..', '..');
const intent = path.join(repository, 'intents', '2026-11-review-loop');
const read = (file: string) => readFile(file, 'utf8');
const tag = '@review-loop-';

function groundTruthBehaviors(spec: string): number[] {
  const section = spec.slice(spec.indexOf('## Ground truth'));
  const line = /`pnpm e2e` covers behaviors ([\d,\sand]+?) against/.exec(section)?.[1];
  if (!line) throw new Error('The spec names no behaviors for `pnpm e2e`');
  return [...line.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

async function taggedBehaviors(): Promise<Map<number, string[]>> {
  const covered = new Map<number, string[]>();
  const own = path.basename(fileURLToPath(import.meta.url));
  for (const file of await readdir(here)) {
    if (!file.endsWith('.spec.ts') || file === own) continue;
    const text = await read(path.join(here, file));
    for (const title of text.matchAll(/test\(\s*'([^']*)'/g)) {
      for (const match of (title[1] ?? '').matchAll(new RegExp(`${tag}(\\d+)`, 'g'))) {
        const behavior = Number(match[1]);
        covered.set(behavior, [...(covered.get(behavior) ?? []), `${file}: ${title[1]}`]);
      }
    }
  }
  return covered;
}

test.describe('review loop coverage', () => {
  test('every behavior the ground truth names has an e2e case that names it', async () => {
    const named = groundTruthBehaviors(await read(path.join(intent, 'spec.md')));
    expect(named.length).toBeGreaterThan(0);
    const covered = await taggedBehaviors();
    expect(named.filter((behavior) => !covered.has(behavior))).toEqual([]);
    // A tag for a behavior the ground truth does not name is a typo.
    expect([...covered.keys()].filter((behavior) => !named.includes(behavior))).toEqual([]);
  });

  test('every sketch the spec interface names exists', async () => {
    const spec = await read(path.join(intent, 'spec.md'));
    const interfaceSection = spec.slice(spec.indexOf('## Interface'), spec.indexOf('## Bound'));
    const sketches = [
      ...interfaceSection.matchAll(/`intents\/2026-11-review-loop\/sketches\/([\w-]+\.png)`/g),
    ].map((match) => match[1] ?? '');
    expect(sketches.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const sketch of sketches) {
      await access(path.join(intent, 'sketches', sketch)).catch(() => missing.push(sketch));
    }
    expect(missing).toEqual([]);
  });

  test('the user guide names every setting of the groups the review loop added', async () => {
    const guide = await read(path.join(repository, 'docs', 'user-guide.md'));
    const added = new Set<SettingGroup>([
      'plans',
      'hosts',
      'triggers',
      'viewer',
      'diff',
      'workspaces',
    ]);
    const keybindings = [
      'keybindings.goPlans',
      'keybindings.gateApprove',
      'keybindings.gateSendBack',
      'keybindings.runChanges',
      'keybindings.changesStepOnly',
    ];
    const reviewLoopSettings = [
      'workflows.sendBackTemplate',
      'workflows.unitPromptTemplate',
      'workflows.planRunOnFailure',
      'workflows.verdictApprovedLine',
      'workflows.alwaysStopSkills',
      'workflows.gateChecksTimeoutMinutes',
      'trackers.gitlab.baseUrl',
      'trackers.gitlab.token',
      'trackers.confluence.baseUrl',
      'trackers.confluence.token',
    ];
    const keys = [
      ...Object.entries(settingsRegistry)
        .filter(([, definition]) => added.has(definition.group))
        .map(([key]) => key),
      ...keybindings,
      ...reviewLoopSettings,
    ];
    for (const key of keys) expect(settingsRegistry, key).toHaveProperty([key]);
    expect(keys.filter((key) => !guide.includes(`\`${key}\``))).toEqual([]);
  });

  test('the Windows smoke check has the three manual review loop steps', async () => {
    const smoke = await read(path.join(repository, 'docs', 'windows-smoke.md'));
    const section = smoke.slice(smoke.indexOf('## 9. Hosts'), smoke.indexOf('## 10.'));
    expect(section).toMatch(/followed plan[\s\S]*GitHub Enterprise[\s\S]*personal access token/);
    expect(section).toMatch(/Jira ticket[\s\S]*Confluence page/);
    expect(section).toMatch(/working copy[\s\S]*path with spaces/);
  });
});
