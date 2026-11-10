import { runFolder } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { backlogCommands } from '@/backlog/commands';
import { calendarCommands } from '@/calendar/commands';
import { validateCalendarSearch } from '@/calendar/search';
import { chatCommands } from '@/chat/commands';
import { useTopic } from '@/chat/data';
import { runningTurn } from '@/chat/model';
import { projectCommands } from '@/projects/commands';
import { providerCommands } from '@/providers/commands';
import { formatWhen } from '@/lib/format';
import { panelCommands, viewerCommands } from '@/panel/commands';
import { panelSelection } from '@/panel/model';
import { planCommands } from '@/plans/commands';
import { openPlan, runRead } from '@/plans/model';
import { runPullRequest } from '@/workflows/pull-request-tab';
import { runTicketRead } from '@/workflows/ticket-tab';
import { useCalendarPrefs } from '@/calendar/prefs';
import { pendingApproval } from '@/chat/view-model';
import { changesStore } from '@/workflows/changes';
import { workflowCommands } from '@/workflows/commands';
import { gateStore } from '@/workflows/gate';
import { gateRunForThread } from '@/workflows/model';
import { triggersPath } from '@/workflows/triggers';
import { buildCommands, type AppCommand, type CommandContext } from './commands';
import { updateCommands } from './updates';
import { eventToBinding, hasCommandModifier, normalizeBinding } from './keybindings';
import { useLayout, useRuntime, useSetting, useUpdateState } from './runtime';

