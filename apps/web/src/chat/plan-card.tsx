import type { Approval, ApprovalDecision, ApprovalItemPayload } from '@wow/contracts';
import { ListChecksIcon } from 'lucide-react';
import { useEffect, useRef, type RefObject } from 'react';
import { WithTooltip } from '@/components/hint';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ApprovalNote, openApprovalNote } from './approval-card';

// The plan card (agent workbench spec 42, 43): Claude Code asks to leave plan mode. The plan is
// drawn as markdown; "Start, accept edits" (focused, so Enter takes it) and "Start, ask each
// time" allow the request and set the thread's mode, "Keep planning" denies with a note. When the
// request did not carry the plan, the card shows the turn's last text and says so.

const startedLabels: Readonly<Record<string, string>> = {
  acceptEdits: 'Started, accepting edits',
  default: 'Started, asking each time',
};

export function PlanCard({
  payload,
  approval,
  section,
  busy,
  error,
  noting,
  onAnswer,
}: {
  readonly payload: ApprovalItemPayload;
  readonly approval: Approval | undefined;
  readonly section: RefObject<HTMLElement | null>;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly noting: boolean;
  readonly onAnswer: (
    decision: ApprovalDecision,
    extra?: { note?: string; permissionMode?: string },
  ) => void;
}) {
  const decision = approval?.decision ?? null;
  const pending = decision === null && approval !== undefined;
  const plan = payload.plan;
  const disabled = busy || !approval;
  const start = useRef<HTMLButtonElement>(null);
  // A new plan takes the focus on its first choice, so Enter starts it (spec 42).
  useEffect(() => {
    if (pending) start.current?.focus();
  }, [pending]);
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Plan"
      data-testid="plan-card"
      data-pending={pending || undefined}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        decision === null ? 'border-info/60' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <ListChecksIcon className="size-4 shrink-0 text-info" />
        <Badge variant="outline">Plan</Badge>
        <span className="min-w-0 text-xs text-muted-foreground">
          {plan?.from === 'conversation'
            ? 'The plan as written in the conversation'
            : 'Claude Code is ready to leave plan mode'}
        </span>
      </div>
      {plan && plan.text !== '' ? (
        <div
          data-testid="plan-text"
          className="max-h-96 overflow-auto rounded border border-border px-3 py-2"
        >
          <Markdown text={plan.text} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">The plan was not sent with the request.</p>
      )}
      {decision === null ? (
        <>
          <div className="flex flex-wrap gap-2">
            <WithTooltip label="Start, accept edits" shortcut="keybindings.planAcceptEdits">
              <Button
                ref={start}
                size="sm"
                disabled={disabled}
                onClick={() => onAnswer('allowOnce', { permissionMode: 'acceptEdits' })}
              >
                Start, accept edits
              </Button>
            </WithTooltip>
            <WithTooltip label="Start, ask each time" shortcut="keybindings.planAskEachTime">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onAnswer('allowOnce', { permissionMode: 'default' })}
              >
                Start, ask each time
              </Button>
            </WithTooltip>
            <WithTooltip label="Keep planning" shortcut="keybindings.planKeepPlanning">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => openApprovalNote(payload.approvalId)}
              >
                Keep planning
              </Button>
            </WithTooltip>
          </div>
          {noting && (
            <ApprovalNote
              label="Keep planning"
              placeholder="What to change in the plan"
              busy={busy}
              onSend={(note) => onAnswer('deny', note.trim() === '' ? {} : { note })}
            />
          )}
        </>
      ) : (
        <p data-testid="approval-decision" className="text-xs text-muted-foreground">
          {decision === 'deny'
            ? payload.note
              ? `Kept planning: ${payload.note}`
              : 'Kept planning'
            : (startedLabels[payload.permissionMode ?? ''] ?? 'Started')}
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
