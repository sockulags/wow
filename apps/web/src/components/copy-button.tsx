import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { notify } from '@/lib/feedback';
import { IconButton } from './hint';

// Puts text on the clipboard and says so when it could not: a browser without the clipboard, a
// page without the permission, or a write it refused. True when the text is there.
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) throw new Error('No clipboard');
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    notify.error('Nothing was copied', {
      id: 'copy-failed',
      description: 'The clipboard did not take the text. Select it and copy it by hand.',
    });
    return false;
  }
}

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
        void copyText(typeof text === 'string' ? text : text()).then(setCopied);
      }}
      onBlur={() => setCopied(false)}
      {...props}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
