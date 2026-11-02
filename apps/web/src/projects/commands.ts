import type { Project } from '@wow/contracts';
import type { AppCommand, CommandContext } from '@/app/commands';
import type { ProjectDialog } from '@/app/runtime';

const open =
  (dialog: ProjectDialog) =>
  ({ navigate, layout }: CommandContext) => {
    void navigate({ to: '/settings/projects' });
    layout.setState({ projectDialog: dialog });
  };

// Palette commands for Settings → Projects: the page, a new project, and rename or remove for each.
export function projectCommands(projects: readonly Project[]): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'settings.projects',
      title: 'Settings: Projects',
      group: 'Settings',
      keywords: ['settings', 'projects', 'folders'],
      run: ({ navigate }) => void navigate({ to: '/settings/projects' }),
    },
    {
      id: 'projects.create',
      title: 'New project',
      group: 'Settings',
      keywords: ['project', 'folder', 'add'],
      run: open({ type: 'create' }),
    },
  ];
  for (const project of projects) {
    commands.push(
      {
        id: `projects.rename.${project.id}`,
        title: `Rename project ${project.name}`,
        value: `Rename project ${project.name} ${project.id}`,
        group: 'Settings',
        keywords: ['project', project.cwd],
        run: open({ type: 'rename', projectId: project.id }),
      },
      {
        id: `projects.remove.${project.id}`,
        title: `Remove project ${project.name}`,
        value: `Remove project ${project.name} ${project.id}`,
        group: 'Settings',
        keywords: ['project', 'delete', project.cwd],
        run: open({ type: 'remove', projectId: project.id }),
      },
    );
  }
  return commands;
}
