import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { CalendarView } from '@/calendar/calendar-view';
import { validateCalendarSearch } from '@/calendar/search';
import { ChatHome, ChatLayout } from '@/chat/chat-view';
import { NewThreadView } from '@/chat/new-thread';
import { ThreadView } from '@/chat/thread-view';
import { SettingsPage } from '@/settings/settings-page';
import { BacklogView, NotFoundView, WorkflowsView } from '@/views/empty-views';
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
  validateSearch: validateCalendarSearch,
  component: function CalendarRoute() {
    return <CalendarView search={calendarRoute.useSearch()} />;
  },
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatLayout,
});

const chatIndexRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '/',
  // The desktop tray opens `/chat?new=1`.
  validateSearch: (search: Record<string, unknown>): { new?: string } =>
    search['new'] === undefined ? {} : { new: String(search['new']) },
  beforeLoad: ({ search }) => {
    if (search.new !== undefined) throw redirect({ to: '/chat/new' });
  },
  component: ChatHome,
});

const newThreadRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '/new',
  component: NewThreadView,
});

const threadRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '/$threadId',
  component: function ThreadRoute() {
    const { threadId } = threadRoute.useParams();
    // Keyed so switching threads starts from fresh scroll and composer state.
    return <ThreadView key={threadId} threadId={threadId} />;
  },
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
  chatRoute.addChildren([chatIndexRoute, newThreadRoute, threadRoute]),
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
