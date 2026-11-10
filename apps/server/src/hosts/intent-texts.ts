import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { locateIntents } from '../plans/service.js';

// The files of one intent whose links can name pages (review loop spec 35): the intent, its spec
// and its plan, as they are in the project folder. Only files, never a link out of the intents
// folder, and only an intent id that is one folder name.
const files = ['intent.md', 'spec.md', 'plan.md'];

export async function readIntentTexts(
  project: { readonly cwd: string },
  setting: string,
  intentId: string,
): Promise<string[]> {
  if (intentId === '' || intentId === '.' || intentId === '..' || /[\\/:]/.test(intentId)) {
    return [];
  }
  const { dir } = await locateIntents(project, setting);
  if (!dir) return [];
  const texts: string[] = [];
  for (const name of files) {
    const file = path.join(dir, intentId, name);
    const found = await lstat(file).catch(() => undefined);
    if (!found?.isFile()) continue;
    const folder = await lstat(path.dirname(file)).catch(() => undefined);
    if (!folder?.isDirectory()) continue;
    texts.push(await readFile(file, 'utf8').catch(() => ''));
  }
  return texts;
}
