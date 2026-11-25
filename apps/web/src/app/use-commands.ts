import { settingValue } from '@wow/client-runtime';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { backlogCommands } from '@/backlog/commands';
import { calendarCommands } from '@/calendar/commands';
import { validateCalendarSearch } from '@/calendar/search';
import { approvalCommands, approvalCardStore } from '@/chat/approval-card';
import { chatCommands } from '@/chat/commands';
import { changesShown, threadChangesCommands, threadChangesStore } from '@/chat/thread-changes';
import { sessionToolsCommands, toolsShown } from '@/panel/tools-tab';
import { outlineCommands, outlineShown } from '@/chat/outline';
import { draftCopyStore, workingCopyCommands } from '@/chat/working-copy';
import { questionCommands } from '@/chat/question-commands';
import { activeQuestionCard, questionStore } from '@/chat/question-store';
import {
  activeSkillComposer,
  skillComposerStore,
  threadSkillComposer,
} from '@/chat/composer-store';
import { skillComposerCommands } from '@/chat/skill-commands';
import { rowActionCommands } from '@/chat/row-commands';
import { activeTaskPin, taskPinCommands, taskPinStore } from '@/chat/task-pin';
import { backgroundCommands, backgroundStore } from '@/chat/background';
import { focusedRowActions, rowActionStore } from '@/lib/row-actions';
import { paletteThreadHits, threadListStore } from '@/chat/thread-commands';
import {
  activeImageComposer,
  imageComposerCommands,
  imageComposerStore,
} from '@/chat/image-commands';
import { activeModelBar, modelBarCommands, modelBarStore } from '@/chat/model-commands';
import { useTopic } from '@/chat/data';
import { conversationCommands, conversationStore } from '@/chat/conversation-nav';
import { needsYouCommands, needsYouTargets } from '@/chat/needs-you';
import { runningTurn } from '@/chat/model';
import { projectCommands } from '@/projects/commands';
import { sessionCommands } from '@/chat/terminal-sessions';
import { connectCommands, providerCommands } from '@/providers/commands';
import { connectStore } from '@/providers/connect-step';
import { setupCommands } from '@/settings/setup';
import { skillCommands } from '@/settings/skills';
import { workflowFileCommands } from '@/settings/workflow-files-section';
import { formatWhen } from '@/lib/format';
import {
  hostItemCommands,
  openFileCommands,
  panelCommands,
  viewerCommands,
} from '@/panel/commands';
import { panelRoute, panelSelection } from '@/panel/model';
import { useCalendarPrefs } from '@/calendar/prefs';
import { buildCommands, type AppCommand, type CommandContext } from './commands';
import { updateCommands } from './updates';
import { eventToBinding, normalizeBinding, worksInTextFields } from './keybindings';
import { useLayout, useRuntime, useSetting, useUpdateState } from './runtime';

// While the first-start gate is up only the step is on screen, so the palette offers only what
// acts on it and on the window.
const gateCommand = (id: string) =>
  id.startsWith('connect.') ||
  ['setup.start', 'palette.open', 'appearance.toggleTheme'].includes(id);

