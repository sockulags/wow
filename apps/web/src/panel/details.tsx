import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The panel's building blocks: a titled block with a two-column list of facts under it.

export function PanelTitle({
  title,
  meta,
  dot,
  actions,
}: {
  readonly title: string;
  // One line under the title: when, or what kind of thing it is.
  readonly meta?: ReactNode;
  // A state color class for the dot before the title.
  readonly dot?: string | undefined;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 pt-4">
      <div className="flex min-w-0 items-start gap-2">
        {dot && <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot)} />}
        <h3 data-testid="panel-title" className="min-w-0 flex-1 text-sm font-medium break-words">
          {title}
        </h3>
      </div>
      {meta !== undefined && <p className="text-xs text-muted-foreground tabular-nums">{meta}</p>}
      {actions !== undefined && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function PanelSection({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section aria-label={label} className={cn('flex flex-col gap-2 px-4 pt-4', className)}>
      <h4 className="text-2xs font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
}

// Facts with no value are left out, so a card without a project shows no empty row.
export function FactList({ facts }: { readonly facts: readonly (Fact | false | undefined)[] }) {
  const shown = facts.filter((fact): fact is Fact => Boolean(fact));
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {shown.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 break-words" data-testid={`fact-${fact.label}`}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const panelLinkClass =
  'rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';
