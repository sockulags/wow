import type { Command, Decision } from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import { InboxIcon, SparklesIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useSetting } from '@/app/runtime';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The decision queue beside the assistant's conversation (chief of staff spec 16 to 19): what
// waits for the user, in the server's order, each with what wow says of it and the assistant's
// brief. The answers send the same commands as the views they come from, with the same keys.

const kindLabels: Readonly<Record<Decision['kind'], string>> = {
  approval: 'Approval',
  question: 'Question',
  gate: 'Gate',
  limit: 'Limit',
  proposal: 'Proposal',
  failedRun: 'Failed',
  missedCard: 'Missed',
};

interface Answer {
  readonly label: string;
  readonly command: Command;
  // The keybinding setting it answers to while the row has the keyboard.
  readonly key?:
    'keybindings.gateApprove' | 'keybindings.approvalAllowOnce' | 'keybindings.approvalDeny';
}

export function answersOf(decision: Decision): Answer[] {
  switch (decision.kind) {
    case 'gate':
      return decision.runId
        ? [
            {
              label: 'Approve',
              command: { type: 'workflowRun.continue', runId: decision.runId },
              key: 'keybindings.gateApprove',
            },
          ]
        : [];
    case 'limit':
      return decision.runId
        ? [
            {
              label: 'Run once more',
              command: { type: 'workflowRun.continue', runId: decision.runId },
              key: 'keybindings.gateApprove',
            },
          ]
        : [];
    case 'approval':
      return decision.approvalId
        ? [
            {
              label: 'Allow once',
              command: {
                type: 'approval.answer',
                approvalId: decision.approvalId,
                decision: 'allowOnce',
              },
              key: 'keybindings.approvalAllowOnce',
            },
            {
              label: 'Deny',
              command: {
                type: 'approval.answer',
                approvalId: decision.approvalId,
                decision: 'deny',
              },
              key: 'keybindings.approvalDeny',
            },
          ]
        : [];
    case 'proposal':
      return decision.proposalId
        ? [
            {
              label: 'Yes',
              command: { type: 'assistant.proposal.accept', proposalId: decision.proposalId },
              key: 'keybindings.gateApprove',
            },
            {
              label: 'No',
              command: { type: 'assistant.proposal.decline', proposalId: decision.proposalId },
            },
          ]
        : [];
    case 'failedRun':
    case 'missedCard':
      return [{ label: 'Dismiss', command: { type: 'decision.dismiss', decisionId: decision.id } }];
    case 'question':
      // A question is answered on its card, where its choices are.
      return [];
  }
}

function DecisionRow({ decision }: { readonly decision: Decision }) {
  const send = useDispatch();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const keys = {
    'keybindings.gateApprove': useSetting('keybindings.gateApprove'),
    'keybindings.approvalAllowOnce': useSetting('keybindings.approvalAllowOnce'),
    'keybindings.approvalDeny': useSetting('keybindings.approvalDeny'),
  };
  const answers = answersOf(decision);
  const run = (command: Command) => {
    setError(undefined);
    send(command).catch((caught: unknown) => setError(errorMessage(caught)));
  };
  const open = () => void navigate({ href: decision.path });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      open();
      return;
    }
    const pressed = eventToBinding(event);
    if (!pressed) return;
    const answer = answers.find(
      (entry) => entry.key && normalizeBinding(keys[entry.key]) === normalizeBinding(pressed),
    );
    if (answer) {
      event.preventDefault();
      run(answer.command);
    }
  };
  return (
    <li
      tabIndex={0}
      data-testid="decision"
      data-kind={decision.kind}
      aria-label={`${kindLabels[decision.kind]}: ${decision.title}`}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-sm bg-muted px-1 text-2xs text-muted-foreground">
          {kindLabels[decision.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{decision.title}</span>
      </div>
      {decision.where && <p className="truncate text-muted-foreground">{decision.where}</p>}
      {decision.fixed.map((line) => (
        <p key={line} className="text-muted-foreground">
          {line}
        </p>
      ))}
      {decision.brief ? (
        <div
          data-testid="decision-brief"
          className="flex flex-col gap-0.5 rounded-sm bg-muted/50 p-2"
        >
          <p className="flex items-start gap-1">
            <SparklesIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <span>{decision.brief.text}</span>
          </p>
          <p className="font-medium">Recommends: {decision.brief.recommendation}</p>
        </div>
      ) : (
        decision.briefPending && (
          <p className="text-muted-foreground italic">The assistant is reading it…</p>
        )
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {answers.map((answer) => (
          <Button
            key={answer.label}
            size="xs"
            variant="outline"
            onClick={() => run(answer.command)}
          >
            {answer.label}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={open}>
          Open
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function DecisionQueue({ className }: { readonly className?: string }) {
  const decisions = useTopic('decisions') ?? [];
  return (
    <section
      aria-label="Needs you"
      data-testid="decision-queue"
      className={cn('flex min-h-0 flex-col gap-2', className)}
    >
      <h2 className="flex items-center gap-1.5 text-sm font-medium">
        <InboxIcon aria-hidden className="size-4 text-muted-foreground" />
        Needs you
        {decisions.length > 0 && (
          <span className="text-xs text-muted-foreground">{decisions.length}</span>
        )}
      </h2>
      {decisions.length === 0 ? (
        <EmptyState compact icon={InboxIcon} title="Nothing waits for you" />
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {decisions.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} />
          ))}
        </ul>
      )}
    </section>
  );
}
