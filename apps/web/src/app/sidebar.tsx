import { Link } from '@tanstack/react-router';
import { WithTooltip } from '@/components/hint';
import { useTopic } from '@/chat/data';
import { cn } from '@/lib/utils';
import { sections, type Section } from './sections';

// "Needs you" counts per section (audit A-22): threads that wait for an answer, workflow runs
// that wait at a gate and the assistant's proposals that wait for a yes. Read from the server's
// rows; nothing is counted locally.
function useNeedsYou(): Partial<Record<Section['id'], number>> {
  const threads = useTopic('threads');
  const runs = useTopic('workflowRuns');
  const proposals = useTopic('assistantProposals');
  return {
    chat: threads?.filter((thread) => thread.state === 'needs_you').length ?? 0,
    workflows: runs?.filter((run) => run.state === 'waiting').length ?? 0,
    assistant: proposals?.filter((proposal) => proposal.state === 'pending').length ?? 0,
  };
}

// The app sidebar. Below 1280px it narrows to an icon rail (audit A-12); the label moves into the
// tooltip, which always carries the section's key.
export function Sidebar() {
  const counts = useNeedsYou();
  return (
    <nav
      aria-label="Sections"
      className="flex w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-xl:w-12"
    >
      <div className="flex h-11 shrink-0 items-center px-4 text-sm font-semibold max-xl:justify-center max-xl:px-0">
        wow
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {sections.map((section) => {
          const count = counts[section.id] ?? 0;
          return (
            <li key={section.id}>
              <WithTooltip
                label={count > 0 ? `${section.title} · ${count} need you` : section.title}
                shortcut={section.keybinding}
                side="right"
              >
                <Link
                  to={section.path}
                  className="relative flex h-8 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring max-xl:justify-center max-xl:px-0"
                  activeProps={{
                    className: 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                    'aria-current': 'page',
                  }}
                >
                  <section.icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate max-xl:sr-only">{section.title}</span>
                  {count > 0 && (
                    <span
                      data-testid={`needs-you-${section.id}`}
                      aria-label={`${count} need you`}
                      className={cn(
                        'ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-state-needs-you px-1 text-2xs font-medium text-warning-foreground tabular-nums',
                        'max-xl:absolute max-xl:top-0 max-xl:right-0 max-xl:ml-0',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </Link>
              </WithTooltip>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
