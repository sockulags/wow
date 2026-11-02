import { describe, expect, it } from 'vitest';
import { applicationMenu } from './app-menu.js';

describe('window menu (audit B-14)', () => {
  it('has no menu in packaged Windows and Linux builds and only App and Edit on macOS', () => {
    expect(applicationMenu('win32', true)).toBeNull();
    expect(applicationMenu('linux', true)).toBeNull();
    expect(applicationMenu('darwin', true)).toEqual([{ role: 'appMenu' }, { role: 'editMenu' }]);
  });

  it("keeps Electron's menu in development for DevTools and reload", () => {
    expect(applicationMenu('win32', false)).toBeUndefined();
  });
});
