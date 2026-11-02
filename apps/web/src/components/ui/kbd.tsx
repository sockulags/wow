import * as React from 'react';

import { cn } from '@/lib/utils';

// One key or key combination, in the interface font (design rules: no monospace for hints).
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border border-border px-1 font-sans text-2xs font-medium tabular-nums select-none',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
