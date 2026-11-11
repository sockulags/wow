import {
  Command,
  findSecret,
  heldSecretSentence,
  hideSecrets,
  type DomainEvent,
  type ServerCommand,
} from '@wow/contracts';
import {
  acceptRefusal,
  changeOf,
  patternsOf,
  proposalOf,
  snapshot,
  targetOf,
  undoRefusal,
} from '../assistant/changes.js';
import { classOf } from '../assistant/classes.js';
import { decideSetup } from '../setup/apply.js';
import {
  CommandRejected,
  decide,
  isAssistantCommand,
  isSetupCommand,
  type DecideContext,
  type ReadModel,
} from './orchestrator.js';

// Decides a command in steps. Each yielded batch of events is stored and projected before the
// next step runs, so a step sees what the one before left behind. A command of the user is one
// step, exactly as before. A command of the assistant is settled here by its class (app
// assistant spec 7 to 11): refused, held as a proposal, or applied with a record of the change.
// The commands that answer the assistant (accept, decline, undo) apply other commands step by
// step. A step that refuses takes back every step before it: the engine's transaction rolls
// back.
export function* decideInSteps(
  commandId: string,
  command: ServerCommand,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  // What a held or inverse command is decided as once the user said so.
  const asUser: DecideContext = { ...context, origin: 'user' };

  if (context.origin === 'assistant') {
    const klass = classOf(command, read, context);
    if (klass.class === 'refused') throw new CommandRejected('rejected', klass.reason);
    const sent = Command.safeParse(command);
    if (!sent.success) throw new CommandRejected('rejected', `${command.type} is not a command`);
    if (klass.class === 'proposal') {
      // Decided once and thrown away: the app's own refusal reaches the assistant now, not the
      // user at Yes, and a command that would change nothing is not worth a question.
      if (decide(sent.data, read, asUser).length === 0) return;
      yield [
        {
          kind: 'assistant.proposed',
          aggregate: commandId,
          payload: proposalOf(commandId, sent.data, read, context),
        },
      ];
      return;
    }
    const target = targetOf(sent.data);
    if (!target) throw new Error(`${command.type} is ordinary but names nothing it changes`);
    const before = snapshot(target, read);
    const events = decide(sent.data, read, asUser);
    if (events.length === 0) return;
    yield events;
    const change = changeOf(
      commandId,
      sent.data,
      target,
      before,
      snapshot(target, read),
      read,
      context,
    );
    if (change) yield [{ kind: 'assistant.changed', aggregate: commandId, payload: change }];
    return;
  }

  // A setup file is applied and undone in steps too, one command at a time.
  if (isSetupCommand(command)) {
    yield* decideSetup(command, read, context);
    return;
  }

  if (!isAssistantCommand(command)) {
    yield decide(command, read, context);
    return;
  }

  switch (command.type) {
    case 'assistant.proposal.accept': {
      const proposal = pendingProposal(read, command.proposalId);
      // The yes is for what the card says. The proposal stays open so the user can say No.
      const stale = acceptRefusal(proposal, read);
      if (stale !== undefined) throw new CommandRejected('conflict', stale);
      yield decide(proposal.command, read, asUser);
      yield [answered(proposal.id, 'accepted', null, context)];
      return;
    }
    case 'assistant.proposal.decline': {
      const proposal = pendingProposal(read, command.proposalId);
      const reason = command.reason?.trim();
      const patterns = patternsOf(read, context);
      // Refused rather than hidden, so the typed text is not kept with the command either.
      const secret = reason ? findSecret(reason, patterns) : null;
      if (secret) throw new CommandRejected('rejected', heldSecretSentence(secret.kind));
      yield [
        answered(proposal.id, 'declined', reason ? hideSecrets(reason, patterns) : null, context),
      ];
      return;
    }
    case 'assistant.undo': {
      const change = read.assistantChange(command.changeId);
      if (!change) throw new CommandRejected('not_found', `No change ${command.changeId}`);
      if (change.state === 'undone') {
        throw new CommandRejected('conflict', `${change.what} was already undone`);
      }
      const refusal = undoRefusal(change, read, context);
      if (refusal !== undefined) throw new CommandRejected('conflict', refusal);
      // An undo puts back what was stored, a step without a model included.
      const putBack: DecideContext = { ...asUser, keepStepsWithoutModel: true };
      for (const inverse of change.inverse) {
        try {
          yield decide(inverse, read, putBack);
        } catch (error) {
          if (!(error instanceof CommandRejected)) throw error;
          throw new CommandRejected(
            error.code,
            `${change.what} cannot be undone: ${error.message}`,
            error.data,
          );
        }
      }
      yield [
        {
          kind: 'assistant.changeUndone',
          aggregate: change.id,
          payload: { changeId: change.id, at: context.now },
        },
      ];
    }
  }
}

function pendingProposal(read: ReadModel, proposalId: string) {
  const proposal = read.assistantProposal(proposalId);
  if (!proposal) throw new CommandRejected('not_found', `No proposal ${proposalId}`);
  if (proposal.state !== 'pending') {
    throw new CommandRejected('conflict', `"${proposal.title}" was already ${proposal.state}`);
  }
  return proposal;
}

const answered = (
  proposalId: string,
  state: 'accepted' | 'declined',
  reason: string | null,
  context: DecideContext,
): DomainEvent => ({
  kind: 'assistant.proposalAnswered',
  aggregate: proposalId,
  payload: { proposalId, state, reason, at: context.now },
});
