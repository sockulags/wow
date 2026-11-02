import { Outlet, useRouterState } from '@tanstack/react-router';
import { PanelLeftIcon, PanelRightIcon, SearchIcon } from 'lucide-react';
import { useLayoutEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ProviderDialogs } from '@/providers/provider-dialogs';
import { formatBinding } from './keybindings';
import { Toaster } from './notifications';
import { CommandPalette } from './palette';
import { useLayout, useRuntime, useSetting } from './runtime';
import { sections } from './sections';
import { Sidebar } from './sidebar';
import { UpdateBanner } from './update-banner';
import { useCommands, useGlobalKeybindings } from './use-commands';

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

function RightPanel() {
  return (
    <aside
      aria-label="Details"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="flex h-11 items-center border-b border-border px-3 text-xs font-medium text-muted-foreground">
        Details
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Select a thread, card or run to see its details here.
      </div>
    </aside>
  );
}

export function Shell() {
  const { layout } = useRuntime();
  const sidebarOpen = useLayout((state) => state.sidebarOpen);
  const rightPanelOpen = useLayout((state) => state.rightPanelOpen);
  const paletteBinding = useSetting('keybindings.palette');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const title = sections.find((section) => pathname.startsWith(section.path))?.title ?? 'wow';
  const { commands, context } = useCommands();
  useGlobalKeybindings(commands, context);
  useApplyTheme();
  useApplyAppearance();

  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      {sidebarOpen && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle sidebar"
            aria-pressed={sidebarOpen}
            onClick={() => layout.setState({ sidebarOpen: !sidebarOpen })}
          >
            <PanelLeftIcon />
          </Button>
          <h1 className="px-1 text-sm font-medium">{title}</h1>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground"
              onClick={() => layout.setState({ paletteOpen: true })}
            >
              <SearchIcon />
              Search
              {paletteBinding !== '' && (
                <kbd className="font-mono text-xs">{formatBinding(paletteBinding)}</kbd>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle right panel"
              aria-pressed={rightPanelOpen}
              onClick={() => layout.setState({ rightPanelOpen: !rightPanelOpen })}
            >
              <PanelRightIcon />
            </Button>
          </div>
        </header>
        <UpdateBanner />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
      {rightPanelOpen && <RightPanel />}
      <CommandPalette commands={commands} context={context} />
      <ProviderDialogs />
      <Toaster />
    </div>
  );
}
