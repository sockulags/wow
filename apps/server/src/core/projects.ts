import type { DomainEvent, Project, ProjectChanges, ServerCommand } from '@wow/contracts';
import { decideCalendar } from './calendar.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Decisions for projects. Whether the folder exists is checked by the RPC handler before the
// command gets here, because the orchestrator does no I/O.

type ProjectCommand = Extract<ServerCommand, { type: `project.${string}` }>;

export const isProjectCommand = (command: ServerCommand): command is ProjectCommand =>
  command.type.startsWith('project.');

function requireProject(read: ReadModel, projectId: string): Project {
  const project = read.project(projectId);
  if (!project) throw new CommandRejected('not_found', `No project ${projectId}`);
  return project;
}

// Pickers show projects by name, so two with the same name could not be told apart.
function checkNameFree(read: ReadModel, name: string, projectId: string): void {
  const taken = read
    .projects()
    .find(
      (project) => project.id !== projectId && project.name.toLowerCase() === name.toLowerCase(),
    );
  if (taken) throw new CommandRejected('conflict', `A project named ${taken.name} already exists`);
}

export function decideProject(
  command: ProjectCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'project.create': {
      if (read.project(command.projectId)) {
        throw new CommandRejected('conflict', `Project ${command.projectId} already exists`);
      }
      checkNameFree(read, command.name, command.projectId);
      return [
        {
          kind: 'project.created',
          aggregate: command.projectId,
          payload: {
            id: command.projectId,
            name: command.name,
            cwd: command.cwd,
            defaultProviderInstanceId: command.defaultProviderInstanceId ?? null,
            defaultModel: command.defaultModel ?? null,
            createdAt: context.now,
          },
        },
      ];
    }
    case 'project.update': {
      const project = requireProject(read, command.projectId);
      const changes: ProjectChanges = {};
      if (command.name !== undefined && command.name !== project.name) {
        checkNameFree(read, command.name, project.id);
        changes.name = command.name;
      }
      if (command.cwd !== undefined && command.cwd !== project.cwd) changes.cwd = command.cwd;
      if (
        command.defaultProviderInstanceId !== undefined &&
        command.defaultProviderInstanceId !== project.defaultProviderInstanceId
      ) {
        changes.defaultProviderInstanceId = command.defaultProviderInstanceId;
      }
      if (command.defaultModel !== undefined && command.defaultModel !== project.defaultModel) {
        changes.defaultModel = command.defaultModel;
      }
      if (Object.keys(changes).length === 0) return [];
      return [
        {
          kind: 'project.updated',
          aggregate: command.projectId,
          payload: { projectId: command.projectId, changes },
        },
      ];
    }
    // A live run would start its next step in a folder that no longer has a project, so removal
    // waits for it. Cards lose the project through the calendar's own update, which cancels their
    // pending triggers; threads keep their folder and lose only the link (see the projector).
    // Finished runs keep the id as history.
    case 'project.delete': {
      const project = requireProject(read, command.projectId);
      if (read.projectHasLiveRun(project.id)) {
        throw new CommandRejected(
          'conflict',
          `${project.name} has a workflow run in progress; stop it or let it finish first`,
        );
      }
      const cards = read
        .projectCards(project.id)
        .flatMap((card) =>
          decideCalendar({ type: 'card.update', cardId: card.id, projectId: null }, read, context),
        );
      return [
        ...cards,
        {
          kind: 'project.deleted',
          aggregate: project.id,
          payload: { projectId: project.id },
        },
      ];
    }
  }
}
