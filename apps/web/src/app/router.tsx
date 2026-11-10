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
import { validatePlanSearch } from '@/plans/model';
import { PlansHome, PlansLayout, PlanView } from '@/plans/plans-view';
import { NotFoundView } from '@/views/empty-views';
import { EditWorkflowView, NewWorkflowView } from '@/workflows/builder';
import { RunView } from '@/workflows/run-view';
import { WorkflowsHome, WorkflowsLayout } from '@/workflows/workflows-view';
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
  component: WorkflowsLayout,
});

const workflowsIndexRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: '/',
  component: WorkflowsHome,
});

const newWorkflowRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: '/new',
  // `?template=<kind>` starts the builder from that template of the workflows.templates setting.
  validateSearch: (search: Record<string, unknown>): { template?: string } =>
    typeof search['template'] === 'string' ? { template: search['template'] } : {},
  component: function NewWorkflowRoute() {
    const { template } = newWorkflowRoute.useSearch();
    return <NewWorkflowView key={template ?? ''} template={template} />;
  },
});

const workflowRunRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: '/runs/$runId',
  component: function WorkflowRunRoute() {
    const { runId } = workflowRunRoute.useParams();
    return <RunView key={runId} runId={runId} />;
  },
});

const workflowRoute = createRoute({
  getParentRoute: () => workflowsRoute,
  path: '/$workflowId',
  component: function WorkflowRoute() {
    const { workflowId } = workflowRoute.useParams();
    return <EditWorkflowView key={workflowId} workflowId={workflowId} />;
  },
});

const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plans',
  component: PlansLayout,
});

const plansIndexRoute = createRoute({
  getParentRoute: () => plansRoute,
  path: '/',
  component: PlansHome,
});

const planRoute = createRoute({
  getParentRoute: () => plansRoute,
  path: '/$projectId/$intentId',
  // `?unit=<key>` opens that unit's contract, so palette commands can.
  validateSearch: validatePlanSearch,
  component: function PlanRoute() {
    const { projectId, intentId } = planRoute.useParams();
    const { unit } = planRoute.useSearch();
    return <PlanView projectId={projectId} intentId={intentId} openUnit={unit} />;
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
  workflowsRoute.addChildren([
    workflowsIndexRoute,
    newWorkflowRoute,
    workflowRunRoute,
    workflowRoute,
  ]),
  plansRoute.addChildren([plansIndexRoute, planRoute]),
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
