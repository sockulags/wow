import { runFolder, type PageRead, type Project, type WorkflowRun } from '@wow/contracts';
import { openInBrowser } from '@/chat/host-links';
import { safeHref } from '@/components/markdown';
import type { AppCommand, CommandGroup } from '@/app/commands';
import { DETAILS_TAB, type LayoutState, type OpenFileDialog } from '@/app/runtime';
import { artifactPath } from '@/workflows/model';
import { pageTitle, runPageRead } from '@/workflows/pages-tab';
import { hasSelection, type PanelSelection } from './model';
import { askHostItem } from './host-tab';
import { showInContextPanel } from './panel-state';
import {
  backTab,
  closeTab,
  closeViewer,
  copyFilePath,
  cycleTab,
  openFile,
  openPage,
  panelTabsOf,
  selectedTab,
  shownFile,
  shownPage,
  tabName,
  toggleFullSize,
} from './viewer';

const groups: Readonly<Partial<Record<PanelSelection['view'], CommandGroup>>> = {
  calendar: 'Calendar',
  chat: 'Chat',
  run: 'Workflows',
  workflow: 'Workflows',
  backlog: 'Backlog',
};

const details: Readonly<Partial<Record<PanelSelection['view'], string>>> = {
  calendar: 'The selected card or meeting',
  chat: 'The open thread',
  run: "The run's active step",
  workflow: 'The open workflow',
  backlog: 'The open item',
};

// "Show in panel" for the open view's selection: opens the context panel and moves the focus
// into it. Listed only while the view has something selected.
export function panelCommands(selection: PanelSelection): AppCommand[] {
  const group = groups[selection.view];
  if (!group || !hasSelection(selection)) return [];
  return [
    {
      id: `panel.show.${selection.view}`,
      title: 'Show in panel',
      group,
      detail: details[selection.view] ?? '',
      keywords: ['context panel', 'details', 'right panel'],
      run: showInContextPanel,
    },
  ];
}

export interface ViewerCommandData {
  // The open tabs of every view; the one on screen is `pathname`'s.
  readonly panelTabs: LayoutState['panelTabs'];
  readonly pathname: string;
  // The run open in the run view, or the run waiting at a gate after the open thread's step.
  readonly openRun: WorkflowRun | undefined;
  readonly projects: readonly Project[];
  // What was last read about the pages of each run.
  readonly pageReads?: readonly PageRead[] | undefined;
}

// The file viewer from the keyboard (review loop spec 6): every artifact the open run's steps
// left is one "Open artifact" command, and an open file can be put away, copied as a path (the
// one the server resolved, like the header's button), and, once it is read as a picture, shown
// at full size.
export function viewerCommands({
  panelTabs,
  pathname,
  openRun,
  projects,
  pageReads = [],
}: ViewerCommandData): AppCommand[] {
  const commands: AppCommand[] = [];
  const project = openRun && projects.find((candidate) => candidate.id === openRun.projectId);
  if (openRun && project) {
    const paths = new Set(openRun.steps.flatMap((step) => step.artifactsFound));
    for (const path of paths) {
      commands.push({
        id: `viewer.open.${path}`,
        title: `Open artifact: ${path}`,
        value: `Open artifact ${path}`,
        group: 'Workflows',
        keywords: ['file', 'view', 'side panel'],
        detail: 'In the side panel',
        run: (context) =>
          openFile(context, {
            runId: openRun.id,
            path,
            fullPath: artifactPath(runFolder(openRun, project.cwd), path),
            from: pathname,
          }),
      });
    }
  }
  // Every linked page of the open run that has been read opens in the side panel (spec 35).
  const runId = openRun?.id;
  for (const link of runId ? (runPageRead(pageReads, runId)?.pages ?? []) : []) {
    if (!link.page || !runId) continue;
    const title = pageTitle(link);
    commands.push({
      id: `viewer.page.${link.ref}`,
      title: `Open page: ${title}`,
      value: `Open page ${title} ${link.ref}`,
      group: 'Workflows',
      keywords: ['confluence', 'page', 'wiki', 'side panel'],
      detail: 'In the side panel',
      run: (context) => openPage(context, { runId, ref: link.ref, from: pathname }),
    });
  }
  const shown = shownPage({ panelTabs }, pathname);
  if (shown) {
    const link = runPageRead(pageReads, shown.runId)?.pages.find(
      (entry) => entry.ref === shown.ref,
    );
    commands.push({
      id: 'viewer.back',
      title: 'Back to conversation',
      group: 'Workflows',
      keywords: ['close page', 'viewer', 'side panel'],
      detail: link ? pageTitle(link) : '',
      run: ({ layout }) => closeViewer(layout, pathname),
    });
    const url = safeHref(link?.page?.url ?? link?.link);
    if (link && url !== undefined) {
      commands.push({
        id: 'viewer.page.openOnHost',
        title: `Open page on host: ${pageTitle(link)}`,
        group: 'Workflows',
        keywords: ['confluence', 'browser', 'external'],
        detail: url,
        run: () => void window.open(url, '_blank', 'noreferrer'),
      });
    }
  }
  const file = shownFile({ panelTabs }, pathname);
  if (file) {
    commands.push(
      {
        id: 'viewer.back',
        title: 'Back to conversation',
        group: 'Workflows',
        keywords: ['close file', 'viewer', 'side panel'],
        detail: file.path,
        run: ({ layout }) => closeViewer(layout, pathname),
      },
      {
        id: 'viewer.copyPath',
        title: 'Copy file path',
        group: 'Workflows',
        keywords: ['viewer', 'clipboard'],
        detail: file.path,
        run: () => copyFilePath(file),
      },
    );
    if (file.read?.kind === 'image') {
      commands.push({
        id: 'viewer.toggleFullSize',
        title: file.fullSize ? 'Fit picture to panel' : 'Show picture at full size',
        group: 'Workflows',
        keywords: ['viewer', 'image', 'zoom', 'fit'],
        detail: file.path,
        run: ({ layout }) => toggleFullSize(layout, file),
      });
    }
  }
  return [...commands, ...tabCommands(panelTabs, pathname)];
}

