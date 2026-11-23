import {
  ApprovalItemPayload,
  GateCardItemPayload,
  type Approval,
  type Question,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { ShieldQuestionIcon } from 'lucide-react';
import { ApprovalCard, decisionLabels } from './approval-card';
import { useTopic } from './data';
import { gateCardWho } from './helpers';
import { ChatQuestions, type ItemContext } from './items';
import { permissionOptions } from './model';

// An approval or a question for the user from a helper anywhere in the main thread's tree
// (orchestrator threads spec 14 to 18). The request stays in the helper's thread: the card reads
// it from that thread's topics and answers it with the same commands, so answering here is
// answering there. While it waits, the card is drawn at the end of the conversation (`dock`) and
// its place in the conversation says so; once answered, here or in the helper's own thread, the
// place says "Answered in <helper>" and the end has nothing. A request whose turn ended without
// an answer (the helper was stopped) waits no more.

const none: readonly never[] = [];

type GateState =
  | { readonly status: 'waits'; readonly item: ThreadItem; readonly helper: Thread | undefined }
  | { readonly status: 'answered'; readonly answer: string }
  | { readonly status: 'gone' };

interface GateRows {
  readonly state: GateState;
  readonly approval: Approval | undefined;
  readonly questions: readonly Question[];
}

// What the helper's thread says of the request now, from its stored rows.
function useGate(payload: GateCardItemPayload): GateRows {
  const approvals = useTopic('approvals', payload.fromThreadId) ?? none;
  const questions = useTopic('questions', payload.fromThreadId) ?? none;
  const items = useTopic('threadItems', payload.fromThreadId) ?? none;
  const turns = useTopic('turns', payload.fromThreadId) ?? none;
  const helper = useTopic('threads')?.find((thread) => thread.id === payload.fromThreadId);
  const approval =
    payload.kind === 'approval' ? approvals.find((row) => row.id === payload.requestId) : undefined;
  const question =
    payload.kind === 'question' ? questions.find((row) => row.id === payload.requestId) : undefined;
  const answer = approval?.decision
    ? decisionLabels[approval.decision]
    : (question?.answer ?? undefined);
  if (answer !== undefined) return { state: { status: 'answered', answer }, approval, questions };
  const item = items.find((each) => each.id === payload.itemId);
  const turn = item && turns.find((each) => each.id === item.turnId);
  const waits = item !== undefined && turn?.state === 'running';
  return {
    state: waits ? { status: 'waits', item, helper } : { status: 'gone' },
    approval,
    questions,
  };
}

// Its place in the conversation: one line.
export function GateCardLine({ payload }: { readonly payload: GateCardItemPayload }) {
  const { state } = useGate(payload);
  const helper = payload.title || 'the helper';
  return (
    <p
      data-testid="gate-card-line"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0" />
      {state.status === 'answered'
        ? `Answered in ${helper}: ${state.answer}`
        : state.status === 'waits'
          ? `${gateCardWho(payload)} asks you; the card waits at the end.`
          : `${gateCardWho(payload)} asked you; its turn ended without an answer.`}
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
  const { state, approval, questions } = useGate(payload);
  const instances = useTopic('providerInstances');
  if (state.status !== 'waits') return null;
  const { item, helper } = state;
  const kind = instances?.find((each) => each.id === helper?.providerInstanceId)?.kind;
  const mode = helper?.permissionMode ?? '';
  // The request in the helper's own folder and mode, which may not be the main thread's; it
  // takes neither the focus nor the keys (spec 15), and has no file to open in this view.
  const helperContext: ItemContext = {
    ...context,
    cwd: helper?.cwd ?? context.cwd,
    permissionLabel: kind
      ? (permissionOptions(kind, mode).find((option) => option.id === mode)?.label ?? mode)
      : mode,
    openFile: undefined,
    keyedApproval: undefined,
    gate: true,
  };
  const parsedApproval =
    payload.kind === 'approval' ? ApprovalItemPayload.safeParse(item.payload) : undefined;
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
        <ApprovalCard payload={parsedApproval.data} approval={approval} context={helperContext} />
      ) : (
        <ChatQuestions items={[item]} questions={questions} turnEnded={false} />
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
