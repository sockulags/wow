import { Link } from '@tanstack/react-router';

// The shared EmptyState lives in components/states; re-exported for older imports.
export { EmptyState } from '@/components/states';

export const NotFoundView = () => (
  <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
    <h2 className="text-sm font-medium">Page not found</h2>
    <Link to="/calendar" className="text-xs text-muted-foreground underline">
      Go to the calendar
    </Link>
  </section>
);
