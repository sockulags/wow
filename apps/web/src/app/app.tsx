import { RouterProvider } from '@tanstack/react-router';
import type { AppRouter } from './router';
import { RuntimeProvider, type Runtime } from './runtime';

export function App({ runtime, router }: { runtime: Runtime; router: AppRouter }) {
  return (
    <RuntimeProvider runtime={runtime}>
      <RouterProvider router={router} />
    </RuntimeProvider>
  );
}
