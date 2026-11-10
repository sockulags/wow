import { FileReadResult, type FileRefusal } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  CopyIcon,
  FileXIcon,
  Maximize2Icon,
  Minimize2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime, useSetting, type ViewerFile } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { CodeBlock } from '@/components/code-block';
import { IconButton } from '@/components/hint';
import { Markdown } from '@/components/markdown';
import { DisconnectedState, EmptyState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  closeViewer,
  copyFilePath,
  fileLanguage,
  formatBytes,
  frameDocument,
  toggleFullSize,
} from './viewer';

// One file of a run in the context panel (review loop spec 6 to 8): markdown rendered, a picture
// fitted, HTML as a page in a frame that reaches nothing, any other text as code. The server
// reads the file; when it refuses, the panel says why.

type FileState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'done'; readonly result: FileReadResult };

function useFile(runId: string, path: string): FileState | undefined {
  const { connection } = useRuntime();
  const [state, setState] = useState<FileState>({ status: 'loading' });
  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    setState({ status: 'loading' });
    connection.request('files.read', { runId, path }).then(
      (answer) => {
        if (!current) return;
        const result = FileReadResult.safeParse(answer);
        setState(
          result.success
            ? { status: 'done', result: result.data }
            : {
                status: 'failed',
                message: 'The server answered in a form this app does not read.',
              },
        );
      },
      (error: unknown) => current && setState({ status: 'failed', message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [connection, runId, path]);
  return connection ? state : undefined;
}

const kindLabels: Readonly<Record<Exclude<FileReadResult['kind'], 'refused'>, string>> = {
  markdown: 'Markdown',
  image: 'Picture',
  html: 'HTML page',
  text: 'Text',
};

const refusalTitles: Readonly<Record<FileRefusal, string>> = {
  outside: 'Outside the run’s folders',
  missing: 'File not found',
  not_a_file: 'Not a file',
  binary: 'Not shown: binary file',
  too_large: 'Not shown: file too large',
};

function Shown({
  file,
  result,
}: {
  readonly file: ViewerFile;
  readonly result: Exclude<FileReadResult, { kind: 'refused' }>;
}) {
  const scripts = useSetting('viewer.htmlScripts');
  const highlightMax = useSetting('viewer.highlightMaxBytes');
  switch (result.kind) {
    case 'markdown':
      return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="viewer-markdown">
          <Markdown text={result.text} />
        </div>
      );
    case 'image':
      return (
        <div
          data-testid="viewer-image"
          className={cn(
            'min-h-0 flex-1 p-3',
            file.fullSize ? 'overflow-auto' : 'flex items-center justify-center overflow-hidden',
          )}
        >
          <img
            alt={file.path}
            src={`data:${result.mediaType};base64,${result.base64}`}
            className={file.fullSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
          />
        </div>
      );
    case 'html':
      return (
        // The sandbox gives the page no origin: it cannot read the app, its storage or the disk,
        // open windows or leave the frame. Without allow-scripts nothing in it runs.
        <iframe
          key={String(scripts)}
          title={file.path}
          data-testid="viewer-html"
          sandbox={scripts ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
          srcDoc={frameDocument(result.text, scripts)}
          className="min-h-0 w-full flex-1 bg-white [color-scheme:light]"
        />
      );
    default:
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="viewer-text">
          <CodeBlock
            code={result.text}
            language={result.size <= highlightMax ? fileLanguage(file.path) : undefined}
            className="min-w-max"
          />
        </div>
      );
  }
}

function Body({ file, state }: { readonly file: ViewerFile; readonly state: FileState }) {
  if (state.status === 'loading') return <LoadingState compact rows={6} label="Reading the file" />;
  if (state.status === 'failed') {
    return (
      <EmptyState compact icon={TriangleAlertIcon} title="The file could not be read">
        {state.message}
      </EmptyState>
    );
  }
  const { result } = state;
  if (result.kind !== 'refused') return <Shown file={file} result={result} />;
  return (
    <EmptyState
      compact
      icon={FileXIcon}
      title={refusalTitles[result.reason]}
      description={<span data-testid="viewer-refusal">{result.message}</span>}
      action={
        result.reason === 'too_large' ? (
          <Button asChild size="xs" variant="outline">
            <Link to="/settings/$group" params={{ group: 'viewer' }}>
              Open Viewer settings
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}

export function FileViewer({ file }: { readonly file: ViewerFile }) {
  const { layout } = useRuntime();
  const state = useFile(file.runId, file.path);
  const result = state?.status === 'done' ? state.result : undefined;
  const read = result && result.kind !== 'refused' ? result : undefined;
  return (
    <section
      aria-label="File viewer"
      data-testid="file-viewer"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        closeViewer(layout);
      }}
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => closeViewer(layout)}>
            <ArrowLeftIcon />
            Back to conversation
          </Button>
          <span className="flex-1" />
          {read?.kind === 'image' && (
            <IconButton
              label={file.fullSize ? 'Fit to panel' : 'Full size'}
              size="icon-xs"
              aria-pressed={file.fullSize}
              onClick={() => toggleFullSize(layout)}
            >
              {file.fullSize ? <Minimize2Icon /> : <Maximize2Icon />}
            </IconButton>
          )}
          <IconButton
            label="Copy path"
            size="icon-xs"
            onClick={() => copyFilePath(file, read?.absolutePath)}
          >
            <CopyIcon />
          </IconButton>
        </div>
        <div className="flex min-w-0 items-baseline gap-2 px-2">
          <h3
            data-testid="viewer-path"
            title={file.fullPath}
            className="min-w-0 flex-1 truncate font-mono text-xs"
          >
            {file.path}
          </h3>
          {read && (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              {kindLabels[read.kind]} · {formatBytes(read.size)}
            </span>
          )}
        </div>
      </div>
      {state ? <Body file={file} state={state} /> : <DisconnectedState compact offline />}
    </section>
  );
}
