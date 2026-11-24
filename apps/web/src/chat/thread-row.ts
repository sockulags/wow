import type { Project, Thread } from '@wow/contracts';

// A thread row's second line (orchestrator threads spec 30): the thread's project, or "No project"
// for a thread without one.
export const threadRowPlace = (
  thread: Pick<Thread, 'projectId'>,
  projects: readonly Pick<Project, 'id' | 'name'>[],
): string =>
  (thread.projectId !== null &&
    projects.find((project) => project.id === thread.projectId)?.name) ||
  'No project';
