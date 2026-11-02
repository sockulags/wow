import {
  BacklogRemote,
  SecretRef,
  TrackerPreview,
  settingsRegistry,
  type BacklogItem,
  type TrackerService,
} from '@wow/contracts';
import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { notify } from '@/lib/feedback';
import { MarkdownPreview } from './markdown';
import { trackerNames } from './model';

type RegistryKey = keyof typeof settingsRegistry;
const isRegistryKey = (key: string): key is RegistryKey => Object.hasOwn(settingsRegistry, key);
const settingLabel = (key: string): string =>
  isRegistryKey(key) ? settingsRegistry[key].label : key;
const isSecret = (key: string): boolean =>
  isRegistryKey(key) && (settingsRegistry[key] as { secret?: boolean }).secret === true;

export function RemoteLink({ remote }: { remote: BacklogRemote }) {
  return (
    <a
      href={remote.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ExternalLinkIcon className="size-3.5" aria-hidden />
      Open {remote.key}
    </a>
  );
}

type Stage =
  | { readonly type: 'loading' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'preview'; readonly preview: TrackerPreview }
  | { readonly type: 'created'; readonly remote: BacklogRemote };

// The settings the tracker still needs, filled in here instead of a detour through Settings
// (audit D-09). Secret ones go to the secret store; the setting keeps only the reference.
function SetUp({
  service,
  missing,
  onSaved,
  onCancel,
}: {
  service: TrackerService;
  missing: readonly string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { connection, settings } = useRuntime();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = trackerNames[service];
  const complete = missing.every((key) => (values[key] ?? '').trim() !== '');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!connection || !complete) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const key of missing) {
        const value = (values[key] ?? '').trim();
        const stored = isSecret(key)
          ? SecretRef.parse(
              await connection.request('secrets.set', { name: `setting:${key}`, value }),
            )
          : value;
        const result = await settings.write(key as RegistryKey, stored as never);
        if (!result.ok) throw new Error(`${settingLabel(key)}: ${result.issues.join('; ')}`);
      }
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form
      aria-label={`Set up ${name}`}
      onSubmit={(event) => void save(event)}
      className="grid gap-4"
    >
      <p className="text-sm">
        {name} needs {missing.length === 1 ? 'one more setting' : 'a few settings'} before wow can
        create the issue. wow keeps {missing.length === 1 ? 'it' : 'them'} for next time; Settings →
        Trackers has the rest.
      </p>
      {missing.map((key, index) => (
        <FormField
          key={key}
          id={`publish-setup-${index}`}
          label={settingLabel(key)}
          help={isRegistryKey(key) ? settingsRegistry[key].description : undefined}
        >
          <Input
            autoFocus={index === 0}
            type={isSecret(key) ? 'password' : 'text'}
            autoComplete="off"
            value={values[key] ?? ''}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </FormField>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !complete || !connection}>
          Set up {name}
        </Button>
      </DialogFooter>
    </form>
  );
}

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
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState(item.title);
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!connection) {
      setStage({ type: 'failed', message: 'Not connected to the wow server' });
      return undefined;
    }
    let current = true;
    setStage({ type: 'loading' });
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
  }, [connection, item.id, service, attempt]);

  const create = async () => {
    if (!connection || title.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const remote = BacklogRemote.parse(
        await connection.request('trackers.publish', {
          backlogItemId: item.id,
          service,
          title: title.trim(),
          ...(labels.length > 0 ? { labels: [...labels] } : {}),
        }),
      );
      setStage({ type: 'created', remote });
      notify.success(`Created ${remote.key}`, {
        action: { label: 'Open', onClick: () => window.open(remote.url, '_blank', 'noreferrer') },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const close = (
    <Button type="button" variant="outline" onClick={onDone}>
      Close
    </Button>
  );

  if (stage.type === 'loading') return <LoadingState rows={3} label="Preparing the issue" />;
  if (stage.type === 'failed') {
    return (
      <>
        <p role="alert" className="text-sm text-destructive">
          {stage.message}
        </p>
        <DialogFooter>
          {close}
          <Button type="button" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </Button>
        </DialogFooter>
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
      <SetUp
        service={service}
        missing={preview.missing}
        onCancel={onDone}
        onSaved={() => setAttempt(attempt + 1)}
      />
    );
  }

  const configured = preview.labels;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Nothing is sent until you press Publish issue. wow does not follow the issue afterwards.
      </p>
      <div className="grid gap-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
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
          {configured.length > 0 && (
            <>
              <dt className="text-muted-foreground">Labels</dt>
              <dd>{configured.join(', ')}</dd>
            </>
          )}
        </dl>
        <FormField id="publish-title" label="Title">
          <Input
            data-testid="preview-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </FormField>
        {item.tags.length > 0 && (
          <FormField
            id="publish-labels"
            label={configured.length > 0 ? 'Also add as labels' : 'Add as labels'}
            help={
              service === 'jira' ? 'Spaces become dashes; Jira labels are one word.' : undefined
            }
            group
          >
            <div className="flex flex-wrap gap-3">
              {item.tags.map((tag) => (
                <label key={tag} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={labels.includes(tag)}
                    onCheckedChange={(checked) =>
                      setLabels(
                        checked === true
                          ? [...labels, tag]
                          : labels.filter((candidate) => candidate !== tag),
                      )
                    }
                  />
                  {tag}
                </label>
              ))}
            </div>
          </FormField>
        )}
        <section aria-label="Description" className="grid gap-1.5">
          <h3 className="text-sm font-medium">Description</h3>
          <div
            data-testid="preview-body"
            className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3"
          >
            <MarkdownPreview markdown={preview.body} />
          </div>
          {service === 'jira' && (
            <p className="text-xs text-muted-foreground">
              Sent to Jira as wiki markup, so headings, lists and emphasis show as here.
            </p>
          )}
        </section>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" disabled={busy || title.trim() === ''} onClick={() => void create()}>
          Publish issue
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Publish to {service ? trackerNames[service] : ''}</DialogTitle>
          <DialogDescription className="sr-only">
            Check the issue wow creates for this backlog item.
          </DialogDescription>
        </DialogHeader>
        {service && <PublishBody key={service} item={item} service={service} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
