import {
  findSecret,
  heldSecretSentence,
  secretPatterns as compiled,
  type AssistantChange,
  type AssistantPlace,
  type AssistantProposal,
  type AssistantProposalLine,
} from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  CheckIcon,
  CircleAlertIcon,
  PencilLineIcon,
  ShieldQuestionIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { errorMessage } from '@/chat/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { proposalFocus } from './model';

// Change rows and proposal cards inline in the assistant's conversation (app assistant spec 7 to
// 10, 20). They show the server's rows and send the user's answer; whether a change is undone or
// a proposal answered comes back on the topic, never from here.

// "08:00–17:00 → 08:00–16:00", "→ on" for something new, "Tea → removed" for something removed.
export function fromTo({ from, to }: Pick<AssistantProposalLine, 'from' | 'to'>): string {
  if (from === null && to === null) return '';
  if (from === null) return `new: ${to ?? ''}`;
  if (to === null) return `${from} → removed`;
  return `${from} → ${to}`;
}

// The place a change lives as a link the router follows (the path can carry a search part).
export function PlaceLink({ place }: { place: AssistantPlace }) {
  const navigate = useNavigate();
  return (
    <a
      href={place.path}
      data-testid="assistant-place"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        void navigate({ href: place.path });
      }}
      className="rounded-sm whitespace-nowrap underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {place.label}
    </a>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };
  return { busy, error, run };
}

