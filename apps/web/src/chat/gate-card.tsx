import {
  ApprovalItemPayload,
  GateCardItemPayload,
  type Approval,
  type Question,
  type ThreadItem,
} from '@wow/contracts';
import { ShieldQuestionIcon } from 'lucide-react';
import { ApprovalCard, decisionLabels } from './approval-card';
import { useTopic } from './data';
import { gateCardWho } from './helpers';
import { ChatQuestions, type ItemContext } from './items';

// An approval or a question for the user from a helper anywhere in the main thread's tree
// (orchestrator threads spec 14 to 18). The request stays in the helper's thread: the card reads
// it from that thread's topics and answers it with the same commands, so answering here is
// answering there. While it waits, the card is drawn at the end of the conversation (`dock`) and
// its place in the conversation says so; once answered, here or in the helper's own thread, the
// place says "Answered in <helper>" and the end has nothing.

const none: readonly never[] = [];

interface GateState {
  readonly item: ThreadItem | undefined;
  readonly approval: Approval | undefined;
  readonly questions: readonly Question[];
  readonly answered: string | undefined;
  readonly helperWaits: boolean;
}

// What the helper's thread says of the request now.
function useGateState(payload: GateCardItemPayload): GateState {
  const approvals = useTopic('approvals', payload.fromThreadId) ?? none;
  const questions = useTopic('questions', payload.fromThreadId) ?? none;
  const items = useTopic('threadItems', payload.fromThreadId) ?? none;
  const helper = useTopic('threads')?.find((thread) => thread.id === payload.fromThreadId);
  const item = items.find((each) => each.id === payload.itemId);
  if (payload.kind === 'approval') {
    const approval = approvals.find((row) => row.id === payload.requestId);
    return {
      item,
      approval,
      questions,
      answered: approval?.decision ? decisionLabels[approval.decision] : undefined,
      helperWaits: helper?.state === 'needs_you',
    };
  }
  const question = questions.find((row) => row.id === payload.requestId);
  return {
    item,
    approval: undefined,
    questions,
    answered: question?.answer ?? undefined,
    helperWaits: helper?.state === 'needs_you' || helper?.state === 'working',
  };
}

// Its place in the conversation: one line.
export function GateCardLine({ payload }: { readonly payload: GateCardItemPayload }) {
  const state = useGateState(payload);
  return (
    <p
      data-testid="gate-card-line"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0" />
      {state.answered === undefined
        ? `${gateCardWho(payload)} asks you; the card waits at the end.`
        : `Answered in ${payload.title || 'the helper'}: ${state.answered}`}
    </p>
  );
}

// The card itself, at the end of the conversation while it waits.
export function GateCard({
  payload,
  context,
}: {
  readonly payload: GateCardItemPayload;
  readonly context: ItemContext;
}) {
  const state = useGateState(payload);
  if (state.answered !== undefined || !state.item) return null;
  const parsedApproval =
    payload.kind === 'approval' ? ApprovalItemPayload.safeParse(state.item.payload) : undefined;
  return (
    <li
      data-testid="gate-card"
      aria-label={`${gateCardWho(payload)} asks you`}
      className="flex flex-col gap-1.5"
    >
      <p className="flex items-center gap-2 text-xs font-medium">
        <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        {gateCardWho(payload)}
      </p>
      {parsedApproval?.success ? (
        <ApprovalCard
          payload={parsedApproval.data}
          approval={state.approval}
          // The keys answer the main thread's own approvals; this card is answered by its buttons.
          context={{ ...context, keyedApproval: { id: payload.requestId, side: true } }}
        />
      ) : (
        <ChatQuestions
          items={[state.item]}
          questions={state.questions}
          turnEnded={!state.helperWaits}
        />
      )}
    </li>
  );
}

// The cards that wait, at the end of the main thread's conversation (spec 14).
export function GateDock({
  items,
  contextOf,
}: {
  readonly items: readonly ThreadItem[];
  readonly contextOf: (item: ThreadItem) => ItemContext;
}) {
  return items.flatMap((item) => {
    if (item.kind !== 'gate_card') return [];
    const parsed = GateCardItemPayload.safeParse(item.payload);
    return parsed.success
      ? [<GateCard key={item.id} payload={parsed.data} context={contextOf(item)} />]
      : [];
  });
}
