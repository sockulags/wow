import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { sections } from './sections';
import { useConnectionState } from './runtime';

const statusText = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
} as const;

function ConnectionStatus() {
  const { status, configured } = useConnectionState();
  const text = configured ? statusText[status] : 'No server: settings are kept in memory';
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          status === 'open' ? 'bg-state-done' : 'bg-muted-foreground/50',
          status === 'reconnecting' && 'bg-state-needs-you',
        )}
      />
      <span data-testid="connection-status">{text}</span>
    </div>
  );
}

export function Sidebar() {
  return (
    <nav
      aria-label="Sections"
      className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <div className="px-3 pt-3 pb-2 text-xs font-semibold tracking-wide text-muted-foreground">
        wow
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {sections.map((section) => (
          <li key={section.id}>
            <Link
              to={section.path}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              activeProps={{
                className: 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                'aria-current': 'page',
              }}
            >
              <section.icon className="size-4 shrink-0" aria-hidden />
              {section.title}
            </Link>
          </li>
        ))}
      </ul>
      <ConnectionStatus />
    </nav>
  );
}
