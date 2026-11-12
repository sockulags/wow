import type { PlanIntent } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';

// The plans service with the real watcher. Nothing here waits on a clock: each step waits for the
// commit the watcher's report leads to.

const id = '2026-06-compost-log';
const intentMd = `---\nid: ${id}\nstatus: accepted\nrev: 1\nsupersedes: null\n---\n\n# A compost log\n`;
const planMd = (units: string) =>
  `---\nintent: ${id}\nrev: 1\nbuilt_on: spec@1\nstatus: accepted\nsource: issues\n---\n\n# Plan\n\n## Units\n\n${units}\n`;

let root: string;
let server: RunningServer;

const rows = (): PlanIntent[] =>
  snapshot(server.database.db, { topic: 'planIntents' }) as PlanIntent[];
const unitKeys = (): string[] | undefined => rows()[0]?.units.map((unit) => unit.key);

// Resolves with the first stored state of the plans topic that passes.
function stored(passes: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = server.engine.onCommit(() => {
      if (!passes()) return;
      stop();
      resolve();
    });
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-plans-watch-'));
  await mkdir(path.join(root, 'garden'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
  });
  server.engine.dispatch('create-garden', {
    type: 'project.create',
    projectId: 'garden',
    name: 'garden',
    cwd: path.join(root, 'garden'),
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('plans watcher', () => {
  it('reads a plan again after it was rewritten in place, even when a read saw it empty', async () => {
    const folder = path.join(root, 'garden', 'intents', id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'intent.md'), intentMd);
    await writeFile(path.join(folder, 'plan.md'), planMd('- [C1] Weigh what goes in'));
    await server.plans.refresh();
    expect(unitKeys()).toEqual(['C1']);

    // What a save in place does: the file is emptied, then written. The read in between is the
    // worst case, and the watcher has to report the finished file after it.
    const file = await open(path.join(folder, 'plan.md'), 'w');
    await server.plans.refresh();
    expect(rows()[0]?.problems.map((problem) => problem.message)).toEqual([
      'Missing frontmatter between --- lines',
    ]);
    const followed = stored(() => unitKeys()?.join() === 'C1,C2');
    await file.writeFile(planMd('- [C1] Weigh what goes in\n- [C2] Turn the heap weekly'));
    await file.close();
    await followed;
    expect(rows()[0]?.problems).toEqual([]);
  });

  it('never shows a half-written plan while a file is saved over and over', async () => {
    const folder = path.join(root, 'garden', 'intents', id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'intent.md'), intentMd);
    await writeFile(path.join(folder, 'plan.md'), planMd('- [C0] Weigh what goes in'));
    await server.plans.refresh();

    const seen: string[] = [];
    const stop = server.engine.onCommit(() => {
      seen.push(...(rows()[0]?.problems.map((problem) => problem.message) ?? []));
    });
    const units = ['- [C0] Weigh what goes in'];
    for (let save = 1; save <= 5; save += 1) {
      units.push(`- [C${save}] Turn the heap, week ${save}`);
      const followed = stored(() => unitKeys()?.length === units.length);
      await writeFile(path.join(folder, 'plan.md'), planMd(units.join('\n')));
      await followed;
    }
    stop();
    expect(seen).toEqual([]);
  });

  it('reads an intents folder created after the start on the next read and follows its removal', async () => {
    await server.plans.refresh();
    expect(rows()).toEqual([]);

    const folder = path.join(root, 'garden', 'intents', id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'intent.md'), intentMd);
    await server.plans.refresh();
    expect(rows()[0]).toMatchObject({ intentId: id, title: 'A compost log' });

    const removed = stored(() => rows().length === 0);
    await rm(path.join(root, 'garden', 'intents'), { recursive: true });
    await removed;

    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'intent.md'), intentMd);
    await server.plans.refresh();
    expect(rows()).toHaveLength(1);
  });
});