export function useCommands(): {
  readonly commands: readonly AppCommand[];
  readonly context: CommandContext;
} {
  const { settings, layout, draft, connection, updates } = useRuntime();
  const updateState = useUpdateState();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const locationSearch = useRouterState({ select: (state) => state.location.search });
  const openThreadId = /^\/chat\/(?!new$)([^/]+)$/.exec(pathname)?.[1];
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances');
  const projects = useTopic('projects');
  const turns = useTopic('turns', openThreadId);
  const approvals = useTopic('approvals', openThreadId);
  // The calendar's zone with "outlook" resolved (F-8), for the cards' "when".
  const { zone: calendarZone } = useCalendarPrefs();
  const openRunId = /^\/workflows\/runs\/([^/]+)$/.exec(pathname)?.[1];
  const workflows = useTopic('workflows');
  const runs = useTopic('workflowRuns');
  const templates = useSetting('workflows.templates');
  const alwaysStopSkills = useSetting('workflows.alwaysStopSkills');
  const calendarItems = useTopic('calendarItems');
  const triggers = useTopic('triggers');
  const schedulerPaused = useSetting('scheduler.paused');
  const outlookProfile = useTopic('outlookStatus')?.[0]?.profile;
  const showWeekends = useSetting('calendar.showWeekends');
  const mailRailCollapsed = useSetting('outlook.mailRailCollapsed');
  const backlogItems = useTopic('backlogItems');
  const planIntents = useTopic('planIntents');
  const planRuns = useTopic('planRuns');
  const changeRequests = useTopic('changeRequests');
  const hostReads = useTopic('hostReads');
  const ticketReads = useTopic('ticketReads');
  const pageReads = useTopic('pageReads');
  const openBacklogItemId = /^\/backlog\/(?!new$)([^/]+)$/.exec(pathname)?.[1];
  const calendarSearch = useMemo(
    () => (pathname === '/calendar' ? validateCalendarSearch(locationSearch) : undefined),
    [pathname, locationSearch],
  );
  const viewer = useLayout((state) => state.viewer);
  const page = useLayout((state) => state.page);
  const changedFiles = useStore(changesStore, (state) =>
    state.runId === openRunId ? state.files : undefined,
  );
  const sendBackRunId = useStore(gateStore, (state) => state.sendBack?.runId);
  const staticCommands = useMemo(() => buildCommands(), []);
  const commands = useMemo(() => {
    const zone = calendarZone;
    const when = (iso: string) => formatWhen(iso, zone);
    const cards = (calendarItems ?? []).filter((item) => item.source === 'local');
    const cardStart = new Map(cards.map((card) => [card.id, card.start]));
    const openThread = threads?.find((thread) => thread.id === openThreadId);
    // The run view's run, or the run waiting at a gate after the open thread's step (spec 9).
    const openRun =
      runs?.find((run) => run.id === openRunId) ??
      (openThread ? gateRunForThread(openThread, runs ?? []) : undefined);
    const openRunProject = projects?.find((project) => project.id === openRun?.projectId);
    return [
      // Cards say when they are ("Card · Tomorrow 10:00").
      ...calendarCommands({
        search: calendarSearch,
        cards,
        triggers: triggers ?? [],
        schedulerPaused,
        profile: outlookProfile,
        showWeekends,
        mailRailCollapsed,
      }).map((command) => {
        const start = command.id.startsWith('card.')
          ? cardStart.get(command.id.slice(5))
          : undefined;
        return start ? { ...command, detail: `Card · ${when(start)}` } : command;
      }),
      ...chatCommands({
        threads: threads ?? [],
        instances: instances ?? [],
        openThread,
        running: runningTurn(turns ?? []) !== undefined,
        approval: pendingApproval(approvals ?? []),
        inChat: pathname.startsWith('/chat'),
      }),
      ...workflowCommands({
        workflows: workflows ?? [],
        runs: runs ?? [],
        templates,
        alwaysStopSkills,
        openRun,
        runView:
          openRunId !== undefined && openRun?.id === openRunId
            ? {
                runId: openRunId,
                search: locationSearch,
                changedFiles: changedFiles ?? [],
                project: openRunProject,
                folder: openRunProject && runFolder(openRun, openRunProject.cwd),
                pullRequest: runPullRequest(
                  runRead(hostReads ?? [], openRunId),
                  changeRequests ?? [],
                ),
                ticket: runTicketRead(ticketReads ?? [], openRunId)?.ticket ?? undefined,
              }
            : undefined,
        sendBackRunId,
        formatWhen: when,
        triggers,
        projects,
        onTriggers: pathname === triggersPath,
      }),
      ...planCommands({
        intents: planIntents ?? [],
        projects: projects ?? [],
        openIntent: openPlan(pathname, planIntents ?? []),
        changeRequests,
        planRuns,
        workflows,
      }),
      ...backlogCommands({
        items: backlogItems ?? [],
        openItem: backlogItems?.find((item) => item.id === openBacklogItemId),
      }),
      ...panelCommands(panelSelection(pathname, locationSearch)),
      ...viewerCommands({
        viewer,
        pathname,
        openRun,
        projects: projects ?? [],
        page,
        pageReads: pageReads ?? [],
      }),
      ...providerCommands(instances ?? []),
      ...projectCommands(projects ?? []),
      ...updateCommands(updateState),
      ...staticCommands,
    ];
  }, [
    calendarZone,
    outlookProfile,
    showWeekends,
    mailRailCollapsed,
    approvals,
    pathname,
    locationSearch,
    updateState,
    staticCommands,
    threads,
    instances,
    projects,
    turns,
    openThreadId,
    workflows,
    runs,
    templates,
    alwaysStopSkills,
    openRunId,
    calendarItems,
    calendarSearch,
    triggers,
    schedulerPaused,
    backlogItems,
    openBacklogItemId,
    viewer,
    page,
    pageReads,
    planIntents,
    planRuns,
    changeRequests,
    hostReads,
    ticketReads,
    changedFiles,
    sendBackRunId,
  ]);
  const context = useMemo(
    () => ({ navigate, settings, layout, draft, connection, updates }),
    [navigate, settings, layout, draft, connection, updates],
  );
  return { commands, context };
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

// Applies the keybindings settings. Bindings are read at key time, so a change on the settings page
// takes effect on the next key press.
export function useGlobalKeybindings(
  commands: readonly AppCommand[],
  context: CommandContext,
): void {
  // The listener is added once and reads the latest commands at key time. Re-adding it whenever a
  // topic changes the command list would move it behind listeners added later on the window, and
  // they would see a shortcut the app is about to claim as unclaimed.
  const latest = useRef({ commands, context });
  latest.current = { commands, context };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const current = latest.current;
      const pressed = eventToBinding(event);
      if (!pressed) return;
      const { values } = current.context.settings.getState();
      const command = current.commands.find((candidate) => {
        if (!candidate.keybinding) return false;
        const binding = settingValue(values, candidate.keybinding);
        return (
          typeof binding === 'string' && binding !== '' && normalizeBinding(binding) === pressed
        );
      });
      if (!command) return;
      // Plain keys stay with text fields; shortcuts with Ctrl, Alt or Cmd work everywhere.
      if (isEditable(event.target) && !hasCommandModifier(pressed)) return;
      // A held key is still claimed (Ctrl+= must not fall through to the browser's page zoom),
      // but only repeatable commands run again.
      event.preventDefault();
      if (event.repeat && !command.repeatable) return;
      command.run(current.context);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
