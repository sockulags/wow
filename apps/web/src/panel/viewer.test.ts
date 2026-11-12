import { createMemorySettingsSource, createSettingsStore } from '@wow/client-runtime';
import { describe, expect, it } from 'vitest';
import { createLayoutStore } from '@/app/runtime';
import { fullPathOf, openFile, panelTabsOf } from './viewer';

// Agent workbench spec 11: opening an open file selects its tab, however the file is named.

const context = () => ({
  layout: createLayoutStore(),
  settings: createSettingsStore(
    createMemorySettingsSource(undefined, { 'appearance.contextPanel': true }),
  ),
});

const open = (runtime: ReturnType<typeof context>, folder: string, path: string) =>
  openFile(runtime, {
    scope: { threadId: 'tea' },
    path,
    fullPath: fullPathOf(folder, path),
    from: '/chat/tea',
  });

const tabNames = (runtime: ReturnType<typeof context>) =>
  panelTabsOf(runtime.layout.getState(), '/chat/tea').tabs.map((tab) =>
    tab.kind === 'file' ? tab.file.path : tab.id,
  );

describe('file tabs', () => {
  it('opens one tab for one file named four ways', () => {
    const runtime = context();
    for (const path of [
      'src/timer.ts',
      './src/timer.ts',
      'src\\timer.ts',
      '/work/tea/src/timer.ts',
    ])
      open(runtime, '/work/tea', path);
    open(runtime, '/work/tea', 'src/other.ts');
    expect(tabNames(runtime)).toEqual(['src/timer.ts', 'src/other.ts']);
  });

  it('takes a Windows path in any case and either slash as the same file', () => {
    const runtime = context();
    open(runtime, 'C:\\work\\tea', 'src/timer.ts');
    open(runtime, 'C:\\work\\tea', 'c:/Work/Tea/src/Timer.ts');
    expect(tabNames(runtime)).toEqual(['src/timer.ts']);
  });
});
