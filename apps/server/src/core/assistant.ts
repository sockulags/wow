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
import { decideBriefRequest, decideWriteBrief } from '../assistant/briefs.js';
import { decideDelegation, decideFollow, isDelegationCommand } from '../assistant/delegation.js';
import { coverage } from '../assistant/permissions.js';
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

  if (isDelegationCommand(command)) {
    if (context.origin !== 'assistant') {
      throw new CommandRejected('rejected', 'Only the assistant sends this.');
    }
    yield* decideDelegation(commandId, command, read, context);
    return;
  }
  if (command.type === 'assistant.requestBrief') {
    if (context.origin === 'assistant')
      throw new CommandRejected('rejected', 'Only wow sends this.');
    yield decideBriefRequest(command, read, context);
    return;
  }
  if (command.type === 'assistant.writeBrief') {
    if (context.origin !== 'assistant') {
      throw new CommandRejected('rejected', 'Only the assistant writes a brief.');
    }
    yield decideWriteBrief(command, read, context);
    return;
  }
  if (command.type === 'assistant.follow') {
    if (context.origin === 'assistant')
      throw new CommandRejected('rejected', 'Only wow sends this.');
    yield decideFollow(command, read, context);
    return;
  }

  if (context.origin === 'assistant') {
    const klass = classOf(command, read, context);
    if (klass.class === 'refused') throw new CommandRejected('rejected', klass.reason);
    const sent = Command.safeParse(command);
    if (!sent.success) throw new CommandRejected('rejected', `${command.type} is not a command`);
    // A proposal a standing permission covers is applied at once and reported (chief of staff
    // spec 5); one a permission would cover but may not now says why on its card (spec 8).
    const covers = klass.class === 'proposal' ? coverage(sent.data, read, context) : undefined;
    if (klass.class === 'proposal' && !(covers && 'covered' in covers)) {
      // Decided once and thrown away: the app's own refusal reaches the assistant now, not the
      // user at Yes, and a command that would change nothing is not worth a question.
      if (decide(sent.data, read, asUser).length === 0) return;
      const proposed = proposalOf(commandId, sent.data, read, context);
      yield [
        {
          kind: 'assistant.proposed',
          aggregate: commandId,
          payload:
            covers && 'held' in covers
              ? {
                  ...proposed,
                  lines: [
                    ...proposed.lines,
                    { what: 'Why this asks', from: null, to: covers.held },
                  ],
                }
              : proposed,
        },
      ];
      return;
    }
    const target = targetOf(sent.data);
    if (!target && !covers) {
      throw new Error(`${command.type} is ordinary but names nothing it changes`);
    }
    // What a permission did is worded as its proposal would have been.
    const used =
      covers && 'covered' in covers ? proposalOf(commandId, sent.data, read, context) : undefined;
    const before = target ? snapshot(target, read) : null;
    const events = decide(sent.data, read, asUser);
    if (events.length === 0) return;
    yield events;
    const change = target
      ? changeOf(commandId, sent.data, target, before, snapshot(target, read), read, context)
      : undefined;
    if (change) yield [{ kind: 'assistant.changed', aggregate: commandId, payload: change }];
    if (covers && 'covered' in covers && used) {
      yield [
        {
          kind: 'assistant.permissionUsed',
          aggregate: commandId,
          payload: {
            id: commandId,
            at: context.now,
            permissionId: covers.covered.id,
            kind: covers.covered.kind,
            commandType: sent.data.type,
            what: used.title,
            place: used.place,
          },
        },
      ];
    }
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
      const putBack: DecideContext = { ...asUser, putBackSteps: true };
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
