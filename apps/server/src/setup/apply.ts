import type { AssistantChangeRecord, DomainEvent, ServerCommand } from '@wow/contracts';
import { changeOf, snapshot, targetOf, undoRefusal } from '../assistant/changes.js';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import { planSetup, problemsText } from './plan.js';

type SetupCommand = Extract<ServerCommand, { type: `setup.${string}` }>;

// Applying a setup file as one step that one Undo takes back (app assistant spec 22). Each
// command is decided as the user's on what the one before left, with the same change record the
// assistant's ordinary changes get: the values it left and the commands that take it back.
// Undo is refused while anything the file set has changed again, and then takes back every
// part, newest first. A step that refuses rolls back the whole transaction.
export function* decideSetup(
  command: SetupCommand,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const asUser: DecideContext = { ...context, origin: 'user' };
  switch (command.type) {
    case 'setup.apply': {
      const id = command.applicationId;
      if (read.setupApplication(id)) {
        throw new CommandRejected('conflict', `Setup ${id} was already applied`);
      }
      const plan = planSetup(command.text, read, asUser);
      if (plan.outcome === 'refused') {
        throw new CommandRejected('rejected', problemsText(plan.problems), plan.problems);
      }
      const parts: AssistantChangeRecord[] = [];
      for (const [index, part] of plan.commands.entries()) {
        const target = targetOf(part);
        if (!target) throw new Error(`${part.type} names nothing it changes`);
        const before = snapshot(target, read);
        const events = decide(part, read, asUser);
        if (events.length === 0) continue;
        yield events;
        const after = snapshot(target, read);
        const change = changeOf(`${id}:${index}`, part, target, before, after, read, asUser);
        if (change) parts.push(change);
      }
      if (parts.length === 0) return;
      yield [
        {
          kind: 'setup.applied',
          aggregate: id,
          payload: {
            id,
            at: context.now,
            name: command.name,
            ...plan.preview,
            parts,
            state: 'applied',
            undoneAt: null,
          },
        },
      ];
      return;
    }
    case 'setup.undo': {
      const application = read.setupApplication(command.applicationId);
      if (!application) {
        throw new CommandRejected('not_found', `No setup ${command.applicationId}`);
      }
      if (application.state === 'undone') {
        throw new CommandRejected(
          'conflict',
          `The setup from ${application.name} was already undone`,
        );
      }
      for (const part of application.parts) {
        const refusal = undoRefusal(part, read, asUser);
        if (refusal !== undefined) {
          throw new CommandRejected(
            'conflict',
            `The setup from ${application.name} cannot be undone. ${refusal}`,
          );
        }
      }
      for (const part of application.parts.toReversed()) {
        for (const inverse of part.inverse) {
          try {
            yield decide(inverse, read, asUser);
          } catch (error) {
            if (!(error instanceof CommandRejected)) throw error;
            throw new CommandRejected(
              error.code,
              `The setup from ${application.name} cannot be undone: ${part.what}: ${error.message}`,
              error.data,
            );
          }
        }
      }
      yield [
        {
          kind: 'setup.undone',
          aggregate: application.id,
          payload: { applicationId: application.id, at: context.now },
        },
      ];
    }
  }
}