export function useCommands(gated = false): {
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
  const approvalOffer = useStore(approvalCardStore, (state) => state.offer);
  const changesOpen = useLayout((state) =>
    changesShown(state, panelRoute(pathname, locationSearch), openThreadId),
  );
  const changesTurnOnly = useStore(threadChangesStore, (state) => state.turnOnly);
  const toolsOpen = useLayout((state) =>
    toolsShown(state, panelRoute(pathname, locationSearch), openThreadId),
  );
  const toolsLive = useTopic('threadTools', openThreadId)?.[0]?.live === true;
  const outlineOpen = useLayout((state) =>
    outlineShown(state, panelRoute(pathname, locationSearch), openThreadId),
  );
  const draftCopy = useStore(draftCopyStore);
  // The calendar's zone with "outlook" resolved (F-8), for the cards' "when".
  const { zone: calendarZone } = useCalendarPrefs();
  const calendarItems = useTopic('calendarItems');
  const triggers = useTopic('triggers');
  const schedulerPaused = useSetting('scheduler.paused');
  const outlookProfile = useTopic('outlookStatus')?.[0]?.profile;
  const showWeekends = useSetting('calendar.showWeekends');
  const backlogItems = useTopic('backlogItems');
  const setupApplications = useTopic('setupApplications');
  const skills = useTopic('skills');
  const openBacklogItemId = /^\/backlog\/(?!new$)([^/]+)$/.exec(pathname)?.[1];
  const calendarSearch = useMemo(
    () => (pathname === '/calendar' ? validateCalendarSearch(locationSearch) : undefined),
    [pathname, locationSearch],
  );
  const panelTabs = useLayout((state) => state.panelTabs);
  const tabsRoute = panelRoute(pathname, locationSearch);
  const staticCommands = useMemo(() => buildCommands(), []);
  const listProjectId = useStore(threadListStore, (state) => state.projectId);
  const paletteHits = useStore(paletteThreadHits);
  const connectShown = useStore(connectStore, (state) => state.shown > 0);
  const questionCard = useStore(questionStore, activeQuestionCard);
  const skillComposer = useStore(skillComposerStore, activeSkillComposer);
  const openComposer = useStore(skillComposerStore, (state) =>
    threadSkillComposer(state, openThreadId),
  );
  const taskPin = useStore(taskPinStore, activeTaskPin);
  const background = useStore(backgroundStore);
  const rowAreas = useStore(rowActionStore, (state) => state.areas);
  const taskPinOpen = useStore(taskPinStore, (state) =>
    taskPin === undefined ? false : (state.open[taskPin] ?? false),
  );
  const imageComposer = useStore(imageComposerStore, activeImageComposer);
  const modelBar = useStore(modelBarStore, activeModelBar);
  const conversation = useStore(conversationStore);
  const reasoningByDefault = useSetting('chat.reasoningOpen');
  const all = useMemo(() => {
    const zone = calendarZone;
    const when = (iso: string) => formatWhen(iso, zone);
    const cards = (calendarItems ?? []).filter((item) => item.source === 'local');
    const cardStart = new Map(cards.map((card) => [card.id, card.start]));
    const openThread = threads?.find((thread) => thread.id === openThreadId);
    // Whose files "Open file…" lists: the open thread's.
    const fileTarget = openThread
      ? { scope: { threadId: openThread.id }, folder: openThread.cwd, from: tabsRoute }
      : undefined;
    return [
      // Cards say when they are ("Card · Tomorrow 10:00").
      ...calendarCommands({
        search: calendarSearch,
        cards,
        triggers: triggers ?? [],
        schedulerPaused,
        profile: outlookProfile,
        showWeekends,
      }).map((command) => {
        const start = command.id.startsWith('card.')
          ? cardStart.get(command.id.slice(5))
          : undefined;
        return start ? { ...command, detail: `Card · ${when(start)}` } : command;
      }),
      ...approvalCommands(approvalOffer),
      ...threadChangesCommands(
        openThread?.id,
        tabsRoute,
        changesOpen,
        changesTurnOnly,
        openThread?.workingCopy?.startSha != null,
      ),
      ...sessionToolsCommands(
        openThread && openThread.kind !== 'assistant' ? openThread.id : undefined,
        tabsRoute,
        toolsOpen,
        toolsLive,
      ),
      ...outlineCommands(
        openThread && openThread.kind !== 'assistant' ? openThread.id : undefined,
        tabsRoute,
        outlineOpen,
      ),
      ...workingCopyCommands({
        openThread,
        onNewThread: pathname === '/chat/new',
        draft: draftCopy,
      }),
      ...chatCommands({
        threads: threads ?? [],
        instances: instances ?? [],
        openThread,
        running: runningTurn(turns ?? []) !== undefined,
        inChat: pathname.startsWith('/chat'),
        projects: projects ?? [],
        threadList: { projectId: listProjectId, found: paletteHits },
        openComposer,
      }),
      ...backlogCommands({
        items: backlogItems ?? [],
        openItem: backlogItems?.find((item) => item.id === openBacklogItemId),
      }),
      ...questionCommands(questionCard),
      ...skillComposerCommands(skillComposer),
      ...taskPinCommands(taskPin, taskPinOpen),
      // Before the layout's commands: on Windows and Linux Ctrl+B is also Toggle sidebar, and
      // while something can go to the background the key sends it there, as in Claude Code.
      ...backgroundCommands(background),
      ...rowActionCommands(focusedRowActions({ areas: rowAreas })),
      ...imageComposerCommands(imageComposer),
      ...modelBarCommands(modelBar),
      ...conversationCommands(
        {
          ...conversation,
          reasoningOpen:
            conversation.threadId === undefined
              ? reasoningByDefault
              : (conversation.reasoning[conversation.threadId]?.open ?? reasoningByDefault),
        },
        reasoningByDefault,
      ),
      ...needsYouCommands(needsYouTargets(threads ?? []), pathname),
      ...setupCommands(setupApplications ?? []),
      ...skillCommands(skills ?? []),
      ...workflowFileCommands(skills ?? []),
      ...panelCommands(panelSelection(pathname, locationSearch)),
      ...viewerCommands({
        panelTabs,
        pathname: tabsRoute,
        projects: projects ?? [],
      }),
      ...openFileCommands(fileTarget),
      ...hostItemCommands({
        target:
          openThread && openThread.kind !== 'assistant'
            ? { threadId: openThread.id, from: tabsRoute }
            : undefined,
        panelTabs,
        pathname: tabsRoute,
      }),
      ...connectCommands(connectShown),
      ...providerCommands(instances ?? []),
      ...projectCommands(projects ?? []),
      ...sessionCommands(),
      ...updateCommands(updateState),
      ...staticCommands,
    ];
  }, [
    rowAreas,
    background,
    calendarZone,
    outlookProfile,
    showWeekends,
    approvalOffer,
    changesOpen,
    changesTurnOnly,
    draftCopy,
    pathname,
    locationSearch,
    tabsRoute,
    updateState,
    staticCommands,
    threads,
    instances,
    projects,
    turns,
    openThreadId,
    calendarItems,
    calendarSearch,
    triggers,
    schedulerPaused,
    backlogItems,
    openBacklogItemId,
    setupApplications,
    skills,
    panelTabs,
    tabsRoute,
    connectShown,
    questionCard,
    skillComposer,
    openComposer,
    taskPin,
    taskPinOpen,
    listProjectId,
    paletteHits,
    imageComposer,
    modelBar,
    conversation,
    reasoningByDefault,
    toolsOpen,
    toolsLive,
    outlineOpen,
  ]);
  const commands = useMemo(
    () => (gated ? all.filter((command) => gateCommand(command.id)) : all),
    [all, gated],
  );
  const context = useMemo(
    () => ({ navigate, settings, layout, draft, connection, updates }),
    [navigate, settings, layout, draft, connection, updates],
  );
  return { commands, context };
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const caretAtTextEnd = (target: EventTarget | null): boolean =>
  (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
  target.selectionStart === target.value.length &&
  target.selectionEnd === target.value.length;

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
  // Added before the first paint, so a key pressed as soon as the app shows reaches it.
  useLayoutEffect(() => {
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
      // Plain keys stay with text fields; shortcuts with Ctrl, Alt or Cmd, and F-keys, which type
      // nothing, work everywhere.
      if (
        isEditable(event.target) &&
        !worksInTextFields(pressed) &&
        !(command.atTextEnd && caretAtTextEnd(event.target))
      )
        return;
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
