import type { LucideIcon } from 'lucide-react';
import { CalendarDaysIcon, ListTodoIcon, MessagesSquareIcon, WorkflowIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

// Placeholders until the feature units (U8 chat, U9 calendar, U10 workflows, U12 backlog) replace
// them. Each says what will appear so the shell is usable from day one.

function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="empty-title"
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <h2 id="empty-title" className="text-sm font-medium">
        {title}
      </h2>
      <p className="max-w-sm text-xs text-muted-foreground">{children}</p>
    </section>
  );
}

export const CalendarView = () => (
  <EmptyState icon={CalendarDaysIcon} title="No calendar items yet">
    Outlook meetings, unread mail and your own cards will appear here.
  </EmptyState>
);

export const ChatView = () => (
  <EmptyState icon={MessagesSquareIcon} title="No threads yet">
    Agent threads from Claude and Codex will appear here.
  </EmptyState>
);

export const WorkflowsView = () => (
  <EmptyState icon={WorkflowIcon} title="No workflows yet">
    Chains of skills with gates between steps will appear here.
  </EmptyState>
);

export const BacklogView = () => (
  <EmptyState icon={ListTodoIcon} title="Backlog is empty">
    Ideas that are not tickets yet will appear here.
  </EmptyState>
);

export const NotFoundView = () => (
  <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
    <h2 className="text-sm font-medium">Page not found</h2>
    <Link to="/calendar" className="text-xs text-muted-foreground underline">
      Go to the calendar
    </Link>
  </section>
);
