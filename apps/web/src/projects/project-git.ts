import { ProjectGit, type GitRemote, type Project, type ProjectGitStatus } from '@wow/contracts';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';

const Answer = z.object({ projects: z.array(ProjectGit) });

// Each project folder's git status and remotes, read by the server (owner decision F-4, audit
// E-12). Asked again when a project is added, removed or moved to another folder, and when a
// stored GitLab site changes, since that decides each project's code host.
export function useProjectsGit(
  projects: readonly Project[] | undefined,
): ReadonlyMap<string, ProjectGit> | undefined {
  const { connection } = useRuntime();
  const [found, setFound] = useState<ReadonlyMap<string, ProjectGit>>();
  const settingRows = useTopic('settings');
  const sites = useMemo(
    () =>
      JSON.stringify(
        (settingRows ?? [])
          .filter((row) => row.key === 'trackers.gitlab.baseUrl')
          .map((row) => [row.scope, row.value])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ),
    [settingRows],
  );
  const folders = useMemo(
    () => projects?.map((project) => `${project.id}\u0000${project.cwd}`).join('\n'),
    [projects],
  );
  useEffect(() => {
    if (!connection || folders === undefined) return undefined;
    let current = true;
    connection
      .request('projects.git', {})
      .then((result) => Answer.parse(result))
      .then(
        ({ projects: rows }) =>
          current && setFound(new Map(rows.map((row) => [row.projectId, row]))),
        () => current && setFound(new Map()),
      );
    return () => {
      current = false;
    };
  }, [connection, folders, sites]);
  return found;
}

export const primaryOf = (git: ProjectGit | undefined): GitRemote | undefined =>
  git?.remotes.find((remote) => remote.name === git.primary);

// "github.com/acme/widgets" for a GitHub remote, else the URL as git has it.
export const remoteLabel = (remote: GitRemote): string =>
  remote.github ? `${remote.github.host}/${remote.github.owner}/${remote.github.repo}` : remote.url;

// What a project row says when its folder cannot give a repository.
export const gitProblems: Readonly<
  Record<
    Exclude<ProjectGitStatus, 'ok'>,
    { title: string; detail: string; tone: 'warning' | 'muted' }
  >
> = {
  folderMissing: {
    title: 'Folder missing',
    detail: 'Threads and workflow runs cannot work here until the folder is back.',
    tone: 'warning',
  },
  noRepository: {
    title: 'No git repository',
    detail: 'Fill in the GitHub repository under Trackers if issues should go to one.',
    tone: 'muted',
  },
  noRemote: {
    title: 'No git remote',
    detail: 'Fill in the GitHub repository under Trackers if issues should go to one.',
    tone: 'muted',
  },
  gitUnavailable: {
    title: 'Git not found',
    detail: 'Install git or add it to the PATH so wow can read the remote.',
    tone: 'muted',
  },
};
