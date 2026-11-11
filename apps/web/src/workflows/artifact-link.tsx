import { useRouterState } from '@tanstack/react-router';
import { CopyIcon, FileTextIcon } from 'lucide-react';
import { useRuntime } from '@/app/runtime';
import { IconButton } from '@/components/hint';
import { openFile } from '@/panel/viewer';
import { artifactPath } from './model';

// One artifact a step left in the run's folder: open it in the side panel next to the
// conversation, or copy its full path.
export function Artifact({
  runId,
  cwd,
  path,
}: {
  readonly runId: string;
  readonly cwd: string;
  readonly path: string;
}) {
  const { settings, layout } = useRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const full = artifactPath(cwd, path);
  return (
    <li className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() =>
          openFile({ settings, layout }, { runId, path, fullPath: full, from: pathname })
        }
        className="inline-flex min-w-0 items-center gap-1 rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileTextIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          Open <span className="font-mono">{path}</span>
        </span>
      </button>
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
