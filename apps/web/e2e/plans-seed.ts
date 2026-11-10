import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Invented intent folders in the agent-os format for the Plans view. They live in their own
// folder of the seeded project (the `plans.intentsDirectory` project setting points at it), so
// the workflow tests' `intents/*` artifacts are left alone.
export const e2ePlansDirectory = 'plan-files';
export const e2ePlansDir = (home: string) => path.join(home, e2ePlansDirectory);

const front = (pairs: Record<string, string | number>) =>
  ['---', ...Object.entries(pairs).map(([key, value]) => `${key}: ${value}`), '---', ''].join('\n');

export const e2eIntentMd = (id: string, title: string, rev = 1) =>
  `${front({ id, status: 'accepted', rev, supersedes: 'null' })}\n# ${title}\n\n## Who and why\n\nInvented for the tests.\n`;

export const e2eSpecMd = (id: string, title: string, builtOn = 1) =>
  `${front({ intent: id, rev: 1, built_on: `intent@${builtOn}`, status: 'accepted' })}\n# ${title}\n\n## Behavior\n\n1. Invented.\n`;

export const e2ePlanMd = (id: string, title: string, body: string, source = 'files') =>
  `${front({ intent: id, rev: 1, built_on: 'spec@1', status: 'accepted', source })}\n# Plan: ${title}\n\n${body}\n`;

const teaUnits = `## Units

- [U1] Count down from a chosen time
- [U2] Ring the bell at zero — depends on U1 — blocked: the bell is on order
- [U3] Show the time left on the lid -- depends on U1, U2
- [U4] Remember the last three teas — depends on U1

### U1 Count down from a chosen time

Outcome: the timer counts down from one to twenty minutes and stops at zero.
Boundaries: no bell and no display; those are U2 and U3.
Change surface: \`timer/countdown.ts\` and its tests.
Acceptance:

- Given three minutes, when the timer starts, then it reaches zero after three minutes.
- Given a running timer, when it is stopped, then the time left stays.

Ground truth: \`pnpm --filter @tea/timer test\`.
Dependencies: none.
Evidence and settled decisions: the clock is passed in, so tests never wait.
Delivery target: pull request.
Open risks: none.

### U2 Ring the bell at zero

Outcome: a bell rings once when the timer reaches zero.
Boundaries: no volume setting.
Acceptance:

- Given a timer at zero, then the bell rings once.

Ground truth: \`pnpm --filter @tea/bell test\`.
Open risks: the bell has not arrived.

### U3 Show the time left on the lid

Outcome: the lid shows minutes and seconds left.
Acceptance:

- Given 2:05 left, then the lid shows 2:05.

### U4 Remember the last three teas

Outcome: the last three times are offered first.
Acceptance:

- Given three earlier teas, then they are listed newest first.
`;

const kettleUnits = `## Units

- [K-1] Boil to a chosen temperature
- [K-2] Keep warm for ten minutes -- depends on K-1 -- blocked: the thermostat is on order
`;

export const e2eLiveIntentId = '2026-04-compost-log';
export const e2eLivePlan = (units: string) =>
  e2ePlanMd(e2eLiveIntentId, 'A compost log', `## Units\n\n${units}\n`, 'issues');

export async function seedPlanFiles(home: string): Promise<void> {
  const write = async (id: string, files: Record<string, string>) => {
    const folder = path.join(e2ePlansDir(home), id);
    await mkdir(folder, { recursive: true });
    for (const [name, text] of Object.entries(files))
      await writeFile(path.join(folder, name), text);
  };
  const tea = 'A tea timer that rings when the tea is ready';
  await write('2026-01-tea-timer', {
    'intent.md': e2eIntentMd('2026-01-tea-timer', tea, 2),
    'spec.md': e2eSpecMd('2026-01-tea-timer', tea, 1),
    'plan.md': e2ePlanMd('2026-01-tea-timer', tea, teaUnits),
  });
  const kettle = 'A kettle that stops at the right temperature';
  await write('2026-02-kettle', {
    'intent.md': e2eIntentMd('2026-02-kettle', kettle),
    'spec.md': e2eSpecMd('2026-02-kettle', kettle),
    'plan.md': e2ePlanMd('2026-02-kettle', kettle, kettleUnits, 'issues'),
  });
  const beds = 'Raised beds watered on a schedule';
  await write('2026-03-raised-beds', {
    'intent.md': e2eIntentMd('2026-03-raised-beds', beds),
    'spec.md': e2eSpecMd('2026-03-raised-beds', beds),
    'plan.md': e2ePlanMd('2026-03-raised-beds', beds, '## Units\n\nThe units are not written yet.'),
  });
  await write(e2eLiveIntentId, {
    'intent.md': e2eIntentMd(e2eLiveIntentId, 'A compost log'),
    'spec.md': e2eSpecMd(e2eLiveIntentId, 'A compost log'),
    'plan.md': e2eLivePlan('- [C1] Weigh what goes in'),
  });
  await write('2026-05-seed-swap', {
    'intent.md': e2eIntentMd('2026-05-seed-swap', 'A seed swap list for the street'),
  });
}
