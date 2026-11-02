import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

// Sonner themed with the app's tokens. The shell renders one; see `lib/feedback` for the API.
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      closeButton
      containerAriaLabel="Notifications"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border-strong)',
          '--border-radius': 'var(--radius)',
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'font-sans text-sm',
          description: '!text-muted-foreground text-xs',
          actionButton: '!bg-primary !text-primary-foreground !font-medium',
          success: '[&_[data-icon]]:text-state-done',
          error: '[&_[data-icon]]:text-destructive',
          warning: '[&_[data-icon]]:text-warning',
          info: '[&_[data-icon]]:text-info',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
