import {
  ToolCallItemPayload,
  askedQuestionsOf,
  assistantToolOf,
  assistantToolText,
  type AssistantChange,
  type AssistantProposal,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSetting } from '@/app/runtime';
import { useDispatch, useTopic } from '@/chat/data';
import { ProjectWorkCard, SecretFieldCard, SecretVariableCard } from './cards';
import { askOf, placeRows, type Placed } from './model';
import { AssistantQuestions, askState } from './questions';
import { ChangeRow, ProposalCard } from './rows';

// What wow's app tools show the user, right after the call that showed it: a change row with
// Undo, a proposal with Yes and No (app assistant spec 7 to 11), a question card or a secret
// field. Every main thread draws them for its own agent's calls (orchestrator threads spec 24).

const noChanges: AssistantChange[] = [];
const noProposals: AssistantProposal[] = [];

export function PlacedRows({
  placed,
  patterns,
}: {
  readonly placed: Placed;
  readonly patterns: readonly string[];
}) {
  const send = useDispatch();
  if (placed.changes.length === 0 && placed.proposals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {placed.changes.map((change) => (
        <ChangeRow
          key={change.id}
          change={change}
          onUndo={() => send({ type: 'assistant.undo', changeId: change.id })}
        />
      ))}
      {placed.proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          secretPatterns={patterns}
          onYes={() => send({ type: 'assistant.proposal.accept', proposalId: proposal.id })}
          onNo={(reason) =>
            send({
              type: 'assistant.proposal.decline',
              proposalId: proposal.id,
              ...(reason === undefined ? {} : { reason }),
            })
          }
        />
      ))}
    </div>
  );
}

export interface AppToolRows {
  // What follows a tool call: its rows and cards, or nothing.
  after(item: ThreadItem): ReactNode;
  // How a call of wow's tools reads: no row of its own where what follows it says it (spec 82
  // of the agent workbench), else in words; undefined for any other tool.
  toolWords(item: ThreadItem): string | null | undefined;
}

// The rows and cards of a main thread's own app tool calls. Records whose call is not in this
// thread's items belong to another thread and are not drawn here.
export function useAppToolRows(
  items: readonly ThreadItem[] | undefined,
  turns: readonly Turn[] | undefined,
  on: boolean,
): AppToolRows | undefined {
  const changes = useTopic('assistantChanges') ?? noChanges;
  const proposals = useTopic('assistantProposals') ?? noProposals;
  const patterns = useSetting('assistant.secretPatterns');
  const { after } = useMemo(
    () => placeRows(on ? (items ?? []) : [], changes, proposals),
    [on, items, changes, proposals],
  );
  const toolWords = useCallback(
    (item: ThreadItem): string | null | undefined => {
      const payload = ToolCallItemPayload.safeParse(item.payload);
      if (!payload.success) return undefined;
      const tool = assistantToolOf(payload.data.name);
      if (tool === null) return undefined;
      if (after.has(item.id) || askOf(item) !== null || askedQuestionsOf(item) !== null) {
        return null;
      }
      return assistantToolText(tool);
    },
    [after],
  );
  const drawAfter = useCallback(
    (item: ThreadItem): ReactNode => {
      const ask = askOf(item);
      const questions = askedQuestionsOf(item);
      const placed = after.get(item.id);
      if (!ask && !placed && !questions) return null;
      return (
        <div className="flex flex-col gap-2">
          {questions && (
            <AssistantQuestions
              item={item}
              request={questions}
              state={askState(item, items ?? [], turns ?? [])}
            />
          )}
          {ask?.kind === 'secretField' && (
            <SecretFieldCard request={ask.request} guide={ask.guide} />
          )}
          {ask?.kind === 'secretVariable' && <SecretVariableCard request={ask.request} />}
          {ask?.kind === 'projectWork' && <ProjectWorkCard offer={ask.offer} />}
          {placed && <PlacedRows placed={placed} patterns={patterns} />}
        </div>
      );
    },
    [after, items, turns, patterns],
  );
  return on ? { after: drawAfter, toolWords } : undefined;
}