// The panel's tab keys from the palette (agent workbench spec 12). The keys themselves act only
// while the focus is in the panel, so these carry no keybinding of their own.
function tabCommands(panelTabs: LayoutState['panelTabs'], pathname: string): AppCommand[] {
  const tabs = panelTabsOf({ panelTabs }, pathname);
  if (tabs.tabs.length === 0) return [];
  const selected = selectedTab(tabs);
  const keywords = ['panel', 'tab', 'side panel'];
  return [
    ...(selected
      ? [
          {
            id: 'panel.tab.close',
            title: 'Close panel tab',
            group: 'Actions' as const,
            keywords,
            detail: tabName(selected),
            run: ({ layout }: Parameters<AppCommand['run']>[0]) => closeTab(layout, pathname),
          },
        ]
      : []),
    {
      id: 'panel.tab.next',
      title: 'Next panel tab',
      group: 'Actions',
      keywords,
      run: ({ layout }) => cycleTab(layout, pathname, 1),
    },
    {
      id: 'panel.tab.previous',
      title: 'Previous panel tab',
      group: 'Actions',
      keywords,
      run: ({ layout }) => cycleTab(layout, pathname, -1),
    },
    ...(tabs.history.length > 0 || tabs.selected !== DETAILS_TAB
      ? [
          {
            id: 'panel.tab.back',
            title: 'Back to the panel tab shown before',
            group: 'Actions' as const,
            keywords,
            run: ({ layout }: Parameters<AppCommand['run']>[0]) => backTab(layout, pathname),
          },
        ]
      : []),
  ];
}

// "Open file…" (agent workbench spec 18): the open thread's or run's folder, listed by the server.
export function openFileCommands(target: OpenFileDialog | undefined): AppCommand[] {
  if (!target) return [];
  return [
    {
      id: 'panel.openFile',
      title: 'Open file…',
      group: 'Actions',
      keywords: ['file', 'find', 'go to file', 'side panel', 'tab'],
      keybinding: 'keybindings.openFile',
      detail: 'In a panel tab',
      run: ({ layout }) => layout.setState({ openFileDialog: target }),
    },
  ];
}

// "Open issue, PR or ticket…" for the open chat or step thread (agent workbench spec 25), and
// Refresh now and Open on host for the host item tab on screen (spec 21, 22).
export function hostItemCommands({
  target,
  panelTabs,
  pathname,
}: {
  readonly target: { readonly threadId: string; readonly from: string } | undefined;
  readonly panelTabs: LayoutState['panelTabs'];
  readonly pathname: string;
}): AppCommand[] {
  const commands: AppCommand[] = [];
  if (target) {
    commands.push({
      id: 'panel.openHostItem',
      title: 'Open issue, PR or ticket…',
      group: 'Actions',
      keywords: ['pull request', 'merge request', 'jira', 'confluence', 'page', 'link', 'url'],
      detail: 'In a panel tab',
      run: ({ layout }) => layout.setState({ openHostDialog: target }),
    });
  }
  const tab = selectedTab(panelTabsOf({ panelTabs }, pathname));
  if (tab?.kind === 'host') {
    const { threadId, item } = tab.host;
    commands.push(
      {
        id: 'panel.host.refresh',
        title: 'Refresh now',
        group: 'Actions',
        keywords: ['host', 'read again', 'fetch'],
        detail: item.url,
        run: ({ connection }) => void askHostItem(connection, { threadId, item }, 'refresh'),
      },
      {
        id: 'panel.host.openOnHost',
        title: 'Open on host',
        group: 'Actions',
        keywords: ['browser', 'external'],
        detail: item.url,
        run: () => openInBrowser(item),
      },
      {
        id: 'viewer.back',
        title: 'Back to details',
        group: 'Actions',
        keywords: ['close', 'side panel'],
        detail: item.url,
        run: ({ layout }) => closeViewer(layout, pathname),
      },
    );
  }
  return commands;
}
