import type { AssistantChange, AssistantProposal, Command } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand, CommandContext } from '@/app/commands';
import { errorMessage } from '@/chat/data';
import { notify } from '@/lib/feedback';
import { proposalFocus } from './model';

export interface AssistantCommandData {
  readonly changes: readonly AssistantChange[];
  readonly proposals: readonly AssistantProposal[];
}

// The answer goes to the server like the card's button; a refusal has no card next to the
// palette, so it comes as a toast with the server's reason.
const answer =
  (command: Command, failed: string) =>
  ({ connection }: CommandContext): void => {
    if (!connection) return;
    dispatch(connection, command).catch((error: unknown) =>
      notify.error(failed, { description: errorMessage(error) }),
    );
  };

// Palette commands for the assistant's work (app assistant spec 8 to 10): Yes and No to every
// proposal that waits, listed under "Needs you", and Undo for every change that is applied.
// No from the palette gives no reason; the card takes one.
export function assistantCommands({ changes, proposals }: AssistantCommandData): AppCommand[] {
  const commands: AppCommand[] = [];
  for (const proposal of proposals) {
    if (proposal.state !== 'pending') continue;
    commands.push(
      {
        id: `assistant.yes.${proposal.id}`,
        title: `Yes: ${proposal.title}`,
        group: 'Assistant',
        keywords: ['assistant', 'proposal', 'accept', 'apply'],
        detail: 'Proposal',
        needsYou: true,
        run: answer(
          { type: 'assistant.proposal.accept', proposalId: proposal.id },
          `"${proposal.title}" was not applied`,
        ),
      },
      {
        id: `assistant.no.${proposal.id}`,
        title: `No: ${proposal.title}`,
        group: 'Assistant',
        keywords: ['assistant', 'proposal', 'decline', 'reject'],
        detail: 'Proposal',
        run: answer(
          { type: 'assistant.proposal.decline', proposalId: proposal.id },
          `"${proposal.title}" could not be declined`,
        ),
      },
      {
        id: `assistant.show.${proposal.id}`,
        title: `Show proposal: ${proposal.title}`,
        group: 'Assistant',
        keywords: ['assistant', 'proposal', 'show', 'waiting'],
        detail: 'Proposal',
        searchOnly: true,
        run: ({ navigate }) => {
          proposalFocus.setState({ id: proposal.id });
          void navigate({ to: '/assistant' });
        },
      },
    );
  }
  const applied = changes.filter((change) => change.state === 'applied');
  applied.forEach((change, index) => {
    commands.push({
      id: `assistant.undo.${change.id}`,
      title: `Undo: ${change.what}`,
      group: 'Assistant',
      keywords: ['assistant', 'change', 'revert', change.place.label],
      detail: `Change · ${change.place.label}`,
      // The newest is offered before typing; older ones when searched for.
      searchOnly: index !== applied.length - 1,
      run: answer(
        { type: 'assistant.undo', changeId: change.id },
        `"${change.what}" was not undone`,
      ),
    });
  });
  return commands;
}
