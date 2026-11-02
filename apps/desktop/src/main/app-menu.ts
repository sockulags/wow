// The application menu (audit B-14). Electron's default menu brings zoom (Ctrl+=, Ctrl+-, Ctrl+0),
// reload (Ctrl+R), DevTools (Ctrl+Shift+I) and an Alt-revealed File/Edit/View bar that are not
// part of wow, and its zoom keys took the calendar's zoom shortcuts. A packaged build therefore
// has no menu on Windows and Linux (text fields still cut, copy and paste natively) and only the
// app and Edit menus on macOS, where copy and paste need them. Development keeps Electron's menu
// for DevTools and reload.

export type MenuRole = 'appMenu' | 'editMenu';

// `undefined` keeps Electron's default menu; `null` removes the menu.
export function applicationMenu(
  platform: NodeJS.Platform,
  packaged: boolean,
): readonly { readonly role: MenuRole }[] | null | undefined {
  if (!packaged) return undefined;
  if (platform === 'darwin') return [{ role: 'appMenu' }, { role: 'editMenu' }];
  return null;
}
