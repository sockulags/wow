import { useNavigate, useRouterState } from '@tanstack/react-router';
import { SettingsIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ShortcutHint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThreadList } from '@/chat/thread-list';
import { cn } from '@/lib/utils';
import { openThreadOf } from './notifications';
import { sections, type Section } from './sections';

// The app's left side (orchestrator threads spec 30, 33): the thread list, and at its bottom one
// settings button whose menu opens Calendar, Backlog, Workflows and Settings in the main area.

const pageIds: readonly Section['id'][] = ['calendar', 'backlog', 'workflows', 'settings'];
export const pages: readonly Section[] = pageIds.flatMap(
  (id) => sections.find((section) => section.id === id) ?? [],
);

function PagesMenu({ rail }: { readonly rail: boolean }) {
  const navigate = useNavigate();
  return (
    <div className={cn('flex shrink-0 border-t border-sidebar-border px-2 py-1', rail && 'px-1')}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            title={rail ? 'Settings' : undefined}
            className={cn('w-full justify-start', rail && 'justify-center px-0')}
          >
            <SettingsIcon />
            <span className={cn(rail && 'sr-only')}>Settings</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {pages.map((page) => (
            <DropdownMenuItem key={page.id} onSelect={() => void navigate({ to: page.path })}>
              <page.icon aria-hidden />
              {page.title}
              <ShortcutHint shortcut={page.keybinding} className="ml-auto" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.matches('input, textarea, select, [role="combobox"]'));

// Escape on a page opened from the menu goes back to the thread that was open (spec 33). A key a
// dialog, a menu or a field already handled is left alone.
export function useEscapeToThread(): void {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const lastThread = useRef<string | undefined>(undefined);
  const threadId = openThreadOf(pathname);
  useEffect(() => {
    // Threads at work and Usage share the path's shape until they go.
    if (threadId !== undefined && threadId !== 'work' && threadId !== 'usage') {
      lastThread.current = threadId;
    }
  }, [threadId]);
  const onPage = pages.some((page) => pathname.startsWith(page.path));
  useEffect(() => {
    if (!onPage) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || editable(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      const back = lastThread.current;
      void navigate(
        back === undefined
          ? { to: '/chat' }
          : { to: '/chat/$threadId', params: { threadId: back } },
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPage, navigate]);
}

export function Sidebar() {
  return <ThreadList footer={(rail) => <PagesMenu rail={rail} />} />;
}
