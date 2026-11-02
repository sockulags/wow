import { CopyIcon, ExternalLinkIcon } from 'lucide-react';
import { IconButton } from '@/components/hint';
import { artifactPath, artifactUrl } from './model';

// One artifact found in the project folder: open it, or copy its full path.
export function Artifact({ cwd, path }: { cwd: string; path: string }) {
  const full = artifactPath(cwd, path);
  return (
    <li className="flex items-center gap-1.5">
      <a
        href={artifactUrl(cwd, path)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          Open <span className="font-mono">{path}</span>
        </span>
      </a>
      <IconButton
        label={`Copy path of ${path}`}
        size="icon-xs"
        className="text-muted-foreground"
        onClick={() => void navigator.clipboard?.writeText(full).catch(() => {})}
      >
        <CopyIcon />
      </IconButton>
    </li>
  );
}
