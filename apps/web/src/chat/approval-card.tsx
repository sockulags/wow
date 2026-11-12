import {
  ruleText,
  toolName,
  type Approval,
  type ApprovalDecision,
  type ApprovalItemPayload,
  type ApprovalKind,
  type Command,
  type ProposedRule,
} from '@wow/contracts';
import { dispatch, type Connection } from '@wow/client-runtime';
import { ChevronRightIcon, ShieldCheckIcon, ShieldQuestionIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { WithTooltip } from '@/components/hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { errorMessage, useDispatch } from './data';
import type { ItemContext } from './items';
import { PlanCard } from './plan-card';
import { EditDiff } from './tools/edit';
import { shownPath } from './tools/facts';

// The approval card (agent workbench spec 36 to 40): the request as what it is, with Allow once,
// Allow for this session, Always allow in this project (with the rule it stores) and Deny with a
// note. A plan approval is the plan card (plan-card.tsx). An approval stored before the agent
// workbench has no facts and is drawn as it was.

export interface ApprovalOffer {
  readonly approvalId: string;
  readonly kind: ApprovalKind;
  readonly rule: ProposedRule | undefined;
}

// A conversation's card that the keys may answer: the first pending one of its thread. A thread
// in the context panel (a step's) yields to the open thread's.
interface KeyedOffer {
  readonly offer: ApprovalOffer;
  readonly side: boolean;
}

interface ApprovalCardState {
  // The approval on screen that waits for an answer, as its card read it, for the palette.
  readonly offer: ApprovalOffer | undefined;
  readonly keyed: readonly KeyedOffer[];
  // The card whose note is open: a denial's, or a plan's Keep planning.
  readonly noting: string | undefined;
}

export const approvalCardStore = createStore<ApprovalCardState>(() => ({
  offer: undefined,
  keyed: [],
  noting: undefined,
}));

const keyedOffer = (keyed: readonly KeyedOffer[]): ApprovalOffer | undefined =>
  (keyed.find((entry) => !entry.side) ?? keyed[0])?.offer;

function keepOffer(entry: KeyedOffer): () => void {
  const others = approvalCardStore
    .getState()
    .keyed.filter((kept) => kept.offer.approvalId !== entry.offer.approvalId);
  const keyed = [...others, entry];
  approvalCardStore.setState({ keyed, offer: keyedOffer(keyed) });
  return () => {
    const state = approvalCardStore.getState();
    const left = state.keyed.filter((kept) => kept !== entry);
    if (left.length === state.keyed.length) return;
    approvalCardStore.setState({
      keyed: left,
      offer: keyedOffer(left),
      ...(state.noting === entry.offer.approvalId ? { noting: undefined } : {}),
    });
  };
}

export const openApprovalNote = (approvalId: string): void =>
  approvalCardStore.setState({ noting: approvalId });
export const closeApprovalNote = (): void => approvalCardStore.setState({ noting: undefined });

export const useApprovalOffer = (): ApprovalOffer | undefined =>
  useStore(approvalCardStore, (state) => state.offer);

const decisionLabels: Readonly<Record<ApprovalDecision, string>> = {
  allowOnce: 'Allowed once',
  allowSession: 'Allowed for this session',
  allowAlways: 'Always allowed in this project',
  deny: 'Denied',
};

const kindLabels: Readonly<Record<ApprovalKind, string>> = {
  command: 'Command',
  fileChange: 'File change',
  tool: 'Tool',
  plan: 'Plan',
};

// A rule's words with its command or tool in mono, as the card and Settings show it.
export function RuleText({ rule }: { readonly rule: ProposedRule }) {
  const [before, code, after] = ruleText(rule).split('`');
  return (
    <span data-testid="approval-rule">
      {before}
      <code className="font-mono">{code}</code>
      {after}
    </span>
  );
}

function requestDetails(approval: Approval | undefined): unknown {
  const request = approval?.request;
  if (typeof request !== 'object' || request === null || !('details' in request)) return null;
  return request.details;
}

// The folder of an old request: the provider's report when it sent one, else the thread's.
function oldFolder(details: unknown, fallback: string): string {
  if (typeof details === 'object' && details !== null && 'cwd' in details) {
    const cwd = (details as { cwd: unknown }).cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return fallback;
}

const argumentText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

// What the request is (spec 36): a command line with its folder, an edit as its diff, a web
// address, or a tool with its arguments.
function RequestBody({
  payload,
  details,
  context,
  pending,
}: {
  readonly payload: ApprovalItemPayload;
  readonly details: unknown;
  readonly context: ItemContext;
  readonly pending: boolean;
}) {
  const facts = payload.facts;
  const folderLine = (folder: string) => (
    <p data-testid="approval-context" className="text-xs text-muted-foreground">
      In <span className="font-mono">{folder}</span> · {context.permissionLabel}
    </p>
  );
  if (!facts) return folderLine(oldFolder(details, context.cwd));
  if (payload.kind === 'command' && facts.command) {
    return (
      <>
        <code data-testid="approval-command" className="font-mono text-xs break-all">
          $ {facts.command}
        </code>
        {folderLine(facts.cwd ?? context.cwd)}
      </>
    );
  }
  if (payload.kind === 'fileChange' && facts.diff) {
    const path = facts.path === undefined ? undefined : shownPath(facts.path, context.cwd);
    return (
      <>
        <EditDiff
          diff={facts.diff}
          path={path}
          cut={payload.diffCut}
          // Until the edit is allowed and made, the file has not changed and Changes lacks it.
          onOpenFile={pending ? undefined : context.openFile}
        />
        {folderLine(context.cwd)}
      </>
    );
  }
  if (facts.url) {
    return (
      <>
        <span data-testid="approval-url" className="font-mono text-xs break-all">
          {facts.url}
        </span>
        {folderLine(context.cwd)}
      </>
    );
  }
  if (facts.tool) {
    const args =
      typeof facts.arguments === 'object' && facts.arguments !== null
        ? Object.entries(facts.arguments)
        : [];
    return (
      <>
        <code data-testid="approval-tool" className="font-mono text-xs">
          {toolName({ server: facts.server ?? null, tool: facts.tool })}
        </code>
        {args.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            {args.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}:</dt>
                <dd className="min-w-0 truncate font-mono">{argumentText(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {folderLine(context.cwd)}
      </>
    );
  }
  return folderLine(context.cwd);
}

export async function answerApproval(
  send: (command: Command) => Promise<unknown>,
  approvalId: string,
  decision: ApprovalDecision,
  extra: { note?: string; permissionMode?: string } = {},
): Promise<void> {
  await send({ type: 'approval.answer', approvalId, decision, ...extra });
  closeApprovalNote();
}

// The note under Deny or Keep planning: one line, Enter sends, Escape closes it (spec 37).
export function ApprovalNote({
  label,
  placeholder,
  busy,
  onSend,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly busy: boolean;
  readonly onSend: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend(note);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeApprovalNote();
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        aria-label={label}
        data-testid="approval-note"
        placeholder={placeholder}
        value={note}
        disabled={busy}
        className="h-8 text-xs"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onSend(note)}>
        {label}
      </Button>
    </div>
  );
}

export function ApprovalCard({
  payload,
  approval,
  context,
}: {
  readonly payload: ApprovalItemPayload;
  readonly approval: Approval | undefined;
  readonly context: ItemContext;
}) {
  const send = useDispatch();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const decision = approval?.decision ?? null;
  const details = requestDetails(approval);
  const pending = decision === null && approval !== undefined;
  const noting = useStore(approvalCardStore, (state) => state.noting === payload.approvalId);
  // A new request takes the focus, so its keys work at once (audit A-11); a plan's first choice
  // takes it itself, so Enter starts the plan.
  useEffect(() => {
    if (pending && payload.kind !== 'plan') section.current?.focus();
  }, [pending, payload.kind]);
  // The palette and the keys answer the thread's first request on screen, whichever card
  // mounted last.
  const keyed = context.keyedApproval;
  const answersKeys = pending && (keyed === undefined || keyed.id === payload.approvalId);
  const side = keyed?.side ?? false;
  useEffect(() => {
    if (!answersKeys) return;
    return keepOffer({
      offer: { approvalId: payload.approvalId, kind: payload.kind, rule: payload.rule },
      side,
    });
  }, [answersKeys, side, payload.approvalId, payload.kind, payload.rule]);

  const answer = (
    choice: ApprovalDecision,
    extra: { note?: string; permissionMode?: string } = {},
  ) => {
    setBusy(true);
    setError(undefined);
    answerApproval(send, payload.approvalId, choice, extra).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };

  if (payload.kind === 'plan') {
    return (
      <PlanCard
        payload={payload}
        approval={approval}
        section={section}
        busy={busy}
        error={error}
        noting={noting}
        onAnswer={answer}
      />
    );
  }

  const disabled = busy || !approval;
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Approval request"
      data-pending={pending || undefined}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        decision === null ? 'border-state-needs-you/60' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        {payload.byRule ? (
          <ShieldCheckIcon className="size-4 shrink-0 text-state-done" />
        ) : (
          <ShieldQuestionIcon className="size-4 shrink-0 text-state-needs-you" />
        )}
        <Badge variant="outline">{kindLabels[payload.kind]}</Badge>
        <span className="min-w-0 font-mono text-xs break-all">{payload.summary}</span>
      </div>
      <RequestBody payload={payload} details={details} context={context} pending={pending} />
      {details !== null && details !== undefined && (
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Details
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
            {JSON.stringify(details, null, 2)}
          </pre>
        </details>
      )}
      {decision === null ? (
        <>
          <div className="flex flex-wrap gap-2">
            <WithTooltip label="Allow once" shortcut="keybindings.approvalAllowOnce">
              <Button size="sm" disabled={disabled} onClick={() => answer('allowOnce')}>
                Allow once
              </Button>
            </WithTooltip>
            <WithTooltip label="Allow for this session" shortcut="keybindings.approvalAllowSession">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => answer('allowSession')}
              >
                Allow for this session
              </Button>
            </WithTooltip>
            {payload.rule && (
              <WithTooltip
                label="Always allow in this project"
                shortcut="keybindings.approvalAllowAlways"
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => answer('allowAlways')}
                >
                  Always allow in this project
                </Button>
              </WithTooltip>
            )}
            <WithTooltip label="Deny" shortcut="keybindings.approvalDeny">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => openApprovalNote(payload.approvalId)}
              >
                Deny
              </Button>
            </WithTooltip>
          </div>
          {payload.rule && (
            <p className="text-xs text-muted-foreground">
              Always allow stores: <RuleText rule={payload.rule} />
            </p>
          )}
          {noting && (
            <ApprovalNote
              label="Deny"
              placeholder="No, and tell it what to do instead"
              busy={busy}
              onSend={(note) => answer('deny', note.trim() === '' ? {} : { note })}
            />
          )}
        </>
      ) : (
        <p data-testid="approval-decision" className="text-xs text-muted-foreground">
          {payload.byRule ? (
            <>
              Allowed by rule: <RuleText rule={payload.byRule} />
            </>
          ) : decision === 'allowAlways' && payload.rule ? (
            <>
              {decisionLabels[decision]}: <RuleText rule={payload.rule} />
            </>
          ) : payload.note ? (
            `Denied: ${payload.note}`
          ) : (
            decisionLabels[decision]
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

const plainCommands: ReadonlyArray<{
  readonly decision: Exclude<ApprovalDecision, 'deny'> | 'deny';
  readonly title: string;
  readonly keybinding: AppCommand['keybinding'];
}> = [
  { decision: 'allowOnce', title: 'Allow once', keybinding: 'keybindings.approvalAllowOnce' },
  {
    decision: 'allowSession',
    title: 'Allow for this session',
    keybinding: 'keybindings.approvalAllowSession',
  },
  {
    decision: 'allowAlways',
    title: 'Always allow in this project',
    keybinding: 'keybindings.approvalAllowAlways',
  },
  { decision: 'deny', title: 'Deny…', keybinding: 'keybindings.approvalDeny' },
];

// The answers to the approval on screen as palette commands with their keys (spec 37, 38, 43).
export function approvalCommands(offer: ApprovalOffer | undefined): AppCommand[] {
  if (!offer) return [];
  const { approvalId } = offer;
  const send =
    (decision: ApprovalDecision, extra: { permissionMode?: string } = {}) =>
    ({ connection }: { connection: Connection | undefined }) => {
      if (!connection) return;
      void answerApproval(
        (command) => dispatch(connection, command),
        approvalId,
        decision,
        extra,
      ).catch(() => undefined);
    };
  const base = {
    group: 'Chat' as const,
    keywords: ['approval', 'approve', 'permission', 'request'],
  };
  if (offer.kind === 'plan') {
    return [
      {
        ...base,
        id: 'chat.plan.acceptEdits',
        title: 'Plan: start, accept edits',
        keywords: [...base.keywords, 'plan', 'start'],
        keybinding: 'keybindings.planAcceptEdits',
        detail: 'Plan',
        run: send('allowOnce', { permissionMode: 'acceptEdits' }),
      },
      {
        ...base,
        id: 'chat.plan.askEachTime',
        title: 'Plan: start, ask each time',
        keywords: [...base.keywords, 'plan', 'start'],
        keybinding: 'keybindings.planAskEachTime',
        detail: 'Plan',
        run: send('allowOnce', { permissionMode: 'default' }),
      },
      {
        ...base,
        id: 'chat.plan.keepPlanning',
        title: 'Plan: keep planning…',
        keywords: [...base.keywords, 'plan', 'deny'],
        keybinding: 'keybindings.planKeepPlanning',
        detail: 'Plan',
        run: () => openApprovalNote(approvalId),
      },
    ];
  }
  return plainCommands
    .filter((entry) => entry.decision !== 'allowAlways' || offer.rule !== undefined)
    .map(({ decision, title, keybinding }) => ({
      ...base,
      id: `chat.approval.${decision}`,
      title,
      ...(keybinding ? { keybinding } : {}),
      detail: 'Approval',
      run: decision === 'deny' ? () => openApprovalNote(approvalId) : send(decision),
    }));
}
