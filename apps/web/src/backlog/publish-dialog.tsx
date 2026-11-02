import {
  BacklogRemote,
  TrackerPreview,
  settingsRegistry,
  type BacklogItem,
  type TrackerService,
} from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { trackerNames } from './model';

const settingLabel = (key: string): string =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

export function RemoteLink({ remote }: { remote: BacklogRemote }) {
  return (
    <a
      href={remote.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
    >
      <ExternalLinkIcon className="size-3" aria-hidden />
      Open {remote.key}
    </a>
  );
}

type Stage =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'preview'; readonly preview: TrackerPreview }
  | { readonly type: 'created'; readonly remote: BacklogRemote };

function PublishBody({
  item,
  service,
  onDone,
}: {
  item: BacklogItem;
  service: TrackerService;
  onDone: () => void;
}) {
  const { connection } = useRuntime();
  const [stage, setStage] = useState<Stage>({ type: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = trackerNames[service];

  useEffect(() => {
    if (!connection) {
      setStage({ type: 'failed', message: 'Not connected to the wow server' });
      return undefined;
    }
    let current = true;
    connection
      .request('trackers.preview', { backlogItemId: item.id, service })
      .then((result) => TrackerPreview.parse(result))
      .then(
        (preview) => current && setStage({ type: 'preview', preview }),
        (caught: unknown) => current && setStage({ type: 'failed', message: errorMessage(caught) }),
      );
    return () => {
      current = false;
    };
  }, [connection, item.id, service]);

  const create = async () => {
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    try {
      const remote = BacklogRemote.parse(
        await connection.request('trackers.publish', { backlogItemId: item.id, service }),
      );
      setStage({ type: 'created', remote });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const close = (
    <Button type="button" variant="outline" onClick={onDone}>
      Done
    </Button>
  );

  if (stage.type === 'loading') {
    return <p className="text-xs text-muted-foreground">Preparing the issue…</p>;
  }
  if (stage.type === 'failed') {
    return (
      <>
        <p role="alert" className="text-xs text-destructive">
          {stage.message}
        </p>
        <DialogFooter>{close}</DialogFooter>
      </>
    );
  }
  if (stage.type === 'created') {
    return (
      <>
        <p data-testid="publish-created" className="flex items-center gap-2 text-sm">
          Created {stage.remote.key}. <RemoteLink remote={stage.remote} />
        </p>
        <DialogFooter>{close}</DialogFooter>
      </>
    );
  }

  const { preview } = stage;
  if (preview.existing) {
    return (
      <>
        <p data-testid="publish-existing" className="flex flex-wrap items-center gap-2 text-sm">
          Already published as {preview.existing.key}.
          <RemoteLink remote={preview.existing} />
        </p>
        <p className="text-xs text-muted-foreground">
          wow keeps one issue per backlog item, so nothing new is created.
        </p>
        <DialogFooter>{close}</DialogFooter>
      </>
    );
  }
  if (preview.missing.length > 0) {
    return (
      <>
        <div role="alert" className="grid gap-1 text-sm">
          <p>{name} is not set up yet. Fill in:</p>
          <ul className="list-disc pl-5 text-xs">
            {preview.missing.map((key) => (
              <li key={key}>{settingLabel(key)}</li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          {close}
          <Button asChild>
            <Link to="/settings/$group" params={{ group: 'trackers' }} onClick={onDone}>
              Open tracker settings
            </Link>
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <dl
        aria-label="Issue preview"
        className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground">{service === 'jira' ? 'Project' : 'Repository'}</dt>
        <dd data-testid="preview-target" className="font-mono">
          {preview.target}
        </dd>
        {preview.issueType && (
          <>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{preview.issueType}</dd>
          </>
        )}
        {preview.labels.length > 0 && (
          <>
            <dt className="text-muted-foreground">Labels</dt>
            <dd>{preview.labels.join(', ')}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Title</dt>
        <dd data-testid="preview-title">{preview.title}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd
          data-testid="preview-body"
          className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {preview.body === '' ? '(empty)' : preview.body}
        </dd>
      </dl>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" disabled={busy} onClick={() => void create()}>
          Create issue
        </Button>
      </DialogFooter>
    </>
  );
}

// "Publish to Jira" and "Publish to GitHub" (behavior 30): the issue first, created only on
// confirm; an item that already has an issue offers to open it instead.
export function PublishDialog({
  item,
  service,
  onClose,
}: {
  item: BacklogItem;
  service: TrackerService | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog open={service !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to {service ? trackerNames[service] : ''}</DialogTitle>
          <DialogDescription>
            Nothing is sent until you press Create issue. wow does not follow the issue afterwards.
          </DialogDescription>
        </DialogHeader>
        {service && <PublishBody key={service} item={item} service={service} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