function Refusal({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// One line: "Work hours: 08:00–17:00 → 08:00–16:00 · Settings → Calendar" with Undo, greyed and
// marked "Undone" after. A refused Undo shows the server's reason under it (spec 8).
export function ChangeRow({
  change,
  onUndo,
}: {
  change: AssistantChange;
  onUndo(): Promise<unknown>;
}) {
  const { busy, error, run } = useAction();
  const undone = change.state === 'undone';
  return (
    <section
      aria-label={`Change: ${change.what}`}
      data-testid="assistant-change"
      data-state={change.state}
      className="flex flex-col gap-1 rounded-md border border-border px-3 py-1.5 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <PencilLineIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className={cn('min-w-0 flex-1', undone && 'text-muted-foreground line-through')}>
          <span className="font-medium">{change.what}</span>
          {fromTo(change) !== '' && (
            <>
              : <span data-testid="assistant-change-values">{fromTo(change)}</span>
            </>
          )}
          <span aria-hidden className="text-muted-foreground">
            {' · '}
          </span>
          <span className="text-muted-foreground">
            <PlaceLink place={change.place} />
          </span>
        </p>
        {undone ? (
          <Badge variant="outline" className="text-muted-foreground">
            Undone
          </Badge>
        ) : (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => run(onUndo)}>
            Undo
          </Button>
        )}
      </div>
      {error && <Refusal>{error}</Refusal>}
    </section>
  );
}

// The whole of a value the line had to shorten, on request.
function WholeValue({ label, text }: { label: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {label}: show all of it
      </summary>
      <pre
        data-testid="assistant-proposal-full"
        className="mt-1 max-h-64 overflow-auto rounded-sm bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
      >
        {text}
      </pre>
    </details>
  );
}

const answered: Readonly<Record<AssistantProposal['state'], string>> = {
  pending: 'Waiting for your answer',
  accepted: 'Yes: applied',
  declined: 'No: nothing changed',
};

// A card that lists exactly what would change, with Yes and No (spec 9, 10). No asks for an
// optional reason, which goes to the assistant with its next turn; a reason that looks like a
// secret (`assistant.secretPatterns`) is not sent, as a held message is not (spec 17). Yes can
// be refused when the thing changed since; the card says why and still offers No.
export function ProposalCard({
  proposal,
  secretPatterns,
  onYes,
  onNo,
}: {
  proposal: AssistantProposal;
  secretPatterns: readonly string[];
  onYes(): Promise<unknown>;
  onNo(reason: string | undefined): Promise<unknown>;
}) {
  const { busy, error, run } = useAction();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const pending = proposal.state === 'pending';
  const card = useRef<HTMLElement>(null);
  const focusWanted = useStore(proposalFocus, (state) => state.id === proposal.id);
  // Show on the waiting line (spec 96) brings the card into view with the focus on it.
  useEffect(() => {
    if (!focusWanted) return;
    card.current?.scrollIntoView({ block: 'center' });
    card.current?.focus();
    proposalFocus.setState({ id: undefined });
  }, [focusWanted]);
  const decline = () => {
    const typed = reason.trim();
    const secret = typed === '' ? null : findSecret(typed, compiled(secretPatterns));
    run(() =>
      secret
        ? Promise.reject(new Error(heldSecretSentence(secret.kind)))
        : onNo(typed === '' ? undefined : typed),
    );
  };
  return (
    <section
      ref={card}
      tabIndex={-1}
      aria-label={`Proposal: ${proposal.title}`}
      data-testid="assistant-proposal"
      data-proposal-id={proposal.id}
      data-state={proposal.state}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pending ? 'border-state-needs-you/60' : 'border-border text-muted-foreground',
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldQuestionIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-state-needs-you-text"
        />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-foreground">{proposal.title}</h3>
          <p className="text-xs text-muted-foreground">
            Nothing changes until you say yes · <PlaceLink place={proposal.place} />
          </p>
        </div>
      </div>
      {proposal.lines.length > 0 && (
        <ul aria-label="What would change" className="flex flex-col gap-0.5 pl-6 text-xs">
          {proposal.lines.map((line, index) => (
            <li key={index}>
              <span className="font-medium">{line.what}</span>
              {fromTo(line) !== '' && `: ${fromTo(line)}`}
              <WholeValue label="Was" text={line.fromFull} />
              <WholeValue label="Becomes" text={line.toFull} />
            </li>
          ))}
        </ul>
      )}
      {pending ? (
        declining ? (
          <form
            className="flex flex-wrap items-center gap-2 pl-6"
            onSubmit={(event) => {
              event.preventDefault();
              decline();
            }}
          >
            <Input
              aria-label="Reason for no (optional)"
              placeholder="Why not? (optional, the assistant reads it)"
              value={reason}
              autoFocus
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              className="h-8 min-w-48 flex-1 text-sm"
            />
            <Button size="sm" type="submit" variant="secondary" disabled={busy}>
              Say no
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setDeclining(false)}
            >
              Back
            </Button>
          </form>
        ) : (
          <div className="flex gap-2 pl-6">
            <Button size="sm" disabled={busy} onClick={() => run(onYes)}>
              <CheckIcon />
              Yes
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeclining(true)}>
              <XIcon />
              No
            </Button>
          </div>
        )
      ) : (
        <p data-testid="assistant-proposal-answer" className="pl-6 text-xs">
          {answered[proposal.state]}
          {proposal.state === 'declined' && proposal.reason && ` (${proposal.reason})`}
        </p>
      )}
      {error && (
        <div className="pl-6">
          <Refusal>{error}</Refusal>
        </div>
      )}
    </section>
  );
}

// The line above the composer while proposals wait (agent workbench spec 96): the oldest by its
// title, with Yes, No and Show. No here gives no reason; the card's No asks for one.
export function WaitingLine({
  text,
  onYes,
  onNo,
  onShow,
}: {
  text: string;
  onYes(): Promise<unknown>;
  onNo(): Promise<unknown>;
  onShow(): void;
}) {
  const { busy, error, run } = useAction();
  return (
    <div
      role="status"
      aria-label="Waiting proposal"
      data-testid="assistant-waiting"
      className="flex flex-col gap-1 rounded-md border border-state-needs-you/60 px-3 py-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-state-needs-you-text" />
        <p data-testid="assistant-waiting-text" className="min-w-0 flex-1 truncate">
          {text}
        </p>
        <Button size="xs" disabled={busy} onClick={() => run(onYes)}>
          Yes
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run(onNo)}>
          No
        </Button>
        <Button size="xs" variant="ghost" onClick={onShow}>
          Show
        </Button>
      </div>
      {error && <Refusal>{error}</Refusal>}
    </div>
  );
}
