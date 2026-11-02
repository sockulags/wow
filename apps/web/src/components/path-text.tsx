import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { IconButton, WithTooltip } from '@/components/hint';
import { cn } from '@/lib/utils';

// Splits a path before its last segment, so the start (drive, home) and the name both stay
// visible and only the middle is cut.
export function splitPath(path: string): { readonly head: string; readonly tail: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at <= 0) return { head: '', tail: path };
  return { head: path.slice(0, at + 1), tail: path.slice(at + 1) };
}

// A file or folder path on one line: ellipsis in the middle, the full path in a tooltip, and an
// optional copy button. Long Windows paths never widen the row around it.
export function PathText({
  path,
  copy = false,
  className,
}: {
  readonly path: string;
  readonly copy?: boolean;
  readonly className?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const { head, tail } = splitPath(path);
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <WithTooltip label={<span className="font-mono">{path}</span>}>
        <span
          tabIndex={0}
          data-testid="path-text"
          className="flex min-w-0 rounded-sm font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">{head}</span>
          <span className="shrink-0 whitespace-pre">{tail}</span>
        </span>
      </WithTooltip>
      {copy && (
        <IconButton
          label={copied ? 'Copied' : 'Copy path'}
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => {
            void navigator.clipboard?.writeText(path).then(() => setCopied(true));
          }}
          onBlur={() => setCopied(false)}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      )}
    </span>
  );
}
