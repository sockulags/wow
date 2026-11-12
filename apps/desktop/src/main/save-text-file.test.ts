import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bareFileName, saveTextFile, type SaveDialogOptions } from './save-text-file.js';

// Thread work spec 7: "Save conversation…" goes through the system's save dialog, only for the
// app's own pages, and writes the text as UTF-8.

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function tempFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'wow-save-'));
  folders.push(folder);
  return folder;
}

const text = '# Tell the kettle story\n\n## You · 20:41\n\nWhistle — ça bout, 沸騰 ☕\n';

describe('wow:save-text-file', () => {
  it('shows the save dialog with the bare title and writes the text as UTF-8', async () => {
    const folder = await tempFolder();
    const target = path.join(folder, 'chosen.md');
    const asked: SaveDialogOptions[] = [];
    const saved = await saveTextFile(
      { suggestedName: 'Tell the kettle story.md', text },
      {
        fromApp: true,
        folder: '/home/me/Documents',
        showSaveDialog: (options) => {
          asked.push(options);
          return Promise.resolve({ canceled: false, filePath: target });
        },
      },
    );
    expect(saved).toBe(target);
    expect(asked).toEqual([
      {
        title: 'Save conversation',
        defaultPath: path.join('/home/me/Documents', 'Tell the kettle story.md'),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      },
    ]);
    const bytes = await readFile(target);
    expect(bytes.toString('utf8')).toBe(text);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it('answers null and writes nothing when the dialog is cancelled', async () => {
    const folder = await tempFolder();
    const saved = await saveTextFile(
      { suggestedName: 'Story.md', text },
      {
        fromApp: true,
        folder,
        showSaveDialog: () => Promise.resolve({ canceled: true }),
      },
    );
    expect(saved).toBeNull();
    expect(await readdir(folder)).toEqual([]);
  });

  it('answers only the app’s own pages and only a request it can read', async () => {
    let shown = 0;
    const shell = (fromApp: boolean) => ({
      fromApp,
      folder: '/docs',
      showSaveDialog: () => {
        shown += 1;
        return Promise.resolve({ canceled: true });
      },
    });
    expect(await saveTextFile({ suggestedName: 'a.md', text: 'x' }, shell(false))).toBeNull();
    expect(await saveTextFile({ suggestedName: '', text: 'x' }, shell(true))).toBeNull();
    expect(await saveTextFile({ path: '/etc/passwd', text: 'x' }, shell(true))).toBeNull();
    expect(shown).toBe(0);
  });

  it('cuts a suggested name to a bare file name', () => {
    expect(bareFileName('..\\..\\Windows\\win.ini')).toBe('win.ini.md');
    expect(bareFileName('../../etc/kettle')).toBe('kettle.md');
    expect(bareFileName('What? <now>: "tea" | coffee*.md')).toBe('What now tea  coffee.md');
    expect(bareFileName('   ')).toBe('conversation.md');
    expect(bareFileName('Notes. . .')).toBe('Notes.md');
  });
});
