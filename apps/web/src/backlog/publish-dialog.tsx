import {
  BacklogRemote,
  SecretRef,
  TrackerPreview,
  settingsRegistry,
  trackerAccountKeys,
  type BacklogItem,
  type Project,
  type PublishProject,
  type TrackerService,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { ChoiceSelect } from '@/components/choice-select';
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
import { sourceLabel } from '@/projects/project-trackers';
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

const projectSources: Readonly<Record<PublishProject['source'], string | undefined>> = {
  chosen: undefined,
  card: "From the item's card",
  run: "From the item's run",
};

// Undefined: the item's card or run decides; null: no project, the defaults in Settings →
// Trackers; else the chosen project.
type ProjectChoice = string | null | undefined;

const NO_PROJECT = '';
const UNCHOSEN = '\u0001unchosen';

// Which project the issue is for. Shown whenever projects exist, so the user sees whose tracker
// settings apply and can change it; it asks first when the item has no project.
function ProjectPicker({
  projects,
  preview,
  onChoose,
}: {
  projects: readonly Project[];
  preview: TrackerPreview;
  onChoose: (choice: ProjectChoice) => void;
}) {
  const value = preview.project ? preview.project.id : preview.needsProject ? UNCHOSEN : NO_PROJECT;
  return (
    <FormField
      id="publish-project"
      label="Project"
      source={preview.project ? projectSources[preview.project.source] : undefined}
      help={
        preview.needsProject
          ? 'This item has no card or run in a project. Choose the project the issue is for; wow uses its repository and Jira project.'
          : undefined
      }
    >
      <ChoiceSelect
        value={value}
        placeholder="Choose a project"
        choices={[
          ...projects.map((project) => ({ value: project.id, label: project.name })),
          { value: NO_PROJECT, label: 'No project (the defaults in Settings → Trackers)' },
        ]}
        onValueChange={(next) => onChoose(next === NO_PROJECT ? null : next)}
        onCloseAutoFocus={(event) => {
          // A choice that needs settings opens the set-up form: its first field takes the focus.
          const next = document.getElementById('publish-setup-0');
          if (!next) return;
          event.preventDefault();
          next.focus();
        }}
      />
    </FormField>
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
  project,
  onSaved,
  onCancel,
}: {
  service: TrackerService;
  missing: readonly string[];
  project: PublishProject | null;
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
        // Sign-in is shared by every project; where issues go is kept for the project (F-4).
        if (project && !trackerAccountKeys.has(key)) {
          await dispatch(connection, {
            type: 'setting.set',
            key,
            scope: `project:${project.id}`,
            value: stored,
          });
          continue;
        }
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
        create the issue. wow keeps {missing.length === 1 ? 'it' : 'them'} for next time: sign-in is
        shared by all projects
        {project ? `, the rest is kept for ${project.name}` : ''}.
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
  const projects = useTopic('projects');
  const [stage, setStage] = useState<Stage>({ type: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [projectChoice, setProjectChoice] = useState<ProjectChoice>(undefined);
  // The last preview's project, so the picker stays put while the next preview loads.
  const [shown, setShown] = useState<TrackerPreview>();
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
      .request('trackers.preview', {
        backlogItemId: item.id,
        service,
        ...(projectChoice !== undefined ? { projectId: projectChoice } : {}),
      })
      .then((result) => TrackerPreview.parse(result))
      .then(
        (preview) => {
          if (!current) return;
          setStage({ type: 'preview', preview });
          setShown(preview);
        },
        (caught: unknown) => current && setStage({ type: 'failed', message: errorMessage(caught) }),
      );
    return () => {
      current = false;
    };
  }, [connection, item.id, service, attempt, projectChoice]);

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
          ...(stage.type === 'preview' ? { projectId: stage.preview.project?.id ?? null } : {}),
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

  const picker =
    projects && projects.length > 0 && shown && !shown.existing ? (
      <ProjectPicker projects={projects} preview={shown} onChoose={setProjectChoice} />
    ) : null;

  if (stage.type === 'loading') {
    return (
      <>
        {picker}
        <LoadingState rows={3} label="Preparing the issue" />
      </>
    );
  }
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
  if (preview.needsProject) {
    return (
      <>
        {picker}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }
  if (preview.missing.length > 0) {
    return (
      <>
        {picker}
        <SetUp
          key={preview.project?.id ?? 'defaults'}
          service={service}
          missing={preview.missing}
          project={preview.project}
          onCancel={onDone}
          onSaved={() => setAttempt(attempt + 1)}
        />
      </>
    );
  }

  const configured = preview.labels;
  const where = service === 'jira' ? 'Jira project' : 'Repository';
  return (
    <>
      {picker}
      <p data-testid="preview-summary" className="text-sm">
        Publishes to {service === 'jira' ? 'Jira project ' : ''}
        <span className="font-mono font-medium">{preview.target}</span>
        {preview.targetHost ? ` on ${preview.targetHost}` : ''}
        {preview.project ? ` for ${preview.project.name}` : ''}. Nothing is sent until you press
        Publish issue, and wow does not follow the issue afterwards.
      </p>
      <div className="grid gap-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{where}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span data-testid="preview-target" className="font-mono">
              {preview.target}
            </span>
            <span data-testid="preview-target-source" className="text-2xs text-muted-foreground">
              {sourceLabel(preview.targetSource, preview.target)}
            </span>
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
