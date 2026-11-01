import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { SettingsPage } from '@/settings/settings-page';
import {
  BacklogView,
  CalendarView,
  ChatView,
  NotFoundView,
  WorkflowsView,
} from '@/views/empty-views';
import { isSettingGroup, settingsByGroup } from './sections';
import { Shell } from './shell';

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFoundView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/calendar' });
  },
});

const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  component: CalendarView,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatView,
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
  component: WorkflowsView,
});

const backlogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/backlog',
  component: BacklogView,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    const [first] = settingsByGroup().keys();
    throw redirect({ to: '/settings/$group', params: { group: first ?? 'appearance' } });
  },
});

export const settingsGroupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$group',
  beforeLoad: ({ params }) => {
    if (!isSettingGroup(params.group) || !settingsByGroup().has(params.group)) throw notFound();
  },
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  calendarRoute,
  chatRoute,
  workflowsRoute,
  backlogRoute,
  settingsIndexRoute,
  settingsGroupRoute,
]);

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
