import type { Project, WorkflowRun } from '@wow/contracts';
import type { AppCommand, CommandGroup } from '@/app/commands';
import type { ViewerFile } from '@/app/runtime';
import { artifactPath } from '@/workflows/model';
import { hasSelection, type PanelSelection } from './model';
import { showInContextPanel } from './panel-state';
import { closeViewer, copyFilePath, openFile, shownFile, toggleFullSize } from './viewer';

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
  readonly viewer: ViewerFile | undefined;
  readonly pathname: string;
  // The run open in the run view, or the run waiting at a gate after the open thread's step.
  readonly openRun: WorkflowRun | undefined;
  readonly projects: readonly Project[];
}

// The file viewer from the keyboard (review loop spec 6): every artifact the open run's steps
// left is one "Open artifact" command, and an open file can be put away, copied as a path (the
// one the server resolved, like the header's button), and, once it is read as a picture, shown
// at full size.
export function viewerCommands({
  viewer,
  pathname,
  openRun,
  projects,
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
            fullPath: artifactPath(project.cwd, path),
            from: pathname,
          }),
      });
    }
  }
  const file = shownFile(viewer, pathname);
  if (file) {
    commands.push(
      {
        id: 'viewer.back',
        title: 'Back to conversation',
        group: 'Workflows',
        keywords: ['close file', 'viewer', 'side panel'],
        detail: file.path,
        run: ({ layout }) => closeViewer(layout),
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
        run: ({ layout }) => toggleFullSize(layout),
      });
    }
  }
  return commands;
}
