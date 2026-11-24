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
import { ProjectsSettingsPage, SettingsPage } from '@/settings/settings-page';
import {
  BacklogHome,
  BacklogLayout,
  ItemView,
  NewItemView,
  validateBacklogItemSearch,
} from '@/backlog/backlog-view';
import { NotFoundView } from '@/views/empty-views';
import { isSettingGroup, settingsByGroup } from './sections';
import { Shell } from './shell';

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFoundView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // The app opens on chat (orchestrator threads spec 30).
  beforeLoad: () => {
    throw redirect({ to: '/chat' });
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

// Workflows are files, listed and written in Settings › Workflows (orchestrator threads spec 22,
// 33); the menu's Workflows opens that page.
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows',
  beforeLoad: () => {
    throw redirect({ to: '/settings/$group', params: { group: 'workflows' } });
  },
});

const backlogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/backlog',
  component: BacklogLayout,
});

const backlogIndexRoute = createRoute({
  getParentRoute: () => backlogRoute,
  path: '/',
  component: BacklogHome,
});

const newBacklogItemRoute = createRoute({
  getParentRoute: () => backlogRoute,
  path: '/new',
  component: NewItemView,
});

const backlogItemRoute = createRoute({
  getParentRoute: () => backlogRoute,
  path: '/$itemId',
  // `?dialog=plan|jira|github` opens that dialog, so palette commands can.
  validateSearch: validateBacklogItemSearch,
  component: function BacklogItemRoute() {
    const { itemId } = backlogItemRoute.useParams();
    const { dialog } = backlogItemRoute.useSearch();
    return <ItemView key={itemId} itemId={itemId} dialog={dialog} />;
  },
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    const [first] = settingsByGroup().keys();
    throw redirect({ to: '/settings/$group', params: { group: first ?? 'appearance' } });
  },
});

// Projects are server rows, not registry settings, so their page has its own path.
const settingsProjectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/projects',
  component: ProjectsSettingsPage,
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
  backlogRoute.addChildren([backlogIndexRoute, newBacklogItemRoute, backlogItemRoute]),
  settingsIndexRoute,
  settingsProjectsRoute,
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
