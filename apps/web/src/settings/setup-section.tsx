import type { SetupApplication, SetupPreview } from '@wow/contracts';
import { CircleAlertIcon, FileDownIcon, FileUpIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { fromTo, PlaceLink } from '@/assistant/rows';
import { errorMessage, useTopic } from '@/chat/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/feedback';
import {
  cancelSetup,
  confirmSetup,
  readSetupFile,
  saveSetupFile,
  setupIsEmpty,
  setupStore,
  undoSetup,
} from './setup';

// Settings → Advanced: save the setup to a file, start from one after its preview, and Undo
// for each file applied here (app assistant spec 21 to 23).

function Lines({ title, lines }: { title: string; lines: SetupPreview['added'] }) {
  if (lines.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">
        {title} ({lines.length})
      </h3>
      <ul className="flex flex-col gap-0.5 text-xs">
        {lines.map((line) => (
          <li key={line.what}>
            <span data-testid="setup-line">
              <span className="font-medium">{line.what}</span>
              {fromTo(line) !== '' && <>: {fromTo(line)}</>}
            </span>
            {line.full !== undefined && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  Show all of it
                </summary>
                <pre
                  data-testid="setup-line-full"
                  className="mt-1 max-h-64 overflow-auto rounded-sm bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
                >
                  {line.full}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SetupPreviewDialog() {
  const { connection } = useRuntime();
  const draft = useStore(setupStore, (state) => state.draft);
  const read = draft?.read;
  const empty = read !== undefined && setupIsEmpty(read);
  return (
    <Dialog open={draft !== undefined} onOpenChange={(open) => !open && cancelSetup()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Start from {draft?.name}</DialogTitle>
          <DialogDescription>
            {read?.outcome === 'refused'
              ? 'This file cannot be used. Nothing was changed.'
              : empty
                ? 'This install already has everything the file holds. Nothing would change.'
                : 'Applying it changes what is listed here, as one step you can undo.'}
          </DialogDescription>
        </DialogHeader>
        {read?.outcome === 'refused' && (
          <ul aria-label="Why the file is refused" className="flex flex-col gap-1 text-xs">
            {read.problems.map((problem) => (
              <li
                key={`${problem.line ?? 0}:${problem.reason}`}
                data-testid="setup-problem"
                className="flex items-start gap-1.5 text-destructive"
              >
                <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {problem.line !== null && (
                    <span className="font-medium">Line {problem.line}: </span>
                  )}
                  {problem.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
        {read?.outcome === 'ready' && (
          <div className="flex flex-col gap-3">
            {read.preview.warnings.length > 0 && (
              <section
                aria-label="Read before you apply"
                className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
              >
                <h3 className="font-medium">Read before you apply</h3>
                <ul className="flex flex-col gap-1">
                  {read.preview.warnings.map((warning) => (
                    <li
                      key={warning}
                      data-testid="setup-warning"
                      className="flex items-start gap-1.5"
                    >
                      <TriangleAlertIcon
                        aria-hidden
                        className="mt-0.5 size-3.5 shrink-0 text-warning"
                      />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Lines title="Added" lines={read.preview.added} />
            <Lines title="Replaced" lines={read.preview.replaced} />
            {read.preview.marked.length > 0 && (
              <section aria-label="Marked" className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">Marked</h3>
                <ul className="flex flex-col gap-0.5 text-xs">
                  {read.preview.marked.map((mark) => (
                    <li key={`${mark.workflow}:${mark.reason}`} data-testid="setup-mark">
                      <span className="font-medium">Workflow "{mark.workflow}"</span>: {mark.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {read.preview.toFillIn.length > 0 && (
              <section aria-label="To fill in" className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">To fill in afterwards</h3>
                <ul className="flex flex-col gap-0.5 text-xs">
                  {read.preview.toFillIn.map((fill) => (
                    <li key={fill.key} data-testid="setup-fill-in">
                      <span className="font-medium">{fill.label}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        <PlaceLink place={fill.place} />
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
        {draft?.error && (
          <p role="alert" className="text-xs text-destructive">
            {draft.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={cancelSetup}>
            {read?.outcome === 'ready' && !empty ? 'Cancel' : 'Close'}
          </Button>
          {read?.outcome === 'ready' && !empty && (
            <Button
              disabled={draft?.busy || !connection}
              onClick={() => connection && void confirmSetup(connection)}
            >
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplicationRow({ application }: { application: SetupApplication }) {
  const { connection } = useRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const undone = application.state === 'undone';
  const counts = `${application.added.length} added, ${application.replaced.length} replaced`;
  return (
    <li
      data-testid="setup-application"
      data-state={application.state}
      className="flex flex-col gap-1 rounded-md border border-border px-3 py-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className={cn('min-w-0 flex-1', undone && 'text-muted-foreground line-through')}>
          <span className="font-medium">{application.name}</span>
          <span className="text-muted-foreground"> · {counts}</span>
        </p>
        {undone ? (
          <Badge variant="outline" className="text-muted-foreground">
            Undone
          </Badge>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !connection}
            onClick={() => {
              if (!connection) return;
              setBusy(true);
              setError(undefined);
              undoSetup(connection, application).then(
                () => setBusy(false),
                (reason: unknown) => {
                  setBusy(false);
                  setError(errorMessage(reason));
                },
              );
            }}
          >
            Undo
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

const failed = (title: string) => (error: unknown) =>
  notify.error(title, { description: errorMessage(error) });

export function SetupSection() {
  const { connection } = useRuntime();
  const applications = useTopic('setupApplications');
  const pickWanted = useStore(setupStore, (state) => state.pickWanted);
  const input = useRef<HTMLInputElement>(null);
  // The palette's "Start from a setup file" opens the picker once the page is here.
  useEffect(() => {
    if (!pickWanted) return;
    setupStore.setState({ pickWanted: false });
    input.current?.click();
  }, [pickWanted]);
  return (
    <section aria-labelledby="setup-file-title" className="mt-4 flex flex-col gap-3">
      <div>
        <h3 id="setup-file-title" className="text-sm font-medium">
          Setup file
        </h3>
        <p className="text-xs text-muted-foreground">
          Saves your settings, tracker and host settings, workflows and templates to a YAML file to
          send to a colleague. It holds no secret, project folder or account name; a secret you set
          is listed for them to fill in.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!connection}
          onClick={() =>
            connection && saveSetupFile(connection).catch(failed('The setup was not saved'))
          }
        >
          <FileDownIcon aria-hidden />
          Save setup to a file
        </Button>
        <Button variant="outline" disabled={!connection} onClick={() => input.current?.click()}>
          <FileUpIcon aria-hidden />
          Start from a setup file
        </Button>
        <input
          ref={input}
          type="file"
          accept=".yaml,.yml,application/yaml,text/yaml"
          aria-label="Setup file to start from"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || !connection) return;
            readSetupFile(connection, file).catch(failed('The file could not be read'));
          }}
        />
      </div>
      {applications && applications.length > 0 && (
        <ul aria-label="Setup files applied here" className="flex flex-col gap-1.5">
          {applications.toReversed().map((application) => (
            <ApplicationRow key={application.id} application={application} />
          ))}
        </ul>
      )}
      <SetupPreviewDialog />
    </section>
  );
}
