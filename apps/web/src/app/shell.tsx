import { Outlet, useRouterState } from '@tanstack/react-router';
import { PanelLeftIcon, PanelRightIcon, SearchIcon } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { IconButton, ShortcutHint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { ContextPanel } from '@/panel/context-panel';
import { OpenFileDialog } from '@/panel/file-list';
import {
  CONTEXT_PANEL_ID,
  MAIN_VIEW_ID,
  toggleContextPanel,
  useContextPanelShown,
} from '@/panel/panel-state';
import { ProjectDialogs } from '@/projects/project-dialogs';
import { ProviderDialogs } from '@/providers/provider-dialogs';
import { ConnectionBanner } from './connection-banner';
import { FirstStart, useFirstStart } from './first-start';
import { AppToaster } from './notifications';
import { CommandPalette } from './palette';
import { useLayout, useRuntime, useSetting } from './runtime';
import { sections } from './sections';
import { Sidebar } from './sidebar';
import { UpdateBanner } from './update-banner';
import { ShellToolbarSlot } from './shell-toolbar';
import { useCommands, useGlobalKeybindings } from './use-commands';
import { publishPaletteCommands } from '@/chat/slash-commands';

function useApplyTheme() {
  const theme = useSetting('appearance.theme');
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  }, [theme]);
}

function useApplyAppearance() {
  const uiFont = useSetting('appearance.uiFont');
  const codeFont = useSetting('appearance.codeFont');
  const density = useSetting('appearance.density');
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--app-font-ui', `"${uiFont}"`);
    root.style.setProperty('--app-font-code', `"${codeFont}"`);
    root.dataset['density'] = density;
  }, [uiFont, codeFont, density]);
}

export function Shell() {
  const { layout, settings } = useRuntime();
  const sidebarOpen = useLayout((state) => state.sidebarOpen);
  const panelShown = useContextPanelShown();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const title = sections.find((section) => pathname.startsWith(section.path))?.title ?? 'wow';
  const gated = useFirstStart();
  const { commands, context } = useCommands(gated);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  useGlobalKeybindings(commands, context);
  // The composer's `/` list runs the palette's commands (agent workbench spec 58).
  useLayoutEffect(() => publishPaletteCommands(commands, context), [commands, context]);
  useApplyTheme();
  useApplyAppearance();

  if (gated) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden bg-background text-foreground">
        <ConnectionBanner />
        <FirstStart />
        <CommandPalette commands={commands} context={context} />
        <ProviderDialogs />
        <AppToaster />
      </div>
    );
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-background text-foreground">
      {sidebarOpen && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
          <IconButton
            label="Toggle sidebar"
            shortcut="keybindings.toggleSidebar"
            aria-pressed={sidebarOpen}
            onClick={() => layout.setState({ sidebarOpen: !sidebarOpen })}
          >
            <PanelLeftIcon />
          </IconButton>
          <h1 className="shrink-0 px-1 text-sm font-medium">{title}</h1>
          {/* Views put their toolbar here with <ShellToolbar>, so it shares the header row. */}
          <div ref={setToolbarSlot} className="flex min-w-0 flex-1 items-center gap-2" />
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => layout.setState({ paletteOpen: true })}
            >
              <SearchIcon />
              <span className="max-lg:sr-only">Search</span>
              <ShortcutHint shortcut="keybindings.palette" className="max-lg:hidden" />
            </Button>
            <IconButton
              label="Toggle context panel"
              shortcut="keybindings.toggleRightPanel"
              aria-pressed={panelShown}
              aria-controls={panelShown ? CONTEXT_PANEL_ID : undefined}
              onClick={() => toggleContextPanel({ settings, layout })}
            >
              <PanelRightIcon />
            </IconButton>
          </div>
        </header>
        <ConnectionBanner />
        <UpdateBanner />
        <ShellToolbarSlot value={toolbarSlot}>
          <div
            id={MAIN_VIEW_ID}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            <Outlet />
          </div>
        </ShellToolbarSlot>
      </main>
      {panelShown && <ContextPanel />}
      <CommandPalette commands={commands} context={context} />
      <OpenFileDialog />
      <ProviderDialogs />
      <ProjectDialogs />
      <AppToaster />
    </div>
  );
}
