import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { IconButton } from './hint';

// Puts text on the clipboard (agent workbench spec 32). `text` is read on click, so a button can
// copy what is rendered at that moment. "Copied" shows until the button loses the focus.
export function CopyButton({
  text,
  label = 'Copy',
  className,
  ...props
}: Omit<ComponentProps<typeof IconButton>, 'label' | 'onClick' | 'children'> & {
  readonly text: string | (() => string);
  readonly label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      size="icon-xs"
      className={className}
      data-copied={copied || undefined}
      onClick={(event) => {
        event.stopPropagation();
        const value = typeof text === 'string' ? text : text();
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
      onBlur={() => setCopied(false)}
      {...props}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
